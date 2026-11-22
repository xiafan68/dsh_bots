// End-to-end matrix for the private-chat rules:
//   { no session, session } x { open, reset } x { bot has workspace, bot has none }
// It runs against a live dsh-bots host (default http://127.0.0.1:6401) and
// asserts both the bot<->session link and the session<->workspace association.
//
//   node tests/e2e-chat-matrix.mjs http://127.0.0.1:6401 <token>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE = (process.argv[2] || 'http://127.0.0.1:6401').replace(/\/$/, '')
const TOKEN = process.argv[3] || ''
const WORKSPACE = 'D:\\codes\\dsh-bots'
const PROJECTION_DIR = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')

let failures = 0
let checks = 0
function check(label, ok, detail) {
  checks += 1
  if (ok) console.log('  PASS ' + label)
  else {
    failures += 1
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)))
  }
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers || {}) }
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(BASE + path, { ...options, headers })
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = text }
  return { status: response.status, payload }
}

const state = async () => (await api('/dsh-bots/api/state')).payload
const chat = (botId, body) => api('/dsh-bots/api/bots/' + botId + '/chat', { method: 'POST', body: JSON.stringify(body || {}) })
const workspacesOf = async (sessionId) => (await api('/dsh-bots/api/debug/workspaces?session=' + encodeURIComponent(sessionId))).payload

function projectionOf(sessionId) {
  try {
    return JSON.parse(readFileSync(join(PROJECTION_DIR, sessionId + '.json'), 'utf8'))
  } catch {
    return null
  }
}

function assistantText(sessionId) {
  const projection = projectionOf(sessionId)
  if (!projection) return ''
  const rows = JSON.stringify(projection)
  return rows
}

async function waitFor(predicate, timeoutMs = 40000, step = 500) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, step))
  }
  return null
}

const createdBots = []
async function makeBot(name, workspaceId) {
  const payload = { name, icon: 'robot', isOrchestrator: false, skills: [] }
  if (workspaceId) payload.workspaceId = workspaceId
  const result = await api('/dsh-bots/api/bots', { method: 'POST', body: JSON.stringify(payload) })
  const bot = result.payload && (result.payload.bot || result.payload)
  if (!bot || !bot.id) throw new Error('failed to create bot ' + name + ': ' + JSON.stringify(result))
  createdBots.push(bot.id)
  return bot.id
}

async function bindingOf(sessionId) {
  const snapshot = await state()
  return (snapshot.bindings || []).find(entry => entry.sessionId === sessionId) || null
}

const defaultWorkspace = async () => {
  const snapshot = await state()
  const list = snapshot.workspaces || []
  const fallback = list.find(entry => entry.default) || list[0] || null
  return fallback
}

