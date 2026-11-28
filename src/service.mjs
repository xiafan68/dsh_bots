import { randomUUID } from 'node:crypto'

const ORCHESTRATOR_TOOLS = ['bot_list', 'task_create', 'task_list', 'task_get', 'task_update', 'task_assign', 'task_dispatch', 'task_new_session', 'task_comment']
const WORKER_TOOLS = ['task_get', 'task_comment', 'task_complete', 'task_block', 'session_list', 'session_get']

const WORKER_DENY = ['task_create', 'task_assign', 'task_dispatch', 'task_update', 'task_new_session', 'bot_list', 'bot_create', 'bot_update']
const ORCHESTRATOR_DENY = ['session_list', 'session_get']

const ROLE_ORCHESTRATOR = `你是这台 DSH 里的**主控 bot**（私人助理）。用户大多数时候只跟你说话。

你的职责：
1. 把用户的要求**记录成任务**，而不是自己直接动手做。除非它只花几十秒（查一个值、解释一句话），否则调用 task_create。
2. 任务描述必须自包含：背景、目标、验收标准、相关位置、禁止事项。执行者看不到你和用户的对话。
3. 决策由你来做：能自己决定，就不要「问一下用户」；只有涉及不可逆、花钱、改变既有约定时才问。
4. 分派前先看看 task_list，能合并的就合并，别造一堆重复任务。
5. 用户问「进展如何」时用 task_list 读真实状态，不要凭印象汇报；被验收通过的任务再说「完成」。
6. 任务每轮结束（交回、受阻、被停止、超时）都会以「任务板通知」的形式发给你，里面带着任务 id、执行方、结果与当前状态。收到后：先 task_get 读真实结果与评论 → 够格就 task_update status=done 验收，不够就补一句说明再 task_dispatch 打回重跑 → 需要用户知道时才用两三句话说结论，不要整段转述执行者的报告。
7. 没有通知时不要空转轮询：只有在用户问进展、或你要做派发决策时才 task_list / inbox_list。

关于你手上的工具：task_create / task_list / task_get / task_update / task_assign / task_dispatch / task_new_session / task_comment / bot_list。

任务执行会话默认拥有**完全权限**（无人值守，不会弹审批）。每个任务会绑定到它自己的 workspace；如果任务换了 workspace 而旧会话还在旧目录里，用 task_new_session 为它新建一个会话，旧会话会被解绑作废，任务本身与评论都保留。`

const ROLE_WORKER = `你是这台 DSH 里的一个**执行 bot**，通过任务板接活。用户不直接跟你对话，你看到的每条任务消息都来自任务板。

工作方式：
1. 先 task_get 读任务全文，确认背景、目标与验收标准；信息不足且无法从工作区自行查证时，用 task_block 说明缺什么，不要瞎猜着做完。
2. 动手做，充分使用你的工具与文件系统；产物写到任务「相关位置」指定的位置。
3. 完成后调用 task_complete，**必须**带上：做了什么改动（文件与关键行为）、怎么验证的（命令与结果）、没做到的与风险。没有证据的「已完成」会被打回。
4. 中途有实质进展或需要决策时用 task_comment 留言，不要沉默。
5. 你没有创建、指派、派发任务的权限——那是主控 bot 的事。

关于你手上的工具：task_get / task_comment / task_complete / task_block，以及 session_list / session_get（查看协作中其他会话的概况）。`

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function sessionIdOfAgent(agent) {
  if (!agent) return null
  const session = agent.session
  if (session && typeof session === 'object') {
    if (typeof session.id === 'string') return session.id
    if (typeof session.sessionId === 'string') return session.sessionId
  }
  if (typeof agent.sessionId === 'string') return agent.sessionId
  if (typeof agent.id === 'string') return agent.id
  return null
}

