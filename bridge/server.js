/**
 * figma-prototyper bridge — M2 本地 WebSocket 双工桥接
 *
 * 契约来源：spec/03-system-architecture.md「WS 消息协议（M2 定型）」「安全边界」「测试缝」、
 * spec/05-acceptance.md FUN-ACC-201~204、ADR-0001（WS 双工）、ADR-0003（Job 级看门狗）。
 *
 * 职责：
 * - 与插件 ui.html 保持一条 WS 长连接（仅绑 127.0.0.1，?token= 鉴权，以最新连接为准）；
 * - HTTP 同端口：GET /health（免鉴权）、POST /jobs（鉴权，Job 入队 + 长轮询至终态）、
 *   GET /events（鉴权，防抖合并后的事件环形缓冲，最近 100 条）；
 * - 四类消息 OP / RESULT / EVENT / CONTROL，均为 {v:1, kind, id, ts, ...}；
 * - Job 状态机 QUEUED → RUNNING → OK|FAILED（M2 协议无独立 CLAIM 消息，
 *   OP 下发即视为 CLAIMED+RUNNING）；RUNNING 超时看门狗 → FAILED(message 含
 *   'timeout')，迟到 RESULT 忽略并记日志；
 * - CONTROL pause：暂停期间不下发排队 Job（RUNNING 中的不打断）；resume 后按序 flush；
 * - EVENT 按 eventWindowMs 固定窗口把各 batch 拼接为一条，写环形缓冲 + stdout；
 * - M3 截图闭环：POST /jobs body 可选 screenshot {mode:'node'|'rect'|'page', nodeId?, rect?, scale?}，
 *   校验后（scale clamp 到 [0.1,4]，ADR-0002）随 OP 原样下发；RESULT 带 screenshotBase64 时
 *   解码写入 ../screenshots/job-<jobId>.png（目录不存在则创建；路径写死，不接受外部路径），
 *   Job 响应附 screenshotPath（绝对路径）；RESULT 带 screenshotError 或写文件失败时响应附
 *   screenshotError（不改写 Job 状态）。无 screenshot 字段时行为与 M2 完全一致；
 * - M4 图片下发：POST /jobs body 可选 images {<name>: base64}。校验（标准 padded base64、
 *   单图解码后 ≤ 5MB、总量 ≤ 20MB，违规 400 invalid-images）后随 OP **原样透传 base64**
 *   （桥接不转码，解码在插件 sandbox 侧做）；无 images 字段（或空对象）的 Job 与 M3 逐字节兼容；
 *   RESULT.screenshotBase64 存在时先做 PNG 形式校验（解码后前 8 字节必须为 PNG 签名），
 *   非 PNG 不写盘、响应附 screenshotError:'invalid-png'，Job 状态不受影响（M3 验收建议项）；
 * - 日志：stdout 简洁行（时间戳 + 事件），脚本最多回显前 80 字符；token 不落盘、不打日志。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const PROTOCOL_VERSION = 1;
const MAX_EVENT_BUFFER = 100;
const CODE_PREVIEW_MAX = 80;
// M4：body 上限从 5MB 提升到 32MiB——20MiB 总量的 images 经 base64 膨胀（×4/3）约 26.7MiB，
// 加 code/字段开销后 32MiB 有余量（单图 5MB / 总量 20MB 限额见下，按解码后字节计）。
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const SCREENSHOT_SCALE_MIN = 0.1;
const SCREENSHOT_SCALE_MAX = 4;
// M4：images 限额（ADR-0002 预算约束：字节按 base64 解码后计）
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;
// M4：标准 padded base64（CLI 侧 Buffer.toString('base64') 恒为 padded；空白字符一律拒绝）
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// M4：screenshotBase64 形式校验——PNG 签名 \x89PNG\r\n\x1a\n
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// M6a：RESULT.data（脚本返回值 JSON 序列化）上限——与 M4 图片总量同量级（20MB）
const DATA_MAX_BYTES = 20 * 1024 * 1024;
// 截图落盘目录：figma-prototyper/screenshots/（运行产物，gitignore；路径写死，不接受外部路径）
const SCREENSHOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'screenshots'
);
export { SCREENSHOT_DIR };

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function timestamp() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

/** 脚本不回显全文（防刷屏），最多前 80 字符 */
function previewCode(code) {
  const oneLine = String(code).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= CODE_PREVIEW_MAX) return oneLine;
  return `${oneLine.slice(0, CODE_PREVIEW_MAX)}…(len=${String(code).length})`;
}