async function scenario(idleBot, linkedBot) {
  const projectWs = (await defaultWorkspace()) || null

  console.log('\n[1] no session + open chat (bot without workspaceId)')
  const first = await chat(idleBot)
  check('open returns a session id', !!(first.payload && first.payload.sessionId), first)
  const session1 = first.payload.sessionId
  const binding1 = await bindingOf(session1)
  check('session is linked to the bot', !!(binding1 && binding1.botId === idleBot), binding1)
  check('session got a workspace (resolved from cwd)', !!(binding1 && binding1.workspaceId), binding1)
  const ws1 = await workspacesOf(session1)
  check('workspace registry contains the session', !!(ws1 && Array.isArray(ws1.rows) && ws1.rows.some(row => row.has)), ws1)

  console.log('\n[1b] no session + cwd outside every workspace -> default workspace')
  const outsideBot = await makeBot('矩阵·默认workspace' + Date.now().toString(36), null)
  const outside = await chat(outsideBot, { cwd: 'C:\\Windows\\Temp' })
  const sessionOutside = outside.payload.sessionId
  const bindingOutside = await bindingOf(sessionOutside)
  check('fallback session is linked to the bot', !!(bindingOutside && bindingOutside.botId === outsideBot), bindingOutside)
  if (projectWs) check('fallback uses the default workspace', bindingOutside.workspaceId === projectWs.id, { got: bindingOutside.workspaceId, want: projectWs.id })
  const wsOutside = await workspacesOf(sessionOutside)
  check('default workspace contains the session', !!(wsOutside && wsOutside.rows.some(row => row.has)), wsOutside && wsOutside.rows)

  console.log('\n[2] open again')
  const second = await chat(idleBot)
  check('reuses the same session', second.payload && second.payload.sessionId === session1, second.payload)
  check('existing session is not re-bound elsewhere', !!(await bindingOf(session1)))

  console.log('\n[3] reset')
  const reset = await chat(idleBot, { reset: true })
  check('reset creates a new session', !!(reset.payload && reset.payload.sessionId && reset.payload.sessionId !== session1), reset.payload)
  const session2 = reset.payload.sessionId
  check('old session survives', !!(await bindingOf(session1)))
  const binding2 = await bindingOf(session2)
  check('new session is linked to the bot', !!(binding2 && binding2.botId === idleBot), binding2)
  check('new session got a workspace', !!(binding2 && binding2.workspaceId), binding2)

  console.log('\n[4] open after reset')
  const third = await chat(idleBot)
  check('open lands on the reset session', third.payload && third.payload.sessionId === session2, third.payload)

  console.log('\n[5] bot WITH workspaceId, no session + open')
  const linked = await chat(linkedBot)
  check('open returns a session id', !!(linked.payload && linked.payload.sessionId), linked.payload)
  const session3 = linked.payload.sessionId
  const binding3 = await bindingOf(session3)
  const expected = (await state()).bots.find(bot => bot.id === linkedBot)
  check('session is linked to the bot', !!(binding3 && binding3.botId === linkedBot), binding3)
  check('binding workspace matches bot workspace', !!(binding3 && binding3.workspaceId), binding3)
  const ws3 = await workspacesOf(session3)
  check('session lives in a real workspace', !!(ws3 && ws3.rows.some(row => row.has)), ws3 && ws3.rows)
  check('bot has a workspace path', !!(expected && expected.workspaceId), expected && expected.workspaceId)

  console.log('\n[6] reset for the bot WITH workspaceId')
  const reset2 = await chat(linkedBot, { reset: true })
  const session4 = reset2.payload.sessionId
  check('reset creates a new session', !!session4 && session4 !== session3, reset2.payload)
  const binding4 = await bindingOf(session4)
  check('reset session keeps a workspace', !!(binding4 && binding4.workspaceId), binding4)
  check('reset session keeps the bot link', !!(binding4 && binding4.botId === linkedBot), binding4)

  console.log('\n[7] persona is applied to a host-created session')
  const said = await api('/dsh-bots/api/debug/say', { method: 'POST', body: JSON.stringify({ botId: linkedBot, text: '只回一句话：你是谁？' }) })
  check('debug/say accepted', said.status === 200, said)
  const greeted = await waitFor(() => {
    const projection = projectionOf(session4)
    if (!projection) return null
    const raw = JSON.stringify(projection)
    if (!/"response"\s*:\s*"/.test(raw)) return null
    return raw
  }, 45000)
  check('assistant answer was recorded', !!greeted)
  if (greeted) {
    const bot = (await state()).bots.find(entry => entry.id === linkedBot)
    check('assistant identifies as the bot', greeted.includes(bot.name), { name: bot.name, sample: greeted.slice(-600) })
  }

  return { session1, session2, session3, session4 }
}

async function main() {
  const snapshot = await state()
  if (!snapshot || !snapshot.bots) throw new Error('host not reachable at ' + BASE)
  console.log('host build:', snapshot.build, '| bots:', snapshot.bots.length, '| workspaces:', (snapshot.workspaces || []).length)

  const idleBot = await makeBot('矩阵·无会话' + Date.now().toString(36), null)
  const linkedBot = await makeBot('矩阵·有工作区' + Date.now().toString(36), WORKSPACE)
  const result = await scenario(idleBot, linkedBot)
  console.log('\nsessions:', JSON.stringify(result, null, 2))

  for (const botId of createdBots) {
    await api('/dsh-bots/api/bots/' + botId, { method: 'DELETE' })
  }
  console.log('\n' + (failures === 0 ? 'MATRIX PASS' : 'MATRIX FAIL') + ' — ' + (checks - failures) + '/' + checks + ' checks')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(error => {
  console.error('MATRIX ERROR', error)
  process.exit(1)
})