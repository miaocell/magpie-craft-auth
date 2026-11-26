/**
 * 核对混元两个模型是不是分开的：分别发请求，看上游 model_queue 报的 model_id。
 *
 * 页面菜单里 Hy4-preview 和 Hy4 是两条，但它们可能指向同一个后端。
 * 判据是 SSE 里 agent_event/model_queue 的 metadata.item.model_id。
 * 用法：C='cookie' node test/model-split.mjs
 */
import { CraftSession } from '../lib/session.mjs'

const s = new CraftSession({ cookie: process.env.C })

for (const wanted of ['Hy4-preview', 'Hy4', 'GLM-5.4', 'deepseek-v4.1-flash']) {
  process.stdout.write(`\n=== 请求 model=${wanted} ===\n`)
  let sent
  try {
    sent = await s.send({ query: '只回一个字：好', model: wanted })
  } catch (e) {
    console.log('发送失败:', e.message)
    continue
  }
  console.log('send ok | conv', sent.conversationId, '| 我们传的:', sent.model)

  let reported = null
  let text = ''
  const t0 = Date.now()
  try {
    for await (const ev of s.stream({ conversationId: sent.conversationId, attempt: sent.taskId })) {
      if (ev.event === 'agent_event' && ev.metadata?.name === 'model_queue') {
        reported = ev.metadata.item?.model_id
        console.log('上游实际分配:', reported, '| state:', ev.metadata.item?.state)
      }
      if (ev.event === 'message' && typeof ev.answer === 'string') text += ev.answer
      if (text.length > 20 || Date.now() - t0 > 45_000) break
    }
  } catch (e) {
    console.log('拉流失败:', e.message)
  }
  console.log('正文:', JSON.stringify(text.slice(0, 40)))
  console.log(reported === wanted ? '→ ✅ 路由到同名模型' : `→ ⚠️ 上游报的是 ${reported}`)
}