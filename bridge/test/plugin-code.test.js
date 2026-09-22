/**
 * M4/M5 插件侧静态契约测试（node:test + vm 桩环境，不依赖 Figma）
 *
 * 目标：FUN-ACC-404（节点树过滤导出：深度 + 字段白名单 + 节点预算 + 截断标记）
 * 与 INT-ACC-003（wireReaction 校验矩阵）的可执行静态证据——用 vm 加载
 * plugin/code.js（stub figma 全局与 __html__），直接调用 sandbox 脚本内的
 * figmaReadTree / decodeImages / figmaWireReaction（sloppy 模式顶层 function
 * 声明会挂到 vm 上下文全局）。
 * INT-ACC-002（Present 点击跳转）为运行时验收：由用户在 Figma 桌面端演示。
 * 运行：cd figma-prototyper/bridge && npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const CODE_JS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'code.js'),
  'utf8'
);

/** 与 plugin/code.js READ_TREE_ALL_FIELDS 一致的白名单（用于全树键核对） */
const ALL_FIELDS = [
  'id', 'name', 'type', 'x', 'y', 'width', 'height', 'visible', 'opacity',
  'chars', 'fontSize', 'fontName', 'layoutMode', 'itemSpacing',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
  'cornerRadius', 'componentId', 'components', 'fillSummary',
];

const DEFAULT_FIELDS = [
  'id', 'name', 'type', 'x', 'y', 'width', 'height',
  'chars', 'fontSize', 'fillSummary', 'componentId',
];

let seq = 0;

/** 构造桩节点：默认 FRAME + 常用属性；children 经第二参传入 */
function makeNode(props = {}, children = []) {
  seq += 1;
  return Object.assign(
    {
      id: 'n' + seq,
      name: 'node' + seq,
      type: 'FRAME',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      visible: true,
      opacity: 1,
      fills: [],
      children,
    },
    props
  );
}

/** 链式构造 n 层嵌套（每层一个子节点），返回根 */
function chain(depth, leafProps = { name: 'leaf' }) {
  let node = makeNode(leafProps);
  for (let i = 0; i < depth; i++) node = makeNode({ name: 'f' + i }, [node]);
  return node;
}

/** 加载 code.js 到 vm 上下文；返回 { context, figma } */
function loadCodeJs(figmaOverrides = {}) {
  const figma = Object.assign(
    {
      mixed: Symbol('figma.mixed'),
      showUI() {},
      ui: {},
      base64Encode: () => '',
      // 模拟真实 figma.base64Decode：非法输入抛错
      base64Decode: (s) => {
        const str = String(s);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(str) || str.length % 4 !== 0) {
          throw new Error('Invalid base64');
        }
        return Uint8Array.from(Buffer.from(str, 'base64'));
      },
      currentPage: makeNode({ type: 'PAGE', name: 'page', id: 'page:1' }),
      getNodeByIdAsync: async () => null,
    },
    figmaOverrides
  );
  const context = vm.createContext({ figma, __html__: '<html></html>' });
  vm.runInContext(CODE_JS, context, { filename: 'plugin/code.js' });
  return { context, figma };
}

/** 跨 realm 深比较：vm 侧对象 prototype 不同，经 JSON 序列化后比较 */
function jsonEq(actual, expected, msg) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
}

// ---- FUN-ACC-404：字段白名单 ----

test('FUN-ACC-404 缺省字段=核心集；全树不含白名单外字段；白名单外请求被交集丢弃', async () => {
  const page = makeNode({ type: 'PAGE', id: 'page:1', name: 'page' }, [
    makeNode({ name: 'frame-a' }, [makeNode({ name: 'text-1', type: 'TEXT', characters: 'hi' })]),
  ]);
  const { context } = loadCodeJs({ currentPage: page });

  const tree = await context.figmaReadTree({});
  assert.equal(tree.count, 3);
  assert.equal(tree.truncated, false);

  const keys = new Set();
  (function walk(n) {
    Object.keys(n).forEach((k) => keys.add(k));
    (n.children || []).forEach(walk);
  })(tree.root);
  for (const k of keys) {
    assert.ok(k === 'children' || ALL_FIELDS.includes(k), `字段 "${k}" 不在白名单内`);
  }

  // 键序断言：用无子节点的根（排除结构性 children 键的干扰）
  const { context: ctx2 } = loadCodeJs({
    currentPage: makeNode({ type: 'PAGE', id: 'page:9', name: 'p9' }),
  });
  assert.deepEqual(Object.keys((await ctx2.figmaReadTree({})).root), DEFAULT_FIELDS, '缺省输出应为核心集（键序一致）');
  // 白名单外字段请求 → 交集丢弃
  assert.deepEqual(
    Object.keys((await ctx2.figmaReadTree({ fields: ['id', 'evil', 'name'] })).root),
    ['id', 'name']
  );
  // 空/全非法请求 → 回落核心集
  assert.deepEqual(Object.keys((await ctx2.figmaReadTree({ fields: ['nope'] })).root), DEFAULT_FIELDS);
  // 单字段请求
  assert.deepEqual(Object.keys((await ctx2.figmaReadTree({ fields: ['type'] })).root), ['type']);
});

