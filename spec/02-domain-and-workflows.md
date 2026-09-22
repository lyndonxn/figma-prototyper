# 02 — 领域与工作流

术语见 `../CONTEXT.md`。

## Job 状态机（M2 起，桥接侧）

```
QUEUED ──插件领取──▶ CLAIMED ──开始执行──▶ RUNNING ──┬──明确 ok──▶ OK
                                                    └──异常/超时──▶ FAILED
CONTROL: PAUSED（桥接不下发新 OP；RUNNING 中的不强行打断）
```

- `queued/pending/running` 语义一律 = 等待中；**只有明确 `ok` 才算成功**。
- FAILED 为终态，错误信息原样回传 Agent；重试 = 新 Job。
- Job 记录（id、提交时间、状态、结果摘要、截图路径）由桥接写内存并在会话结束清空；不落盘敏感内容。

## 主工作流（Agent 循环）

1. 用户提供目标 + 设计规范 + 目标文件标识；
2. Agent 经插件读取目标页面结构（过滤导出，见 token 预算）；
3. Agent 出 ≥2 套方案方向 → 逐套生成操作脚本；
4. CLI 提交 Job → 桥接 → 插件执行 → RESULT + 截图回传；
5. Agent 看截图自查 → 不满意则改脚本再提交（回到 4）；
6. 全部返回 `ok` 后交用户验收：Present 模式点交互、选方案。

## 人机协同（M2 起）

- `CONTROL/PAUSE`：用户手动编辑前可暂停 Agent 下发；恢复后继续。
- `EVENT`（documentchange 流）：插件上报画布变更，**必须防抖/批量合并**后才推给 Agent，防止事件洪泛撑爆上下文。

## Token 预算规则（约束 Agent 循环，来源 ADR-0002）

1. 截图导出必须带**区域裁剪 + 缩放倍数**参数；禁止默认整页高清导出。
2. 操作脚本必须**批量**完成一批元素；验收以"轮数最小化"为准绳。
3. 节点树/设计读取必须**过滤**（层级深度 + 字段白名单），不 dump 全量。
4. 每完成一个阶段即总结落盘（本工作区 HANDOFF 协议），新会话续接，避免上下文无界增长。

## IR 转换工作流（M6 起，Design→Code）

1. Agent 经 CLI 提交带 `toIR({rootId,depth,maxNodes})` 的脚本 → 插件把目标画板抽取为**设计 IR**（JSON，schema 见 `03`）；
2. IR 经 RESULT 回传，CLI 落盘至 `--ir-out` 指定目录（缺省 `output/code/` 下按任务 ID 建子目录）的 `design-ir.json`，图片资产经 exportAsync 落盘为相对路径文件；
3. Agent 读 IR 合成 **HTML+CSS 单文件**（布局/样式结构由 IR 确定性给出，字体映射等判断由 Agent 完成）；
4. CLI `figmapt shot` 对产物 HTML 用系统 Chrome headless 截图 → 与 Figma exportAsync 截图**并排对比**；
5. Agent 看两张图迭代（回到 3），满意后交付用户。

预算约束（继承 ADR-0002）：IR 抽取复用 readTree 的深度/字段白名单/节点数三重过滤；IR 单文件超过预算上限须分块（按顶层 frame 拆分），禁止整页无界导出。

## 任务认领与并发

采用通用 Agent 任务状态机与认领规则（BACKLOG→IN_PROGRESS→REVIEW→DONE，认领留痕）；本仓库已独立，不继承外部协议。本项目切片在 `state/TASKS.md` 维护；写-写并行须独立分支/worktree。

## 时间规则

日期 `YYYY-MM-DD` 本地时区（Asia/Shanghai）；交接时间戳附时区。
