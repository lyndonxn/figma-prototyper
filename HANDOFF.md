# HANDOFF — figma-prototyper

更新时间：2026-09-22 23:20（Asia/Shanghai）
当前目标：Agent + Figma 插件实时原型系统——AI 经本地桥接 + 自定义插件在免费版 Figma 上产出可编辑、可点击的原型；M6 Design→Code + M7a 图层重建已交付
当前状态：**M1–M6 + M7a 全部 DONE；M7b（DOM 抽取 CDP→IR）BACKLOG**。使用入口：`skill/figma-prototyper-skill.md`（原型 = 第 2~6 节；Design→Code = 第 7 节；Code→Design = 第 8 节）

## 已完成

- **M7a 图层重建（2026-09-22，分支会话实现 + 两轮验收 ACCEPT + 真机迭代）**：
  - `cli/figmapt.js`：`rebuild` 子命令——确定性脚本生成器（同 IR 字节一致，`--dry-run` 测试缝），映射表按 spec/03；图片走 M4 images 通道（脚本不内嵌 base64）；CR- 命名冲突自动 .rN 后缀；不触碰既有节点；字体回退链 IR字体→PingFang SC→Inter（fontFallbacks 记录）；退出码 0/1/2。
  - `skill/` 第 8 节 Code→Design 工作流（五步/映射表/字体回退/坑 21~26）；fixture `cli/test/fixtures/m7-rebuild/` 入版本控制。
  - **真机迭代抓出并修复三缺陷**（聚焦复审 ACCEPT agent-01e66c01）：①IR 缺对齐语义 → toIR/rebuild 双侧扩展 `layout.primary/counter`（primaryAxisAlignItems/counterAxisAlignItems）与 `absolute`（layoutPositioning ABSOLUTE）——IR schema M7 扩展，spec/03 已更新；②resize 必须在 layoutMode 之后（否则 auto-layout sizing 被 hug 重置，按钮缩成内容宽、space-between 失效）；③IR 无 fills 的帧须清 createFrame 默认白填充（root 与子节点两处）。另修第一轮验收发现的占位符串行替换污染（单遍正则替换）。
  - 运行时证据：U11 IR（新版 toIR 重抽，primary×10/counter×9）→ 重建 CR-U11-支付成功（36:824 后清理，终版保留 .r3 于 -605,3944），44 节点、字体零回退、与原稿布局/文本/间距/对齐/底色等价（对比截图 `screenshots/m7a-rebuild-u11.png` vs `output/code/m6-u11/figma.png`）；剩余差异均为矢量包围盒近似（坑 26 已录）。
  - 测试 59→67 全绿（bridge 35 + cli 32，rebuild 8 用例含确定性/映射/占位符回归/images 载荷/错误路径）。
  - 运行时注意：中间测试板 CR-U11-支付成功(.r1/.r2) 已清理；Figma 插件已重载至新版 toIR。

- **M7 Code→Design 规划（2026-09-22，controller，wanan Change lane）**：用户两项决策（**D 先 C 后**：M7a 图层重建先行，用 output/ 已验证 IR 当 fixture；**CDP 零新增依赖**：系统 Chrome + DevTools Protocol，cli 引入 ws，不引 Playwright）→ ADR-0005。Harness 修订：spec/01（范围激活 M7 + 用户故事 5）、spec/02（逆向转换工作流：extract→rebuild→toIR 读回 diff 五步 + 字体回退策略）、spec/03（逆向转换契约：IR→Plugin API 重建映射表、CR- 命名与不触碰既有节点、CDP 抽取契约；M7a/M7b 路径所有权；测试缝——rebuild 用 m6-site IR fixture、extract 用 CDP 桩）、spec/05（FUN-ACC-701~704，7NN 编号）、spec/07（M7a/M7b BACKLOG）、CONTEXT.md（图层重建/CDP 抽取/逆向闭环术语）、TASKS.md（T-07a/07b BACKLOG）。实现未启动。

