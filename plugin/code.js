/**
 * Figma Agent Prototyper (Dev) — M1 插件骨架（sandbox 侧），M3 截图捕获，M4 素材能力，M5 原型交互
 *
 * 环境：Figma plugin sandbox。持有 figma API，无网络能力
 * （manifest networkAccess.allowedDomains 为 ["none"]）。
 * 与 ui.html（iframe）仅通过 postMessage 双向通信，不使用其他通道。
 *
 * 消息契约：
 * - 收（自 UI）：{ type: 'RUN_SCRIPT', code: string, jobId?: string, screenshot?: ScreenshotSpec,
 *   images?: {<name>: string(base64)} }
 *   ScreenshotSpec（M3，桥接侧已校验/clamp，此处防御性再校验）：
 *   { mode: 'node'|'rect'|'page', nodeId?: string, rect?: {x,y,width,height}, scale?: number }
 *   images（M4，桥接侧已校验限额，此处 base64 → Uint8Array 后注入脚本）：
 *   {<name>: base64}；手动模式无 images → 空对象。
 * - 回（至 UI）：{ type: 'RESULT', ok: boolean, message: string, jobId?: string,
 *   screenshotBase64?: string, screenshotError?: string }
 *   M2 起 jobId 由 UI 原样透传（手动运行为 undefined），用于桥接关联 OP 结果。
 *   M3 起：脚本 ok 且带 screenshot 时执行捕获；捕获失败不改写 ok（脚本成果不因截图问题丢失），
 *   仅附 screenshotError；仅 ok 且捕获成功才带 screenshotBase64。
 *
 * 截图规则（ADR-0002 token 预算）：必须区域化（node/rect）或显式 page，scale 默认 1、
 * clamp 到 [0.1, 4]，禁止默认整页高清。手动模式（无 screenshot）行为与 M1/M2 完全一致。
 *
 * 执行模型（ADR-0003）：Agent 脚本以 AsyncFunction 包装执行，注入 ('figma','readTree','images',
 * 'wireReaction') 四个实参，支持 await / return；整体 try/catch，失败时错误原样回传（含 loadFontAsync
 * 缺字体等 Figma 原生错误，不做二次包装）。
 * 不调用 figma.closePlugin（面板须保持可用）。
 *
 * M4 脚本环境（本切片新增）：
 * - readTree(spec)：过滤节点树导出器（ADR-0002 深度 + 字段白名单预算）。
 *   readTree({rootId?, depth?, fields?, maxNodes?}) → Promise<{root, count, truncated}>
 *   · rootId 缺省 = 当前页；depth 缺省 3、硬上限 10（root 为第 0 层，向下最多 depth 层）；
 *   · maxNodes 缺省 500、硬上限 2000，预算耗尽即截断并置 truncated:true；
 *   · fields 与白名单取交集，缺省核心集；节点属性只输出白名单字段
 *     （children 为树结构载体，不属于属性字段；叶子节点不含 children 键）；
 *   · fillSummary 为 fills 轻量摘要（最多前 3 个 paint，不输出完整 paint 对象）；
 *   · 字段级容错：单字段读取失败置 null，不拖垮整个 readTree。
 *   · 读取 chars 不需要 loadFontAsync（只有设置文本才需要）；fontName 输出 {family,style}。
 *   用法：const tree = await readTree({ depth: 2, fields: ['id','type','name'] });
 * - images：{<name>: Uint8Array}，脚本内 figma.createImage(images.logo) 创建图片填充。
 *   （FUN-ACC-402 的 createImage/填充、FUN-ACC-403 的 createComponent 均直接用原生 API，
 *   本插件不新增包装字体/组件 API——FUN-ACC-401/403 的错误原样冒泡即验收路径。）
 *
 * M5 脚本环境（本切片新增）：
 * - wireReaction(spec)：原型交互连线助手（INT-ACC-002/003），覆盖式写入 node.reactions。
 *   await wireReaction({sourceId, trigger?, action, destinationId?, animation?})
 *   → {sourceId, reactions:<写入后读回数组>, destinationId?(仅 NAVIGATE)}
 *   · trigger 缺省 'ON_CLICK'，允许 ON_CLICK | ON_HOVER | ON_PRESS；
 *   · action 允许 NAVIGATE | BACK；NAVIGATE 需要 destinationId（BACK 无 destinationId，
 *     多余的 destinationId 与 animation 被忽略——Figma 的 BACK action 不携带转场）；
 *   · animation 可选（缺省瞬时切换，不写 transition 字段）：{type, easing?, duration?}
 *     · type 允许 SMART_ANIMATE | DISSOLVE | MOVE_IN | MOVE_OUT | SLIDE_IN | SLIDE_OUT | PUSH
 *       （映射为 transition 仅这 7 种；无 animation = 瞬时 = 无 transition 字段）；
 *     · easing 允许 LINEAR | EASE_IN | EASE_OUT | EASE_IN_AND_OUT | GENTLE | QUICK | SLOW |
 *       BOUNCY，缺省 EASE_OUT；CUSTOM_CUBIC 等自定义缓动不支持（报错提示改用枚举值）；
 *     · duration 单位毫秒（缺省 300）——Figma transition.duration 为秒，写入时 /1000；
 *     · 方向型转场（MOVE_IN/MOVE_OUT/SLIDE_IN/SLIDE_OUT/PUSH）写入 direction（可传，
 *       缺省 'LEFT'）与 matchLayers:false（Figma typings 对 DirectionalTransition 必填）；
 *   · 校验失败 throw，消息含相关节点 id 或允许值列表（INT-ACC-003）；
 *   · 对同节点多次调用是覆盖不是追加（node.reactions = [本次单条]）。
 *
 * M6a 脚本环境（本切片新增）：
 * - toIR(spec)：设计 IR 抽取器（FUN-ACC-601，Design→Code 通道）。
 *   toIR({rootId?, depth?, fields?, maxNodes?}) → Promise<{ir, assets}>
 *   · ir = {v:1, kind:'design-ir', root, truncated}；节点结构
 *     {type, name, layout:{mode,gap?,padding?}, style:{fills,strokes,radius,effects,font},
 *      text?, asset?, children?}；type ∈ frame|text|image|component|instance；
 *   · 字段白名单/深度/节点预算完全继承 readTree（M4）：depth 缺省 3、硬上限 10；
 *     maxNodes 缺省 500、硬上限 2000；未知字段忽略；预算耗尽置 truncated:true；
 *   · 确定性映射 Plugin API：layoutMode NONE/HORIZONTAL/VERTICAL → mode；
 *     itemSpacing → gap；paddingLeft/Top/Right/Bottom → padding（四边，任一非零才出现）；
 *     cornerRadius → radius；characters → text；fontSize/fontName → font；
 *     fills 只取可见 SOLID 纯色（hex+opacity），GRADIENT/IMAGE 填充归入 image 处理；
 *   · 图片填充节点（含 IMAGE / GRADIENT 填充）：exportAsync（PNG，scale 1）导出字节，
 *     收集进 assets 集（base64，名字用节点 id 防止冲突），节点标记 {type:'image', asset:nodeId}；
 *   · 整体 try/catch 原样回传（与 readTree 一致）；字段级容错：单字段读取/导出失败不拖垮整体。
 *   · 脚本返回值通道（M6a）：脚本 return 对象/数组（非 undefined）→ JSON 序列化进
 *     RESULT.data（≤20MB，与 M4 图片总量一致），超限置 ok:false；其余返回值走原 message 通道。
 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const SCREENSHOT_SCALE_MIN = 0.1;
const SCREENSHOT_SCALE_MAX = 4;
const RECT_SCRATCH_X = -100000; // 临时帧放置处：远离画布，避免污染视图
const RECT_SCRATCH_Y = -100000;

/** 防御性规范化截图参数；返回 null 表示无有效截图参数。 */
function normalizeScreenshot(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const mode = spec.mode;
  if (mode !== 'node' && mode !== 'rect' && mode !== 'page') return null;
  let scale = 1;
  if (typeof spec.scale === 'number' && Number.isFinite(spec.scale)) {
    scale = Math.min(SCREENSHOT_SCALE_MAX, Math.max(SCREENSHOT_SCALE_MIN, spec.scale));
  }
  if (mode === 'node') {
    if (typeof spec.nodeId !== 'string' || spec.nodeId.length === 0) return null;
    return { mode: mode, nodeId: spec.nodeId, scale: scale };
  }
  if (mode === 'rect') {
    const r = spec.rect;
    if (!r || typeof r !== 'object') return null;
    const x = r.x, y = r.y, width = r.width, height = r.height;
    const nums = [x, y, width, height];
    for (let i = 0; i < nums.length; i++) {
      if (typeof nums[i] !== 'number' || !Number.isFinite(nums[i])) return null;
    }
    return { mode: mode, rect: { x: x, y: y, width: width, height: height }, scale: scale };
  }
  return { mode: mode, scale: scale };
}

function boxesIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
         a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * 按 ScreenshotSpec 捕获 PNG 字节。
 * - node：getNodeByIdAsync → exportAsync（SCALE constraint）
 * - rect：当前页顶层节点中取 absoluteBoundingBox 与 rect 相交者，clone 进临时帧
 *   （尺寸=rect、clipsContent、无填充、置于远离画布处）按相对坐标定位后导出，
 *   finally 保证临时帧移除。
 * - page：currentPage.exportAsync（预算警告路径：调用方显式选择）。
 */
async function captureScreenshot(spec) {
  const constraint = { type: 'SCALE', value: spec.scale };
  if (spec.mode === 'node') {
    const node = await figma.getNodeByIdAsync(spec.nodeId);
    if (!node) throw new Error('screenshot node not found: ' + spec.nodeId);
    return await node.exportAsync({ format: 'PNG', constraint: constraint });
  }
  if (spec.mode === 'page') {
    return await figma.currentPage.exportAsync({ format: 'PNG', constraint: constraint });
  }
  // rect 模式：临时帧拼装区域
  const rect = spec.rect;
  const targets = figma.currentPage.children.filter(function (node) {
    const bb = node.absoluteBoundingBox; // 顶层节点的页面绝对包围盒
    return !!bb && boxesIntersect(bb, rect);
  });
  const tempFrame = figma.createFrame();
  try {
    tempFrame.resize(rect.width, rect.height);
    tempFrame.clipsContent = true;
    tempFrame.fills = [];
    tempFrame.x = RECT_SCRATCH_X;
    tempFrame.y = RECT_SCRATCH_Y;
    for (let i = 0; i < targets.length; i++) {
      const original = targets[i];
      const bb = original.absoluteBoundingBox;
      const clone = original.clone();
      tempFrame.appendChild(clone);
      clone.x = bb.x - rect.x;
      clone.y = bb.y - rect.y;
    }
    return await tempFrame.exportAsync({ format: 'PNG', constraint: constraint });
  } finally {
    tempFrame.remove(); // 任何路径（含导出失败）都清理临时帧
  }
}

