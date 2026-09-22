#!/usr/bin/env node
/**
 * figmapt — M3 CLI：提交脚本 + 阻塞等待 Job 终态 + 输出截图路径；M4 扩展 --image 图片下发
 *
 * 契约来源：spec/03-system-architecture.md（Agent 循环、安全边界）、
 * spec/05-acceptance.md FUN-ACC-301~303 / FUN-ACC-401~404、
 * ADR-0002（截图必须区域化 + scale 参数化；images 限额由桥接侧强制）。
 *
 * 用法：
 *   node cli/figmapt.js run <scriptfile> [--node <id>|--rect x,y,w,h] [--scale N]
 *        [--image <path>]... [--image <name>=<path>]...
 *        [--timeout ms] [--token T] [--port P]
 *
 * - token：--token > 环境变量 FIGMA_BRIDGE_TOKEN；port：--port > FIGMA_BRIDGE_PORT > 8787。
 * - 不带 --node/--rect 时不发 screenshot 字段（与 M2 行为一致）；本 CLI 不提供 page 模式
 *   （ADR-0002：整页导出仅为显式预算警告路径，不做成常规入口）。
 * - --scale 原样上报，由桥接 clamp 到 [0.1, 4]。
 * - --image（M4，可重复）：读取本地文件 → base64 随 Job 下发，脚本内经
 *   figma.createImage(images.<name>) 使用。缺省 name = 文件名去扩展名；
 *   <name>=<path> 显式命名。单图 > 5MB / 总量 > 20MB 由桥接拒绝（400 invalid-images）。
 *
 * 退出码语义：
 *   0 = Job ok（stdout：OK <jobId> / Message / Screenshot? / ScreenshotError?）
 *   1 = Job failed 或超时（stderr：FAILED: <原错误>）
 *   2 = 参数错误（stderr：用法）或传输/鉴权层错误（stderr：ERROR: <...>）
 *
 * Node ≥ 24，ESM，零依赖（fetch/fs 均为全局/内置）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const PROG = 'node cli/figmapt.js';

const USAGE = `用法: ${PROG} run <scriptfile> [--node <id>|--rect x,y,w,h] [--scale N] [--image <path>|<name>=<path>]... [--timeout ms] [--token T] [--port P]
        ${PROG} shot <htmlfile> [--out <png>] [--w N] [--h N] [--chrome <exe>] [--timeout ms]

run — 提交脚本给 Figma 插件执行（参数见下）：
shot — 用系统 Chrome headless 对本地 HTML 截图（Design→Code 闭环对比，FUN-ACC-604）：
  <htmlfile>      要截图的本地 HTML 文件（必须存在）
  --out <png>     输出 PNG 路径（缺省 = 输入同目录 <文件名>.png）
  --w N / --h N  视口宽/高（缺省 1280 / 800）
  --chrome <exe> Chrome/Chromium 可执行文件（缺省按 --chrome>FIGMAPT_CHROME>系统路径 顺序定位）
  --timeout ms   shot 截图超时毫秒数（缺省 30000）；成功判据为截图文件落盘稳定，
                 不依赖 Chrome 进程退出（真 Chrome headless=new 写完截图可能不退出）

参数:
  <scriptfile>     要执行的脚本文件路径（内容作为 code 提交，sandbox 内以 AsyncFunction 执行）
  --node <id>      截图模式 node：按节点 ID 导出 PNG（与 --rect 互斥）
  --rect x,y,w,h   截图模式 rect：按页面绝对坐标区域导出 PNG（与 --node 互斥）
  --scale N        导出倍数，默认 1；原样上报，桥接 clamp 到 [0.1, 4]（须与 --node/--rect 同用）
  --image <path>   下发本地图片为图片填充素材（可重复）；缺省名 = 文件名去扩展名，
                   <name>=<path> 显式命名；脚本内 figma.createImage(images.<name>) 使用；
                   限额：单图 ≤ 5MB、总量 ≤ 20MB（桥接侧强制，超限 400 invalid-images）
  --ir-out <dir>   M6a：Job ok 且响应含 IR data 时，将 design-ir.json 与 assets/<name>.png
                   落盘至该目录（图片资产由 base64 解码写入）；无 data 时明确报错（exit 2）
  --timeout ms     Job 超时毫秒数（缺省由桥接决定，默认 30000）
  --token T        桥接 token（缺省读环境变量 FIGMA_BRIDGE_TOKEN）
  --port P         桥接端口（缺省读 FIGMA_BRIDGE_PORT，再缺省 8787）

退出码(run): 0=ok（含截图路径）  1=脚本失败/超时  2=参数错误或连接/鉴权失败
退出码(shot): 0=截图成功  1=Chrome 执行失败（stderr 透传）  2=参数错误或找不到 Chrome（含降级提示）`;

function failUsage(message) {
  console.error(`参数错误: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function failError(message) {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

/**
 * 解析 --key value 与 --key=value 两种形式；非 -- 开头者归入 positional。
 * 同一 key 重复出现时聚合为数组（--image 依赖此行为；其余 key 重复由
 * single() 报参数错误——M3 单值语义不静默取后者）。
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const store = (key, value) => {
    if (flags[key] === undefined) flags[key] = value;
    else if (Array.isArray(flags[key])) flags[key].push(value);
    else flags[key] = [flags[key], value];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        store(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          store(key, next);
          i++;
        } else {
          store(key, '');
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** 单值 flag 取用：被重复传入（数组）时报参数错误，保持显式失败而非静默取值 */
function single(flags, key) {
  const v = flags[key];
  if (Array.isArray(v)) failUsage(`--${key} 只能出现一次`);
  return v;
}

