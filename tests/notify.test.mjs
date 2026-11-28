// Round-end notices: every way a round can end (worker hand-back, block, stop,
// timeout) has to reach the orchestrator exactly once, with enough context to
// act. finishRound is the single choke point, so these tests drive it directly.
import assert from 'node:assert/strict'
import { createService } from '../src/service.mjs'

const TASK = {
  id: 'T-100',
  title: '让登录页支持手机号',
  status: 'in_progress',
  assignee: { kind: 'bot', id: 'bot-worker' },
  sessionId: 'session-worker',
  activeRoundId: 'round-1',
  notify: null,
  pendingDispatch: null,
}

function harness({ taskOverrides = {}, orchestratorSession = 'session-orch' } = {}) {
  const notifications = []
  let task = { ...TASK, ...taskOverrides }
  const store = {
    async finishRound(taskId, { status = 'completed' } = {}) {
      if (status === 'completed') task = { ...task, status: 'in_review', activeRoundId: null }
      else task = { ...task, status: 'blocked', activeRoundId: null }
      return { task: { ...task }, round: { id: 'round-1', status } }
    },
    async getTask() {
      return { ...task }
    },
    async getBot(id) {
      return { id, name: '执行小助手' }
    },
    async listBots() {
      return [{ id: 'bot-orch', name: '主控', isOrchestrator: true, sessionId: orchestratorSession }]
    },
    async pushNotification(record) {
      notifications.push(record)
      return { id: 'n-' + notifications.length, ...record }
    },
    async pendingNotifications() {
      return []
    },
    async markNotificationsDelivered() {},
    peek(fn) {
      return fn({ bots: [], tasks: [] })
    },
  }
  const service = createService({ ctx: { get: () => false }, store, log: () => {} })
  return { service, notifications }
}

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log('notify: PASS ' + name)
  } catch (error) {
    fail += 1
    console.log('notify: FAIL ' + name)
    console.log('  ' + (error && error.message ? error.message : error))
  }
}

await check('completed round notifies the orchestrator once, with next steps', async () => {
  const { service, notifications } = harness()
  await service.finishRound('T-100', { status: 'completed', note: '改了 login.tsx，单测通过' })
  assert.equal(notifications.length, 1, 'exactly one notice per round end')
  const notice = notifications[0]
  assert.equal(notice.target, 'orchestrator')
  assert.equal(notice.urgent, true, 'a finished round must reach the orchestrator, not only its inbox')
  assert.match(notice.text, /T-100/)
  assert.match(notice.text, /执行小助手/)
  assert.match(notice.text, /session-worker/)
  assert.match(notice.text, /in_review/)
  assert.match(notice.text, /task_update status=done/, 'the notice must say what to do next')
})

await check('failed round points at re-dispatch, not acceptance', async () => {
  const { service, notifications } = harness()
  await service.finishRound('T-100', { status: 'failed', note: '测试挂了' })
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].text, /轮次失败/)
  assert.match(notifications[0].text, /task_dispatch/)
})

await check('silent finishes stay out of the transcript', async () => {
  const { service, notifications } = harness()
  await service.finishRound('T-100', { status: 'failed', note: '换会话时中止', silent: true })
  assert.equal(notifications.length, 0, 'housekeeping must not ping the orchestrator')
})

await check('a task finished by the orchestrator itself does not notify itself', async () => {
  const { service, notifications } = harness({
    taskOverrides: { sessionId: 'session-orch' },
    orchestratorSession: 'session-orch',
  })
  await service.finishRound('T-100', { status: 'completed', note: '主控自己做的' })
  assert.equal(notifications.length, 0, 'no self-notification loop')
})

await check('task.notify=silent still records but does not wake the orchestrator', async () => {
  const { service, notifications } = harness({ taskOverrides: { notify: 'silent' } })
  await service.finishRound('T-100', { status: 'completed', note: '常规收尾' })
  assert.equal(notifications.length, 1, 'the record stays for inbox_list')
  assert.equal(notifications[0].urgent, false, 'but it is not pushed into the chat')
})

console.log(`notify: ${pass}/${pass + fail} PASS`)
if (fail) process.exitCode = 1