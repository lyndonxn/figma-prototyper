# figma-prototyper Skill — Agent 驱动 Figma 产出可点击原型

> **自包含 runbook（FUN-ACC-501）**：本文档面向"从未接触过本项目的全新会话"。只读本文，无需追问任何背景，即可完成：连接 Figma 桌面端 → 读现有设计 → 批量创建/修改 ≥2 套方案 → 截图自查迭代 → 连原型交互（点击跳转/返回/动效）→ 交付用户验收。
> 运行前提：本机已安装 Figma 桌面端 + Node ≥ 24；项目位于 `figma-prototyper/`（下文所有相对路径以此为根）。

## 0. 30 秒速查

```
1. Figma 桌面端打开目标文件，运行插件（Plugins → Development → Figma Agent Prototyper (Dev)）
2. 终端A：cd figma-prototyper/bridge && node server.js   → 复制 stdout 的 TOKEN
3. 面板粘贴 TOKEN → 点「连接」→ 显示「已连接」
4. 终端B：export FIGMA_BRIDGE_TOKEN=<TOKEN>
5. 循环：写脚本存 /tmp/xx.js → node cli/figmapt.js run /tmp/xx.js [--node <id> --scale 2]
         → 读 Screenshot 路径看图 → 改脚本重提（批量！）
6. 交互：await wireReaction({sourceId, action:'NAVIGATE', destinationId}) / {action:'BACK'}
7. 交付：告知用户在 Figma 里点 Present（▶）逐帧点按验收
```

---

## 1. 前置条件

> **分工原则**：桥接的启动/自检/等待上线由 **Agent 自动完成**（第 0 步）；**用户只做两件事**——打开 Figma 目标文件、运行插件面板（面板会自动配对连接，无需粘贴 token）。

1. **用户：打开 Figma 桌面端**目标文件（需编辑权限；免费版可用；浏览器版不支持本地开发插件）。
2. **首次使用需导入插件**：Figma 菜单 `Plugins → Development → Import plugin from manifest…`，选择 `figma-prototyper/plugin/manifest.json`。
3. **用户：运行插件** `Plugins → Development → Figma Agent Prototyper (Dev)`——面板打开后会**自动配对连接**本机桥接（日志出现「已连接 ws://localhost:8787」）。若显示「未发现本机桥接」，说明桥接没启动——告诉 Agent 即可。
4. **Agent：环境自检与启动（第 0 步，无需用户参与）**：

   ```bash
   # a. 桥接活着吗？
   curl -s http://127.0.0.1:8787/health
   # 不通则后台启动并等它就绪：
   cd figma-prototyper/bridge && (node server.js > /tmp/figma-bridge.log 2>&1 &) && sleep 1
   curl -s http://127.0.0.1:8787/health   # 期望 {"ok":true}

   # b. 插件上线了吗？
   curl -s http://127.0.0.1:8787/status   # 期望 {"ok":true,"pluginConnected":true,...}
   # pluginConnected=false → 请用户运行插件面板（上方 1-3），轮询直到 true 再开工
   ```

5. **Agent：取 token 供 CLI 使用**：`export FIGMA_BRIDGE_TOKEN=$(curl -s http://127.0.0.1:8787/token | sed 's/.*"token":"\([^"]*\)".*/\1/')`（面板也用同一机制自动配对，用户全程无需接触 token）。
6. **手动回退**（自动配对不可用时）：`node server.js` 的 stdout 会打印 `TOKEN: <hex>`，粘贴进面板点「连接」——旧流程仍然完整可用。
7. **收尾**：任务结束 Agent 可发 CONTROL/shutdown 关桥接，或留给用户 `Ctrl+C`。

## 2. Agent 工作流（核心循环）

### a. 读现有设计——`readTree`

先了解画布上已有什么，再动手改。`readTree` 注入脚本环境，必须 `await`：