/** 解析 x,y,w,h → {x,y,width,height}；非法返回 null */
function parseRect(s) {
  const parts = String(s).split(',').map((p) => p.trim());
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (!nums.every((n) => Number.isFinite(n))) return null;
  const [x, y, width, height] = nums;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function buildScreenshot(flags) {
  const nodeFlag = single(flags, 'node');
  const rectFlag = single(flags, 'rect');
  const scaleFlag = single(flags, 'scale');
  const hasNode = nodeFlag !== undefined;
  const hasRect = rectFlag !== undefined;
  if (hasNode && hasRect) {
    failUsage('--node 与 --rect 互斥，只能选择一种截图模式');
  }
  if (!hasNode && !hasRect) {
    if (scaleFlag !== undefined) {
      failUsage('--scale 须与 --node 或 --rect 同用（不带截图参数时无需倍数）');
    }
    return undefined; // 无截图参数：与 M2 行为一致
  }
  let scale;
  if (scaleFlag !== undefined) {
    scale = Number(scaleFlag);
    if (!Number.isFinite(scale)) failUsage(`--scale 须为数字，收到: "${scaleFlag}"`);
  }
  if (hasNode) {
    const nodeId = nodeFlag;
    if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
      failUsage('--node 须为非空节点 ID，如 --node 11:6');
    }
    return { mode: 'node', nodeId: nodeId.trim(), ...(scale !== undefined ? { scale } : {}) };
  }
  const rect = parseRect(rectFlag);
  if (!rect) {
    failUsage(`--rect 格式须为 x,y,w,h（数字、w/h>0），收到: "${rectFlag}"`);
  }
  return { mode: 'rect', rect, ...(scale !== undefined ? { scale } : {}) };
}

/** 取路径的文件名（兼容 / 与 \ 分隔） */
function baseName(p) {
  const parts = String(p).split(/[/\\]/);
  return parts[parts.length - 1];
}

/**
 * M4：构建 images 载荷（{<name>: base64}）。
 * rawImage 为 undefined（未传）→ undefined（body 不带 images，与 M3 逐字节兼容）；
 * 可为单串或数组（--image 可重复）：<path>（缺省名 = 文件名去扩展名）或 <name>=<path>。
 * 读文件失败 / 名称重复 / 名称或路径为空 → 参数错误（exit 2）。
 */
function buildImages(rawImage) {
  if (rawImage === undefined) return undefined;
  const entries = Array.isArray(rawImage) ? rawImage : [rawImage];
  const images = {};
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) {
      failUsage('--image 须为 <路径> 或 <名称>=<路径>');
    }
    let name;
    let file;
    const eq = entry.indexOf('=');
    if (eq === 0) {
      failUsage(`--image 名称不能为空: "${entry}"（用 <名称>=<路径> 显式命名）`);
    } else if (eq > 0) {
      name = entry.slice(0, eq).trim();
      file = entry.slice(eq + 1);
    } else {
      file = entry;
      const base = baseName(file);
      const dot = base.lastIndexOf('.');
      name = dot > 0 ? base.slice(0, dot) : base;
    }
    if (!name) {
      failUsage(`--image 缺少有效名称: "${entry}"（用 <名称>=<路径> 显式命名）`);
    }
    if (Object.prototype.hasOwnProperty.call(images, name)) {
      failUsage(`--image 名称重复: "${name}"（用 <名称>=<路径> 区分多图）`);
    }
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch (err) {
      failUsage(
        `无法读取图片文件 "${file}": ${err && err.code ? err.code : err && err.message ? err.message : String(err)}`
      );
    }
    if (bytes.length === 0) {
      failUsage(`图片文件为空: "${file}"`);
    }
    images[name] = bytes.toString('base64');
  }
  return images;
}

