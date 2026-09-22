/**
 * M7b extract 独立验收测试（wanan Gate 8 补充，FUN-ACC-703）
 *
 * 现有 cli/test/extract.test.js 已覆盖：纯映射结构断言、CDP 桩测 e2e、exit 2 语义、冒烟开关。
 * 本文件补充其未覆盖的验收要素：
 *   1) 「design-ir.json 合法（schema v1 与 toIR 同构）」的实质性校验——逐节点字段白名单 +
 *      枚举/类型校验，而非仅 JSON.parse；
 *   2) 与 toIR 既有产物（cli/test/fixtures/m7-rebuild/design-ir.json）的键集合同构对照；
 *   3) extract 产物可被 M7a rebuild 消费（loadRebuildIr 同款 schema 前置校验 inline 复刻）。
 *
 * 不依赖真 Chrome / 桥接 / Figma；不读 output/ 下 gitignored 产物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mapDomToIr } from '../lib/extract.js';

// ==================== 合成 CDP 载荷（独立于 extract.test.js 的最小数据集） ====================

function buildSynthetic() {
  const nodes = [
    { nodeId: 1, nodeType: 1, localName: 'html', parentId: 0, childNodeIds: [2] },
    { nodeId: 2, nodeType: 1, localName: 'body', parentId: 1, attributes: ['class', 'page'], childNodeIds: [3] },
    {
      nodeId: 3, nodeType: 1, localName: 'div', parentId: 2,
      attributes: ['id', 'app', 'class', 'app'], childNodeIds: [4, 5, 6, 7, 8, 9],
    },
    { nodeId: 4, nodeType: 3, nodeValue: 'Hello', parentId: 3 },
    { nodeId: 5, nodeType: 1, localName: 'div', parentId: 3, attributes: ['class', 'card'], childNodeIds: [10] },
    { nodeId: 10, nodeType: 3, nodeValue: 'Card', parentId: 5 },
    { nodeId: 6, nodeType: 1, localName: 'img', parentId: 3, attributes: ['alt', 'logo', 'src', '/x/logo.png'], childNodeIds: [] },
    { nodeId: 7, nodeType: 1, localName: 'div', parentId: 3, attributes: ['class', 'abs'], childNodeIds: [] },
    { nodeId: 8, nodeType: 1, localName: 'div', parentId: 3, attributes: ['class', 'comp'], childNodeIds: [] },
    { nodeId: 9, nodeType: 1, localName: 'div', parentId: 3, attributes: ['class', 'gone'], childNodeIds: [11] },
    { nodeId: 11, nodeType: 1, localName: 'div', parentId: 9, childNodeIds: [] },
  ];
  const stylesById = {
    2: { display: 'block', 'font-family': 'Inter', 'font-size': '16px', 'font-weight': '400', color: 'rgb(0,0,0)' },
    3: {
      display: 'flex', 'flex-direction': 'row', 'row-gap': '12px',
      'justify-content': 'space-between', 'align-items': 'center',
      'padding-top': '10px', 'padding-left': '20px',
      'background-color': 'rgb(255,255,255)',
      'font-family': 'Inter', 'font-size': '20px', 'font-weight': '700', color: 'rgb(17,17,17)',
    },
    5: {
      display: 'block', 'background-color': 'rgba(0,0,255,0.5)',
      'border-left-width': '1px', 'border-left-color': 'rgb(0,255,0)',
      'border-top-left-radius': '8px',
    },
    6: { display: 'inline' },
    7: { display: 'block', position: 'absolute' },
    8: { display: 'block' },
    9: { display: 'none' },
    11: { display: 'block' },
  };
  const boxesById = {
    2: { x: 0, y: 0, width: 320, height: 480 },
    3: { x: 0, y: 0, width: 320, height: 480 },
    5: { x: 0, y: 10, width: 100, height: 40 },
    6: { x: 110, y: 10, width: 50, height: 50 },
    7: { x: 170, y: 0, width: 30, height: 30 },
    8: { x: 210, y: 10, width: 60, height: 40 },
  };
  return { nodes, stylesById, boxesById };
}

// ==================== schema v1 校验器（对齐 spec/03 设计 IR 契约 + fixture 键集合） ====================

const IR_DOC_KEYS = new Set(['v', 'kind', 'root', 'truncated']);
const IR_NODE_KEYS = new Set(['type', 'name', 'bounds', 'absolute', 'layout', 'style', 'text', 'asset', 'children']);
const IR_TYPES = new Set(['frame', 'text', 'image', 'component', 'instance']);
const IR_LAYOUT_MODES = new Set(['none', 'horizontal', 'vertical']);
const IR_ALIGN = new Set(['min', 'center', 'max', 'between', 'baseline']);
const IR_STYLE_KEYS = new Set(['fills', 'strokes', 'radius', 'font']);

function validateBounds(b, where, errors) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    errors.push(`${where}: bounds 缺失或非对象`);
    return;
  }
  for (const k of ['x', 'y', 'width', 'height']) {
    if (typeof b[k] !== 'number' || !Number.isFinite(b[k])) errors.push(`${where}: bounds.${k} 非有限数值`);
  }
}

/** 递归校验 IR 节点：键白名单 + 枚举 + 类型（实质性 schema 校验，非 JSON.parse 了事） */
function validateIrNode(node, where, errors) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${where}: 节点非对象`);
    return;
  }
  for (const k of Object.keys(node)) {
    if (!IR_NODE_KEYS.has(k)) errors.push(`${where}: 白名单外字段 "${k}"`);
  }
  if (!IR_TYPES.has(node.type)) errors.push(`${where}: type "${node.type}" 不在 ${[...IR_TYPES].join('/')}`);
  if (typeof node.name !== 'string') errors.push(`${where}: name 非字符串`);
  validateBounds(node.bounds, where, errors);
  if (node.absolute !== undefined && node.absolute !== true) {
    errors.push(`${where}: absolute 若存在必须为 true`);
  }
  const layout = node.layout;
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    errors.push(`${where}: layout 缺失`);
  } else {
    if (!IR_LAYOUT_MODES.has(layout.mode)) errors.push(`${where}: layout.mode "${layout.mode}" 非法`);
    if (layout.gap !== undefined && (typeof layout.gap !== 'number' || layout.gap < 0)) {
      errors.push(`${where}: layout.gap 非法`);
    }
    for (const k of ['primary', 'counter']) {
      if (layout[k] !== undefined && !IR_ALIGN.has(layout[k])) errors.push(`${where}: layout.${k} "${layout[k]}" 非法`);
    }
    if (layout.padding !== undefined) {
      for (const k of ['top', 'right', 'bottom', 'left']) {
        if (typeof layout.padding[k] !== 'number') errors.push(`${where}: layout.padding.${k} 非数值`);
      }
    }
  }
  if (node.type === 'text') {
    if (typeof node.text !== 'string') errors.push(`${where}: type=text 缺 text 字段`);
  } else if (node.type === 'image') {
    if (typeof node.asset !== 'string' || node.asset.length === 0) errors.push(`${where}: type=image 缺 asset 键`);
  }
  if (node.style !== undefined) {
    for (const k of Object.keys(node.style)) {
      if (!IR_STYLE_KEYS.has(k)) errors.push(`${where}: style 白名单外字段 "${k}"`);
    }
    for (const k of ['fills', 'strokes']) {
      const arr = node.style[k];
      if (arr !== undefined) {
        if (!Array.isArray(arr)) errors.push(`${where}: style.${k} 非数组`);
        else for (const p of arr) {
          if (typeof p.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.color)) errors.push(`${where}: style.${k} 颜色非 #hex`);
          if (p.opacity !== undefined && (typeof p.opacity !== 'number' || p.opacity < 0 || p.opacity > 1)) {
            errors.push(`${where}: style.${k}.opacity 越界`);
          }
        }
      }
    }
    if (node.style.font !== undefined) {
      const f = node.style.font;
      for (const k of ['family', 'style', 'size']) {
        if (typeof f[k] !== 'string' && typeof f[k] !== 'number') errors.push(`${where}: style.font.${k} 缺失`);
      }
    }
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) errors.push(`${where}: children 非数组`);
    else node.children.forEach((c, i) => validateIrNode(c, `${where}.children[${i}]`, errors));
  }
}