```js
const tree = await readTree({
  rootId: '<页面或某帧的id>',   // 缺省 = 当前页
  depth: 2,                     // 缺省 3，硬上限 10（root 为第 0 层）
  fields: ['id', 'name', 'type', 'width', 'height', 'chars'],  // 与白名单取交集
  maxNodes: 300,                // 缺省 500，硬上限 2000；超出截断 truncated:true
});
return JSON.stringify({ count: tree.count, truncated: tree.truncated, root: tree.root });
```

- 可用字段白名单：`id, name, type, x, y, width, height, visible, opacity, chars, fontSize, fontName, layoutMode, itemSpacing, paddingLeft/Right/Top/Bottom, cornerRadius, componentId, components, fillSummary`。缺省输出核心集（够定位/建组件/查填充）。
- **预算纪律**：大文件先 `depth: 1` 探路，看 `truncated` 与顶层结构再决定下钻范围；只请求用得到的字段。
- 节点 id 形如 `11:6`，后续 `--node`、`wireReaction` 都用它。

### b. 出 ≥2 套方案 → 逐套生成脚本

基于 a 的信息，先想出 **≥2 套差异化方案**（布局/风格/结构要有明显区别，便于用户挑选），然后每套写一个脚本文件（如 `/tmp/scheme-a.js`、`/tmp/scheme-b.js`）：

- 每套方案一个 Frame 容器（命名如 `方案A-首页`），所有元素装进该 Frame；多套方案 x 坐标错开并排摆放。
- **脚本必须批量**：一个脚本完成该方案全部节点 + 文本 + 连线，而不是建一个节点跑一次（每轮 CLI 调用 = 一张截图 + 一份脚本的 token 成本）。
- 建议写成**幂等**的（先按名字查已存在节点，存在则复用），这样重复提交安全，自查阶段可直接带截图参数重跑同一脚本。
- 脚本环境规范见第 3 节。

### c. 提交脚本——CLI

```bash
cd figma-prototyper    # CLI 相对路径以此为准
node cli/figmapt.js run /tmp/scheme-a.js
```

- stdout 成功形态：

  ```
  OK <jobId>
  Message: <脚本的 return 值>        ← 把节点 id 写进 return，后续步骤从这里拿
  Screenshot: /abs/path/screenshots/job-<jobId>.png   ← 仅带 --node/--rect 时出现
  ```

- 可选参数：
  - `--node <id>`：对指定节点导出 PNG；`--rect x,y,w,h`：按页面绝对坐标区域导出（二者互斥）；
  - `--scale N`：导出倍数（配合 --node/--rect，如 2 = 2 倍分辨率）；
  - `--image <名称>=<路径>`：下发本地图片素材，可重复（见第 5 节坑 5）；
  - `--timeout 60000`：Job 超时毫秒数（缺省 30000，长脚本调大）。
- 退出码：`0`=成功；`1`=脚本失败/超时（stderr 显示 `FAILED: <原样错误>`）；`2`=参数错误或连不上桥接。

### d. 看图自查 → 改脚本重提

```bash
node cli/figmapt.js run /tmp/scheme-a.js --node <方案A帧id> --scale 2
```

读 stdout `Screenshot:` 行给出的**绝对路径**，用文件查看工具打开 PNG，逐项自查：布局是否按方案意图、文字是否渲染（含中文）、间距对齐、配色。不满意 → 修改脚本 → 重新 `run`。

> **强调：批量操作减少轮数。** 每轮重提尽量携带全部要改的点（一个脚本里一次改完），不要发现一个改一个。幂等脚本重跑无副作用。

### e. 交互连线——`wireReaction`

在建节点同一脚本里（继续批量）给按钮/帧连原型交互，必须 `await`：

