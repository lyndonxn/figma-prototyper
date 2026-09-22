# STATUS — figma-prototyper 进度快照

更新时间：2026-09-19（Asia/Shanghai）
当前切片：M1 — 插件骨架（FUN-ACC-101~105）

## 整体进度

- [x] M1 插件骨架（DONE：FUN-ACC-101~105 全部通过）
- [x] M2 WebSocket 双工桥接 + 暂停开关（DONE：FUN-ACC-201~204 契约测试 7/7，独立验收 ACCEPT；真机冒烟通过）
- [x] M3 CLI + 截图闭环（DONE：301/302 契约测试 + 303 运行时抽验 640×480 精确 2 倍）
- [x] M1 插件骨架（DONE：FUN-ACC-101~105 全部通过）
- [x] M2 WebSocket 双工桥接 + 暂停开关（DONE：FUN-ACC-201~204 契约测试 7/7，独立验收 ACCEPT；真机冒烟通过）
- [x] M3 CLI + 截图闭环（DONE：301/302 契约测试 + 303 运行时抽验 640×480 精确 2 倍）
- [x] M4 文字/图片/组件（DONE：401/402/403 运行时代跑通过 + 404 静态 pass + chars bug 修复）
- [x] M5 原型交互 + Skill（DONE：002 用户 Present 点按通过、003/501 过、wireReaction schema 修复真机复验通过）
- [x] M6a 设计 IR 通道（DONE：FUN-ACC-601/602 静态+契约测试 pass，独立验收 ACCEPT，测试 48 全绿）
- [x] M6b Design→Code 闭环（REVIEW：604 契约测试 + 603 机制侧 pass、独立验收 ACCEPT、测试 56 全绿；运行时待用户配合）

## 当前工作

**M6 Design→Code 收尾（2026-09-22）**：M6a DONE；M6b 机制与契约全部就绪（shot 子命令 + skill 第 7 节 Design→Code 工作流），运行时证据待用户：①终端跑一次 `node cli/figmapt.js shot` 真机冒烟（30 秒）②Figma 打开画板走全链路（toIR→合成→shot→对比）后 603/604 定 DONE。

## 已知风险

- 运行时验收依赖用户手动导入插件（无法自动化 Figma 导入动作）。
- sandbox 同步脚本无硬超时，M2 看门狗就位前的已知限制（ADR-0003）。