/** 复刻 figmapt.js loadRebuildIr 的前置 schema 校验（rebuild 可消费性） */
function assertRebuildConsumable(ir) {
  assert.equal(typeof ir.v, 'number', 'rebuild 前置校验：缺字段 v');
  assert.equal(typeof ir.kind, 'string', 'rebuild 前置校验：缺字段 kind');
  assert.ok(ir.root && typeof ir.root === 'object', 'rebuild 前置校验：缺字段 root');
}

// ==================== 1) 逐节点白名单 + 枚举校验 ====================

test('FUN-ACC-703 验收：mapDomToIr 产物逐节点满足 schema v1 字段白名单与枚举（实质性校验）', () => {
  const { nodes, stylesById, boxesById } = buildSynthetic();
  const ir = mapDomToIr({ nodes, stylesById, boxesById, rootSelector: '#app' });

  for (const k of Object.keys(ir)) {
    if (!IR_DOC_KEYS.has(k)) assert.fail(`文档级白名单外字段 "${k}"`);
  }
  const errors = [];
  validateIrNode(ir.root, 'root', errors);
  assert.deepEqual(errors, [], `IR 节点 schema 违例:\n${errors.join('\n')}`);

  // 关键语义抽查（白名单之外的实质断言）
  assert.equal(ir.v, 1);
  assert.equal(ir.kind, 'design-ir');
  assert.equal(ir.truncated, false);
  const root = ir.root;
  assert.equal(root.layout.mode, 'horizontal');
  assert.equal(root.layout.gap, 12);
  assert.equal(root.layout.primary, 'between');
  assert.equal(root.layout.counter, 'center');
  assert.deepEqual(root.layout.padding, { top: 10, right: 0, bottom: 0, left: 20 });
  assert.deepEqual(root.style.fills, [{ color: '#ffffff', opacity: 1 }]);
  const names = (root.children || []).map((c) => c.name);
  assert.ok(!names.includes('gone'), 'display:none 子树应被跳过');
  const abs = (root.children || []).find((c) => c.name === 'abs');
  assert.equal(abs && abs.absolute, true, 'flex 父下 position:absolute 应输出 absolute:true');
  const card = (root.children || []).find((c) => c.name === 'card');
  assert.deepEqual(card.style.fills, [{ color: '#0000ff', opacity: 0.5 }], 'rgba 应转 hex+opacity');
  assert.deepEqual(card.style.strokes, [{ color: '#00ff00', opacity: 1 }]);
  assert.equal(card.style.radius, 8);
  const img = (root.children || []).find((c) => c.type === 'image');
  assert.equal(img && img.asset, 'logo');
});