```js
// 跳转：源帧上的按钮 → 目标帧（trigger 缺省 ON_CLICK）
await wireReaction({ sourceId: '<按钮A的id>', action: 'NAVIGATE', destinationId: '<目标帧B的id>' });

// 返回：目标帧上的按钮 → 上一帧（BACK 无 destinationId）
await wireReaction({ sourceId: '<按钮B的id>', action: 'BACK' });

// 带转场（可选 animation）
await wireReaction({
  sourceId: '<按钮A的id>', action: 'NAVIGATE', destinationId: '<目标帧B的id>',
  animation: { type: 'SMART_ANIMATE', duration: 300, easing: 'EASE_OUT' },  // duration 单位毫秒
});
```

参数速查：

| 参数 | 允许值 / 说明 |
|---|---|
| `trigger` | 缺省 `ON_CLICK`；可选 `ON_HOVER`、`ON_PRESS` |
| `action` | `NAVIGATE`（需 `destinationId`）或 `BACK`（无 destinationId；多余的 destinationId/animation 会被忽略） |
| `animation.type` | `SMART_ANIMATE` / `DISSOLVE` / `MOVE_IN` / `MOVE_OUT` / `SLIDE_IN` / `SLIDE_OUT` / `PUSH`；**当前 Figma schema 要求 NAVIGATE 必带 transition——一律显式传 animation**（实测 2026-09-19：不带会被拒绝 "Required value missing at actions[0].transition"） |
| `animation.easing` | `LINEAR` / `EASE_IN` / `EASE_OUT` / `EASE_IN_AND_OUT` / `GENTLE` / `QUICK` / `SLOW` / `BOUNCY`；缺省 `EASE_OUT` |
| `animation.duration` | 毫秒，缺省 300 |

- **覆盖式**：对同源节点多次调用 `wireReaction` 是**替换**不是追加（最后一次生效）。
- **返回值**：`{sourceId, reactions:<写入后读回数组>, destinationId?}`。读回数组含复数 `actions` 字段，同时会看到一个废弃的单数 `action` 镜像——那是 Figma 存储层的正常现象，不用管。
- **重要**：当前 Figma 桌面端已**废弃** reactions 的单数 `action` 写法（写入时报 "Please update the 'actions' field…prevent data loss"）。`wireReaction` 内部已处理（写复数 `actions`），**优先用它**；若必须手写 `node.reactions`，见坑 10。
- 校验失败会 throw，错误消息包含相关节点 id 或允许值列表——按提示改参数重跑即可。
- **Smart Animate 命名约定**：两帧中**同名同结构**的图层自动匹配做补间。做法：源帧与目标帧里的对应图层取**相同 name**（如都叫 `card`、`title`、`btn`），属性差异（位置/大小/颜色）就会被动画。

### f. 交付

全部方案 + 连线完成后，向用户交付：

1. 各方案 Frame 的名称与节点 id（从各脚本 return 摘要汇总）；
2. 连线清单（哪个按钮 → 哪帧，什么触发/转场）；
3. 自查截图路径（可选附上）；
4. **告知用户验收方式**：在 Figma 桌面端选中起始帧 → 点右上角 **Present（▶ 播放）**，逐个点按按钮验证跳转/返回/动效是否符合预期。运行时点击行为（跳转是否成功）由用户在 Present 模式最终确认（INT-ACC-002）。

## 3. 脚本环境规范

脚本通过插件沙箱以 AsyncFunction 执行，**注入 4 个实参，直接当全局变量用**：

| 注入变量 | 类型 | 说明 |
|---|---|---|
| `figma` | API 对象 | Figma Plugin API 全集（createFrame/createText/loadFontAsync/getNodeByIdAsync 等）；无网络 |
| `readTree` | async 函数 | 过滤节点树导出器（第 2a 节），返回 `{root, count, truncated}` |
| `images` | 对象 | `{<名称>: Uint8Array}`，来自 CLI `--image`；**未传 --image 时是空对象，用前判空** |
| `wireReaction` | async 函数 | 原型交互连线（第 2e 节） |

硬规则：

