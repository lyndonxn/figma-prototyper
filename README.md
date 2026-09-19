# figma-prototyper

Agent + Figma 插件实时原型系统：AI Agent 通过本地桥接 + 自定义 Figma 插件，在**免费版 Figma** 上创建设计、连原型交互，并以截图闭环自校验。

规则与验收见 [AGENTS.md](AGENTS.md) 与 [spec/](spec/README.md)；当前进度见 [HANDOFF.md](HANDOFF.md)。

## 目录结构

```
figma-prototyper/
├── AGENTS.md          # 项目规则（继承工作区根 AGENTS.md）
├── spec/              # 契约：范围/工作流/架构/验收/路线图
├── state/             # 任务板、进度快照、ADR
├── plugin/            # Figma 插件（manifest + code.js + ui.html：脚本执行/截图/readTree/images/wireReaction）
├── bridge/            # 本地桥接服务（M2：127.0.0.1 + 临时 token，截图落盘 screenshots/）
├── cli/               # Agent 提交任务的 CLI（M3 起：run --node/--rect/--scale/--image）
├── skill/             # Agent Skill 文档（M5）：全新会话只读即可复现全流程
└── HANDOFF.md
```

## M1 快速开始（手动模式）

1. 打开 Figma 桌面端，进入任意有编辑权限的文件；
2. 菜单 `Plugins → Development → Import plugin from manifest…`，选择 `plugin/manifest.json`；
3. 运行 `Plugins → Development → Figma Agent Prototyper (Dev)`；
4. 面板中已预填示例脚本（创建一个 Auto Layout Frame），点击 **Run**；
5. 画布出现 320×240 Auto Layout Frame（含文本"M1 骨架 OK"）并自动缩放至视野、日志显示成功信息（含 Frame id）即 M1 通过。

## 原型交互（M5）

脚本环境注入 `wireReaction` 助手，为节点连原型交互（**覆盖式**写入 `node.reactions`，返回写入后读回结果）：

```js
// 点击跳转（trigger 缺省 ON_CLICK）
await wireReaction({ sourceId: '<按钮id>', action: 'NAVIGATE', destinationId: '<目标帧id>' });
// 返回（无 destinationId）
await wireReaction({ sourceId: '<按钮id>', action: 'BACK' });
// Smart Animate 转场（可选 animation，duration 单位毫秒；两帧同名同结构图层自动匹配补间）
await wireReaction({
  sourceId: '<按钮id>', action: 'NAVIGATE', destinationId: '<目标帧id>',
  animation: { type: 'SMART_ANIMATE', duration: 300, easing: 'EASE_OUT' },
});
```

- `trigger`：`ON_CLICK`（缺省）/ `ON_HOVER` / `ON_PRESS`；`action`：`NAVIGATE`（需 `destinationId`）/ `BACK`；转场类型：`SMART_ANIMATE`/`DISSOLVE`/`MOVE_IN`/`MOVE_OUT`/`SLIDE_IN`/`SLIDE_OUT`/`PUSH`（不传 animation = 瞬时切换）；`easing`：`LINEAR`/`EASE_IN`/`EASE_OUT`/`EASE_IN_AND_OUT`/`GENTLE`/`QUICK`/`SLOW`/`BOUNCY`（缺省 `EASE_OUT`）。
- 校验失败立即报错且不写入，错误消息含相关节点 id 或允许值列表（INT-ACC-003）；对同一节点多次调用是**覆盖不是追加**。
- **验收方式（INT-ACC-002）**：在 Figma 中选中起始帧 → 右上角 **Present（▶ 播放）**，点按按钮验证跳转/返回/动效；转场为即时切换亦算通过。
- 完整 Agent 工作流（连接桥接 → 读设计 → 出 ≥2 套方案 → 截图自查 → 连线 → 交付）见 **[skill/figma-prototyper-skill.md](skill/figma-prototyper-skill.md)**。

## 安全

- 桥接仅监听 `127.0.0.1`，每次会话临时 token（M2 起）；
- 插件不访问任何外部域名（`allowedDomains: ["none"]`，仅开发期放行本地桥接）；
- 使用结束关闭桥接并清理 token。
