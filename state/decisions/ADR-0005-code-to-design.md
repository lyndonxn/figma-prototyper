# ADR-0005 — Code→Design 采用 D 先 C 后 + CDP 零新增依赖抽取

日期：2026-09-22 ｜ 状态：已接受 ｜ 影响：M7 切片划分（M7a/M7b）、验收 ID（FUN-ACC-701~704）、`spec/01/02/03` 修订

## 背景

M6 收官后用户指令"方向一完成就开始方向二"。Code→Design 的两个组成：DOM 抽取（页面 → IR）与图层重建（IR → Figma 可编辑图层）。需选定：切片先后、DOM 抽取引擎。

## 决策（两项，均为用户 2026-09-22 明确选定）

1. **切片顺序 = D 先（图层重建），C 后（DOM 抽取）**：M7a 用 `output/code/m6-site/src/` 已验证 IR 做 fixture 先交付重建能力（零新依赖、不碰 DOM、可独立验收）；M7b 再补 DOM 抽取。收益：最快拿到可演示价值，且 extract 的 IR 输出有下游（rebuild）实战检验后才定稿对齐。
2. **DOM 抽取引擎 = 系统 Chrome + CDP**（`--remote-debugging-port` + `DOM.getDocument`/`CSS.getComputedStyleForNode`/`DOM.getBoxModel`）：**零新增依赖家族**——`ws` 已在桥接依赖树（v8，无传递依赖），cli/package.json 引入即可，不引 Playwright（数百 MB 浏览器下载，与 ADR-0004 截图侧"不引 Playwright"决策保持一致）。

## 后果

- 正向：重建为确定性脚本生成器（无 LLM，同 IR 重跑字节一致），保真可测可回滚；双向共用同一 IR schema（M6 已实战定稿），M7b 只是把抽取源从 Figma 换成浏览器。
- 代价：CDP 对接代码自写（比 Playwright 多约一个切片内单元的工作量）；cli 从纯零依赖变为引入 `ws`（唯一例外，记录在案）。
- 边界：重建新建 `CR-` 前缀画板、不触碰既有节点；component/instance 按 frame 诚实降级；保真目标"结构/样式等价"，不承诺像素 1:1。
- 许可证边界：延续 ADR-0004——自研实现，不参考 local-figma（Apache-2.0）代码。
