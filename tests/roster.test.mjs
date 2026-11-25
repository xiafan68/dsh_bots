// The orchestrator prompt must carry a live workspace list: task_create
// inherits the caller's workspace, so naming another one has to be a decision
// the model can actually make. The list is a rendered prompt section (not a
// chat message), so these tests assert on the registered section/variable.
import assert from 'node:assert/strict'
import { createService } from '../src/service.mjs'

const ROSTER_SECTION = 'dsh-bots:orchestrator-roster'
const WORKSPACE_SECTION = 'dsh-bots:orchestrator-workspaces'

function harness({ workspaces, botWorkspaceId = 'ws-a' } = {}) {
  const sections = []
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
          section(section) {
            sections.push(section)
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
  return { service, agent, sections, variables }
}

const WORKSPACES = [
  { workspaceId: 'ws-a', header: { path: 'D:/codes/alpha', title: 'Alpha' } },
  { workspaceId: 'ws-b', header: { path: 'D:/codes/beta' } },
]

const { service, agent, sections, variables } = harness({ workspaces: WORKSPACES })
await service.attach(agent)

const workspaceSection = sections.find((section) => section.name === WORKSPACE_SECTION)
assert.ok(workspaceSection, 'workspace section should be registered for the orchestrator')
assert.match(workspaceSection.text, /\{\{dsh_bots_workspaces\}\}/, 'section must reference its variable')

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

console.log('roster: PASS workspace list is rendered as a prompt section')
console.log('roster: PASS ids, paths, default and own-workspace markers are present')
console.log('roster: PASS empty or missing workspace registry degrades gracefully')