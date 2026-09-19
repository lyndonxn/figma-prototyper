/**
 * M2/M3 桥接契约测试（node:test，不依赖 Figma）
 *
 * 覆盖：FUN-ACC-201~204 + 附加（Job 超时看门狗、无插件 503、连接断开失败在途 Job）
 * + M3 截图参数透传与落盘（FUN-ACC-303 桥接侧、写盘字节一致性）。
 * 约定：每个用例临时端口（port:0）+ 随机 token，teardown 全部关闭。
 * 运行：cd figma-prototyper/bridge && npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startBridge, SCREENSHOT_DIR } from '../server.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 假插件：带 token 连接 WS，记录收到的消息，支持 waitFor / send / close。
 */
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

  function waitFor(pred, label = 'message', timeoutMs = 3000) {
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

/** 收集 WS 关闭码（FUN-ACC-201：无/错 token 应为 4401） */
function collectClose(ws) {
  return new Promise((resolve, reject) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', reject);
  });
}

async function postJob(port, token, body) {
  const res = await fetch(`http://127.0.0.1:${port}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function getEvents(port, token) {
  const res = await fetch(`http://127.0.0.1:${port}/events`, {
    headers: { 'x-bridge-token': token },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ---- FUN-ACC-201 仅本地监听 ----

test('FUN-ACC-201 仅绑定 127.0.0.1，无 token / 错 token 的 WS 连接被拒 4401', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  try {
    // 监听地址：server.address().address === '127.0.0.1'（经 startBridge 返回的 host 透出）
    assert.equal(bridge.host, '127.0.0.1');
    assert.equal(typeof bridge.httpPort, 'number');

    const noToken = await collectClose(new WebSocket(`ws://127.0.0.1:${bridge.httpPort}`));
    assert.equal(noToken.code, 4401, `无 token 应为 close 4401，实际 ${noToken.code}`);

    const badToken = await collectClose(
      new WebSocket(`ws://127.0.0.1:${bridge.httpPort}/?token=${'x'.repeat(32)}`)
    );
    assert.equal(badToken.code, 4401, `错 token 应为 close 4401，实际 ${badToken.code}`);

    // /health 免鉴权且不泄露信息；/events 无 token 被拒
    const health = await fetch(`http://127.0.0.1:${bridge.httpPort}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const eventsNoAuth = await fetch(`http://127.0.0.1:${bridge.httpPort}/events`);
    assert.equal(eventsNoAuth.status, 401);
    const jobsNoAuth = await postJob(bridge.httpPort, 'wrong-token', { code: 'return 1' });
    assert.equal(jobsNoAuth.status, 401);
  } finally {
    await bridge.close();
  }
});

// ---- FUN-ACC-202 WS 双工通路 ----

test('FUN-ACC-202 假插件连上 → OP 下发 → RESULT 回传 → HTTP 得到 ok/failed', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;

    // ok 路径
    const pending = postJob(bridge.httpPort, token, { code: 'return 1+1' });
    const op = await plugin.waitFor((m) => m.kind === 'OP', 'OP');
    assert.equal(op.code, 'return 1+1');
    assert.equal(typeof op.jobId, 'string');
    assert.ok(op.jobId.length > 0);
    assert.equal(op.v, 1);
    assert.equal(typeof op.ts, 'number');
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '2' });
    const resp = await pending;
    assert.equal(resp.status, 200);
    assert.equal(resp.json.status, 'ok');
    assert.equal(resp.json.message, '2');
    assert.equal(resp.json.jobId, op.jobId);
    assert.equal(typeof resp.json.elapsedMs, 'number');

    // failed 路径
    const pending2 = postJob(bridge.httpPort, token, { code: 'throw new Error("boom")' });
    const op2 = await plugin.waitFor((m) => m.kind === 'OP' && m.code.includes('boom'), 'OP#2');
    plugin.send({ kind: 'RESULT', jobId: op2.jobId, status: 'failed', message: 'Error: boom' });
    const resp2 = await pending2;
    assert.equal(resp2.json.status, 'failed');
    assert.equal(resp2.json.message, 'Error: boom');
    assert.equal(resp2.json.jobId, op2.jobId);
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

// ---- FUN-ACC-203 暂停开关 ----

test('FUN-ACC-203 CONTROL pause 期间 Job 保持 QUEUED 不下发，resume 后送达；RUNNING 不被打断', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;

    plugin.send({ kind: 'CONTROL', action: 'pause' });
    await sleep(50); // 让桥接处理 CONTROL

    const pending = postJob(bridge.httpPort, token, { code: 'paused-job' });
    await sleep(500);
    assert.equal(
      plugin.received.filter((m) => m.kind === 'OP').length,
      0,
      '暂停期间插件不应收到任何 OP'
    );

    plugin.send({ kind: 'CONTROL', action: 'resume' });
    const op = await plugin.waitFor((m) => m.kind === 'OP', 'OP after resume');
    assert.equal(op.code, 'paused-job');
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: 'done' });
    const resp = await pending;
    assert.equal(resp.json.status, 'ok');

    // RUNNING 中的 Job 不被 pause 打断
    const pending2 = postJob(bridge.httpPort, token, { code: 'running-while-pause' });
    const op2 = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'running-while-pause', 'OP#2');
    plugin.send({ kind: 'CONTROL', action: 'pause' });
    plugin.send({ kind: 'RESULT', jobId: op2.jobId, status: 'ok', message: 'still-ok' });
    const resp2 = await pending2;
    assert.equal(resp2.json.status, 'ok');
    assert.equal(resp2.json.message, 'still-ok');
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

