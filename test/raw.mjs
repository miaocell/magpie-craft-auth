/**
 * 打印上游原始 SSE 增量，用来核对"字符丢失"到底是上游还是我们转发的问题。
 * 用法：C='cookie' node test/raw.mjs
 */
import { CraftSession } from '../lib/session.mjs'

const s = new CraftSession({ cookie: process.env.C })
const sent = await s.send({ query: process.env.Q || '数一下 1 到 5，只输出数字。', model: 'lgb-auto' })
console.log('conv', sent.conversationId, '| task', sent.taskId, '| model', sent.model)

let n = 0
let joined = ''
for await (const ev of s.stream({ conversationId: sent.conversationId, attempt: sent.taskId })) {
  if (ev.event === 'message') {
    joined += ev.answer
    console.log(`MSG#${++n}`, JSON.stringify(ev.answer))
    if (joined.length > 120) break
  }
}
console.log('\n拼接结果：', JSON.stringify(joined))