- **M6 收官：Design→Code 全链路运行时验证（2026-09-22，controller 真机实测）**：
  - 环境：Figma 桌面端 126.9.9 + 桥接（重启至 M6a 后版本——首轮 data 未回传系旧桥接进程不识 RESULT.data，重启即解）+ 插件重载（bounds 修复后）。
  - 链路：U11-支付成功画板（37:249，29 节点）→ `toIR --ir-out` 落盘（design-ir.json 23KB，含 bounds）→ Agent 按 skill 第 7 节合成 HTML+CSS 单文件 → `shot --w 390 --h 844` → 与 Figma 基准（`--rect` 导出）并排对比 → 1 轮迭代（wifi 图标 conic-gradient 扇形修正）→ 收敛：布局/文本/间距/配色等价。产物：`output/code/m6-u11/`（design-ir.json / index.html / shot.png / figma.png）。
  - **运行时抓出并修复两个缺陷**（聚焦复审 ACCEPT，agent-2f2a873a；测试 48→59：bridge 35 + cli 24）：
    1. toIR 缺 `bounds` 字段——spec/03 契约系 M6b 验收后回填，实现缺失（验收时序漏洞）。修复：buildIrNode 输出 bounds{x,y,width,height}（round3、字段级容错）+ TOIR_NODE_KEYS/断言更新。
    2. shot 旧输出文件误判——输出路径已存在旧 PNG 时立即满足"落盘稳定"，Chrome 未写新图即 exit 0。修复：spawn 前预删除 outPath + `delay` 桩回归用例。
  - **新发现 Figma 行为怪癖（skill 坑 20）**：`exportAsync` 对 clipsContent=false 画板导出远超画板尺寸的区域（390×844 画板 → 3010×2572），`--node` 导出失真；对比基准改用 `--rect`（临时帧 + clipsContent 强制裁切，尺寸恒正确）——反向验证了 M3 rect 路径的设计价值。
  - **FUN-ACC-603/604 定 DONE，M6 全部验收 ID 通过。**

- **M6b Design→Code 闭环（2026-09-22，分支会话实现 + 独立验收 ACCEPT）**：
  - `cli/figmapt.js`：`shot` 子命令——包装系统 Chrome（`--headless=new --screenshot --window-size --user-data-dir` 临时目录用后清理）；Chrome 定位 `--chrome` > `FIGMAPT_CHROME` > macOS 常见路径；缺失 → exit 2 + 降级提示（手动打开页面截图）；Chrome 失败 exit 1 stderr 原文；零新依赖。
  - `skill/figma-prototyper-skill.md`：新增第 7 节「Design→Code 工作流」（自包含：六步、IR→CSS 语义映射表、字体映射起点表、坑 13~18 覆盖 M6a 边界、单文件无构建链边界声明）。
  - 证据：测试 48→56（cli 13→21，含 1 个真 Chrome 冒烟 skip 项，`FIGMAPT_SHOT_SMOKE=1` 显式开启）；604 契约路径全验证（PNG 字节一致 / exit 1/2 / 临时目录清理）；603 机制侧 pass（映射表与 IR 契约一致）；`node --check` OK；独立验收 ACCEPT（agent-165cab9a）。
  - **运行时待用户**（603/604 定 DONE 的条件）：①`node cli/figmapt.js shot <任意 html> --out <png>` 真机冒烟；②Figma 全链路：画板 → toIR --ir-out → Agent 按 skill 第 7 节合成 HTML → shot → 与 exportAsync 截图对比至少一轮迭代。controller 沙箱内 Chrome 无法拉起（环境限制，与实现会话一致），须用户终端执行。
  - spec 回填：02 修正 toIR 签名（无 fields）；03 节点字段补 bounds{x,y,width,height}（mode:none 绝对定位用）。

