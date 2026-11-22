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