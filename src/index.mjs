import { homedir } from 'node:os'
import { join } from 'node:path'
import { BotsStore } from './store.mjs'
import { createService } from './service.mjs'
import { createApi } from './bff.mjs'
import { registerTools } from './tools.mjs'

export const name = '@dsh-external/dsh-bots'
export const inject = []
export const SERVICE_NAME = 'bots'

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-external',
    validate(value) {
      const input = value && typeof value === 'object' ? value : {}
      const output = {
        storageDir: typeof input.storageDir === 'string' ? input.storageDir : '',
        debug: input.debug === undefined ? false : Boolean(input.debug),
      }
      return { value: output }
    },
  },
}

function pickAgent(payload) {
  if (!payload) return null
  if (payload.agent) return payload.agent
  if (payload.session && payload.ctx) return payload
  return payload
}

export function apply(ctx, config = {}) {
  const debug = Boolean(config && config.debug)
  const log = (...args) => {
    if (debug) {
      try {
        console.debug('[dsh-bots]', ...args)
      } catch {
        /* ignore */
      }
    }
  }

  const root = process.env.DSH_HOME || join(homedir(), '.dsh')
  const storageDir = (config && config.storageDir) || join(root, 'storages', 'dsh-bots')
  const store = new BotsStore({ dir: storageDir, log })
  void store.load().catch((error) => log('store load failed', error))

  const service = createService({ ctx, store, log })
  const api = createApi({ ctx, store, service, log })

  let disposeTools = () => {}

  ctx.effect(() => () => {
    disposeTools()
    service.dispose()
  }, 'dsh-bots: cleanup')

  ctx.on('agent/created', (payload) => {
    const agent = pickAgent(payload)
    void service.attach(agent).catch((error) => log('attach failed', error))
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = pickAgent(payload)
    const session = agent && agent.session
    const sessionId = session && typeof session === 'object' ? session.id : agent && agent.sessionId
    if (sessionId) service.detach(sessionId)
  })

  const mountBff = (scope) => {
    const webServer = scope.webServer || (scope.get && scope.get('webServer', false))
    if (!webServer || typeof webServer.register !== 'function') {
      log('webServer unavailable; BFF not mounted')
      return
    }
    scope.effect(() => api.registerWebServer(webServer), 'dsh-bots: bff')
  }
  ctx.inject(['webServer'], mountBff)

  const mountTools = (scope) => {
    disposeTools = registerTools({ ctx: scope, store, service, log })
    scope.effect(() => disposeTools, 'dsh-bots: tools')
  }
  ctx.inject(['tools'], mountTools)

  // Re-attach agents that already exist when the plugin is (re)loaded.
  const agents = ctx.get && ctx.get('agents', false)
  if (agents && typeof agents.list === 'function') {
    Promise.resolve()
      .then(() => agents.list())
      .then((list) => {
        for (const agent of Array.isArray(list) ? list : []) {
          void service.attach(agent).catch((error) => log('attach existing failed', error))
        }
      })
      .catch((error) => log('agents.list failed', error))
  }

  const expose = () => {
    try {
      if (ctx.reflect && typeof ctx.reflect.provide === 'function') ctx.reflect.provide(SERVICE_NAME, service)
      else if (typeof ctx.provide === 'function') ctx.provide(SERVICE_NAME, service)
    } catch (error) {
      log('provide failed', error)
    }
  }
  expose()

  return { name: SERVICE_NAME, store, service, api }
}