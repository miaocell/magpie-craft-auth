/**
 * OpenAI chat/completions → 游点灵 send + stream。
 *
 * 站点这套协议与 OpenAI 差得比较远，转换要点：
 *
 *  - 上游只有「一条 query 字符串」，没有多轮 messages 数组。所以把历史
 *    压成一段带角色标记的文本前置到 query 里，最后一条 user 消息原样保留。
 *  - 回复是 SSE 的 `event:message` 增量 `answer` 拼接，没有 finish_reason，
 *    也不给 token 计数。我们只能按字符数估 usage。
 *  - `agent_event` 里的 tool_called / tool_output 是它的游戏开发 Agent 在
 *    读写工作区文件，跟对话内容无关，直接丢弃，否则会把文件内容混进回答。
 *  - 站点是"每轮扣积分"的，一个请求对应一次扣费，重试要谨慎。
 */
import { CraftSession } from './session.mjs'
import { selectModel, DEFAULT_MODEL } from './models.mjs'
import { ProviderError } from './const.mjs'

/** 把 OpenAI messages 折成一段纯文本 query */
function foldMessages(messages, systemPrefix = '') {
  const list = Array.isArray(messages) ? messages : []
  if (!list.length) throw new ProviderError('请求里没有 messages。', 400, 'bad_request')

  // 最后一条 user 才是这轮真正要问的
  let lastUserIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') { lastUserIdx = i; break }
  }
  if (lastUserIdx < 0) throw new ProviderError('请求里没有 user 消息。', 400, 'bad_request')

  const textOf = (content) => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part
          if (part?.type === 'text') return String(part.text ?? '')
          // 站点暂不支持图片输入，占位说明优于静默丢失
          if (part?.type === 'image_url') return '[图片已省略：上游不支持图片输入]'
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    return ''
  }

  const label = { system: '系统', user: '用户', assistant: '助手', tool: '工具' }
  const history = []
  for (let i = 0; i < lastUserIdx; i++) {
    const m = list[i]
    const t = textOf(m?.content).trim()
    if (!t) continue
    history.push(`${label[m.role] ?? m.role}：${t}`)
  }

  const question = textOf(list[lastUserIdx].content).trim()
  if (!question) throw new ProviderError('最后一条 user 消息是空的。', 400, 'bad_request')

  const parts = []
  if (systemPrefix) parts.push(systemPrefix.trim())
  if (history.length) {
    parts.push('以下是此前的对话记录，供你参考：\n' + history.join('\n'))
  }
  parts.push(question)

  return { query: parts.join('\n\n'), folded: history.length > 0 }
}

/** 粗估 token：中文按 1 字 1 token，英文按 4 字符 1 token 折中取 1.6 字符/token */
function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk++
  }
  const rest = [...text].length - cjk
  return Math.max(1, Math.round(cjk + rest / 3.5))
}

function wantStream(body) {
  return body?.stream === true
}

/** 非流式响应 */
function jsonResponse(content, model, usage) {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  )
}

/** 流式响应：把上游增量转成 OpenAI 的 chunk 形状 */
function streamResponse(iterator, model, usageRef, readQueue, cleanup) {
  const enc = new TextEncoder()
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)

  const body = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))

      const chunk = (delta, finish = null) => send({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })

      try {
        // 首个 chunk 只声明 role，content 留空但**不能**带空字符串——
        // 部分客户端会把空串当成一个真实增量，导致首个字符被吞。
        chunk({ role: 'assistant' })
        let full = ''
        for await (const text of iterator) {
          if (!text) continue
          full += text
          chunk({ content: text })
        }

        // 整轮没出字又确实在排队：明确告诉调用方是排队，不是空回复
        const q = typeof readQueue === 'function' ? readQueue() : null
        if (!full && q) {
          send({
            error: {
              message: `游点灵「${q.model || model}」排队中（前面还有 ${q.ahead} 个请求），本轮没等到正文。这是站点侧排队，换个模型或稍后重试。`,
              type: 'model_queued',
              code: 'model_queued',
              ahead: q.ahead,
            },
          })
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          return
        }

        chunk({}, 'stop')

        const usage = {
          prompt_tokens: usageRef.prompt,
          completion_tokens: estimateTokens(full),
          total_tokens: usageRef.prompt + estimateTokens(full),
        }
        // 最后单独发一帧 usage（OpenAI 的 stream_options.include_usage 行为）
        send({
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          usage,
        })
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send({ error: { message, type: 'upstream_error' } })
      } finally {
        try { controller.close() } catch { /* 已关 */ }
        // 清理放到 close 之后，且不 await：cancel + delete 两个请求要花十几秒，
        // 等它们完成会让调用方多等一整个回合。失败了也不影响已发出的内容。
        if (typeof cleanup === 'function') {
          cleanup().catch(() => {})
        }
      }
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

/**
 * 从上游事件流里只取正文增量。
 *
 * 过滤规则来自实测：`event:message` 的 `answer` 是正片；其余
 * `agent_event`（tool_called / tool_output / model_queue / reasoning_item_created）
 * 都是它内部 Agent 的动作，混进回答会污染内容。
 *
 * 但 model_queue 里有一件事必须往上报：`state` 和 `ahead`。热门模型
 * （限时免费那几个）会排队到 ahead 几十，正文要等很久。不报的话调用方
 * 只看到长时间没输出，会以为是插件坏了。
 */