- **M6a 设计 IR 通道（2026-09-22，分支会话实现 + 独立验收 ACCEPT）**：
  - `plugin/code.js`：第 5 个沙箱注入 `toIR({rootId,depth,maxNodes})`——复用 readTree 预算模式（depth≤10/maxNodes≤2000/截断标记）；确定性映射 layoutMode/itemSpacing/padding/cornerRadius/characters/fontSize；可见 SOLID 填充→hex+opacity，GRADIENT/IMAGE 填充→type:image + exportAsync PNG base64 入 assets（键=节点 id）；RESULT.data 返回值通道（≤20MB，脚本 return 对象才走 data，字符串仍走 message 向后兼容）。
  - `plugin/ui.html`：RESULT.data 透传（最小改动）；`bridge/server.js`：data 校验（20MB 上限 + JSON 可解析，违规 failJob）+ 透传；`cli/figmapt.js`：`--ir-out` 落盘 design-ir.json + assets/*.png（文件名白名单防注入），无 data → exit 2。
  - 证据：测试 40→48 全绿（bridge 35 + cli 13，验收方独立复跑确认）；FUN-ACC-601/602 逐条 pass（601 白名单/预算/截断断言、602 落盘字节一致/超限拒绝/无 data 报错）；`node --check` 双 OK；零新依赖。
  - 验收建议已回填：spec/03 节点字段补 text/asset 枚举 + toIR 无 fields 筛选说明；spec/05 601 Given 同步。
  - 已知边界（低危，M6b 注意）：含图片/渐变填充的容器节点作为叶处理、不递归其子节点；asset 文件名含节点 id 冒号（APFS 合法）。

- M6 规划（2026-09-22，controller，wanan Change lane）：对比 denki-san/local-figma 后用户决定纳入 Design↔Code。三项用户决策（单方向先行 / HTML+CSS 静态页 / Chrome headless）→ ADR-0004；Harness 原地修订：spec/01（范围+非目标收窄）、02（IR 转换工作流）、03（IR 契约+路径所有权 M6a/M6b）、05（FUN-ACC-601~604）、07（M6a/M6b 切片，M5 行 REVIEW→DONE 状态校正）、README 索引、CONTEXT.md（IR 术语）、TASKS.md（T-06a/06b BACKLOG）。实现未启动。提交 7eafb3c（main，未 push）。

- Bootstrap：项目 Harness 四层落盘并通过 wanan 严格校验（`validate-harness.ps1` 输出 "Harness strict validation passed"）。
  - 规则层：`AGENTS.md`、`CONTEXT.md`；契约层：`spec/README.md` + 01~07；状态层：`state/`（TASKS/STATUS + ADR-0001~0003）；路线图：M1–M5。
  - 三项决策记录：ADR-0001 WS 双工桥接、ADR-0002 token 预算内置、ADR-0003 eval 脚本执行模型。
- M1 插件骨架（分支会话实现 + 独立验收 + 修复复审 ACCEPT）：
  - `plugin/manifest.json`：api 1.0.0、editorType figma、`allowedDomains:["none"]`、devAllowedDomains 放行 ws+http localhost:8787。
  - `plugin/code.js`：sandbox 侧 RUN_SCRIPT 处理器，AsyncFunction 包装 + figma 注入 + 全程 try/catch，失败回传 ok:false 原样错误；无网络代码。
  - `plugin/ui.html`：粘贴脚本面板（预填示例）+ Run 三态（执行中禁用防重/成功/失败原文）+ 追加式日志 + 清空；零外部引用。
  - 修复记录：示例脚本 sizing mode 由 AUTO（hug 会缩成约 320×168）改为 FIXED，锁定 320×240（FUN-ACC-104 静态一致性已由复审确认）。

- M2 桥接（分支会话实现 + 独立验收第一轮 ACCEPT）：
  - `bridge/server.js`：`startBridge()` 可测试结构；仅绑 127.0.0.1；token（crypto 随机、timingSafeEqual、缺失/错误 4401）；`GET /health`（免鉴权）、`POST /jobs`（长轮询至终态；无插件 503）、`GET /events`（防抖环形缓冲）；四类消息 {v:1,kind,id,ts}；Job 看门狗（超时 FAILED、迟到 RESULT 忽略）；CONTROL pause/resume/shutdown；断连时在途 Job 确定性 FAILED。
  - `plugin/ui.html`：桥接区块（token 密码框仅内存 + 连接状态）；OP FIFO 单飞；RESULT 双路（日志三态不变 + 回传桥接）；busy 锁 + 60s 本地超时。
  - `plugin/code.js`：授权微改——RESULT 三处透传 jobId。
  - 证据：`npm test` 7/7（node:test，含看门狗/503/断连附加用例）；验收方独立复现并核验断言真实性（203 pause 期间零 OP、204 合并 ≤3 且 30 条无丢失）。

- M3 CLI + 截图闭环（分支会话实现 + 独立验收 ACCEPT，303 运行时待抽验）：
  - `cli/figmapt.js`：零依赖 CLI，`run <file> [--node|--rect] [--scale] [--timeout] [--token/--port]`；退出码 0=ok / 1=job 失败超时 / 2=传输参数错误；token 优先级 --token > FIGMA_BRIDGE_TOKEN。
  - `plugin/code.js`：截图三模式——node（exportAsync SCALE）、rect（顶层相交节点 clone 进临时帧，finally 清理）、page（显式选择，CLI 无入口）；捕获失败不使 Job 失败（screenshotError）。
  - `bridge/server.js`：screenshot 校验 + scale clamp [0.1,4] + base64 落盘 `screenshots/job-<jobId>.png`（路径写死防注入）。
  - 证据：bridge 10/10 + cli 8/8（验收方独立复跑）；301 断言文件字节级一致、302 覆盖 failed+timeout、303 协议三层（CLI→桥→OP）逐字段验证；M1/M2 零回归（无 screenshot 的 OP 与 M2 逐字节一致）。

- M4 素材能力（分支会话实现 + 独立验收 ACCEPT，401/402/403 运行时待代跑）：
  - `plugin/code.js`：脚本注入 `readTree({rootId,depth,fields,maxNodes})`——21 字段白名单交集、depth≤10、maxNodes≤2000、仅容器递归、截断标记、字段级容错、fillSummary 轻量摘要；`images`（name→Uint8Array）注入。
  - `cli/figmapt.js --image <path>`（可重复 + name=path 命名）；`bridge` images 校验（单图 5MB/总量 20MB、严格 base64、拒绝 `__proto__`）+ screenshotBase64 PNG 签名校验（非 PNG → screenshotError:'invalid-png' 不写盘）。
  - 证据：bridge 22/22 + cli 11/11（验收方独立复跑）；404 四要素真实断言（全树键 walk、越权字段拒绝、边界命中）；M1–M3 零回归（OP 键集精确断言）。

- M5 交互 + Skill（分支会话实现 + 独立验收 ACCEPT + 501 实测，REVIEW）：
  - `plugin/code.js`：注入 `wireReaction({sourceId, trigger?, action, destinationId?, animation?})`——纯值白名单→节点存在性→写入，错误含 id/允许值；覆盖式；返回 `{sourceId, reactions:<读回>, destinationId?}`。
  - `skill/figma-prototyper-skill.md`：自包含 runbook（前置条件与实际代码逐字核对、六步工作流、脚本环境规范、ADR-0002 预算规则、10 条坑清单、幂等示例）。
  - **501 复现实测（FUN-ACC-501）**：全新子代理仅读 skill 文档、零提问，独立完成"登录页⇄首页"两页可点击原型（SMART_ANIMATE 300ms + BACK），截图自查通过——skill 自包含性成立。实测同时发现 **Figma 已废弃 reactions 单数 `action` 字段**（官方文档/示例均滞后）：wireReaction 已修为复数 `actions`（vm 28/28 回归），skill 补坑 10（手写 schema：actions 复数、duration 秒、对象形式）。
  - 证据：bridge 28/28（验收方独立复跑）；002 静态链路三方核验（官方文档+示例仓库+typings）。

- 通过（M5 收官复验，2026-09-19）：**INT-ACC-002 pass**（用户 Present 点按"能跳"：登录页→首页 SMART_ANIMATE、返回键回退）+ **wireReaction 修复真机复验 pass**（23:30→23:32 重连线成功，无 schema 拒绝）+ **M4 chars 修复真机复验 pass**（readTree 返回 `chars:"登录页"/"进入首页"`）。**M1–M5 全部验收 ID 通过，项目交付。**

## 验证

- 通过（静态）：`node --check plugin/code.js` = SYNTAX_OK；manifest JSON 解析 + 字段逐项核对；ui.html 零外部引用 grep；AsyncFunction 包装 Node 冒烟测试（成功返回值/异常原样冒泡/undefined→"执行成功"）。
- 独立验收：第一轮 REJECT（发现 FUN-ACC-104 sizing 缺陷）→ 修复 → 全新子代理聚焦复审 **ACCEPT**（FUN-ACC-101/102/103 pass、修复 pass、无回归）。
- 通过（运行时，2026-09-19 用户实测确认）：**FUN-ACC-104 pass**——画布出现 Agent-Prototyper-M1 框架，尺寸徽标 **320×240**（sizing FIXED 修复在真实环境生效），面板状态"成功"，日志"[成功] 已创建 Auto Layout Frame: 11:6"（截图存于会话缓存，证据为用户确认 + 日志内容）。
- 通过（运行时，2026-09-19 用户实测确认）：**FUN-ACC-105 pass**——`throw new Error('测试')` 显示红色"[失败]"日志、Run 恢复可点、粘回原脚本再跑成功。**M1 的 FUN-ACC-101~105 全部通过。**
- 通过（M2 契约测试，2026-09-19）：**FUN-ACC-201~204 pass**——npm test 7/7，独立验收 ACCEPT；后经 M3 扩展为 10 用例仍全绿（无回归直接证据）。
- 通过（M3 契约测试，2026-09-19）：**FUN-ACC-301/302 pass**、**303 静态部分 pass**——独立验收 ACCEPT（bridge 10/10 + cli 8/8；301 文件字节级断言、302 failed+timeout 双路径、无回归确认）；303 运行时已另行通过（见上）。
- 通过（运行时代跑，2026-09-19）：**FUN-ACC-401/402/403 pass**——①字体文本：中英数字混排（Noto Sans SC）正确渲染，且缺字体错误路径真实触发（报错原样、含修复建议）；②图片填充：本地 PNG 经 CLI --image → 桥接 → 注入 sandbox → createImage 填充，截图与源图一致；③组件化：组件 + createInstance + readTree 读回结构正确（instance 子节点 id 呈 `I<id>;<child>` 命名）。
- 通过（运行时发现并修复 bug）：readTree 的 chars 字段读取用了不存在的 `node.chars`（正确为 `node.characters`），vm 桩测试未能发现（桩内同名假属性）——由真机代跑抓出。已修复，vm 回归 22/22；真机复验随 M5 插件重载进行。
- 修复（light-lane）：bridge parseCliArgs 此前只认 `--key=value`，空格形式被静默忽略（曾导致 controller 传 token 失效）；现两种形式均支持 + 无法识别参数打警告。
- 通过（M4 契约测试，2026-09-19）：bridge 22/22 + cli 11/11（验收方独立复跑）+ 404 四要素真实断言；后经 M5 扩展为 28 用例仍全绿（无回归直接证据）。
- 通过（501 复现实测，2026-09-19）：**FUN-ACC-501 pass（附发现）**——全新子代理仅读 skill 完成任务且零提问；抓出 wireReaction 单数 `action` schema 失效（已修复，见上），修复的真机复验待插件重载。
- **未验证（运行时）**：INT-ACC-002 Present 模式点按（用户动作，原型已就绪：帧 23:28 登录页 / 23:32 首页，reactions 已正确写入）；wireReaction 修复 + M4 chars 修复的真机探针（随插件重载一起做，各 30 秒）。按 spec/05，002 通过前 M5 保持 REVIEW。
- 通过（运行时冒烟，2026-09-22 controller 代跑沙箱外真机）：**shot 真机冒烟发现缺陷并已修复**——Chrome 152 `--headless=new --screenshot` 写完 PNG 后进程不退出（后台服务常驻），shot 原实现等待子进程 close 导致无限挂起（桩测试无法暴露：桩会正常退出）。修复：成功判据改为"截图文件落盘稳定"（100ms×3 次大小不变 → SIGKILL Chrome → exit 0），默认 30s 超时 `--timeout ms` 可调。修复后真机复验 **pass**：800×600 PNG 2.4s exit 0（证据 `screenshots/m6b-shot-smoke.png`）；新增 hang/idle 桩回归用例，聚焦复审 ACCEPT（agent-1ab8a6f4，测试 48→58：bridge 35 + cli 23）。skill 坑 19 与 spec/03 shot 描述已同步。
- 通过（M6 收官全链路运行时，2026-09-22 controller 真机实测）：**FUN-ACC-603/604 pass**——U11 画板（37:249）toIR→IR 落盘（含 bounds）→ Agent 合成 HTML 单文件 → shot 390×844 → 与 Figma 基准（--rect 导出）对比，1 轮迭代（wifi 图标）后收敛，布局/文本/间距/配色等价（产物 `output/code/m6-u11/`）。过程中修复 toIR 缺 bounds、shot 旧文件误判两缺陷（聚焦复审 ACCEPT agent-2f2a873a，测试 59 全绿）；发现 Figma exportAsync 对 clipsContent=false 画板导出失真（skill 坑 20，--rect 规避）。**至此 FUN-ACC-601~604 全部通过，M6 标 DONE。**
- 通过（运行时抽验，2026-09-19 controller 代跑真机全链路）：**FUN-ACC-303 pass**——`node cli/figmapt.js run /tmp/m3-shot.js --node 16:6 --scale 2` → 插件执行 → PNG 落盘 → 视觉核对为纯橙测试框架、分辨率 640×480（320×240 精确 2 倍）、仅含目标节点。**至此 FUN-ACC-301~303 全部通过，M3 标 DONE。**
- M4 改进项（验收方建议，非缺陷）：桥接侧对 screenshotBase64 做最小形式校验（Buffer.from 对非法字符静默跳过，可能写出损坏 PNG）。
- 通过（真机冒烟，2026-09-19 用户确认"连上了"）：Figma 插件面板经 `ws://localhost:8787?token=` 成功连接真实桥接，面板状态"已连接"——M2 真机链路验证完成。
- 未执行检查（记录）：WS upgrade 未校验 Origin（回环 + token 威胁模型下可接受，验收方备注）；截图真机抽验（FUN-ACC-303 运行时部分）在 M3 交付后进行。

## 未完成

- M3–M5 全部切片（验收 ID 已在 spec/05 预定义）；M3 待启动（T-03 BACKLOG，阻塞已解除）。

## 阻塞

- 无硬阻塞。M3 实现不依赖 Figma；真机冒烟建议但不阻塞。

## 决策与待决

- 已确认：WS 双工桥接（ADR-0001）、token 预算硬约束（ADR-0002）、AsyncFunction 执行模型（ADR-0003）、端口 8787、项目名 figma-prototyper、**本机自动配对**（2026-09-19 用户选便捷优先：GET /token 免鉴权供面板自动连接，等效"本机免鉴权"——桥接仅绑 127.0.0.1，token 防护对象从"本机进程"退化为"无"，换取零粘贴体验；skill 前置条件已改为 Agent 第 0 步自检）。
- 延迟：OPEN-1 push 远程授权；OPEN-3 端口冲突时改配置项（已由 --port 支持）。
- 非 目标：App 客户端 ↔ Figma 双向实时同步（v3 话题，见 spec/01）。

## 工作区与版本控制

- 变更产物：`figma-prototyper/` 全部（AGENTS.md、CONTEXT.md、README.md、spec/×8、state/×5、plugin/×3、HANDOFF.md）。
- 保留的无关变更（未staged）：`build_wanan_flow.py`、`vault-autocommit.sh`、`kart-racer/.gitignore`（用户/其他项目所有）。
- 提交：M6a 聚焦提交 d0375b9（main，未 push）；此前规划提交 7eafb3c、863ad9a。
- Push：未 push（无远程授权，继承工作区 OPEN-1）。

## 工具与环境清单

- Root task ID：figma-prototyper-m1-2026-09-19
- 本地能力：read/glob/grep/bash/replace 全可用（darwin arm64，macOS 26.6）
- 运行时：node v24.19.0、git 2.50.1、pwsh（/opt/homebrew/bin/pwsh，wanan 校验可用）、Figma 桌面端已安装（/Applications/Figma.app）
- 适配器：无

## 分支登记

| 分支会话 | 范围/所有路径 | 压缩次数 | 状态 | 交接 | 集成 |
|---|---|---:|---|---|---|
| controller@zcode | Harness 全部 + 状态落盘 + 集成 | 0 | active | 本文件 | — |
| M1-impl（agent_7baa138c） | `plugin/**`、`README.md` | 0 | completed | 子代理报告（回复中） | accepted |
| M1-accept（agent_936d04df） | 只读验收 | 0 | completed | REJECT 报告 → 触发修复 | accepted |
| M1-accept-r2（agent_69702b9f） | 只读复审 | 0 | completed | ACCEPT 报告 | accepted |
| M2-impl（agent_929f295e） | `bridge/**`、`plugin/ui.html`、`plugin/code.js` 微改、`.gitignore` | 0 | completed | 子代理报告（回复中） | accepted |
| M2-accept（agent_240f99ac） | 只读验收 | 0 | completed | ACCEPT 报告（第一轮） | accepted |
| M3-impl（agent_8ac0b941） | `cli/**`、`bridge/**` 扩展、`plugin/code.js` 截图、`plugin/ui.html` 透传 | 0 | completed | 子代理报告（回复中） | accepted |
| M3-accept（agent_a06afb89） | 只读验收 | 0 | completed | ACCEPT 报告（303 运行时待验） | accepted |
| controller 真机抽验 | CLI 全链路代跑（303） | 0 | completed | 本文件验证节 | accepted |
| M4-impl（agent_a841f55d） | `plugin/code.js`、`plugin/ui.html`、`bridge/**`、`cli/**` | 0 | completed | 子代理报告（回复中） | accepted |
| M4-accept（agent_cee62bce） | 只读验收 | 0 | completed | ACCEPT 报告（401/402/403 运行时待验） | accepted |
| controller 运行时代跑（M4） | 401/402/403 + chars bug 修复 | 0 | completed | 本文件验证节 | accepted |
| M5-impl（agent_fabd4665） | `plugin/code.js`、`skill/**`、`plugin-code.test.js`、`README.md` | 0 | completed | 子代理报告（回复中） | accepted |
| M5-accept（agent_cca73b4c） | 只读验收 | 0 | completed | ACCEPT 报告（002 运行时待验） | accepted |
| 501 复现子代理（agent_7b5ac49c） | 仅读 skill 独立建原型 | 0 | completed | 任务报告 + 文档缺口清单 | accepted（缺口已回写 skill） |
| controller 收官复验 | wireReaction/chars 真机探针 + 用户 Present | 0 | completed | 本文件验证节 | accepted |
| M6a-impl（agent_de9e389f） | `plugin/**`、`bridge/**`、`cli/**` | 0 | completed | 子代理报告（回复中） | accepted |
| M6a-accept（agent_d06305c5） | 只读验收 | 0 | completed | ACCEPT 报告（低危边界已记录） | accepted |
| M6b-impl（agent_7f299de2） | `cli/**`、`skill/**` | 0 | completed | 子代理报告（回复中） | accepted |
| M6b-accept（agent_165cab9a） | 只读验收 | 0 | completed | ACCEPT 报告（运行时待用户） | accepted |
| controller 真机冒烟（shot） | 发现 Chrome 不退出缺陷 + 修复 | 0 | completed | 本文件验证节 | accepted |
| M6b-accept-r2（agent_1ab8a6f4） | 聚焦复审（shot 挂起修复） | 0 | completed | ACCEPT 报告 | accepted |
| controller M6 收官实测 | Figma 全链路 + 2 缺陷修复 + skill 坑 20 | 0 | completed | 本文件验证节 | accepted |
| M6-r2（agent_2f2a873a） | 聚焦复审（bounds + shot 预清理） | 0 | completed | ACCEPT 报告（2 条低危备忘） | accepted |

## 前端设计锁

- 不适用：插件面板为工具型 UI，`spec/04` 记录 Design status: DRAFT + Gate 6 N/A；产品化时重开。

## 风险

- sandbox 同步脚本无硬超时（ADR-0003 已记录），M2 Job 级看门狗就位前的已知限制。
- 运行时验收依赖用户手动操作，可能停滞——下一步已给出精确动作清单。

## 下一步（M7b 待启动）

1. **T-07b（M7b，阻塞已解除）**：`figmapt extract`——系统 Chrome + CDP（DOM.getDocument/getComputedStyleForNode/getBoxModel → IR schema v1，含 primary/counter/absolute 语义），cli/package.json 引入 ws；skill 第 8 节增补抽取小节；验收 FUN-ACC-703（CDP 桩契约测试）+ 704（运行时往返等价：extract→rebuild→toIR 读回 diff，需 Figma + Chrome）。
2. 未决：push 仍继承 OPEN-1 无授权；融合 P0 基建（任务 ID 异步/doctor/断线恢复）未排期。
