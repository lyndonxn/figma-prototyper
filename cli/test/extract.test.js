/**
 * M7b CLI `extract` 子命令契约测试（node:test，不依赖真机 Chrome）
 *
 * 覆盖（FUN-ACC-703 证据）：
 *   1) 纯映射函数 mapDomToIr 单测：合成 CDP 载荷断言 IR 结构/layout/bounds 相对换算/text/font/fills/absolute/asset/跳过 display:none。
 *   2) CDP 编排桩测（--cdp-url 缝）：起假 DevTools 端点（http /json/list + ws 脚本化 CDP 响应），
 *      spawn CLI extract，断言 exit 0、design-ir.json 合法、assets/*.png 字节与桩一致、stdout 列出产物。
 *   3) Chrome 缺失：--chrome /nonexistent → exit 2 + 降级提示。
 *   4) 参数错误：文件不存在 → exit 2；多余位置参数 → exit 2。
 *   5) 真 Chrome 冒烟（可选 skip）：仅当系统能定位 Chrome 且 FIGMAPT_EXTRACT_SMOKE=1 时运行。
 *
 * 运行：cd figma-prototyper/cli && node --test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { mapDomToIr } from '../lib/extract.js';

const CLI_PATH = fileURLToPath(new URL('../figmapt.js', import.meta.url));

// 确定性假 PNG 字节（合法签名 + 固定尾部），用于校验 assets 落盘字节一致
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('STUBFAKE-PNG-figmapt-extract-test-703'),
]);
const FAKE_B64 = FAKE_PNG.toString('base64');

/** 合成 CDP 拉平数据：root #app 为纵向 flex 容器，含文本/带 fills 的 div/img/position:absolute 子项 + display:none 子树 */
function buildSynthetic() {
  const nodes = [
    { nodeId: 1, nodeType: 1, localName: 'html', parentId: 0, childNodeIds: [2] },
    {
      nodeId: 2,
      nodeType: 1,
      localName: 'body',
      parentId: 1,
      attributes: ['class', 'page'],
      childNodeIds: [3],
    },
    {
      nodeId: 3,
      nodeType: 1,
      localName: 'div',
      parentId: 2,
      attributes: ['id', 'app', 'class', 'app'],
      childNodeIds: [4, 5, 6, 7, 9],
    },
    { nodeId: 4, nodeType: 3, nodeValue: 'Title', parentId: 3 },
    {
      nodeId: 5,
      nodeType: 1,
      localName: 'div',
      parentId: 3,
      attributes: ['class', 'card'],
      childNodeIds: [8],
    },
    { nodeId: 8, nodeType: 3, nodeValue: 'Card', parentId: 5 },
    {
      nodeId: 6,
      nodeType: 1,
      localName: 'img',
      parentId: 3,
      attributes: ['alt', 'logo', 'src', '/x/logo.png'],
      childNodeIds: [],
    },
    {
      nodeId: 7,
      nodeType: 1,
      localName: 'div',
      parentId: 3,
      attributes: ['class', 'abs'],
      childNodeIds: [],
    },
    {
      nodeId: 9,
      nodeType: 1,
      localName: 'div',
      parentId: 3,
      attributes: ['class', 'gone'],
      childNodeIds: [10],
    },
    { nodeId: 10, nodeType: 1, localName: 'div', parentId: 9, childNodeIds: [] },
  ];

  const stylesById = {
    2: { display: 'block', 'font-family': '"Inter", sans-serif', 'font-size': '16px', 'font-weight': '400', color: 'rgb(0,0,0)' },
    3: {
      display: 'flex',
      'flex-direction': 'column',
      'column-gap': '8px',
      'justify-content': 'center',
      'padding-top': '24px',
      'padding-right': '24px',
      'padding-bottom': '24px',
      'padding-left': '24px',
      'font-family': '"Inter", sans-serif',
      'font-size': '20px',
      'font-weight': '400',
      color: 'rgb(17,17,17)',
    },
    5: {
      display: 'block',
      'background-color': 'rgb(255,0,0)',
      'border-top-width': '2px',
      'border-top-color': 'rgb(0,255,0)',
      'border-top-left-radius': '4px',
    },
    6: { display: 'inline' },
    7: { display: 'block', position: 'absolute' },
    9: { display: 'none' },
    10: { display: 'block' },
  };

  const boxesById = {
    2: { x: 0, y: 0, width: 320, height: 480 },
    3: { x: 0, y: 0, width: 320, height: 480 },
    5: { x: 0, y: 24, width: 272, height: 40 },
    6: { x: 0, y: 80, width: 120, height: 120 },
    7: { x: 0, y: 0, width: 40, height: 40 },
  };

  return { nodes, stylesById, boxesById };
}

