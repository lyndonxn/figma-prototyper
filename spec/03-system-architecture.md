# 03 — 系统架构

## 组件与数据流

```
用户 ──目标/规范──▶ Agent(ZCode)
                      │ 生成脚本
                      ▼
                   CLI (M3) ──POST/WS──▶ 桥接 Bridge (127.0.0.1:8787, M2)
                                            │ OP 下发 ▲ RESULT/EVENT 回传
                                            ▼        │
                                        插件 ui.html ──postMessage──▶ 插件 code.js (sandbox)
                                                                          │ Plugin API
                                                                          ▼
                                                                    Figma 画布
                                                                          │ exportAsync
                                                                          ▼
                                                                    截图落盘 → Agent Read
```

## 插件文件契约（M1）

| 文件 | 环境 | 职责 |
|---|---|---|
| `plugin/manifest.json` | — | 插件声明；`editorType:["figma"]`；`networkAccess.allowedDomains:["none"]`，`devAllowedDomains` 放行 `ws://localhost:8787` + `http://localhost:8787` |
| `plugin/code.js` | sandbox | `showUI` 挂载面板；监听 `RUN_SCRIPT`，用 **AsyncFunction** 包装执行（`figma` 作实参注入），try/catch 全覆盖，`RESULT{ok,message}` 回传 UI |
| `plugin/ui.html` | iframe | M1：脚本编辑框（预填示例）+ Run + 日志区；向 sandbox 发 `{pluginMessage:{type:'RUN_SCRIPT',code}}`，监听 RESULT 渲染（成功/失败/执行中三态） |

已知限制（记录于 ADR-0003）：sandbox 内同步 eval 无法被外部硬超时打断；看门狗在 M2 由桥接 Job 级超时承担。

## WS 消息协议（M2 定型）

四类消息，JSON，均含 `{v:1, kind, id, ts, ...}`：

| kind | 方向 | 载荷要点 |
|---|---|---|
| `OP` | 桥接→插件 | `{jobId, code}`（Agent 脚本） |
| `RESULT` | 插件→桥接 | `{jobId, status:'ok'\|'failed', message, screenshotBase64?, screenshotError?}`；桥接落盘后对 CLI 响应 `screenshotPath` |
| `EVENT` | 插件→桥接 | `{type:'documentchange', batch:[...]}`（防抖合并后） |
| `CONTROL` | 双向 | `{action:'pause'\|'resume'\|'shutdown'}` |

鉴权：WS 连接握手带 `?token=`，token 由 CLI/桥接每次会话临时生成，不落盘。

## 设计 IR 契约（M6 定型）

- 格式：`{v:1, kind:'design-ir', root:{...}}`；节点字段：`type(frame|text|image|component|instance)`、`name`、`bounds{x,y,width,height}`（相对父节点坐标，mode:none 或 absolute 时用于绝对定位）、`absolute`（可选，auto-layout 父帧内绝对定位的子节点，M7 扩展）、`layout{mode,gap,padding,primary,counter}`（自动布局 ↔ flex 语义，mode 即方向：none/horizontal/vertical；primary/counter 为对齐语义 min/center/max/between|baseline，仅非默认 MIN 时出现，M7 扩展）、`style{fills,strokes,radius,effects,font}`、`text`（type=text 时的文本内容）、`asset`（type=image 时的资产键，对应 assets/ 下文件名）、`children[]`。字段白名单与截断标记继承 readTree（M4）；与 readTree 的差异：toIR 恒输出完整规范形，不支持 fields 筛选（下游是代码合成，需全量结构）。
- 通道：RESULT 新增可选 `data` 字段（脚本返回值的 JSON 序列化，大小上限与截图同量级）；CLI `--ir-out` 指定落盘目录，写入 `design-ir.json` 与 `assets/`（exportAsync PNG，HTML 用相对路径引用，不内联 base64）。
- 代码合成由 Agent 完成（skill 固化工作流），系统内不做规则化 codegen 组件；截图对比由 CLI `shot` 子命令包装 `chrome --headless=new --screenshot`，Chrome 缺失时退出码 2 并提示降级。成功判据为**截图文件落盘稳定**（不依赖 Chrome 进程退出——真 Chrome headless=new 写完截图可能常驻），默认 30s 超时（`--timeout ms` 可调），超时退出码 1。

## 逆向转换契约（M7 定型，Code→Design）

