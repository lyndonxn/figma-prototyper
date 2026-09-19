# ADR-0003 — Agent 脚本在插件 sandbox 内以 AsyncFunction 执行

日期：2026-09-19 ｜ 状态：已接受 ｜ 影响：plugin/code.js、安全模型

## 背景

Agent 生成的操作脚本需要在持有 `figma` API 的 sandbox 环境执行，且脚本天然含 `await`（如 `loadFontAsync`）。sandbox 无网络能力（manifest `allowedDomains:["none"]`），本身不能外发数据。

## 决策

`code.js` 用 `new AsyncFunction('figma', code)` 包装执行，整体 try/catch，错误**原样**回传 UI（Agent 自修复依赖完整错误信息）。成功路径把脚本返回值作为结果消息。

已知限制与缓解：
- sandbox 内同步脚本无法被外部硬超时打断 → 看门狗由 M2 桥接在 **Job 级**承担（超时标记 FAILED）。
- eval 执行的是 Agent/用户自己生成的代码 → 攻击面 = 本机用户权限；缓解：桥接 token 鉴权、仅 127.0.0.1、会话结束清 token、脚本不落盘为可执行文件。

## 后果

- 正向：实现极简，错误反馈保真，支持 await。
- 代价：接受"同步脚本可能卡住插件"直到 M2 看门狗就位；不适用于不可信代码（本系统不做不可信代码沙箱）。
