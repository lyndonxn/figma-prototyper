/**
 * M7b：HTML → IR 抽取（Code→Design 逆向闭环第一步）
 *
 * 架构（spec/03「逆向转换契约 — DOM 抽取」明文要求）：
 *   - 纯映射函数 `mapDomToIr(...)`：输入为 CDP 拉平的 DOM/style/box 数据，输出与 toIR 同构的
 *     IR schema v1 对象；可独立单测，无网络/无 CDP 依赖。
 *   - CDP 编排 `extract({...})`：拉起系统 Chrome（`--headless=new --remote-debugging-port`）
 *     或经 `--cdp-url` 直连已运行的 DevTools 端点，走 CDP（Page/DOM/CSS）把页面转成
 *     {nodes, stylesById, boxesById}，再调 mapDomToIr 得 IR；图片经
 *     `Page.captureScreenshot` 取得字节，随 IR 一并返回。
 *
 * 仅新增 `ws` 依赖（ADR-0005：零新增依赖家族，cli 引入 ws 而非 Playwright）。
 *
 * 退出码约定（由调用方 figmapt.js 解释）：
 *   - 本模块抛 `Error` 且 `err.code === 'BAD_SELECTOR'` 表示 selector 未匹配 → 调用方转 exit 2。
 *   - 其余错误（Chrome 执行失败 / CDP 错误 / 超时）由调用方转 exit 1。
 *   - Chrome 缺失由调用方在拉起前先判定（resolveChrome 返回 null）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

// ==================== 工具 ====================

/** 数值对齐 toIR 的 round3 惯例（统一精度，避免浮点噪声） */
export function round3(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/** 属性数组 [name,val,name,val,...] → 对象 */
function attrMap(node) {
  const out = {};
  const a = node && node.attributes;
  if (Array.isArray(a)) {
    for (let i = 0; i + 1 < a.length; i += 2) out[a[i]] = a[i + 1];
  }
  return out;
}

/** 节点 name 语义来源：id > 首段 class > tag */
function nodeName(node) {
  const attrs = attrMap(node);
  if (attrs.id) return attrs.id;
  if (attrs.class) return attrs.class.split(/\s+/)[0];
  return (node.localName || node.nodeName || 'div').toLowerCase();
}

/** 颜色解析：支持 rgb()/rgba()/#hex；透明（alpha=0 或 transparent）→ null */
export function parseColor(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (s === '' || s === 'transparent' || s === 'none') return null;
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((x) => x.trim());
    const r = parseFloat(p[0]);
    const g = parseFloat(p[1]);
    const b = parseFloat(p[2]);
    const a = p.length > 3 ? parseFloat(p[3]) : 1;
    if (!Number.isFinite(a) || a === 0) return null;
    return { color: rgbToHex(r, g, b), opacity: round3(a) };
  }
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return { color: '#' + hex.slice(0, 6), opacity: 1 };
  }
  return null;
}

function rgbToHex(r, g, b) {
  const c = (v) => {
    const n = Math.max(0, Math.min(255, Math.round(v)));
    return n.toString(16).padStart(2, '0');
  };
  return '#' + c(r) + c(g) + c(b);
}

// ==================== selector 解析（纯函数，可单测） ====================

