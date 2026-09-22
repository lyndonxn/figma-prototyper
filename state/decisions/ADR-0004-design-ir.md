# ADR-0004 — Design→Code 采用 IR 中枢 + Agent 合成 + Chrome headless 对比

日期：2026-09-22 ｜ 状态：已接受 ｜ 影响：M6 验收 ID（FUN-ACC-601~604）、`spec/01/02/03` 修订

## 背景

用户决定纳入 Design↔Code 能力（对比 denki-san/local-figma 后的范围扩展）。可行路线：全规则 codegen（映射规则维护成本失控）、全 LLM 转换（结构易幻觉）、IR 确定性抽取 + LLM 合成。另需选定：转换方向顺序、目标形态、截图对比工具链。

## 决策（三项，均为用户 2026-09-22 明确选定）

1. **M6 只做 Design→Code 单方向**；Code→Design 预留 M7 候选，不预先定契约——IR 先在方向一实战中定稿，避免过早设计返工。
2. **目标形态 = HTML+CSS 单文件静态页**（零构建链，浏览器直开）；React 等留作未来 IR→X 适配器。IR 中组件层级保留，代码侧表达为嵌套 DOM。
3. **截图对比 = 系统 Chrome headless**（`--headless=new --screenshot`，零 npm 依赖）；运行时检测 Chrome 缺失 → 退出码 2 并提示降级手动模式。

架构形态：**IR 中枢**（`design-ir.json`，schema 见 `spec/03`）。抽取（toIR）确定性、合成（Agent 读 IR 写 HTML）由 LLM 承担判断、对比走既有截图闭环。Code→Design 届时复用同一 IR（DOM→IR→脚本生成器），不经 LLM。

## 后果

- 正向：结构与样式由 IR 确定性保证，LLM 只做字体映射等有限判断；`spec/01` 原"真实前端代码生成"非目标相应收窄为"工程级框架代码"仍非目标。
- 代价：新增 RESULT.data 通道与 `output/code/` 产物目录契约；保真目标为"结构等价 90%，像素级靠迭代"，不承诺 1:1。
- 许可证边界：本能力为自研设计，**不参考** local-figma（Apache-2.0）代码实现，仅借鉴公开文档中的思路。