// ---- FUN-ACC-204 EVENT 防抖 ----

test('FUN-ACC-204 1 秒内 30 条 EVENT 防抖合并为 ≤ceil(1500/1000)+1 条，batch 拼接无丢失', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token, eventWindowMs: 1000 });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;

    for (let i = 0; i < 30; i++) {
      plugin.send({ kind: 'EVENT', type: 'documentchange', batch: [{ change: i }] });
      await sleep(10); // 30 条约 300ms，全部落在第一个 1s 窗口内
    }
    await sleep(1500); // 等窗口 flush

    const res = await getEvents(bridge.httpPort, token);
    assert.equal(res.status, 200);
    const data = res.json;
    assert.ok(Array.isArray(data.events));

    assert.ok(data.events.length >= 1, '至少合并出 1 条事件');
    assert.ok(
      data.events.length <= Math.ceil(1500 / 1000) + 1,
      `合并后条数应 ≤ ${Math.ceil(1500 / 1000) + 1}，实际 ${data.events.length}`
    );

    const total = data.events.reduce((n, e) => n + e.batch.length, 0);
    assert.equal(total, 30, '窗口内各 batch 应拼接为一条且无丢失');

    for (const e of data.events) {
      assert.equal(e.kind, 'EVENT');
      assert.equal(e.v, 1);
      assert.equal(e.type, 'documentchange');
      assert.ok(Array.isArray(e.batch) && e.batch.length > 0);
    }
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

// ---- 附加：Job 超时看门狗（ADR-0003）----

test('附加：RUNNING 超时看门狗 → FAILED 含 timeout；迟到 RESULT 被忽略且桥接仍健康', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token, jobTimeoutMs: 300 });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;

    const t0 = Date.now();
    const resp = await postJob(bridge.httpPort, token, { code: 'never-returns' });
    const elapsed = Date.now() - t0;
    assert.equal(resp.json.status, 'failed');
    assert.ok(resp.json.message.includes('timeout'), `message 应含 timeout，实际：${resp.json.message}`);
    assert.ok(elapsed >= 250, `看门狗不应早于 timeoutMs 触发，实际 ${elapsed}ms`);
    assert.ok(elapsed < 2000, `看门狗应在 ~300ms 触发，实际 ${elapsed}ms`);

    // 迟到 RESULT：忽略（不崩溃），桥接仍健康
    plugin.send({ kind: 'RESULT', jobId: resp.json.jobId, status: 'ok', message: 'too late' });
    await sleep(100);
    const health = await fetch(`http://127.0.0.1:${bridge.httpPort}/health`);
    assert.deepEqual(await health.json(), { ok: true });
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

// ---- 附加：无插件连接 ----

test('附加：无插件连接时 POST /jobs → 503 no-plugin-connected', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  try {
    const resp = await postJob(bridge.httpPort, token, { code: 'return 1' });
    assert.equal(resp.status, 503);
    assert.deepEqual(resp.json, { error: 'no-plugin-connected' });
  } finally {
    await bridge.close();
  }
});

// ---- 附加：连接断开时在途 Job 失败 ----

test('附加：插件连接断开 → 在途 Job FAILED(connection lost)，长轮询得到确定答复', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;
    const pending = postJob(bridge.httpPort, token, { code: 'will-drop' });
    await plugin.waitFor((m) => m.kind === 'OP', 'OP');

    await plugin.close(); // 插件主动断开

    const resp = await pending;
    assert.equal(resp.json.status, 'failed');
    assert.ok(resp.json.message.includes('connection lost'), `应含 connection lost，实际：${resp.json.message}`);
  } finally {
    await bridge.close();
  }
});