function newId() {
  return crypto.randomUUID();
}

/** 常量时间比较，避免 token 比较侧信道 */
function safeEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * M3：校验并规范化截图参数（scale clamp 到 [0.1,4]，ADR-0002 预算约束）。
 * 返回规范化后的 spec；非法时抛错（由调用方回 400）。
 */
function normalizeScreenshot(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('screenshot must be an object');
  }
  const mode = spec.mode;
  if (mode !== 'node' && mode !== 'rect' && mode !== 'page') {
    throw new Error('screenshot.mode must be "node" | "rect" | "page"');
  }
  let scale = 1;
  if (spec.scale !== undefined) {
    if (typeof spec.scale !== 'number' || !Number.isFinite(spec.scale)) {
      throw new Error('screenshot.scale must be a finite number');
    }
    scale = Math.min(SCREENSHOT_SCALE_MAX, Math.max(SCREENSHOT_SCALE_MIN, spec.scale));
  }
  if (mode === 'node') {
    if (typeof spec.nodeId !== 'string' || spec.nodeId.length === 0) {
      throw new Error('screenshot.nodeId (string) required for mode=node');
    }
    return { mode, nodeId: spec.nodeId, scale };
  }
  if (mode === 'rect') {
    const r = spec.rect;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error('screenshot.rect required for mode=rect');
    }
    const { x, y, width, height } = r;
    if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error('screenshot.rect must have finite x/y/width/height');
    }
    return { mode, rect: { x, y, width, height }, scale };
  }
  return { mode, scale };
}

