import { STATUSES, PRIORITY_LIST } from './store.mjs'

export const ROUTE_PREFIX = '/dsh-bots/api'

export const BUILD = 'v42-chat-matrix'

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload === undefined ? null : payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

export function createApi({ ctx, store, service, log }) {
  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const method = (req.method || 'GET').toUpperCase()
    try {
      if (method !== 'GET' && !sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin write rejected' })

      if (method === 'GET' && (path === '/' || path === '/state')) {
        const state = await service.state()
        const pending = await store.pendingNotifications()
        const inbox = pending.filter((item) => item.target === 'orchestrator' && !item.urgent).length
        return sendJson(res, 200, { ...state, inbox, build: BUILD, statuses: STATUSES, priorities: PRIORITY_LIST, trace: typeof service.debug === 'function' ? service.debug() : [] })
      }

      if (path === '/bots' && method === 'POST') {
        const body = await readBody(req)
        const bot = await store.createBot({
          name: asString(body.name, '未命名 Bot'),
          icon: asString(body.icon, 'bot'),
          systemPrompt: asString(body.systemPrompt),
          skills: Array.isArray(body.skills) ? body.skills : asString(body.skills).split(',').map((item) => item.trim()).filter(Boolean),
          isOrchestrator: asBool(body.isOrchestrator),
          workspaceId: body.workspaceId ? String(body.workspaceId) : null,
        })
        return sendJson(res, 200, { bot })
      }

      const botMatch = path.match(/^\/bots\/([^/]+)$/)
      if (botMatch && method === 'PATCH') {
        const body = await readBody(req)
        const bot = await store.updateBot(botMatch[1], body)
        if (!bot) return sendJson(res, 404, { error: 'bot not found' })
        return sendJson(res, 200, { bot })
      }
      if (botMatch && method === 'DELETE') {
        const ok = await store.deleteBot(botMatch[1])
        return sendJson(res, ok ? 200 : 404, ok ? { ok } : { error: 'bot not found' })
      }

      const chatMatch = path.match(/^\/bots\/([^/]+)\/chat$/)
      if (chatMatch && method === 'POST') {
        const body = await readBody(req)
        const result = await service.openBotChat(chatMatch[1], {
          cwd: asString(body.cwd),
          sessionId: asString(body.sessionId),
          peek: body.peek === true,
          replace: body.replace === true,
          reset: body.reset === true,
        })
        return sendJson(res, 200, result)
      }

      if (path === '/tasks' && method === 'POST') {
        const body = await readBody(req)
        const task = await store.createTask({
          title: asString(body.title, '未命名任务'),
          brief: asString(body.brief),
          status: body.status,
          assignee: body.assignee || (body.assigneeBotId ? { kind: 'bot', id: body.assigneeBotId } : null),
          agentRequired: body.agentRequired,
          priority: body.priority,
          notify: body.notify,
          labels: body.labels,
          workspaceId: body.workspaceId || null,
        })
        return sendJson(res, 200, { task })
      }

      const taskMatch = path.match(/^\/tasks\/([^/]+)$/)
      if (taskMatch && method === 'PATCH') {
        const body = await readBody(req)
        const task = await store.updateTask(taskMatch[1], body)
        if (!task) return sendJson(res, 404, { error: 'task not found' })
        return sendJson(res, 200, { task })
      }
      if (taskMatch && method === 'DELETE') {
        const task = await store.getTask(taskMatch[1])
        if (!task) return sendJson(res, 404, { error: 'task not found' })
        const updated = await store.updateTask(task.id, { status: 'canceled' })
        return sendJson(res, 200, { task: updated })
      }

      if (method === 'GET' && path === '/debug/skills') {
        const skills = ctx.get('skills', false)
        if (!skills) return sendJson(res, 200, { error: 'skills service unavailable' })
        const cwd = url.searchParams.get('cwd') || process.cwd()
        const attempts = []
        const shapes = [[cwd], [{ cwd }], [{ cwd, modelInvocable: true }], []]
        for (const args of shapes) {
          try {
            const value = await skills.list(...args)
            const items = Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : null)
            attempts.push({ args, ok: true, count: items ? items.length : null, sample: items ? items.slice(0, 4) : String(value).slice(0, 200) })
          } catch (error) {
            attempts.push({ args, ok: false, error: String((error && error.message) || error) })
          }
        }
        return sendJson(res, 200, { cwd, attempts })
      }

      if (method === 'GET' && path === '/debug/workspaces') {
        const sessionQuery = new URL(req.url || '/', 'http://localhost').searchParams.get('session')
        let rows = []
        try {
          const registry = ctx.get('workspaceRegistry', false)
          const list = registry && typeof registry.list === 'function' ? await registry.list() : []
          rows = (list || []).map((w) => {
            const ids = (w.record && w.record.sessionIds) || w.sessionIds || w.sessions || null
            return {
              id: String(w.workspaceId || w.id),
              keys: Object.keys(w),
              header: w.header || null,
              sessionCount: Array.isArray(ids) ? ids.length : null,
              sessionIds: Array.isArray(ids) ? ids.slice(0, 3) : null,
              has: Array.isArray(ids) && sessionQuery ? ids.includes(sessionQuery) : undefined,
            }
          })
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) })
        }
        return sendJson(res, 200, { build: BUILD, rows })
      }

      if (method === 'GET' && path === '/debug') {
        const names = ['agents','tools','skills','webServer','sessionController','sessions','sessionStore','workspaces','workspaceRegistry','workingDirectory','modelCatalog','models','providers','approvals','approval','permissions','permission','policy','sandbox','settings','preferences','config','profile','agentPresets','agentPresetRegistry','systemPrompt','subagents','hooks','commands','usage','locale','sessionTitle','environment','runtime','capabilities']
        const out = {}
        for (const name of names) {
          try {
            const value = ctx.get(name, false)
            if (!value) { out[name] = null; continue }
            const methods = []
            const seen = new Set()
            let cursor = value
            for (let depth = 0; cursor && depth < 4; depth++) {
              for (const key of Object.getOwnPropertyNames(cursor)) {
                if (key === 'constructor' || seen.has(key)) continue
                seen.add(key)
                let descriptor
                try { descriptor = Object.getOwnPropertyDescriptor(cursor, key) } catch { continue }
                if (descriptor && typeof descriptor.value === 'function') methods.push(key)
              }
              cursor = Object.getPrototypeOf(cursor)
            }
            let peek = null
            try {
              const slim = {}
              for (const key of Object.keys(value).slice(0, 12)) {
                const item = value[key]
                if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) slim[key] = item
                else if (Array.isArray(item)) slim[key] = `array(${item.length})`
                else if (typeof item === 'object') slim[key] = '{' + Object.keys(item).slice(0, 8).join(',') + '}'
              }
              peek = JSON.stringify(slim).slice(0, 1200)
            } catch { peek = 'unserializable' }
            out[name] = { keys: Object.keys(value).slice(0, 24), methods: [...new Set(methods)].slice(0, 80), peek }
          } catch (error) {
            out[name] = 'ERR ' + String(error && error.message ? error.message : error)
          }
        }
        return sendJson(res, 200, { build: BUILD, services: out, inbox: typeof service.inboxText === 'function' ? service.inboxText() : null, trace: typeof service.debug === 'function' ? service.debug() : [] })
      }

      if (path === '/debug/say' && method === 'POST') {
        const body = await readBody(req)
        const bot = body.botId ? await store.getBot(String(body.botId)) : null
        let sessionId = String(body.sessionId || (bot && bot.sessionId) || '')
        // A bot that has never been chatted with has no session yet: open its
        // private chat instead of answering with a 400 that reads like a bug.
        if (!sessionId && bot) {
          try {
            const opened = await service.openBotChat(bot.id, {})
            sessionId = String((opened && opened.sessionId) || '')
          } catch (error) {
            return sendJson(res, 409, { error: 'cannot open a session for ' + bot.id + ': ' + (error && error.message ? error.message : error) })
          }
        }
        if (!sessionId) return sendJson(res, 400, { error: 'sessionId or botId required' })
        const result = await service.deliver(sessionId, String(body.text || ''))
        return sendJson(res, 200, { ok: true, sessionId, result })
      }

      const stopMatch = path.match(/^\/tasks\/([^/]+)\/stop$/)
      if (stopMatch && method === 'POST') {
        const result = await service.stopRound(stopMatch[1])
        return sendJson(res, result.ok ? 200 : 409, result)
      }
      const dispatchMatch = path.match(/^\/tasks\/([^/]+)\/dispatch$/)
      if (dispatchMatch && method === 'POST') {
        const result = await service.dispatchTask(dispatchMatch[1])
        if (result.ok && result.queued) return sendJson(res, 202, result)
        return sendJson(res, result.ok ? 200 : 409, result)
      }

      const commentMatch = path.match(/^\/tasks\/([^/]+)\/comment$/)
      if (commentMatch && method === 'POST') {
        const body = await readBody(req)
        const comment = await store.addComment(commentMatch[1], asString(body.author, 'human'), asString(body.text))
        if (!comment) return sendJson(res, 404, { error: 'task not found' })
        return sendJson(res, 200, { comment })
      }

      return sendJson(res, 404, { error: `no route for ${method} ${path}` })
    } catch (error) {
      log('dsh-bots api error', error)
      return sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
    }
  }

  return {
    handler: (req, res) => {
      void handle(req, res)
    },
    registerWebServer(webServer) {
      return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res) => void handle(req, res) })
    },
  }
}