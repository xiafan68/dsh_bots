# dsh-bots 实现笔记（v1）

面向维护者：这一版怎么搭的、踩过哪些坑、下一轮从哪接。

## 结构

```
D:\codes\dsh-bots
├─ package.json          # bundle 声明：dsh.bundle.patch / dsh.client
├─ cordis.patch.yml      # 插入 id: dsh-bots 一行
├─ icon.svg              # 插件图标（线性三柱）
├─ locale/{zh,en}.json   # meta.title / meta.description
├─ lib/index.js          # 只是 re-export src/index.mjs
├─ lib/client.js         # 手写 ModuleLoader 工厂（不打包、不依赖构建）
├─ src/index.mjs         # 插件入口：Config、agent 事件、webServer/tools 注入
├─ src/store.mjs         # JSON 域存储（原子写 + 串行队列）
├─ src/service.mjs       # 人格注入、会话创建、派发、通知
├─ src/tools.mjs         # 角色工具集（主控 / 执行）
├─ src/bff.mjs           # /dsh-bots/api 路由
└─ tmp/                  # 离线桩测试与调试脚本（不入库可删）
```

Host 侧不 import 任何 `@deepseek-ai/dsh-*` 包：需要 `defineTool` 时 `ctx.require('@deepseek-ai/dsh-tools')`，取服务统一 `ctx.get(name, false)`。这样 bundle 不需要 peerDependencies，也不会因为宿主的 node_modules 布局变化而崩。

## 三个关键机制

**角色 = 会话 → bot 绑定。** `bindings` 里每个 sessionId 记着 botId 与 kind（private / task）。`agent/created` 时按 sessionId 找到 bot，注入人格 section（`systemPrompt.section`）并按角色 `tools.restrict({ deny })` 收掉越权工具。工具执行时再算一次角色，所以即使可见性没收干净，越权调用也会被拒。

**派发 = 确保会话 + 投结构化消息。** `dispatchTask` 先校验（未结束、无进行中轮次、有 bot 指派），再复用/恢复/新建任务会话，写 round 与 `activeRoundId`，最后 `agent.followup({ content:[{type:'text',text}], source:{kind:'user'} })`。轮次结束用 `whenIdle()` 看门狗兜底（延迟 2s 再等，避免刚入队就被判空闲）。

**通知 = 先落库再投递。** 每条通知先写 `notifications`（`target: 'orchestrator'`），投递成功才 `markNotificationsDelivered`。主控会话不在线时留在库里，下次 `openBotChat` 或 `agent/created` 时 `flushPendingNotifications()` 补发。

## 三个必须知道的坑

1. **`agents.create` 不带 `agentOptions` 的会话没有模型路由。** 会话能建、事件能写，但 turn 空跑（prompt/response 全空、stats 为 0）。必须从任一活 agent 的 `options.provider/model` 继承。`service.mjs` 里的 `agentOptions()` 就是干这个的。
2. **`followup` 收结构化消息，不需要 `createUserMessage`。** `dsh-llm` 在宿主里 `ctx.require` 解不出来，早期版本因此在派发时 409；直接用 `{ role: 'user', content, source }` 就对了。**`role: 'user'` 不能省**：会话持久化按 `message.role` 校验，缺了它整条会话在重放时报 `session event at seq 8 message must have role "user"`，会话就打不开了（v5 修）。
3. **重装即重载。** `install_bundle` 对已装包报 `already-installed`，`set_plugin` 用包名报 `unknown-plugin`；`remove_bundle` + `install_bundle` 会立刻重载 Host 代码。`/dsh-bots/api/state` 返回的 `build` 字段用来确认宿主是否真的换了代码。

## 数据

`$DSH_HOME/storages/dsh-bots/db.json`：

```jsonc
{
  "version": 1,
  "seq": { "task": 4, "bot": 5, "round": 6, "comment": 7 },
  "bots": [{ "id": "bot-005", "name": "私人助理", "icon": "🧭", "systemPrompt": "...",
             "skills": [], "isOrchestrator": true, "workspaceId": "D:\\codes\\dsh-bots",
             "sessionId": "session-3834...", "archived": false }],
  "tasks": [{ "id": "T-0004", "title": "...", "brief": "...", "status": "in_review",
              "assignee": { "kind": "bot", "id": "bot-004" }, "agentRequired": true,
              "priority": "low", "labels": [], "workspaceId": null,
              "sessionId": "session-2b41...", "activeRoundId": null,
              "comments": [{ "author": "bot-004", "text": "...", "at": 1795... }] }],
  "rounds": [{ "id": "round-5", "taskId": "T-0004", "botId": "bot-004",
               "sessionId": "session-2b41...", "startedAt": 1795..., "endedAt": 1795...,
               "status": "completed", "note": "..." }],
  "bindings": [{ "sessionId": "session-2b41...", "botId": "bot-004",
                 "kind": "task", "taskId": "T-0004", "workspaceId": null }],
  "notifications": [{ "id": "n1795...", "taskId": null, "text": "...",
                      "target": "orchestrator", "delivered": true, "at": 1795... }],
  "settings": {}
}
```