- **重建映射表（M7a，确定性，无 LLM）**——IR 节点 → Plugin API：
  - `type:frame` → `createFrame`；`layout.mode` horizontal/vertical → `layoutMode` + `itemSpacing`(gap) + `paddingTop/Right/Bottom/Left`；`layout.primary/counter` → `primaryAxisAlignItems`/`counterAxisAlignItems`（M7 扩展，重建居中/两端对齐语义）；`mode:none` → 绝对定位（`bounds.x/y` + `resize`，子节点 bounds 为相对父坐标）；auto-layout 父帧内 `absolute:true` 子节点 → `layoutPositioning='ABSOLUTE'` + bounds 摆位
  - `type:text` → `createText`（先 `loadFontAsync`，回退策略见 `02`）；`text`、`style.font`(family/style/size) 直映
  - `type:image`（或含图片填充的叶节点）→ `createRectangle`/`createFrame` + `createImage(bytes)` imagePaint；字节经 M4 images 通道下发（键=IR asset 名），**脚本内不内嵌 base64**
  - `style.fills/strokes` → SOLID（hex+opacity）；`radius` → `cornerRadius`；`type:component|instance` → 按 frame 重建并计入 `skipped`（诚实降级，组件保真留待后续）
- **重建产物（M7a）**：当前页面新建顶层画板，命名 =（`--name` 前缀，缺省 `CR-`）+ 原 root name（同名冲突自动加 `.rN` 数字后缀）；不修改/不删除任何既有节点；脚本 return `{frameId, created, skipped, fontFallbacks[]}`（RESULT.data 通道）。`--dry-run` 输出脚本到 stdout 不提交（确定性测试缝）。已知边界：IR 未捕获描边粗细（strokeWeight），重建描边默认 1px；IR 超 maxNodes 的分块重建为 Agent 级指引（skill 坑），CLI 不自动切分；矢量图形（Vector）按实心包围盒近似重建，不还原路径（skill 坑 26）；IR 无 fills 的帧重建为透明（清除 createFrame 默认白填充）。
- **DOM 抽取（M7b）**：CLI `extract` 拉起系统 Chrome `--headless=new --remote-debugging-port`，经 CDP `DOM.getDocument`+`DOM.getFlattenedDocument`、`CSS.getComputedStyleForNode`、`DOM.getBoxModel` → 映射为 IR schema v1（与 toIR 同构）。`ws` 加入 cli/package.json（无传递依赖），bridge/plugin 零改动。输入支持 `file://` 与 `http(s)://`；Chrome 缺失 → 退出码 2（语义同 `shot`）。

## 文件路径所有权

| 切片 | 拥有路径 |
|---|---|
| M1 | `plugin/**`、`README.md` |
| M2 | `bridge/**`、`plugin/ui.html`（扩展 WS 客户端）、`plugin/code.js`（控制器授权微改：RESULT 透传 jobId）、`plugin/manifest.json`（如需） |
| M3 | `cli/**`、`bridge/**`（截图端点与落盘）、`screenshots/`（运行产物，gitignore）、`plugin/code.js`（截图捕获）、`plugin/ui.html`（OP 携带截图参数透传） |
| M4 | `plugin/code.js`（readTree/images 注入）、`plugin/ui.html`（images 透传）、`bridge/**`（images 限额 + PNG 签名校验）、`cli/**`（--image）；`skill/` 归 M5 |
| M5 | `plugin/**`、`skill/` |
| M6a | `plugin/code.js`（toIR 注入 + 资产导出）、`plugin/ui.html`（ir 参数透传）、`bridge/**`（RESULT.data 通道）、`cli/**`（--ir-out） |
| M6b | `cli/**`（shot 子命令）、`skill/`（Design→Code 工作流节）、`output/code/`（产物，gitignore） |
| M7a | `cli/**`（rebuild 子命令 + 脚本生成器）、`skill/`（Code→Design 工作流节） |
| M7b | `cli/**`（extract 子命令 + CDP 客户端 + cli 侧 ws 依赖）、`skill/`（对应小节增补） |

## 安全边界

- 桥接仅绑 `127.0.0.1`；无 token 的 WS/HTTP 请求一律拒绝。
- 脚本在 sandbox 执行，无网络能力（manifest `allowedDomains:["none"]`），不能外发数据。
- 执行前核对目标文件/页面标识（CLI 参数 → Job 载荷 → 脚本内断言）。
- 会话结束：shutdown + token 失效。

## 测试缝

- 静态：`node --check plugin/code.js`；`JSON.parse(manifest)`；桥接/CLI 用 node 原生 `node:test`。
- 契约：M2 用本地 WS 客户端模拟插件做集成测试（不依赖 Figma）。
- 运行时：Figma 桌面端人工验证（FUN-ACC-104/105、INT-ACC-002），证据为截图 + 用户确认。
- M6 契约：toIR/RESULT.data 用 node:test 桩测（不依赖 Figma）；`shot` 子命令用本地 HTML fixture 验证（不依赖 Figma）；产物对比须运行时证据。
- M7 契约：rebuild 脚本生成器用 `cli/test/fixtures/` 自建 IR fixture（node:test 断言生成脚本关键调用序列 + 确定性 golden 对比，不依赖 Figma）；`extract` 的 CDP 对接用桩 Chrome 或注入式 CDP 客户端桩测；重建/往返等价性须运行时证据。
