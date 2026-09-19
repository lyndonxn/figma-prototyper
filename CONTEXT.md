# CONTEXT — 术语表

| 术语 | 含义 |
|---|---|
| Agent | 驱动本系统的 AI（ZCode 等），负责理解目标、生成操作脚本、查看截图并迭代 |
| 插件 | 装进 Figma 桌面端的自定义开发插件，本系统的"执行器"，通过官方 Plugin API 操作画布 |
| sandbox / code.js | 插件的沙箱 JS 环境：持有 `figma` API（可操作画布），**不能**发网络请求 |
| UI iframe / ui.html | 插件的 iframe 环境：**能**访问本地网络（桥接），碰不到 `figma` API；两者仅经 `postMessage` 互通 |
| 桥接（Bridge） | 本地 Node 服务，仅绑 `127.0.0.1:8787`；M2 起为 WebSocket 双工：上行 OP 下发、下行 RESULT/EVENT、CONTROL 控制指令 |
| Job | 一次脚本执行任务。状态机：`QUEUED → CLAIMED → RUNNING → OK | FAILED`；`ok` 之外的终态语义一律视为"未完成" |
| OP / RESULT / EVENT / CONTROL | 四类 WS 消息：操作下发 / 执行结果 / 画布事件流（documentchange 等）/ 控制（暂停、恢复、关停） |
| 运行时验证 | 必须在 Figma 桌面端真实执行才能取得的证据（人工配合），与静态检查（node --check、JSON 解析）相对 |
| Token 预算 | Agent 侧模型调用的成本控制约束：截图裁剪缩放、脚本批量操作、节点树过滤导出、上下文分阶段落盘（ADR-0002） |
| reactions | Plugin API 中原型交互属性（触发器 + 动作），可写；用于 M5 连接页面跳转/返回/弹层 |
| Smart Animate 匹配约定 | 两帧中同名同结构图层在原型转场时自动匹配的命名规范（M5） |