/**
 * M6a：IR 产物落盘（--ir-out）。
 * data.data 为脚本返回 {ir, assets:{<name>:base64}} 的 JSON 序列化。
 * 写入 <dir>/design-ir.json（ir 部分）+ <dir>/assets/<name>.png（base64 解码落盘）。
 * 资产名按节点 id 命名；仅允许 [A-Za-z0-9_.:-]，防路径注入。
 * 返回写入的产物路径清单（含 design-ir.json 与每个 asset 绝对路径）。
 */
const IR_ASSET_NAME_RE = /^[A-Za-z0-9_.:-]+$/;

function writeIrOut(dir, dataString) {
  let parsed;
  try {
    parsed = JSON.parse(dataString);
  } catch (err) {
    failUsage(`IR data 非合法 JSON：${err && err.message ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed === null) {
    failUsage('IR data 须为对象 {ir, assets}');
  }
  const ir = parsed.ir;
  const assets = parsed.assets;

  const outDir = path.resolve(dir);
  fs.mkdirSync(outDir, { recursive: true });

  const irPath = path.join(outDir, 'design-ir.json');
  // ir 部分：缺省写为空 IR 骨架（保证 design-ir.json 永远可解析）
  const irDoc = ir && typeof ir === 'object' ? ir : { v: 1, kind: 'design-ir', root: null, truncated: false };
  fs.writeFileSync(irPath, JSON.stringify(irDoc, null, 2));

  const written = [irPath];
  const assetsDir = path.join(outDir, 'assets');
  if (assets && typeof assets === 'object' && !Array.isArray(assets)) {
    fs.mkdirSync(assetsDir, { recursive: true });
    const names = Object.keys(assets);
    for (const name of names) {
      if (typeof name !== 'string' || !IR_ASSET_NAME_RE.test(name)) {
        failUsage(`非法的资产文件名 "${String(name)}"（仅允许 [A-Za-z0-9_.:-]）`);
      }
      const b64 = assets[name];
      if (typeof b64 !== 'string' || b64.length === 0) continue;
      const assetPath = path.join(assetsDir, name + '.png');
      // 防注入：解析后必须落在 assetsDir 内
      if (path.resolve(assetPath).startsWith(assetsDir + path.sep)) {
        fs.writeFileSync(assetPath, Buffer.from(b64, 'base64'));
        written.push(assetPath);
      }
    }
  }
  return written;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  const command = positional[0];
  if (command === 'run') {
    return runCommand(positional, flags);
  }
  if (command === 'shot') {
    return shotCommand(positional, flags);
  }
  failUsage(command === undefined ? '缺少命令 run 或 shot' : `未知命令 "${command}"`);
}

/** 解析 --w/--h 为正整数；非数字或缺省用 fallback；非法 → 参数错误 exit 2 */
function parseDim(raw, fallback, label) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    failUsage(`--${label} 须为正整数（像素），收到: "${raw}"`);
  }
  return n;
}

/**
 * M6b：定位系统 Chrome/Chromium 可执行文件。
 * 顺序：--chrome 参数 > 环境变量 FIGMAPT_CHROME > 系统常见路径（macOS/常见 Linux 发行路径）。
 * 返回第一个存在的可执行文件路径；全部缺失返回 null（调用方据此 exit 2 + 降级提示）。
 */
const COMMON_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

function resolveChrome(flags) {
  const chromeFlag = single(flags, 'chrome');
  // 显式 --chrome 优先且为唯一候选：用户明确指定了可执行文件，缺失即"找不到 Chrome"（exit 2）。
  // 未指定时再回退到环境变量 FIGMAPT_CHROME → 系统常见路径。
  const candidates = [];
  if (chromeFlag !== undefined && chromeFlag !== '') {
    candidates.push(chromeFlag);
  } else {
    const envChrome = process.env.FIGMAPT_CHROME;
    if (envChrome && envChrome.length > 0) candidates.push(envChrome);
    for (const p of COMMON_CHROME_PATHS) candidates.push(p);
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* 路径不可访问：跳过，继续候选 */
    }
  }
  return null;
}

/** 找不到 Chrome：退出码 2 + 明确降级提示（含手动打开页面截图替代方案） */
function failChromeMissing(w, h, outName) {
  console.error('错误: 找不到可用的 Chrome / Chromium 可执行文件，无法截图。');
  console.error('定位顺序：--chrome 参数 > 环境变量 FIGMAPT_CHROME > 系统常见路径');
  console.error('  （macOS: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome 等；');
  console.error('   Linux: /usr/bin/google-chrome / /usr/bin/chromium 等）。');
  console.error(`降级方案：手动打开页面截图——用浏览器打开 HTML 页面，按视口 ${w}x${h} 截图并保存为 ${outName}。`);
  process.exit(2);
}

/**
 * M6b：shot 子命令——用系统 Chrome headless 对本地 HTML 截图。
 * 包装：chrome --headless=new --screenshot=<abs out> --window-size=W,H --user-data-dir=<tmp> file://<abs html>
 * 退出码：0=成功截图 / 1=Chrome 执行失败（stderr 透传）/ 2=参数错误或找不到 Chrome。
 */
async function shotCommand(positional, flags) {
  const htmlFile = positional[1];
  if (htmlFile === undefined) failUsage('缺少 HTML 文件路径');
  if (positional.length > 2) failUsage(`多余的位置参数: ${positional.slice(2).join(' ')}`);

  const absHtml = path.resolve(htmlFile);
  if (!fs.existsSync(absHtml) || !fs.statSync(absHtml).isFile()) {
    failUsage(`HTML 文件不存在或不是普通文件: "${htmlFile}"`);
  }

  const w = parseDim(single(flags, 'w'), 1280, 'w');
  const h = parseDim(single(flags, 'h'), 800, 'h');

  const outFlag = single(flags, 'out');
  let outPath;
  if (outFlag !== undefined && outFlag !== '') {
    outPath = path.resolve(outFlag);
  } else {
    const parsed = path.parse(absHtml);
    outPath = path.join(parsed.dir, parsed.name + '.png');
  }

  const chrome = resolveChrome(flags);
  if (!chrome) {
    failChromeMissing(w, h, path.basename(outPath));
  }

  // 确保输出目录存在
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // 临时 user-data-dir：避免污染用户 profile；用后清理
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-chrome-'));
  const args = [
    '--headless=new',
    `--screenshot=${outPath}`,
    `--window-size=${w},${h}`,
    `--user-data-dir=${tmpDir}`,
    `file://${absHtml}`,
  ];

  // 超时：默认 30s，可 --timeout 毫秒覆盖
  const timeoutFlag = single(flags, 'timeout');
  let timeoutMs = 30000;
  if (timeoutFlag !== undefined && timeoutFlag !== '') {
    timeoutMs = Number(timeoutFlag);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) failUsage(`--timeout 须为正整数毫秒，收到: "${timeoutFlag}"`);
  }

  await new Promise((resolve) => {
    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    let finished = false;
    const cleanupTmp = () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不阻断主流程 */
      }
    };
    const finish = (fn) => {
      if (finished) return;
      finished = true;
      clearInterval(pollTimer);
      clearTimeout(killTimer);
      fn();
    };
    const killChild = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 进程已退出则忽略 */
      }
    };

    // 真 Chrome（--headless=new）写完截图后进程可能不退出（后台服务常驻），
    // 因此以"截图文件落盘稳定"为成功判据：连续 STABLE_CHECKS 次轮询大小不变即成功并杀掉 Chrome。
    const POLL_MS = 100;
    const STABLE_CHECKS = 3;
    let lastSize = -1;
    let stableCount = 0;
    const pollTimer = setInterval(() => {
      let size = -1;
      try {
        if (fs.existsSync(outPath)) size = fs.statSync(outPath).size;
      } catch {
        /* 读取失败视为未落盘 */
      }
      if (size > 0 && size === lastSize) {
        stableCount += 1;
      } else {
        stableCount = 0;
      }
      lastSize = size;
      if (stableCount >= STABLE_CHECKS) {
        killChild();
        finish(() => {
          cleanupTmp();
          console.log(`Screenshot: ${outPath}`);
          process.exit(0);
        });
      }
    }, POLL_MS);

    const killTimer = setTimeout(() => {
      killChild();
      finish(() => {
        cleanupTmp();
        console.error(`Chrome 截图超时（${timeoutMs}ms 内未产出稳定截图文件）。`);
        console.error('可尝试增大 --timeout 或手动打开页面截图（见 shot 用法）。');
        process.exit(1);
      });
    }, timeoutMs);

    child.on('error', (err) => {
      finish(() => {
        cleanupTmp();
        console.error(`Chrome 执行失败: ${err && err.message ? err.message : String(err)}`);
        process.exit(1);
      });
    });
    child.on('close', (code) => {
      finish(() => {
        cleanupTmp();
        // Chrome 自行退出（旧版行为或被外部终止）：以文件是否产出为成功判据
        let ok = false;
        try {
          ok = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
        } catch {
          ok = false;
        }
        if (ok) {
          console.log(`Screenshot: ${outPath}`);
          process.exit(0);
        }
        if (code === 0) {
          console.error('Chrome 正常退出但未产出截图文件。');
          process.exit(1);
        }
        console.error(`Chrome 执行失败（exit ${code}）:`);
        if (stderr.trim()) console.error(stderr.trim());
        if (stdout.trim()) console.error(stdout.trim());
        process.exit(1);
      });
    });
  });
}