export function parseSelector(sel) {
  sel = (sel || '').trim();
  const res = { tag: null, id: null, cls: null };
  const idM = sel.match(/#([\w-]+)/);
  if (idM) res.id = idM[1];
  const clsM = sel.match(/\.([\w-]+)/);
  if (clsM) res.cls = clsM[1];
  const tagM = sel.match(/^([a-zA-Z][\w-]*)/);
  if (tagM) res.tag = tagM[1].toLowerCase();
  return res;
}

export function matchSelector(node, parsed) {
  if (!node || node.nodeType !== 1) return false;
  if (parsed.tag && (node.localName || '').toLowerCase() !== parsed.tag) return false;
  const attrs = attrMap(node);
  if (parsed.id && attrs.id !== parsed.id) return false;
  if (parsed.cls) {
    const cls = (attrs.class || '').split(/\s+/);
    if (!cls.includes(parsed.cls)) return false;
  }
  return true;
}

// ==================== 图片资产名（确定性，白名单净化） ====================

/** 资产名净化：仅保留 [A-Za-z0-9_.:-]，其余替换为 '-' */
export function sanitizeAssetName(s) {
  return String(s).replace(/[^A-Za-z0-9_.:-]/g, '-');
}

/**
 * 给一组 img 节点分配确定性资产键。
 * 优先 alt，否则 src basename（去扩展名）；冲突加序号；兜底 img-<n>。
 */
export function assignImageAssetKeys(imgNodes) {
  const used = new Set();
  const keys = [];
  let idx = 0;
  for (const n of imgNodes) {
    const attrs = attrMap(n);
    let base = null;
    if (attrs.alt && attrs.alt.trim()) base = attrs.alt.trim();
    else if (attrs.src) {
      const bn = path.basename(String(attrs.src).split('?')[0]);
      base = bn.replace(/\.[^.]+$/, '');
    }
    let cand = sanitizeAssetName(base || '');
    if (!cand) cand = `img-${idx}`;
    let key = cand;
    let i = 1;
    while (used.has(key)) key = `${cand}-${i++}`;
    used.add(key);
    keys.push(key);
    idx++;
  }
  return keys;
}

// ==================== 纯映射：CDP 拉平数据 → IR v1 ====================

/**
 * mapDomToIr —— 可独立单测的纯函数。
 * @param {object} args
 * @param {Array}  args.nodes        CDP getFlattenedDocument 的 nodes 数组（含 nodeType/localName/attributes/childNodeIds/nodeValue）
 * @param {object} [args.stylesById] map: nodeId → { cssProp: value }（来自 CSS.getComputedStyleForNode）
 * @param {object} [args.boxesById]  map: nodeId → { x, y, width, height }（来自 DOM.getBoxModel，页面绝对坐标）
 * @param {string} [args.rootSelector] 根元素选择器（缺省 'body'）
 * @param {object} [args.viewport]   视口 {width,height}（当前仅占位/对齐用，schema 不落）
 * @param {object} [args.imageKeys]  可选 map: imgNodeId → 资产键（编排层预分配，保证与截图命名一致）；缺省内部用 assignImageAssetKeys
 * @returns IR v1 对象 {v:1,kind:'design-ir',root:{...},truncated:false}
 */
export function mapDomToIr({ nodes, stylesById = {}, boxesById = {}, rootSelector = 'body', viewport, imageKeys }) {
  const byId = new Map();
  for (const n of nodes) byId.set(n.nodeId, n);

  // 1) 选根
  const parsed = parseSelector(rootSelector);
  let rootNode = null;
  for (const n of nodes) {
    if (matchSelector(n, parsed)) {
      rootNode = n;
      break;
    }
  }
  if (!rootNode) {
    const e = new Error(`selector "${rootSelector}" 未匹配到任何元素`);
    e.code = 'BAD_SELECTOR';
    throw e;
  }

  // 2) 图片资产键
  const imgNodes = nodes.filter((n) => n.nodeType === 1 && (n.localName || '').toLowerCase() === 'img');
  const keyByNodeId = new Map();
  if (imageKeys && typeof imageKeys === 'object') {
    imgNodes.forEach((n) => keyByNodeId.set(n.nodeId, imageKeys[n.nodeId] || `img-${n.nodeId}`));
  } else {
    const keys = assignImageAssetKeys(imgNodes);
    imgNodes.forEach((n, i) => keyByNodeId.set(n.nodeId, keys[i]));
  }

  const skipTags = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript', 'head']);

  // 子节点解析：真 Chrome 的 getFlattenedDocument 返回嵌套 children（节点对象数组），
  // 不填 childNodeIds（实测 62 节点全 MISSING）；childNodeIds 仅桩测试使用，作回退。
  const childrenOf = (node) => {
    if (Array.isArray(node.children) && node.children.length > 0) return node.children;
    if (Array.isArray(node.childNodeIds)) {
      return node.childNodeIds.map((id) => byId.get(id)).filter(Boolean);
    }
    return [];
  };

  function build(node, parentAbs, parentDisplay, isRoot) {
    const style = stylesById[node.nodeId] || {};
    const box = boxesById[node.nodeId];
    const absBox = box
      ? { x: box.x, y: box.y, width: box.width, height: box.height }
      : { x: parentAbs.x, y: parentAbs.y, width: 0, height: 0 };
    // 零尺寸不可见元素跳过（根除外）
    if (!isRoot && absBox.width === 0 && absBox.height === 0) return null;

    const display = style['display'] || 'block';
    if (display === 'none') return null; // display:none 子树整支跳过

    const localName = (node.localName || node.nodeName || 'div').toLowerCase();
    const name = nodeName(node);
    const bounds = {
      x: round3(absBox.x - parentAbs.x),
      y: round3(absBox.y - parentAbs.y),
      width: round3(absBox.width),
      height: round3(absBox.height),
    };

    // 收集子节点（children 对象数组优先，childNodeIds 回退——见 childrenOf 注释）
    const childNodes = childrenOf(node);
    const elementChildren = [];
    const textChildren = [];
    for (const c of childNodes) {
      if (c.nodeType === 3) {
        if ((c.nodeValue || '').trim()) textChildren.push(c);
      } else if (c.nodeType === 1) {
        if (skipTags.has((c.localName || '').toLowerCase())) continue;
        elementChildren.push(c);
      }
    }

    // 纯文本叶元素（无元素子节点但有文本）→ 自身产出 text 节点；
    // 但若元素自身带容器样式（fills/strokes/radius），则保持为 frame 容纳文本子节点（避免丢失背景/边框）。
    const hasContainerStyle = Object.keys(buildStyle(style)).length > 0;
    if (elementChildren.length === 0 && textChildren.length > 0 && !hasContainerStyle) {
      const text = textChildren.map((t) => t.nodeValue).join('').trim();
      const font = buildFont(style);
      const tnode = { type: 'text', name, bounds, layout: { mode: 'none' }, text };
      const tstyle = buildTextStyle(style, font);
      if (Object.keys(tstyle).length) tnode.style = tstyle;
      return tnode;
    }

    // 容器 / 图片帧
    const layout = buildLayout(style, display);
    const styleObj = buildStyle(style);
    const ir = { type: 'frame', name, bounds, layout };
    if (Object.keys(styleObj).length) ir.style = styleObj;
    if (localName === 'img') {
      ir.type = 'image';
      ir.asset = keyByNodeId.get(node.nodeId) || `img-${node.nodeId}`;
    }

    const children = [];
    // 直接文本子节点 → text 节点（font 取父元素 computed style）
    for (const t of textChildren) {
      const tb = boxesById[t.nodeId];
      const tAbs = tb ? { x: tb.x, y: tb.y, width: tb.width, height: tb.height } : absBox;
      const tbounds = {
        x: round3(tAbs.x - absBox.x),
        y: round3(tAbs.y - absBox.y),
        width: round3(tAbs.width),
        height: round3(tAbs.height),
      };
      const font = buildFont(style);
      const tnode = { type: 'text', name, bounds: tbounds, layout: { mode: 'none' }, text: t.nodeValue.trim() };
      const tstyle = buildTextStyle(style, font);
      if (Object.keys(tstyle).length) tnode.style = tstyle;
      children.push(tnode);
    }
    // 元素子节点 → 递归
    for (const ec of elementChildren) {
      const built = build(ec, absBox, display, false);
      if (built) children.push(built);
    }
    if (children.length) ir.children = children;

    // position:absolute 且父为 flex → absolute:true（IR M7 auto-layout 绝对定位语义）
    const parentFlex = parentDisplay === 'flex';
    if (style['position'] === 'absolute' && parentFlex) ir.absolute = true;

    return ir;
  }

  const rootAbs = boxesById[rootNode.nodeId] || { x: 0, y: 0, width: 0, height: 0 };
  let rootIr = build(rootNode, rootAbs, null, true);
  if (!rootIr) {
    rootIr = { type: 'frame', name: nodeName(rootNode), bounds: { x: 0, y: 0, width: 0, height: 0 }, layout: { mode: 'none' } };
  }

  return { v: 1, kind: 'design-ir', root: rootIr, truncated: false };
}

// ---- 子映射助手（纯） ----

function buildLayout(style, display) {
  if (display !== 'flex') return { mode: 'none' };
  const dir = style['flex-direction'] || 'row';
  const mode = dir === 'column' ? 'vertical' : 'horizontal';
  const layout = { mode };
  // 主轴 gap：row 方向取 row-gap，column 方向取 column-gap
  const gap = dir === 'column' ? parseFloat(style['column-gap']) : parseFloat(style['row-gap']);
  if (Number.isFinite(gap) && gap > 0) layout.gap = round3(gap);
  const just = style['justify-content'];
  if (just === 'center') layout.primary = 'center';
  else if (just === 'flex-end') layout.primary = 'max';
  else if (just === 'space-between') layout.primary = 'between';
  const align = style['align-items'];
  if (align === 'center') layout.counter = 'center';
  else if (align === 'flex-end') layout.counter = 'max';
  else if (align === 'baseline') layout.counter = 'baseline';
  const pad = buildPadding(style);
  if (pad) layout.padding = pad;
  return layout;
}

function buildPadding(style) {
  const t = parseFloat(style['padding-top']);
  const r = parseFloat(style['padding-right']);
  const b = parseFloat(style['padding-bottom']);
  const l = parseFloat(style['padding-left']);
  if ([t, r, b, l].some((v) => Number.isFinite(v) && v !== 0)) {
    return { top: round3(t || 0), right: round3(r || 0), bottom: round3(b || 0), left: round3(l || 0) };
  }
  return null;
}

function buildStyle(style) {
  const out = {};
  const fill = parseColor(style['background-color']);
  if (fill) out.fills = [fill];
  const stroke = buildStroke(style);
  if (stroke) out.strokes = [stroke];
  const radius = parseFloat(style['border-top-left-radius']);
  if (Number.isFinite(radius) && radius > 0) out.radius = round3(radius);
  return out;
}

function buildStroke(style) {
  const sides = ['top', 'right', 'bottom', 'left'];
  for (const s of sides) {
    const w = parseFloat(style[`border-${s}-width`]);
    if (Number.isFinite(w) && w > 0) {
      const c = parseColor(style[`border-${s}-color`]);
      if (c) return c;
    }
  }
  return null;
}

export function buildFont(style) {
  const ff = (style['font-family'] || '')
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '');
  const size = parseFloat(style['font-size']);
  let w = parseInt(style['font-weight'] || '400', 10);
  if (Number.isNaN(w)) {
    w = /bold/.test(style['font-weight'] || '') ? 700 : 400;
  }
  const styleName = w >= 600 ? 'Bold' : 'Regular';
  return {
    family: ff || 'Inter',
    style: styleName,
    size: Number.isFinite(size) ? round3(size) : 14,
  };
}

