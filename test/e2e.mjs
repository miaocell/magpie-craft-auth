/**
 * 本地验证脚本。不依赖 magpie，直接调插件导出的函数。
 * 用法：CRAFT_COOKIE='...' node test/e2e.mjs
 */
import plugin from '../index.mjs'
import { normalizeCookie } from '../lib/cookie.mjs'

const cookie = process.env.CRAFT_COOKIE
if (!cookie) { console.error('缺 CRAFT_COOKIE'); process.exit(1) }

const p = await plugin({ client: { app: { log: (x) => console.log('[magpie]', x.body?.message ?? x) } } })

console.log('\n=== 1. config ===')
const cfg = {}
await p.config(cfg)
console.log('provider id:', cfg.provider.craft.id, '| models:', Object.keys(cfg.provider.craft.models).length)

console.log('\n=== 2. 登录校验 ===')
const method = p.auth.methods[0]
const auth = await method.authorize({ cookie })
console.log(JSON.stringify(auth, null, 2).slice(0, 600))
if (auth.type !== 'success') process.exit(1)

const getAuth = async () => ({ type: 'api', key: auth.key })

console.log('\n=== 3. 模型菜单 ===')
const models = await p.provider.models(cfg.provider.craft, { auth: await getAuth() })
for (const [id, m] of Object.entries(models)) {
  console.log(` ${id} | name=${m.name} | rate=${m.rate ?? '-'} | ctx=${m.limit.context}`)
}

console.log('\n=== 4. 额度 ===')
console.log(JSON.stringify(await p.auth.usage(getAuth), null, 2).slice(0, 800))

console.log('\n=== 5. loader + 非流式对话 ===')
const loader = await p.auth.loader(getAuth)
const res = await loader.fetch('https://craft.qq.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: '你是简洁的助手。' },
      { role: 'user', content: '用一个短句解释什么是打砖块游戏。' },
    ],
    stream: false,
  }),
})
console.log('status:', res.status)
const j = await res.json()
console.log('content:', j.choices?.[0]?.message?.content?.slice(0, 300))
console.log('usage:', JSON.stringify(j.usage))

console.log('\n=== 6. 流式对话 ===')
const res2 = await loader.fetch('https://craft.qq.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'lgb-auto',
    messages: [{ role: 'user', content: '数一下 1 到 5。' }],
    stream: true,
  }),
})
console.log('status:', res2.status, '| ct:', res2.headers.get('content-type'))
const reader = res2.body.getReader()
const dec = new TextDecoder()
let buf = '', text = '', chunks = 0
const deadline = Date.now() + 90_000
// 注意：不要用 Promise.race 加超时去抢 reader.read()——超时赢的那一次
// 会把已经读到的 chunk 丢掉，看起来就像"首字符消失"。这里只有整体截止时间。
while (Date.now() < deadline) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  let i
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i).trim()
    buf = buf.slice(i + 2)
    if (!frame.startsWith('data:')) continue
    const payload = frame.slice(5).trim()
    if (payload === '[DONE]') { console.log('[DONE]'); continue }
    try {
      const ev = JSON.parse(payload)
      chunks++
      const d = ev.choices?.[0]?.delta?.content
      if (typeof d === 'string') text += d
      if (ev.usage) console.log('usage帧:', JSON.stringify(ev.usage))
    } catch (e) { console.log('BAD FRAME', payload.slice(0, 80)) }
  }
  // 收到 stop 就够了，不必等连接关
  if (buf.includes('"finish_reason":"stop"') || text.includes('。')) break
}
try { await reader.cancel() } catch {}
console.log('chunks:', chunks, '| 正文:', text.slice(0, 300))

console.log('\n=== 全部通过 ===')
