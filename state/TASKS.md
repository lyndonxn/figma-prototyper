# TASKS — figma-prototyper 任务板

> 认领格式：认领人=agent标识、日期=YYYY-MM-DD。状态机见 `../spec/02-domain-and-workflows.md` 与工作区根协议。

| ID | 任务 | 状态 | 认领人 | 日期 | 验收 ID | 备注 |
|---|---|---|---|---|---|---|
| T-01 | M1：插件骨架（manifest + 双环境 postMessage + 手动脚本建 Frame） | DONE | controller@zcode | 2026-09-19 | FUN-ACC-101~105 | 101~103 静态 pass（独立验收 ACCEPT）；104/105 运行时 pass（用户实测：320×240 + 错误路径红色日志不崩溃、可连续运行） |
| T-02 | M2：WebSocket 双工桥接 + token + 暂停开关 + EVENT 防抖 | DONE | controller@zcode | 2026-09-19 | FUN-ACC-201~204 | 契约测试 7/7 pass（node:test），独立验收第一轮 ACCEPT；真机冒烟已通过（用户确认连接成功） |
| T-03 | M3：CLI + 截图闭环（裁剪/缩放参数化） | DONE | controller@zcode | 2026-09-19 | FUN-ACC-301~303 | 301/302 契约测试 pass；303 运行时抽验 pass（controller 代跑：16:6 节点 @2x → 640×480 精确、区域正确） |
| T-04 | M4：文字/图片/组件/字体 + 节点树过滤 | DONE | controller@zcode | 2026-09-19 | FUN-ACC-401~404 | 401/402/403 运行时代跑通过（中英文字体渲染 / 真实图片填充 / 组件+实例+readTree 结构）；404 静态 pass。运行中发现并修复 readTree chars 属性名 bug（node.chars→node.characters，vm 回归 22/22，真机复验随 M5 插件重载） |
| T-05 | M5：原型交互 reactions + Skill 固化 | DONE | controller@zcode | 2026-09-19 | INT-ACC-002~003, FUN-ACC-501 | 002 用户 Present 点按通过（"能跳"）；003 校验矩阵 + wireReaction 修复真机复验通过；501 全新子代理仅读 skill 零提问独立完成两页可点击原型（并抓出 action schema bug，已修复） |
| T-06a | M6a：设计 IR 通道（toIR 注入 + RESULT.data + --ir-out 落盘） | DONE | M6a-impl agent-de9e389f / 验收 agent-d06305c5 | 2026-09-22 | FUN-ACC-601~602 | 601/602 静态+契约测试 pass（独立验收 ACCEPT）；测试 40→48 全绿（bridge 35 + cli 13）；验收建议已回填 spec/03（text/asset 字段枚举）与 spec/05（fields 语义：toIR 恒发完整规范形）；603/604 运行时项属 M6b |
| T-06b | M6b：Design→Code 闭环（Agent 合成 HTML+CSS + Chrome headless 对比） | DONE | M6b-impl agent-7f299de2 / 验收 agent-165cab9a / 复审 agent-1ab8a6f4、agent-2f2a873a | 2026-09-22 | FUN-ACC-603~604 | **603/604 运行时证据齐（2026-09-22 Figma 全链路实测）**：U11-支付成功画板（37:249）toIR→IR 落盘→Agent 合成 HTML 单文件→shot 390×844→与 Figma 基准并排对比，1 轮迭代（wifi 图标）后收敛，布局/文本/间距/配色等价（产物 output/code/m6-u11/）。运行时另抓出两缺陷已修复+复审 ACCEPT（agent-2f2a873a）：①toIR 缺 bounds 字段（spec/03 契约 M6b 回填晚于验收）②shot 旧输出文件误判稳定（预清理修复）。测试 48→59 全绿（bridge 35 + cli 24，真 Chrome 冒烟 skip 项另证）。新增坑 20：clipsContent=false 画板 --node 导出失真改用 --rect |
| T-07a | M7a：图层重建（figmapt rebuild——IR→沙箱脚本确定性生成器 + skill Code→Design 工作流节） | BACKLOG | — | — | FUN-ACC-701~702 | 2026-09-22 新增，阻塞于用户启动指令；fixture 用 output/code/m6-site/src/ 已验证 IR；映射表见 spec/03 逆向转换契约 |
| T-07b | M7b：DOM 抽取（figmapt extract——系统 Chrome + CDP→IR，cli 引入 ws） | BACKLOG | — | — | FUN-ACC-703~704 | 阻塞于 T-07a（D 先 C 后，ADR-0005）；CDP 桩测不依赖 Figma，运行时往返等价（704）需 Figma+Chrome |

## 已完成记录

- **T-01~T-05 全部 DONE（2026-09-19，项目交付）**：M1 插件骨架 / M2 WS 双工桥接 / M3 CLI+截图闭环 / M4 素材能力 / M5 原型交互+Skill。全部验收 ID 通过（FUN-ACC-101~501、INT-ACC-001~003），每切片经独立子代理验收，关键能力均有真机运行时证据。

- T-01 于 2026-09-19 完成（DONE）：静态独立验收 ACCEPT + 用户运行时实测（320×240、错误路径），证据见 `HANDOFF.md` 验证节；提交 1df946d、61c140d 及 M1-DONE 提交。
- T-02 于 2026-09-19 完成（DONE）：bridge WS 双工 + token + 暂停 + 防抖 + ui.html WS 客户端；契约测试 7/7（node:test），独立验收第一轮 ACCEPT（含 203"pause 期间零 OP"等真实断言核验）；FUN-ACC-201~204 证据级别为静态+契约测试，符合 spec/03 测试缝定义。
- T-03 于 2026-09-19 完成（DONE）：CLI + 截图三模式 + 桥接落盘；契约测试 bridge 10/10 + cli 8/8，独立验收 ACCEPT；运行时抽验由 controller 代跑（真机全链路：CLI→桥接→插件→Figma→PNG 640×480 精确 2 倍），证据 `screenshots/job-60e54a9e-88d5-4294-b555-c2a4c1133f33.png`。
