# figma-prototyper

**让任意 AI Agent 在免费版 Figma 上设计可编辑、可点击的原型，并在设计稿与代码之间双向转换。**

本地桥接 + 自定义 Figma 插件 + CLI + 自包含 Skill 文档。Agent 生成操作脚本 → 插件在画布上执行 → 截图回传自查 → 迭代，最终交付可编辑、可交互（点击跳转/返回/转场）的原型——全部原生 Figma 图层，你始终可以手动继续编辑。设计稿可导出为可运行的 HTML 页面，HTML/网页也可反向重建为 Figma 画板，两个方向共享一套显式 IR 中间契约并经真机验证等价。

> 起因：官方 Figma MCP 写入画布需要付费席位，且不支持上传图片/自定义字体。本系统直接调用免费可用的官方 Plugin API，绕开付费墙，能力反而更完整。

## 工作原理

```
你（说设计需求）
  → Agent 读 skill 文档 + readTree 读现有设计（深度/字段/数量三重预算过滤）
  → Agent 生成批量操作脚本（JS）
  → CLI 提交 → 本地桥接（仅 127.0.0.1）→ Figma 插件执行（官方 Plugin API）
  → exportAsync 截图落盘 → Agent 看图自查 → 不满意改脚本重提
  → wireReaction 连接原型交互（跳转/返回/转场）
  → 你在 Figma Present 模式点按验收
```

一切发生在你本机：桥接只监听 `127.0.0.1`，无云端、无数据外发。画布上发生的每一步你都看得见。

**Design↔Code 双向转换**围绕同一套设计 IR（中间表示 JSON，schema v1）运转：

```
Design→Code：Figma 画板 --toIR--> IR --Agent 合成--> HTML+CSS --shot--> 截图对比
Code→Design：HTML/URL --extract(真 Chrome CDP)--> IR --rebuild--> Figma 原生画板
读回校验：  重建画板 --toIR--> IR' --diff--> 与源 IR 逐节点比对（真机 0 mismatch）
```

## 特性

- **免费版 Figma 可用**——不需要任何付费席位；产物是原生图层/组件/交互，完全可编辑
- **截图闭环自校验**——Agent 每轮提交后拿到 PNG 自查，自己发现问题自己修（实测宠物商店三页原型 6 轮完成）
- **预算内建**——截图强制区域裁剪 + 缩放上限、节点树读取强制白名单过滤、脚本批量操作（token 成本可控）
- **素材完整**——文字（任意本机字体）、图片（本地文件字节下发）、组件与实例
- **原型交互**——`wireReaction` 助手：ON_CLICK/HOVER/PRESS × NAVIGATE/BACK × 7 种转场，校验失败报错含节点 id
- **Design↔Code 双向转换**——显式 IR 契约（schema v1）：画板转可运行 HTML；HTML/网页经真 Chrome CDP 抽取重建回 Figma；双向真机 E2E 验证节点级等价（45/45 与 38/38 节点，0 mismatch）
- **本机自动配对**——面板打开即自动发现桥接并连接，零粘贴
- **Agent 无关**——纯本机 HTTP/WS + 文件约定；任何能读文件、跑终端、看图的 Agent 客户端都能驱动（Claude Code / Codex / Cursor / ZCode …）；仓库根 `AGENTS.md` 含任务路由表，Codex / Cursor 打开仓库即可自动感知 skill 入口

## 快速开始