async function* answerOnly(events, onQueue) {
  for await (const ev of events) {
    if (ev?.event === 'message' && typeof ev.answer === 'string') {
      yield ev.answer
      continue
    }

    if (ev?.event === 'agent_event' && ev.metadata?.name === 'model_queue') {
      const item = ev.metadata.item ?? {}
      if (typeof onQueue === 'function') {
        onQueue({ state: item.state ?? '', ahead: item.ahead ?? null, model: item.model_id ?? '' })
      }
      continue
    }

    // 出错信号：转成异常让外层能带上 status
    if (ev?.event === 'error') {
      throw new ProviderError(
        `游点灵回复失败：${ev.message ?? ev.msg ?? JSON.stringify(ev).slice(0, 200)}`,
        502,
        'upstream_error',
      )
    }
  }
}

/**
 * 发消息，撞并发上限时先清槽位再重试一次。
 *
 * 为什么值得这么做：10010 的成因通常不是"另一轮真在跑"，而是上一轮异常收尾
 * （客户端提前断开、模型排队到天荒地老）后服务端没回收槽位。这种情况下
 * 对那个会话 cancel 一次就能放掉，重发即可 —— 不需要用户手动去网页点停止。
 *
 * 只重试一次：如果 cancel 之后还撞，说明确实有别的对话在跑，重试只会白扣积分。
 */
async function sendWithSlotRecovery(session, opts) {
  try {
    return await session.send(opts)
  } catch (error) {
    // 10010：账号级并发满了；10004：这个会话上一轮还没收尾。
    // 两种都是「槽位没放掉」，cancel 一次再重发即可。
    if (error?.code !== 10010 && error?.code !== 10004) throw error
    const target = opts.conversationId
    if (!target) throw error
    const cleaned = await session.cancel(target)
    if (!cleaned) throw error
    return await session.send(opts)
  }
}

/**
 * 主入口。签名与 magpie 的 auth.loader().fetch 一致。
 */
export async function chat(session, input, init = {}) {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: '只接受 POST。' } }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let body
  try { body = await request.json() }
  catch { throw new ProviderError('请求体不是合法 JSON。', 400, 'bad_request') }

  if (!session.signedIn) {
    throw Object.assign(
      new ProviderError('请先登录游点灵账号。', 401, 'sign_in_required'),
      { signIn: 'required' },
    )
  }

  const { query } = foldMessages(body.messages, body.__systemPrefix ?? '')

  // 选模型：认不出就退回默认（auto），不要因为模型名不匹配直接失败
  let catalog = []
  try { catalog = await session.models() } catch { /* 拿不到目录就用默认 */ }
  const chosen = selectModel(catalog, body.model) ?? DEFAULT_MODEL

  const signal = request.signal

  // 会话复用：一个 magpie 进程内，同一 model+首条消息指纹走同一个 conversation，
  // 这样多轮对话在站点侧是连贯的。没有 fingerprint 就每条新开。
  const convKey = body.__conversationId ?? null
  const sent = await sendWithSlotRecovery(session, {
    query,
    conversationId: convKey,
    model: chosen,
    signal,
  })

  const usageRef = { prompt: estimateTokens(query) }
  // 排队状态：热门模型（限时免费那几个）会排几十位，正文要等很久，
  // 把这个信息推给调用方，免得看起来像卡死
  let queueNote = null
  const onQueue = (q) => {
    if (q.ahead !== null && q.ahead > 0) queueNote = q
  }
  const events = answerOnly(session.stream({
    conversationId: sent.conversationId,
    attempt: sent.taskId,
    signal,
  }), onQueue)

  // 收尾清理：每次请求都会在账号里留下一个项目，站点对项目总数有硬上限（实测 50），
  // 只建不删跑到上限后整个插件都用不了（30006）。这里在请求结束时删掉会话。
  //
  // 顺序是「先删、删不掉才 cancel」——实测 DELETE 对处理中的会话也直接成功（很快），
  // 而 cancel 在同一个会话上会一直等，反而更慢。cancel 只在 DELETE 被拒时才补一刀。
  const cleanup = async () => {
    try {
      const deleted = await session.deleteConversation(sent.conversationId)
      if (!deleted) {
        await session.cancel(sent.conversationId)
        await session.deleteConversation(sent.conversationId)
      }
    } catch { /* 清理失败不影响本次回复 */ }
  }

  if (wantStream(body)) {
    return streamResponse(events, chosen, usageRef, () => queueNote, cleanup)
  }

  // 非流式：把整段收完再回
  let full = ''
  try {
    for await (const t of events) full += t
  } finally {
    // 不阻塞回复：cancel + delete 要十几秒，等它会把整轮拖长。
    // 清理失败也没关系，下次 prune 能补上。
    cleanup().catch(() => {})
  }
  if (!full && queueNote) {
    throw new ProviderError(
      `游点灵「${chosen}」排队中（前面还有 ${queueNote.ahead} 个请求），本轮窗口内没等到正文。` +
      '这是站点侧排队，不是插件的问题——热门/限时免费模型在高峰期会排队几十位，' +
      '过一会儿再试，或换 deepseek-v4.1-flash / lgb-auto 这类不排队的模型。',
      503,
      'model_queued',
      { model: chosen, ahead: queueNote.ahead },
    )
  }
  return jsonResponse(full, chosen, {
    prompt: usageRef.prompt,
    completion: estimateTokens(full),
  })
}

/** 拿一条最短的测试消息探活，用于登录校验（不消耗太多积分） */
export async function probe(session, signal) {
  const me = await session.me(signal)
  return me
}

export { CraftSession }