// ==================== M3：截图参数透传与落盘 ====================

// 1×1 透明 PNG 的 base64（最小合法 PNG，含标准 8 字节签名）
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('M3：POST /jobs 带 screenshot → OP 原样透传（scale clamp [0.1,4]），无 screenshot 的 OP 不带该字段', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;

    // node 模式：scale=2 原样透传
    let pending = postJob(bridge.httpPort, token, {
      code: 'a',
      screenshot: { mode: 'node', nodeId: '11:6', scale: 2 },
    });
    let op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'a', 'OP#node');
    assert.deepEqual(op.screenshot, { mode: 'node', nodeId: '11:6', scale: 2 });
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '' });
    assert.equal((await pending).json.status, 'ok');

    // rect 模式：scale=9 clamp 到 4（ADR-0002 预算上界）
    pending = postJob(bridge.httpPort, token, {
      code: 'b',
      screenshot: { mode: 'rect', rect: { x: 0, y: 0, width: 320, height: 240 }, scale: 9 },
    });
    op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'b', 'OP#rect');
    assert.deepEqual(op.screenshot, {
      mode: 'rect',
      rect: { x: 0, y: 0, width: 320, height: 240 },
      scale: 4,
    });
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '' });
    assert.equal((await pending).json.status, 'ok');

    // scale=0.05 clamp 到 0.1；page 模式
    pending = postJob(bridge.httpPort, token, {
      code: 'c',
      screenshot: { mode: 'page', scale: 0.05 },
    });
    op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'c', 'OP#page');
    assert.deepEqual(op.screenshot, { mode: 'page', scale: 0.1 });
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '' });
    assert.equal((await pending).json.status, 'ok');

    // 无 screenshot 字段（M2 兼容）：OP 不应带 screenshot
    pending = postJob(bridge.httpPort, token, { code: 'd' });
    op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'd', 'OP#legacy');
    assert.equal('screenshot' in op, false, 'M2 兼容路径 OP 不应携带 screenshot 字段');
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '' });
    assert.equal((await pending).json.status, 'ok');
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

test('M3：非法 screenshot → 400 invalid-screenshot（node 缺 nodeId / rect 缺失 / mode 未知 / scale 非数值）', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;
    const cases = [
      { mode: 'node' }, // 缺 nodeId
      { mode: 'node', nodeId: '' },
      { mode: 'rect' }, // 缺 rect
      { mode: 'rect', rect: { x: 0, y: 0, width: 'a', height: 1 } },
      { mode: 'fullscreen' }, // 未知 mode
      { mode: 'page', scale: 'big' }, // scale 非数值
      'not-an-object', // 非对象
    ];
    for (const screenshot of cases) {
      const resp = await postJob(bridge.httpPort, token, { code: 'x', screenshot });
      assert.equal(resp.status, 400, `case ${JSON.stringify(screenshot)} 应 400`);
      assert.equal(resp.json.error, 'invalid-screenshot');
    }
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

test('M3：RESULT 带 screenshotBase64 → 解码落盘 screenshots/job-<jobId>.png，响应带绝对 screenshotPath 且字节一致；screenshotError 原样透传且不改写状态', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  const written = [];
  try {
    await plugin.opened;

    // ok + 截图：落盘 + screenshotPath
    let pending = postJob(bridge.httpPort, token, {
      code: 'shot',
      screenshot: { mode: 'node', nodeId: '1:1', scale: 1 },
    });
    const op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'shot', 'OP');
    plugin.send({
      kind: 'RESULT',
      jobId: op.jobId,
      status: 'ok',
      message: 'done',
      screenshotBase64: PNG_1X1_BASE64,
    });
    const resp = await pending;
    assert.equal(resp.json.status, 'ok');
    assert.equal(typeof resp.json.screenshotPath, 'string');
    assert.ok(path.isAbsolute(resp.json.screenshotPath), 'screenshotPath 应为绝对路径');
    assert.ok(
      resp.json.screenshotPath.startsWith(SCREENSHOT_DIR + path.sep) &&
        path.basename(resp.json.screenshotPath) === `job-${op.jobId}.png`,
      `screenshotPath 应位于固定目录且名为 job-<jobId>.png，实际：${resp.json.screenshotPath}`
    );
    const bytes = fs.readFileSync(resp.json.screenshotPath);
    assert.deepEqual(bytes, Buffer.from(PNG_1X1_BASE64, 'base64'), '落盘字节应与 base64 解码一致');
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    written.push(resp.json.screenshotPath);

    // ok + 截图捕获失败：screenshotError 透传，状态仍 ok
    pending = postJob(bridge.httpPort, token, { code: 'err', screenshot: { mode: 'node', nodeId: '1:1' } });
    const op2 = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'err', 'OP#2');
    plugin.send({
      kind: 'RESULT',
      jobId: op2.jobId,
      status: 'ok',
      message: 'script-ok',
      screenshotError: 'screenshot node not found: 1:1',
    });
    const resp2 = await pending;
    assert.equal(resp2.json.status, 'ok', '截图失败不使 Job 失败');
    assert.equal(resp2.json.screenshotError, 'screenshot node not found: 1:1');
    assert.equal('screenshotPath' in resp2.json, false);
  } finally {
    await plugin.close();
    await bridge.close();
    for (const f of written) {
      try { fs.unlinkSync(f); } catch { /* 已清理 */ }
    }
  }
});

