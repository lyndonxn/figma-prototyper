/**
 * M3 CLI 契约测试（node:test，不依赖 Figma）
 *
 * 复用 bridge/test 的假插件模式：startBridge({port:0}) + 假插件 WS 连接 +
 * spawn 真实 CLI 子进程（node cli/figmapt.js run ...）。
 * 覆盖：FUN-ACC-301（阻塞等 ok + 截图落盘字节一致）、FUN-ACC-302（失败/超时语义）、
 * FUN-ACC-303（截图参数组装与透传、scale clamp）、附加（无插件/401/连接拒绝 → exit 2、
 * 用法错误、token/port 环境变量回退）。
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
import { startBridge, SCREENSHOT_DIR } from '../../bridge/server.js';

// CLI 本体零依赖；测试侧复用 bridge 的 ws（经 createRequire 定位到 bridge/node_modules）
const bridgeRequire = createRequire(new URL('../../bridge/package.json', import.meta.url));
const { WebSocket } = bridgeRequire('ws');

const CLI_PATH = fileURLToPath(new URL('../figmapt.js', import.meta.url));

// 1×1 透明 PNG 的 base64（最小合法 PNG，含标准 8 字节签名）
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** 假插件（同 bridge/test 模式）：连接 WS、记录消息、waitFor/send/close */
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
  ws.on('error', () => {}); // 关闭竞态下的 error 不打断测试，由断言裁决

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

/** 运行 CLI 子进程；默认剥掉环境变量中的 token/port（避免外泄环境干扰断言） */
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

/** 临时脚本目录（每用例自建自清理） */
function makeScriptDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-cli-test-'));
}

function writeScript(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

/**
 * 发起一次 CLI 运行，并在 OP 到达时按 replyFactory 回 RESULT。
 * 返回 { op, child }；op 为 null 表示插件未收到 OP（用于无插件等场景的前置防御）。
 * seen: 跨多次运行的 OP 去重集合（同一 bridge/plugin 连续多轮时传入同一个 Set）。
 * env: 传给 CLI 子进程的环境变量覆盖（用于 token/port 环境变量回退测试）。
 */
async function runWithPlugin(plugin, cliArgs, replyFactory, seen = new Set(), env = {}) {
  const pendingOp = plugin
    .waitFor((m) => m.kind === 'OP' && !seen.has(m.jobId), 'OP')
    .then((op) => {
      seen.add(op.jobId);
      return op;
    })
    .catch(() => null);
  const childPromise = runCli(cliArgs, env);
  const op = await pendingOp;
  if (op) plugin.send(replyFactory(op));
  const child = await childPromise;
  return { op, child };
}

async function cleanupFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* 已清理 */
  }
}

// ---- FUN-ACC-301 阻塞等 ok + 截图落盘 ----

test('FUN-ACC-301 ok+截图：CLI exit 0，stdout 含 OK 与截图路径，文件真实存在且字节与 base64 解码一致', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  const dir = makeScriptDir();
  let shotPath = null;
  try {
    await plugin.opened;
    const script = writeScript(dir, 'm301.js', "return 'created frame';");

    const { child } = await runWithPlugin(plugin, ['run', script, '--token', token, '--port', String(bridge.httpPort)], (op) => ({
      kind: 'RESULT',
      jobId: op.jobId,
      status: 'ok',
      message: '已创建 Frame',
      screenshotBase64: PNG_1X1_BASE64,
    }));

    assert.equal(child.code, 0, `exit 0 预期，实际 ${child.code}，stderr=${child.stderr}`);
    assert.ok(child.stdout.includes(`OK `), `stdout 应含 OK，实际：${child.stdout}`);
    const shotMatch = /Screenshot: (.+)/.exec(child.stdout);
    assert.ok(shotMatch, `stdout 应含 Screenshot: <路径>，实际：${child.stdout}`);
    shotPath = shotMatch[1].trim();

    assert.ok(path.isAbsolute(shotPath), `截图路径应为绝对路径：${shotPath}`);
    assert.ok(
      shotPath.startsWith(SCREENSHOT_DIR + path.sep),
      `截图应落在 ${SCREENSHOT_DIR}，实际：${shotPath}`
    );
    assert.ok(fs.existsSync(shotPath), '截图文件应真实存在');
    const bytes = fs.readFileSync(shotPath);
    assert.deepEqual(bytes, Buffer.from(PNG_1X1_BASE64, 'base64'), '落盘字节应与 base64 解码一致');
    assert.deepEqual(
      bytes.subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      '应为合法 PNG 签名'
    );
    assert.ok(child.stdout.includes('Message: 已创建 Frame'), 'stdout 应含 Message 行');
  } finally {
    await cleanupFile(shotPath);
    fs.rmSync(dir, { recursive: true, force: true });
    await plugin.close();
    await bridge.close();
  }
});