// ---- M4：readTree 过滤节点树导出器（ADR-0002：深度 + 字段白名单 + 节点预算） ----

/** 属性字段白名单：exporter 只可能输出这些字段（children 为树结构，不在白名单内） */
const READ_TREE_ALL_FIELDS = [
  'id', 'name', 'type', 'x', 'y', 'width', 'height', 'visible', 'opacity',
  'chars', 'fontSize', 'fontName', 'layoutMode', 'itemSpacing',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
  'cornerRadius', 'componentId', 'components', 'fillSummary',
];
/** 缺省核心集（token 预算：够定位/建组件/查填充即可） */
const READ_TREE_DEFAULT_FIELDS = [
  'id', 'name', 'type', 'x', 'y', 'width', 'height',
  'chars', 'fontSize', 'fillSummary', 'componentId',
];
const READ_TREE_DEPTH_DEFAULT = 3;
const READ_TREE_DEPTH_HARD_MAX = 10;
const READ_TREE_MAX_NODES_DEFAULT = 500;
const READ_TREE_MAX_NODES_HARD_MAX = 2000;
const READ_TREE_FILL_MAX = 3; // fillSummary 最多输出前 3 个 paint
/** 才递归 children 的容器类型 */
const READ_TREE_CONTAINER_TYPES = [
  'FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'DOCUMENT', 'PAGE',
];

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** UTF-8 字节长度（Figma sandbox 无 Node Buffer；与 bridge 侧 Buffer.byteLength 行为一致） */
function utf8ByteLength(str) {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i += 1; } // 代理对
    else bytes += 3;
  }
  return bytes;
}

/** fills 轻量摘要：[{type, color:{r,g,b}保留3位, opacity?, imageScaleMode?}]，最多前 3 个 */
function readTreeFillSummary(node) {
  try {
    const fills = node.fills;
    if (!fills || fills === figma.mixed || typeof fills.length !== 'number') return null;
    const out = [];
    const n = Math.min(fills.length, READ_TREE_FILL_MAX);
    for (let i = 0; i < n; i++) {
      const p = fills[i];
      if (!p || typeof p.type !== 'string') continue;
      const item = { type: p.type };
      if (p.type === 'SOLID' && p.color && typeof p.color === 'object') {
        item.color = { r: round3(p.color.r), g: round3(p.color.g), b: round3(p.color.b) };
      }
      if (isNum(p.opacity) && p.opacity !== 1) item.opacity = round3(p.opacity);
      if (p.type === 'IMAGE' && typeof p.scaleMode === 'string') item.imageScaleMode = p.scaleMode;
      out.push(item);
    }
    return out;
  } catch (err) {
    return null; // 字段级容错
  }
}

/** COMPONENT_SET → 其下 COMPONENT 的 [{id,name}]；其余类型为 null */
function readTreeComponents(node) {
  try {
    if (node.type !== 'COMPONENT_SET') return null;
    const kids = node.children;
    const out = [];
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] && kids[i].type === 'COMPONENT') {
        out.push({ id: kids[i].id, name: kids[i].name });
      }
    }
    return out;
  } catch (err) {
    return null;
  }
}

/**
 * 单节点白名单导出。逐字段 try/catch：单字段读取失败置 null，
 * 不让整个 readTree 崩（FUN-ACC-404 字段级容错）。
 */
function readTreeNodeFields(node, fields) {
  const out = {};
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    try {
      if (f === 'id') { out.id = node.id; }
      else if (f === 'name') { out.name = node.name; }
      else if (f === 'type') { out.type = node.type; }
      else if (f === 'x') { out.x = isNum(node.x) ? round3(node.x) : null; }
      else if (f === 'y') { out.y = isNum(node.y) ? round3(node.y) : null; }
      else if (f === 'width') { out.width = isNum(node.width) ? round3(node.width) : null; }
      else if (f === 'height') { out.height = isNum(node.height) ? round3(node.height) : null; }
      else if (f === 'visible') { out.visible = typeof node.visible === 'boolean' ? node.visible : null; }
      else if (f === 'opacity') { out.opacity = isNum(node.opacity) ? round3(node.opacity) : null; }
      else if (f === 'chars') { out.chars = typeof node.characters === 'string' ? node.characters : null; }
      else if (f === 'fontSize') { out.fontSize = isNum(node.fontSize) ? node.fontSize : null; } // 混合字号 → null
      else if (f === 'fontName') {
        const fn = node.fontName; // 混合字体为 figma.mixed 符号 → null
        out.fontName = fn && fn !== figma.mixed ? { family: fn.family, style: fn.style } : null;
      }
      else if (f === 'layoutMode') { out.layoutMode = typeof node.layoutMode === 'string' ? node.layoutMode : null; }
      else if (f === 'itemSpacing') { out.itemSpacing = isNum(node.itemSpacing) ? round3(node.itemSpacing) : null; }
      else if (f === 'paddingLeft') { out.paddingLeft = isNum(node.paddingLeft) ? round3(node.paddingLeft) : null; }
      else if (f === 'paddingRight') { out.paddingRight = isNum(node.paddingRight) ? round3(node.paddingRight) : null; }
      else if (f === 'paddingTop') { out.paddingTop = isNum(node.paddingTop) ? round3(node.paddingTop) : null; }
      else if (f === 'paddingBottom') { out.paddingBottom = isNum(node.paddingBottom) ? round3(node.paddingBottom) : null; }
      else if (f === 'cornerRadius') { out.cornerRadius = isNum(node.cornerRadius) ? round3(node.cornerRadius) : null; }
      else if (f === 'componentId') { out.componentId = typeof node.componentId === 'string' ? node.componentId : null; }
      else if (f === 'components') { out.components = readTreeComponents(node); }
      else if (f === 'fillSummary') { out.fillSummary = readTreeFillSummary(node); }
      // 白名单外字段不输出（fields 入口已取交集，此处兜底）
    } catch (err) {
      out[f] = null;
    }
  }
  return out;
}

