# STATUS — figma-prototyper 进度快照

更新时间：2026-09-22（Asia/Shanghai）
当前切片：M7 — Code→Design（FUN-ACC-701~704，规划完成，实现 BACKLOG）

## 整体进度

- [x] M1 插件骨架（DONE：FUN-ACC-101~105 全部通过）
- [x] M2 WebSocket 双工桥接 + 暂停开关（DONE：FUN-ACC-201~204 契约测试 7/7，独立验收 ACCEPT；真机冒烟通过）
- [x] M3 CLI + 截图闭环（DONE：301/302 契约测试 + 303 运行时抽验 640×480 精确 2 倍）
- [x] M4 文字/图片/组件（DONE：401/402/403 运行时代跑通过 + 404 静态 pass + chars bug 修复）
- [x] M5 原型交互 + Skill（DONE：002 用户 Present 点按通过、003/501 过、wireReaction schema 修复真机复验通过）
- [x] M6a 设计 IR 通道（DONE：FUN-ACC-601/602 静态+契约测试 pass，独立验收 ACCEPT，测试 48 全绿）
- [x] M6b Design→Code 闭环（DONE：603/604 运行时证据齐——U11 画板全链路 toIR→合成→shot→对比 1 轮迭代收敛；测试 59 全绿）
- [ ] M7a 图层重建（BACKLOG：rebuild 确定性脚本生成器，FUN-ACC-701~702）
- [ ] M7b DOM 抽取（BACKLOG：extract CDP→IR，FUN-ACC-703~704，阻塞于 M7a）

## 当前工作

**M7 Code→Design 规划完成（2026-09-22）**：两项用户决策（D 先 C 后 / CDP 零新增依赖）→ ADR-0005；契约落 spec/02（逆向转换工作流）、spec/03（重建映射表 + extract 契约 + M7 路径所有权 + 测试缝）、spec/05（FUN-ACC-701~704）、spec/07（M7a/M7b BACKLOG）。实现未启动。

## 已知风险

- 运行时验收依赖用户手动导入插件（无法自动化 Figma 导入动作）。
- sandbox 同步脚本无硬超时，M2 看门狗就位前的已知限制（ADR-0003）。
- Figma 桌面端 `exportAsync` 对 clipsContent=false 画板导出区域失真（skill 坑 20，用 --rect 规避）。
