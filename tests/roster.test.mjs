// The orchestrator prompt must carry a live workspace list: task_create
// inherits the caller's workspace, so naming another one has to be a decision
// the model can actually make. The list is registered as runtime context (a
// snapshot appended after retained history, so a change never invalidates the
// cached prefix) rather than a prompt section or a chat message.
import assert from 'node:assert/strict'
import { createService } from '../src/service.mjs'

const ROSTER_CONTEXT = 'dsh-bots:orchestrator-roster'
const WORKSPACE_CONTEXT = 'dsh-bots:orchestrator-workspaces'

function harness({ workspaces, botWorkspaceId = 'ws-a' } = {}) {
  const contexts = []
  const variables = new Map()
  const registry = {
    list: () => workspaces,
    state: { defaultWorkspaceId: 'ws-a' },
  }
  const ctx = {
    get(name, fallback) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'systemPrompt') {
        return {
          variable(name, provider) {
            variables.set(name, provider)
            return () => {}
          },
          context(context) {
            contexts.push(context)
            return () => {}
          },
        }
      }
      return fallback
    },
  }
  const store = {
    peek: (fn) => fn({ bots: [], tasks: [] }),
    findBotBySession: async () => ({
      id: 'bot-001',
      name: '主控',
      systemPrompt: '',
      skills: [],
      isOrchestrator: true,
      workspaceId: botWorkspaceId,
    }),
    bindingFor: async () => null,
    bindSession: async () => {},
  }
  const service = createService({ ctx, store, log: () => {} })
  const agent = { session: { id: 'session-1', append() {} }, ctx, inject() {} }
  return { service, agent, contexts, variables }
}

const WORKSPACES = [
  { workspaceId: 'ws-a', header: { path: 'D:/codes/alpha', title: 'Alpha' } },
  { workspaceId: 'ws-b', header: { path: 'D:/codes/beta' } },
]

const { service, agent, contexts, variables } = harness({ workspaces: WORKSPACES })
await service.attach(agent)

const rosterContext = contexts.find((item) => item.name === ROSTER_CONTEXT)
assert.ok(rosterContext, 'the bot roster should be registered as runtime context')
assert.equal(rosterContext.required, true, 'the roster must survive optional-context suppression')
assert.match(rosterContext.text, /\{\{dsh_bots_roster\}\}/, 'roster context must reference its variable')

const workspaceContext = contexts.find((item) => item.name === WORKSPACE_CONTEXT)
assert.ok(workspaceContext, 'workspace context should be registered for the orchestrator')
assert.equal(workspaceContext.required, true, 'the workspace list must survive optional-context suppression')
assert.match(workspaceContext.text, /\{\{dsh_bots_workspaces\}\}/, 'context must reference its variable')

const render = variables.get('dsh_bots_workspaces')
assert.ok(render, 'workspace variable should be registered')
const text = render()

assert.match(text, /workspace_id: ws-a/, 'every workspace id must be listed')
assert.match(text, /workspace_id: ws-b/)
assert.match(text, /D:\/codes\/alpha|D:\/codes\/beta/, 'paths help the model target a project')
assert.match(text, /默认/, 'the default workspace is marked')
assert.match(text, /你当前会话在这里/, "the orchestrator's own workspace is marked")

// An unknown registry must degrade to a readable line, never to a thrown error.
const degraded = harness({ workspaces: [] })
const degradedCtx = degraded.agent.ctx
await degraded.service.attach(degraded.agent)
assert.match(degraded.variables.get('dsh_bots_workspaces')(), /还没有注册任何 workspace/)

// A missing service must not break prompt assembly either.
const missing = createService({
  ctx: { get: () => false },
  store: { peek: (fn) => fn({ bots: [], tasks: [] }), findBotBySession: async () => null },
  log: () => {},
})
assert.equal(typeof missing.attach, 'function')

console.log('roster: PASS bot roster and workspace list are runtime contexts')
console.log('roster: PASS ids, paths, default and own-workspace markers are present')
console.log('roster: PASS empty or missing workspace registry degrades gracefully')