前置：macOS、[Figma 桌面端](https://www.figma.com/downloads/)（免费版即可）、Node ≥ 24、一个具备"读文件 + 跑终端 + 看图"能力的 Agent 客户端。

```bash
git clone https://github.com/lyndonxn/figma-prototyper.git
cd figma-prototyper
```

**1. 导入插件（仅首次）**：Figma 菜单 `Plugins → Development → Import plugin from manifest…`，选择 `plugin/manifest.json`。

**2. 启动桥接**：

```bash
cd bridge && node server.js
```

**3. 运行插件**：`Plugins → Development → Figma Agent Prototyper (Dev)`——面板会自动配对连接本机桥接（无需粘贴 token；日志出现「已连接」）。

**4. 让 Agent 干活**：把下面这段发给你的 Agent 客户端（工作目录指向本仓库）：

```
读取并严格遵循 skill/figma-prototyper-skill.md，
用 figma-prototyper 完成任务：<你的设计需求>
```

skill 文档自包含：环境自检、脚本环境规范、预算规则、已知坑清单全在里面——Agent 零上下文即可执行（已用"全新会话独立完成可点击原型"实测验证）。

## 脚本环境（Agent 生成什么代码）

插件沙箱向脚本注入四个能力（支持 `await` / `return`，整体 try/catch，错误原样回传）：

| 注入 | 用途 |
|---|---|
| `figma` | 官方 Plugin API 全集（建元素/自动布局/组件/文字/图片…） |
| `readTree(spec)` | 过滤式读取现有设计：字段白名单 + 深度上限 + 节点预算 + 截断标记 |
| `images` | 经 CLI `--image` 下发的本地图片字节（`figma.createImage(images.xxx)`） |
| `wireReaction(spec)` | 原型交互连线：校验通过才写入，失败报错含节点 id |

CLI 侧：`node cli/figmapt.js run <script.js> [--node <id>|--rect x,y,w,h] [--scale N] [--image name=path] [--timeout ms]`，阻塞至任务终态，成功输出截图路径（退出码 0/1/2 = 成功/脚本失败/参数或连接错误）。

## Design↔Code 双向转换

所有转换围绕一套显式的**设计 IR**（中间表示 JSON，schema v1：节点含 type/name/bounds/layout/style/text/asset/children），`toIR` / `rebuild` / `extract` 三个命令产出的 IR 同构，可逐节点 diff 校验。

| 命令 | 作用 |
|---|---|
| `figmapt run <script.js> --ir-out <dir>` | Figma 画板 → IR（沙箱注入 `toIR`，带深度/字段/节点三重预算） |
| `figmapt shot <html> --out x.png` | HTML 页面截图（真 Chrome headless，用于合成结果自查） |
| `figmapt extract <html\|URL> --ir-out <dir>` | HTML/网页 → IR（真 Chrome + CDP：DOM/computed style/盒模型；`--selector` 选 root，`--cdp-url` 留测试缝） |
| `figmapt rebuild <ir目录>` | IR → Figma 原生画板（确定性重建：自动布局/文字/图片/填充描边圆角，字体带回退链） |

**典型用法**：

```bash
# Design → Code：把画板 37:249 导出为可运行的 HTML 单文件
node cli/figmapt.js run script-toir.js --ir-out ./ir-u11      # 画板 → IR
node cli/figmapt.js shot output/code/u11/index.html --out cmp.png

# Code → Design：把网页重建为 Figma 画板
node cli/figmapt.js extract page.html --ir-out ./ir-page --selector .app
node cli/figmapt.js rebuild ./ir-page --name CR --x 0 --y 4000 --token <token>
```

**边界（v1 诚实降级）**：渐变与 background-image 不抽取；`strokeWeight` 重建默认 1px；HTML 抽取的 font-weight 以 ≥600 → Bold 近似；矢量描边按包围盒近似。完整工作流与坑清单见 skill 文档第 7/8 节。

## 安全模型

- 桥接**仅绑定 `127.0.0.1`**，不暴露到局域网；无云端组件
- 脚本在插件沙箱执行，沙箱**无网络能力**（manifest `allowedDomains: ["none"]`），不能外发数据
- **本机自动配对模式**（默认开启）：面板经 `GET /token`（仅本机可达）自动获取 token，等效"本机免鉴权"——便捷优先的取舍；如需收紧，手动粘贴 token 的旧流程完整保留
- 桥接重启即换 token；插件面板 token 仅存内存不落盘

## 实测

- 全新会话（仅读 skill 文档、零上下文）独立完成「登录页 ⇄ 首页」可点击原型——skill 自包含性验证
- 宠物商店 App 三页可点击原型（首页/详情/领养预约）：6 轮提交完成，含自查迭代（发现留白过大、chip 间距 bug 并自行修复）
- Design→Code 全链路：U11 画板 →IR→ Agent 合成 HTML → 截图对比，1 轮迭代收敛（布局/文本/间距/配色等价）
- Code→Design 双向 E2E：Figma 原稿 toIR（45 节点）→ rebuild → 读回 diff **45/45 节点 0 mismatch**；HTML extract（38 节点）→ rebuild → 读回 diff **38/38 节点 0 mismatch**，bounds 偏差均为 0，字体零回退
- 质量基线：bridge + cli 测试套件全绿（75 用例），spec 驱动验收 ID（FUN-ACC-101~704）全部通过，关键切片经独立子代理验收
- 已知边界：脚本在沙箱内同步执行无硬超时（桥接侧有 Job 级看门狗兜底）；Figma 桌面端需保持运行

## 项目文档（面向贡献者/维护者）

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 项目规则与任务路由（含 skill 入口；Codex / Cursor 自动读取） |
| [spec/](spec/README.md) | 契约：范围/工作流/架构（含设计 IR 契约）/验收（FUN-ACC-101~704、INT-ACC-001~003 全部通过）/路线图 |
| [skill/](skill/figma-prototyper-skill.md) | Agent 的完整 runbook（系统核心） |
| [state/](state/STATUS.md) | 任务板、进度、ADR 决策记录 |
| [HANDOFF.md](HANDOFF.md) | 交付状态与证据链 |

## License

[MIT](LICENSE)
