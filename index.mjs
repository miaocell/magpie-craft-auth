/**
 * 游点灵（craft.qq.com / CraftBuddy）的 magpie 供应商插件。
 *
 * 把腾讯游点灵的积分变成 magpie 网关上的一组模型：登录一次，Claude Code /
 * Codex / OpenCode / 任何走 OpenAI 兼容接口的 Agent 都能用，消耗的是这个
 * 账号的积分。
 *
 * ## 站点结构（逆向结论，决定了本插件的形状）
 *
 *  - 前端是 Vue3 SPA，业务接口全部同域 `/api/**`。
 *  - 接口**不是** OpenAI 兼容：发消息是 `POST /api/chathost/send`，
 *    回复要另开 `GET /api/chathost/stream` 的 SSE 拉。两者靠 conversation_id 关联。
 *  - 登录态只在 Cookie 的 `jwt_token`（HttpOnly）里。**服务端直连不校验
 *    TLS / HTTP2 指纹**，也不需要浏览器，带对 Cookie 和两个客户端头就能打。
 *  - `X-Client-Version` / `X-Client-Type` 缺任一个就回 10001，光看 body 查不出来。
 *
 * ## 为什么不做成反代
 *
 * 反代只能把网页搬过来，模型用不了。插件直连上游，多轮上下文、流式输出
 * 都由 magpie 掌控，也不依赖本机是否开着浏览器。
 *
 * ## 登录
 *
 * 两条路：
 *  1. 粘贴 Cookie —— 从 DevTools → Network → 任一 /api 请求 → 请求头里整段复制。
 *     这是唯一能拿到 HttpOnly `jwt_token` 的方式，多账号就多粘几次。
 *  2. 用浏览器登录 —— 插件开一个独立调试实例，你登完它自动抓 Cookie。
 *
 * 凭据存进插件自己的保管库（Windows 上 DPAPI 加密），与浏览器解耦。
 *
 * 导出只有这一个函数——入口模块导出的每个函数都会被当成插件调用。
 */
import { CraftSession } from './lib/session.mjs'
import { chat, probe } from './lib/chat.mjs'
import { normalizeCookie, parseCookieHeader, cookieHeaderFrom } from './lib/cookie.mjs'
import { buildProvider, buildModels, PROVIDER, DEFAULT_MODEL } from './lib/models.mjs'
import { magpieModels } from './lib/magpie-models.mjs'
import { normalizeQuota } from './lib/quota.mjs'
import { dailyStatus } from './lib/daily.mjs'
import { saveAccount, loadAccount, listAccounts, removeAccount } from './lib/vault.mjs'
import { launchDebugBrowser, cookiesFromDebugPort } from './lib/cdp.mjs'
import { icon } from './lib/icon.mjs'
import { ProviderError, BASE } from './lib/const.mjs'

export { PROVIDER }

/** 会话缓存：同一个 userId 在一个进程内复用，避免每次请求都重建 */
const sessions = new Map()

function sessionFor(userId, cookie) {
  const key = String(userId)
  let s = sessions.get(key)
  if (!s || (cookie && s.cookie !== cookie)) {
    s = new CraftSession({ cookie, userId })
    sessions.set(key, s)
  }
  return s
}