// ==================== M4：images 透传与限额、screenshotBase64 PNG 形式校验 ====================

test('M4：POST /jobs 带 images → OP 原样透传 base64（不转码），可与 screenshot 共存；无/空 images 的 OP 不带 images 字段（M3 逐字节兼容）', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;
    const imgB64 = Buffer.from('figma-m4-image-bytes-含中文与\x00\x01二进制', 'utf8').toString('base64');

    // 带 images：OP.images 与请求逐字符串一致（桥接只透传不转码）
    let pending = postJob(bridge.httpPort, token, {
      code: 'img-job',
      images: { logo: imgB64, icon: PNG_1X1_BASE64 },
    });
    let op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'img-job', 'OP#img');
    assert.deepEqual(op.images, { logo: imgB64, icon: PNG_1X1_BASE64 });
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '' });
    assert.equal((await pending).json.status, 'ok');

    // images + screenshot 共存
    pending = postJob(bridge.httpPort, token, {
      code: 'img-shot',
      images: { logo: imgB64 },
      screenshot: { mode: 'node', nodeId: '1:1', scale: 1 },
    });
    op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'img-shot', 'OP#imgshot');
    assert.deepEqual(op.images, { logo: imgB64 });
    assert.deepEqual(op.screenshot, { mode: 'node', nodeId: '1:1', scale: 1 });
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '' });
    assert.equal((await pending).json.status, 'ok');

    // 无 images（M3 兼容）：OP 键集合与 M3 完全一致（逐字节兼容的结构证据）
    pending = postJob(bridge.httpPort, token, { code: 'legacy' });
    op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'legacy', 'OP#legacy');
    assert.deepEqual(Object.keys(op).sort(), ['code', 'id', 'jobId', 'kind', 'ts', 'v']);
    assert.equal('images' in op, false);
    assert.equal('screenshot' in op, false);
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '' });
    assert.equal((await pending).json.status, 'ok');

    // 空 images 对象：视为未提供（不透传）
    pending = postJob(bridge.httpPort, token, { code: 'empty-img', images: {} });
    op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'empty-img', 'OP#empty');
    assert.equal('images' in op, false, '空 images 对象应视为未提供');
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '' });
    assert.equal((await pending).json.status, 'ok');
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