function buildTextStyle(style, font) {
  const out = { font };
  const color = parseColor(style['color']);
  if (color) out.fills = [color];
  return out;
}

function styleMap(computedStyle) {
  const m = {};
  if (Array.isArray(computedStyle)) {
    for (const e of computedStyle) {
      if (e && e.name) m[e.name] = e.value;
    }
  }
  return m;
}

/** 整体超时包装：超时 reject（label）；调用方据此转 exit 1。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function boxFromModel(model) {
  if (!model) return null;
  const c = model.content;
  const x = c ? c[0] : 0;
  const y = c ? c[1] : 0;
  return {
    x: round3(x),
    y: round3(y),
    width: round3(model.width || 0),
    height: round3(model.height || 0),
  };
}

// ==================== CDP 客户端（JSON-RPC 关联） ====================

function createCdp(ws, sendTimeoutMs) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }, sendTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, cb) {
      const l = (m) => {
        if (m.method === method) cb(m);
      };
      listeners.add(l);
      return () => listeners.delete(l);
    },
    waitEvent(method, timeoutMs) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          off();
          reject(new Error(`等待 CDP 事件超时: ${method}`));
        }, timeoutMs);
        const off = this.on(method, (m) => {
          clearTimeout(t);
          off();
          resolve(m.params);
        });
      });
    },
  };
}

// ==================== orchestration：extract ====================

/**
 * extract —— 拉起 Chrome 或直连 DevTools，经 CDP 把页面抽成 IR。
 * @param {object} opts
 * @param {string} [opts.chrome]    Chrome 可执行文件（与 cdpUrl 二选一；都缺则抛 CHROME_MISSING）
 * @param {string} [opts.cdpUrl]    DevTools HTTP 端点（如 http://127.0.0.1:9222）；优先于 chrome
 * @param {string}  opts.url        导航目标（file:// 或 http(s)://）
 * @param {string} [opts.rootSelector]
 * @param {object} [opts.viewport]  {width,height}
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ir, images: Array<{key, png: Buffer}>}>}
 * 失败时抛 Error；调用方据此：BAD_SELECTOR→exit2，其余（含 CHROME_MISSING）→exit1。
 */
