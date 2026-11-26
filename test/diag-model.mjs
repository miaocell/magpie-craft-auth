/**
 * 诊断单个模型为什么不出正文：把所有事件名和排队状态打出来。
 * 用法：C='cookie' M='GLM-5.4' node test/diag-model.mjs
 */
import { CraftSession } from '../lib/session.mjs'

const s = new CraftSession({ cookie: process.env.C })
const model = process.env.M || 'GLM-5.4'

const sent = await s.send({ query: process.env.Q || '只回一个字：好', model })
console.log('conv', sent.conversationId, '| model', sent.model)

let text = ''
const seen = new Map()
const t0 = Date.now()

for await (const ev of s.stream({ conversationId: sent.conversationId, attempt: sent.taskId })) {
  const name = ev.event === 'agent_event' ? `agent:${ev.metadata?.name}` : ev.event
  const n = (seen.get(name) ?? 0) + 1
  seen.set(name, n)
  // 每种事件只打前两条，排队状态单独打
  if (n <= 2 && name !== 'agent:model_queue') {
    console.log(`[${name}]`, JSON.stringify(ev).slice(0, 220))
  }
  if (name === 'agent:model_queue') {
    const it = ev.metadata.item ?? {}
    console.log(`  queue state=${it.state} ahead=${JSON.stringify(it.ahead)} model=${it.model_id}`)
  }
  if (ev.event === 'message' && typeof ev.answer === 'string') text += ev.answer
  if (text.length > 12 || Date.now() - t0 > 75_000) break
}

console.log('\n事件统计:', Object.fromEntries(seen))
console.log('正文:', JSON.stringify(text))