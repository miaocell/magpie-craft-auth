/**
 * craft.qq.com（游点灵 / CraftBuddy）的会话与请求层。
 *
 * 站点模型不是 OpenAI 兼容：发消息是一次 POST，回复要另开一条 SSE 拉取，
 * 两者靠 conversation_id 关联。这里把这套东西收成一个 session 对象。
 *
 * 关键三条（都是实测出来的）：
 *   1. 登录态只看 Cookie 里的 `jwt_token`（HttpOnly），服务端直连不校验 TLS 指纹，
 *      也不需要浏览器；有这一条就能从 Node 直接打上游。
 *   2. POST /api/chathost/send 必须带 `X-Client-Version` / `X-Client-Type`，
 *      少了就报「请求参数错误」（10001），光看 body 是查不出来的。
 *   3. 回复走 GET /api/chathost/stream?conversation_id=&attempt=，
 *      `attempt` 用的是 send 返回的 task_id。SSE 里 `event:message` 的 `answer`
 *      是增量文本，`agent_event` 是工具调用/模型队列等元数据。
 */
import { BASE, HEADERS, ProviderError } from './const.mjs'

const TIMEOUT = 60_000

/**
 * 一个账号的会话。cookie 是原始 Cookie 头字符串。
 */
export class CraftSession {
  constructor({ cookie, nickname = '', userId = null } = {}) {
    this.cookie = String(cookie || '').trim()
    this.nickname = nickname
    this.userId = userId
    this._models = null
    this._modelsAt = 0
    this._quota = null
    this._quotaAt = 0
  }

  get signedIn() {
    return this.cookie.length > 0
  }

  headers(extra = {}) {
    return { ...HEADERS, Cookie: this.cookie, ...extra }
  }