// ---- FUN-ACC-404：深度预算 ----

test('FUN-ACC-404 depth：缺省 3、硬上限 10（超出 clamp）、depth=0 仅根；仅容器递归', async () => {
  const chain12 = chain(11); // 11 层包装 + 1 叶 = 12 节点
  const page = makeNode({ type: 'PAGE', id: 'page:1' }, [chain12]);
  const { context } = loadCodeJs({ currentPage: page });

  assert.equal((await context.figmaReadTree({ depth: 0 })).count, 1);
  assert.equal((await context.figmaReadTree({ depth: 1 })).count, 2);
  assert.equal((await context.figmaReadTree({})).count, 4, '缺省 depth=3 → 根 + 3 层');
  assert.equal((await context.figmaReadTree({ depth: 99 })).count, 11, '硬上限 10 → 根 + 10 层');

  // 非容器（RECTANGLE）不递归：即使挂着 children 数组也不进入
  const rectWithKids = makeNode({ type: 'RECTANGLE', name: 'rect' }, [makeNode({ name: 'ghost' })]);
  const page2 = makeNode({ type: 'PAGE', id: 'page:2' }, [rectWithKids]);
  const { context: ctx2 } = loadCodeJs({ currentPage: page2 });
  const tree = await ctx2.figmaReadTree({ fields: ['id', 'name'] });
  assert.equal(tree.count, 2, '仅根页 + RECTANGLE 本身；ghost 不应被递归');
  assert.equal(JSON.stringify(tree.root).includes('ghost'), false);
});

// ---- FUN-ACC-404：节点预算与截断 ----

test('FUN-ACC-404 maxNodes：预算耗尽截断 truncated=true、缺省 500 / 硬上限 2000；恰好装满不误报', async () => {
  const chain10 = chain(9); // 10 节点
  const page = makeNode({ type: 'PAGE', id: 'page:1' }, [chain10]);
  const { context } = loadCodeJs({ currentPage: page });

  const cut = await context.figmaReadTree({ depth: 10, maxNodes: 4 });
  assert.equal(cut.count, 4);
  assert.equal(cut.truncated, true, '预算耗尽应置 truncated');
  let n = cut.root;
  for (let i = 0; i < 3; i++) n = n.children[0];
  assert.equal('children' in n, false, '截断端点不应再带 children');

  // 根页 + 10 节点链 = 11 个节点；预算恰好 11 → 全遍历不误报
  const exact = await context.figmaReadTree({ depth: 10, maxNodes: 11 });
  assert.equal(exact.count, 11);
  assert.equal(exact.truncated, false, '恰好装满且树已遍尽不应误报截断');

  const clamped = await context.figmaReadTree({ depth: 10, maxNodes: 999999 });
  assert.equal(clamped.count, 11, '999999 clamp 到硬上限 2000，不影响小树');

  // 缺省 500：page(0) + wide(1) + 600 子节点(2) → 恰好 500（含根）且截断
  const wide = makeNode(
    { name: 'wide' },
    Array.from({ length: 600 }, (_, i) => makeNode({ name: 'w' + i }))
  );
  const { context: ctx2 } = loadCodeJs({
    currentPage: makeNode({ type: 'PAGE', id: 'page:2' }, [wide]),
  });
  const def = await ctx2.figmaReadTree({ depth: 2 });
  assert.equal(def.count, 500, '缺省 maxNodes=500');
  assert.equal(def.truncated, true);

  // 硬上限 2000：3000 个子节点 + maxNodes 999999 → clamp 到 2000
  const wider = makeNode(
    { name: 'wider' },
    Array.from({ length: 3000 }, (_, i) => makeNode({ name: 'x' + i }))
  );
  const { context: ctx3 } = loadCodeJs({
    currentPage: makeNode({ type: 'PAGE', id: 'page:3' }, [wider]),
  });
  const hard = await ctx3.figmaReadTree({ depth: 2, maxNodes: 999999 });
  assert.equal(hard.count, 2000, 'maxNodes 硬上限 2000');
  assert.equal(hard.truncated, true);
});