1. **`await` 可用**（async 函数体）；顶层 `return` 一个**字符串摘要，必须包含关键节点 id**——它出现在 CLI stdout 的 `Message:` 行，是后续截图/连线的 id 来源。
2. **先 `loadFontAsync` 再设 `characters`**：`figma.createText()` 默认 Inter Regular，设置文字前必须 `await figma.loadFontAsync({ family: 'Inter', style: 'Regular' })`；用其他字体先加载对应 `{family, style}`。loadFontAsync 读取不需要——只有**设置**文本才需要。
3. `readTree` / `images` 判空与容错：`readTree` 结果检查 `truncated`；`images.logo` 先判 `if (images && images.logo)` 再 `figma.createImage(images.logo)`。
4. 脚本抛错会**原样回传**（插件侧整体 try/catch，不做二次包装），CLI 以 `FAILED: <原文>` 输出——不要在脚本里吞错（catch 后至少 return 错误摘要）。
5. 不要调用 `figma.closePlugin()`（面板须保持可用）；不要尝试 import/require/fetch（沙箱无模块、无网络）。

## 4. 预算规则（ADR-0002，硬约束）

1. **截图必须区域化**：`--node <id>` 或 `--rect x,y,w,h` + 适度 `--scale`（1–2 常用，最大 4）。禁止整页高清导出；CLI 不提供 page 模式入口。
2. **脚本批量**：一次 `run` 完成一套方案的全部操作（建/改/连线）。迭代轮数 = 成本，以轮数最小化为准绳。
3. **读取过滤**：`readTree` 按需给 `depth/fields/maxNodes`，缺省值已为预算调优，不要无脑取满。
4. **阶段落盘**：每个阶段结束（如"方案A建完并自查通过"）把**结论 + 节点 id + 证据路径**写入工作区状态文件（`HANDOFF.md` / `state/`），让新会话可续接，不依赖聊天记录。

## 5. 已知坑清单

1. **字体未加载**：未先 `loadFontAsync` 就设 `characters` 会报错，错误信息含 font/loadFontAsync 关键字并指向缺的字体（如 Inter Regular）。修法：脚本开头 `await figma.loadFontAsync({ family: 'Inter', style: 'Regular' })`（用非 Inter 字体时加载对应 `{family, style}`）。
2. **readTree 是 Promise**：漏 `await` 拿到的是 Promise 对象，读 `tree.root.children` 全是 undefined。修法：`const tree = await readTree({...})`。
3. **ok 语义**：CLI stdout 出现 `OK <jobId>` 才算成功；`FAILED: <原样错误>`（退出码 1）= 把错误**原样贴回上下文分析**后修脚本重试；退出码 2 = 参数/连接层问题（先查 `FIGMA_BRIDGE_TOKEN`、桥接是否在跑、面板是否「已连接」）。
4. **reactions 覆盖式**：对同一源节点多次 `wireReaction` 是替换不是追加。要"一个按钮多个交互"不可行（M5 单条覆盖）；换目标直接再调一次即可。
5. **图片 name=path 参数顺序**：`--image <名称>=<路径>`（如 `--image logo=/tmp/logo.png`）；只给路径时名称 = 文件名去扩展名。脚本内 `figma.createImage(images.logo)` 后把 Image paint 赋给节点 fills；用前判空。单图 ≤5MB、总量 ≤20MB（超限桥接直接拒绝）。
6. **BACK 无参数**：`action:'BACK'` 不需要也不使用 destinationId/animation（传了被忽略，返回值不含 destinationId）。
7. **面板 token 不落盘**：桥接重启（或换端口）后面板显示「已断开」，需重新粘贴新 TOKEN 并点「连接」；CLI 侧同步更新 `FIGMA_BRIDGE_TOKEN`。
8. **Job 超时**：缺省 30s；大批量脚本先本地想清楚再提交，必要时 `--timeout 60000`。超时/失败重跑是安全的（幂等脚本）。
9. **wireReaction 报错自解释**：源/目标节点不存在（含 id）、非法 trigger/action/animation（含允许值列表）——照着错误消息改即可。但若遇到 Figma 内部 schema 报错（如 "Expected [0].action to be one of…"），说明你绕过了助手在手写 reactions——回到第 10 条检查 schema。
10. **手写 `node.reactions` 的 schema**（能用 `wireReaction` 就别手写）：`actions` 必须是**复数数组**（单数 `action` 字段会被当前 Figma 拒绝："Please update the 'actions' field…prevent data loss"）；导航动作形状 `{type:'NODE', destinationId, navigation:'NAVIGATE', transition?}`；**NAVIGATE 实际必带 `transition`**（不带会被 schema 拒绝，见 2e 表）；`transition.duration` 单位是**秒**（0.3 = 300ms）；`easing` 和 `trigger` 是对象 `{type:'EASE_OUT'}` / `{type:'ON_CLICK'}`，不是裸字符串。
11. **读回形状**：wireReaction 入参 duration 是毫秒，但写入后**读回/存储是秒**（300 → 0.30000001…，float32 精度）；BACK 的读回 `actions[0]` 只有 `{type:'BACK'}`（无 navigation/destinationId）——读回校验按"字段缺失也算成功"处理。
12. **幂等要用"复用式"而不是"删除重建式"**：`findOne` 按名找到就复用节点，才能保证节点 id 稳定、`--node` 截图循环可用；删除重建会让 id 每轮变化，截图参数失效。