export default async function CraftPlugin(input = {}) {
  const log = (level, message) => {
    try { input?.client?.app?.log?.({ body: { service: 'craft', level, message } }) } catch { /* 忽略 */ }
  }

  /** auth.key 里存的是 userId，真正的 cookie 每次从保管库现读 */
  function sessionFromAuth(auth) {
    if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key) {
      throw Object.assign(
        new ProviderError('请先登录游点灵账号。', 401, 'sign_in_required'),
        { signIn: 'required' },
      )
    }
    const acc = loadAccount(auth.key)
    if (!acc?.cookie) {
      throw Object.assign(
        new ProviderError('本地保管库里找不到这个账号，请重新登录。', 401, 'account_missing'),
        { signIn: 'expired' },
      )
    }
    return sessionFor(acc.userId, acc.cookie)
  }

  /** 校验一个 cookie：拿 /api/auth/me，顺便把账号信息带出来 */
  async function verify(cookie, signal) {
    const s = new CraftSession({ cookie })
    const me = await s.me(signal)
    return { session: s, me }
  }

  async function adopt(session, me, source) {
    saveAccount({
      userId: me.userId,
      nickname: me.nickname,
      cookie: session.cookie,
      roles: me.roles,
      creatorStage: me.creatorStage,
    })
    sessions.set(String(me.userId), session)
    return {
      type: 'success',
      key: String(me.userId),
      accountId: String(me.userId),
      metadata: {
        email: me.nickname || `user-${me.userId}`,
        uid: me.userId,
        roles: me.roles,
        creator: me.creatorStage,
        source,
      },
    }
  }

  return {
    // ------------------------------------------------------------ 供应商与模型
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= buildProvider(buildModels())
    },

    // ---------------------------------------------------------------- 登录
    auth: {
      provider: PROVIDER,
      icon,
      // 站点对并发敏感（同一账号并发对话会排队），且每轮扣积分
      maxConcurrency: 1,

      methods: [
        // ① 粘贴 Cookie —— 不依赖浏览器，所有平台都能用
        {
          type: 'api',
          label: '粘贴游点灵 Cookie',
          placeholder: 'jwt_token=...; qlogin_uid=...',
          prompts: [{
            type: 'password',
            key: 'cookie',
            message: '游点灵 Cookie（不要用 document.cookie，里面没有 jwt_token）',
            placeholder: 'DevTools → Network → 任一 /api 请求 → 请求头 → Cookie，整段复制',
            validate: (value) => {
              try {
                normalizeCookie(value)
                return undefined
              } catch (error) {
                return error.message
              }
            },
          }],

          async authorize(inputs, { signal } = {}) {
            let cookie
            try { cookie = normalizeCookie(inputs?.cookie ?? '').cookie }
            catch (error) { return { type: 'failed', error: String(error.message).slice(0, 500) } }

            try {
              const { session, me } = await verify(cookie, signal)
              return await adopt(session, me, 'cookie')
            } catch (error) {
              return { type: 'failed', error: `Cookie 校验失败：${String(error?.message || error).slice(0, 460)}` }
            }
          },
        },

        // ② 开浏览器登录 —— 插件起一个独立调试实例，你登完自动抓
        {
          type: 'api',
          keyless: true,
          label: '用浏览器登录游点灵（自动抓取）',
          placeholder: '插件开一个窗口，你登录后自动完成',

          async authorize(_inputs, { signal } = {}) {
            let launched
            try { launched = await launchDebugBrowser() }
            catch (error) { return { type: 'failed', error: String(error?.message || error).slice(0, 480) } }

            let pairs
            try {
              const deadline = Date.now() + 5 * 60_000
              while (Date.now() < deadline) {
                signal?.throwIfAborted()
                try {
                  const found = await cookiesFromDebugPort('craft.qq.com', launched.port)
                  // 关键键齐了才算登录成功
                  if (found?.cookies?.some((c) => c.name === 'jwt_token')) {
                    pairs = found.cookies
                    break
                  }
                } catch { /* 还没登录，继续等 */ }
                await new Promise((r) => setTimeout(r, 2_000))
              }
            } finally {
              await launched.close()
            }

            if (!pairs?.length) {
              return {
                type: 'failed',
                error: '等了 5 分钟没检测到登录（窗口已关闭）。可以重试，或改用「粘贴游点灵 Cookie」。',
              }
            }

            const cookie = cookieHeaderFrom(pairs)
            try {
              const { session, me } = await verify(cookie, signal)
              return await adopt(session, me, 'browser-login')
            } catch (error) {
              return { type: 'failed', error: `读到的 Cookie 校验失败：${String(error?.message || error).slice(0, 420)}` }
            }
          },
        },
      ],

      async loader(getAuth) {
        return {
          baseURL: `${BASE}/v1`,
          apiKey: 'craft-cookie',
          async fetch(input_, init) {
            const session = sessionFromAuth(await getAuth())
            return chat(session, input_, init)
          },
        }
      },

      // ------------------------------------------------------------ 额度
      async usage(getAuth) {
        let session
        try {
          session = sessionFromAuth(await getAuth())
        } catch (error) {
          return { error: String(error?.message || error).slice(0, 300), windows: [], ...(error?.signIn ? { signIn: error.signIn } : {}) }
        }

        try {
          const data = await session.json('/api/ms/points/balance')
          const b = data?.data ?? {}
          return normalizeQuota(b, session.nickname, b.expiring ?? [])
        } catch (error) {
          if (error?.signIn) {
            return { error: error.message, windows: [], signIn: error.signIn }
          }
          return { error: `积分暂时取不到：${String(error?.message || error).slice(0, 200)}`, windows: [] }
        }
      },
    },

    // ------------------------------------------------------- 每个账号的模型
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models
        try {
          const session = sessionFromAuth(auth)
          const catalog = await session.models(undefined, true)
          return magpieModels(catalog, PROVIDER)
        } catch (error) {
          log('warn', `获取游点灵模型失败：${error?.message}`)
          if (error?.signIn) throw error
          return provider.models
        }
      },
    },

    // ---------------------------------------------------------------- 工具
    tool: {
      balance: {
        description: '查看游点灵账号的积分余额、今日消耗，以及每日登录赠送有没有到账。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_args, { auth } = {}) {
          const session = sessionFromAuth(auth)
          const data = await session.json('/api/ms/points/balance')
          return dailyStatus(data?.data ?? {}, session.nickname)
        },
      },
      daily_grant: {
        description:
          '游点灵的每日登录赠送积分（每天自动发，站点没有领取按钮）今天到账了没。' +
          '如果没到账，提示用户打开一次 craft.qq.com 让服务端认到当天活跃即可。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_args, { auth } = {}) {
          const session = sessionFromAuth(auth)
          const data = await session.json('/api/ms/points/balance')
          const s = dailyStatus(data?.data ?? {}, session.nickname)
          return {
            今日已领: s.今日已领,
            今日领取额: s.今日领取额,
            下个自然日可领: s.下个自然日可领,
            说明: s.说明,
            action: s.action,
            site: s.site,
          }
        },
      },
    },
  }
}

export const _internal = {
  PROVIDER,
  DEFAULT_MODEL,
  listAccounts,
  loadAccount,
  removeAccount,
  parseCookieHeader,
  CraftSession,
  BASE,
}