// ---- FUN-ACC-404：root 解析 ----

test('FUN-ACC-404 root：缺省当前页；rootId 经 getNodeByIdAsync；未命中报错清晰', async () => {
  const target = makeNode({ id: 'target:1', name: 'target', type: 'RECTANGLE' });
  const page = makeNode({ type: 'PAGE', id: 'page:1' });
  const { context } = loadCodeJs({
    currentPage: page,
    getNodeByIdAsync: async (id) => (id === 'target:1' ? target : null),
  });

  assert.equal((await context.figmaReadTree({})).root.id, 'page:1');
  const byId = await context.figmaReadTree({ rootId: 'target:1' });
  assert.equal(byId.root.id, 'target:1');
  assert.equal('children' in byId.root, false, 'RECTANGLE 为叶，无 children 键');
  await assert.rejects(
    () => context.figmaReadTree({ rootId: 'missing:9' }),
    /node not found: missing:9/
  );
});

// ---- M4：fillSummary / components / 字段语义与容错 ----

test('M4 fillSummary：前 3 个 paint、SOLID 颜色保留 3 位、opacity≠1 才输出、IMAGE 带 imageScaleMode；mixed → null', async () => {
  const painted = makeNode({
    fills: [
      { type: 'SOLID', color: { r: 0.123456, g: 0.5, b: 1 }, opacity: 1 },
      { type: 'IMAGE', scaleMode: 'FILL', opacity: 0.5 },
      { type: 'GRADIENT_LINEAR' },
      { type: 'SOLID', color: { r: 1, g: 1, b: 1 } }, // 第 4 个不输出
    ],
  });
  const mixedFills = makeNode({ type: 'TEXT' });
  const page = makeNode({ type: 'PAGE', id: 'page:1' }, [painted, mixedFills]);
  const { context, figma } = loadCodeJs({ currentPage: page });
  mixedFills.fills = figma.mixed; // 混合填充（符号）

  const tree = await context.figmaReadTree({ fields: ['fillSummary'] });
  jsonEq(tree.root.children[0].fillSummary, [
    { type: 'SOLID', color: { r: 0.123, g: 0.5, b: 1 } },
    { type: 'IMAGE', opacity: 0.5, imageScaleMode: 'FILL' },
    { type: 'GRADIENT_LINEAR' },
  ]);
  assert.equal(tree.root.children[1].fillSummary, null, 'figma.mixed fills → null');
});

test('M4 components：COMPONENT_SET → 子 COMPONENT 的 [{id,name}]；其余类型 → null', async () => {
  const setNode = makeNode(
    { type: 'COMPONENT_SET', id: 'set:1', name: 'Btn' },
    [
      makeNode({ type: 'COMPONENT', id: 'c-a', name: 'A' }),
      makeNode({ type: 'COMPONENT', id: 'c-b', name: 'B' }),
      makeNode({ type: 'FRAME', id: 'f-x', name: 'not-component' }),
    ]
  );
  const page = makeNode({ type: 'PAGE', id: 'page:1' }, [setNode]);
  const { context } = loadCodeJs({ currentPage: page });

  const tree = await context.figmaReadTree({ fields: ['components'] });
  jsonEq(tree.root.children[0].components, [
    { id: 'c-a', name: 'A' },
    { id: 'c-b', name: 'B' },
  ]);
  assert.equal(tree.root.components, null, 'PAGE 无 components → null');
});