export async function extract(opts) {
  const { chrome, cdpUrl, url, rootSelector = 'body', viewport = { width: 1280, height: 800 }, timeoutMs = 30000 } = opts;
  let child = null;
  let tmpDir = null;
  let baseUrl = null;
  let killed = false;
  const cleanup = () => {
    if (killed) return;
    killed = true;
    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不阻断 */
      }
    }
  };

  try {
    if (cdpUrl) {
      baseUrl = cdpUrl.replace(/\/+$/, '');
    } else {
      if (!chrome) {
        const e = new Error('找不到可用的 Chrome / Chromium 可执行文件');
        e.code = 'CHROME_MISSING';
        throw e;
      }
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-extract-'));
      const args = [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${tmpDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        `--window-size=${viewport.width},${viewport.height}`,
        'about:blank',
      ];
      child = spawn(chrome, args, { stdio: 'ignore' });
      child.on('error', () => {});
      const port = await waitForPort(path.join(tmpDir, 'DevToolsActivePort'), timeoutMs);
      baseUrl = `http://127.0.0.1:${port}`;
    }

    const pageTarget = await getPageTarget(baseUrl, timeoutMs);
    // 整体超时包在 extract 内部：超时 reject 会先触发下方 finally（SIGKILL Chrome + 清临时目录），
    // 再向上传播，避免调用方早退留下孤儿进程。
    const { ir, images } = await withTimeout(
      connectAndExtract({
        wsUrl: pageTarget.webSocketDebuggerUrl,
        url,
        rootSelector,
        timeoutMs,
      }),
      timeoutMs,
      'extract 超时'
    );
    return { ir, images };
  } finally {
    cleanup();
  }
}

