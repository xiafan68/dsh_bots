// Store-level regression tests for the workspace/session changes:
// a task must be able to carry a workspace, and an abandoned execution session
// must disappear from the bindings instead of keeping the task bound to it.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { BotsStore } from '../src/store.mjs'

let pass = 0
let fail = 0

async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`store: PASS ${name}`)
  } catch (error) {
    fail += 1
    console.log(`store: FAIL ${name}`)
    console.log('  ' + (error && error.message ? error.message : error))
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-bots-store-'))
const store = new BotsStore({ dir })

try {
  await check('任务可以携带并改绑 workspace', async () => {
    const task = await store.createTask({ title: 'workspace 指派', workspaceId: 'ws-a' })
    assert.equal(task.workspaceId, 'ws-a')
    const moved = await store.updateTask(task.id, { workspaceId: 'ws-b' })
    assert.equal(moved.workspaceId, 'ws-b')
    // `null` clears the workspace instead of being treated as "not provided".
    const cleared = await store.updateTask(task.id, { workspaceId: null })
    assert.equal(cleared.workspaceId, null)
  })

  await check('unbindSession 只摘掉目标会话的绑定', async () => {
    const bot = await store.createBot({ name: '执行 bot' })
    const task = await store.createTask({ title: '换会话', workspaceId: 'ws-a' })
    await store.bindSession({ sessionId: 's-old', botId: bot.id, kind: 'task', taskId: task.id, workspaceId: 'ws-a' })
    await store.bindSession({ sessionId: 's-new', botId: bot.id, kind: 'task', taskId: task.id, workspaceId: 'ws-b' })
    const dropped = await store.unbindSession('s-old')
    assert.equal(dropped, true)
    assert.equal(await store.bindingFor('s-old'), null)
    assert.equal((await store.bindingFor('s-new')).workspaceId, 'ws-b')
    // Unbinding twice is a no-op, not an error.
    assert.equal(await store.unbindSession('s-old'), false)
  })

  await check('新会话可以写回任务并去重绑定', async () => {
    const task = await store.createTask({ title: '重建会话', workspaceId: 'ws-c' })
    await store.updateTask(task.id, { sessionId: null })
    await store.updateTask(task.id, { sessionId: 's-1' })
    await store.bindSession({ sessionId: 's-1', botId: 'bot-001', kind: 'task', taskId: task.id, workspaceId: 'ws-c' })
    const reloaded = await store.getTask(task.id)
    assert.equal(reloaded.sessionId, 's-1')
    assert.equal((await store.bindingFor('s-1')).taskId, task.id)
  })
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\nstore: ${pass}/${pass + fail} PASS`)
if (fail > 0) process.exit(1)