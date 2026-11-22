# dsh-bots 端到端验证记录

> 环境：独立测试实例（`npx` 拉起的 CLI 版 dsh 0.2.2-rc.5 + 独立 profile `bottest`），
> 数据与桌面实例共用 `~/.dsh/storages/dsh-bots/db.json`。
> 浏览器侧全部通过 headless Chrome + CDP 真机操作（不是 mock、不是单元测试）。

## 1. 启动一个测试实例

PATH 里的 node 版本可能低于 dsh 要求（>= 24.9）。可以拿 Electron 自带的 node 顶班：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$node = 'C:\Users\xiafa\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$bin  = 'C:\Users\xiafa\AppData\Local\npm-cache\_npx\63d4cff42d507497\node_modules\@deepseek-ai\dsh\lib\bin.js'
& $node $bin --version
```

首次建 profile：

```powershell
& $node $bin --profile bottest --from-default-profile web --help
# 然后把 @dsh-external/dsh-bots 指过去（手工 junction 比 pnpm link 稳）
New-Item -ItemType Junction -Path "$HOME\.dsh\profiles\bottest\node_modules\@dsh-external\dsh-bots" -Target 'D:\codes\dsh-bots'
```

启动：

```powershell
Start-Process -FilePath $node -ArgumentList @($bin,'--profile','bottest','--port','6401','--no-open') `
  -RedirectStandardOutput D:\codes\dsh-bots\tmp\bottest.out.log `
  -RedirectStandardError  D:\codes\dsh-bots\tmp\bottest.err.log
