function compileDeclaration(decl) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(decl.parameters || {})) {
    const node = {}
    for (const [prop, value] of Object.entries(spec || {})) {
      if (prop === 'required') continue
      if (prop === 'type' && value === 'json') continue
      node[prop] = value
    }
    if (!node.type) node.type = 'string'
    properties[key] = node
    if (spec && spec.required) required.push(key)
  }
  return {
    name: decl.name,
    description: decl.description,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
    ...(decl.output ? { output: decl.output } : {}),
    ...(decl.timeoutMs ? { timeoutMs: decl.timeoutMs } : {}),
    execute: decl.execute,
  }
}

function resolveDefineTool(ctx, log) {
  try {
    const mod = ctx.require('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') return mod.defineTool
  } catch (error) {
    log('dsh-bots: defineTool unavailable, using local compiler', error)
  }
  return compileDeclaration
}

const textOutput = (decl) => ({
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
  ...(decl.output || {}),
})

function fmtTask(task) {
  const assignee = task.assignee ? `${task.assignee.kind}:${task.assignee.id}` : '未指派'
  const lines = [
    `${task.id}  [${task.status}]  ${task.title}`,
    `指派 ${assignee} · 优先级 ${task.priority} · agentRequired ${task.agentRequired ? 'yes' : 'no'}${task.workspaceId ? ` · workspace ${task.workspaceId}` : ''}${task.sessionId ? ` · 会话 ${task.sessionId}` : ''}`,
  ]
  if (task.brief.trim()) lines.push(`说明：${task.brief.trim()}`)
  if (task.result) lines.push(`结果：${task.result}`)
  if (task.comments.length) {
    lines.push('评论：')
    for (const comment of task.comments.slice(-5)) lines.push(`  - [${comment.author}] ${comment.text}`)
  }
  return lines.join('\n')
}

