# ADR-0001 — 桥接采用 WebSocket 双工（取代原计划的 HTTP 轮询）

日期：2026-09-19 ｜ 状态：已接受 ｜ 影响：M2 实现方式与消息协议

## 背景

MVP 原计划桥接用 HTTP 轮询（最简闭环）。会话讨论确认：WebSocket 的增量代码量小，且官方 manifest 支持放行 `ws://localhost`；三能力依赖它——逐条操作直播（Agent→Figma 流式）、`documentchange` 事件回流（Figma→Agent）、暂停/恢复控制指令。

## 决策

M2 桥接直接定型为 **WebSocket 双工**，四类消息 `OP / RESULT / EVENT / CONTROL`（契约见 `spec/03`）。M1 阶段插件仍为手动模式，manifest 的 `devAllowedDomains` 预放行 ws+http，避免 M2 再改 manifest。

## 后果

- 正向：协议一次定型，避免返工；人机协同（层次二/三）能力顺势获得。
- 代价：桥接比轮询版本略复杂（连接生命周期、重连、token 握手）。
- 备选被否：HTTP 轮询（需二次返工协议层）；Figma 官方 MCP（写入需付费席位、无图片/自定义字体，见 spec/01）。
