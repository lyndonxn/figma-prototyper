# 05 — 功能验收

> 证据分两级：**静态**（命令/代码走查可证）与**运行时**（须 Figma 桌面端真实执行）。运行时条目在证据取得前，切片最多标 `REVIEW`，不得标 `DONE`。
> 编号约定：FUN-ACC-1NN=M1 插件、2NN=M2 桥接、3NN=M3 CLI、4NN=M4 素材能力、5NN=M5 Skill、6NN=M6 Design→Code；INT-ACC=面板交互验收（见 `04`）。编号与（已迁出的）原工作区仓库 FUN-ACC-001~006 分属不同项目，互不冲突。

**M1 插件骨架**

## FUN-ACC-101 manifest 合法可导入

Given `plugin/manifest.json`
When 解析 JSON 并核对字段
Then 含 `name`、`id`、`api:"1.0.0"`、`editorType:["figma"]`、`main:"code.js"`、`ui:"ui.html"`
And `networkAccess.allowedDomains` 为 `["none"]`，`devAllowedDomains` 同时含 `ws://localhost:8787` 与 `http://localhost:8787`（证据：静态）

## FUN-ACC-102 code.js 语法与执行包装

Given `plugin/code.js`
When `node --check` 与代码走查
Then 语法通过；脚本经 AsyncFunction 包装执行且整体 try/catch；失败路径回传 ok:false 且 message 为原样错误信息（证据：静态）

## FUN-ACC-103 ui.html 消息通路

Given `plugin/ui.html`
When 代码走查
Then 存在发送 `{pluginMessage:{type:'RUN_SCRIPT', code}}` 的通路；监听 RESULT 并以三态（成功/失败/执行中）渲染日志；面板预填示例脚本（证据：静态）

## FUN-ACC-104 运行时建框

Given Figma 桌面端已导入并运行本插件、用户在面板点击 Run（示例脚本）
When 脚本执行完成
Then 画布出现 320×240 Auto Layout Frame（含文本"M1 骨架 OK"）并自动缩放至视野，日志显示执行成功（证据：**运行时**）

## FUN-ACC-105 错误不崩溃

Given 面板中运行一段会 throw 的脚本
When 执行完成
Then 日志原样显示错误信息；Run 恢复可点；紧接运行正常脚本仍成功（证据：**运行时**）

**M2 桥接（规划中）**

## FUN-ACC-201 仅本地监听

Given 桥接启动
When 检查监听地址
Then 仅绑定 `127.0.0.1:8787`，无 token 的连接被拒（证据：静态+契约测试）

## FUN-ACC-202 WS 双工通路

Given 模拟插件客户端带 token 连接
When 桥接下发 OP
Then 模拟端收到 OP 载荷，回传 RESULT 后 CLI 侧得到 ok（证据：契约测试）

## FUN-ACC-203 暂停开关

Given CONTROL/PAUSE 已生效
When 提交新 Job
Then Job 保持 QUEUED 不下发；RESUME 后正常下发（证据：契约测试）

## FUN-ACC-204 EVENT 防抖

Given 插件密集上报 documentchange
When 桥接转发
Then 合并为批、频率不超过配置阈值（证据：契约测试）

**M3 CLI + 截图闭环（规划中）**

## FUN-ACC-301 阻塞等 ok

Given CLI 提交脚本文件
When Job 完成
Then 进程退出码 0，stdout 含截图文件路径（证据：契约测试）

## FUN-ACC-302 失败语义

Given 脚本 failed 或超时
When CLI 结束
Then 退出码非 0，stderr 含原错误（证据：契约测试）

## FUN-ACC-303 截图参数化

Given 导出请求带区域 rect 与 scale
When 插件 exportAsync
Then 仅导出该区域且分辨率符合 scale（证据：静态 + 运行时抽验）

**M4 文字/图片/组件（规划中）**

## FUN-ACC-401 字体与文本

Given 脚本先 `loadFontAsync` 再设置文本
When 运行
Then 文本正确渲染，缺字体时错误信息明确（证据：运行时）

## FUN-ACC-402 图片填充

Given 本地图片经桥接下发字节
When `createImage` 填充
Then 画布出现该图片（证据：运行时）

## FUN-ACC-403 组件化

Given 脚本创建组件
Then Figma 资产面板出现该组件，实例可复用（证据：运行时）

## FUN-ACC-404 节点树过滤导出

Given 读取请求带深度与字段白名单
Then 返回结构不含白名单外字段（证据：静态）

**M5 原型交互 + Skill（规划中）**

### INT-ACC-001 面板交互可达

- Decision: INT-001/INT-002/INT-003（`04` 交互登记）
- Trigger: Run 点击 / 脚本编辑 / 清空日志
- Starting state: 面板就绪、编辑区有脚本
- Expected transition: 执行中态 → 日志追加结果；清空 → 日志区为空；无动效依赖
- Alternate/reduced-motion behavior: 不适用（无动效）
- Evidence: 与 FUN-ACC-104/105 同一运行时证据

### INT-ACC-002 点击跳转（产出物原型）

- Decision: M5 reactions 脚本（`04` 原型交互节）
- Trigger: Present 模式点击源帧
- Starting state: 两帧间已设 reactions(ON_CLICK→NAVIGATE)
- Expected transition: 原型跳转至目标帧
- Alternate/reduced-motion behavior: 转场为即时切换亦算通过
- Evidence: **运行时**（用户 Present 演示）

### INT-ACC-003 reactions 读回校验

- Decision: M5 读回校验逻辑
- Trigger: 脚本设置 reactions 后校验
- Starting state: 目标节点缺失或触发器非法
- Expected transition: 校验报错并指出节点 id
- Alternate/reduced-motion behavior: 不适用
- Evidence: 静态

## FUN-ACC-501 Skill 可复现

Given 全新会话仅读 skill 文档
When 执行"用 figma-prototyper 在文件 X 做两套可点击方案"
Then 无需追问背景即可走完 Agent 循环（证据：运行时）

**M6 Design→Code（规划中，2026-09-22）**

## FUN-ACC-601 toIR 注入与 schema 一致性

Given 脚本调用 `toIR({rootId,depth,maxNodes})`（toIR 恒输出完整规范形，无 fields 筛选，见 `03`）
When 插件执行并回传
Then 返回 `{v:1,kind:'design-ir'}` 结构，字段仅含白名单集合，深度/节点数上限生效，超限带截断标记（证据：静态 + 契约测试）

## FUN-ACC-602 IR 与资产落盘

Given CLI 提交带 `--ir-out` 目录参数的 Job 且 Job 为 ok
When 桥接回传 RESULT.data
Then 该目录下 `design-ir.json` 合法可解析，图片资产落盘 `assets/` 且 HTML 可相对引用（证据：静态 + 契约测试）

## FUN-ACC-603 静态页产物

Given 合法 design-ir.json + skill 文档
When Agent 合成 HTML+CSS 单文件
Then 浏览器直接打开呈现与 IR 等价的布局结构与文本，图片为相对路径引用，无构建链依赖（证据：运行时）

## FUN-ACC-604 截图对比闭环

Given 产物 HTML 与 Figma exportAsync 截图
When `figmapt shot` 执行
Then 产出同视口 Chrome 截图，Agent 完成至少一轮"对比→修改→重截"迭代；Chrome 缺失时退出码 2 且提示明确（证据：运行时 + 契约测试）