## 6. 最小示例（可直接跑）

把下面内容存为 `/tmp/figmapt-demo.js`（幂等：重复运行复用已有帧，不会重复创建；重复连线是覆盖，结果不变）：

```js
// 两帧 + 按钮 + 点击跳转/返回 的最小可点击原型
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

function find(name) { return figma.currentPage.findOne(function (n) { return n.name === name; }); }

function buildFrame(name, x, bg) {
  let f = find(name);
  if (f) return f;
  f = figma.createFrame();
  f.name = name;
  f.resize(320, 240);
  f.x = x; f.y = 0;
  f.fills = [{ type: 'SOLID', color: bg }];
  const title = figma.createText();
  title.characters = name;          // 字体已加载，安全
  title.fontSize = 20;
  f.appendChild(title);
  title.x = 20; title.y = 20;
  const btn = figma.createFrame();  // 按钮先用纯色帧表示
  btn.name = 'btn-' + name;
  btn.resize(120, 44);
  btn.cornerRadius = 8;
  btn.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.4, b: 1 } }];
  f.appendChild(btn);
  btn.x = 100; btn.y = 160;
  return f;
}

const a = buildFrame('方案A-首页', 0, { r: 1, g: 0.96, b: 0.9 });
const b = buildFrame('方案B-详情', 400, { r: 0.9, g: 0.94, b: 1 });
const btnA = find('btn-方案A-首页');
const btnB = find('btn-方案B-详情');

// 交互：A 的按钮 → B 帧；B 的按钮 → 返回
await wireReaction({ sourceId: btnA.id, action: 'NAVIGATE', destinationId: b.id });
await wireReaction({ sourceId: btnB.id, action: 'BACK' });

figma.viewport.scrollAndZoomIntoView([a, b]);
return 'A=' + a.id + ' B=' + b.id + ' btnA=' + btnA.id + ' btnB=' + btnB.id;
```

配套两条 CLI 命令（cwd = `figma-prototyper/`，需先完成第 1 节前置条件）：

```bash
# 1) 提交执行：stdout 的 Message 行给出各帧/按钮 id
node cli/figmapt.js run /tmp/figmapt-demo.js

# 2) 对方案A 帧截图自查（<A> 换成上一步 Message 里 A= 的值；脚本幂等，重跑安全）
node cli/figmapt.js run /tmp/figmapt-demo.js --node <A> --scale 2
```

验收：画布出现两个并排 Frame，各自有标题与蓝色按钮；在 Figma 里选中 `方案A-首页` 点 **Present（▶）**，点按钮应跳到 `方案B-详情`，再点其按钮应返回（瞬时切换即算通过）。