test('M4 字段语义：chars/fontName 输出 {family,style}；混合值置 null；单字段 getter 抛错不拖垮整体', async () => {
  const text = makeNode({
    type: 'TEXT',
    characters: '你好',
    fontSize: 12,
    fontName: { family: 'Inter', style: 'Regular' },
  });
  const mixedText = makeNode({ type: 'TEXT' });
  const broken = makeNode({ name: 'broken' });
  Object.defineProperty(broken, 'opacity', {
    get() {
      throw new Error('boom');
    },
  });
  const page = makeNode({ type: 'PAGE', id: 'page:1' }, [text, mixedText, broken]);
  const { context, figma } = loadCodeJs({ currentPage: page });
  mixedText.fontSize = figma.mixed;
  mixedText.fontName = figma.mixed;

  const tree = await context.figmaReadTree({ fields: ['chars', 'fontSize', 'fontName'] });
  assert.equal(tree.root.chars, null, 'PAGE 无 chars → null（不崩）');
  assert.equal(tree.root.children[0].chars, '你好');
  jsonEq(tree.root.children[0].fontName, { family: 'Inter', style: 'Regular' });
  assert.equal(tree.root.children[1].fontSize, null, '混合字号 → null');
  assert.equal(tree.root.children[1].fontName, null, '混合字体 → null');

  const tree2 = await context.figmaReadTree({ fields: ['id', 'opacity'] });
  assert.equal(tree2.root.children[2].opacity, null, 'getter 抛错 → 置 null（字段级容错）');
  assert.equal(typeof tree2.root.children[2].id, 'string', '同节点其余字段不受影响');
  assert.equal(tree2.truncated, false);
});

// ---- M4：images 解码（sandbox 侧） ----

test('M4 decodeImages：base64 → Uint8Array 字节一致；非法/空条目跳过；undefined → 空对象', async () => {
  const { context } = loadCodeJs();
  const raw = Buffer.from('img-bytes-含中文', 'utf8');
  const out = context.decodeImages({
    logo: raw.toString('base64'),
    bad: '!!!not-base64!!!',
    empty: '',
    num: 42,
  });
  assert.equal(Object.prototype.toString.call(out.logo), '[object Uint8Array]', '解码产物应为 Uint8Array');
  assert.deepEqual(Buffer.from(out.logo), raw);
  assert.equal('bad' in out, false, '非法 base64 条目跳过');
  assert.equal('empty' in out, false);
  assert.equal('num' in out, false);
  assert.equal(Object.keys(context.decodeImages(undefined)).length, 0, '手动模式无 images → 空对象');
});

// ---- M5：wireReaction（INT-ACC-003 静态证据；INT-ACC-002 运行时由用户 Present 验证） ----

/** 构建带节点注册表的桩：getNodeByIdAsync 按表返回，未命中为 null */
function loadWithNodes(nodes) {
  const map = {};
  for (const n of nodes) map[n.id] = n;
  return loadCodeJs({
    getNodeByIdAsync: async (id) => map[id] || null,
  });
}

test('M5 wireReaction 成功路径：NAVIGATE 形状精确断言（trigger/action/navigation/destinationId，瞬时无 transition）', async () => {
  const source = makeNode({ id: '11:2', name: 'home' });
  const dest = makeNode({ id: '11:6', name: 'detail' });
  const { context } = loadWithNodes([source, dest]);

  const ret = await context.figmaWireReaction({ sourceId: '11:2', action: 'NAVIGATE', destinationId: '11:6' });

  jsonEq(source.reactions, [
    {
      trigger: { type: 'ON_CLICK' },
      actions: [{ type: 'NODE', destinationId: '11:6', navigation: 'NAVIGATE' }],
    },
  ], 'NAVIGATE 缺省形状（官方示例同款，trigger 缺省 ON_CLICK）');
  assert.equal('transition' in source.reactions[0].actions[0], false, '缺省瞬时：不写 transition 字段');
  jsonEq(ret, {
    sourceId: '11:2',
    reactions: [
      {
        trigger: { type: 'ON_CLICK' },
        actions: [{ type: 'NODE', destinationId: '11:6', navigation: 'NAVIGATE' }],
      },
    ],
    destinationId: '11:6',
  }, '读回返回 {sourceId, reactions, destinationId?}');

  // 显式 trigger 透传
  await context.figmaWireReaction({ sourceId: '11:2', action: 'NAVIGATE', destinationId: '11:6', trigger: 'ON_HOVER' });
  assert.equal(source.reactions[0].trigger.type, 'ON_HOVER');
  assert.equal(source.reactions.length, 1, '单条覆盖');
});

