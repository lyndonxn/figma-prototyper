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
import path from 'node:path';
import process from 'node:process';

const PROG = 'node cli/figmapt.js';

const USAGE = `用法: ${PROG} run <scriptfile> [--node <id>|--rect x,y,w,h] [--scale N] [--image <path>|<name>=<path>]... [--timeout ms] [--token T] [--port P]

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

退出码: 0=ok（含截图路径）  1=脚本失败/超时  2=参数错误或连接/鉴权失败`;

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
  if (command !== 'run') {
    failUsage(command === undefined ? '缺少命令 run 与脚本文件' : `未知命令 "${command}"`);
  }
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
