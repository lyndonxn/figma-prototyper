# STATUS — figma-prototyper 进度快照

更新时间：2026-09-22（Asia/Shanghai）
当前切片：M7 — Code→Design（M7a DONE；M7b BACKLOG）

## 整体进度

- [x] M1 插件骨架（DONE：FUN-ACC-101~105 全部通过）
- [x] M2 WebSocket 双工桥接 + 暂停开关（DONE：FUN-ACC-201~204 契约测试 7/7，独立验收 ACCEPT；真机冒烟通过）
- [x] M3 CLI + 截图闭环（DONE：301/302 契约测试 + 303 运行时抽验 640×480 精确 2 倍）
- [x] M4 文字/图片/组件（DONE：401/402/403 运行时代跑通过 + 404 静态 pass + chars bug 修复）
- [x] M5 原型交互 + Skill（DONE：002 用户 Present 点按通过、003/501 过、wireReaction schema 修复真机复验通过）
- [x] M6a 设计 IR 通道（DONE：FUN-ACC-601/602 静态+契约测试 pass，独立验收 ACCEPT，测试 48 全绿）
- [x] M6b Design→Code 闭环（DONE：603/604 运行时证据齐——U11 画板全链路 toIR→合成→shot→对比 1 轮迭代收敛；测试 59 全绿）
- [x] M7a 图层重建（DONE：FUN-ACC-701/702 pass——U11 IR 真机重建 44 节点与原稿等价；测试 67 全绿；IR schema 扩展 primary/counter/absolute）
- [ ] M7b DOM 抽取（BACKLOG：extract CDP→IR，FUN-ACC-703~704）

## 当前工作

**M7a 图层重建交付（2026-09-22）**：`figmapt rebuild` 确定性重建链路真机验证成立（U11 画板 IR → CR-U11-支付成功 画板，44 节点、字体零回退、结构/样式等价）。运行时迭代抓出并修复 IR 保真缺口（对齐语义/absolute、resize 顺序、默认填充）。下一步 T-07b（DOM 抽取 CDP→IR）。

## 已知风险

- 运行时验收依赖用户手动导入插件（无法自动化 Figma 导入动作）。
- sandbox 同步脚本无硬超时，M2 看门狗就位前的已知限制（ADR-0003）。
- Figma 桌面端 `exportAsync` 对 clipsContent=false 画板导出区域失真（skill 坑 20，用 --rect 规避）。