test('M4：images 校验 → 400 invalid-images（字符非法 / 长度非4倍数 / 空值 / 非字符串值 / 空名 / __proto__ / 单图>5MB / 总量>20MB / 非对象）', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;
    const exact5mb = Buffer.alloc(5 * 1024 * 1024, 0x7f).toString('base64');
    const over5mb = Buffer.alloc(5 * 1024 * 1024 + 1, 0x7f).toString('base64');
    // 每张 ≤ 5MB 的 4 张图恰好 20MB；加 1 字节即超总量
    const totalOver = {
      a: exact5mb,
      b: exact5mb,
      c: exact5mb,
      d: exact5mb,
      e: Buffer.alloc(1, 1).toString('base64'),
    };
    const cases = [
      [{ logo: 'not base64!!' }, '字符非法（空格/!）'],
      [{ logo: 'abc' }, '长度非 4 倍数'],
      [{ logo: 'ab=c' }, '= 不在尾部'],
      [{ logo: '' }, '空字符串'],
      [{ logo: 123 }, '值非字符串'],
      [{ '': Buffer.alloc(4, 1).toString('base64') }, '空名称'],
      // JSON 侧注入 __proto__ 键（对象字面量无法构造 own property，经 JSON.parse 绕行）
      [JSON.parse('{"__proto__":"YQ=="}'), '__proto__ 名'],
      [{ logo: over5mb }, `单图超 5MB（解码 ${5 * 1024 * 1024 + 1}B）`],
      [totalOver, '总量超 20MB（20MB+1B）'],
      [['not-an-object'], '数组'],
      ['string', '字符串'],
    ];
    for (const [images, label] of cases) {
      const resp = await postJob(bridge.httpPort, token, { code: 'x', images });
      assert.equal(resp.status, 400, `case[${label}] 应 400，实际 ${resp.status}`);
      assert.equal(resp.json.error, 'invalid-images', `case[${label}] error 应为 invalid-images`);
      assert.equal(
        typeof resp.json.message === 'string' && resp.json.message.length > 0,
        true,
        `case[${label}] 应带非空 message`
      );
    }
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

test('M4：images 限额边界放行——单图恰好 5MB、总量恰好 20MB（4×5MB）→ 200 且 OP 原样透传', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;
    const exact5mb = Buffer.alloc(5 * 1024 * 1024, 0x7f).toString('base64');
    const pending = postJob(bridge.httpPort, token, {
      code: 'boundary',
      images: { a: exact5mb, b: exact5mb, c: exact5mb, d: exact5mb },
    });
    const op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'boundary', 'OP#boundary', 8000);
    assert.deepEqual(Object.keys(op.images).sort(), ['a', 'b', 'c', 'd']);
    assert.equal(op.images.a, exact5mb, '边界放行时 base64 应原样透传');
    plugin.send({ kind: 'RESULT', jobId: op.jobId, status: 'ok', message: '' });
    assert.equal((await pending).json.status, 'ok');
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

test('M4：RESULT.screenshotBase64 非 PNG 字节（text/plain）→ screenshotError=invalid-png、不写盘、Job 状态不受影响', async () => {
  const token = newToken();
  const bridge = await startBridge({ port: 0, token });
  const plugin = makeFakePlugin(bridge.httpPort, token);
  try {
    await plugin.opened;
    const textB64 = Buffer.from('plain text, definitely not a png', 'utf8').toString('base64');
    const pending = postJob(bridge.httpPort, token, {
      code: 'badpng',
      screenshot: { mode: 'node', nodeId: '1:1', scale: 1 },
    });
    const op = await plugin.waitFor((m) => m.kind === 'OP' && m.code === 'badpng', 'OP#badpng');
    plugin.send({
      kind: 'RESULT',
      jobId: op.jobId,
      status: 'ok',
      message: 'script-ok',
      screenshotBase64: textB64,
    });
    const resp = await pending;
    assert.equal(resp.json.status, 'ok', '非 PNG 截图不改写 Job 状态（M3 语义保持）');
    assert.equal(resp.json.message, 'script-ok');
    assert.equal(resp.json.screenshotError, 'invalid-png');
    assert.equal('screenshotPath' in resp.json, false, '非 PNG 不应写盘');
    assert.equal(
      fs.existsSync(path.join(SCREENSHOT_DIR, `job-${op.jobId}.png`)),
      false,
      'screenshots/job-<jobId>.png 不应存在'
    );
  } finally {
    await plugin.close();
    await bridge.close();
  }
});

// ---- 本机自动配对（GET /token 免鉴权 + GET /status 连接状态）----

test('自动配对：/token 免鉴权返回当前 token；/status 反映插件连接状态', async () => {
  const bridge = await startBridge({ port: 0, eventWindowMs: 50 });
  const base = `http://127.0.0.1:${bridge.httpPort}`;
  try {
    const r1 = await fetch(`${base}/token`);
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).token, bridge.token, '/token 返回值与启动 token 一致');

    const s1 = await (await fetch(`${base}/status`)).json();
    assert.equal(s1.ok, true);
    assert.equal(s1.pluginConnected, false, '无插件时 pluginConnected=false');

    const ws = new WebSocket(`ws://127.0.0.1:${bridge.httpPort}/?token=${encodeURIComponent(bridge.token)}`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('fake plugin connect failed'));
    });
    const s2 = await (await fetch(`${base}/status`)).json();
    assert.equal(s2.pluginConnected, true, '插件连接后 pluginConnected=true');
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const s3 = await (await fetch(`${base}/status`)).json();
    assert.equal(s3.pluginConnected, false, '插件断开后 pluginConnected=false');
  } finally {
    await bridge.close();
  }
});
