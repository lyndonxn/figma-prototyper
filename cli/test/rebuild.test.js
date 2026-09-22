/**
 * M7a CLI `rebuild` 子命令契约测试（node:test，不依赖 Figma 真机）
 *
 * 覆盖：FUN-ACC-701（确定性 + 映射覆盖）、FUN-ACC-702（提交载荷 images 通道 + 脚本引用注入映射、不内嵌 base64、不触碰既有节点）、
 * 错误路径（缺目录 / 非法 JSON / 缺 schema 字段 → exit 2 + stderr 明确）。
 * fixture 见 ./fixtures/m7-rebuild/（已纳入版本控制，不依赖 output/ 下 gitignored 文件）。
 *
 * 模式：同 cli.test.js —— spawn 真实 CLI 子进程 + 复用 bridge/test 的假插件（startBridge + WS）。
 * 确定性/映射覆盖用 --dry-run 拿生成脚本文本断言；images 载荷用真实 Job 提交到假插件，检查 OP.images 与 OP.code。
 *
 * 运行：cd figma-prototyper/cli && node --test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startBridge } from '../../bridge/server.js';

const bridgeRequire = createRequire(new URL('../../bridge/package.json', import.meta.url));
const { WebSocket } = bridgeRequire('ws');

const CLI_PATH = fileURLToPath(new URL('../figmapt.js', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/m7-rebuild', import.meta.url));

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** 运行 CLI 子进程；剥掉环境 token/port 避免外泄 */
function runCli(args, envOverrides = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.FIGMA_BRIDGE_TOKEN;
    delete env.FIGMA_BRIDGE_PORT;
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

/** 假插件（同 cli.test.js）：连接 WS、记录 OP、reply 回 RESULT */
function makeFakePlugin(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  const received = [];
  const waiters = [];
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    received.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        clearTimeout(waiters[i].timer);
        const w = waiters.splice(i, 1)[0];
        w.resolve(msg);
      }
    }
  });
  ws.on('error', () => {});
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  function waitFor(pred, label = 'message', timeoutMs = 4000) {
    const existing = received.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.pred === pred);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      waiters.push({ pred, resolve, timer });
    });
  }
  function send(payload) {
    ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), ts: Date.now(), ...payload }));
  }
  async function close() {
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => {
        ws.once('close', resolve);
        ws.close();
      });
    }
  }
  return { ws, received, opened, waitFor, send, close };
}

/** 同 runWithPlugin：提交 CLI，OP 到达时回 RESULT，返回 {op, child} */
async function runWithPlugin(plugin, cliArgs, replyFactory) {
  const pendingOp = plugin.waitFor((m) => m.kind === 'OP', 'OP').catch(() => null);
  const childPromise = runCli(cliArgs);
  const op = await pendingOp;
  if (op) plugin.send(replyFactory(op));
  const child = await childPromise;
  return { op, child };
}

/** 构造 AsyncFunction（与插件沙箱一致）校验生成脚本语法是否可解析（不实际执行） */
function isParseableAsyncFunction(code) {
  try {
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    new AsyncFn('figma', 'images', code); // 仅构造，不运行
    return true;
  } catch {
    return false;
  }
}