test('M5 wireReaction BACK：action 仅 {type:"BACK"}，无 destinationId；多余 destinationId/animation 被忽略', async () => {
  const source = makeNode({ id: '11:6', name: 'detail' });
  const { context } = loadWithNodes([source]);

  const ret = await context.figmaWireReaction({
    sourceId: '11:6',
    action: 'BACK',
    destinationId: '11:2',
    animation: { type: 'SMART_ANIMATE', duration: 500 },
  });

  jsonEq(source.reactions, [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }],
    'BACK 无 destinationId（Figma 的 BACK action 不携带转场字段）');
  assert.equal('destinationId' in ret, false, 'BACK 返回值不含 destinationId');
  assert.equal('transition' in source.reactions[0].actions[0], false);
});

test('M5 wireReaction animation：transition 形状 {type, duration(秒), easing:{type}}；缺省 300ms / EASE_OUT', async () => {
  const source = makeNode({ id: '11:2' });
  const dest = makeNode({ id: '11:6' });
  const { context } = loadWithNodes([source, dest]);

  await context.figmaWireReaction({
    sourceId: '11:2',
    action: 'NAVIGATE',
    destinationId: '11:6',
    animation: { type: 'SMART_ANIMATE', duration: 300, easing: 'EASE_OUT' },
  });
  jsonEq(source.reactions[0].actions[0].transition, {
    type: 'SMART_ANIMATE',
    duration: 0.3, // 毫秒 → 秒（Figma transition.duration 单位为秒）
    easing: { type: 'EASE_OUT' },
  }, 'SMART_ANIMATE 转场形状');

  // 缺省 duration/easing：DISSOLVE → 0.3s + EASE_OUT
  const src2 = makeNode({ id: '12:2' });
  const { context: ctx2 } = loadWithNodes([src2, dest]);
  await ctx2.figmaWireReaction({
    sourceId: '12:2', action: 'NAVIGATE', destinationId: '11:6',
    animation: { type: 'DISSOLVE' },
  });
  jsonEq(src2.reactions[0].actions[0].transition, {
    type: 'DISSOLVE',
    duration: 0.3,
    easing: { type: 'EASE_OUT' },
  }, '缺省 duration=300ms、easing=EASE_OUT');

  // 方向型转场：PUSH 写入 direction（缺省 LEFT）+ matchLayers:false（typings 必填）
  const src3 = makeNode({ id: '13:2' });
  const { context: ctx3 } = loadWithNodes([src3, dest]);
  await ctx3.figmaWireReaction({
    sourceId: '13:2', action: 'NAVIGATE', destinationId: '11:6',
    animation: { type: 'PUSH', duration: 200, easing: 'GENTLE' },
  });
  jsonEq(src3.reactions[0].actions[0].transition, {
    type: 'PUSH',
    duration: 0.2,
    easing: { type: 'GENTLE' },
    direction: 'LEFT',
    matchLayers: false,
  }, '方向型转场补 direction/matchLayers');
});

