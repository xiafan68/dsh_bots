// TDD spec for the private-chat flow.
// Red first: `chatFlow` does not exist yet in lib/client.js, so this file fails.
// The rule it pins down: opening an existing conversation never creates a new one.
import assert from 'node:assert/strict'

const module_ = await loadClient()
const chatFlow = module_.__chatFlow
assert.equal(typeof chatFlow, 'function', 'client exposes __chatFlow for tests')

const bot = { id: 'bot-1', name: 'x', workspaceId: 'D:/w' }
const calls = []
const deps = (over) => ({
  peek: async () => { calls.push('peek'); return over.existing ?? null },
  request: async (_b, _p, reset) => { calls.push(reset ? 'request:reset' : 'request:create'); return over.fresh || 'session-new' },
  open: async (id) => { calls.push('open:' + id); return over.opened !== false },
})

// 1. 已有会话、能打开：复用，不新建
calls.length = 0
let out = await chatFlow(bot, {}, deps({ existing: 'session-old', opened: true }))
assert.equal(out.sessionId, 'session-old')
assert.equal(out.created, false)
assert.deepEqual(calls, ['peek', 'open:session-old'], '复用已有会话时不应创建新会话')

// 2. 已有会话、打不开：报错，**不能**偷偷新建（本次 bug 的核心）
calls.length = 0
await assert.rejects(
  () => chatFlow(bot, {}, deps({ existing: 'session-old', opened: false })),
  (err) => err.code === 'CANNOT_OPEN',
  '打不开已有会话时必须抛 CANNOT_OPEN',
)
assert.ok(!calls.some((c) => c.startsWith('request')), '打不开时不得创建或重置会话，实际调用：' + calls.join(','))

// 3. 从来没有会话：创建一次
calls.length = 0
out = await chatFlow(bot, {}, deps({ existing: null, fresh: 'session-new', opened: true }))
assert.equal(out.sessionId, 'session-new')
assert.equal(out.created, true)
assert.deepEqual(calls, ['peek', 'request:create', 'open:session-new'])

// 4. 显式重置：跳过 peek，只请求一次 reset
calls.length = 0
out = await chatFlow(bot, { reset: true }, deps({ existing: 'session-old', fresh: 'session-next', opened: true }))
assert.equal(out.sessionId, 'session-next')
assert.equal(out.created, true)
assert.equal(out.reset, true)
assert.deepEqual(calls, ['request:reset', 'open:session-next'], '重置不应该先 peek，也不应该创建两次')

console.log('chat-flow: 4/4 PASS')

async function loadClient() {
  const fs = await import('node:fs')
  const vm = await import('node:vm')
  const code = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let exported = null
  const proto = { jsx() {}, jsxs() {}, Fragment: 'fragment', createElement() {}, useState(v) { return [v, () => {}] }, useCallback(f) { return f }, useEffect() {}, useRef(v) { return { current: v } } }
  const require = (name) => {
    if (name === 'react') return proto
    if (name === 'react/jsx-runtime') return { jsx: proto.jsx, jsxs: proto.jsxs, Fragment: 'fragment' }
    throw new Error('unexpected require: ' + name)
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(def) { exported = def.factory(require) } } },
    document: { createElement: () => ({ set textContent(v) {}, appendChild() {} }), head: { appendChild() {} }, querySelector: () => null, addEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    console, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return exported
}