/** M3~M6a：run 子命令（原 main 主体） */
async function runCommand(positional, flags) {
  const scriptFile = positional[1];
  if (scriptFile === undefined) failUsage('缺少脚本文件路径');
  if (positional.length > 2) failUsage(`多余的位置参数: ${positional.slice(2).join(' ')}`);

  let code;
  try {
    code = fs.readFileSync(scriptFile, 'utf8');
  } catch (err) {
    failUsage(`无法读取脚本文件 "${scriptFile}": ${err && err.message ? err.message : String(err)}`);
  }

  // token：--token > FIGMA_BRIDGE_TOKEN；port：--port > FIGMA_BRIDGE_PORT > 8787
  const tokenFlag = single(flags, 'token');
  const token = tokenFlag !== undefined && tokenFlag !== '' ? tokenFlag : process.env.FIGMA_BRIDGE_TOKEN;
  if (!token) {
    failUsage('缺少桥接 token（用 --token 或环境变量 FIGMA_BRIDGE_TOKEN）');
  }
  const portFlag = single(flags, 'port');
  const portRaw = portFlag !== undefined && portFlag !== '' ? portFlag : process.env.FIGMA_BRIDGE_PORT;
  const port = portRaw !== undefined ? Number(portRaw) : 8787;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    failUsage(`--port 须为 1-65535 的整数，收到: "${portRaw}"`);
  }

  let timeoutMs;
  const timeoutFlag = single(flags, 'timeout');
  if (timeoutFlag !== undefined) {
    timeoutMs = Number(timeoutFlag);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      failUsage(`--timeout 须为正数（毫秒），收到: "${timeoutFlag}"`);
    }
  }

  const screenshot = buildScreenshot(flags);
  const images = buildImages(flags.image); // M4：--image 可重复，保持数组形态

  // M6a：--ir-out（落盘目录；缺省未提供 = 不落盘 IR）
  const irOut = single(flags, 'ir-out');
  if (irOut !== undefined && (typeof irOut !== 'string' || irOut.length === 0)) {
    failUsage('--ir-out 须为非空目录路径');
  }

  const body = {
    code,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(screenshot !== undefined ? { screenshot } : {}),
    ...(images !== undefined ? { images } : {}),
  };

  // 提交并阻塞长轮询至 Job 终态（桥接侧看门狗保证超时必有答复）
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': token },
      body: JSON.stringify(body),
    });
  } catch (err) {
    failError(`无法连接桥接 127.0.0.1:${port}（${err && err.cause && err.cause.code ? err.cause.code : err && err.message ? err.message : String(err)}）`);
  }

  if (res.status !== 200) {
    let detail = '';
    try {
      const errBody = await res.json();
      detail = errBody && errBody.error ? errBody.error : JSON.stringify(errBody);
    } catch {
      detail = '';
    }
    failError(`桥接返回 HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    failError('桥接响应不是合法 JSON');
  }

  if (data.status === 'ok') {
    console.log(`OK ${data.jobId}`);
    console.log(`Message: ${typeof data.message === 'string' ? data.message : ''}`);
    if (typeof data.screenshotPath === 'string' && data.screenshotPath.length > 0) {
      console.log(`Screenshot: ${data.screenshotPath}`);
    }
    if (typeof data.screenshotError === 'string' && data.screenshotError.length > 0) {
      console.log(`ScreenshotError: ${data.screenshotError}`);
    }
    // M6a：IR 落盘（--ir-out 且响应含 data）
    if (irOut !== undefined) {
      if (typeof data.data !== 'string' || data.data.length === 0) {
        failUsage('Job ok 但响应不含 IR data（脚本未 return {ir, assets}，或 data 被桥接拒绝）');
      }
      const written = writeIrOut(irOut, data.data);
      console.log('IR-Out:');
      for (const p of written) console.log(`  ${p}`);
    }
    process.exit(0);
  }
  if (data.status === 'failed') {
    console.error(`FAILED: ${typeof data.message === 'string' ? data.message : JSON.stringify(data)}`);
    process.exit(1);
  }
  failError(`未知的 Job 终态: ${JSON.stringify(data)}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(2);
});
