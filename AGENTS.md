# figma-prototyper 项目 Harness

> **独立项目**（2026-09-19 自 ZCode 工作区迁出，独立 Git 仓库；历史提交存于原工作区仓库存档）。本目录自带完整规则与契约，不依赖外部文件。

## 1. Purpose 目的

Agent + Figma 插件实时原型系统：让 AI Agent 通过本地桥接 + 自定义 Figma 插件，在免费版 Figma 上创建/修改设计、连原型交互，并以截图闭环自校验。用户 = 唯一决策人；Agent = 理解目标、生成并执行操作脚本、看图迭代。

## 2. Instruction precedence 指令优先级

当前用户指令 > 根 `AGENTS.md` > 本文件 > `spec/05-acceptance.md` 验收标准 > 其他文档。

## 3. 领域约束

- **Job 状态机**（M2 起）：`QUEUED → CLAIMED → RUNNING → OK | FAILED`；桥接可 `PAUSED`（不下发新 OP）。状态只允许出现在桥接内存/日志与 `state/` 落盘记录中，变更留痕。
- **路径所有权**：认领期间切片拥有其声明的路径；本项目路径划分见 `spec/03-system-architecture.md`。
- **双环境边界**：`code.js`（sandbox，持 figma API，无网络）与 `ui.html`（iframe，有网络，无 figma API）只通过 `postMessage` 通信，不得尝试其他通道。
- **脚本执行模型**：Agent 生成的脚本在 sandbox 内以 AsyncFunction 执行（ADR-0003），必须 try/catch 包装并把错误原样回传。
- **非目标**（防止范围蔓延）：App 客户端 ↔ Figma 双向实时同步（v3 话题）、插件上架 Community、云端服务、多人协作场景。

## 4. 安全与质量约束

- 桥接只绑定 `127.0.0.1`，每次会话临时 token 鉴权；token 不落盘、不进 Git。
- 插件 manifest 的 `allowedDomains` 保持 `["none"]`；仅 `devAllowedDomains` 放行 `localhost:8787`。
- 执行前核对目标 Figma 文件/页面标识；只有明确 `ok` 才算成功（queued/pending/running 均为等待中）。
- 每次使用结束关闭桥接并清理 token。
- 任何文件不得含密钥/token/隐私数据。
- Git 检查点是里程碑必要条件；push 须经用户授权（根协议第 5 节）。

## 5. Spec index 规格索引与任务路由

| 任务领域 | 先读 |
|---|---|
| 产品范围与非目标 | `spec/01-product-scope.md` |
| 领域与工作流（Job 状态机、token 预算） | `spec/02-domain-and-workflows.md` |
| 架构（消息协议、文件契约、安全边界） | `spec/03-system-architecture.md` |
| 视觉与交互（工具型 UI，Gate 6 不适用） | `spec/04-visual-and-interaction.md` |
| 功能验收 | `spec/05-acceptance.md` |
| 视觉验收 | `spec/06-visual-acceptance.md` |
| 路线图与切片（M1–M5） | `spec/07-delivery-roadmap.md` |

术语见 `CONTEXT.md`。

## 6. 验证

- 每切片：静态检查（`node --check`、manifest JSON 解析、WS/HTTP 契约测试）+ 需要运行时证据的条目在 Figma 桌面端人工执行（用户配合）。
- 未执行的检查必须显式列出（如：多 Agent 并发、远程协作）。
- 索引完整性：本文件与 `spec/README.md` 的相对链接全部可解析。

## 7. Definition of done 完成定义

切片完成 = 实现通过对应验收 ID + `state/STATUS.md`/`state/TASKS.md` 更新 + `HANDOFF.md` 含证据与下一步 + Git 聚焦提交（push 状态明确）+ 未执行检查已列名。独立验收由全新子代理执行（根协议 wanan Gate 8）。