/** M3：解码 base64 并写入固定目录 screenshots/job-<jobId>.png；返回透传给 Job 响应的字段。 */
function writeScreenshotFile(jobId, base64) {
  const filePath = path.join(SCREENSHOT_DIR, `job-${jobId}.png`);
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { screenshotPath: filePath };
  } catch (err) {
    return {
      screenshotError: `screenshot write failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

/**
 * M4：screenshotBase64 形式校验——解码后前 8 字节必须为 PNG 签名
 * （Buffer.from 对非法字符静默跳过，因此只看字节前缀；非 PNG 由调用方拒绝写盘）。
 */
function looksLikePng(base64) {
  const buf = Buffer.from(base64, 'base64');
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * M4：校验并透传 images（{<name>: base64}）。违规抛错（由调用方回 400 invalid-images）：
 * - 非对象/数组 → 错；空对象视为未提供（返回 undefined，与 M3 无 images 兼容）；
 * - name 非法（空串/__proto__）→ 错；值非字符串/空串/非标准 padded base64 → 错；
 * - 单图解码后 > 5MB → 错；累计解码 > 20MB → 错（ADR-0002 预算约束）。
 * 校验通过后原样返回 base64 映射（桥接不转码，解码在插件 sandbox 侧）。
 */
function normalizeImages(images) {
  if (!images || typeof images !== 'object' || Array.isArray(images)) {
    throw new Error('images must be an object of {name: base64string}');
  }
  const names = Object.keys(images);
  if (names.length === 0) return undefined; // 空对象 = 未提供图片
  const out = {};
  let totalBytes = 0;
  for (const name of names) {
    if (name.length === 0 || name === '__proto__') {
      throw new Error(`images has invalid name: "${name}"`);
    }
    const value = images[name];
    if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !BASE64_RE.test(value)) {
      throw new Error(`images["${name}"] must be a non-empty standard base64 string`);
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 0) {
      throw new Error(`images["${name}"] decodes to zero bytes`);
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `images["${name}"] is ${bytes.length} bytes, exceeds per-image limit ${MAX_IMAGE_BYTES} (5MB)`
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_IMAGES_TOTAL_BYTES) {
      throw new Error(
        `images total ${totalBytes} bytes exceeds limit ${MAX_IMAGES_TOTAL_BYTES} (20MB)`
      );
    }
    out[name] = value; // 原样透传 base64（不转码）
  }
  return out;
}

/**
 * 启动桥接。返回 { httpPort, token, host, close() }；port: 0 由 OS 分配临时端口。
 * host 为实际绑定地址（恒为 '127.0.0.1'），供契约测试核对 FUN-ACC-201。
 */
export async function startBridge({
  port = 8787,
  token = crypto.randomBytes(16).toString('hex'),
  eventWindowMs = 1000,
  jobTimeoutMs = 30000,
} = {}) {
  const state = {
    plugin: null, // 当前插件 WS 连接（以最新连接为准）
    paused: false, // CONTROL/PAUSE 生效中
    jobs: new Map(), // jobId → job（插入序即 FIFO）
    eventBuffer: [], // 防抖合并后的事件环形缓冲（最近 100 条）
    eventWindow: null, // { batch, count, timer } 进行中的合并窗口
    closing: false,
  };
  let closePromise = null;

  const httpServer = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log(`HTTP 处理异常：${err && err.message ? err.message : String(err)}`);
      try {
        json(res, 500, { error: 'internal-error' });
      } catch {
        /* 响应可能已发出 */
      }
    });
  });

  // noServer：upgrade 由上方 httpServer 的 'upgrade' 事件接管（token 校验在此处做）
  const wss = new WebSocketServer({ noServer: true });

  function json(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    // CORS：插件面板 iframe（figma.com 源）需跨域读取本机端点（自动配对/状态自检）。
    // 服务仅绑 127.0.0.1，放行所有源不扩大网络暴露面。
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  }

  function isAuthorized(req, url) {
    const header = req.headers['x-bridge-token'];
    if (header && safeEquals(header, token)) return true;
    const q = url.searchParams.get('token');
    if (q && safeEquals(q, token)) return true;
    return false;
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');

    // CORS 预检（面板 fetch 跨域需要）
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-bridge-token',
      });
      return res.end();
    }

    // 免鉴权健康检查：不泄露任何信息
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }
    // 本机自动配对（安全决策记录于 HANDOFF）：桥接仅绑 127.0.0.1，此端点只有本机进程
    // 可达；供插件面板免手动粘贴自动连接。等效于"本机免鉴权"模式（用户 2026-09-19 选择便捷优先）。
    if (req.method === 'GET' && url.pathname === '/token') {
      return json(res, 200, { token: token });
    }
    // 状态查询（免鉴权）：供 Agent 客户端环境自检（判断桥接存活与插件是否上线）
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, {
        ok: true,
        pluginConnected: Boolean(state.plugin && state.plugin.readyState === WebSocket.OPEN),
        paused: Boolean(state.paused),
        closing: Boolean(state.closing),
      });
    }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      if (!isAuthorized(req, url)) return json(res, 401, { error: 'unauthorized' });
      return handleCreateJob(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      if (!isAuthorized(req, url)) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { events: state.eventBuffer });
    }
    return json(res, 404, { error: 'not-found' });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handleCreateJob(req, res) {
    if (state.closing) return json(res, 503, { error: 'bridge-closing' });

    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { error: 'invalid-json' });
    }
    if (typeof body.code !== 'string' || body.code.length === 0) {
      return json(res, 400, { error: 'code-required' });
    }
    let timeoutMs = jobTimeoutMs;
    if (body.timeoutMs !== undefined) {
      if (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0) {
        return json(res, 400, { error: 'invalid-timeoutMs' });
      }
      timeoutMs = body.timeoutMs;
    }
    // M3：可选 screenshot 参数（无该字段 → 与 M2 行为完全一致）
    let screenshot;
    if (body.screenshot !== undefined) {
      try {
        screenshot = normalizeScreenshot(body.screenshot);
      } catch (err) {
        return json(res, 400, { error: 'invalid-screenshot', message: err.message });
      }
    }
    // M4：可选 images 参数（校验限额后原样透传；无该字段/空对象 → 与 M3 行为完全一致）
    let images;
    if (body.images !== undefined) {
      try {
        images = normalizeImages(body.images);
      } catch (err) {
        return json(res, 400, { error: 'invalid-images', message: err.message });
      }
    }
    if (!state.plugin || state.plugin.readyState !== WebSocket.OPEN) {
      return json(res, 503, { error: 'no-plugin-connected' });
    }

    const job = {
      jobId: newId(),
      code: body.code,
      status: 'QUEUED',
      submittedAt: Date.now(),
      timeoutMs,
      screenshot, // undefined = 无截图参数
      images, // M4：undefined = 无图片参数（base64 映射，已校验）
      watchdog: null,
      waiters: [], // 长轮询 resolve 列表
    };
    state.jobs.set(job.jobId, job);
    log(`JOB ${job.jobId} QUEUED (code: ${previewCode(job.code)})`);

    dispatchPending();
    // 长轮询：挂起 HTTP 请求直到 Job 终态
    const result = await new Promise((resolve) => job.waiters.push(resolve));
    return json(res, 200, result);
  }

  function settle(job, result) {
    const waiters = job.waiters;
    job.waiters = [];
    for (const resolve of waiters) resolve(result);
  }

  function failJob(job, message, extras) {
    if (job.status === 'OK' || job.status === 'FAILED') return;
    if (job.watchdog) {
      clearTimeout(job.watchdog);
      job.watchdog = null;
    }
    job.status = 'FAILED';
    log(`JOB ${job.jobId} FAILED (${message})`);
    settle(job, {
      status: 'failed',
      jobId: job.jobId,
      message,
      elapsedMs: Date.now() - job.submittedAt,
      ...(extras || {}),
    });
  }

  function completeJob(job, message, extras) {
    if (job.status !== 'RUNNING') return false;
    if (job.watchdog) {
      clearTimeout(job.watchdog);
      job.watchdog = null;
    }
    job.status = 'OK';
    log(`JOB ${job.jobId} OK (${message === '' ? '(empty message)' : previewCode(message)})`);
    settle(job, {
      status: 'ok',
      jobId: job.jobId,
      message,
      elapsedMs: Date.now() - job.submittedAt,
      ...(extras || {}),
    });
    return true;
  }

  /** 下发所有排队 Job（按入队序）。暂停或无连接时不动作。 */
  function dispatchPending() {
    if (state.closing || state.paused) return;
    const plugin = state.plugin;
    if (!plugin || plugin.readyState !== WebSocket.OPEN) return;
    for (const job of state.jobs.values()) {
      if (job.status !== 'QUEUED') continue;
      startJob(job, plugin);
    }
  }

  function startJob(job, plugin) {
    job.status = 'RUNNING'; // OP 下发即视为领取+开始执行（M2 协议无独立 CLAIM 消息）
    job.watchdog = setTimeout(() => {
      if (job.status === 'RUNNING') {
        failJob(job, `timeout: no RESULT within ${job.timeoutMs}ms (jobId=${job.jobId})`);
      }
    }, job.timeoutMs);
    sendToPlugin(plugin, {
      kind: 'OP',
      jobId: job.jobId,
      code: job.code,
      // M3：screenshot 参数（已 clamp）随 OP 下发；无截图参数的 Job 不带该字段（M2 兼容）
      ...(job.screenshot !== undefined ? { screenshot: job.screenshot } : {}),
      // M4：images 参数（base64 映射，已校验）随 OP 原样透传；无图片的 Job 不带该字段（M3 兼容）
      ...(job.images !== undefined ? { images: job.images } : {}),
    });
    log(`JOB ${job.jobId} → RUNNING (OP 下发)`);
  }

  function sendToPlugin(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: newId(), ts: Date.now(), ...payload }));
    return true;
  }

  function broadcast(payload) {
    sendToPlugin(state.plugin, payload);
  }

  // ---- EVENT 防抖：固定窗口，窗口内各 batch 拼接为一条 ----

  function handleEvent(msg) {
    const batch = Array.isArray(msg.batch) ? msg.batch : [];
    if (!state.eventWindow) {
      state.eventWindow = {
        batch: [],
        count: 0,
        timer: setTimeout(flushEventWindow, eventWindowMs),
      };
    }
    state.eventWindow.batch.push(...batch);
    state.eventWindow.count += 1;
  }

  function flushEventWindow() {
    const win = state.eventWindow;
    state.eventWindow = null;
    if (!win) return;
    const event = {
      v: PROTOCOL_VERSION,
      kind: 'EVENT',
      id: newId(),
      ts: Date.now(),
      type: 'documentchange',
      batch: win.batch,
    };
    state.eventBuffer.push(event);
    if (state.eventBuffer.length > MAX_EVENT_BUFFER) state.eventBuffer.shift();
    log(`EVENT documentchange batch=${win.batch.length} (merged ${win.count} msgs)`);
  }

  // ---- CONTROL（双向）：pause / resume / shutdown ----

  function handleControl(action) {
    if (action === 'pause') {
      if (!state.paused) {
        state.paused = true;
        log('CONTROL pause：暂停下发新 OP（RUNNING 中的不打断）');
      }
      broadcast({ kind: 'CONTROL', action: 'pause' });
    } else if (action === 'resume') {
      if (state.paused) {
        state.paused = false;
        log('CONTROL resume：恢复下发，按序 flush 排队 Job');
      }
      broadcast({ kind: 'CONTROL', action: 'resume' });
      dispatchPending();
    } else if (action === 'shutdown') {
      log('CONTROL shutdown：开始关闭桥接');
      broadcast({ kind: 'CONTROL', action: 'shutdown' });
      closeBridge();
    } else {
      log(`CONTROL 未知 action=${String(action)}，已忽略`);
    }
  }

  // ---- 插件 WS 连接管理 ----

  function onPluginConnection(ws) {
    const previous = state.plugin;
    state.plugin = ws;
    if (previous && previous !== ws) {
      log('PLUGIN 新连接接入，替换并关闭旧连接');
      try {
        previous.close(4000, 'replaced');
      } catch {
        /* 旧连接可能已关闭 */
      }
    }
    log('PLUGIN connected');
    ws.on('message', (data) => onPluginMessage(ws, data));
    ws.on('close', () => onPluginClose(ws));
    ws.on('error', (err) => {
      log(`PLUGIN 连接错误：${err && err.message ? err.message : String(err)}`);
    });
    dispatchPending();
  }

  function onPluginMessage(ws, data) {
    if (ws !== state.plugin) return; // 非当前连接的消息一律忽略
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      log('PLUGIN 收到非 JSON 消息，已忽略');
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.kind === undefined) {
      log('PLUGIN 消息缺少 kind，已忽略');
      return;
    }
    if (msg.kind === 'RESULT') {
      const job = typeof msg.jobId === 'string' ? state.jobs.get(msg.jobId) : undefined;
      if (!job || job.status !== 'RUNNING') {
        log(`RESULT 迟到/未知 (jobId=${String(msg.jobId)})，已忽略`);
        return;
      }
      const message = typeof msg.message === 'string' ? msg.message : '';
      // M3：截图落盘与透传——不改写 Job 状态，只附加响应字段
      // M4：落盘前先做 PNG 形式校验（前 8 字节签名）；非 PNG 不写盘、附 screenshotError:'invalid-png'
      const extras = {};
      if (typeof msg.screenshotBase64 === 'string' && msg.screenshotBase64.length > 0) {
        if (!looksLikePng(msg.screenshotBase64)) {
          extras.screenshotError = 'invalid-png';
          log(`JOB ${job.jobId} 截图未落盘：screenshotBase64 非 PNG 字节（screenshotError=invalid-png）`);
        } else {
          Object.assign(extras, writeScreenshotFile(job.jobId, msg.screenshotBase64));
          if (extras.screenshotPath) {
            log(`JOB ${job.jobId} 截图已落盘: ${extras.screenshotPath}`);
          } else {
            log(`JOB ${job.jobId} 截图落盘失败: ${extras.screenshotError}`);
          }
        }
      }
      if (extras.screenshotError === undefined &&
          typeof msg.screenshotError === 'string' && msg.screenshotError.length > 0) {
        extras.screenshotError = msg.screenshotError;
      }
      if (msg.status === 'ok') {
        // M6a：RESULT.data 校验——仅当存在时检查（大小上限 20MB + JSON 可解析）；
        // 超限/非法 → 拒绝并置 FAILED（data 为 IR 主交付物，缺失即 Job 失败）。
        if (msg.data !== undefined && msg.data !== null) {
          if (typeof msg.data !== 'string' || Buffer.byteLength(msg.data, 'utf8') > DATA_MAX_BYTES) {
            failJob(
              job,
              `RESULT.data 超过 ${DATA_MAX_BYTES} 字节上限或非字符串，已拒绝（jobId=${job.jobId}）`,
              extras
            );
            return;
          }
          try {
            JSON.parse(msg.data);
          } catch (err) {
            failJob(job, `RESULT.data 非合法 JSON，已拒绝（jobId=${job.jobId}）`, extras);
            return;
          }
          extras.data = msg.data; // 随 HTTP 响应透传给 CLI
        }
        completeJob(job, message, extras);
      } else {
        failJob(job, message === '' ? 'plugin reported failure' : message, extras);
      }
      return;
    }
    if (msg.kind === 'EVENT') {
      handleEvent(msg);
      return;
    }
    if (msg.kind === 'CONTROL') {
      handleControl(msg.action);
      return;
    }
    log(`PLUGIN 未知消息 kind=${String(msg.kind)}，已忽略`);
  }

  function onPluginClose(ws) {
    if (state.plugin !== ws) return; // 被替换的旧连接关闭，忽略
    state.plugin = null;
    log('PLUGIN disconnected');
    if (state.closing) return;
    // 在途（含排队）Job 全部失败，让长轮询得到确定答复而非悬挂
    for (const job of state.jobs.values()) {
      if (job.status === 'QUEUED' || job.status === 'RUNNING') {
        failJob(job, 'connection lost (plugin disconnected)');
      }
    }
  }

  httpServer.on('upgrade', (req, socket, head) => {
    let given = null;
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      given = url.searchParams.get('token');
    } catch {
      given = null;
    }
    if (state.closing || !given || !safeEquals(given, token)) {
      log('WS 握手拒绝：token 缺失或错误 (close 4401)');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(4401, 'unauthorized');
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onPluginConnection(ws));
  });

  // ---- 生命周期 ----

  function closeBridge() {
    if (closePromise) return closePromise;
    state.closing = true;
    if (state.eventWindow) {
      clearTimeout(state.eventWindow.timer);
      state.eventWindow = null;
    }
    for (const job of state.jobs.values()) {
      if (job.status === 'QUEUED' || job.status === 'RUNNING') {
        failJob(job, 'bridge closed');
      }
    }
    closePromise = new Promise((resolve) => {
      let pending = 2;
      const done = () => {
        pending -= 1;
        if (pending === 0) resolve();
      };
      const plugin = state.plugin;
      state.plugin = null;
      if (plugin) {
        try {
          plugin.close(1001, 'bridge shutdown');
        } catch {
          /* 已关闭 */
        }
      }
      wss.close(done);
      httpServer.close(done);
      // 兜底：清掉 keep-alive 空闲连接（fetch 连接池），避免测试/CLI 进程悬挂；
      // 延迟触发，让已 resolve 的长轮询响应先完成写出。
      setTimeout(() => {
        try {
          httpServer.closeAllConnections();
        } catch {
          /* 服务器可能已关闭 */
        }
      }, 150);
    });
    return closePromise;
  }

  // ---- 监听（仅 127.0.0.1）----

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  httpServer.on('error', (err) => {
    log(`HTTP server error：${err && err.message ? err.message : String(err)}`);
  });

  const address = httpServer.address();
  const httpPort = address.port;
  const host = address.address; // 恒为 '127.0.0.1'
  log(`bridge listening on ${host}:${httpPort}`);

  return { httpPort, token, host, close: closeBridge };
}

// ---- CLI 入口（仅直接运行本文件时）----

function isCliEntry() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const eq = /^--([a-z-]+)=(.*)$/.exec(argv[i]);
    if (eq) { out[eq[1]] = eq[2]; continue; }
    const sp = /^--([a-z-]+)$/.exec(argv[i]);
    if (sp && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[sp[1]] = argv[++i];
      continue;
    }
    console.warn(`[bridge] 忽略无法识别的参数: ${argv[i]}`);
  }
  return out;
}

if (isCliEntry()) {
  const args = parseCliArgs(process.argv.slice(2));
  const port = args.port !== undefined ? Number(args.port) : 8787;
  const token = args.token || crypto.randomBytes(16).toString('hex');
  const eventWindowMs = args['event-window-ms'] !== undefined ? Number(args['event-window-ms']) : 1000;
  const jobTimeoutMs = args['job-timeout-ms'] !== undefined ? Number(args['job-timeout-ms']) : 30000;
  try {
    const bridge = await startBridge({ port, token, eventWindowMs, jobTimeoutMs });
    console.log(`TOKEN: ${token}`);
    console.log(`Bridge listening: ws://127.0.0.1:${bridge.httpPort} (HTTP 同端口：POST /jobs、GET /events、GET /health)`);
    console.log('插件连接：把上方 TOKEN 粘贴进面板 token 输入框后点击「连接」');
    const shutdown = async () => {
      await bridge.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(`bridge 启动失败: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  }
}