export function createService({ ctx, store, log }) {
  const ns = { agents: null, llm: null }
  const traces = []
  function trace(line) {
    traces.push(line)
    if (traces.length > 60) traces.shift()
    if (log) log('dsh-bots: ' + line)
  }

  function agentCwdOf(agent) {
    if (!agent) return null
    const candidates = [agent.identity && agent.identity.cwd, agent.meta && agent.meta.cwd, agent.options && agent.options.cwd]
    for (const value of candidates) if (typeof value === 'string' && value) return value
    return null
  }

  async function workspaceIdForCwd(cwd) {
    if (!cwd) return null
    const registry = ctx.get('workspaceRegistry', false)
    if (!registry || typeof registry.resolveByPath !== 'function') return null
    try {
      const workspace = await registry.resolveByPath(cwd)
      return (workspace && (workspace.workspaceId || workspace.id)) || null
    } catch (error) {
      trace('workspaceIdForCwd failed: ' + String(error && error.message ? error.message : error))
      return null
    }
  }

  // A workspace reference may be a path (bot.workspaceId) or an id (task
  // workspace, client). Storage keeps ids only, so normalize before binding.
  async function normalizeWorkspace(value) {
    if (!value) return null
    const text = String(value)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return text
    return workspaceIdForCwd(text)
  }

  async function renameSession(sessionId, title, agent) {
    const clean = String(title || '').trim().slice(0, 80)
    if (!clean) return
    // rename() takes a Session object, not an id: passing the id makes the
    // controller try to resume "undefined". Resolve a live agent first.
    let holder = agent || null
    if (!holder) {
      const registry = agents()
      holder = registry && typeof registry.get === 'function' ? registry.get(sessionId) : null
    }
    if (!holder) holder = await resumeSession(sessionId)
    const session = holder && holder.session
    if (!session) { trace('rename skipped (no session) ' + sessionId); return }
    const titles = ctx.get('sessionTitle', false)
    if (titles && typeof titles.rename === 'function') {
      try {
        await titles.rename(session, clean)
        trace('renamed ' + sessionId + ' -> ' + clean)
        return
      } catch (error) {
        trace('sessionTitle.rename failed: ' + String(error && error.message ? error.message : error))
      }
    }
    const controller = ctx.get('sessionController', false)
    if (controller && typeof controller.rename === 'function') {
      try {
        await controller.rename(session, clean)
        trace('controller.rename ' + sessionId + ' -> ' + clean)
      } catch (error) {
        trace('controller.rename failed: ' + String(error && error.message ? error.message : error))
      }
    }
  }

  function agents() {
    if (!ns.agents) ns.agents = ctx.get('agents', false) || null
    return ns.agents
  }

  function userMessage(text) {
    // agent.followup() takes a structural user-role message. Every persisted
    // message also needs a stable identity and role: 'user', otherwise replay
    // validation rejects the whole session as corrupt.
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
  }

  function agentOptions() {
    const registry = agents()
    try {
      const live = registry && typeof registry.list === 'function' ? registry.list() : []
      for (const item of Array.isArray(live) ? live : []) {
        const candidate = item && item.agent ? item.agent : item
        const opts = candidate && candidate.options
        if (opts && opts.provider && opts.model) return { provider: opts.provider, model: opts.model }
        const model = candidate && candidate.model
        const current = model && typeof model.current === 'function' ? model.current() : null
        if (current && current.provider && current.model) return { provider: current.provider, model: current.model }
      }
    } catch {
      /* best effort */
    }
    return null
  }

  // Bot sessions run unattended: a pending approval has no human to click it, so
  // the turn would hang forever. Task sessions therefore default to the profile's
  // full-access preset (danger-full-access sandbox + never approval): the bot can
  // edit files in its workspace without a prompt it could never get answered.
  function approvalService() {
    try {
      return ctx.get('approval', false)
    } catch {
      return null
    }
  }

  function relaxApproval(agent) {
    const approval = approvalService()
    if (!approval || typeof approval.setPolicy !== 'function') return false
    try {
      approval.setPolicy(agent, 'never')
      return true
    } catch (error) {
      log('dsh-bots: approval setPolicy failed', error)
      return false
    }
  }

  function permissionPresetService() {
    try {
      const presets = ctx.get('permissionPresets', false)
      return presets && typeof presets.set === 'function' ? presets : null
    } catch {
      return null
    }
  }

  // "Full access" is one durable event that flips both knobs (sandbox mode and
  // approval policy). Prefer the profile preset so the session behaves exactly
  // like the user's own full-access chats; fall back to approval "never" when the
  // preset service is not composed (older hosts, tests).
  function grantFullAccess(agent) {
    if (!agent) return 'none'
    const session = agent.session
    const presets = permissionPresetService()
    if (presets && session && typeof session === 'object' && session.id) {
      try {
        presets.set(session, 'danger-full-access')
        trace(`full-access preset for ${sessionIdOfAgent(agent)}`)
        return 'danger-full-access'
      } catch (error) {
        trace(`full-access preset failed: ${error && error.message ? error.message : error}`)
      }
    }
    if (relaxApproval(agent)) {
      trace(`approval never (full-access fallback) for ${sessionIdOfAgent(agent)}`)
      return 'never'
    }
    return 'none'
  }

  function liveCwd() {
    const registry = agents()
    const list = registry && typeof registry.list === 'function' ? registry.list() : []
    for (const item of Array.isArray(list) ? list : []) {
      const agent = item && item.agent ? item.agent : item
      if (!agent) continue
      for (const value of [agent.identity && agent.identity.cwd, agent.meta && agent.meta.cwd, agent.options && agent.options.cwd]) {
        if (typeof value === 'string' && value) return value
      }
    }
    return undefined
  }

  // Debug helper: what the orchestrator's pull-based inbox currently holds.
  function inboxText() {
    const pending = store.peek((data) => (data.notifications || []).filter((item) => !item.delivered && item.target === 'orchestrator' && !item.urgent))
    if (!pending.length) return '(empty)'
    return pending.slice(-8).map((item) => '- ' + String(item.text || '').replace(/\s+/g, ' ').slice(0, 180)).join('\n')
  }

  function botPrompt(bot) {
    const parts = []
    if (bot.systemPrompt.trim()) parts.push(bot.systemPrompt.trim())
    parts.push(bot.isOrchestrator ? ROLE_ORCHESTRATOR : ROLE_WORKER)
    if (bot.skills.length) {
      parts.push(`你被额外启用了这些技能：${bot.skills.join('、')}。需要时直接按技能说明使用；项目工作区自带的技能同样可用。`)
    }
    parts.push(`你的名字是「${bot.name}」。`)
    return parts.join('\n\n')
  }

  function taskPrompt(task, bot) {
    const lines = []
    lines.push(`【任务板 · ${task.id}】${task.title}`)
    lines.push('')
    lines.push(task.brief.trim() || '（任务没有更详细的描述，请先 task_get 确认，必要时 task_block 请主控补充。）')
    lines.push('')
    if (task.labels.length) lines.push(`标签：${task.labels.join('、')}`)
    lines.push(`指派人：${bot ? bot.name : '未指派'}　优先级：${task.priority}`)
    lines.push('')
    lines.push('开始前先 task_get 读一遍任务；完成后必须 task_complete 并附上证据；做不下去就 task_block 说明缺什么。')
    return lines.join('\n')
  }

  function applyPersona(agent, text) {
    const agentCtx = agent && agent.ctx
    if (!agentCtx || typeof agentCtx.get !== 'function') return () => {}
    const systemPrompt = agentCtx.get('systemPrompt', false)
    if (!systemPrompt || typeof systemPrompt.section !== 'function') { trace('persona skipped: no systemPrompt service'); return () => {} }
    try {
      // Shadow the deployment persona for this one agent, the same way the
      // `dsh-persona` row does: same section name, same registry-owned order.
      // Appending a second persona section instead would leave the harness
      // identity in place, and the model would keep calling itself "lead".
      const order = typeof systemPrompt.getSectionOrder === 'function'
        ? systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
        : 0
      const dispose = systemPrompt.section({ name: 'deployment:persona-prefix', order, text }) || (() => {})
      trace('persona section registered (' + text.length + ' chars, order ' + order + ')')
      return dispose
    } catch (error) {
      log('dsh-bots: persona section failed', error)
      return () => {}
    }
  }

  // The orchestrator always needs to know who it can hand work to. The roster is
  // registered as runtime context (a snapshot appended after retained history,
  // only when its text changed), so bots created or deleted mid-session show up
  // without a restart and without rewriting the cached prompt prefix.
  function rosterText(self) {
    const snapshot = store.peek((db) => ({ bots: db.bots || [], tasks: db.tasks || [] }))
    const others = snapshot.bots.filter((bot) => bot.id !== self.id && !bot.archived)
    if (!others.length) return '当前没有其他 bot。需要新帮手时可以用 bot_create 创建一个。'
    // Deliberately free of task state: this text lives in a runtime-context
    // snapshot, and every change appends a new one. A per-bot "在办 N" counter
    // flips on every dispatch/finish, which would turn task churn into context
    // churn; load is available through task_list when it actually matters.
    return others
      .map((bot) => {
        const bits = [bot.name, bot.id]
        if (bot.isOrchestrator) bits.push('主控')
        if (bot.skills.length) bits.push(`技能 ${bot.skills.join('/')}`)
        bits.push(bot.sessionId ? '已有会话' : '还没有会话')
        return '- ' + bits.join(' · ')
      })
      .join('\n')
  }

  // The orchestrator also needs to know which workspaces exist and what each is
  // for: a task binds to a workspace, and its session is created there. Exposed
  // through a system-prompt variable + runtime context rather than a chat
  // message, so the list never piles up in the conversation.
  function workspaceRosterText(self) {
    try {
      const registry = ctx.get('workspaceRegistry', false)
      if (!registry || typeof registry.list !== 'function') return '（workspace 服务不可用，暂时列不出来）'
      const state = typeof registry.state === 'object' && registry.state ? registry.state : null
      const defaultId = state && state.defaultWorkspaceId ? String(state.defaultWorkspaceId) : ''
      const own = String((self && (self.workspaceId || self.cwd)) || '')
      const plain = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const rows = (registry.list() || [])
        .map((workspace) => ({
          id: String(workspace.workspaceId || workspace.id || ''),
          path: (workspace.header && workspace.header.path) || workspace.path || workspace.cwd || '',
          title: (workspace.header && workspace.header.title) || workspace.title || '',
        }))
        .filter((workspace) => workspace.id)
        // Deterministic order: the rendered text is part of the cached prompt
        // prefix, so an incidental registry reorder must not invalidate it.
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      if (!rows.length) return '（还没有注册任何 workspace）'
      return rows
        .map((workspace) => {
          const bits = [workspace.title || workspace.path || workspace.id]
          if (workspace.id === defaultId) bits.push('默认')
          if (own && (workspace.id === own || (workspace.path && plain(workspace.path) === plain(own)))) bits.push('你当前会话在这里')
          return '- ' + bits.join(' · ') + '\n  workspace_id: ' + workspace.id + (workspace.path ? '\n  路径: ' + workspace.path : '')
        })
        .join('\n')
    } catch (error) {
      trace('workspaceRosterText failed: ' + String(error && error.message ? error.message : error))
      return '（读取 workspace 列表失败）'
    }
  }

  function applyRoster(agent, bot) {
    const agentCtx = agent && agent.ctx
    if (!agentCtx || typeof agentCtx.get !== 'function') return () => {}
    const systemPrompt = agentCtx.get('systemPrompt', false)
    if (!systemPrompt || typeof systemPrompt.variable !== 'function' || typeof systemPrompt.context !== 'function') {
      trace('roster skipped: no systemPrompt service')
      return () => {}
    }
    try {
      // Variable first: an unresolved {{…}} reference fails assembly outright.
      const disposeVariable = systemPrompt.variable('dsh_bots_roster', () => rosterText(bot)) || (() => {})
      // Runtime context rather than a prompt section: sections are re-rendered
      // into surface node 0, so any change rewrites the very first token and
      // throws away the whole cached prefix. A context snapshot is logged after
      // the retained history and only when its text changed, so a roster update
      // costs just the new snapshot instead of the entire conversation.
      const disposeRoster =
        systemPrompt.context({
          name: 'dsh-bots:orchestrator-roster',
          order: 10250, // after first-party guidance and the persona suffix
          required: true, // orchestration is useless without the roster; keep it even when optional context is suppressed
          text: '## 当前可用的其他 bots\n下面这份名单每次请求前都会刷新，可以直接按 id 指派：\n{{dsh_bots_roster}}\n用 task_assign / task_dispatch 指派；要新帮手就用 bot_create。任务板的后台事件（如执行 bot 交回）不会自动发消息，需要时用 inbox_list 查看，读完即清空。',
        }) || (() => {})
      // Workspaces are a separate context: task_create inherits the caller's
      // workspace by default, so the orchestrator must be able to name another
      // one on purpose. A context keeps the list out of the chat transcript and
      // refreshes it only when the registry actually changed.
      const disposeWorkspaceVariable = systemPrompt.variable('dsh_bots_workspaces', () => workspaceRosterText(bot)) || (() => {})
      const disposeWorkspaceContext =
        systemPrompt.context({
          name: 'dsh-bots:orchestrator-workspaces',
          order: 10260,
          required: true,
          text: [
            '## 可用的 workspace（任务与执行会话落在哪里）',
            '这份清单每次请求前刷新；下面的 id 和路径都可以直接填给 task_create / task_update / task_new_session 的 workspace_id。',
            '{{dsh_bots_workspaces}}',
            '怎么用：',
            '- task_create 不填 workspace_id 时，新任务继承你当前会话所在的 workspace；要落到别的项目，就填 workspace_id（id 或绝对路径）。',
            '- 每个任务绑定自己的 workspace，分派时执行 bot 的会话就开在那个目录里，和你自己会话所在的 workspace 无关；DSH 只校验 workspace 存在，不限制你为其它 workspace 建会话。',
            '- 任务已经建好但 workspace 填错了：先用 task_update 改 workspace_id，再 task_dispatch；旧会话还停在旧目录时用 task_new_session 重建（旧会话解绑作废，任务与评论都保留）。',
          ].join('\n'),
        }) || (() => {})
      trace('roster context registered')
      return () => {
        try { disposeWorkspaceContext() } catch { /* ignore */ }
        try { disposeWorkspaceVariable() } catch { /* ignore */ }
        try { disposeRoster() } catch { /* ignore */ }
        try { disposeVariable() } catch { /* ignore */ }
      }
    } catch (error) {
      log('dsh-bots: roster context failed', error)
      return () => {}
    }
  }

  function restrictTools(agent, deny) {
    const agentCtx = agent && agent.ctx
    if (!agentCtx || typeof agentCtx.get !== 'function') return () => {}
    const tools = agentCtx.get('tools', false)
    if (!tools || typeof tools.restrict !== 'function') return () => {}
    const disposers = []
    for (const name of deny) {
      try {
        const dispose = tools.restrict({ deny: [name] })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch {
        /* tool not registered in this deployment; execute() still enforces the role */
      }
    }
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

  // Bots declare a user-level skill whitelist; skills that come from the bot's
  // own workspace are always allowed (requirement: whitelist ∪ project skills).
  // The guard is synchronous, so the project set is resolved once up front and
  // refreshed on every (re)attach; a failed lookup fails open for project skills
  // but never widens the user-level whitelist.
  function guardSkills(agent, bot) {
    const agentCtx = agent && agent.ctx
    if (!agentCtx || typeof agentCtx.get !== 'function') return () => {}
    const tools = agentCtx.get('tools', false)
    if (!tools || typeof tools.guard !== 'function') return () => {}
    const allowed = new Set((bot.skills || []).map((item) => String(item).trim()).filter(Boolean))
    if (allowed.size === 0) return () => {}
    const workspace = String(bot.workspaceId || '').replace(/\\/g, '/').toLowerCase()
    let project = new Set()
    try {
      const skills = agentCtx.get('skills', false)
      if (skills && typeof skills.list === 'function') {
        void Promise.resolve()
          .then(() => skills.list({ cwd: bot.workspaceId || undefined }))
          .then((items) => {
            const names = new Set()
            for (const item of items || []) {
              if (!item || !item.name) continue
              const base = item.resourceBase && item.resourceBase.path
              const where = String(base || item.path || '').replace(/\\/g, '/').toLowerCase()
              if (workspace && where.startsWith(workspace)) names.add(String(item.name))
            }
            project = names
            trace('skill guard: project skills under ' + workspace + ' = [' + [...names].join(',') + ']')
          })
          .catch((error) => trace('skill guard list failed: ' + (error && error.message)))
      }
    } catch {
      /* ignore */
    }
    let dispose
    trace('skill guard registered for ' + bot.id + ' allow=[' + [...allowed].join(',') + ']')
    try {
      dispose = tools.guard((execution) => {
        if (!execution || execution.name !== 'skill') return undefined
        const args = execution.arguments || {}
        const name = String(args.name || args.skill || '').trim()
        if (!name) return undefined
        if (allowed.has(name) || project.has(name)) return undefined
        return {
          reason: `「${name}」不在「${bot.name}」启用的技能里。可用：${[...allowed].join('、')}；项目工作区自带的技能会自动放行。`,
          info: { name: 'SkillNotAllowed', code: 'SKILL_NOT_ALLOWED' },
        }
      })
    } catch (error) {
      trace('skill guard failed: ' + (error && error.message))
      return () => {}
    }
    return typeof dispose === 'function' ? dispose : () => {}
  }

  const attached = new Map()
  const disposers = new Map()

  async function attach(agent) {
    const sessionId = sessionIdOfAgent(agent)
    if (!sessionId || attached.get(sessionId) === agent) return
    detach(sessionId)
    attached.set(sessionId, agent)
    const bot = await store.findBotBySession(sessionId)
    if (!bot) { trace('attach ' + sessionId + ' -> no bot binding'); return }
    // Sessions created before workspace tracking have a binding with no
    // workspace; recover it from the conversation's own cwd.
    const binding = await store.bindingFor(sessionId).catch(() => null)
    if (binding && !binding.workspaceId) {
      const recovered = await workspaceIdForCwd(agentCwdOf(agent)).catch(() => null)
      if (recovered) {
        await store.bindSession({ ...binding, workspaceId: recovered }).catch(() => {})
        trace('binding ' + sessionId + ' recovered workspace ' + recovered)
      }
    }
    trace('attach ' + sessionId + ' -> ' + bot.id + ' (' + (bot.isOrchestrator ? 'orchestrator' : 'worker') + ')')
    grantFullAccess(agent)
    const text = botPrompt(bot)
    const disposePersona = applyPersona(agent, text)
    const disposeRoster = bot.isOrchestrator ? applyRoster(agent, bot) : () => {}
    const disposeTools = restrictTools(agent, bot.isOrchestrator ? ORCHESTRATOR_DENY : WORKER_DENY)
    const disposeSkills = guardSkills(agent, bot)
    disposers.set(sessionId, () => {
      disposePersona()
      disposeRoster()
      disposeTools()
      disposeSkills()
    })
    log(`dsh-bots: attached ${bot.isOrchestrator ? 'orchestrator' : 'worker'} bot ${bot.id} to ${sessionId}`)
    if (bot.isOrchestrator) void flushPendingNotifications().catch((error) => log('dsh-bots: flush failed', error))
  }

  function detach(sessionId) {
    const dispose = disposers.get(sessionId)
    if (dispose) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    disposers.delete(sessionId)
    attached.delete(sessionId)
  }

  async function roleOfSession(sessionId) {
    const bot = await store.findBotBySession(sessionId)
    if (!bot) return null
    return bot.isOrchestrator ? 'orchestrator' : 'worker'
  }

  async function botForSession(sessionId) {
    return store.findBotBySession(sessionId)
  }

  function defaultCwd() {
    try {
      const workingDirectory = ctx.get('workingDirectory', false)
      if (workingDirectory) {
        const current = typeof workingDirectory.current === 'function' ? workingDirectory.current() : workingDirectory.current
        if (typeof current === 'string') return current
        if (current && typeof current.path === 'string') return current.path
      }
    } catch {
      /* best effort */
    }
    try {
      const workspaces = ctx.get('workspaces', false)
      if (!workspaces) return undefined
      const current = typeof workspaces.current === 'function' ? workspaces.current() : workspaces.current
      if (current && typeof current.path === 'string') return current.path
      const list = typeof workspaces.list === 'function' ? workspaces.list() : workspaces.list
      if (Array.isArray(list) && list.length && typeof list[0].path === 'string') return list[0].path
    } catch {
      /* best effort */
    }
    return undefined
  }

  // A session announced through sessionController has no model route of its own:
  // without a selectModel record every turn fails with "has no provider/model".
  async function defaultModelSelection() {
    const controller = ctx.get('sessionController', false)
    if (controller && typeof controller.modelCatalog === 'function') {
      try {
        const catalog = await controller.modelCatalog()
        const fallback = catalog && catalog.default
        if (fallback && fallback.provider && fallback.model) return fallback
      } catch (error) {
        trace('modelCatalog failed: ' + String(error && error.message ? error.message : error))
      }
    }
    try {
      const list = agents() && typeof agents().list === 'function' ? agents().list() : []
      for (const entry of list) {
        const options = (entry && entry.options) || {}
        const model = options.model
        const id = typeof model === 'string' ? model : model && (model.id || model.model)
        if (options.provider && id) return { provider: options.provider, model: id }
      }
    } catch {
      /* best effort */
    }
    return null
  }

  async function ensureModelSelection(sessionId) {
    const controller = ctx.get('sessionController', false)
    if (!controller || !sessionId) return
    if (typeof controller.initializeDefaultModel === 'function') {
      try {
        await controller.initializeDefaultModel(sessionId)
        trace('initializeDefaultModel ok for ' + sessionId)
        return
      } catch (error) {
        trace('initializeDefaultModel failed: ' + String(error && error.message ? error.message : error))
      }
    }
    if (typeof controller.selectModel !== 'function') return
    const selection = await defaultModelSelection()
    if (!selection) { trace('no model selection available for ' + sessionId); return }
    try {
      await controller.selectModel({ sessionId, provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) })
      trace('selectModel ' + selection.provider + '/' + selection.model + ' for ' + sessionId)
    } catch (error) {
      trace('selectModel failed: ' + String(error && error.message ? error.message : error))
    }
  }

  async function ensureSession({ botId, taskId, workspacePath, workspaceId: explicitWorkspaceId, title }) {
    const registry = agents()
    if (!registry || typeof registry.create !== 'function') throw new Error('agents service unavailable')
    let cwd = workspacePath || liveCwd() || defaultCwd() || process.cwd()
    // Sessions must be announced through the host controller: the Web client only
    // learns about a session it has never listed when the host broadcasts it, and
    // uiWorkspace.openSession() falls back to the workspace picker for unknown ids.
    const controller = ctx.get('sessionController', false)
    trace('ensureSession cwd=' + cwd + ' controller=' + (controller ? typeof controller.create : 'none'))
    let sessionId = null
    let announced = false
    let workspaceId = explicitWorkspaceId || null
    const workspaceRegistry = ctx.get('workspaceRegistry', false)
    if (!workspaceId && workspaceRegistry && typeof workspaceRegistry.resolveByPath === 'function') {
      try {
        const workspace = await workspaceRegistry.resolveByPath(cwd)
        if (workspace) workspaceId = workspace.workspaceId || workspace.id || null
      } catch (error) {
        trace('resolveByPath failed: ' + String(error && error.message ? error.message : error))
      }
    }
    // Without a workspace the announced session cannot be opened by the Web client
    // (openSession falls back to the workspace picker), so fall back to the default
    // workspace instead of creating a session that only lives in the cwd.
    if (!workspaceId) {
      try {
        const all = await listWorkspaces()
        const fallback = (Array.isArray(all) ? all.find(entry => entry && entry.default) : null) || (Array.isArray(all) ? all[0] : null)
        if (fallback) {
          workspaceId = fallback.id || null
          if (!explicitWorkspaceId && fallback.path) cwd = fallback.path
          trace('default workspace fallback -> ' + String(workspaceId))
        }
      } catch (error) {
        trace('default workspace fallback failed: ' + String(error && error.message ? error.message : error))
      }
    }
    trace('workspaceId for ' + cwd + ' = ' + String(workspaceId))
    if (controller && typeof controller.create === 'function') {
      try {
        const created = await controller.create(workspaceId ? { workspaceId } : { cwd })
        if (created && created.sessionId) {
          sessionId = created.sessionId
          announced = true
          trace('controller.create -> ' + sessionId)
          await ensureModelSelection(sessionId)
        } else {
          trace('controller.create returned no id: ' + JSON.stringify(created || null).slice(0, 200))
        }
      } catch (error) {
        trace('controller.create failed: ' + String(error && error.message ? error.message : error))
      }
    }
    if (!sessionId) sessionId = `session-${randomUUID()}`
    let agent = announced ? await resumeSession(sessionId) : null
    trace('resume after announce: ' + (agent ? 'ok' : 'null'))
    if (!agent && !announced) {
      const options = agentOptions()
      const result = await registry.create({ sessionId, meta: { cwd }, ...(options ? { agentOptions: options } : {}) })
      agent = result && result.agent ? result.agent : result
      if (!agent) throw new Error('failed to create agent')
    }
    grantFullAccess(agent)
    if (botId) {
      await store.bindSession({ sessionId, botId, kind: taskId ? 'task' : 'private', taskId: taskId || null, workspaceId: await normalizeWorkspace(workspaceId) })
      // The persona/tool guard attach ran on agent creation, before this binding
      // told us which bot owns the session. Re-apply it now so the bot's first
      // reply is in character instead of the profile default.
      await rebind(sessionId)
    }
    await renameSession(sessionId, title, agent)
    trace('ensureSession done ' + sessionId + (workspaceId ? ' ws=' + workspaceId : ''))
    return { sessionId, agent }
  }

  async function rebind(sessionId) {
    const registry = agents()
    if (!registry) return
    let agent = typeof registry.get === 'function' ? registry.get(sessionId) : null
    if (!agent && typeof registry.resume === 'function') {
      try {
        const resumed = await registry.resume({ resumeSessionId: sessionId })
        agent = resumed && resumed.agent ? resumed.agent : resumed
      } catch (error) {
        trace('resume for rebind failed: ' + String(error && error.message ? error.message : error))
      }
    }
    if (!agent) { trace('rebind ' + sessionId + ': no live agent yet'); return }
    attached.delete(sessionId)
    detach(sessionId)
    await attach(agent)
  }

  async function openBotChat(botId, options = {}) {
    const bot = await store.getBot(botId)
    if (!bot) throw new Error('bot not found')
    // A bot owns exactly one private conversation: once it exists, every open
    // reuses it. The Web client only creates one when there is nothing to reuse.
    if (options.peek) {
      return { sessionId: bot.sessionId ? String(bot.sessionId) : null, created: false, peek: true };
    }
    // Reset: start a fresh private conversation for this bot. The host creates it
    // (so it is announced to every client) and the caller opens it by id.
    if (options.reset) {
      const resetWs = await workspaceIdForCwd(bot.workspaceId || options.cwd || null)
      const created = await ensureSession({
        botId: bot.id,
        workspacePath: bot.workspaceId || options.cwd || undefined,
        workspaceId: resetWs,
        title: bot.name,
      })
      await store.updateBot(bot.id, { sessionId: created.sessionId })
      // ensureSession already bound this session with the workspace it resolved;
      // re-binding here with resetWs would clobber it when that lookup was empty.
      trace('reset session of ' + bot.id + ' -> ' + created.sessionId)
      await renameSession(created.sessionId, bot.name)
      return { sessionId: created.sessionId, created: true, reset: true }
    }

    // Explicit rebuild: the caller knows the stored conversation cannot be shown in
    // this profile (e.g. it predates workspace binding) and asks for a replacement.
    if (options.replace && options.sessionId) {
      const adopted = String(options.sessionId);
      await store.updateBot(bot.id, { sessionId: adopted });
      const adoptedWs = await workspaceIdForCwd(options.cwd || bot.workspaceId || null);
      await store.bindSession({ sessionId: adopted, botId: bot.id, kind: 'private', taskId: null, workspaceId: adoptedWs || null });
      trace('replaced session of ' + bot.id + ' with ' + adopted + (adoptedWs ? ' ws=' + adoptedWs : ''));
      await rebind(adopted);
      await renameSession(adopted, bot.name);
      return { sessionId: adopted, created: false, replaced: true };
    }

    if (bot.sessionId) {
      const reused = String(bot.sessionId);
      if (options.sessionId && String(options.sessionId) !== reused) {
        trace('ignoring client session ' + options.sessionId + ' for ' + bot.id + ', reusing ' + reused);
      }
      await renameSession(reused, bot.name);
      return { sessionId: reused, created: false, reused: true };
    }
    // The Web client creates the conversation itself (so it can open it right
    // away) and hands the session id over here to be bound to the bot.
    if (options.sessionId) {
      const attached = String(options.sessionId)
      await store.updateBot(bot.id, { sessionId: attached })
      const attachedCwd = options.cwd || bot.workspaceId || null
      const attachedWs = bot.workspaceId ? await workspaceIdForCwd(bot.workspaceId) : await workspaceIdForCwd(attachedCwd)
      await store.bindSession({ sessionId: attached, botId: bot.id, kind: 'private', taskId: null, workspaceId: attachedWs || null })
      trace('bound client session ' + attached + ' to ' + bot.id + (attachedWs ? ' ws=' + attachedWs : ''))
      // The Web client may already have an agent for this conversation (it
      // creates one when the draft opens). Re-apply the bot persona now, or
      // the first reply would be the profile default instead of this bot.
      await rebind(attached)
      await renameSession(attached, bot.name)
      return { sessionId: attached, created: false, attached: true }
    }
    if (!bot.workspaceId && options.cwd) {
      await store.updateBot(bot.id, { workspaceId: String(options.cwd) })
      bot.workspaceId = String(options.cwd)
    }
    const registry = agents()
    const finish = (sessionId, created) => {
      if (bot.isOrchestrator) void flushPendingNotifications().catch((error) => log('dsh-bots: flush failed', error))
      return { sessionId, created }
    }
    if (bot.sessionId && registry && typeof registry.get === 'function') {
      // Older conversations were created before titles existed; opening the
      // chat is a good moment to give them the bot's name.
      void renameSession(bot.sessionId, bot.name).catch(() => {})
      const live = registry.get(bot.sessionId)
      if (live) return finish(bot.sessionId, false)
      const resolved = await resumeSession(bot.sessionId)
      if (resolved) return finish(bot.sessionId, false)
    }
    const { sessionId } = await ensureSession({ botId: bot.id, workspacePath: bot.workspaceId || undefined, workspaceId: await workspaceIdForCwd(bot.workspaceId), title: bot.name })
    await store.updateBot(bot.id, { sessionId })
    return finish(sessionId, true)
  }

  async function resumeSession(sessionId) {
    const registry = agents()
    if (!registry || typeof registry.resume !== 'function') return null
    try {
      const result = await registry.resume({ resumeSessionId: sessionId })
      return result && result.agent ? result.agent : result || null
    } catch (error) {
      log(`dsh-bots: resume ${sessionId} failed`, error)
      return null
    }
  }

  async function deliver(sessionId, text) {
    const controller = ctx.get('sessionController', false)
    if (controller && typeof controller.prompt === 'function') {
      try {
        await controller.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        })
        trace('delivered via controller.prompt ' + sessionId)
        return 'prompt'
      } catch (error) {
        // The controller path is preferred (clients see the text live), but it
        // is not always usable from a plugin call site; fall back to the agent
        // queue, which persists the same identified message.
        trace('controller.prompt failed (' + String(error && error.message ? error.message : error) + '), falling back to followup')
      }
    }
    const registry = agents()
    const agent = (registry && typeof registry.get === 'function' ? registry.get(sessionId) : null) || (await resumeSession(sessionId))
    if (!agent) throw new Error('会话还没有可用的 agent')
    const sent = agent.followup ? agent.followup(userMessage(text)) : null
    if (sent && typeof sent.then === 'function') await sent
    trace('delivered via agent.followup ' + sessionId)
    return 'followup'
  }

  async function watchRound(taskId, roundId, sessionId, bot) {
    try {
      let agent = null
      for (let attempt = 0; attempt < 40 && !agent; attempt += 1) {
        const registry = agents()
        if (registry && typeof registry.get === 'function') agent = registry.get(sessionId)
        if (!agent) await new Promise((resolve) => setTimeout(resolve, 750))
      }
      if (agent) {
        if (typeof agent.whenIdle === 'function') await agent.whenIdle()
      } else {
        await new Promise((resolve) => setTimeout(resolve, 15000))
      }
      const fresh = await store.getTask(taskId)
      if (fresh && fresh.activeRoundId === roundId) {
        await finishRound(taskId, { status: 'completed', note: '轮次结束（未收到 task_complete）' })
      }
    } catch (error) {
      log('dsh-bots: round watcher failed', error)
    }
  }

  // A task session must live in the task's workspace. A bare workspace id is not
  // enough: the session has to be started with a cwd, so map the id back to the
  // path the host registered for it.
  async function workspacePathFor(workspaceId) {
    const id = await normalizeWorkspace(workspaceId)
    if (!id) return null
    const all = await listWorkspaces()
    const hit = (Array.isArray(all) ? all : []).find((item) => item && String(item.id) === id)
    return hit && hit.path ? String(hit.path) : null
  }

  // Replace a task's session instead of silently reusing the wrong one: the old
  // conversation is abandoned (unbound, so it stops posing as this task's chat)
  // and a fresh session is created in the requested workspace.
  async function rebuildTaskSession(task, bot, options = {}) {
    const wanted = await normalizeWorkspace(
      options.workspaceId !== undefined ? options.workspaceId : task.workspaceId || bot.workspaceId,
    )
    const previous = task.sessionId ? String(task.sessionId) : null
    if (previous) {
      detach(previous)
      await store.unbindSession(previous).catch(() => {})
    }
    await store.updateTask(task.id, { sessionId: null, ...(wanted ? { workspaceId: wanted } : {}) })
    const created = await ensureSession({
      botId: bot.id,
      taskId: task.id,
      workspacePath: await workspacePathFor(wanted),
      workspaceId: wanted,
      title: bot.name + ' · ' + task.id,
    })
    await store.updateTask(task.id, { sessionId: created.sessionId })
    await store.bindSession({ sessionId: created.sessionId, botId: bot.id, kind: 'task', taskId: task.id, workspaceId: wanted })
    if (previous) {
      await store
        .addComment(task.id, 'system', `已新建执行会话 ${created.sessionId}（替换旧会话 ${previous}）${wanted ? `，workspace ${wanted}` : ''}`)
        .catch(() => {})
    }
    trace(`task ${task.id} session -> ${created.sessionId} ws=${String(wanted)}${previous ? ` (replaced ${previous})` : ''}`)
    return { sessionId: created.sessionId, previousSessionId: previous, workspaceId: wanted, agent: created.agent }
  }

  async function ensureTaskAgent(task, bot) {
    const registry = agents()
    if (!registry) throw new Error('agents service unavailable')
    const wantedId = await normalizeWorkspace(task.workspaceId || bot.workspaceId)
    if (task.sessionId) {
      const binding = await store.bindingFor(task.sessionId).catch(() => null)
      const boundId = binding && binding.workspaceId ? String(binding.workspaceId) : null
      // The workspace was corrected after this conversation was born: keep going
      // would edit the old directory, so rebuild in the right one.
      if (wantedId && boundId && boundId !== wantedId) {
        trace(`task ${task.id} session ${task.sessionId} bound to ${boundId} but wants ${wantedId}: rebuilding`)
        const rebuilt = await rebuildTaskSession(task, bot)
        return { agent: rebuilt.agent, sessionId: rebuilt.sessionId, rebuilt: true }
      }
      const live = typeof registry.get === 'function' ? registry.get(task.sessionId) : null
      if (live) {
        grantFullAccess(live)
        return { agent: live, sessionId: task.sessionId, rebuilt: false }
      }
      const resumed = await resumeSession(task.sessionId)
      if (resumed) {
        grantFullAccess(resumed)
        return { agent: resumed, sessionId: task.sessionId, rebuilt: false }
      }
      trace(`task ${task.id} session ${task.sessionId} cannot be resumed: rebuilding`)
      const rebuilt = await rebuildTaskSession(task, bot)
      return { agent: rebuilt.agent, sessionId: rebuilt.sessionId, rebuilt: true }
    }
    const rebuilt = await rebuildTaskSession(task, bot)
    return { agent: rebuilt.agent, sessionId: rebuilt.sessionId, rebuilt: true }
  }

  // "New session for this task" — the escape hatch when a task session is stuck
  // in the wrong workspace, points at an unreadable log, or is simply too dirty
  // to continue. The task, its rounds and its comments stay; only the
  // conversation is replaced.
  async function newTaskSession(taskId, options = {}) {
    const task = await store.getTask(taskId)
    if (!task) return { ok: false, error: `任务 ${taskId} 不存在` }
    if (task.status === 'done' || task.status === 'canceled') return { ok: false, error: `任务 ${task.id} 已结束（${task.status}）` }
    const bot = task.assignee && task.assignee.kind === 'bot' ? await store.getBot(task.assignee.id) : null
    if (!bot) return { ok: false, error: `任务 ${task.id} 还没有指派给具体 bot；先 task_assign 再新开会话` }
    if (task.activeRoundId) {
      // The abandoned conversation must not keep editing the wrong directory while
      // its replacement starts.
      await stopRound(task.id, { reason: '为任务新建执行会话，旧会话作废', silent: true }).catch(() => {})
    }
    const rebuilt = await rebuildTaskSession(task, bot, { workspaceId: options.workspaceId })
    await rebind(rebuilt.sessionId)
    return {
      ok: true,
      taskId: task.id,
      sessionId: rebuilt.sessionId,
      previousSessionId: rebuilt.previousSessionId,
      workspaceId: rebuilt.workspaceId,
      botId: bot.id,
    }
  }

  // Make the task's conversation visible/openable in this client. A session whose
  // workspace or log belongs to another profile cannot be opened: say so instead
  // of handing the UI an id it will fail on.
  async function openTaskSession(taskId) {
    const task = await store.getTask(taskId)
    if (!task) return { ok: false, error: `任务 ${taskId} 不存在` }
    if (!task.sessionId) return { ok: false, error: `任务 ${task.id} 还没有执行会话；先派发，或用「新开会话」建一个` }
    const agent = await liveAgent(task.sessionId)
    if (!agent) {
      return {
        ok: false,
        sessionId: task.sessionId,
        error: `执行会话 ${task.sessionId} 打不开（可能属于别的 workspace 或 profile）；可以用「新开会话」为它重建一个`,
      }
    }
    grantFullAccess(agent)
    return { ok: true, taskId: task.id, sessionId: task.sessionId }
  }

  async function finishRound(taskId, options = {}) {
    const finished = await store.finishRound(taskId, options)
    // Run the queued dispatch on a later tick: this whole call chain usually
    // lives inside the finishing agent's own turn, and we must not await a new
    // session start from inside it.
    setTimeout(() => { drainQueue(taskId).catch((error) => log('dsh-bots: drain queued dispatch failed', error)) }, 0)
    // A finished or stopped round is exactly the moment the orchestrator has to
    // act (accept the result, unblock, reassign), so it gets one notice per
    // round instead of having to poll. `silent` is for internal housekeeping
    // (rebuilding a session), where a notice would only be noise.
    if (!options.silent) {
      try {
        await announceRoundEnd(taskId, options, finished)
      } catch (error) {
        log('dsh-bots: round notice failed', error)
      }
    }
    return finished
  }

  function roundOutcomeText(status) {
    if (status === 'completed') return '轮次结束，等待验收'
    return '轮次失败'
  }

  // One place builds the notice: task, executor, outcome, current status and the
  // next action. The orchestrator still reads the real task with task_get — the
  // note is a pointer, not an evaluation.
  async function announceRoundEnd(taskId, options = {}, finished = null) {
    const task = (finished && finished.task) || (await store.getTask(taskId))
    if (!task) return
    const executor = task.assignee && task.assignee.kind === 'bot' ? task.assignee.id : ''
    // The orchestrator may be executing a task itself (agentRequired off); do not
    // push a notice into the turn that is producing it.
    const target = await orchestratorSession()
    if (target && target.sessionId && task.sessionId && target.sessionId === task.sessionId) {
      trace('skip round notice: the orchestrator runs ' + task.id + ' itself')
      return
    }
    const bot = executor ? await store.getBot(executor).catch(() => null) : null
    const who = bot ? bot.name + '（' + bot.id + '）' : executor || '未指派'
    const lines = [
      `任务 ${task.id}「${task.title}」${roundOutcomeText(options.status)}`,
      `执行方：${who}${task.sessionId ? ' · 会话 ' + task.sessionId : ''}`,
    ]
    if (options.note) lines.push(`说明：${options.note}`)
    lines.push(`当前状态：${task.status}`)
    lines.push(
      options.status === 'completed'
        ? '下一步：task_get 看结果与评论，够了就 task_update status=done 验收；不够就补一句说明再 task_dispatch 重跑。'
        : '下一步：task_get 看卡在哪，补信息后 task_update status=todo 再 task_dispatch；确实做不了就向用户说明。',
    )
    await notifyOrchestrator(lines.join('\n'), { taskId: task.id, urgent: true })
  }

  async function drainQueue(taskId) {
    const task = await store.getTask(taskId)
    if (!task || !task.pendingDispatch || task.activeRoundId) return
    if (task.status === 'done' || task.status === 'canceled') return
    const pending = await store.takePendingDispatch(taskId)
    trace('draining queued dispatch for ' + taskId)
    const result = await dispatchTask(taskId, { byBotId: pending && pending.botId })
    if (!result.ok) {
      log('dsh-bots: queued dispatch failed for ' + taskId, result.error)
      // Nobody is waiting on a queued dispatch, so the orchestrator has to hear
      // about the failure instead of finding a stuck task later.
      await notifyOrchestrator(`排队中的派发没有跑起来：任务 ${taskId}。原因：${result.error}`, { taskId, urgent: true }).catch(() => {})
    }
  }

  async function dispatchTask(taskId, { byBotId = null } = {}) {
    const task = await store.getTask(taskId)
    if (!task) return { ok: false, error: `任务 ${taskId} 不存在` }
    if (task.status === 'done' || task.status === 'canceled') return { ok: false, error: `任务 ${task.id} 已结束（${task.status}）` }
    if (task.activeRoundId) {
      const pending = await store.queueDispatch(task.id, { botId: task.assignee && task.assignee.kind === 'bot' ? task.assignee.id : null })
      trace('queued dispatch for ' + task.id + ' behind ' + task.activeRoundId)
      return { ok: true, queued: true, taskId: task.id, queuedAt: pending && pending.at }
    }
    let bot = null
    if (task.assignee && task.assignee.kind === 'bot') bot = await store.getBot(task.assignee.id)
    if (!bot) return { ok: false, error: `任务 ${task.id} 还没有指派给具体 bot；先 task_assign，或把 agentRequired 关掉自己处理` }
    // A task filed before workspaces existed (or created by a tool that could
    // not see one) adopts the bot's workspace on first dispatch, so the session
    // it spawns is filed under that project too.
    if (!task.workspaceId && bot.workspaceId) {
      const adopted = await normalizeWorkspace(bot.workspaceId)
      if (adopted) {
        await store.updateTask(task.id, { workspaceId: adopted })
        task.workspaceId = adopted
      }
      trace('task ' + task.id + ' adopted workspace ' + bot.workspaceId)
    }
    if (bot.archived) return { ok: false, error: `bot ${bot.name} 已归档` }

    const { sessionId } = await ensureTaskAgent(task, bot)
    // The agent is created before the session->bot binding exists, so its first
    // attach saw "no bot binding". Re-apply persona, tool set and skill guard now
    // that the task session is bound to this bot.
    await rebind(sessionId)
    const round = await store.startRound({ taskId: task.id, botId: bot.id, sessionId })
    try {
      await deliver(sessionId, taskPrompt(task, bot))
    } catch (error) {
      await finishRound(task.id, { status: 'failed', note: `投递失败：${error && error.message ? error.message : error}`, silent: true })
      return { ok: false, error: `无法把任务投递到 ${bot.name} 的会话：${error && error.message ? error.message : error}` }
    }

    void watchRound(task.id, round.id, sessionId, bot)
    return { ok: true, taskId: task.id, sessionId, roundId: round.id, botId: bot.id }
  }

  async function orchestratorSession() {
    const bots = await store.listBots()
    const orchestrator = bots.find((bot) => bot.isOrchestrator)
    if (!orchestrator) return null
    return { bot: orchestrator, sessionId: orchestrator.sessionId }
  }

  function notifyText(text) {
    return `【任务板通知】\n${text}\n\n（这是任务板自动发来的系统通知，不是用户消息。需要时用 task_list 读真实状态，再决定是否向用户汇报。）`
  }

  async function liveAgent(sessionId) {
    if (!sessionId) return null
    const registry = agents()
    const live = registry && typeof registry.get === 'function' ? registry.get(sessionId) : null
    if (live) return live
    return resumeSession(sessionId)
  }

  async function notifyOrchestrator(text, options = {}) {
    const override = options.taskId ? await store.getTask(options.taskId).then((task) => (task ? task.notify : null)).catch(() => null) : null
    const urgent = override === 'visible' ? true : override === 'silent' ? false : !!options.urgent
    const record = await store.pushNotification({ taskId: options.taskId || null, text, target: 'orchestrator', urgent })
    // Routine finishes stay silent: they land in the orchestrator's inbox,
    // which is injected through the system prompt (the user never sees it).
    // Only things that need a decision are pushed into the chat transcript.
    if (!urgent) {
      // No delivery and no prompt injection: the orchestrator pulls this with
      // inbox_list next time it runs. Appending to the transcript or rewriting
      // the system prompt both cost more than a pull-on-demand list.
      trace('queued silent notification ' + record.id)
      return { delivered: false, queued: true }
    }
    const target = await orchestratorSession()
    if (!target || !target.sessionId) return { delivered: false, reason: 'no orchestrator session' }
    try {
      await deliver(target.sessionId, notifyText(text))
      await store.markNotificationsDelivered([record.id])
      return { delivered: true }
    } catch (error) {
      log('dsh-bots: notify failed', error)
      return { delivered: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  async function flushPendingNotifications() {
    const pending = (await store.pendingNotifications()).filter((item) => item.target === 'orchestrator' && item.urgent)
    if (!pending.length) return 0
    const target = await orchestratorSession()
    if (!target || !target.sessionId) return 0
    for (const item of pending) {
      try {
        await deliver(target.sessionId, notifyText(item.text))
      } catch {
        return 0
      }
    }
    await store.markNotificationsDelivered(pending.map((item) => item.id))
    log(`dsh-bots: flushed ${pending.length} pending notification(s) to the orchestrator`)
    return pending.length
  }

  async function stopRound(taskId, { reason = '人工中止', silent = false } = {}) {
    const task = await store.getTask(taskId)
    if (!task) return { ok: false, error: `任务 ${taskId} 不存在` }
    if (!task.activeRoundId) return { ok: false, error: `任务 ${task.id} 当前没有进行中的轮次` }
    const roundId = task.activeRoundId
    if (task.sessionId) {
      const agent = await liveAgent(task.sessionId)
      if (agent && typeof agent.cancel === 'function') {
        try {
          await agent.cancel({ kind: 'user' })
        } catch (error) {
          log('dsh-bots: cancel failed', error)
        }
      }
    }
    await finishRound(task.id, { status: 'failed', note: reason, silent })
    return { ok: true, taskId: task.id, roundId }
  }

  async function state() {
    const [bots, tasks, bindings, workspaces] = await Promise.all([
      store.listBots(),
      store.listTasks(),
      store.listBindings(),
      listWorkspaces(),
    ])
    return { bots, tasks, bindings, workspaces }
  }

  async function dispose() {
    for (const sessionId of [...disposers.keys()]) detach(sessionId)
  }

  // The client needs to know which workspaces this profile can actually show, to
  // tell a dead session binding (old workspace, other profile) from a live one.
  async function listWorkspaces() {
    try {
      const registry = ctx.get('workspaceRegistry', false);
      if (!registry || typeof registry.list !== 'function') return [];
      const rows = await registry.list();
      const state = typeof registry.state === 'object' && registry.state ? registry.state : null;
      return (rows || []).map((w) => ({
        id: String(w.workspaceId || w.id),
        path: (w.header && w.header.path) || w.path || w.cwd || null,
        title: (w.header && w.header.title) || w.title || null,
        default: Boolean(state && state.defaultWorkspaceId === String(w.workspaceId || w.id)),
      }));
    } catch (error) {
      trace('listWorkspaces failed: ' + String(error && error.message || error));
      return [];
    }
  }

  return {
    attach,
    detach,
    dispose,
    roleOfSession,
    agentCwdOf,
    workspaceIdForCwd,
    botForSession,
    openBotChat,
    dispatchTask,
    newTaskSession,
    openTaskSession,
    workspacePathFor,
    normalizeWorkspace,
    grantFullAccess,
    finishRound,
    drainQueue,
    stopRound,
    deliver,
    notifyOrchestrator,
    inboxText,
    flushPendingNotifications,
    state,
    listWorkspaces,
    ORCHESTRATOR_TOOLS,
    WORKER_TOOLS,
    createUserMessage: userMessage,
    skillGuardFor: guardSkills,
    debug: () => traces.slice(-30),
  }
}