/**
 * M6b CLI `shot` 子命令契约测试（node:test，不依赖真机装 Chrome）
 *
 * 用桩可执行文件伪造 Chrome 行为（sh/node 脚本，校验参数、吐假 PNG 字节、或按场景 exit 非 0）：
 *   - 成功路径：stub 收到 --screenshot=<path> 后写入确定性假 PNG，exit 0 → 验证 PNG 落盘且字节一致、临时 user-data-dir 已清理。
 *   - Chrome 执行失败：STUB_CHROME_MODE=fail → stub 往 stderr 写错误并 exit 7 → 验证 CLI exit 1 + stderr 透传。
 *   - 找不到 Chrome：--chrome 指向不存在的路径 → resolveChrome 返回 null → CLI exit 2 + 降级提示文案。
 *   - HTML 文件不存在：CLI exit 2 + 用法提示。
 *   - 真 Chrome 冒烟：仅当系统存在 Chrome（--chrome/FIGMAPT_CHROME/常见路径之一）时运行；否则 skip（不硬依赖真机）。
 *
 * 运行：cd figma-prototyper/cli && node --test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../figmapt.js', import.meta.url));

// 确定性假 PNG 字节（含合法 PNG 8 字节签名 + 固定尾部），用于校验落盘字节一致
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('STUBFAKEPNG-0123456789-figmapt-shot-test'),
]);

/**
 * 生成桩 Chrome（node 脚本，带 shebang 且可执行）。
 * 行为由环境变量 STUB_CHROME_MODE 控制：ok（默认，写假 PNG）/ fail（写 stderr 并 exit 7）
 * / hang（写假 PNG 后挂起不退出，复现真 Chrome headless=new 行为）/ idle（什么都不做，挂起）。
 * 桩只解析 --screenshot=<out> 把假 PNG 写到该路径，其余参数忽略校验。
 */
function makeStubChrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-stub-chrome-'));
  const stub = path.join(dir, 'stub-chrome.mjs');
  const body = [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "let out = '';",
    "for (const a of args) { if (a.startsWith('--screenshot=')) out = a.slice('--screenshot='.length); }",
    "const mode = process.env.STUB_CHROME_MODE || 'ok';",
    "if (mode === 'fail') { process.stderr.write('headless-chrome: renderer process exited unexpectedly (stub simulation)\\n'); process.exit(7); }",
    `const FAKE = Buffer.from(${JSON.stringify(Array.from(FAKE_PNG))});`,
    "if (!out) { process.stderr.write('stub: missing --screenshot\\n'); process.exit(7); }",
    "if (mode === 'idle') { setInterval(() => {}, 1000); }",
    "else { writeFileSync(out, FAKE); if (mode === 'hang') { setInterval(() => {}, 1000); } else { process.exit(0); } }",
    '',
  ].join('\n');
  fs.writeFileSync(stub, body, { mode: 0o755 });
  return { stub, dir };
}

/** 运行 CLI 子进程；默认剥掉 FIGMA_BRIDGE_TOKEN/PORT/FIGMAPT_CHROME，避免外泄环境干扰 */
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

/** 统计 tmpdir 下残留的 figmapt-chrome- 临时目录（用于校验清理） */
function countChromeTmpDirs() {
  const tmp = os.tmpdir();
  let n = 0;
  try {
    for (const e of fs.readdirSync(tmp)) {
      if (e.startsWith('figmapt-chrome-')) n++;
    }
  } catch {
    /* 忽略 */
  }
  return n;
}

