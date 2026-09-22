# 07 — 交付路线图

## 切片与阻塞边

| 切片 | 内容 | 阻塞于 | 验收 ID | 状态 |
|---|---|---|---|---|
| M1 | 插件骨架：manifest + 双环境 postMessage + 手动脚本建 Frame | — | FUN-ACC-101~105 | DONE |
| M2 | WebSocket 双工桥接 + token 鉴权 + 暂停开关 + EVENT 防抖 | M1 | FUN-ACC-201~204 | DONE |
| M3 | CLI + 截图落盘闭环（裁剪/缩放参数化） | M2 | FUN-ACC-301~303 | DONE |
| M4 | 文字/图片/组件/字体 + 节点树过滤导出 | M3 | FUN-ACC-401~404 | DONE |
| M5 | 原型交互（reactions）+ Agent Skill 固化 | M4 | INT-ACC-002~003、FUN-ACC-501 | DONE |
| M6a | 设计 IR 通道：toIR 注入 + RESULT.data + `--ir-out` 落盘（schema 见 `03`） | M4 | FUN-ACC-601~602 | DONE |
| M6b | Design→Code 闭环：Agent 合成 HTML+CSS（skill 固化）+ Chrome headless 对比（`shot` 子命令） | M6a | FUN-ACC-603~604 | DONE（运行时证据：U11 画板全链路实测 + 1 轮迭代收敛，2026-09-22） |
| M7a | 图层重建：`figmapt rebuild`——IR→沙箱脚本确定性生成器（映射表见 `03`）+ skill Code→Design 工作流节 | M6a | FUN-ACC-701~702 | DONE（运行时证据：U11 IR 真机重建 44 节点，与原稿布局/文本/间距/对齐/底色等价，2026-09-22） |
| M7b | DOM 抽取：`figmapt extract`——系统 Chrome + CDP（DOM/computed style/盒模型→IR），cli 侧引入 `ws` | M7a | FUN-ACC-703~704 | DONE（运行时证据：U11 HTML 真机全链路 extract→rebuild→toIR 读回 diff，38/38 节点零 mismatch 零豁免，2026-09-23） |

每切片 = 可独立演示的垂直行为；M2 起 `plugin/ui.html` 由桥接切片拥有（见 `03` 路径所有权）。M6 决策来源：2026-09-22 用户三项决策（单方向先行 / HTML+CSS 静态页 / Chrome headless），见 ADR-0004。M7 决策来源：2026-09-22 用户两项决策（D 先 C 后 / CDP 零新增依赖），见 ADR-0005。

## 需求追溯

范围（`01`）用户故事 1 ← M1–M5 全链路；故事 2 ← M2 暂停开关 + EVENT；故事 3 ← 架构选型（Plugin API，见 ADR-0001/0003）。

## 延迟决策

- OPEN-1：push 远程授权（缺省：仅本地提交）。
- OPEN-2：目标 Figma 文件（用户在 M1 运行时验证时提供，任意草稿即可）。
- OPEN-3：端口冲突改配置项（低风险）。
- 非 MVP 明确不做：App↔Figma 双向同步（v3 再议，见 `01` 非目标）。

## 发布与回滚边界

本系统为本地个人工具，无生产发布。回滚 = Git 回退对应切片提交；桥接/插件不含持久状态（会话结束清空）。