# 第一行就是 http://127.0.0.1:6401/?token=...
```

> 重启前先杀掉占用端口的进程，否则 `EADDRINUSE` 会让「2 required plugins did not activate」。

模型：`C:\Users\xiafa\.dsh\profiles\bottest\cordis.patch.yml` 里把 `agent-default-model`
指到有额度的 provider（本机是 `aliyun / deepseek-v4.1-flash-1017`），否则会话会因为
`ACCOUNT_QUOTA` 报「本轮运行失败」。

## 2. 已验证的行为

| # | 行为 | 结果 | 证据 |
|---|---|---|---|
| 1 | 侧栏出现「任务板」入口，图标正常 | 通过 | `tmp/shot-board.png` |
| 2 | 看板 5 列、卡片不溢出、窄窗口横向滚动 | 通过 | 同上 |
| 3 | Bots 页签：卡片、线性图标、主控徽章、技能/人格提示 | 通过 | `tmp/shot-bots.png` |
| 4 | 面板内建任务：标题、五段 brief、指派、优先级 | 通过 | T-0008 / T-0011 |
| 5 | 点「私聊」打开该 bot 的固定会话，可直接发消息 | 通过 | `tmp/shot-chat.png` |
| 6 | bot 人格注入（自称、职责、工具集按角色区分） | 通过 | 私聊回复与 worker 评论 |
| 7 | 派发：任务 → 执行 bot 会话，状态转处理中 | 通过 | T-0011 trace |
| 8 | 交回：worker 用 `task_complete` 汇报，任务转待验收 | 通过 | T-0011 两条评论 |
| 9 | 完成通知投递到主控 bot 的会话 | 通过 | trace `delivered via agent.followup session-d8b21af5…` |
| 10 | 非主控 bot 可以查看会话列表（`session_list`） | 通过 | T-0004 冒烟 |
| 11 | 主控每次请求前收到其他 bot 名单，且新建 bot 后下一轮即时可见 | 通过 | `tmp/shot-roster2.png` |

## 3. 这一轮修掉的四个真 bug

1. **空面板**：客户端用 `jsxRuntime.jsx` 当 `h` 用，第三个孩子之后全丢，面板只剩一个空 div。
   换成 `react.createElement` 后恢复。
2. **会话打不开**：宿主自造 sessionId 建会话，客户端目录里没有它，`openSession` 退回首页。
   改成客户端 `sessions.create({ workspaceId })` → 宿主绑定 → `openSession`。
3. **会话重放损坏**：`followup` 的消息缺 `id`，落盘后校验失败（`lacks an identified message`）。
   消息改为 `{ id, role: 'user', content, source }`。
\n## 3.1 主控的 bot 名单（本轮新增）\n\n`service.applyRoster()` 在 orchestrator 会话的 agent scope 里注册两项：\n\n- `systemPrompt.variable("'dsh_bots_roster'", () => rosterText(bot))` —— 每次 assembly 重新求值；\n- `systemPrompt.section({ name: "dsh-bots:orchestrator-roster", order: 10250, text: "…{{dsh_bots_roster}}…" })` —— 放在 persona 之后，是系统提示的最后一段。\n\n实测：问主控「你现在有哪些其他 bot？」，它按 `名字 · id · 空闲 · 已有会话` 的格式回答；随后新建 bot-006，再问一次，名单里立刻出现「文案助手 · bot-006 · 空闲 · 技能 copywriting · 还没有会话」，不需要重启。\n\n> 名单只注入主控；执行 bot 看不到别人的名单。变量必须先于 section 注册，否则未解析的 `{{…}}` 会让整轮 assembly 失败。\n4. **看板把渲染进程跑满 CPU**：`1fr` 列宽和 `overflow-x:auto` 同时存在会让布局与滚动条
   互相触发。改成「宽屏 1fr、窄屏固定 196px + 滚动」，两者互斥。

## 4. 已知边界

- 右侧栏还没有独立的 Bots 标签页，入口只有左侧「任务板」面板。
- 会话列表里的 bot 图标（`sidebar.session.row.trailing`）还没接，因为那一层只能拿到 sessionId。
- 技能白名单目前只作用在系统提示层，没有真正拦 `skill` 工具调用。
- 任务会话的工作目录取 bot 的 workspace，bot 没设时退回当前工作区。
- 桌面实例的 Host 代码需要重启应用才会加载新版（Client 刷新页面即可）。
## 4. v14 回归（隔离数据目录）

桌面实例未重启前，用独立 profile 的 CLI 实例 + 独立数据目录复跑了一遍完整闭环，确认 store 的「写前重载」与名单注入没有引入回归。

- 数据目录：`D:\codes\dsh-bots\tmp\e2e-store`（profile patch 里 `dsh-bots.config.storageDir` 指过去，避免动真实数据）
- 启动：`--profile bottest --port 6401`（Electron 当 node，见 §1）
- 脚本：`tmp\e2e-api.mjs`

| # | 实测 | 结果 |
|---|------|------|
| 1 | `GET /state` | `build=v14-roster`，3 bots / 12 tasks |
| 2 | `POST /tasks` 建 T-0012 指派 bot-006（该 bot 还没有任何会话） | 200，任务进「等待认领」 |
| 3 | `POST /tasks/T-0012/dispatch` | 200，自动建会话 `session-ee3e351b…`、`round-20` |
| 4 | 4 秒后 | 评论「v14 ok」出现在任务下，状态 in_progress |
| 5 | 6 秒后 | 交回评论 + 状态 in_review |
| 6 | 主控侧 | 通知 `n1795260696692-14` 已投递（delivered=true） |
| 7 | 再查 | T-0012 被主控标为 done——「派发→执行→交回→主控验收」整条闭环自动跑完 |
| 8 | 两个 store 并发写（`tmp\test-store.mjs`） | PASS：A 改 bot 名、B 改任务优先级，两边都保住 |

结论：v14 代码在真实宿主里可用，桌面实例重启后即可生效。
- 补：已完成列此前把 canceled 过滤掉了（	asks.filter(status!=='canceled')），与需求「已完成=done+canceled」不符；已改为一并列，实测 已完成 11（done 7 + canceled 4）、待立项 1、页签「任务 1」（只数未结束任务）。

## 5. 桌面应用侧栏入口「看不见」的排查（v14 之后）

现象：宿主升级到 v14 后，桌面应用左侧栏只看到「新会话 / 消息订阅 / 更多」，找不到「任务板」。

排查：桌面 renderer 没有开远程调试端口、`/` 需要 token，无法从外部读 DOM。用临时诊断通道（客户端把结果写进一条调试任务的评论）确认：

- `apply` 执行、`sidebar.panellist` 与 `main` 两处注册都成功；
- 槽位里确实有我们的条目：`slot[7]: local-session-search|plugins|schedules|dsh-context|strategy-workbench|dsh-bots|message-hub`；
- DOM 里也渲染出了「任务板」这一行；
- 但它的几何位置是 `navRect 8,-133,264x270` —— 面板列表被滚出了可视区。

结论：不是插件问题，是侧栏面板列表的滚动位置停在下方。把侧栏滚回顶部即可见；也可以直接在「更多」菜单里找到（`sidebar.panellist.actions` 会把未钉住的入口收进去）。

诊断代码已全部移除（`node --check lib/client.js` 通过），调试任务 T-0012 已从数据里删除。
## 6. 会话行显示 bot 图标（v15）

需求里有一条：workspace 会话列表里，如果某个会话属于某个 bot，要显示该 bot 的图标。

实现（`lib/client.js`）：

- 注册 `sidebar.session.row.trailing` 槽，组件 `SessionRowBadge` 按传入的 `sessionId` 去 `bindingsBySession` 里查绑定，命中就渲染 18px 的线性图标；主控 bot 用强调色底，其他 bot 用中性底色。
- 绑定表来自 `/state` 的 `bindings`：`apply` 里先主动拉一次（不等用户打开面板），面板的 10 秒轮询刷新时也会更新；订阅用 `bindingListeners` 通知已挂载的行重渲染。
- 图标复用 Bots 面板那套 `BotGlyph`（12 个线性图标），不额外引入资源。

实测（bottest + CDP）：5 个已绑定会话的行上都出现了 `.dxb-row-badge`，`title` 正确（`主控 bot · 私人助理` / `bot · 文案助手` / `bot · 执行小工`）；未绑定会话不渲染任何东西，不影响原有行布局。

## 7. 技能白名单真的拦（v17）

需求（m00157）：bot 里勾的技能只是用户级白名单，项目 workspace 自带的技能要额外加载；两层之外的不该能用。

实现（`src/service.mjs`）：

- `guardSkills(agent, bot)` 在 `attach` 里注册 `agent.ctx.tools.guard(...)`，只拦 `skill` 工具的调用；白名单为空时整体不注册（不限制）。
- 白名单来自 `bot.skills`；项目技能集合在 attach 时用 `skills.list({ cwd: bot.workspaceId })` 拉一次，按 `resourceBase.path` 是否落在 workspace 路径下判定，缓存到闭包里。
- 命中集合外返回 `{ reason: "「x」不在「名字」启用的技能里…", info: { code: 'SKILL_NOT_ALLOWED' } }`，模型看到的是一条失败结果而不是异常。
- 顺带修了一个更基础的 bug：任务会话是「先建 agent、后写 session→bot 绑定」，attach 跑在绑定之前会报 `no bot binding`，人格 / 角色工具集 / 技能 guard 全都没挂上。`dispatchTask` 里在 `ensureTaskAgent` 之后补 `await rebind(sessionId)`，把三者重新挂上。

实测（真实宿主，v17）：

1. `PATCH /bots/bot-004 {"skills":["genui"]}`，然后建 T-0014「技能白名单拦截验证 v2」并派发给 bot-004。
2. bot-004 在任务会话里调用 `skill(name="office")`，工具返回：

   ```text
   Error: 「office」不在「执行小工」启用的技能里。可用：genui；项目工作区自带的技能会自动放行。
   ```

3. 同一轮里 `skill(name="genui")` 不被拦；`skill` 以外的工具（`task_get` / `task_comment` / `task_complete`）也不受影响。评论里模型自己写明「白名单拦截生效」。
4. 测完把 bot-004 的技能恢复为空，避免影响真实数据。

离线单测 `tmp/test-skills.mjs`：白名单 `genui` + workspace 下的 `project-helper` → 两者都放行；`office` 被拒；`shell` / `task_get` 等非 skill 工具不经过该 guard。

## 8. 右侧栏 Bots 标签页（v18）

实现：`ctx.sidebarRightTabs.register({ id: "@dsh-external/dsh-bots/bots", kind: "dsh-bots", title: () => "Bots", keepMounted: true })` + `ctx.slots.register({ name: "sidebar.right.pane.tab", key: <同一个 id> }, BotsSidePane)`。tab 类型注册包在 `ctx.effect` 里，优先用 `ctx.inject(["sidebarRightTabs"], …)`，服务未就绪时退化为 250ms 轮询注册。

实测（bottest 6401 + headless Chrome CDP）：
1. 打开任一会话（右侧栏只在有会话面板时存在）。
2. `window.__dshBotsOpenRight()` → `"opened"`。
3. 右侧栏出现 `Bots` 页签，渲染 3 行：`私人助理 / 主控`、`执行小工 / 1 个在办`、`文案助手 / 空闲`，每行带「私聊 / 开始」按钮，截图 `tmp/side-pane8.png`。

同时修掉一个通用 bug：`api()` 在 GET 上也发了 `content-type: application/json`，本地网关会把它当写请求处理，导致面板一直停在「加载中」。现在只有带 body 时才发这个头。

## 9. 快速入口与右侧栏样式重做（v19）

新增**左侧独立入口**：`sidebar.panellist` 注册第二个 id `dsh-bots-bots`（order 52，标签“Bots”，机器人线性图标），对应 `main` keyed slot 渲染 `BotsPanel`（`Panel` 的 `mode: "bots"`）。点开直接是 bot 列表，不再需要先进“任务板”再切页签。

右侧栏 `BotsSidePane` 重做：

- 头部：小号大写标题 + 数量胶囊 + 刷新按钮；bot 超过 5 个时出现筛选框。
- 行：30px 图标块（主控用强调色底）、名字 + “主控”胶囊、状态点（有在办为绿）+ 在办数 + 是否有会话；整行是 button，点任意位置直接开私聊，悬停才显示“私聊”。
- 空态与同名空态文案分开（“还没有 bot”/“没有匹配的 bot”）。

实测（bottest 6401 + CDP 9226）：

1. 左侧栏同时出现“任务板”“Bots”两行，点“Bots”直接进入 bot 卡片面板（3 张卡），截图 `tmp/final2-botspanel.png`。
2. 面板头部点“右侧栏” → 自动开主控私聊并顶出右侧栏，3 行 bot，截图 `tmp/final-sidepane.png`。
3. `document.querySelectorAll(".dxb-bot").length === 3`；右侧栏行数在 keepMounted 影响下会数出 6（两份 DOM，视觉只有一份）。

**事故记录（值得留）**：用 PowerShell `Get-Content -Raw` + `Set-Content -Encoding utf8` 改 `lib/client.js`，PS 5.1 按 ANSI 读 UTF-8，整份中文被写成乱码。恢复方式：bottest 的页面在事故前已加载过该 bundle，用 CDP `Debugger.enable` + `Debugger.getScriptSource` 从浏览器内存里把源码整段取回（`tmp/recovered-7.js` → `tmp/client.from-browser.js`），再裁掉拼接分隔符；校验 `node --check` 通过、替换字符计数为 0。教训：改这类文件只用编辑器/Node 的 `fs`（显式 utf8），别走 PowerShell 文本管道。

## 10. 任务「停止本轮」按钮（v20）

此前任务一旦进入 `in_progress`，若 worker 卡住或想中止，UI 上没有出口，只能等看门狗或改文件。现在任务详情在 `activeRoundId` 存在时显示红色描边的「停止本轮」：

- 客户端：`stopRound()` → `POST /tasks/:id/stop`，body `{ reason: '用户在任务详情里手动停止' }`；成功后刷新详情，按钮自动消失（`activeRoundId` 被清空）。
- 宿主：`service.stopRound(taskId)` 对任务会话 `agent.cancel({ kind: 'user' })` + `finishRound({ status: 'failed', note: reason })`。
- 实测（bottest 6401 + CDP）：派发 T-0013 → 详情按钮为 `标为已完成 / 停止本轮 / 派发给 bot / 保存`；点「停止本轮」后按钮消失，`GET /state` 里 `T-0013.status = blocked`、`activeRoundId = null`。截图 `tmp/stop-dialog.png`、`tmp/stop-after.png`。

顺带修了窄窗下的头部排布：`.dxb-head` 由固定 `height:46px` 改为 `min-height` + `flex-wrap`，泳道的固定轨道回退断点从 1100px 降到 980px；1100×800 下 5 列刚好铺满（`scrollWidth/clientWidth = 796/796`），900 宽才出现横向滚动。截图 `tmp/board-1100.png`。

## 11. 会话标题、图标与 workspace 归属（v21→v22）

四个一起修的问题：

1. **会话行不显示 bot 图标**：图标本身在 v15 就有了；这次实测确认它在会话行右侧正常渲染（截图 `tmp/rows-zoom.png`：主控行是强调色机器人图标，执行 bot 行是描边机器人），不显示的原因是桌面端还在跑旧 client bundle，刷新页面即可。
2. **会话标题用 bot 名**：新增 `renameSession()`。注意 `sessionController.rename()` 收的是 **Session 对象**而不是 id（传 id 会报 `resume failed for session "undefined"`），所以先 `agents.get` / `resume` 拿 agent，再 `sessionTitle.rename(agent.session, title)`。实测：私聊会话 → `文案助手`；任务会话 → `执行小工 · T-0014`。
3. **任务没有 workspace**：`POST /tasks` 接受 `workspaceId`；面板「+ 任务」在提交前用 `workspaceIdForPath(currentCwdNow())` 取当前工作区；`task_create` 工具用调用者 agent 的 cwd 反查 workspace。
4. **任务会话不挂在 workspace 下**：`ensureSession` 现在接受显式 `workspaceId`，既传给 `sessionController.create({ workspaceId })`，也写进 `bindings.workspaceId`；任务首次派发时若自己没有 workspace 会继承 bot 的（`task.adopt workspace`）。

实测（bottest + 隔离 store）：`POST /bots/bot-006/chat` → `{created:true}`，绑定 `workspaceId=91f1d133-…`；建 T-0014（带 workspaceId）→ 派发 → 任务会话 `session-a3af59f9-…` 绑定同 workspace，trace `renamed … -> 执行小工 · T-0014`；浏览器里会话行显示标题「执行小工 · T-0014」并带 bot 图标。

### v23/v24 补强（存量会话）

- `attach()` 时若绑定记录没有 `workspaceId`，用该会话自己的 cwd 反查 workspace 并写回（trace `binding … recovered workspace`）。
- 打开已有私聊会话时顺手把标题改成 bot 名，存量会话不用重建。
- 绑定里只存 workspace **id**：新增 `normalizeWorkspace()`，路径先经 `resolveByPath` 转换；`task_dispatch` 让任务继承 bot 的 workspace 时也走同一条转换（之前会把路径原样写进绑定）。
- 实测：桌面实例 `build=v24-workspace-id`，新建 bot-004 私聊后绑定为 `workspaceId=91f1d133-c7bb-421c-854d-df77b12d6199`（UUID，不再是路径）。

## 12. 后台事件：拉取式收件箱（v27）

目标：执行 bot 交回后**不打扰用户**，但主控要能知道。三条可选通道里选了第三条：

| 通道 | 用户可见 | 成本 |
| --- | --- | --- |
| 直接发消息进主控私聊 | 是 | 无需额外成本，但刷屏 |
| 每轮改系统提示（v25 试过） | 否 | **KV 前缀缓存每轮失效**，被否决 |
| 事件落库 + `inbox_list` 按需拉取（v27） | 否 | 常量提示只改一次，之后零成本 |

实现：
- `notifyOrchestrator(text, { urgent, taskId })`：紧急度可被任务上的 `notify` 覆盖（`visible` → 发可见消息；`silent` → 只落库；空 → 用调用方默认）。非紧急只 `store.pushNotification`，不投递、不唤醒、不改提示。
- 系统提示里只有一句**常量**：「任务板的后台事件（如执行 bot 交回）不会自动发消息，需要时用 inbox_list 查看，读完即清空。」挂载一次，之后每轮前缀完全一致。
- 工具 `inbox_list`（仅主控）：读 `pendingNotifications()` 里 `target='orchestrator' && !urgent` 的条目，返回后 `markNotificationsDelivered` 清空。
- 任务字段 `notify`（`silent` | `visible` | null）：`POST/PATCH /tasks`、工具 `task_create`/`task_update`、面板任务详情的「结束通知」下拉都可设置。
- `flushPendingNotifications()` 只补发 `urgent` 的（静默条目靠主控自己拉）。

实测（桌面实例 `build=v27-pull-inbox`，2026-11-22）：
| 场景 | 结果 |
| --- | --- |
| T-0020 默认通知方式，派发后交回 | `in_review`、`inbox` 1→2、主控私聊无新消息 |
| T-0021 任务详情设「可见」 | 通知记录 `urgent=true, delivered=true`，直接发进主控私聊，`inbox` 不变 |
| 向主控发「用 inbox_list 看看收件箱」 | 主控调用工具后 `inbox` 2→0，两条事件被读走并清空 |

代价与边界：
- 静默事件不会主动唤醒主控；主控只在「用户找它」或「有紧急事件」时才看得到——这正是要的取舍。
- 收件箱不做去重聚合，同一任务多次交回会有多条；上限由 `inbox_list` 的 `limit`（默认 10，上限 30）控制。
- 回滚点：`db.json.bak-20261122-100119`（引入通知字段前）。
- 面板验证：任务详情弹窗第 4 个字段就是「结束通知」，三个选项 默认 / 静默 / 可见（截图 `tmp/dialog-notify2.png`）；选项文案取短，长解释放在 `title` 属性里，避免下拉在 150px 宽度下被截断。

## 13. 需求验收对照（11 条）

对照 `docs/requirements.md` §6，逐条给出结论与证据。"部分"都写清了缺什么。

| # | 验收项 | 结论 | 证据 / 缺口 |
| --- | --- | --- | --- |
| 1 | 建 bot（名称/图标/人格/用户级技能）→ 列表 → 私聊；只加载选中技能，项目技能仍可用 | 通过 | v17 真机拦截 `office` 放行 `genui`+项目技能；面板 BotDialog 12 图标；私聊 v30 起先 peek 复用已有会话，没有才 `sessions.create`+`/bots/:id/chat`（§14 实测两次点击同一会话） |
| 2 | 私聊进入会话、置顶、会话行显示 bot 图标（主控带徽标） | 通过 | 图标与徽标通过（`.dxb-row-badge` 实测 5 个、title 正确）；`openSession` 后调 `uiWorkspace.pinSession`，bottest 实测打开主控私聊后该会话出现「已置顶」态、菜单变为「取消置顶」（截图 `tmp/pin-sidebar.png`）；私聊落在 bot 的 workspace 或当前 cwd |
| 3 | 主控私聊在左侧栏常驻；底部快捷入口可进 | 通过 | 置顶生效后主控私聊在侧栏顶部常驻（#2 实测）；底部 `sidebar.footer.action` 座位被 Settings 占用，改用左侧独立「Bots」行 + 右侧栏页签两个浅入口（见 §3.2.4） |
| 4 | 主控在私聊里用一句话建任务并分派 | 通过 | 真机对话实测：给主控一句「这件事交给执行小工做」，它自己建 T-0023、指派 bot-004 并派发，25 秒后任务进待验收、产物 `tmp/nl-smoke.txt` 落盘 |
| 5 | 任务上看板、列从等待认领到处理中、卡片显示负责人 | 通过 | 看板 5 列 + 卡片头像/状态/优先级；派发后 todo→in_progress 实测 |
| 6 | 任务会话落在任务 workspace，行标题带任务号 | 通过 | v21/v22：binding `workspaceId` 为 UUID，标题「执行小工 · T-0014」 |
| 7 | 完成后任务进「等你」，主控收到通知并汇总 | 部分 | 任务进 `in_review` 通过；通知按 m03889 的决定改为**拉取式**（默认静默 + `inbox_list`，可设「可见」直接发），与需求原文的「收到通知」等价但省 token |
| 8 | 主控不可用时未指派任务可人工指派 | 通过 | 未指派任务显示「未指派」，`agentRequired && status=todo` 的卡片额外带琥珀色「等待分派」chip；人点「派发给 bot」即可指派。实测（bottest 758px 看板）：`.dxb-chip.wait` 1 个、文本「等待分派」、color `rgb(180, 83, 9)`（截图 `tmp/chip-board.png`） |
| 9 | 进行中再派发 → 排队不重复执行 | 通过 | v28：第二次派发返回 `202 {queued:true}`，本轮结束后自动重放（实测 round-27 → round-28） |
| 10 | 重启后 bot/图标/任务/绑定/置顶/去重状态保留 | 通过 | `db.json` 持久化 + mtime 重载；重启后 3 bots / 20 tasks、绑定与标题均在 |
| 11 | 普通 bot 看不到 `task_*` 管理工具 | 通过 | 按角色注册（`ORCHESTRATOR_TOOLS` / `WORKER_TOOLS`）；T-0004 会话只有 `task_get/comment/complete/block` + `session_*` |

剩余可做（都不阻塞使用）：置顶与底部快捷入口的桌面实测、自然语言建任务端到端、给未指派任务加「等待分派」视觉态。

### 13.1 自然语言建任务实测（2026-11-22）

向主控私聊投递（经 `POST /debug/say`，等价于用户开口）：

> 帮我记一件事：在 D:\codes\dsh-bots\tmp\nl-smoke.txt 写一行 ok。这件事交给执行小工做，你自己不要动手。做完如果有结果告诉我一声。

时间线（`/state` 轮询）：

| 时刻 | 观察 |
| --- | --- |
| t+10s | 出现 T-0023「在 tmp\nl-smoke.txt 写一行 ok」，`assignee=bot-004`，已有 `sessionId`，状态 `in_progress` |
| t+25s | 状态 `in_review`，1 条交回评论；产物文件内容为 `ok`（2 字节） |

说明：主控没有自己动手改文件（评论里是执行 bot 的汇报），说明「建任务 → 指派 → 派发」这条链在真实对话里是通的。这条从「部分」升为「通过」。

## 14. 私聊为什么会新建会话，以及修复（v30）

现象：每点一次 bot 卡片上的「私聊」，会话列表里就多一个会话，且 bot 的绑定被覆盖成最新的那个。

原因：宿主用 `agents.create` 自建的会话不在 Web client 的会话目录里，`openSession(id)` 找不到它就会退回「选择工作区」。当时的绕法是「让客户端先用 `sessions.create` 建一个自己认识的会话，再把 id 交给宿主绑定」——客户端每次点击都先建，所以每次都新。

修复：
- 宿主 `openBotChat` 支持 `{ peek: true }`，只返回已有的 `bot.sessionId`，不创建；并且一旦 bot 已有会话，忽略客户端传来的新 id（trace 记 `ignoring client session …`）。
- 客户端 `launchChat` 先 peek：有 id 就 `sessions.refresh()` / `sessions.retain(id)` 后 `openSession(id)`；拿不到或目录里仍没有，才走「客户端创建 + 宿主绑定」。
- 任务板卡片上的「私聊」也改成走同一条 `launchChat`，此前它有一份重复实现。

实测（bottest 6401 + CDP 9229，新建 bot-007 无会话）：
- 第 1 次点击：创建 `session-2c1c52b7-…`，composer 出现（会话已打开）。
- 第 2 次点击：peek 命中同一 id，`revealed=true`，仍是同一个 `session-2c1c52b7-…`，`bot.sessionId` 未变。
- 已有会话的 bot（bot-005）实测两张卡片点击后 `bot.sessionId` 也保持不变。

顺带确认的 client 会话目录形状：`sessions.list.getSnapshot()` → `{ ids, byId, phase, projectionsBySession }`，判断「目录里有没有这个会话」要看 `ids`。

## §15 私聊固定 + 重置（v34/v35）

问题：点「私聊」每次都新建会话；重置后的新对话发不出消息（`session "…" is already owned by an active write handle`）。

根因：
1. 早期让客户端先 `sessions.create()` 再把 id 交给宿主，宿主每次都采纳新 id → 每点一次就多一个会话。
2. 客户端创建的会话由客户端持有写句柄，宿主 `rebind/resume` 再拿一个写句柄，发消息时被 DSH 的会话锁拒绝（同一 profile 同时跑两个 DSH 实例也会出现同样的锁冲突）。
3. 宿主机建的会话不在客户端目录里时，`openSession` 会静默退回「选择工作区」。

修法：
- 会话只由宿主创建（`ensureSession` → `sessionController.create({ workspaceId })`，会广播给所有客户端），客户端只做 `reveal` + `openSession`，并重试 3 次等待目录刷新；客户端不再创建会话。
- `openBotChat` 支持 `peek`（只读会话 id）与 `reset`（新开一个私有会话，旧会话保留）；`/bots/:id/chat` 把 `peek/replace/reset` 透传给服务。
- 卡片加「重置」、右侧栏行加「↺」，走 `reset:true`。

实测（bottest，host `v35-chat-reset`）：
- 无会话的 bot 点「私聊」→ 宿主建会话、界面打开、composer 出现；在会话里发消息 → 6 秒内收到 bot 回复（人格正确）。
- `POST /bots/bot-008/chat {reset:true}` → 返回新 session，`peek` 复读同一个 id。
- 桌面宿主装回 v35（bundles=22），刷新页面即可看到「重置」按钮。

注意：同一个 profile 不要同时开两个 DSH 实例去写同一个会话，DSH 会以 `already owned by an active write handle` 拒绝。

### v36/v37：重置会话必须有 workspace

实测 `POST /bots/bot-006/chat {reset:true}` 时发现两个问题，都会让「重置」又退回「选择工作区」：

1. bot 没有 workspace 时，`sessionController.create({ cwd })` 建出的会话不带 workspaceId，界面打不开。修法：`ensureSession` 在解析不到 workspace 时回退到默认 workspace（`workspaceRegistry.list()` 里 `default: true` 的那个，没有就用第一个）。trace 记 `default workspace fallback -> <id>`。
2. reset 分支在 `ensureSession` 之后又 `bindSession({ workspaceId: resetWs || null })`，把刚解析好的 workspace 覆盖成 null。修法：去掉这次重复绑定，绑定只由 `ensureSession` 负责。

改完实测：bot-006 重置 → `session-61b182d0-…`，binding `workspaceId=73db883a-f505-4a3c-9754-8c33a068db79`（默认 workspace），不再是空值。宿主 `BUILD=v37-reset-binding`。

补充实测（v37 之后，桌面宿主）：

- 重置出的会话可以正常发消息：`POST /debug/say {botId:'bot-006', text:'只回两个字：收到'}` → 12 秒后该会话投影里 `turnOutline.turns[0] = { prompt: '只回两个字：收到', response: '收到' }`，没有 `already owned by an active write handle`。
- 复用未回归：`POST /bots/bot-005/chat` 连续两次都返回 `session-5c951bb4-…`，第二次 `reused: true`。

### v38：宿主建的会话没有模型路由

现象：重置后的对话里发消息报 `agent "session-…" has no provider/model: set AgentOptions.provider and AgentOptions.model or record a model selection`。

原因：宿主机用 `sessionController.create({ workspaceId })` 宣布会话后，只是 `agents.resume()` 拿到 agent，**没有记录过这个会话的模型选择**；DSH 的 turn 需要会话级 `ModelSelection`，所以第一轮就失败。

修法：`ensureSession` 在 `controller.create` 成功后调用 `ensureModelSelection(sessionId)`：
- 先试 `sessionController.initializeDefaultModel(sessionId)`；
- 不行再取 `sessionController.modelCatalog().default`（退路：任一活 agent 的 `options.provider/model`），调 `selectModel({ sessionId, provider, model, reasoningEffort? })`。

实测（桌面 `v38-session-model`）：`POST /bots/bot-005/chat {reset:true}` → `session-514f32d9-…`，发「只回两个字：收到」→ 15 秒后投影 `response: "收到"`，不再报 provider/model。任务会话走同一个 `ensureSession`，一并修好。

## v39：私聊固定会话的回归用例（TDD）

### 报的现象
点「私聊」时有时会**多出一个会话**；重置之后点「私聊」也进不到刚重置的那个对话。

### 根因
`lib/client.js` 的 `launchChat` 在「已有会话但打不开」的分支里，直接调 `requestSession(..., true)` —— 也就是**静默重置**。于是只要当前窗口打不开这个会话（别的工作区、历史损坏、目录快照未刷新），每点一次「私聊」就多建一个会话，而且新会话又不是用户以为的那个。

### 红 → 绿
1. 先写 `tests/chat-flow.test.mjs`，把决策表钉死：已有会话且能打开 → 复用；已有会话打不开 → 抛 `CANNOT_OPEN`（**不得**创建/重置）；没有会话 → 创建一次；显式重置 → 只请求一次 reset。此时 `__chatFlow` 还不存在，用例是红的。
2. 把 `launchChat` 拆成纯决策函数 `chatFlow(bot, options, deps)` + 依赖注入的 `launchChat`，并 `exports.__chatFlow` 暴露给用例。红转绿：`chat-flow: 4/4 PASS`。
3. 宿主侧 e2e `tests/e2e-chat-api.mjs`（对真实宿主，建临时 bot、跑完删除）：`e2e-chat-api: 8/8 PASS`。
4. 浏览器 e2e `tests/e2e-ui-chat.mjs`（CDP）：重置只发一次 `reset:true`、会话换一次；私聊两次不发 reset、会话不变；之后输入框存在。

### 怎么跑
```bash
pnpm test           # 纯逻辑用例（离线，无宿主）
pnpm test:api       # 需要 DSH_BOTS_URL（默认 http://127.0.0.1:53625）
pnpm test:ui        # 需要 DSH_UI_URL + CDP_PORT（headless Chrome）
```

### 写用例时踩到的坑
- **面板会卸载**：打开会话后主视图切换，任务板/Bots 面板被卸载，所以要按按钮前先 `ensurePanel()`（见 `tests/e2e-ui-chat.mjs`）。
- **headless Chrome 会卡死**：同一个 target 跑太久，`Page.navigate` / `Runtime.evaluate` 永挂，表现为 `Detected unsettled top-level await`。换新端口 + 新 `--user-data-dir` 重开即可。
- `.dxb-bot` 是卡片容器类，按 `[class*="dxb-bot"]` 选会连带命中容器，点按钮时容易点到第一张卡。

## §16 私聊 / 重置的场景矩阵（v42）

自动化用例：`tests/e2e-chat-matrix.mjs`（对真实宿主，自建临时 bot 跑完删除）。

```powershell
node tests/e2e-chat-matrix.mjs http://127.0.0.1:6401 <token>
# 或 npm run test:matrix -- http://127.0.0.1:6401 <token>
```

| # | bot 状态 | 操作 | 期望 | 实测 |
| --- | --- | --- | --- | --- |
| 1 | 没有会话，没有 workspaceId | 私聊 | 新建 1 个会话，绑定 bot，落在 cwd 解析出的 workspace | PASS |
| 1b | 同上，cwd 不在任何 workspace | 私聊 | 落到默认 workspace，并出现在该 workspace 的会话列表 | PASS |
| 2 | 已有会话 | 私聊（再次） | 复用同一个 id，不新建、不覆盖绑定 | PASS |
| 3 | 已有会话 | 重置 | 新建 1 个会话，旧会话保留，新会话绑定 bot 与 workspace | PASS |
| 4 | 刚重置 | 私聊 | 打开重置后的那个会话 | PASS |
| 5 | 没有会话，有 workspaceId | 私聊 | 新会话落在该 bot 的 workspace | PASS |
| 6 | 有会话，有 workspaceId | 重置 | 新会话仍落在该 workspace，绑定不变 | PASS |
| 7 | 宿主新建的会话 | 发消息 | 回复以 bot 身份说话（人格注入生效） | PASS |

结果：**25/25 检查通过**（另：`chat-flow 4/4`、`e2e-chat-api 8/8`）。

### workspace 归属规则

1. `bot.workspaceId` 能解析成 workspace → 用它；
2. 否则用会话 cwd 去 `workspaceRegistry.resolveByPath` → 命中就用；
3. 都失败 → 用默认 workspace，并把会话 cwd 改成默认 workspace 的路径。

会话创建统一走 `sessionController.create({ workspaceId })`（宿主公告给所有客户端），随后 `selectModel` 记录模型路由、`bindSession` 写绑定、`rebind` 注入人格——所以「重置后能直接发消息」和「回复是 bot 而不是 lead」这两件事都成立。

### 关于「私聊后像是新对话」

空会话在 DSH 里本来就是 hero 视图（「探索未至之境 / 选择一个工作区 / 请选择模型」），容易被当成「新建了会话」。判定方法是看会话标题与主视图里的 session id：私聊打开的会话 `mainRef` 就是 bot 记着的那个 id。**在 composer 里手动切换工作区**才是真的新建草稿会话——那之后就不再属于这个 bot 了（这是 DSH 自身的草稿行为，插件无法拦）。

### v41 修复：人格没有注入

宿主建会话时 `agent/created` 早于 `bindSession`，`attach` 查不到 bot，于是回复用默认人格（自称 lead）。修复：`ensureSession` 在 `bindSession` 之后补 `await rebind(sessionId)`。矩阵第 7 项就是它的回归用例。