function waitForPort(file, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, 'utf8');
          const line = content.split(/\r?\n/).find((l) => /^\d+$/.test(l.trim()));
          if (line) {
            resolve(parseInt(line, 10));
            return;
          }
        }
      } catch {
        /* ignore */
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('等待 Chrome DevToolsActivePort 超时'));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function getPageTarget(baseUrl, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/json/list`, { signal: ctrl.signal });
    const list = await res.json();
    const pages = Array.isArray(list) ? list : [];
    const target =
      pages.find((p) => p.type === 'page' && p.url === 'about:blank') ||
      pages.find((p) => p.type === 'page');
    if (!target || !target.webSocketDebuggerUrl) throw new Error('DevTools 未找到可用的 page target');
    return target;
  } finally {
    clearTimeout(t);
  }
}

async function connectAndExtract({ wsUrl, url, rootSelector, timeoutMs }) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WebSocket 连接 DevTools 超时')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

  const cdp = createCdp(ws, timeoutMs);
  try {
    await cdp.send('Page.enable');
    try {
      await cdp.send('CSS.enable');
    } catch {
      /* 部分 CDP 实现无需显式 enable */
    }
    const loadPromise = cdp.waitEvent('Page.loadEventFired', timeoutMs);
    await cdp.send('Page.navigate', { url });
    await loadPromise;

    // DOM 树获取：getDocument(depth:-1) 嵌套树 + 客户端拉平。
    // 实测坑（真 Chrome 152）：getFlattenedDocument 的 children/盒模型受 DOM 会话状态影响
    // 不稳定——getDocument 之后调用返回 children 为空、盒模型偶发 null，甚至整次 error；
    // getDocument 的嵌套 children 是 spec 保证的最稳定形态，故弃用 getFlattenedDocument。
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const nodes = [];
    const walkDom = (n) => {
      nodes.push(n);
      if (Array.isArray(n.children)) for (const c of n.children) walkDom(c);
    };
    walkDom(doc.root);

    const stylesById = {};
    const boxesById = {};
    for (const n of nodes) {
      if (n.nodeType !== 1) continue;
      try {
        const s = await cdp.send('CSS.getComputedStyleForNode', { nodeId: n.nodeId });
        stylesById[n.nodeId] = styleMap(s.computedStyle);
      } catch {
        /* 跳过无样式节点 */
      }
      try {
        const b = await cdp.send('DOM.getBoxModel', { nodeId: n.nodeId });
        if (b.model) {
          boxesById[n.nodeId] = boxFromModel(b.model);
        } else {
          // 盒模型偶发 null（布局未就绪）：短暂等待后重试一次
          await new Promise((r) => setTimeout(r, 50));
          const b2 = await cdp.send('DOM.getBoxModel', { nodeId: n.nodeId });
          boxesById[n.nodeId] = boxFromModel(b2.model);
        }
      } catch {
        /* 文本等无盒模型节点跳过 */
      }
    }

    // 图片：逐个 clip 截图取字节
    const imgNodes = nodes.filter((n) => n.nodeType === 1 && (n.localName || '').toLowerCase() === 'img');
    const keys = assignImageAssetKeys(imgNodes);
    const imageKeys = {};
    imgNodes.forEach((n, i) => (imageKeys[n.nodeId] = keys[i]));
    const images = [];
    for (let i = 0; i < imgNodes.length; i++) {
      const box = boxesById[imgNodes[i].nodeId];
      if (!box) continue;
      const clip = {
        x: round3(box.x),
        y: round3(box.y),
        width: round3(box.width),
        height: round3(box.height),
        scale: 1,
      };
      try {
        const r = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip,
          captureBeyondViewport: false,
        });
        images.push({ key: keys[i], png: Buffer.from(r.data, 'base64') });
      } catch {
        /* 截图失败不阻断整体抽取 */
      }
    }

    const ir = mapDomToIr({ nodes, stylesById, boxesById, rootSelector, imageKeys });
    return { ir, images };
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}