/** 运行 CLI 子进程；剥掉环境 token/port/chrome 避免外泄 */
function runCli(args, envOverrides = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.FIGMA_BRIDGE_TOKEN;
    delete env.FIGMA_BRIDGE_PORT;
    delete env.FIGMAPT_CHROME;
    Object.assign(env, envOverrides);
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** 起假 DevTools 端点：http /json/list + ws 脚本化 CDP 响应；返回 {close, port} */
function startFakeDevtools() {
  const syn = buildSynthetic();
  const styleArr = (id) => {
    const o = syn.stylesById[id] || {};
    return Object.keys(o).map((k) => ({ name: k, value: o[k] }));
  };
  const modelOf = (id) => {
    const b = syn.boxesById[id];
    if (!b) return { content: [0, 0, 0, 0, 0, 0, 0, 0], width: 0, height: 0 };
    return { content: [b.x, b.y, b.x, b.y, b.x, b.y, b.x, b.y], width: b.width, height: b.height };
  };
  const respond = (msg) => {
    const r = (result) => ({ id: msg.id, result });
    switch (msg.method) {
      case 'Page.enable':
      case 'CSS.enable':
      case 'Page.navigate':
        return r({});
      case 'DOM.getDocument': {
        // 真 Chrome 形态：嵌套树（children 为节点对象数组）。由扁平 childNodeIds 现场构建。
        const byId = new Map(syn.nodes.map((n) => [n.nodeId, { ...n, children: [] }]));
        const roots = [];
        for (const n of byId.values()) {
          const p = n.parentId !== undefined ? byId.get(n.parentId) : null;
          if (p) p.children.push(n);
          else roots.push(n);
        }
        return r({ root: roots[0] });
      }
      case 'CSS.getComputedStyleForNode':
        return r({ computedStyle: styleArr(msg.params.nodeId) });
      case 'DOM.getBoxModel':
        return r({ model: modelOf(msg.params.nodeId) });
      case 'Page.captureScreenshot':
        return r({ data: FAKE_B64 });
      default:
        return r({});
    }
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/list') {
        const body = JSON.stringify([
          { type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/test` },
        ]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ server, path: '/devtools/page/test' });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (typeof msg.id !== 'number') return;
        const resp = respond(msg);
        if (resp) ws.send(JSON.stringify(resp));
        if (msg.method === 'Page.navigate') {
          ws.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((res) => {
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}

// ==================== 1) 纯映射函数单测 ====================

test('FUN-ACC-703 纯函数 mapDomToIr：v/kind/root 结构 + flex layout + bounds 相对换算 + text/font + fills + absolute + asset + 跳过 display:none', () => {
  const { nodes, stylesById, boxesById } = buildSynthetic();
  const ir = mapDomToIr({ nodes, stylesById, boxesById, rootSelector: '#app' });

  // v/kind/root 结构
  assert.equal(ir.v, 1);
  assert.equal(ir.kind, 'design-ir');
  assert.ok(ir.root && typeof ir.root === 'object');

  // root：flex column + gap + primary + padding
  const root = ir.root;
  assert.equal(root.type, 'frame');
  assert.equal(root.name, 'app');
  assert.deepEqual(root.bounds, { x: 0, y: 0, width: 320, height: 480 });
  assert.equal(root.layout.mode, 'vertical');
  assert.equal(root.layout.gap, 8);
  assert.equal(root.layout.primary, 'center');
  assert.deepEqual(root.layout.padding, { top: 24, right: 24, bottom: 24, left: 24 });

  // 子节点
  const children = root.children || [];
  assert.ok(children.length >= 3, '应有 ≥3 个可见子节点（文本/card/img/abs）');
  const byName = Object.fromEntries(children.map((c) => [c.name, c]));

  // 文本：直接文本子节点，font 取父（#app）computed style
  const textNode = children.find((c) => c.type === 'text' && c.text === 'Title');
  assert.ok(textNode, '应存在文本 "Title"');
  assert.equal(textNode.style.font.family, 'Inter');
  assert.equal(textNode.style.font.size, 20);
  assert.equal(textNode.style.font.style, 'Regular');

  // 带 fills 的 div：mode none + fills hex + strokes + radius
  const card = byName.card;
  assert.ok(card, '应存在 card 节点');
  assert.equal(card.type, 'frame');
  assert.equal(card.layout.mode, 'none');
  assert.deepEqual(card.bounds, { x: 0, y: 24, width: 272, height: 40 });
  assert.deepEqual(card.style.fills, [{ color: '#ff0000', opacity: 1 }]);
  assert.deepEqual(card.style.strokes, [{ color: '#00ff00', opacity: 1 }]);
  assert.equal(card.style.radius, 4);

  // 图片：type image + asset 键（alt 净化 → logo）
  const img = children.find((c) => c.type === 'image');
  assert.ok(img, '应存在 image 节点');
  assert.equal(img.asset, 'logo');
  assert.deepEqual(img.bounds, { x: 0, y: 80, width: 120, height: 120 });

  // position:absolute 且父为 flex → absolute:true
  const abs = byName.abs;
  assert.ok(abs, '应存在 abs 节点');
  assert.equal(abs.absolute, true);

  // display:none 子树（gone）被跳过
  assert.equal(byName.gone, undefined, 'display:none 子树不应出现在 IR 中');
  const allNames = JSON.stringify(ir);
  assert.ok(!allNames.includes('"gone"'), 'IR 不应含 gone 文本');
});

test('FUN-ACC-703 纯函数：selector 未匹配 → 抛 BAD_SELECTOR（调用方转 exit 2）', () => {
  const { nodes, stylesById, boxesById } = buildSynthetic();
  assert.throws(
    () => mapDomToIr({ nodes, stylesById, boxesById, rootSelector: '#nope' }),
    (e) => e.code === 'BAD_SELECTOR'
  );
});

// ==================== 2) CDP 编排桩测（--cdp-url 缝） ====================

test('FUN-ACC-703 CDP 桩测：--cdp-url 直连假 DevTools → exit 0、design-ir.json 合法、assets/logo.png 字节一致、stdout 列产物', async () => {
  const dev = await startFakeDevtools();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-extract-cdp-'));
  const html = path.join(work, 'page.html');
  fs.writeFileSync(html, '<!doctype html><html><body><div id="app"></div></body></html>');
  const irOut = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-extract-ir-'));
  try {
    const child = await runCli([
      'extract',
      html,
      '--cdp-url',
      `http://127.0.0.1:${dev.port}`,
      '--ir-out',
      irOut,
      '--selector',
      '#app',
    ]);
    assert.equal(child.code, 0, `exit 0 预期，实际 ${child.code}，stderr=${child.stderr}`);

    const irPath = path.join(irOut, 'design-ir.json');
    assert.ok(fs.existsSync(irPath), 'design-ir.json 应落盘');
    const ir = JSON.parse(fs.readFileSync(irPath, 'utf8'));
    assert.equal(ir.v, 1);
    assert.equal(ir.kind, 'design-ir');
    assert.equal(ir.root.name, 'app');
    assert.equal(ir.root.layout.mode, 'vertical');

    const assetPath = path.join(irOut, 'assets', 'logo.png');
    assert.ok(fs.existsSync(assetPath), 'assets/logo.png 应落盘');
    assert.deepEqual(fs.readFileSync(assetPath), FAKE_PNG, '落盘 PNG 字节应与桩返回的假 PNG 一致');

    assert.ok(child.stdout.includes('IR-Out:'), `stdout 应含 IR-Out 清单，实际：${child.stdout}`);
    assert.ok(child.stdout.includes(irPath), 'stdout 应列 design-ir.json 路径');
    assert.ok(child.stdout.includes(assetPath), 'stdout 应列 asset 路径');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(irOut, { recursive: true, force: true });
    await dev.close();
  }
});

// ==================== 3) Chrome 缺失 ====================

test('FUN-ACC-703 Chrome 缺失：--chrome 指向不存在路径 → exit 2 + 降级提示（含"--cdp-url"）', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-extract-missing-'));
  const html = path.join(work, 'page.html');
  fs.writeFileSync(html, '<!doctype html><html><body>x</body></html>');
  try {
    const child = await runCli(['extract', html, '--chrome', '/nonexistent/chrome-bin/that/does/not/exist']);
    assert.equal(child.code, 2, `exit 2 预期，实际 ${child.code}，stdout=${child.stdout}`);
    assert.ok(/找不到.*Chrome|降级方案/.test(child.stderr), `stderr 应含找不到 Chrome 的降级提示，实际：${child.stderr}`);
    assert.ok(child.stderr.includes('--cdp-url'), `降级提示应提及 --cdp-url，实际：${child.stderr}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ==================== 4) 参数错误 ====================

test('FUN-ACC-703 参数错误：文件不存在 → exit 2', async () => {
  const child = await runCli(['extract', '/nonexistent/page.html', '--cdp-url', 'http://127.0.0.1:1']);
  assert.equal(child.code, 2, `exit 2 预期，实际 ${child.code}`);
  assert.ok(/参数错误/.test(child.stderr) && /文件不存在/.test(child.stderr), `stderr 应明确，实际：${child.stderr}`);
});

test('FUN-ACC-703 参数错误：多余位置参数 → exit 2', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-extract-extra-'));
  const html = path.join(work, 'page.html');
  fs.writeFileSync(html, '<!doctype html><html><body>x</body></html>');
  try {
    const child = await runCli(['extract', html, 'bonus-arg', '--cdp-url', 'http://127.0.0.1:1']);
    assert.equal(child.code, 2, `exit 2 预期，实际 ${child.code}`);
    assert.ok(/参数错误/.test(child.stderr) && /多余的位置参数/.test(child.stderr), `stderr 应明确，实际：${child.stderr}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ==================== 5) 真 Chrome 冒烟（可选 skip） =================

function findRealChrome() {
  const env = process.env.FIGMAPT_CHROME;
  if (env && env.length > 0 && fs.existsSync(env)) return env;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* skip */
    }
  }
  return null;
}

const realChrome = findRealChrome();
const runRealSmoke = Boolean(realChrome) && process.env.FIGMAPT_EXTRACT_SMOKE === '1';

test(
  'FUN-ACC-703 真 Chrome 冒烟（检测到才跑，需 FIGMAPT_EXTRACT_SMOKE=1 开启）',
  {
    skip: runRealSmoke
      ? false
      : realChrome
        ? '未开启 FIGMAPT_EXTRACT_SMOKE=1，跳过真 Chrome 冒烟'
        : '系统未安装 Chrome/Chromium，跳过（不硬依赖真机）',
  },
  async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-extract-real-'));
    const html = path.join(work, 'page.html');
    const irOut = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-extract-real-ir-'));
    fs.writeFileSync(
      html,
      '<!doctype html><html><body style="margin:0"><div id="app" style="width:200px;height:100px;background:#abc">hi</div></body></html>'
    );
    try {
      const child = await runCli(['extract', html, '--chrome', realChrome, '--selector', '#app', '--ir-out', irOut]);
      assert.equal(child.code, 0, `真 Chrome 应 exit 0，stderr=${child.stderr}`);
      const ir = JSON.parse(fs.readFileSync(path.join(irOut, 'design-ir.json'), 'utf8'));
      assert.ok(ir.root && ir.root.bounds && ir.root.bounds.width > 0 && ir.root.bounds.height > 0, 'root.bounds 尺寸应合理');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      fs.rmSync(irOut, { recursive: true, force: true });
    }
  }
);
