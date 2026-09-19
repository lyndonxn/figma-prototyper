# 04 — 视觉与交互

Design status: DRAFT

> 定性：本项目**无产品前端**；唯一视觉表面为插件工具面板 `ui.html`（开发者工具，非产品界面）。三方案视觉 ideate（Product Design 路由）不适用，记录为 N/A 而非跳过；若面板未来升级为产品化界面，本文件回 DRAFT 并走完整 Gate 6。

## Visual exploration manifest

- Mode: N/A — 工具型 UI（developer utility panel），无品牌视觉方向决策；依据 `01` 非目标与根工作区先例（根 spec/04 记录 N/A）。
- Visual batch: 未执行（N/A），唯一视觉标准 = 可读、可用。
- Selected visual: N/A。

## Design tokens and assets

- 无独立 token 体系；面板使用系统字体与中性灰配色；无图片资产。

## Page structure

### PAGE-001 插件管理面板（ui.html）

- Route/surface: Figma 插件 iframe 面板（约 360×460）
- Viewport sections: 1) 标题行（插件名 + 状态指示）→ 2) 脚本编辑区（预填示例）→ 3) Run 主操作 → 4) 日志区（追加式，最新在底部）
- Content priority: 主结果 = 一次脚本执行的成功/失败反馈，错误信息不截断
- Components/assets: textarea、button、log 列表；无外部资产
- Responsive structure: N/A（固定尺寸工具面板）
- States: 就绪 / 执行中（Run 禁用 + 防重复提交）/ 成功（成功日志）/ 失败（红色日志 + 恢复可点）
- Affordances: AFF-001, AFF-002, AFF-003

Structure status: APPROVED（来源：用户 2026-09-19 会话确认的 M1 范围——"粘贴脚本 → Run → 看结果"面板）

## Interaction coverage

| Affordance ID | Surface/control | Mapping | Coverage |
|---|---|---|---|
| AFF-001 | Run 按钮 | INT-001 | COMPLETE |
| AFF-002 | 脚本编辑框 | INT-002 | COMPLETE |
| AFF-003 | 清空日志 | INT-003 | COMPLETE |

Coverage status: COMPLETE

## Interaction decision register

### INT-001 运行脚本

- Category: control
- Surface/control: Run 按钮（AFF-001）
- Trigger: click
- Outcome: 面板进入执行中态，sandbox 执行脚本，日志追加成功/失败结果
- Materiality: INHERITED（标准工具行为）
- Option 1 (recommended): 单击执行 + 执行中禁用防重 | Trade-off: 不支持并发多脚本
- Option 2: 允许并发执行 | Trade-off: 画布操作交错，失败难归因
- Option 3: 执行前确认弹窗 | Trade-off: 高频迭代下徒增点击
- Selected option: Option 1
- Status: SELECTED
- Decision source: 用户 2026-09-19 会话确认的 M1 范围
- Dependencies: INT-002
- Relevant states: 执行中/成功/失败
- Acceptance: INT-ACC-001

### INT-002 编辑脚本

- Category: form
- Surface/control: 脚本 textarea（AFF-002）
- Trigger: 键盘输入
- Outcome: 编辑内容更新，作为 RUN_SCRIPT 载荷
- Materiality: INHERITED（标准文本编辑行为，无实质分叉）
- Option 1 (recommended): 自由编辑 + 预填示例脚本 | Trade-off: 无语法高亮
- Option 2: 外置脚本文件加载 | Trade-off: M1 引入文件 IO 复杂度
- Option 3: 只读固定示例 | Trade-off: 无法测试错误路径
- Selected option: Option 1
- Status: SELECTED
- Decision source: 标准工具惯例（低风险细节，按 wanan Gate 3 假设推进）
- Dependencies: INT-001
- Relevant states: focus
- Acceptance: INT-ACC-001

### INT-003 清空日志

- Category: control
- Surface/control: 清空日志（AFF-003）
- Trigger: click
- Outcome: 日志区清空，不影响画布与脚本
- Materiality: INHERITED（标准行为）
- Option 1 (recommended): 单击立即清空 | Trade-off: 误触丢日志
- Option 2: 二次确认 | Trade-off: 多一步操作
- Option 3: 不提供清空 | Trade-off: 长会话日志滚动难读
- Selected option: Option 1
- Status: SELECTED
- Decision source: 标准工具惯例
- Dependencies: none
- Relevant states: success
- Acceptance: INT-ACC-001

## 原型交互（M5 产出物，非面板 UI）

由脚本经 `node.reactions` 创建：跳转（NAVIGATE）、返回（BACK）、弹层（overlay）、URL；触发器 ON_CLICK/ON_HOVER 等；Smart Animate 依赖图层命名约定（见 `../CONTEXT.md`）。验收见 `05` INT-ACC-002/003。

## Frontend lock

- Lock: DRAFT — 工具型 UI，明确不进入 Gate 6 锁流程；升级产品化界面时本节重开。
- Approval source: 用户 2026-09-19 会话确认 M1 范围（面板结构如 PAGE-001）
- Revision: v1（M1）
- Contract fingerprint: fp-figma-prototyper-m1-utility-ui-v1