// 不应在生成脚本中出现的"触碰既有节点"调用
const BANNED_MUTATION = [/removeNode/, /deleteAsync/, /\.remove\(/, /deleteNode/, /destroy/];

// ==================== FUN-ACC-701：确定性重建 ====================

test('FUN-ACC-701 确定性：同 IR 两次 --dry-run 输出逐字节一致', async () => {
  const a = await runCli(['rebuild', FIXTURE_DIR, '--dry-run']);
  const b = await runCli(['rebuild', FIXTURE_DIR, '--dry-run']);
  assert.equal(a.code, 0, `--dry-run 应 exit 0，stderr=${a.stderr}`);
  assert.equal(b.code, 0, `--dry-run 应 exit 0，stderr=${b.stderr}`);
  assert.equal(a.stdout, b.stdout, '两次 --dry-run 生成的脚本应逐字节一致（确定性）');
  assert.ok(a.stdout.length > 0, '生成脚本不应为空');
});

test('FUN-ACC-701 确定性：--name 前缀变化时脚本随之变化，但同参数仍稳定', async () => {
  const def = await runCli(['rebuild', FIXTURE_DIR, '--dry-run']);
  const named = await runCli(['rebuild', FIXTURE_DIR, '--name', 'X-', '--dry-run']);
  assert.ok(def.stdout.includes('NAME_PREFIX = "CR-"'), '缺省前缀应为 CR-');
  assert.ok(named.stdout.includes('NAME_PREFIX = "X-"'), '显式前缀应反映到脚本');
  assert.notEqual(def.stdout, named.stdout, '不同前缀应生成不同脚本');
  const named2 = await runCli(['rebuild', FIXTURE_DIR, '--name', 'X-', '--dry-run']);
  assert.equal(named.stdout, named2.stdout, '同参数重跑应稳定');
});

test('FUN-ACC-701 确定性：IR 内容含占位符字面量（__X__ 等）时不被串行替换污染', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-rebuild-ph-'));
  try {
    const ir = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'design-ir.json'), 'utf8'));
    ir.root.children[0].name = '__X__'; // 节点名含占位符字面量
    fs.writeFileSync(path.join(dir, 'design-ir.json'), JSON.stringify(ir));

    const { stdout: script } = await runCli(['rebuild', dir, '--x', '120', '--dry-run']);
    assert.equal(
      script.includes('"name":"__X__"'),
      true,
      'IR 注入文本中的 __X__ 字面量应原样保留（不被后续占位符替换破坏）'
    );
    assert.ok(script.includes('const BOARD_X = 120'), '真实占位符 __X__ 仍应被正确替换为 --x 值');
    assert.ok(script.includes('const BOARD_Y = 0'), '未指定的 --y 应取缺省值 0');
    assert.equal(isParseableAsyncFunction(script), true, '生成脚本仍应为合法 AsyncFunction 体');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== FUN-ACC-701：映射覆盖 ====================

test('FUN-ACC-701 映射覆盖：生成脚本含正确 create 序列/layout/样式/CR-命名/回退链/不触碰既有节点', async () => {
  const { stdout: script } = await runCli(['rebuild', FIXTURE_DIR, '--dry-run']);
  assert.ok(script.length > 0, '脚本非空');

  // 节点类型映射
  assert.ok(script.includes('figma.createFrame()'), 'frame/component/instance → createFrame');
  assert.ok(script.includes('figma.createText()'), 'text → createText');
  assert.ok(script.includes('figma.createImage('), 'image → createImage（经注入 images）');

  // 自动布局映射：赋值走变量，字面量在嵌入 IR JSON 中
  assert.ok(script.includes("layoutMode = 'HORIZONTAL'"), 'horizontal → layoutMode HORIZONTAL');
  assert.ok(script.includes("layoutMode = 'VERTICAL'"), 'vertical → layoutMode VERTICAL');
  assert.ok(script.includes('n.itemSpacing = layout.gap'), 'gap → itemSpacing');
  assert.ok(script.includes('board.itemSpacing = rootLayout.gap'), 'root gap → itemSpacing');
  assert.ok(script.includes('"gap":8'), 'row gap=8 出现在嵌入 IR');
  assert.ok(script.includes('"gap":16'), 'root gap=16 出现在嵌入 IR');
  assert.ok(script.includes('n.paddingLeft = layout.padding.left'), 'padding → paddingLeft');
  assert.ok(script.includes('board.paddingLeft = rootLayout.padding.left'), 'root padding → paddingLeft');
  assert.ok(script.includes('"left":24'), 'root padding left=24 出现在嵌入 IR');

  // 样式映射：SOLID（hex+opacity）、radius
  assert.ok(script.includes("type: 'SOLID'"), 'fills/strokes → SOLID paint');
  assert.ok(script.includes('hexToRgb'), 'hex → {r,g,b} 转换');
  assert.ok(script.includes('n.cornerRadius = style.radius'), 'radius → cornerRadius');
  assert.ok(script.includes('board.cornerRadius = rootStyle.radius'), 'root radius → cornerRadius');
  assert.ok(script.includes('"radius":8') && script.includes('"radius":4'), 'radius 值 8/4 出现在嵌入 IR');
  assert.ok(script.includes('"opacity":0.5'), 'stroke opacity 0.5 应保留（SOLID paint hex+opacity）');

  // 字体映射 + 回退链
  assert.ok(script.includes('n.fontSize = font.size'), 'font size 映射');
  assert.ok(script.includes('"size":20') && script.includes('"size":14'), 'font size 值 20/14 出现在嵌入 IR');
  assert.ok(script.includes('await loadFontWithFallback('), 'text 先 loadFontAsync（经回退助手）');
  assert.ok(script.includes("'PingFang SC'") && script.includes("'Inter'"), '字体回退链：PingFang SC → Inter');
  assert.ok(script.includes('FONT_FALLBACKS.push'), 'fontFallbacks 记录回退');

  // CR- 命名 + 冲突后缀逻辑
  assert.ok(script.includes('NAME_PREFIX = "CR-"'), '缺省前缀 CR-');
  assert.ok(script.includes('BASE_NAME = NAME_PREFIX + (IR.root.name'), '画板名 = 前缀 + IR root name');
  assert.ok(script.includes(".r' + suffix"), '冲突自动加 .r1/.r2 后缀');
  assert.ok(script.includes('figma.currentPage.findOne'), '脚本内查同名冲突（不依赖外部删改）');

  // component/instance 降级：计入 skipped
  assert.ok(script.includes("if (type === 'component' || type === 'instance')"), 'component/instance 识别');
  assert.ok(script.includes('COUNTS.skipped += 1'), 'component/instance 计入 skipped 降级计数');

  // mode:none 绝对定位分支
  assert.ok(script.includes("if (parentMode === 'none')"), 'mode:none → 绝对定位分支');
  assert.ok(script.includes('n.x = b.x'), '绝对定位设 x = 相对 bounds.x');

  // 对齐映射（M7 扩展）：primary/counter → Figma 枚举；absolute 子节点 → layoutPositioning
  assert.ok(script.includes("'SPACE_BETWEEN'") && script.includes('primaryAxisAlignItems'), 'layout.primary → primaryAxisAlignItems（含 SPACE_BETWEEN）');
  assert.ok(script.includes("'BASELINE'") && script.includes('counterAxisAlignItems'), 'layout.counter → counterAxisAlignItems（含 BASELINE）');
  assert.ok(script.includes('"primary":"between"'), 'fixture 对齐语义嵌入 IR JSON');
  assert.ok(script.includes("layoutPositioning = 'ABSOLUTE'"), 'absolute 子节点 → layoutPositioning ABSOLUTE');
  assert.ok(script.includes('"absolute":true'), 'fixture absolute 标记嵌入 IR JSON');

  // 返回值契约
  assert.ok(
    script.includes(
      'return JSON.stringify({ frameId: board.id, created: COUNTS.created, skipped: COUNTS.skipped, fontFallbacks: FONT_FALLBACKS })'
    ),
    '脚本返回 {frameId, created, skipped, fontFallbacks}'
  );

  // 不触碰既有节点：脚本不得含任何删除/销毁调用
  for (const re of BANNED_MUTATION) {
    assert.equal(re.test(script), false, `生成脚本不得含触碰既有节点的调用（匹配 ${re}）`);
  }

  // 脚本可解析为合法 AsyncFunction（与插件沙箱一致），且不内嵌 40+ 字符 base64 块
  assert.equal(isParseableAsyncFunction(script), true, '生成脚本应为合法 AsyncFunction 体（无语法错误）');
  assert.equal(/[A-Za-z0-9+/]{40,}={0,2}/.test(script), false, '脚本不得内嵌长 base64 块（图片须经 images 通道）');
});

