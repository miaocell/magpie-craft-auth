/**
 * 精确验证流式转发：把每个 OpenAI chunk 的内容打出来，确认不丢字符。
 * 用法：C='cookie' node test/stream-check.mjs
 */
import plugin from '../index.mjs'

const p = await plugin({})
const auth = await p.auth.methods[0].authorize({ cookie: process.env.C })
const getAuth = async () => ({ type: 'api', key: auth.key })
const loader = await p.auth.loader(getAuth)

const res = await loader.fetch('https://craft.qq.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'lgb-auto',
    messages: [{ role: 'user', content: '数一下 1 到 5，只输出数字。' }],
    stream: true,
  }),
})

const reader = res.body.getReader()
const dec = new TextDecoder()
let buf = '', text = '', n = 0, done = false
const t0 = Date.now()
while (!done && Date.now() - t0 < 90_000) {
  const { done: d, value } = await reader.read()
  if (d) break
  buf += dec.decode(value, { stream: true })
  let i
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i).trim()
    buf = buf.slice(i + 2)
    if (!frame.startsWith('data:')) continue
    const payload = frame.slice(5).trim()
    if (payload === '[DONE]') { done = true; continue }
    const ev = JSON.parse(payload)
    const c = ev.choices?.[0]?.delta?.content
    if (typeof c === 'string') { text += c; console.log(`#${++n}`, JSON.stringify(c)) }
    if (ev.usage) console.log('USAGE', JSON.stringify(ev.usage))
  }
}
console.log('\n拼接：', JSON.stringify(text))
console.log('字符数：', text.length, '| chunk 数：', n)
console.log(text.includes('1') && text.includes('5') ? '✅ 首尾字符完整' : '❌ 有字符丢失')