/**
 * readTree({rootId?, depth?, fields?, maxNodes?}) → Promise<{root, count, truncated}>
 * 注入脚本作用域（AsyncFunction 第 2 实参）；脚本侧 await 调用。
 */
async function figmaReadTree(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};

  // fields：请求与白名单取交集；交集为空或缺省 → 核心集
  let fields = READ_TREE_DEFAULT_FIELDS.slice();
  if (Array.isArray(s.fields)) {
    const requested = [];
    for (let i = 0; i < s.fields.length; i++) {
      const f = s.fields[i];
      if (typeof f === 'string' &&
          READ_TREE_ALL_FIELDS.indexOf(f) !== -1 &&
          requested.indexOf(f) === -1) {
        requested.push(f);
      }
    }
    if (requested.length > 0) fields = requested;
  }

  // depth / maxNodes：缺省 + 硬上限 clamp（ADR-0002 预算约束）
  let depth = READ_TREE_DEPTH_DEFAULT;
  if (isNum(s.depth)) depth = Math.min(READ_TREE_DEPTH_HARD_MAX, Math.max(0, Math.floor(s.depth)));
  let maxNodes = READ_TREE_MAX_NODES_DEFAULT;
  if (isNum(s.maxNodes)) maxNodes = Math.min(READ_TREE_MAX_NODES_HARD_MAX, Math.max(1, Math.floor(s.maxNodes)));

  // root：rootId 缺省 = 当前页
  let root;
  if (typeof s.rootId === 'string' && s.rootId.length > 0) {
    root = await figma.getNodeByIdAsync(s.rootId);
    if (!root) throw new Error('readTree: node not found: ' + s.rootId);
  } else {
    root = figma.currentPage;
  }

  const rootOut = readTreeNodeFields(root, fields);
  let count = 1;
  let truncated = false;

  // level：node 自身所在层（root=0）；仅容器类型递归，向下不超过 depth 层。
  // 预算检查放在"读到下一个真实存在的子节点"之前：只有真的发生节点被跳过才置 truncated。
  function buildChildren(node, outNode, level) {
    if (level >= depth) return;
    if (READ_TREE_CONTAINER_TYPES.indexOf(node.type) === -1) return;
    let children;
    try {
      children = node.children;
    } catch (err) {
      return;
    }
    if (!children || typeof children.length !== 'number') return;
    for (let i = 0; i < children.length; i++) {
      if (count >= maxNodes) {
        truncated = true; // 该子节点真实存在但被预算跳过
        return;
      }
      const child = children[i];
      const childOut = readTreeNodeFields(child, fields);
      count += 1;
      if (!outNode.children) outNode.children = [];
      outNode.children.push(childOut);
      buildChildren(child, childOut, level + 1);
      if (truncated) return;
    }
  }

  buildChildren(root, rootOut, 0);
  return { root: rootOut, count: count, truncated: truncated };
}

// ---- M4：images 解码（UI 透传 {name: base64} → 脚本可用 {name: Uint8Array}） ----

/**
 * 把 base64 映射逐项解码为 Uint8Array（figma.base64Decode，与 base64Encode 对称）。
 * 单图解码失败只跳过该图（桥接侧已校验，此处防御），不影响其他图与脚本执行。
 */
function decodeImages(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const names = Object.keys(raw);
  for (let i = 0; i < names.length; i++) {
    const b64 = raw[names[i]];
    if (typeof b64 !== 'string' || b64.length === 0) continue;
    try {
      const bytes = figma.base64Decode(b64);
      if (bytes && bytes.length > 0) out[names[i]] = bytes;
    } catch (err) {
      // 跳过解码失败的条目
    }
  }
  return out;
}

// ---- M5：wireReaction 原型交互助手（INT-ACC-002/003，覆盖式 node.reactions 写入） ----