// ==================== FUN-ACC-702：提交载荷 images 通道 + 注入映射（不内嵌 base64） ====================

test('FUN-ACC-702 提交：OP.images 含正确键与 base64，OP.code 引用注入映射而非内嵌 base64', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;
    const assetFile = path.join(FIXTURE_DIR, 'assets', '11:6.png');
    const assetBytes = fs.readFileSync(assetFile);
    const assetB64 = assetBytes.toString('base64');

    const { op, child } = await runWithPlugin(
      plugin,
      ['rebuild', FIXTURE_DIR, '--token', token, '--port', String(bridge.httpPort)],
      (o) => ({
        kind: 'RESULT',
        jobId: o.jobId,
        status: 'ok',
        message: 'rebuilt',
        data: JSON.stringify({ frameId: '0:1', created: 12, skipped: 2, fontFallbacks: [] }),
      })
    );
    assert.ok(op, 'OP 应已下发到插件');

    // OP.images 载荷：键 = IR asset 名（含冒号合法），base64 解码后与文件字节一致
    assert.ok(op.images && typeof op.images === 'object', 'OP 应携带 images 载荷');
    assert.deepEqual(Object.keys(op.images), ['11:6'], 'images 键应等于 IR asset 名 11:6');
    assert.deepEqual(Buffer.from(op.images['11:6'], 'base64'), assetBytes, 'OP.images 解码应与文件字节一致');

    // OP.code（生成脚本）：引用注入的 images 映射取字节（动态键 images[key]，key 来自 IR asset），且不内嵌 base64
    const code = op.code;
    assert.ok(code.includes('figma.createImage(images[key])'), '脚本应经注入的 images 映射取字节（images[key]）');
    assert.ok(code.includes('images['), '脚本以注入 images 映射为图片来源（非内嵌）');
    assert.equal(code.includes(assetB64), false, '脚本不得内嵌 asset base64（图片走 images 通道）');

    // 不触碰既有节点：脚本无删除/销毁调用
    for (const re of BANNED_MUTATION) {
      assert.equal(re.test(code), false, `提交脚本不得含触碰既有节点的调用（匹配 ${re}）`);
    }

    assert.equal(child.code, 0, `rebuild 应 exit 0，stderr=${child.stderr}`);
    assert.ok(child.stdout.includes('OK '), `stdout 应含 OK，实际：${child.stdout}`);
    assert.ok(
      child.stdout.includes('Rebuilt: frameId=0:1 created=12 skipped=2'),
      `stdout 应含重建计数，实际：${child.stdout}`
    );
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

test('FUN-ACC-702 无 image 的 IR：OP 不带 images 字段（与 M3 兼容）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-rebuild-noimg-'));
  try {
    const ir = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'design-ir.json'), 'utf8'));
    ir.root.children = ir.root.children.filter((c) => c.type !== 'image'); // 去掉 image 节点
    fs.writeFileSync(path.join(dir, 'design-ir.json'), JSON.stringify(ir));

    const token = newToken();
    const bridge = await startBridge({ port: 0, token });
    const plugin = makeFakePlugin(bridge.httpPort, token);
    try {
      await plugin.opened;
      const { op, child } = await runWithPlugin(
        plugin,
        ['rebuild', dir, '--token', token, '--port', String(bridge.httpPort)],
        (o) => ({
          kind: 'RESULT',
          jobId: o.jobId,
          status: 'ok',
          message: 'ok',
          data: JSON.stringify({ frameId: '0:2', created: 10, skipped: 2, fontFallbacks: [] }),
        })
      );
      assert.ok(op, 'OP 应下发');
      assert.equal('images' in op, false, '无 image 的 IR 提交时 OP 不应携带 images 字段');
      assert.equal(child.code, 0, `exit 0 预期，stderr=${child.stderr}`);
    } finally {
      await plugin.close();
      await bridge.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== 错误路径：exit 2 + stderr 明确 ====================

test('错误路径：缺 IR 目录 / design-ir.json 非法 JSON / 缺 schema 字段(v/kind/root) → exit 2 + stderr 明确', async () => {
  // 1) 目录不存在
  const missingDir = await runCli([
    'rebuild',
    path.join(os.tmpdir(), 'figmapt-no-such-ir-' + crypto.randomBytes(4).toString('hex')),
  ]);
  assert.equal(missingDir.code, 2, `缺目录应 exit 2，实际 ${missingDir.code}`);
  assert.ok(/错误:/.test(missingDir.stderr) && /IR 目录不存在/.test(missingDir.stderr), `stderr 应明确，实际：${missingDir.stderr}`);

  // 2) design-ir.json 非法 JSON
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-rebuild-badjson-'));
  fs.writeFileSync(path.join(badDir, 'design-ir.json'), '{ 这不是合法 json ');
  const badJson = await runCli(['rebuild', badDir]);
  assert.equal(badJson.code, 2, `非法 JSON 应 exit 2，实际 ${badJson.code}`);
  assert.ok(/错误:/.test(badJson.stderr) && /合法 JSON/.test(badJson.stderr), `stderr 应明确，实际：${badJson.stderr}`);
  fs.rmSync(badDir, { recursive: true, force: true });

  // 3) 缺 schema 字段：v / kind / root 各一例
  const cases = [
    { drop: 'v', json: { kind: 'design-ir', root: { type: 'frame', name: 'r' } } },
    { drop: 'kind', json: { v: 1, root: { type: 'frame', name: 'r' } } },
    { drop: 'root', json: { v: 1, kind: 'design-ir' } },
  ];
  for (const c of cases) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-rebuild-schema-'));
    fs.writeFileSync(path.join(d, 'design-ir.json'), JSON.stringify(c.json));
    const child = await runCli(['rebuild', d]);
    assert.equal(child.code, 2, `缺 ${c.drop} 应 exit 2，实际 ${child.code}`);
    assert.ok(
      /错误:/.test(child.stderr) && child.stderr.includes(`缺少字段 ${c.drop}`),
      `缺 ${c.drop} 的 stderr 应明确，实际：${child.stderr}`
    );
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('错误路径：rebuild 缺位置参数（目录）→ exit 2', async () => {
  const child = await runCli(['rebuild']);
  assert.equal(child.code, 2, `缺目录位置参数应 exit 2，实际 ${child.code}`);
  assert.ok(/错误:/.test(child.stderr) && /IR 目录路径/.test(child.stderr), `stderr 应明确，实际：${child.stderr}`);
});