  /** 统一的 JSON 请求；非 2xx 或 code !== 0 都抛 ProviderError */
  async json(path, { method = 'GET', body, signal, allowCodes = [] } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(TIMEOUT),
    })

    // 401 是 curl 侧最常见的「cookie 过期」，要能被上层识别成重新登录
    if (res.status === 401) {
      throw Object.assign(
        new ProviderError('游点灵登录态已失效，请重新导入 Cookie。', 401, 'sign_in_required'),
        { signIn: 'expired' },
      )
    }

    const text = await res.text()
    let data
    try { data = JSON.parse(text) }
    catch {
      throw new ProviderError(
        `游点灵返回了非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}`,
        res.status || 502,
        'bad_response',
      )
    }

    if (!res.ok) {
      throw new ProviderError(
        `游点灵请求失败（HTTP ${res.status}）：${data?.message ?? text.slice(0, 200)}`,
        res.status,
        'upstream_error',
      )
    }

    // 站点自己的业务码：0 = ok，10104 = 未登录，10010 = 并发已满
    if (typeof data?.code === 'number' && data.code !== 0 && !allowCodes.includes(data.code)) {
      if (data.code === 10104) {
        throw Object.assign(
          new ProviderError('游点灵登录态已失效（10104 未登录），请重新导入 Cookie。', 401, 'sign_in_required'),
          { signIn: 'expired' },
        )
      }
      // 同一账号同一时刻只能跑一个对话。上一轮的槽位没回收就会一直撞这个，
      // 对那个会话调 cancel 能放掉（见 CraftSession.cancel）。
      if (data.code === 10010) {
        throw Object.assign(
          new ProviderError(
            '游点灵这个账号当前已有对话在跑（10010 并行聊天已达上限）。' +
            '等上一轮结束再发；如果上一轮是排队中的热门模型，它可能占位很久——' +
            '用 daily_grant / balance 之外的 cancel 清一下那个会话，或换 ' +
            'deepseek-v4.1-flash / lgb-auto 这类不排队的模型。',
            429,
            'concurrency_limit',
            { code: 10010 },
          ),
          { conversationId: body?.conversation_id ?? null },
        )
      }
      throw new ProviderError(
        `游点灵业务错误 ${data.code}：${data.message ?? ''}`,
        502,
        'upstream_error',
        { code: data.code, requestId: data.request_id },
      )
    }

    return data
  }

  /** 当前账号信息，用来校验 cookie 有效性 */
  async me(signal) {
    const data = await this.json('/api/auth/me', { signal })
    this.nickname = data?.nickname ?? this.nickname
    this.userId = data?.user_id ?? this.userId
    return {
      nickname: this.nickname,
      userId: this.userId,
      roles: data?.roles ?? [],
      // creator_activation.stage = signed 表示创作者资格已激活
      creatorStage: data?.creator_activation?.stage ?? null,
    }
  }

  /**
   * 模型清单。缓存 5 分钟——菜单变化很慢，而一次对话要读好几次。
   * 返回 [{ id, name, free, tags }]
   */
  async models(signal, force = false) {
    if (!force && this._models && Date.now() - this._modelsAt < 300_000) return this._models

    const data = await this.json('/api/chathost/model-options', { signal })
    const list = data?.data?.platform_models ?? []
    const models = list.map((m) => {
      const tags = (m.tags ?? []).map((t) => String(t?.label ?? '')).filter(Boolean)
      return {
        id: String(m.id),
        name: String(m.name ?? m.id),
        free: tags.some((t) => /免费/.test(t)),
        auto: m.id === data?.data?.default_platform_model,
        tags,
      }
    })

    this._models = models
    this._modelsAt = Date.now()
    this._defaultModel = data?.data?.default_platform_model ?? models[0]?.id ?? 'lgb-auto'
    return models
  }

  async defaultModel(signal) {
    if (!this._models) await this.models(signal)
    return this._defaultModel ?? 'lgb-auto'
  }

  /** 积分余额。前端在 header 上显示的数字，来自这个接口 */
  async quota(signal, force = false) {
    if (!force && this._quota && Date.now() - this._quotaAt < 60_000) return this._quota
    try {
      const data = await this.json('/api/chathost/usage', { signal })
      this._quota = data?.data ?? data
      this._quotaAt = Date.now()
      return this._quota
    } catch (error) {
      // 额度取不到不该让整块面板失败
      if (error?.signIn) throw error
      return null
    }
  }

  /**
   * 新建一个对话，返回服务端分配的 conversation_id。
   *
   * 站点没有"给个空会话"的接口——`POST /api/ms/conversations` 必须带标题和
   * 描述，服务端建完返回 id（10 位 base36）。id 不能自己编：随便造的
   * conversation_id 在 send 时会回 10006「会话不存在」。
   */
  async createConversation({ title = '新对话', description = '', signal } = {}) {
    const data = await this.json('/api/ms/conversations', {
      method: 'POST',
      body: { title: title || '新对话', raw_description: description || title || '新对话' },
      signal,
    })
    const d = data?.data ?? data
    const id = d?.conversation_id ?? d?.id ?? d?.app_id ?? ''
    if (!id) {
      throw new ProviderError('创建游点灵会话失败：服务端没返回会话 id。', 502, 'create_failed')
    }
    return { conversationId: String(id) }
  }

  /**
   * 中止一个会话上正在跑/排队中的对话。
   *
   * 这个接口很关键：站点把「同一账号同时只能跑一个对话」的槽位挂在会话上，
   * 如果一轮请求没正常收尾（比如客户端提前断开、模型一直排队），槽位不会自动
   * 回收，之后所有请求都会回 10010 并行聊天已达上限。对那个会话调一次 cancel
   * 就能把槽位放掉——实测有效。（`/api/chathost/scenes/cancel` 是另一套
   * 游戏场景接口，对普通对话会回 41002 场景会话不存在，别用。）
   */
  async cancel(conversationId, { signal } = {}) {
    if (!conversationId) return false
    try {
      const res = await fetch(`${BASE}/api/chathost/cancel`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ conversation_id: conversationId, scene_id: conversationId }),
        signal: signal ?? AbortSignal.timeout(15_000),
      })
      const text = await res.text()
      return /"message"\s*:\s*"ok"/.test(text) || /"code"\s*:\s*0/.test(text)
    } catch {
      return false
    }
  }

  /**
   * 发一条消息，返回 { taskId, assistantMessageId, conversationId }。
   * 这一步只入队，正文要从 stream() 读。
   */
  async send({ query, conversationId, model, signal, history = [] }) {
    // 会话必须先在服务端存在，随手的随机串会被拒（10006 会话不存在）
    let conv = conversationId
    if (!conv) {
      const created = await this.createConversation({
        title: query.slice(0, 30),
        description: query.slice(0, 200),
        signal,
      })
      conv = created.conversationId
    }

    const chosen = model || await this.defaultModel(signal)

    const body = {
      query,
      conversation_id: conv,
      is_regenerate: false,
      model: 'chathost',
      user_message_id: crypto.randomUUID(),
      inputs: {
        domain: BASE,
        expert_ids: [],
        model_selection: { source: 'system', model: chosen },
      },
    }

    const data = await this.json('/api/chathost/send', {
      method: 'POST',
      body,
      signal,
    })

    const d = data?.data ?? {}
    return {
      conversationId: d.conversation_id ?? conv,
      taskId: d.task_id ?? '',
      assistantMessageId: d.assistant_message_id ?? '',
      model: chosen,
      isNew: !conversationId,
    }
  }

  /**
   * 拉 SSE。逐条 yield 解析后的事件对象。
   *
   * 站点用的是标准 SSE 帧（`id: N\ndata: {...}\n\n`），但注意它偶尔会
   * 在一帧里塞多行、也没有 `event:` 字段——类型在 JSON 的 `event` 键里。
   */
  async *stream({ conversationId, attempt, signal }) {
    const url = `${BASE}/api/chathost/stream?conversation_id=${encodeURIComponent(conversationId)}&attempt=${encodeURIComponent(attempt)}`
    const res = await fetch(url, {
      headers: this.headers({ Accept: 'text/event-stream' }),
      signal,
    })

    if (!res.ok || !res.body) {
      throw new ProviderError(`拉取游点灵回复流失败（HTTP ${res.status}）`, res.status || 502, 'stream_failed')
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          try { yield JSON.parse(payload) }
          catch { /* 半帧或心跳，忽略 */ }
        }
      }
      // 收尾：最后可能没有空行
      const line = buffer.split('\n').find((l) => l.startsWith('data:'))
      if (line) {
        try { yield JSON.parse(line.slice(5).trim()) } catch { /* 忽略 */ }
      }
    } finally {
      try { await reader.cancel() } catch { /* 已结束 */ }
    }
  }
}
