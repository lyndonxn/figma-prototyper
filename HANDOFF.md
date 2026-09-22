# HANDOFF — figma-prototyper

更新时间：2026-09-22 20:20（Asia/Shanghai）
当前目标：Agent + Figma 插件实时原型系统——AI 经本地桥接 + 自定义插件在免费版 Figma 上产出可编辑、可点击的原型；M6 起新增 Design→Code（设计 IR 中枢）
当前状态：**M1–M5 交付 + M6 规划完成（spec 已定稿，实现未启动）**。使用入口：`skill/figma-prototyper-skill.md`

## 已完成

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
- 提交：本切片聚焦提交（见 `git log` 中首条 figma-prototyper 提交，注明 FUN-ACC-101~103）。
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

## 前端设计锁

- 不适用：插件面板为工具型 UI，`spec/04` 记录 Design status: DRAFT + Gate 6 N/A；产品化时重开。

## 风险

- sandbox 同步脚本无硬超时（ADR-0003 已记录），M2 Job 级看门狗就位前的已知限制。
- 运行时验收依赖用户手动操作，可能停滞——下一步已给出精确动作清单。

## 下一步（M6 实现，待用户启动）

1. **T-06a（M6a）**：分支会话实现 IR 通道——`plugin/code.js` toIR 注入、RESULT.data、`cli --ir-out`；验收 FUN-ACC-601~602（静态+契约测试，可全程不依赖 Figma）。
2. **T-06b（M6b，阻塞于 06a）**：`figmapt shot` 子命令（先本地 HTML fixture 契约测试）+ skill 增补 Design→Code 工作流节；验收 603/604（运行时，需 Figma + 本机 Chrome）。
3. 未决：M6a 实现启动需用户明确指令（含是否先处理融合 P0 基建）；push 仍继承 OPEN-1 无授权。
4. 日常使用入口不变：新会话直接读 `skill/figma-prototyper-skill.md` 执行设计任务（501 已实测可复现）。
