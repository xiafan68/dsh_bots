# dsh-bots

Bots + 共享任务看板，作为 DSH 插件安装在侧栏。人可以直接和 bot 私聊派活，也可以把活变成任务；主控 bot 负责把任务分派给具体 bot，并在完成后汇总汇报。

## 文档

- [文档索引](docs/README.md) —— 一页看全，按「你想知道什么」索引
- [需求文档](docs/requirements.md) —— 要解决什么问题、边界在哪
- [实现笔记](docs/implementation-notes.md) —— 面向维护者：怎么搭的、踩过哪些坑
- [端到端验证记录](docs/verification.md) —— 真实宿主 + headless Chrome 的实测过程
- [交互形态变迁分析](docs/interaction-shift.md) —— 从「人建会话指派」到「主控 Bot + 任务板」
- [模型假设分析](docs/model-assumptions.md) —— 这套协议对模型能力的要求

## 现在能做什么

- 侧栏「**协作台**」入口（`sidebar.panellist` + `main` keyed slot，带线性图标）——任务和 bots 都在这一处：一页「任务」看板、一页「Bots」列表。
- 右侧工具栏「**协作台**」（v44）——聊天时点开就是同一块板，顺手点「+ 任务」记录一条，不必切走对话；右侧栏只在有会话时出现。
- 旧的独立「Bots」侧栏行已移除（v44）：bot 列表就是协作台里的「Bots」页签，少一个重复入口。
- Bot 管理：名字、线性图标（12 个内置）、额外 system prompt、用户级技能白名单、主控标记。全局最多一个主控。
- **旧会话的边界**：如果某个 bot 的历史会话属于当前实例里不存在的工作区，点「私聊」会打开一个空的中转视图（DSH 找不到归属工作区时的默认态），不会自动新建——数据一致性优先，删掉该 bot 的会话或重建即可。
- **私聊复用**（v30）：一个 bot 只有一个私聊会话。点「私聊」先问宿主有没有，有就直接打开，没有才新建；重复点击不会再产生新会话。
- **回归用例**：`npm test`（决策表 4 条 + 存储层 3 条 + 主控提示 3 条）、`npm run test:api`（真实宿主 8 条）、`npm run test:matrix`（场景矩阵 25 条检查）。
- **任务指派 workspace（v43）**：新建与任务详情里都能选 workspace；任务会话就建在该 workspace 下，执行 bot 改的是那个项目，而不是宿主默认目录。任务卡片上直接显示所属 workspace。
- **执行会话可见、可跳转（v43）**：任务详情里有「执行会话」一行，显示会话 id，并提供「打开会话」直接跳到那段对话；点不开（会话属于别的 workspace/profile、日志不可读）时给出原因，而不是静默失败。
- **任务默认完全权限（v43）**：任务会话创建时按 `danger-full-access` 预设放行（沙箱不拦文件写入、审批不再打断），执行 bot 不会因为卡在「请求批准」而停住；宿主没有该预设时退回 `approval: never`。
- **主控可换会话（v43）**：主控有 `task_new_session`（任务详情里是「新开会话」）。workspace 改错了、旧会话打不开、或会话已经脏了，就换一个新的执行会话——旧会话解绑作废，任务、轮次与评论都保留；改完 workspace 再派发时也会自动重建会话，不会继续用旧目录。
- **主控知道有哪些 workspace（v43）**：主控的系统提示里多了一段「可用的 workspace」，每次请求前刷新——标题、id、路径、默认工作区、以及哪个是它自己会话所在；`task_create` / `task_update` / `task_new_session` 可以直接按 id 或路径指定。清单由 `systemPrompt.section` 渲染，属于系统提示的一部分，不会在对话里堆消息。跨 workspace 建执行会话不受 DSH 限制（只校验目标 workspace 存在），这一点也写进了主控提示。
- **协作台（v44）**：侧栏原来的「任务板」改名为「协作台」，并把重复的「Bots」入口去掉了——bot 列表就是台面上的「Bots」页签。右侧工具栏也注册了「协作台」：聊天时顺手就能开板、点「+ 任务」记录一条，不用离开对话。
- **会话标题与归属**（v21）：私聊会话的标题就是 bot 名，任务会话是「bot 名 · 任务号」；两者都带 bot 图标，绑定记录里写明所属 workspace，会话本身也建在该 workspace 下。
- **私聊固定一个对话（v35）**：每个 bot 的私聊由宿主创建并记录，点多少次都回到同一个会话；卡片的「重置」（右侧栏是「↺」）会新开一个私有对话，旧对话仍留在会话列表里。宿主创建的会话会广播给界面，因此不会再出现「点私聊弹回选择工作区」。
- 私聊：点「私聊」为该 bot 创建（或复用）一个固定会话，并直接打开；主控首次打开时补发积压通知。
- 排队派发（v28）：任务已有一轮在跑时再点派发不会被拒，返回 202「已排队」，本轮结束后自动接着跑下一轮。
- **停止本轮**：任务在 `in_progress` 时，任务详情里有「停止本轮」，取消该轮并把任务打回 `blocked`，不必等看门狗。
- 任务看板五列：等你（待验收 + 受阻）、处理中、等待认领、已完成、待立项。窄窗口横向滚动，宽屏等分。
- 任务全文按「背景 / 目标 / 验收标准 / 相关位置 / 禁止事项」写，派发时原样投给执行 bot 的会话。
- 角色工具集（按会话 → bot 绑定判定，工具内部二次校验）：
  - 主控：`bot_list / bot_create / task_create / task_list / task_get / task_update / task_assign / task_dispatch / task_new_session / task_comment / task_complete / task_block / session_list / session_get`
  - 执行 bot：`task_get / task_comment / task_complete / task_block / session_list / session_get`