/** trigger 白名单（M5 契约）；缺省 ON_CLICK */
const WIRE_TRIGGER_TYPES = ['ON_CLICK', 'ON_HOVER', 'ON_PRESS'];
/** action 白名单（M5 契约） */
const WIRE_ACTION_TYPES = ['NAVIGATE', 'BACK'];
/** 生成 transition 的 animation.type（Figma typings：SimpleTransition + DirectionalTransition） */
const WIRE_TRANSITION_TYPES = ['SMART_ANIMATE', 'DISSOLVE', 'MOVE_IN', 'MOVE_OUT', 'SLIDE_IN', 'SLIDE_OUT', 'PUSH'];
/** DirectionalTransition 的 direction 白名单（typings 必填字段，缺省 LEFT） */
const WIRE_DIRECTIONS = ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'];
/** 方向型转场类型（写入 direction + matchLayers） */
const WIRE_DIRECTIONAL_TYPES = ['MOVE_IN', 'MOVE_OUT', 'SLIDE_IN', 'SLIDE_OUT', 'PUSH'];
/** easing 白名单（M5 契约）；缺省 EASE_OUT，CUSTOM_CUBIC 类自定义缓动明确拒绝 */
const WIRE_EASING_TYPES = ['LINEAR', 'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'GENTLE', 'QUICK', 'SLOW', 'BOUNCY'];
/** animation.duration 缺省值（毫秒）；Figma transition.duration 为秒，写入时 /1000 */
const WIRE_DURATION_DEFAULT_MS = 300;

/** transition 类型白名单文本（错误提示用） */
const WIRE_TRANSITION_HINT = WIRE_TRANSITION_TYPES.join(' | ');
/** easing 类型白名单文本（错误提示用） */
const WIRE_EASING_HINT = WIRE_EASING_TYPES.join(' | ');

/**
 * 把 animation 对象映射为 Figma transition（仅当 animation.type 在 7 种转场内被调用）。
 * duration 毫秒 → 秒；easing → {type}（不支持 easingFunction，CUSTOM_CUBIC 已在入口拒绝）；
 * 方向型转场补 direction（缺省 LEFT）与 matchLayers:false（typings 必填，避免运行时被拒）。
 */
function wireBuildTransition(animation) {
  let durationMs = WIRE_DURATION_DEFAULT_MS;
  if (animation.duration !== undefined && animation.duration !== null) {
    if (typeof animation.duration !== 'number' || !Number.isFinite(animation.duration) || animation.duration < 0) {
      throw new Error('wireReaction: animation.duration 须为非负数字（毫秒），收到: ' + String(animation.duration));
    }
    durationMs = animation.duration;
  }
  const transition = {
    type: animation.type,
    duration: Math.round((durationMs / 1000) * 1000) / 1000, // 毫秒 → 秒（Figma 单位）
  };
  let easingType = 'EASE_OUT';
  if (animation.easing !== undefined && animation.easing !== null) {
    const e = animation.easing;
    if (typeof e !== 'string' || WIRE_EASING_TYPES.indexOf(e) === -1) {
      throw new Error(
        'wireReaction: 非法 animation.easing "' + String(e) +
        '"（允许值: ' + WIRE_EASING_HINT +
        '；CUSTOM_CUBIC 等自定义缓动本工具不支持，请改用上述枚举值）'
      );
    }
    easingType = e;
  }
  transition.easing = { type: easingType };
  if (WIRE_DIRECTIONAL_TYPES.indexOf(animation.type) !== -1) { // MOVE_IN/MOVE_OUT/PUSH/SLIDE_IN/SLIDE_OUT 为方向型
    const dir = animation.direction === undefined || animation.direction === null ? 'LEFT' : animation.direction;
    if (typeof dir !== 'string' || WIRE_DIRECTIONS.indexOf(dir) === -1) {
      throw new Error(
        'wireReaction: 非法 animation.direction "' + String(dir) +
        '"（允许值: ' + WIRE_DIRECTIONS.join(' | ') + '）'
      );
    }
    transition.direction = dir;
    transition.matchLayers = false;
  }
  return transition;
}

/**
 * wireReaction({sourceId, trigger?, action, destinationId?, animation?}) → Promise<result>
 * 注入脚本作用域（AsyncFunction 第 4 实参）；脚本侧 await 调用。
 * 校验顺序：sourceId 在场 → trigger/action/animation 纯值白名单 → 源节点存在 →
 * NAVIGATE 的 destinationId 在场且存在。全部通过才写 node.reactions 并读回。
 */
async function figmaWireReaction(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('wireReaction: 参数须为对象 {sourceId, trigger?, action, destinationId?, animation?}');
  }
  const sourceId = spec.sourceId;
  const trigger = spec.trigger === undefined || spec.trigger === null ? 'ON_CLICK' : spec.trigger;
  const action = spec.action;
  const animation = spec.animation;

  // sourceId 在场性（报错须含 id 位置；缺失时无 id 可填，原样串化）
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new Error('wireReaction: 源节点不存在 (' + String(sourceId) + ')');
  }

  // 纯值校验：在触达 Figma 之前拒绝非法值（INT-ACC-003）
  if (typeof trigger !== 'string' || WIRE_TRIGGER_TYPES.indexOf(trigger) === -1) {
    throw new Error(
      'wireReaction: 非法 trigger "' + String(trigger) +
      '"（允许值: ' + WIRE_TRIGGER_TYPES.join(' | ') + '）'
    );
  }
  if (typeof action !== 'string' || WIRE_ACTION_TYPES.indexOf(action) === -1) {
    throw new Error(
      'wireReaction: 非法 action "' + String(action) +
      '"（允许值: ' + WIRE_ACTION_TYPES.join(' | ') + '）'
    );
  }
  let transition = null;
  if (animation !== undefined && animation !== null) {
    if (!animation || typeof animation !== 'object' ||
        typeof animation.type !== 'string' || WIRE_TRANSITION_TYPES.indexOf(animation.type) === -1) {
      const got = animation && typeof animation === 'object' ? String(animation.type) : String(animation);
      throw new Error(
        'wireReaction: 非法 animation.type "' + got +
        '"（允许值: ' + WIRE_TRANSITION_HINT + '；不传 animation = 瞬时切换，无 transition 字段）'
      );
    }
    transition = wireBuildTransition(animation);
  }

  // 节点存在性校验：报错必须包含相关节点 id（INT-ACC-003）
  const source = await figma.getNodeByIdAsync(sourceId);
  if (!source) {
    throw new Error('wireReaction: 源节点不存在 (' + sourceId + ')');
  }
  const destinationId = spec.destinationId;
  if (action === 'NAVIGATE') {
    if (typeof destinationId !== 'string' || destinationId.length === 0) {
      throw new Error('wireReaction: NAVIGATE 需要 destinationId (source: ' + sourceId + ')');
    }
    const destination = await figma.getNodeByIdAsync(destinationId);
    if (!destination) {
      throw new Error(
        'wireReaction: 目标节点不存在 (source: ' + sourceId + ', destination: ' + destinationId + ')'
      );
    }
  }

  // 组装并覆盖式写入。注意：当前 Figma 桌面端 API 已废弃单数 action 字段
  // （set_reactions 报 "Please update the 'actions' field instead of the 'action'
  //  field in order to prevent data loss"），必须写复数 actions 数组（501 复现实测发现）。
  let reaction;
  if (action === 'BACK') {
    reaction = { trigger: { type: trigger }, actions: [{ type: 'BACK' }] }; // BACK 无 destinationId/transition
  } else {
    const nodeAction = { type: 'NODE', destinationId: destinationId, navigation: 'NAVIGATE' };
    if (transition) nodeAction.transition = transition;
    reaction = { trigger: { type: trigger }, actions: [nodeAction] };
  }
  source.reactions = [reaction]; // 覆盖式：多次调用对同节点是替换不是追加

  const result = { sourceId: sourceId, reactions: source.reactions }; // 读回返回
  if (action === 'NAVIGATE') result.destinationId = destinationId;
  return result;
}