## 下一轮可以接的

- 右侧栏「Bots」标签页（`sidebarRightTabs.register` + `sidebar.right.pane.tab`），把列表从主面板挪过去。
- 会话行 bot 图标 / 主控徽标（`sidebar.session.row.trailing`，只拿得到 sessionId，靠 bindings 反查）。
- 技能白名单真正收口：`skills` 的 per-agent 过滤目前没有官方窄口，需要 `${bot.skills}` 变量 + 提示词，或在 `skill` 工具上做 guard。
- 排队（ADR-0004 语义）：当前忙时直接 409，可以加每任务一条的队列。
- 验收闭环：主控 `task_update status=done` 目前不校验证据字段，可以要求 evidence 非空。

## v2（v43）：workspace 归属、会话跳转、全权限

数据里 `task.workspaceId` / `binding.workspaceId` 一直存在，v2 才把它们真正接通。

- **workspace 指派**：新建任务与任务详情都能选 workspace（`GET /state` 里的 `workspaces` 由 `workspaceRegistry.list()` 提供）；`dispatchTask` 遇到没有 workspace 的任务会 adopt bot 的 workspace。任务会话用 `workspacePathFor(workspaceId)` 把 id 反查成路径再建——只传 id 不够，`agents.create` 要的是 cwd。
- **改绑后自动重建**：`ensureTaskAgent` 先比较 `binding.workspaceId` 与「任务 workspace（或 bot workspace）」，不一致就 `rebuildTaskSession`：detach → `unbindSession` → 清 `task.sessionId` → `ensureSession` → 回写 `sessionId` → `bindSession`，并在任务里留一条 system 评论。所以「先派发、再改 workspace、再派发」不会继续在旧目录里跑。
- **跳转会话**：BFF 新增 `POST /tasks/:id/open-session`（用 `liveAgent` 确认这段会话在当前宿主确实能打开，再把 id 交给客户端的 `openAnnouncedSession`）与 `POST /tasks/:id/session`（= 新开会话）。客户端在任务详情里显示 sessionId 与「打开会话 / 新开会话」两个按钮；打不开时说明原因（通常是会话属于别的 workspace / profile）。
- **工具**：主控新增 `task_new_session`（`task_id` / `workspace_id` / `reason`）；`task_update` 增加 `workspace_id`。改绑只改数据，下一次派发触发重建（也可以立刻 `task_new_session`）。
- **权限**：`grantFullAccess` 优先 `ctx.permissionPresets.set(session, 'danger-full-access')`——一次把 sandbox 与 approval 两个旋钮都切过去；宿主的 `permissionPresets` 服务不存在时才退回 `approval.setPolicy(agent, 'never')`。
- **测试**：`tests/store.test.mjs` 覆盖 workspace 改绑、`unbindSession`、会话回写；`npm test` 串跑决策表与存储层。`BUILD` 升到 `v43-workspace-sessions`，可用 `/dsh-bots/api/state` 确认宿主已换代码。

## v43 补充：主控怎么看得到 workspace

`rosterText` 只列 bot，主控原本无从知道 workspace 的 id，`task_create.workspace_id` 只能靠用户口述路径。补法沿用 roster 的机制——`systemPrompt.variable` + `systemPrompt.context`（不是对话消息，也不是 system 节点）：

- `workspaceRosterText(self)` 每次请求前同步读 `workspaceRegistry.list()`，输出标题 / `workspace_id` / 路径，并标出「默认」与「你当前会话在这里」（按 id 或规范化后的路径比对）；结果按 id 排序，注册表顺序变化不会导致文本抖动。
- `applyRoster` 里注册 context `dsh-bots:orchestrator-workspaces`（order 10260，紧跟 bot 名单的 10250，`required: true`），文本说明三件事：不填 workspace_id 会继承当前 workspace；任务会话开在任务自己的 workspace，与主控会话无关；DSH 只校验目标 workspace 存在，不限制跨 workspace 建会话，改错后用 `task_update` + `task_new_session`。
- bot 名单也在 v2 里从 section 换成了 context：`dsh-bots:orchestrator-roster`（order 10250，`required: true`）。两段都靠 `{{dsh_bots_roster}}` / `{{dsh_bots_workspaces}}` 变量插值，变量仍由 `systemPrompt.variable` 提供。
- 为什么是 context：`docs/architecture.md:130` 的不变量是「Model-visible means logged」，任何模型可见输入都必须有 session event，所以「注入但不落日志」在本框架里做不到；而 `systemPrompt.context` 是框架明确标注的 cache-safe 形态——快照只在内容变化时追加在保留历史之后，不会重写 system/message 节点 0。`required: true` 保证即使全局关掉可选 runtime-context，这两段仍然在。
- 测试：`tests/roster.test.mjs` 用假 ctx / store 走真实 `attach`，断言两段 context 的注册、`required`、变量引用、id/路径/默认/当前会话标记，以及空仓库与无 `workspaceRegistry` 时的降级文案。

