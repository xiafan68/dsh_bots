// End-to-end spec for the private-chat contract, against a running DSH host.
//   DSH_BOTS_URL   base url          (default http://127.0.0.1:53625)
//
// Pins down what "重置" and "私聊" mean:
//   - a bot without a conversation: 私聊 creates exactly one
//   - 私聊 again: reuses it, never creates a second one
//   - 重置: creates exactly one new conversation and switches the bot over
//   - after 重置: 私聊 reuses the new one
import assert from 'node:assert/strict'

const BASE = process.env.DSH_BOTS_URL || 'http://127.0.0.1:53625'
const name = 'e2e-chat-' + Date.now().toString(36)

const call = async (path, init) => {
  const res = await fetch(BASE + '/dsh-bots/api' + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(path + ' -> ' + res.status + ' ' + JSON.stringify(body))
  return body
}
const chat = (id, body = {}) => call('/bots/' + id + '/chat', { method: 'POST', body: JSON.stringify(body) })

let botId = null
try {
  const created = await call('/bots', { method: 'POST', body: JSON.stringify({ name, icon: 'robot', systemPrompt: 'e2e' }) })
  const bot = created.bot || created
  botId = bot.id
  assert.ok(botId, 'POST /bots 应返回新 bot 的 id')

  const empty = await chat(botId, { peek: true })
  assert.equal(empty.sessionId, null, '新 bot 不应该有会话')

  const first = await chat(botId)
  const id1 = first.sessionId
  assert.ok(id1, '私聊应创建会话')
  assert.equal(first.created, true)

  const again = await chat(botId)
  assert.equal(again.sessionId, id1, '再次私聊必须复用同一个会话')
  assert.equal(again.created, false)

  const reset = await chat(botId, { reset: true })
  const id2 = reset.sessionId
  assert.ok(id2 && id2 !== id1, '重置必须换成一个新会话')
  assert.equal(reset.reset, true)
  assert.equal(reset.created, true)

  const afterReset = await chat(botId)
  assert.equal(afterReset.sessionId, id2, '重置后私聊必须进到新会话')
  assert.equal(afterReset.created, false)

  const peeked = await chat(botId, { peek: true })
  assert.equal(peeked.sessionId, id2)

  console.log('e2e-chat-api: 8/8 PASS (' + id1.slice(0, 18) + ' -> ' + id2.slice(0, 18) + ')')
} finally {
  if (botId) await call('/bots/' + botId, { method: 'DELETE' }).catch(() => {})
}