export function registerTools({ ctx, store, service, log }) {
  const defineTool = resolveDefineTool(ctx, log)
  const registry = ctx.get('tools', false) || ctx.tools
  if (!registry || typeof registry.register !== 'function') {
    log('dsh-bots: tools service unavailable; model tools skipped')
    return () => {}
  }

  const disposers = []

  async function roleOf(exec) {
    const agent = exec && exec.agent
    const sessionId = agent && agent.session && typeof agent.session === 'object' ? agent.session.id : agent && agent.sessionId
    if (!sessionId) return { role: 'orchestrator', sessionId: null }
    const role = await service.roleOfSession(sessionId)
    const bot = await service.botForSession(sessionId)
    return { role: role || 'orchestrator', sessionId, bot }
  }

  function register(decl, options = {}) {
    const definition = defineTool({
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters || {},
      output: textOutput(decl),
      timeoutMs: decl.timeoutMs || 20000,
      async execute(args, exec) {
        const { role, sessionId, bot } = await roleOf(exec)
        if (decl.roles && !decl.roles.includes(role)) {
          return `权限不足：${decl.name} 只对${decl.roles.includes('orchestrator') ? '主控 bot' : '执行 bot'}开放（当前会话 ${sessionId || '未知'} 的角色是 ${role}）。`
        }
        try {
          return await decl.run({ args: args || {}, role, sessionId, bot, store, service, exec })
        } catch (error) {
          return `失败：${error && error.message ? error.message : error}`
        }
      },
    })
    try {
      const dispose = registry.register(definition, `dsh-bots:${decl.name}`)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log(`dsh-bots: failed to register tool ${decl.name}`, error)
    }
  }

  // ------------------------------------------------------------ orchestrator

  register({
    name: 'bot_list',
    description: '列出这台机器上配置的所有 bot（名字、id、是否主控、已启用的技能、是否有私聊会话）。分派任务前先用它确认目标 bot。',
    roles: ['orchestrator'],
    parameters: {},
    async run({ store }) {
      const bots = await store.listBots()
      if (!bots.length) return '还没有任何 bot。让用户先在侧栏 Bots 面板里创建。'
      return bots
        .map((bot) => `${bot.id}  ${bot.name}${bot.isOrchestrator ? '  [主控]' : ''}${bot.sessionId ? '  [有会话]' : ''}  技能：${bot.skills.join('、') || '无'}`)
        .join('\n')
    },
  })

  register({
    name: 'bot_create',
    description: '创建一个 bot。只有用户明确要求时使用；创建后可以用 bot 的会话做事。',
    roles: ['orchestrator'],
    parameters: {
      name: { type: 'string', required: true, description: 'bot 的名字，例如「前端工程师」' },
      system_prompt: { type: 'string', description: '这个 bot 的额外人格与工作规范（会追加在系统提示里）' },
      skills: { type: 'string', description: '要启用的用户级技能，逗号分隔；项目工作区自带技能会自动加载' },
      is_orchestrator: { type: 'boolean', description: '是否设为主控 bot（全局最多一个）' },
    },
    async run({ args, store }) {
      const bot = await store.createBot({
        name: args.name,
        systemPrompt: args.system_prompt || '',
        skills: String(args.skills || '').split(',').map((item) => item.trim()).filter(Boolean),
        isOrchestrator: Boolean(args.is_orchestrator),
      })
      return `已创建 ${bot.id}「${bot.name}」。用户可以在侧栏 Bots 面板里点它开私聊。`
    },
  })

  register({
    name: 'task_create',
    description:
      '在任务板上创建任务。任务描述必须自包含：执行者看不到你和用户的对话。写完读一遍，问自己「一个没参与过对话的人能只靠这段文字做完吗」。只花几十秒的事不要建任务。',
    roles: ['orchestrator'],
    parameters: {
      title: { type: 'string', required: true, description: '一句话说清要做什么，例如「修复登录页在 Safari 下按钮错位」' },
      brief: {
        type: 'string',
        description: '任务全文，建议五段：背景（为什么做）/ 目标（做完是什么样）/ 验收标准（怎么算完成）/ 相关位置（文件、命令、链接）/ 禁止事项（不要动什么）',
      },
      assignee_bot_id: { type: 'string', description: '指派给哪个 bot 的 id；留空表示等人或稍后分派' },
      agent_required: { type: 'boolean', description: '是否要求 agent 执行（默认 true）；false 表示人可以自己干' },
      priority: { type: 'string', description: 'low / normal / high / urgent，默认 normal' },
      labels: { type: 'string', description: '标签，逗号分隔' },
      status: { type: 'string', description: 'backlog / todo，默认 todo（todo 表示可以派了）' },
      notify: { type: 'string', description: '任务结束时怎么通知主控：silent（只进收件箱）/ visible（发可见通知）；留空按默认' },
      workspace_id: { type: 'string', description: '任务绑定的 workspace（id 或绝对路径）；留空继承你当前会话所在的 workspace。可选的 id 见系统提示里的「可用的 workspace」清单。执行 bot 的会话会开在这个 workspace 里' },
    },
    async run({ args, store, exec, service }) {
      let assignee = null
      if (args.assignee_bot_id) {
        const bot = await store.getBot(args.assignee_bot_id)
        if (!bot) return `没有找到 bot ${args.assignee_bot_id}，先用 bot_list 看看。`
        assignee = { kind: 'bot', id: bot.id }
      }
      // A task inherits the caller's workspace so its session lands in the same
      // project instead of the profile default directory; an explicit
      // workspace_id wins so the board can retarget a task after the fact.
      let workspaceId = null
      try {
        workspaceId = args.workspace_id ? await service.normalizeWorkspace(String(args.workspace_id)) : null
        if (!workspaceId) {
          const cwd = service.agentCwdOf(exec && exec.agent)
          workspaceId = await service.workspaceIdForCwd(cwd)
        }
      } catch (error) {
        workspaceId = null
      }
      const task = await store.createTask({
        title: args.title,
        brief: args.brief || '',
        assignee,
        agentRequired: args.agent_required,
        priority: args.priority,
        labels: String(args.labels || '').split(',').map((item) => item.trim()).filter(Boolean),
        status: args.status || 'todo',
        workspaceId,
      })
      return `已创建 ${task.id}「${task.title}」${assignee ? `，指派给 ${assignee.id}` : '，暂未指派'}${workspaceId ? `，workspace ${workspaceId}` : ''}。`
    },
  })

  register({
    name: 'task_list',
    description: '读任务板。不带参数返回全部未结束任务；可按状态或指派过滤。汇报进展前先调它，不要凭印象。',
    roles: ['orchestrator'],
    parameters: {
      status: { type: 'string', description: 'backlog / todo / in_progress / in_review / done / blocked / canceled；留空返回全部' },
      assignee_bot_id: { type: 'string', description: '只看某个 bot 的任务' },
      limit: { type: 'number', description: '最多返回多少条，默认 30' },
    },
    async run({ args, store }) {
      let tasks = await store.listTasks()
      if (args.status) tasks = tasks.filter((task) => task.status === args.status)
      if (args.assignee_bot_id) tasks = tasks.filter((task) => task.assignee && task.assignee.id === args.assignee_bot_id)
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 30
      if (!tasks.length) return '没有匹配的任务。'
      const shown = tasks.slice(0, limit)
      const counts = tasks.reduce((acc, task) => ((acc[task.status] = (acc[task.status] || 0) + 1), acc), {})
      const summary = Object.entries(counts).map(([status, count]) => `${status}:${count}`).join('  ')
      return `${summary}\n\n${shown.map(fmtTask).join('\n\n')}${tasks.length > shown.length ? `\n\n（仅显示前 ${shown.length} 条，共 ${tasks.length} 条）` : ''}`
    },
  })

  register({
    name: 'task_get',
    description: '读一条任务的完整内容，包括评论与最近结果。',
    roles: ['orchestrator', 'worker'],
    parameters: { task_id: { type: 'string', required: true, description: '任务 id，例如 T-0003' } },
    async run({ args, store }) {
      const task = await store.getTask(args.task_id)
      if (!task) return `没有任务 ${args.task_id}。`
      return fmtTask(task)
    },
  })

  register({
    name: 'task_update',
    description: '改任务：验收通过设为 done、打回设回 todo、补说明、调优先级。把任务设为 done 等于你确认验收标准已经满足。',
    roles: ['orchestrator'],
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id' },
      status: { type: 'string', description: 'backlog / todo / in_progress / in_review / done / blocked / canceled' },
      title: { type: 'string', description: '新标题' },
      brief: { type: 'string', description: '新的任务全文' },
      priority: { type: 'string', description: 'low / normal / high / urgent' },
      notify: { type: 'string', description: 'silent / visible；留空恢复默认' },
      result: { type: 'string', description: '验收结论或最终结果' },
      workspace_id: { type: 'string', description: '把任务改绑到另一个 workspace（id 或绝对路径）；留空不动。改了之后执行会话仍开在旧目录，派发时会自动重建，也可以直接 task_new_session' },
    },
    async run({ args, store, service }) {
      const before = await store.getTask(args.task_id)
      if (!before) return `没有任务 ${args.task_id}。`
      let workspaceId
      if (args.workspace_id) {
        workspaceId = await service.normalizeWorkspace(String(args.workspace_id))
        if (!workspaceId) return `没法把 workspace「${args.workspace_id}」解析成已知工作区；用 workspace 的 id 或绝对路径。`
      }
      const task = await store.updateTask(args.task_id, {
        status: args.status,
        title: args.title,
        brief: args.brief,
        priority: args.priority,
        notify: args.notify,
        result: args.result,
        ...(workspaceId ? { workspaceId } : {}),
      })
      if (!task) return `没有任务 ${args.task_id}。`
      const moved = workspaceId && before.workspaceId !== workspaceId
      const stale = moved && task.sessionId
      return `已更新 ${task.id}：状态 ${task.status}${moved ? `，workspace → ${workspaceId}` : ''}。${stale ? ` 执行会话 ${task.sessionId} 还在旧 workspace；下次派发会自动重建，或现在用 task_new_session 立即重建。` : ''}`
    },
  })

  register({
    name: 'inbox_list',
    description: '读任务板的后台事件（执行 bot 交回、轮次结束等）。这些事件不会主动发消息，读完即标记为已读。返回最近的待处理条目。',
    roles: ['orchestrator'],
    parameters: {
      limit: { type: 'number', description: '最多返回几条，默认 10' },
    },
    async run({ args, store }) {
      const pending = (await store.pendingNotifications()).filter((item) => item.target === 'orchestrator' && !item.urgent)
      if (!pending.length) return '收件箱是空的：最近没有新的后台事件。'
      const limit = Math.max(1, Math.min(30, Number(args.limit) || 10))
      const items = pending.slice(-limit)
      await store.markNotificationsDelivered(items.map((item) => item.id))
      return ['共 ' + pending.length + ' 条待读，下面是最近 ' + items.length + ' 条（已标记为已读）：']
        .concat(items.map((item) => '- ' + item.text.replace(/\n+/g, ' ')))
        .join('\n')
    },
  })

  register({
    name: 'task_assign',
    description: '把任务指派给某个 bot 或留空。指派前用 bot_list 确认它存在且能力合适。',
    roles: ['orchestrator'],
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id' },
      bot_id: { type: 'string', description: '目标 bot id；传空字符串表示取消指派' },
      agent_required: { type: 'boolean', description: '是否要求 agent 执行' },
    },
    async run({ args, store }) {
      const assignee = args.bot_id ? { kind: 'bot', id: String(args.bot_id) } : null
      if (assignee) {
        const bot = await store.getBot(assignee.id)
        if (!bot) return `没有找到 bot ${assignee.id}。`
      }
      const task = await store.updateTask(args.task_id, { assignee, ...(args.agent_required === undefined ? {} : { agentRequired: args.agent_required }) })
      if (!task) return `没有任务 ${args.task_id}。`
      return `已把 ${task.id} 指派给 ${assignee ? assignee.id : '（空）'}。`
    },
  })

  register({
    name: 'task_dispatch',
    description: '把任务正式派给当前指派的 bot：给它建（或复用）一个会话，把任务全文发进去，任务进入处理中。派之前确认任务说明足够自包含。',
    roles: ['orchestrator'],
    parameters: { task_id: { type: 'string', required: true, description: '任务 id' } },
    async run({ args, service, bot }) {
      const result = await service.dispatchTask(args.task_id, { byBotId: bot ? bot.id : null })
      if (!result.ok) return result.error
      return `已派发 ${result.taskId}（轮次 ${result.roundId}），会话 ${result.sessionId}。它完成后会用 task_complete 交回，你会收到通知。`
    },
  })

  register({
    name: 'task_new_session',
    description:
      '给任务换一个新的执行会话：绑错了 workspace、旧会话打不开、或旧会话已经脏到没法继续时用。旧会话会被解绑作废（正在跑的轮次会被停止），任务、评论与历史都保留；新会话开在任务的 workspace 里。换完用 task_dispatch 重新派发。',
    roles: ['orchestrator'],
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id' },
      workspace_id: { type: 'string', description: '顺便把任务改绑到哪个 workspace（id 或绝对路径）；留空用任务当前的 workspace' },
      reason: { type: 'string', description: '为什么要换会话（会记进任务评论，方便事后追）' },
    },
    async run({ args, service, bot, store }) {
      const result = await service.newTaskSession(args.task_id, { workspaceId: args.workspace_id ? String(args.workspace_id) : undefined })
      if (!result.ok) return result.error
      if (args.reason) {
        await store.addComment(result.taskId, bot ? bot.id : 'orchestrator', `换会话：${String(args.reason).trim()}`).catch(() => {})
      }
      return `已为 ${result.taskId} 新建执行会话 ${result.sessionId}${result.workspaceId ? `（workspace ${result.workspaceId}）` : ''}${result.previousSessionId ? `，旧会话 ${result.previousSessionId} 已解绑` : ''}。用 task_dispatch 重新派发。`
    },
  })

  register({
    name: 'task_comment',
    description: '在任务下留一条评论。给执行者补充上下文、记录你的判断、或说明打回原因。',
    roles: ['orchestrator', 'worker'],
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id' },
      text: { type: 'string', required: true, description: '评论内容' },
    },
    async run({ args, role, bot, store }) {
      const author = bot ? bot.id : role === 'worker' ? 'worker' : 'human'
      const comment = await store.addComment(args.task_id, author, args.text)
      if (!comment) return `没有任务 ${args.task_id}。`
      return `已记录评论到 ${args.task_id}。`
    },
  })

  // ------------------------------------------------------------ worker

  register({
    name: 'task_complete',
    description:
      '交回任务。必须写清做了什么、怎么验证的、有什么没做到。没有证据的「已完成」会被打回。调用后任务进入待验收，主控会收到通知。',
    roles: ['orchestrator', 'worker'],
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id' },
      summary: { type: 'string', required: true, description: '做了什么：改了哪些文件、关键行为如何变化' },
      evidence: { type: 'string', description: '怎么验证的：命令、输出、截图路径、对比结果' },
      gaps: { type: 'string', description: '没做到的、已知风险、需要主控决策的点' },
    },
    async run({ args, bot, store, service }) {
      const task = await store.getTask(args.task_id)
      if (!task) return `没有任务 ${args.task_id}。`
      if (!task.activeRoundId) return `任务 ${task.id} 当前没有进行中的轮次，不需要交回。`
      const lines = [`【${bot ? bot.name : '执行 bot'} 交回】`, args.summary.trim()]
      if (args.evidence) lines.push(`验证：${args.evidence.trim()}`)
      if (args.gaps) lines.push(`未完成/风险：${args.gaps.trim()}`)
      const result = lines.join('\n')
      await store.addComment(task.id, bot ? bot.id : 'worker', result)
      const finished = await service.finishRound(task.id, { status: 'completed', note: args.summary.slice(0, 200), result })
      return finished && finished.task ? `已交回 ${task.id}，等待验收。` : `已交回 ${task.id}。`
    },
  })

  register({
    name: 'task_block',
    description: '卡住了：说明缺什么信息、需要谁做决定，任务进入受阻状态并通知主控。不要用它代替「我再试试」。',
    roles: ['orchestrator', 'worker'],
    parameters: {
      task_id: { type: 'string', required: true, description: '任务 id' },
      reason: { type: 'string', required: true, description: '具体卡在哪、需要什么才能继续' },
    },
    async run({ args, bot, store, service }) {
      const task = await store.getTask(args.task_id)
      if (!task) return `没有任务 ${args.task_id}。`
      await store.addComment(task.id, bot ? bot.id : 'worker', `【受阻】${args.reason}`)
      if (task.activeRoundId) {
        // finishRound announces the failure; a second notice here would be noise.
        await service.finishRound(task.id, { status: 'failed', note: args.reason })
      } else {
        await service.notifyOrchestrator(`任务 ${task.id}「${task.title}」受阻：${args.reason}`, { urgent: true, taskId: task.id })
      }
      await store.updateTask(task.id, { status: 'blocked' })
      return `已把 ${task.id} 标记为受阻并通知主控。`
    },
  })

  register({
    name: 'session_list',
    description: '列出与任务板相关的会话（bot 私聊、任务轮次），用于了解协作中的其他工作。只返回元数据，不返回对话内容。',
    roles: ['worker', 'orchestrator'],
    parameters: { limit: { type: 'number', description: '最多返回多少条，默认 20' } },
    async run({ args, store }) {
      const [bindings, tasks, bots] = await Promise.all([store.listBindings(), store.listTasks(), store.listBots()])
      const botName = new Map(bots.map((bot) => [bot.id, bot.name]))
      const taskTitle = new Map(tasks.map((task) => [task.id, task.title]))
      const rows = bindings.map((binding) => {
        const owner = binding.botId ? botName.get(binding.botId) || binding.botId : '未绑定'
        const task = binding.taskId ? `${binding.taskId} ${taskTitle.get(binding.taskId) || ''}` : '私聊'
        return `${binding.sessionId}  ${binding.kind}  ${owner}  ${task}`
      })
      if (!rows.length) return '还没有登记任何会话。'
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 20
      return rows.slice(0, limit).join('\n')
    },
  })

  register({
    name: 'session_get',
    description: '查一个会话属于哪个 bot、对应哪条任务、任务当前状态。用于确认「这个会话是谁在干什么」。不返回对话内容。',
    roles: ['worker', 'orchestrator'],
    parameters: { session_id: { type: 'string', required: true, description: '会话 id' } },
    async run({ args, store }) {
      const bindings = await store.listBindings()
      const binding = bindings.find((item) => item.sessionId === args.session_id)
      if (!binding) {
        const bot = await store.findBotBySession(args.session_id)
        if (!bot) return `没有登记过会话 ${args.session_id}。`
        return `${args.session_id} 是 bot ${bot.id}「${bot.name}」的会话。`
      }
      const bot = binding.botId ? await store.getBot(binding.botId) : null
      const task = binding.taskId ? await store.getTask(binding.taskId) : null
      return [
        `会话 ${binding.sessionId}`,
        `类型：${binding.kind}`,
        `bot：${bot ? `${bot.id}「${bot.name}」` : '无'}`,
        `任务：${task ? `${task.id}「${task.title}」 状态 ${task.status}` : '无'}`,
      ].join('\n')
    },
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }
}