test('M5 wireReaction 校验矩阵（INT-ACC-003）：非法值拒绝且消息含节点 id 或允许值列表', async () => {
  const source = makeNode({ id: '11:2' });
  const dest = makeNode({ id: '11:6' });
  const { context } = loadWithNodes([source, dest]);

  // sourceId 缺失 / 源不存在（消息含 id）
  await assert.rejects(
    () => context.figmaWireReaction({ action: 'NAVIGATE', destinationId: '11:6' }),
    /wireReaction: 源节点不存在/
  );
  await assert.rejects(
    () => context.figmaWireReaction({ sourceId: 'missing:9', action: 'NAVIGATE', destinationId: '11:6' }),
    /源节点不存在 \(missing:9\)/
  );
  // NAVIGATE 但 destinationId 缺失（消息含 sourceId）
  await assert.rejects(
    () => context.figmaWireReaction({ sourceId: '11:2', action: 'NAVIGATE' }),
    /NAVIGATE 需要 destinationId \(source: 11:2\)/
  );
  // destinationId 不存在（消息含 source 与 destination）
  await assert.rejects(
    () => context.figmaWireReaction({ sourceId: '11:2', action: 'NAVIGATE', destinationId: 'missing:8' }),
    /目标节点不存在 \(source: 11:2, destination: missing:8\)/
  );
  // 非法 trigger（列出允许值）
  await assert.rejects(
    () => context.figmaWireReaction({ sourceId: '11:2', action: 'BACK', trigger: 'ON_DRAG' }),
    /非法 trigger "ON_DRAG"（允许值: ON_CLICK \| ON_HOVER \| ON_PRESS）/
  );
  // 非法 action（列出允许值）
  await assert.rejects(
    () => context.figmaWireReaction({ sourceId: '11:2', action: 'OPEN_URL', destinationId: '11:6' }),
    /非法 action "OPEN_URL"（允许值: NAVIGATE \| BACK）/
  );
  // 非法 animation.type（列出允许值）
  await assert.rejects(
    () => context.figmaWireReaction({ sourceId: '11:2', action: 'BACK', animation: { type: 'FOO' } }),
    /非法 animation\.type "FOO"（允许值: SMART_ANIMATE \| DISSOLVE \| MOVE_IN \| MOVE_OUT \| SLIDE_IN \| SLIDE_OUT \| PUSH/
  );
  // animation 非 object（如字符串）
  await assert.rejects(
    () => context.figmaWireReaction({ sourceId: '11:2', action: 'BACK', animation: 'SMART_ANIMATE' }),
    /非法 animation\.type/
  );
  // CUSTOM_CUBIC easing：拒绝并提示改用枚举值
  await assert.rejects(
    () => context.figmaWireReaction({
      sourceId: '11:2', action: 'NAVIGATE', destinationId: '11:6',
      animation: { type: 'SMART_ANIMATE', easing: 'CUSTOM_CUBIC' },
    }),
    /非法 animation\.easing "CUSTOM_CUBIC".*GENTLE \| QUICK \| SLOW \| BOUNCY/
  );
  // 非法 direction（方向型转场）
  await assert.rejects(
    () => context.figmaWireReaction({
      sourceId: '11:2', action: 'NAVIGATE', destinationId: '11:6',
      animation: { type: 'SLIDE_IN', direction: 'UP' },
    }),
    /非法 animation\.direction "UP"（允许值: LEFT \| RIGHT \| TOP \| BOTTOM）/
  );
  // 非法 duration
  await assert.rejects(
    () => context.figmaWireReaction({
      sourceId: '11:2', action: 'NAVIGATE', destinationId: '11:6',
      animation: { type: 'DISSOLVE', duration: -5 },
    }),
    /animation\.duration 须为非负数字（毫秒）/
  );
  // 校验失败不写 reactions
  assert.equal(source.reactions, undefined, '全部校验失败路径都不应写入 reactions');
});

test('M5 wireReaction 覆盖式语义：对同节点第二次调用后 reactions 只有一组（替换非追加）', async () => {
  const source = makeNode({ id: '11:2' });
  const a = makeNode({ id: '11:6' });
  const b = makeNode({ id: '11:8' });
  const { context } = loadWithNodes([source, a, b]);

  await context.figmaWireReaction({ sourceId: '11:2', action: 'NAVIGATE', destinationId: '11:6' });
  assert.equal(source.reactions.length, 1);
  await context.figmaWireReaction({ sourceId: '11:2', action: 'NAVIGATE', destinationId: '11:8' });
  assert.equal(source.reactions.length, 1, '覆盖：仍只有一组');
  assert.equal(source.reactions[0].actions[0].destinationId, '11:8', '指向新目标');
});

test('M5 脚本注入：AsyncFunction 第 4 实参 wireReaction 在 sandbox 内可用（手动模式同样注入）', async () => {
  const { context, figma } = loadWithNodes([makeNode({ id: '11:2' }), makeNode({ id: '11:6' })]);
  const posted = [];
  figma.ui.postMessage = (m) => posted.push(m);

  await context.figma.ui.onmessage({
    type: 'RUN_SCRIPT',
    code: 'return [typeof wireReaction, typeof readTree, typeof images].join(":");',
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].ok, true);
  assert.equal(posted[0].message, 'function:function:object', 'wireReaction 以第 4 实参注入');

  // 端到端：注入的 wireReaction 真实可用（await + 校验 + 覆盖写入）
  await context.figma.ui.onmessage({
    type: 'RUN_SCRIPT',
    code: 'const r = await wireReaction({ sourceId: "11:2", action: "NAVIGATE", destinationId: "11:6" }); return r.destinationId;',
  });
  assert.equal(posted[1].ok, true);
  assert.equal(posted[1].message, '11:6');
});