// ---- M6a：toIR 设计 IR 抽取（Design→Code 通道，FUN-ACC-601）----

/** IR 节点类型白名单（字段白名单：除 children 外的节点顶层键） */
const TOIR_NODE_KEYS = ['type', 'name', 'layout', 'style', 'text', 'asset', 'children'];
/** 深度/节点预算（继承 readTree） */
const TOIR_DEPTH_DEFAULT = 3;
const TOIR_DEPTH_HARD_MAX = 10;
const TOIR_MAX_NODES_DEFAULT = 500;
const TOIR_MAX_NODES_HARD_MAX = 2000;
/** RESULT.data 序列化上限（与 M4 图片总量一致） */
const TOIR_DATA_MAX_BYTES = 20 * 1024 * 1024;
/** 可递归 children 的容器类型 */
const TOIR_CONTAINER_TYPES = [
  'FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'DOCUMENT', 'PAGE',
];
/** 栅格填充类型（归入 image 处理） */
const TOIR_RASTER_FILL_TYPES = [
  'IMAGE', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND',
];

/** layoutMode（Plugin API）→ IR layout.mode */
function toIrLayoutMode(mode) {
  if (mode === 'HORIZONTAL') return 'horizontal';
  if (mode === 'VERTICAL') return 'vertical';
  return 'none';
}