// ---- FUN-ACC-302 失败语义 ----

test('FUN-ACC-302a 脚本 failed：CLI exit 1，stderr 含 FAILED 与原错误文本', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  const dir = makeScriptDir();
  try {
    await plugin.opened;
    const script = writeScript(dir, 'm302a.js', 'throw new Error("boom")');
    const originalError = 'Error: boom (原样错误不截断)';

    const { child } = await runWithPlugin(plugin, ['run', script, '--token', token, '--port', String(bridge.httpPort)], (op) => ({
      kind: 'RESULT',
      jobId: op.jobId,
      status: 'failed',
      message: originalError,
    }));

    assert.equal(child.code, 1, `exit 1 预期，实际 ${child.code}，stdout=${child.stdout}`);
    assert.ok(child.stderr.includes('FAILED:'), `stderr 应含 FAILED:，实际：${child.stderr}`);
    assert.ok(child.stderr.includes(originalError), `stderr 应含原错误文本，实际：${child.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await plugin.close();
    await bridge.close();
  }
});

test('FUN-ACC-302b 超时：假插件不回 RESULT，--timeout 400 → 桥接看门狗 FAILED(timeout) → CLI exit 1', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  const dir = makeScriptDir();
  try {
    await plugin.opened;
    const script = writeScript(dir, 'm302b.js', 'never-returns');

    const { op, child } = await runWithPlugin(
      plugin,
      ['run', script, '--timeout', '400', '--token', token, '--port', String(bridge.httpPort)],
      () => null // 不回 RESULT，触发桥接看门狗
    );
    assert.ok(op, 'OP 应已下发到插件');

    assert.equal(child.code, 1, `exit 1 预期，实际 ${child.code}，stdout=${child.stdout}`);
    assert.ok(child.stderr.includes('FAILED:'), `stderr 应含 FAILED:，实际：${child.stderr}`);
    assert.ok(child.stderr.includes('timeout'), `stderr 应含 timeout，实际：${child.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await plugin.close();
    await bridge.close();
  }
});

// ---- FUN-ACC-303 截图参数化（静态/协议部分：CLI 组装 + 桥接透传 + clamp）----

test('FUN-ACC-303 --node/--rect/--scale 组装正确：OP.screenshot 精确匹配，scale=9 clamp 为 4，无参数时不带 screenshot', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  const dir = makeScriptDir();
  const seen = new Set();
  try {
    await plugin.opened;
    const script = writeScript(dir, 'm303.js', 'return 1');
    const baseArgs = ['--token', token, '--port', String(bridge.httpPort)];

    // node 模式 + scale 2
    let { op, child } = await runWithPlugin(
      plugin,
      ['run', script, '--node', '11:6', '--scale', '2', ...baseArgs],
      (o) => ({ kind: 'RESULT', jobId: o.jobId, status: 'ok', message: '1' }),
      seen
    );
    assert.equal(child.code, 0, `node 模式 CLI 应成功，stderr=${child.stderr}`);
    assert.deepEqual(
      op.screenshot,
      { mode: 'node', nodeId: '11:6', scale: 2 },
      'OP.screenshot 应为 {mode:node, nodeId, scale:2}'
    );

    // rect 模式 + scale 9 → clamp 到 4（ADR-0002 预算上界）
    ({ op, child } = await runWithPlugin(
      plugin,
      ['run', script, '--rect', '10,20,320,240', '--scale', '9', ...baseArgs],
      (o) => ({ kind: 'RESULT', jobId: o.jobId, status: 'ok', message: '1' }),
      seen
    ));
    assert.equal(child.code, 0, `rect 模式 CLI 应成功，stderr=${child.stderr}`);
    assert.deepEqual(
      op.screenshot,
      { mode: 'rect', rect: { x: 10, y: 20, width: 320, height: 240 }, scale: 4 },
      'OP.screenshot 应为 rect 区域且 scale clamp 到 4'
    );

    // rect 整数含空格容错
    ({ op, child } = await runWithPlugin(
      plugin,
      ['run', script, '--rect', '0, 0, 64, 32', ...baseArgs],
      (o) => ({ kind: 'RESULT', jobId: o.jobId, status: 'ok', message: '1' }),
      seen
    ));
    assert.equal(child.code, 0);
    assert.deepEqual(op.screenshot, {
      mode: 'rect',
      rect: { x: 0, y: 0, width: 64, height: 32 },
      scale: 1,
    });

    // 不带 --node/--rect（M2 兼容）：OP 不携带 screenshot 字段
    ({ op, child } = await runWithPlugin(
      plugin,
      ['run', script, ...baseArgs],
      (o) => ({ kind: 'RESULT', jobId: o.jobId, status: 'ok', message: '1' }),
      seen
    ));
    assert.equal(child.code, 0);
    assert.equal('screenshot' in op, false, '无截图参数时 OP 不应携带 screenshot 字段');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await plugin.close();
    await bridge.close();
  }
});