### prompt cache 上的代价

DSH 的 `docs/subsystems/system-prompt.md` 写明两条不同的落点：section 的渲染文本「committed as a `system/message` surface node — appended as surface node 0 on the first step, then replaced in place when the rendered text changes」；context 则是「cache-safe counterpart」，快照只在变化时追加在保留历史之后。也就是说：

- 内容不变时两者都不产生新 token，steady state 不掉 cache；
- section 一旦变，会重写节点 0 —— 后续整段对话的前缀全部失配，下一次请求按未缓存计；
- context 变化只在尾部追加一小段快照，前面全部复用，只有新增的 token 未命中；代价是这段会作为 user-role 快照进入历史（压缩时会被遮蔽）。

bot 名单和 workspace 清单都可能在会话中途变（新建 bot、加 workspace），而且它们位于提示词最靠前的部分，用 section 会连累整段前缀，所以两段都改成了 `systemPrompt.context` + `required: true`。`workspaceRosterText` / `rosterText` 的输出按 id 排序，保证「内容没变就一个字都不变」，不会因为注册表顺序抖动而产生新快照。

## v44：协作台与右侧栏入口

界面层只动了 `lib/client.js`，数据与工具不变。

- **改名**：侧栏入口、板头标题、右侧栏标签都从「任务板 / Bots」统一成「协作台」；板内两个页签仍是「任务 / Bots」。
- **去重**：删掉左侧第二个 `sidebar.panellist`（`dsh-bots-bots`）及其 `main` 面板、`BotsPanel` 组件，bot 列表只在协作台的「Bots」页签里。
- **右侧栏**：`sidebarRightTabs.register` 的标签标题改成「协作台」，`sidebar.right.pane.tab` 的 body 从原来的 `BotsSidePane` 换成同一份 `Panel`——聊天时点开就是完整看板（含「+ 任务」「+ Bot」），不用切走。`BotsSidePane` 与板头的「右侧栏」按钮因此一并删除。
- **代价**：右侧栏用 `keepMounted`，面板在关闭状态下仍每 10 秒拉一次 `/state`；本地服务，暂时可接受，需要时改成「可见时才轮询」。
- `BUILD` 升到 `v44-collab-pane`。

## v45：roster 与 workspace 清单改走 runtime context

两段提示从 `systemPrompt.section` 换成 `systemPrompt.context`（`required: true`），理由见上面「prompt cache 上的代价」：会话中途新建 bot / 加 workspace 时，section 会重写 system/message 节点 0、作废整段前缀；context 只在尾部追加一份快照。

- 实测：宿主重载后，主控会话（`session-931dde89-…`）的下一次组装在 `seq 460` 追加了一条 `source.kind='runtime-context'` 的 user-role 快照，长度 2264 字符，里面同时含 bot 名单与 workspace 清单（`workspace_id: 91f1d133…`、默认与「你当前会话在这里」标记）；之后多个 step 没有再追加，说明文本没变就不会产生新快照。
- 变量仍由 `systemPrompt.variable` 提供（`dsh_bots_roster` / `dsh_bots_workspaces`），context 文本里的 `{{…}}` 正常插值。
- `required: true` 保留原先 section 的语义：即使全局关掉可选 runtime-context，这两段仍然在（否则主控会静默失去 bot 与 workspace 名单）。
- roster 去掉了每个 bot 的「在办 N / 空闲」计数：那部分随任务起止翻转，会把任务 churn 变成快照 churn；现在的名单只含名字、id、主控标记、技能、是否已有会话，负载让主控需要时用 `task_list` 查。`tests/roster.test.mjs` 里加了一条断言防止它被加回来。
- 开发期现象：插件重载时 context 会先 dispose 再重注册，于是会话里会各留下一条「没有 roster」和「有 roster」的快照（实测 seq 515 → 526）。这是重载造成的，steady state 不会发生；生产环境只在插件升级时出现一次。
- `BUILD` 升到 `v45-context-roster`。