/** 节点是否含栅格填充（IMAGE / GRADIENT）→ 判定为 image 节点 */
function nodeHasRasterFill(node) {
  try {
    const fills = node.fills;
    if (!fills || fills === figma.mixed || typeof fills.length !== 'number') return false;
    for (let i = 0; i < fills.length; i++) {
      const p = fills[i];
      if (p && TOIR_RASTER_FILL_TYPES.indexOf(p.type) !== -1) return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}

/** 节点 → IR type（image 优先：含栅格填充即 image；其余按 Plugin 类型映射） */
function toIrNodeType(node) {
  if (nodeHasRasterFill(node)) return 'image';
  const t = node.type;
  if (t === 'TEXT') return 'text';
  if (t === 'COMPONENT') return 'component';
  if (t === 'INSTANCE') return 'instance';
  return 'frame'; // FRAME/GROUP/SECTION/COMPONENT_SET/DOCUMENT/PAGE/RECTANGLE/ELLIPSE 等 → frame
}

/** 单个 SOLID 可见填充 → {color:'#rrggbb', opacity?}；非 SOLID / 不可见 / 缺颜色 → null */
function toIrSolidFill(paint) {
  if (!paint || paint.type !== 'SOLID' || paint.visible === false) return null;
  const c = paint.color;
  if (!c || typeof c.r !== 'number') return null;
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const hex = '#' + [r, g, b].map((v) => (v < 16 ? '0' : '') + v.toString(16)).join('');
  const item = { color: hex };
  if (typeof paint.opacity === 'number' && paint.opacity !== 1) item.opacity = round3(paint.opacity);
  return item;
}

/** 构建单个 IR 节点（同步部分 + 异步栅格导出）；字段级容错：单字段失败不影响整体 */
async function buildIrNode(node, assets) {
  const type = toIrNodeType(node);
  const out = {
    type: type,
    name: typeof node.name === 'string' ? node.name : '',
  };

  // layout：mode 恒出现；gap（itemSpacing）/ padding（四边）仅在非 none 且非零时出现
  const layout = { mode: 'none' };
  try {
    if (typeof node.layoutMode === 'string') layout.mode = toIrLayoutMode(node.layoutMode);
  } catch (err) { /* 字段级容错 */ }
  if (layout.mode !== 'none') {
    let gap;
    try { gap = isNum(node.itemSpacing) ? round3(node.itemSpacing) : null; } catch (err) { gap = null; }
    let pl = 0, pt = 0, pr = 0, pb = 0;
    try { pl = isNum(node.paddingLeft) ? round3(node.paddingLeft) : 0; } catch (err) { pl = 0; }
    try { pt = isNum(node.paddingTop) ? round3(node.paddingTop) : 0; } catch (err) { pt = 0; }
    try { pr = isNum(node.paddingRight) ? round3(node.paddingRight) : 0; } catch (err) { pr = 0; }
    try { pb = isNum(node.paddingBottom) ? round3(node.paddingBottom) : 0; } catch (err) { pb = 0; }
    if (gap !== null) layout.gap = gap;
    if (pl !== 0 || pt !== 0 || pr !== 0 || pb !== 0) {
      layout.padding = { left: pl, top: pt, right: pr, bottom: pb };
    }
  }
  out.layout = layout;

  // style：fills / strokes（仅可见 SOLID 纯色）/ radius / effects / font
  const style = {};
  try {
    const fills = node.fills;
    if (fills && fills !== figma.mixed && typeof fills.length === 'number') {
      const arr = [];
      for (let i = 0; i < fills.length; i++) {
        const f = toIrSolidFill(fills[i]);
        if (f) arr.push(f);
      }
      if (arr.length) style.fills = arr;
    }
  } catch (err) { /* 字段级容错 */ }
  try {
    const strokes = node.strokes;
    if (strokes && strokes !== figma.mixed && typeof strokes.length === 'number') {
      const arr = [];
      for (let i = 0; i < strokes.length; i++) {
        const s = toIrSolidFill(strokes[i]);
        if (s) arr.push(s);
      }
      if (arr.length) style.strokes = arr;
    }
  } catch (err) { /* 字段级容错 */ }
  try {
    if (isNum(node.cornerRadius) && node.cornerRadius !== figma.mixed) {
      style.radius = round3(node.cornerRadius);
    }
  } catch (err) { /* 字段级容错 */ }
  try {
    const eff = node.effects;
    if (Array.isArray(eff) && eff.length) {
      const arr = eff
        .filter((e) => e && typeof e.type === 'string')
        .map((e) => ({ type: e.type, visible: e.visible !== false }));
      if (arr.length) style.effects = arr;
    }
  } catch (err) { /* 字段级容错 */ }
  if (type === 'text') {
    const font = {};
    try { if (isNum(node.fontSize)) font.size = node.fontSize; } catch (err) { /* 容错 */ }
    try {
      const fn = node.fontName;
      if (fn && fn !== figma.mixed && fn.family) {
        font.family = fn.family;
        if (fn.style) font.style = fn.style;
      }
    } catch (err) { /* 容错 */ }
    if (Object.keys(font).length) style.font = font;
  }
  if (Object.keys(style).length) out.style = style;

  // text：TEXT 节点的 characters
  if (type === 'text') {
    try {
      if (typeof node.characters === 'string') out.text = node.characters;
    } catch (err) { /* 字段级容错 */ }
  }

  // image 节点：exportAsync（PNG, scale 1）导出 → assets（名字 = 节点 id，防冲突）
  if (type === 'image') {
    out.asset = node.id; // 引用名恒为节点 id
    try {
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
      if (bytes && (typeof bytes.length !== 'number' || bytes.length > 0)) {
        assets[node.id] = figma.base64Encode(bytes);
      }
    } catch (err) {
      // 导出失败：仍标记 image（asset 引用存在），资产缺失不拖垮整体
    }
  }

  return out;
}

/**
 * toIR({rootId?, depth?, fields?, maxNodes?}) → Promise<{ir, assets}>
 * 注入脚本作用域（AsyncFunction 第 5 实参）；脚本侧 await 调用。
 * 返回值约定：{ir, assets:{<nodeId>:base64}} 整体作为脚本返回值（→ RESULT.data）。
 */
async function figmaToIR(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};

  // depth / maxNodes：缺省 + 硬上限 clamp（继承 readTree / ADR-0002 预算约束）
  let depth = TOIR_DEPTH_DEFAULT;
  if (isNum(s.depth)) depth = Math.min(TOIR_DEPTH_HARD_MAX, Math.max(0, Math.floor(s.depth)));
  let maxNodes = TOIR_MAX_NODES_DEFAULT;
  if (isNum(s.maxNodes)) maxNodes = Math.min(TOIR_MAX_NODES_HARD_MAX, Math.max(1, Math.floor(s.maxNodes)));

  // root：rootId 缺省 = 当前页
  let root;
  if (typeof s.rootId === 'string' && s.rootId.length > 0) {
    root = await figma.getNodeByIdAsync(s.rootId);
    if (!root) throw new Error('toIR: node not found: ' + s.rootId);
  } else {
    root = figma.currentPage;
  }

  const assets = {};
  const rootNode = await buildIrNode(root, assets);
  let count = 1;
  let truncated = false;

  // level：node 自身所在层（root=0）；容器类型递归，向下不超过 depth 层；
  // 栅格（image）节点为叶，不再递归。预算检查放在"读到下一个真实存在的子节点"之前。
  async function descend(srcNode, outNode, level) {
    if (level >= depth) return;
    if (TOIR_CONTAINER_TYPES.indexOf(srcNode.type) === -1) return;
    if (outNode.type === 'image') return; // 栅格节点为叶
    let children;
    try {
      children = srcNode.children;
    } catch (err) {
      return;
    }
    if (!children || typeof children.length !== 'number') return;
    for (let i = 0; i < children.length; i++) {
      if (count >= maxNodes) {
        truncated = true; // 该子节点真实存在但被预算跳过
        return;
      }
      const child = children[i];
      const childOut = await buildIrNode(child, assets);
      count += 1;
      if (!outNode.children) outNode.children = [];
      outNode.children.push(childOut);
      await descend(child, childOut, level + 1);
      if (truncated) return;
    }
  }

  await descend(root, rootNode, 0);
  const ir = { v: 1, kind: 'design-ir', root: rootNode, truncated: truncated };
  return { ir: ir, assets: assets };
}

figma.showUI(__html__, { width: 360, height: 480 });

figma.ui.onmessage = async (msg) => {
  if (!msg || msg.type !== 'RUN_SCRIPT') return;

  // M3：screenshot 参数（undefined = 无截图，行为与 M1/M2 一致；有值但非法 → 捕获失败路径）
  const shotSpec = normalizeScreenshot(msg.screenshot);
  const shotSpecInvalid = msg.screenshot !== undefined && msg.screenshot !== null && shotSpec === null;

  if (typeof msg.code !== 'string') {
    figma.ui.postMessage({
      type: 'RESULT',
      ok: false,
      jobId: msg.jobId, // M2：透传桥接 jobId（手动运行为 undefined）
      message: 'RUN_SCRIPT 载荷缺少 code 字符串字段',
    });
    return;
  }

  // M4：images 解码（{name: base64} → {name: Uint8Array}）；手动模式无 images → 空对象
  const images = decodeImages(msg.images);

  try {
    // M4/M5/M6a：注入 ('figma','readTree','images','wireReaction','toIR') 五个实参（手动模式同样注入，无害）；
    // 错误经整体 catch 原样回传
    const run = new AsyncFunction('figma', 'readTree', 'images', 'wireReaction', 'toIR', '"use strict";\n' + msg.code);
    const result = await run(figma, figmaReadTree, images, figmaWireReaction, figmaToIR);

    // 返回值通道（M6a）：对象/数组（非 undefined）→ JSON 序列化进 RESULT.data（≤20MB）；
    // 其余（undefined/string/number/boolean）→ 走原 message 通道。
    let data;
    let message;
    if (result === undefined) {
      message = '执行成功';
    } else if (result !== null && typeof result === 'object') {
      const serialized = JSON.stringify(result);
      if (utf8ByteLength(serialized) > TOIR_DATA_MAX_BYTES) {
        throw new Error(
          'RESULT.data 序列化后 ' + utf8ByteLength(serialized) +
          ' 字节，超过上限 ' + TOIR_DATA_MAX_BYTES + '（20MB）'
        );
      }
      data = serialized;
      message = '执行成功';
    } else {
      message = String(result);
    }

    const reply = {
      type: 'RESULT',
      ok: true,
      jobId: msg.jobId, // M2：透传桥接 jobId（手动运行为 undefined）
      message: message,
    };
    if (data !== undefined) reply.data = data; // M6a：RESULT 新增可选 data 字段
    // M3：仅 ok 路径捕获截图；捕获失败不使 Job 失败，只附 screenshotError
    if (shotSpecInvalid) {
      reply.screenshotError = 'invalid screenshot spec (mode/nodeId/rect/scale)';
    } else if (shotSpec) {
      try {
        const bytes = await captureScreenshot(shotSpec);
        reply.screenshotBase64 = figma.base64Encode(bytes);
      } catch (err) {
        reply.screenshotError = err instanceof Error ? err.message : String(err);
      }
    }
    figma.ui.postMessage(reply);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stackFirstLine =
      err && err.stack ? String(err.stack).split('\n')[0].trim() : '';
    let full = message;
    if (stackFirstLine && full && stackFirstLine.indexOf(full) === -1) {
      full += '\n' + stackFirstLine;
    } else if (!full && stackFirstLine) {
      full = stackFirstLine;
    }
    figma.ui.postMessage({ type: 'RESULT', ok: false, jobId: msg.jobId, message: full });
  }
};
