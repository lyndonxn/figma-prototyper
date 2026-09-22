# STATUS — figma-prototyper 进度快照

更新时间：2026-09-22（Asia/Shanghai）
当前切片：M6 — Design→Code（FUN-ACC-601~604）**全部 DONE，M6 收官**

## 整体进度

- [x] M1 插件骨架（DONE：FUN-ACC-101~105 全部通过）
- [x] M2 WebSocket 双工桥接 + 暂停开关（DONE：FUN-ACC-201~204 契约测试 7/7，独立验收 ACCEPT；真机冒烟通过）
- [x] M3 CLI + 截图闭环（DONE：301/302 契约测试 + 303 运行时抽验 640×480 精确 2 倍）
- [x] M4 文字/图片/组件（DONE：401/402/403 运行时代跑通过 + 404 静态 pass + chars bug 修复）
- [x] M5 原型交互 + Skill（DONE：002 用户 Present 点按通过、003/501 过、wireReaction schema 修复真机复验通过）
- [x] M6a 设计 IR 通道（DONE：FUN-ACC-601/602 静态+契约测试 pass，独立验收 ACCEPT，测试 48 全绿）
- [x] M6b Design→Code 闭环（DONE：603/604 运行时证据齐——U11 画板全链路 toIR→合成→shot→对比 1 轮迭代收敛；测试 59 全绿）

## 当前工作

**M6 收官（2026-09-22）**：Design→Code 全链路已在真机验证成立：Figma 画板 → `toIR --ir-out` → Agent 按 skill 第 7 节合成 HTML+CSS 单文件 → `shot` 截图 → 与 Figma 基准对比迭代。日常使用入口：`skill/figma-prototyper-skill.md`（原型 = 第 2~6 节；Design→Code = 第 7 节）。可选延伸：Code→Design（M7 候选，未排期）、融合 P0 基建（任务 ID 异步/doctor/断线恢复）、push 远程（OPEN-1）。

## 已知风险

- 运行时验收依赖用户手动导入插件（无法自动化 Figma 导入动作）。
- sandbox 同步脚本无硬超时，M2 看门狗就位前的已知限制（ADR-0003）。
- Figma 桌面端 `exportAsync` 对 clipsContent=false 画板导出区域失真（skill 坑 20，用 --rect 规避）。