// ==================== M6a：toIR 设计 IR（FUN-ACC-601） ====================

// 与 plugin/code.js TOIR_NODE_KEYS 一致的节点白名单（用于全树键核对）
const TOIR_NODE_KEYS = ['type', 'name', 'layout', 'style', 'text', 'asset', 'children'];

test('FUN-ACC-601 schema：{v:1,kind,root,truncated}；节点仅含白名单键；确定性字段映射', async () => {
  const page = makeNode(
    { type: 'PAGE', id: 'p:1', name: 'page' },
    [
      makeNode(
        {
          name: 'frame', type: 'FRAME', layoutMode: 'VERTICAL', itemSpacing: 16,
          paddingLeft: 24, paddingTop: 24, paddingRight: 24, paddingBottom: 24,
          fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3 } }],
          strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, visible: true }],
          cornerRadius: 12,
        },
        [
          makeNode({
            name: 't', type: 'TEXT', characters: 'hi', fontSize: 12,
            fontName: { family: 'Inter', style: 'Regular' },
            fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
          }),
        ]
      ),
    ]
  );
  const { context } = loadCodeJs({ currentPage: page });

  const { ir } = await context.figmaToIR({});
  assert.equal(ir.v, 1);
  assert.equal(ir.kind, 'design-ir');
  assert.equal(typeof ir.truncated, 'boolean');

  // 全树节点仅含白名单键；layout.mode 合法
  (function walk(n) {
    Object.keys(n).forEach((k) => assert.ok(TOIR_NODE_KEYS.includes(k), `节点键 "${k}" 不在白名单内`));
    if (n.layout) assert.ok(['none', 'horizontal', 'vertical'].includes(n.layout.mode));
    (n.children || []).forEach(walk);
  })(ir.root);

  // 具体映射核对
  const frame = ir.root.children[0];
  assert.equal(frame.type, 'frame');
  assert.equal(frame.layout.mode, 'vertical');
  assert.equal(frame.layout.gap, 16);
  jsonEq(
    frame.layout.padding,
    { left: 24, top: 24, right: 24, bottom: 24 }
  );
  jsonEq(frame.style.fills, [{ color: '#1a334d' }]);
  jsonEq(frame.style.strokes, [{ color: '#000000' }]);
  assert.equal(frame.style.radius, 12);
  const text = frame.children[0];
  assert.equal(text.type, 'text');
  assert.equal(text.text, 'hi');
  jsonEq(text.style.font, { family: 'Inter', style: 'Regular', size: 12 });
});

test('FUN-ACC-601 字段白名单：未知字段忽略；非容器（RECTANGLE）不递归；GRADIENT 填充归入 image', async () => {
  const solidRect = makeNode({ name: 'box', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] });
  const gradRect = makeNode({ name: 'g', type: 'RECTANGLE', fills: [{ type: 'GRADIENT_LINEAR' }] });
  const page = makeNode({ type: 'PAGE', id: 'p:1' }, [solidRect, gradRect]);
  const { context } = loadCodeJs({ currentPage: page });

  const { ir } = await context.figmaToIR({ fields: ['evilField'] }); // 未知字段应被忽略
  assert.equal(ir.root.children[0].type, 'frame', 'RECTANGLE → frame（无栅格填充）');
  assert.equal(ir.root.children[1].type, 'image', 'GRADIENT 填充 → image');
  assert.equal('evilField' in ir.root, false, '未知字段不应出现');
  assert.equal('children' in ir.root.children[0], false, 'RECTANGLE 为叶，无 children 键');
});