// ---- 附加：传输/鉴权层错误 → ERROR + exit 2 ----

test('附加：无插件连接 → 503 → CLI exit 2，stderr 含 ERROR', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const dir = makeScriptDir();
  try {
    const script = writeScript(dir, 'noplugin.js', 'return 1');
    const child = await runCli(['run', script, '--token', token, '--port', String(bridge.httpPort)]);
    assert.equal(child.code, 2, `exit 2 预期，实际 ${child.code}`);
    assert.ok(child.stderr.includes('ERROR'), `stderr 应含 ERROR，实际：${child.stderr}`);
    assert.ok(child.stderr.includes('no-plugin-connected'), `stderr 应含 503 细节，实际：${child.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await bridge.close();
  }
});

test('附加：错 token → 401 → CLI exit 2；连接拒绝（桥接已关闭）→ CLI exit 2', async () => {
  const dir = makeScriptDir();
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const script = writeScript(dir, 'auth.js', 'return 1');
  try {
    // 401
    const child401 = await runCli(['run', script, '--token', 'wrong-token', '--port', String(bridge.httpPort)]);
    assert.equal(child401.code, 2, `401 应 exit 2，实际 ${child401.code}`);
    assert.ok(child401.stderr.includes('ERROR') && child401.stderr.includes('401'), child401.stderr);

    // 连接拒绝：先关桥接再用同端口
    const port = bridge.httpPort;
    await bridge.close();
    const childRefused = await runCli(['run', script, '--token', token, '--port', String(port)]);
    assert.equal(childRefused.code, 2, `连接拒绝应 exit 2，实际 ${childRefused.code}`);
    assert.ok(childRefused.stderr.includes('ERROR'), childRefused.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      await bridge.close(); // 幂等
    } catch {
      /* 已关闭 */
    }
  }
});

// ---- 附加：参数错误 → 用法说明 + exit 2 ----

test('附加：参数错误（文件不存在 / rect 格式错 / node+rect 互斥 / 缺 token / scale 非数字）→ stderr 用法 + exit 2', async () => {
  const dir = makeScriptDir();
  try {
    const script = writeScript(dir, 'ok.js', 'return 1');

    const missing = await runCli(['run', path.join(dir, 'nope.js'), '--token', 't']);
    assert.equal(missing.code, 2);
    assert.ok(missing.stderr.includes('参数错误') && missing.stderr.includes('用法:'), missing.stderr);

    const badRect = await runCli(['run', script, '--rect', '1,2,three', '--token', 't']);
    assert.equal(badRect.code, 2);
    assert.ok(badRect.stderr.includes('用法:'), badRect.stderr);

    const both = await runCli(['run', script, '--node', '11:6', '--rect', '0,0,1,1', '--token', 't']);
    assert.equal(both.code, 2);
    assert.ok(both.stderr.includes('互斥'), both.stderr);

    const noToken = await runCli(['run', script]);
    assert.equal(noToken.code, 2);
    assert.ok(noToken.stderr.includes('token'), noToken.stderr);

    const badScale = await runCli(['run', script, '--node', '11:6', '--scale', 'big', '--token', 't']);
    assert.equal(badScale.code, 2);
    assert.ok(badScale.stderr.includes('用法:'), badScale.stderr);

    const noCmd = await runCli([]);
    assert.equal(noCmd.code, 2);
    assert.ok(noCmd.stderr.includes('用法:'), noCmd.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 附加：token/port 环境变量回退 ----

test('附加：FIGMA_BRIDGE_TOKEN / FIGMA_BRIDGE_PORT 环境变量回退生效（无 --token/--port 也成功）', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  const dir = makeScriptDir();
  try {
    await plugin.opened;
    const script = writeScript(dir, 'env.js', 'return 1');
    const { child } = await runWithPlugin(
      plugin,
      ['run', script],
      (op) => ({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '1' }),
      new Set(),
      { FIGMA_BRIDGE_TOKEN: token, FIGMA_BRIDGE_PORT: String(bridge.httpPort) }
    );
    assert.equal(child.code, 0, `环境变量回退应成功，stderr=${child.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await plugin.close();
    await bridge.close();
  }
});

// ==================== M4：--image 图片下发（FUN-ACC-402 CLI 侧） ====================

test('M4：--image 单图（缺省名=文件名去扩展名）→ OP.images 键正确、base64 解码后与文件字节一致', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  const dir = makeScriptDir();
  try {
    await plugin.opened;
    const script = writeScript(dir, 'm402.js', "return 'with image';");
    const imgPath = path.join(dir, 'logo.png');
    const imgBytes = crypto.randomBytes(192); // 任意二进制，验证 base64 往返无损
    fs.writeFileSync(imgPath, imgBytes);

    const { op, child } = await runWithPlugin(
      plugin,
      ['run', script, '--image', imgPath, '--token', token, '--port', String(bridge.httpPort)],
      (o) => ({ kind: 'RESULT', jobId: o.jobId, status: 'ok', message: 'ok' })
    );
    assert.equal(child.code, 0, `CLI 应成功，stderr=${child.stderr}`);
    assert.ok(op, 'OP 应已下发');
    assert.deepEqual(Object.keys(op.images), ['logo'], '缺省名应为文件名去扩展名');
    assert.deepEqual(
      Buffer.from(op.images.logo, 'base64'),
      imgBytes,
      'OP.images.logo 解码后应与 CLI 读取的文件字节一致'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await plugin.close();
    await bridge.close();
  }
});

test('M4：--image name=path 显式命名 + 多图 → OP.images 键正确、各字节一致；无 --image 的 OP 不带 images 字段', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  const dir = makeScriptDir();
  const seen = new Set();
  try {
    await plugin.opened;
    const script = writeScript(dir, 'm402b.js', 'return 1');
    const img1 = path.join(dir, 'hero.png');
    const img2 = path.join(dir, 'photo.dat'); // 无扩展名歧义：用显式命名
    const bytes1 = crypto.randomBytes(64);
    const bytes2 = crypto.randomBytes(128);
    fs.writeFileSync(img1, bytes1);
    fs.writeFileSync(img2, bytes2);
    const baseArgs = ['--token', token, '--port', String(bridge.httpPort)];

    // name=path 命名 + 缺省命名混合
    const { op, child } = await runWithPlugin(
      plugin,
      ['run', script, '--image', `icon=${img1}`, '--image', img2, ...baseArgs],
      (o) => ({ kind: 'RESULT', jobId: o.jobId, status: 'ok', message: '1' }),
      seen
    );
    assert.equal(child.code, 0, `CLI 应成功，stderr=${child.stderr}`);
    assert.deepEqual(Object.keys(op.images).sort(), ['icon', 'photo']);
    assert.deepEqual(Buffer.from(op.images.icon, 'base64'), bytes1, '命名图字节应一致');
    assert.deepEqual(Buffer.from(op.images.photo, 'base64'), bytes2, '缺省名图字节应一致');

    // 无 --image：OP 不带 images 字段（M3 兼容）
    const { op: opLegacy } = await runWithPlugin(
      plugin,
      ['run', script, ...baseArgs],
      (o) => ({ kind: 'RESULT', jobId: o.jobId, status: 'ok', message: '1' }),
      seen
    );
    assert.equal('images' in opLegacy, false, '无 --image 时 OP 不应携带 images 字段');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await plugin.close();
    await bridge.close();
  }
});