- 完成闭环：执行 bot 调 `task_complete`（强制写证据）→ 任务进入待验收 → **事件只落库、不发消息**（不唤醒、不改系统提示）→ 主控下次运行时用 `inbox_list` 拉取并决定要不要汇报 → 验收 `status=done` 或打回。每个任务可在详情里选「结束通知：默认 / 静默 / 可见」，选「可见」才把通知发进主控私聊；受阻与轮次异常永远发可见通知。
- 技能白名单（v17）：bot 的「技能」字段是用户级白名单，项目 workspace 自带的技能自动放行；超出集合的 `skill` 调用会被工具层拒绝。
- 右侧栏协作台（v44，接替 v18/v19 的 Bots 标签页）：会话右侧栏里一页完整的协作台（任务 + Bots 两个页签），点行即开私聊、点「+ 任务」即建任务；不再需要从面板头部顶出侧栏。
- **主控的 bot 名单**：主控 bot 每次请求前都会在系统提示末尾拿到「当前可用的其他 bots」（名字 · id · 主控标记 · 在办/空闲 · 技能 · 是否已有会话）。名单走 system-prompt 变量，每一步重新求值，新建/删除 bot 不需要重启或新会话。

## 安装

```powershell
plugin_manager install_bundle target=D:\codes\dsh-bots
```

改动 Host 代码后，`install_bundle` 对已安装包会返回 `already-installed`；用 `remove_bundle` + `install_bundle` 触发重新加载（会立即生效，`GET /dsh-bots/api/state` 的 `build` 字段可用于确认）。

## 数据

`$DSH_HOME/storages/dsh-bots/db.json`（原子写）。删除它等于清空 bot、任务、绑定与通知。

## 已验证（真实宿主 + 独立 CLI 实例，2026-11-21）

1. 建 bot（主控 / 执行）→ 私聊建会话（带模型路由）→ 会话被持久化。
2. 建任务 + 指派 + 派发 → 执行 bot 在自己会话里收到任务全文，回评论、调 `task_complete` 交回 → 任务进「等你」。
3. 交回后主控私聊里**不会**出现通知消息（任务详情里选「可见」除外）；主控需要时用 `inbox_list` 读收件箱，读完即清空。受阻、轮次异常仍会收到「【任务板通知】…」。
4. 执行 bot 调用 `session_list` 能列出自己的任务会话与主控私聊会话。
5. 浏览器侧（headless Chrome + CDP，独立 `bottest` profile）：侧栏入口、看板、Bots 卡片、私聊、发消息、面板内建任务、派发全流程跑通。细节与截图见 [docs/verification.md](docs/verification.md)。
6. 离线桩测试 `tmp\test-service.mjs` 覆盖派发管线（无需宿主）。

## 已知边界（v1）

- 快速入口有两处（v44）：左侧「协作台」行（完整看板）与会话右侧栏的「协作台」页签（不离开当前对话）；右侧栏只在有会话时存在。
- 会话行上的 bot 图标：已接（`sidebar.session.row.trailing`，v15），只对已有绑定的会话显示。
- 技能白名单在工具层真正拦截（v17）：`skill` 调用先查 bot 的用户级白名单，再放行 bot 所在 workspace 自带的技能（按技能资源路径是否落在 workspace 下判断）；集合外的调用被拒绝，并返回可用技能清单。
- 任务工作目录取 bot 的 workspace，取不到时退回当前工作区。
- 未做排队：一个任务同时只有一轮；轮次进行中再次派发返回 409。
- 宿主代码改动需要重启应用（Client 改刷新页面即可）。
- 桌面实例与 CLI 实例可以指向同一个数据目录：store 按文件 mtime/size 自动重载，写入前也会先加载最新版本，避免两个宿主互相覆盖（v14 起）。