test('FUN-ACC-601 depth/maxNodes 边界：缺省3、depth 硬上限 10、maxNodes 缺省500/硬上限2000、截断仅由预算触发', async () => {
  function countNodes(n) {
    let c = 1;
    if (n.children) for (const k of n.children) c += countNodes(k);
    return c;
  }
  const big = chain(11); // 12 节点（11 包装 + 1 叶）挂在 page 下 → 共 13
  const { context } = loadCodeJs({ currentPage: makeNode({ type: 'PAGE', id: 'p:1' }, [big]) });

  // 缺省 depth=3、maxNodes=500：小树全遍历，truncated=false
  const smallTree = makeNode({ type: 'PAGE', id: 'p:2' }, [chain(2)]); // 共 4 节点
  const { context: ctxSmall } = loadCodeJs({ currentPage: smallTree });
  const def = await ctxSmall.figmaToIR({});
  assert.equal(countNodes(def.ir.root), 4, '缺省 depth=3 覆盖 4 节点树');
  assert.equal(def.ir.truncated, false);

  // depth 硬上限 10：depth=99 被 clamp 到 10 → 11 节点（page + 10 层），深度截断不置 truncated
  const clamped = await context.figmaToIR({ depth: 99, maxNodes: 999999 });
  assert.equal(countNodes(clamped.ir.root), 11, 'depth clamp 到 10（root + 10 层）');
  assert.equal(clamped.ir.truncated, false, 'depth 上限为硬截断（非预算），不置 truncated');

  // maxNodes 作为预算触发截断：depth 充足但 maxNodes=4 → 4 节点后截断
  const budget = await context.figmaToIR({ depth: 10, maxNodes: 4 });
  assert.equal(countNodes(budget.ir.root), 4);
  assert.equal(budget.ir.truncated, true, '预算耗尽应置 truncated');

  // maxNodes 硬上限 2000：3000 子节点 + page = 3001，clamp 到 2000 且截断
  const wider = makeNode(
    { name: 'wider' },
    Array.from({ length: 3000 }, (_, i) => makeNode({ name: 'x' + i }))
  );
  const { context: ctxWide } = loadCodeJs({ currentPage: makeNode({ type: 'PAGE', id: 'p:3' }, [wider]) });
  const hard = await ctxWide.figmaToIR({ depth: 2, maxNodes: 999999 });
  assert.equal(countNodes(hard.ir.root), 2000, 'maxNodes 硬上限 2000');
  assert.equal(hard.ir.truncated, true);
});

test('FUN-ACC-601 图片填充节点 → type:image、asset=nodeId、assets 含 base64（与导出字节一致）', async () => {
  const pngBytes = Buffer.from('fake-png-bytes-含中文');
  const raster = makeNode({
    id: 'img:1', name: 'photo', type: 'RECTANGLE',
    fills: [{ type: 'IMAGE', scaleMode: 'FILL', visible: true }],
    exportAsync: async () => Uint8Array.from(pngBytes),
  });
  const page = makeNode({ type: 'PAGE', id: 'p:1' }, [raster]);
  const { context } = loadCodeJs({
    currentPage: page,
    base64Encode: (b) => Buffer.from(b).toString('base64'),
  });

  const { ir, assets } = await context.figmaToIR({});
  assert.equal(ir.root.children[0].type, 'image');
  assert.equal(ir.root.children[0].asset, 'img:1', 'asset 名 = 节点 id（防冲突）');
  assert.equal(typeof assets['img:1'], 'string', 'assets 应含该节点 id 的 base64');
  assert.deepEqual(Buffer.from(assets['img:1'], 'base64'), pngBytes, 'assets 字节应与导出一致');
  assert.equal('children' in ir.root.children[0], false, 'image 节点为叶');
});

test('FUN-ACC-602 脚本 return 对象 → RESULT.data 为 JSON 字符串；超 20MB → ok:false', async () => {
  const { context, figma } = loadCodeJs();
  const posted = [];
  figma.ui.postMessage = (m) => posted.push(m);

  // 对象返回值 → data 通道
  await context.figma.ui.onmessage({
    type: 'RUN_SCRIPT',
    code: 'return { ir: { v: 1 }, assets: { "1:1": "AAA" } };',
  });
  assert.equal(posted[0].ok, true);
  assert.equal(typeof posted[0].data, 'string');
  assert.deepEqual(JSON.parse(posted[0].data), { ir: { v: 1 }, assets: { '1:1': 'AAA' } });

  // 非对象返回值仍走 message（向后兼容）
  await context.figma.ui.onmessage({ type: 'RUN_SCRIPT', code: 'return 42;' });
  assert.equal(posted[1].ok, true);
  assert.equal(posted[1].message, '42');
  assert.equal('data' in posted[1], false);

  // 超 20MB → ok:false（data 上限语义）
  await context.figma.ui.onmessage({
    type: 'RUN_SCRIPT',
    code: 'return { big: "x".repeat(' + 21 * 1024 * 1024 + ') };',
  });
  assert.equal(posted[2].ok, false, '超 20MB 应 ok:false');
  assert.ok(/RESULT\.data/.test(posted[2].message), '错误应提示 data 超限');
});