test('M4：--image 错误参数——文件不存在 / 名称重复 / 空值 / 名称空 → stderr 用法 + exit 2', async () => {
  const dir = makeScriptDir();
  try {
    const script = writeScript(dir, 'ok.js', 'return 1');
    const imgA = path.join(dir, 'a.png');
    const imgB = path.join(dir, 'b.png');
    fs.writeFileSync(imgA, Buffer.from('aaa'));
    fs.writeFileSync(imgB, Buffer.from('bbb'));

    const missing = await runCli(['run', script, '--image', path.join(dir, 'nope.png'), '--token', 't']);
    assert.equal(missing.code, 2, `文件不存在应 exit 2，实际 ${missing.code}`);
    assert.ok(missing.stderr.includes('用法:'), missing.stderr);
    assert.ok(missing.stderr.includes('nope.png'), `错误信息应含文件路径：${missing.stderr}`);

    const dup = await runCli(['run', script, '--image', `x=${imgA}`, '--image', `x=${imgB}`, '--token', 't']);
    assert.equal(dup.code, 2, `名称重复应 exit 2，实际 ${dup.code}`);
    assert.ok(dup.stderr.includes('重复'), dup.stderr);

    const empty = await runCli(['run', script, '--image=', '--token', 't']);
    assert.equal(empty.code, 2, `空值应 exit 2，实际 ${empty.code}`);
    assert.ok(empty.stderr.includes('用法:'), empty.stderr);

    const noName = await runCli(['run', script, '--image', `=${imgA}`, '--token', 't']);
    assert.equal(noName.code, 2, `名称空应 exit 2，实际 ${noName.code}`);
    assert.ok(noName.stderr.includes('名称'), noName.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
