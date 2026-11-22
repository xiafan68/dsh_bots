import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'canceled']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']

const DEFAULT_DB = () => ({
  version: 1,
  seq: { task: 0, bot: 0, round: 0, comment: 0 },
  bots: [],
  tasks: [],
  rounds: [],
  bindings: [],
  notifications: [],
  settings: { defaultWorkspaceId: null },
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function nextSeq(db, key) {
  db.seq[key] = (db.seq[key] || 0) + 1
  return db.seq[key]
}

function taskIdOf(n) {
  return `T-${String(n).padStart(4, '0')}`
}

function botIdOf(n) {
  return `bot-${String(n).padStart(3, '0')}`
}

function roundIdOf(n) {
  return `round-${n}`
}

/**
 * Tiny domain store: one JSON document, atomic replace, serialized writes.
 * Everything the tools and the BFF need lives behind this object.
 */
export class BotsStore {
  constructor({ dir, log }) {
    this.dir = dir
    this.file = join(dir, 'db.json')
    this.log = log || (() => {})
    this.db = null
    this.loading = null
    this.queue = Promise.resolve()
  }

  async fileStamp() {
    try {
      const info = await stat(this.file)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return 'missing'
    }
  }

  // Two hosts (the desktop app and a CLI instance) can point at the same
  // storage directory, so the in-memory copy is only trusted while the file on
  // disk is unchanged. Reloading on mtime/size change keeps the second host
  // from silently serving — and then overwriting with — a stale snapshot.
  async load() {
    if (this.loading) return this.loading
    const stamp = await this.fileStamp()
    if (this.db && this.stamp === stamp) return this.db
    this.loading = (async () => {
      await mkdir(this.dir, { recursive: true })
      try {
        const raw = await readFile(this.file, 'utf8')
        const parsed = JSON.parse(raw)
        this.db = { ...DEFAULT_DB(), ...parsed, settings: { ...DEFAULT_DB().settings, ...(parsed.settings || {}) } }
        for (const key of ['bots', 'tasks', 'rounds', 'bindings', 'notifications']) {
          if (!Array.isArray(this.db[key])) this.db[key] = []
        }
      } catch (error) {
        if (error && error.code !== 'ENOENT') this.log('bots store: unreadable db, starting fresh', error)
        if (!this.db) this.db = DEFAULT_DB()
      }
      this.stamp = stamp
      this.loading = null
      return this.db
    })()
    return this.loading
  }

  async persist() {
    const run = async () => {
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, JSON.stringify(this.db, null, 2), 'utf8')
      await rename(tmp, this.file)
    }
    this.queue = this.queue.then(run, run)
    await this.queue
    this.stamp = await this.fileStamp()
  }

  async read(fn) {
    await this.load()
    return fn(this.db)
  }

  // Synchronous peek for prompt-time callbacks (system-prompt variables run on
  // every assembly and cannot await). The in-memory db is authoritative once
  // load() has completed, which happens before the first bot session exists.
  peek(fn) {
    return fn(this.db || DEFAULT_DB())
  }

  async write(fn) {
    await this.load()
    const result = fn(this.db)
    await this.persist()
    return result
  }

  // ---------------------------------------------------------------- bots

  async listBots() {
    return this.read((db) => clone(db.bots).sort((a, b) => Number(a.isOrchestrator ? 0 : 1) - Number(b.isOrchestrator ? 0 : 1) || a.createdAt - b.createdAt))
  }

  async getBot(id) {
    return this.read((db) => {
      const bot = db.bots.find((item) => item.id === id)
      return bot ? clone(bot) : null
    })
  }

  async findBotBySession(sessionId) {
    if (!sessionId) return null
    return this.read((db) => {
      const direct = db.bots.find((item) => item.sessionId === sessionId)
      if (direct) return clone(direct)
      const binding = db.bindings.find((item) => item.sessionId === sessionId && item.botId)
      if (!binding) return null
      const bound = db.bots.find((item) => item.id === binding.botId)
      return bound ? clone(bound) : null
    })
  }

  async createBot(input) {
    return this.write((db) => {
      const now = Date.now()
      const bot = {
        id: botIdOf(nextSeq(db, 'bot')),
        name: String(input.name || '').trim() || '未命名 Bot',
        icon: String(input.icon || 'bot'),
        systemPrompt: String(input.systemPrompt || ''),
        skills: Array.isArray(input.skills) ? input.skills.map(String) : [],
        isOrchestrator: Boolean(input.isOrchestrator),
        workspaceId: input.workspaceId || null,
        sessionId: input.sessionId || null,
        archived: false,
        createdAt: now,
        updatedAt: now,
      }
      if (bot.isOrchestrator) {
        for (const other of db.bots) other.isOrchestrator = false
      }
      db.bots.push(bot)
      return clone(bot)
    })
  }

  async updateBot(id, patch) {
    return this.write((db) => {
      const bot = db.bots.find((item) => item.id === id)
      if (!bot) return null
      if (patch.isOrchestrator === true) {
        for (const other of db.bots) other.isOrchestrator = other.id === id
      }
      for (const key of ['name', 'icon', 'systemPrompt', 'sessionId', 'workspaceId']) {
        if (patch[key] !== undefined) bot[key] = patch[key]
      }
      if (patch.skills !== undefined) bot.skills = Array.isArray(patch.skills) ? patch.skills.map(String) : []
      if (patch.isOrchestrator !== undefined) bot.isOrchestrator = Boolean(patch.isOrchestrator)
      if (patch.archived !== undefined) bot.archived = Boolean(patch.archived)
      bot.updatedAt = Date.now()
      return clone(bot)
    })
  }

  async deleteBot(id) {
    return this.write((db) => {
      const index = db.bots.findIndex((item) => item.id === id)
      if (index < 0) return false
      db.bots.splice(index, 1)
      db.bindings = db.bindings.filter((item) => item.botId !== id)
      for (const task of db.tasks) {
        if (task.assignee && task.assignee.kind === 'bot' && task.assignee.id === id) task.assignee = null
      }
      return true
    })
  }

  // ---------------------------------------------------------------- tasks

  async listTasks() {
    return this.read((db) => clone(db.tasks).sort((a, b) => b.updatedAt - a.updatedAt))
  }

  async getTask(id) {
    return this.read((db) => {
      const task = db.tasks.find((item) => item.id === id || item.id === String(id).toUpperCase())
      return task ? clone(task) : null
    })
  }

  async createTask(input) {
    return this.write((db) => {
      const now = Date.now()
      const n = nextSeq(db, 'task')
      const task = {
        id: taskIdOf(n),
        title: String(input.title || '').trim() || '未命名任务',
        brief: String(input.brief || ''),
        status: TASK_STATUSES.includes(input.status) ? input.status : 'backlog',
        assignee: normalizeAssignee(input.assignee),
        agentRequired: input.agentRequired !== false,
        priority: PRIORITIES.includes(input.priority) ? input.priority : 'normal',
        // How the orchestrator learns about this task's round ending:
        // null = follow the global default (silent on hand-off, visible on trouble).
        notify: ['silent', 'visible'].includes(input.notify) ? input.notify : null,
        labels: Array.isArray(input.labels) ? input.labels.map(String) : [],
        workspaceId: input.workspaceId || null,
        sessionId: input.sessionId || null,
        activeRoundId: null,
        result: null,
        comments: [],
        createdAt: now,
        updatedAt: now,
      }
      db.tasks.push(task)
      return clone(task)
    })
  }

  async updateTask(id, patch) {
    return this.write((db) => {
      const task = db.tasks.find((item) => item.id === id)
      if (!task) return null
      for (const key of ['title', 'brief', 'workspaceId', 'sessionId', 'result']) {
        if (patch[key] !== undefined) task[key] = patch[key]
      }
      if (patch.status !== undefined) {
        if (!TASK_STATUSES.includes(patch.status)) throw new Error(`unknown status: ${patch.status}`)
        task.status = patch.status
      }
      if (patch.priority !== undefined) {
        if (!PRIORITIES.includes(patch.priority)) throw new Error(`unknown priority: ${patch.priority}`)
        task.priority = patch.priority
      }
      if (patch.notify !== undefined) task.notify = ['silent', 'visible'].includes(patch.notify) ? patch.notify : null
      if (patch.assignee !== undefined) task.assignee = normalizeAssignee(patch.assignee)
      if (patch.agentRequired !== undefined) task.agentRequired = Boolean(patch.agentRequired)
      if (patch.labels !== undefined) task.labels = Array.isArray(patch.labels) ? patch.labels.map(String) : []
      if (patch.activeRoundId !== undefined) task.activeRoundId = patch.activeRoundId
      task.updatedAt = Date.now()
      return clone(task)
    })
  }

  async addComment(id, author, text) {
    return this.write((db) => {
      const task = db.tasks.find((item) => item.id === id)
      if (!task) return null
      const comment = { id: `c${nextSeq(db, 'comment')}`, author: String(author || 'human'), text: String(text || ''), at: Date.now() }
      task.comments.push(comment)
      task.updatedAt = Date.now()
      return clone(comment)
    })
  }

  // ---------------------------------------------------------------- rounds

  async startRound({ taskId, botId, sessionId }) {
    return this.write((db) => {
      const task = db.tasks.find((item) => item.id === taskId)
      if (!task) return null
      const round = {
        id: roundIdOf(nextSeq(db, 'round')),
        taskId,
        botId,
        sessionId,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        note: '',
      }
      db.rounds.push(round)
      task.activeRoundId = round.id
      task.status = 'in_progress'
      task.updatedAt = Date.now()
      return clone(round)
    })
  }

  // A dispatch requested while a round is running is remembered on the task and
  // replayed once that round finishes, instead of being rejected outright.
  async queueDispatch(taskId, info = {}) {
    return this.write((db) => {
      const task = db.tasks.find((item) => item.id === taskId)
      if (!task) return null
      task.pendingDispatch = { at: Date.now(), botId: info.botId || null }
      task.updatedAt = Date.now()
      return task.pendingDispatch
    })
  }

  async takePendingDispatch(taskId) {
    return this.write((db) => {
      const task = db.tasks.find((item) => item.id === taskId)
      if (!task || !task.pendingDispatch) return null
      const pending = task.pendingDispatch
      delete task.pendingDispatch
      return pending
    })
  }

  async finishRound(taskId, { status = 'completed', note = '', result = null } = {}) {
    return this.write((db) => {
      const task = db.tasks.find((item) => item.id === taskId)
      if (!task) return null
      const round = db.rounds.find((item) => item.id === task.activeRoundId)
      if (round) {
        round.status = status
        round.endedAt = Date.now()
        round.note = note
      }
      task.activeRoundId = null
      if (status === 'completed') {
        task.status = 'in_review'
        if (result) task.result = result
      } else if (status === 'failed') {
        task.status = 'blocked'
      }
      task.updatedAt = Date.now()
      return { task: clone(task), round: round ? clone(round) : null }
    })
  }

  async listRounds(taskId) {
    return this.read((db) => clone(db.rounds.filter((item) => item.taskId === taskId)))
  }

  // ---------------------------------------------------------------- bindings

  async bindSession(binding) {
    return this.write((db) => {
      const existing = db.bindings.find((item) => item.sessionId === binding.sessionId)
      if (existing) {
        Object.assign(existing, binding)
        return clone(existing)
      }
      const record = { kind: 'task', taskId: null, botId: null, workspaceId: null, ...binding }
      db.bindings.push(record)
      return clone(record)
    })
  }

  async listBindings() {
    return this.read((db) => clone(db.bindings))
  }

  async bindingFor(sessionId) {
    return this.read((db) => {
      const hit = db.bindings.find((item) => item.sessionId === sessionId)
      return hit ? clone(hit) : null
    })
  }

  // A task can be moved to a new session (wrong workspace, unreadable log). The
  // abandoned session must stop looking like a bot conversation in the UI.
  async unbindSession(sessionId) {
    return this.write((db) => {
      const before = db.bindings.length
      db.bindings = db.bindings.filter((item) => item.sessionId !== sessionId)
      return db.bindings.length !== before
    })
  }

  // ---------------------------------------------------------------- notifications

  async pushNotification(entry) {
    return this.write((db) => {
      const record = { id: `n${Date.now()}-${db.notifications.length}`, at: Date.now(), delivered: false, ...entry }
      db.notifications.push(record)
      if (db.notifications.length > 200) db.notifications.splice(0, db.notifications.length - 200)
      return clone(record)
    })
  }

  async pendingNotifications() {
    return this.read((db) => clone(db.notifications.filter((item) => !item.delivered)))
  }

  async markNotificationsDelivered(ids) {
    return this.write((db) => {
      const set = new Set(ids)
      for (const item of db.notifications) if (set.has(item.id)) item.delivered = true
      return true
    })
  }
}

export function normalizeAssignee(value) {
  if (!value) return null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    if (text === 'human' || text === 'me') return { kind: 'human', id: 'me' }
    return { kind: 'bot', id: text }
  }
  if (typeof value === 'object' && value.kind) {
    if (value.kind === 'bot' && value.id) return { kind: 'bot', id: String(value.id) }
    if (value.kind === 'human') return { kind: 'human', id: String(value.id || 'me') }
    return null
  }
  return null
}

export const STATUSES = TASK_STATUSES
export const PRIORITY_LIST = PRIORITIES