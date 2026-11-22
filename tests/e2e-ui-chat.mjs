// Browser end-to-end spec for the two buttons that kept surprising us.
// Runs against a real DSH web instance through CDP (headless Chrome).
//
//   DSH_UI_URL   http://127.0.0.1:6401/?token=...   (required)
//   CDP_PORT     9241                              (default)
//
// What it pins down:
//   - 重置 posts reset:true exactly once and the bot's session id changes once
//   - 私聊 twice: no reset:true is ever posted, the session id does not change
//   - after 私聊 the composer exists (the conversation actually opened)
import assert from 'node:assert/strict'
import { connect } from '../tmp/cdp-lib.mjs'

const URL_ = process.env.DSH_UI_URL
if (!URL_) throw new Error('DSH_UI_URL is required')

const c = await connect({ fresh: true })
await c.rpc('Network.enable')
await c.rpc('Page.navigate', { url: URL_ })
await c.wait(9000)
const ev = (e) => c.ev(e)

// Record every private-chat request the panel makes.
await ev(`(() => {
  window.__chatCalls = [];
  const orig = window.fetch;
  window.fetch = function (url, opts) {
    try {
      const u = String(url);
      if (u.indexOf('/dsh-bots/api/bots/') === 0 && u.indexOf('/chat') > 0) {
        window.__chatCalls.push({ url: u, body: opts && typeof opts.body === 'string' ? opts.body : null });
      }
    } catch (e) {}
    return orig.apply(this, arguments);
  };
  window.confirm = function () { return true };
  return 'hooked';
})()`)

const stateBot = async (id) => JSON.parse(await ev(`fetch('/dsh-bots/api/state').then(r => r.text())`)).bots.find((b) => b.id === id)

// The panel unmounts whenever the main view switches to a conversation, so
// every button press re-opens it first.
const ensurePanel = async () => {
  for (let i = 0; i < 6; i++) {
    if ((await ev(`document.querySelectorAll('.dxb-bot').length`)) > 0) return
    await ev(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /Bots/.test((x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')));
      if (b) b.click();
      window.confirm = function () { return true };
      return b ? 'clicked' : 'missing';
    })()`)
    await c.wait(1500)
  }
  throw new Error('打不开 Bots 面板（6 次尝试）')
}

await ensurePanel()

const cards = await ev(`document.querySelectorAll('.dxb-bot').length`)
assert.ok(cards > 0, 'Bots 面板应渲染卡片，实际 ' + cards)

// Pick the first bot card; identify it by the bot-xxx id printed on the card.
const botId = await ev(`(() => {
  const card = document.querySelector('.dxb-bot');
  const m = card && (card.innerText || '').match(/bot-\\d+/);
  return m ? m[0] : '';
})()`)
assert.ok(botId, '卡片上应带 bot-xxx 编号')

const before = await stateBot(botId)

const clickInCard = async (label) => { await ensurePanel(); return ev(`(() => {
  const card = Array.from(document.querySelectorAll('.dxb-bot')).find((x) => (x.innerText || '').indexOf(${JSON.stringify(botId)}) >= 0);
  if (!card) return 'no-card';
  const btn = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
  if (!btn) return 'no-' + ${JSON.stringify(label)};
  btn.click();
  return 'clicked';
})()`) }

// 1. 重置：只发一次 reset:true，会话换一次
await ev('window.__chatCalls = []')
assert.equal(await clickInCard('重置'), 'clicked', '卡片上应有「重置」')
await c.wait(9000)
const resetCalls = JSON.parse(await ev('JSON.stringify(window.__chatCalls)'))
const resetPosts = resetCalls.filter((s) => s.body && s.body.indexOf('"reset":true') >= 0)
assert.equal(resetPosts.length, 1, '一次点击只应发一次 reset:true，实际 ' + JSON.stringify(resetCalls))
const afterReset = await stateBot(botId)
assert.ok(afterReset.sessionId && afterReset.sessionId !== before.sessionId, '重置后 bot 的会话应换成新的')

// 2. 私聊两次：不得 reset，不得换会话
await ev('window.__chatCalls = []')
assert.equal(await clickInCard('私聊'), 'clicked')
await c.wait(6000)
assert.equal(await clickInCard('私聊'), 'clicked')
await c.wait(6000)
const chatCalls = JSON.parse(await ev('JSON.stringify(window.__chatCalls)'))
assert.ok(!chatCalls.some((s) => s.body && s.body.indexOf('"reset":true') >= 0), '私聊不得触发重置，实际 ' + JSON.stringify(chatCalls))
const afterChat = await stateBot(botId)
assert.equal(afterChat.sessionId, afterReset.sessionId, '私聊必须停在重置后的那个会话')

// 3. 会话确实打开了
const composer = await ev(`document.querySelectorAll('[contenteditable="true"],textarea').length`)
assert.ok(composer > 0, '私聊后应出现输入框')

console.log('e2e-ui-chat: 7/7 PASS (' + botId + ' ' + (before.sessionId || 'none').slice(0, 16) + ' -> ' + afterReset.sessionId.slice(0, 16) + ')')
process.exit(0)