test('FUN-ACC-604 shot 成功路径：stub Chrome 写假 PNG → CLI exit 0，PNG 落盘且字节与预期一致，临时 user-data-dir 已清理', async () => {
  const { stub, dir } = makeStubChrome();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-shot-ok-'));
  const html = path.join(work, 'page.html');
  const out = path.join(work, 'page.png');
  fs.writeFileSync(html, '<!doctype html><html><body>hi</body></html>');
  const before = countChromeTmpDirs();
  try {
    const child = await runCli(['shot', html, '--chrome', stub, '--out', out, '--w', '1280', '--h', '800']);
    assert.equal(child.code, 0, `exit 0 预期，实际 ${child.code}，stderr=${child.stderr}`);
    assert.ok(child.stdout.includes(`Screenshot: ${out}`), `stdout 应含 Screenshot 路径，实际：${child.stdout}`);
    assert.ok(fs.existsSync(out), 'PNG 应已落盘');
    assert.deepEqual(fs.readFileSync(out), FAKE_PNG, '落盘 PNG 字节应与 stub 写入的假 PNG 一致');
    assert.equal(countChromeTmpDirs(), before, '临时 user-data-dir 应被清理（无残留 figmapt-chrome-）');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FUN-ACC-604 shot 缺省 --out：输出文件名 = 输入同名 .png（同目录）', async () => {
  const { stub, dir } = makeStubChrome();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-shot-default-'));
  const html = path.join(work, 'index.html');
  const out = path.join(work, 'index.png');
  fs.writeFileSync(html, '<!doctype html><html><body>x</body></html>');
  try {
    const child = await runCli(['shot', html, '--chrome', stub]);
    assert.equal(child.code, 0, `exit 0 预期，stderr=${child.stderr}`);
    assert.ok(fs.existsSync(out), `缺省输出 ${out} 应已落盘`);
    assert.deepEqual(fs.readFileSync(out), FAKE_PNG, '缺省输出字节应一致');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FUN-ACC-604 shot Chrome 执行失败：stub exit 7 + stderr → CLI exit 1 且透传 stderr 原文', async () => {
  const { stub, dir } = makeStubChrome();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-shot-fail-'));
  const html = path.join(work, 'page.html');
  const out = path.join(work, 'page.png');
  fs.writeFileSync(html, '<!doctype html><html><body>hi</body></html>');
  try {
    const child = await runCli(['shot', html, '--chrome', stub, '--out', out], { STUB_CHROME_MODE: 'fail' });
    assert.equal(child.code, 1, `exit 1 预期，实际 ${child.code}，stdout=${child.stdout}`);
    assert.ok(child.stderr.includes('headless-chrome: renderer process exited unexpectedly'), `stderr 应透传 stub 原文，实际：${child.stderr}`);
    assert.equal(fs.existsSync(out), false, '执行失败时不应产出 PNG');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FUN-ACC-604 shot 找不到 Chrome：--chrome 指向不存在路径 → resolveChrome 返回 null → CLI exit 2 + 降级提示（含"手动打开页面截图"）', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-shot-missing-'));
  const html = path.join(work, 'page.html');
  fs.writeFileSync(html, '<!doctype html><html><body>hi</body></html>');
  try {
    const child = await runCli(['shot', html, '--chrome', '/nonexistent/chrome-bin/that/does/not/exist']);
    assert.equal(child.code, 2, `exit 2 预期，实际 ${child.code}，stdout=${child.stdout}`);
    assert.ok(/找不到.*Chrome|降级方案/.test(child.stderr), `stderr 应含找不到 Chrome 的降级提示，实际：${child.stderr}`);
    assert.ok(child.stderr.includes('手动打开页面截图'), `降级提示应含"手动打开页面截图"，实际：${child.stderr}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('FUN-ACC-604 shot HTML 文件不存在：CLI exit 2 + 用法提示（不启动 Chrome）', async () => {
  const { stub, dir } = makeStubChrome();
  try {
    const child = await runCli(['shot', '/nonexistent/page.html', '--chrome', stub]);
    assert.equal(child.code, 2, `exit 2 预期，实际 ${child.code}`);
    assert.ok(child.stderr.includes('用法:'), `stderr 应含用法提示，实际：${child.stderr}`);
    assert.ok(child.stderr.includes('不存在'), `stderr 应说明文件不存在，实际：${child.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FUN-ACC-604 shot 参数错误（--w 非数字 / 缺 HTML）：exit 2 + 用法提示', async () => {
  const { stub, dir } = makeStubChrome();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-shot-badargs-'));
  const html = path.join(work, 'page.html');
  fs.writeFileSync(html, '<html></html>');
  try {
    const badW = await runCli(['shot', html, '--chrome', stub, '--w', 'big']);
    assert.equal(badW.code, 2, `非数字 --w 应 exit 2，实际 ${badW.code}`);
    assert.ok(badW.stderr.includes('用法:'), badW.stderr);

    const noHtml = await runCli(['shot', '--chrome', stub]);
    assert.equal(noHtml.code, 2, `缺 HTML 应 exit 2，实际 ${noHtml.code}`);
    assert.ok(noHtml.stderr.includes('用法:'), noHtml.stderr);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FUN-ACC-604 shot Chrome 不退出（真机行为回归）：stub 写完 PNG 后挂起 → CLI 以文件落盘稳定为判据 exit 0，并终止挂起进程', async () => {
  const { stub, dir } = makeStubChrome();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-shot-hang-'));
  const html = path.join(work, 'page.html');
  const out = path.join(work, 'page.png');
  fs.writeFileSync(html, '<!doctype html><html><body>hi</body></html>');
  try {
    const started = Date.now();
    const child = await runCli(['shot', html, '--chrome', stub, '--out', out], { STUB_CHROME_MODE: 'hang' });
    assert.equal(child.code, 0, `exit 0 预期（不应挂起等待进程退出），stderr=${child.stderr}`);
    assert.ok(child.stdout.includes(`Screenshot: ${out}`), `stdout 应含 Screenshot 路径，实际：${child.stdout}`);
    assert.deepEqual(fs.readFileSync(out), FAKE_PNG, '落盘 PNG 字节应一致');
    assert.ok(Date.now() - started < 15000, `应在稳定检测后及时返回（实际 ${Date.now() - started}ms）`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FUN-ACC-604 shot 超时兜底：stub 既不写文件也不退出 + --timeout 短超时 → CLI exit 1 + 超时提示', async () => {
  const { stub, dir } = makeStubChrome();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-shot-timeout-'));
  const html = path.join(work, 'page.html');
  fs.writeFileSync(html, '<!doctype html><html><body>hi</body></html>');
  try {
    const child = await runCli(
      ['shot', html, '--chrome', stub, '--out', path.join(work, 'x.png'), '--timeout', '800'],
      { STUB_CHROME_MODE: 'idle' }
    );
    assert.equal(child.code, 1, `exit 1 预期，实际 ${child.code}，stdout=${child.stdout}`);
    assert.ok(child.stderr.includes('超时'), `stderr 应含超时提示，实际：${child.stderr}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 真 Chrome 冒烟：检测到才跑（skip 语义，不硬依赖真机） ----
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

// 真 Chrome 冒烟：仅当系统存在 Chrome 且显式开启 FIGMAPT_SHOT_SMOKE=1 时才真实启动（避免
// 在沙箱/CI 环境误拉起真 Chrome 导致挂起或 sandbox 报错）；否则 skip（不硬依赖真机）。
const runRealSmoke = Boolean(realChrome) && process.env.FIGMAPT_SHOT_SMOKE === '1';

test(
  'FUN-ACC-604 shot 真 Chrome 冒烟（检测到才跑，需 FIGMAPT_SHOT_SMOKE=1 开启）',
  {
    skip: runRealSmoke
      ? false
      : realChrome
        ? '未开启 FIGMAPT_SHOT_SMOKE=1，跳过真 Chrome 冒烟（避免误拉起真 Chrome）'
        : '系统未安装 Chrome/Chromium，跳过（不硬依赖真机）',
  },
  async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'figmapt-shot-real-'));
    const html = path.join(work, 'page.html');
    const out = path.join(work, 'page.png');
    fs.writeFileSync(html, '<!doctype html><html><body style="background:#fff">hello</body></html>');
    try {
      const child = await runCli(['shot', html, '--chrome', realChrome, '--out', out]);
      assert.equal(child.code, 0, `真 Chrome 应 exit 0，stderr=${child.stderr}`);
      assert.ok(fs.existsSync(out), '真 Chrome 应产出 PNG');
      const bytes = fs.readFileSync(out);
      assert.deepEqual(
        bytes.subarray(0, 8),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        '应为合法 PNG 签名'
      );
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
);

// 防御性：确保本测试模块自身未泄漏 figmapt-chrome- 临时目录（以模块加载时的基线为准，容忍外部残留）
const BASELINE_CHROME_TMP = countChromeTmpDirs();
test('shot 清理兜底：本模块运行后 figmapt-chrome- 临时目录数量不高于基线', () => {
  assert.equal(
    countChromeTmpDirs(),
    BASELINE_CHROME_TMP,
    '本模块不应额外残留 figmapt-chrome- 临时目录'
  );
});