// ==================== 2) 与 toIR 既有产物（fixture）键集合同构对照 ====================

test('FUN-ACC-703 验收：extract IR 与 toIR fixture（m7-rebuild）键集合同构', () => {
  const fixturePath = fileURLToPath(new URL('./fixtures/m7-rebuild/design-ir.json', import.meta.url));
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  assert.deepEqual(
    new Set(Object.keys(fixture)),
    IR_DOC_KEYS,
    'fixture 文档键集合应等于本验收的文档白名单（v/kind/root/truncated）'
  );

  // 收集 fixture（toIR 产物）用到的全部节点/样式键，extract 产物不得超出该词表
  const nodeKeys = new Set();
  const styleKeys = new Set();
  const walk = (n) => {
    for (const k of Object.keys(n)) nodeKeys.add(k);
    if (n.style) for (const k of Object.keys(n.style)) styleKeys.add(k);
    if (n.children) n.children.forEach(walk);
  };
  walk(fixture.root);

  const { nodes, stylesById, boxesById } = buildSynthetic();
  const ir = mapDomToIr({ nodes, stylesById, boxesById, rootSelector: '#app' });
  const errors = [];
  const walkExtract = (n, where) => {
    for (const k of Object.keys(n)) {
      if (!nodeKeys.has(k)) errors.push(`${where}: extract 键 "${k}" 不在 toIR fixture 词表中`);
    }
    if (n.style) {
      for (const k of Object.keys(n.style)) {
        if (!styleKeys.has(k)) errors.push(`${where}: style 键 "${k}" 不在 toIR fixture 词表中`);
      }
      const font = n.style.font;
      if (font && !(typeof font.family === 'string' && typeof font.style === 'string' && typeof font.size === 'number')) {
        errors.push(`${where}: font 结构与 toIR {family,style,size} 不同构`);
      }
    }
    if (n.children) n.children.forEach((c, i) => walkExtract(c, `${where}.children[${i}]`));
  };
  walkExtract(ir.root, 'root');
  assert.deepEqual(errors, [], `extract 与 toIR 不同构:\n${errors.join('\n')}`);

  // 文档结构同构：{v,kind,root,truncated}
  assert.deepEqual(Object.keys(ir).sort(), Object.keys(fixture).sort());
});

// ==================== 3) rebuild 可消费性（M7a 前置 schema 校验） ====================

test('FUN-ACC-703 验收：extract IR 可通过 rebuild 的 loadRebuildIr 前置校验且类型可被映射表处理', () => {
  const { nodes, stylesById, boxesById } = buildSynthetic();
  const ir = mapDomToIr({ nodes, stylesById, boxesById, rootSelector: '#app' });
  assertRebuildConsumable(ir);

  // rebuild 生成器的 build() 按 type 分派：覆盖到的类型必须 ∈ 映射表词表
  const types = [];
  const walk = (n) => {
    types.push(n.type);
    if (n.children) n.children.forEach(walk);
  };
  walk(ir.root);
  for (const t of types) {
    assert.ok(IR_TYPES.has(t), `rebuild 无法处理节点类型 "${t}"`);
  }
  // asset 键须满足 rebuild 的资产文件命名（assets/<key>.png，桥接拒绝空串/__proto__）
  const assets = [];
  const collect = (n) => {
    if (n.type === 'image' && n.asset) assets.push(n.asset);
    if (n.children) n.children.forEach(collect);
  };
  collect(ir.root);
  for (const a of assets) {
    assert.ok(a.length > 0 && a !== '__proto__', `asset 键 "${a}" 会被桥接拒绝`);
    assert.match(a, /^[A-Za-z0-9_.:-]+$/, `asset 键 "${a}" 不满足文件名白名单`);
  }
});
