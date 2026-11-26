/**
 * Cookie 解析与校验。
 *
 * 站点登录态在 `jwt_token` 这个 HttpOnly cookie 里，JS 读不到，
 * 所以"粘贴 Cookie"这条路径要求用户从 DevTools 的请求头里整段复制。
 * 这里只做三件事：解析、检查关键键、生成可直接喂给 fetch 的字符串。
 */

const REQUIRED_ANY = ['jwt_token']

/** 把 "a=1; b=2" 或带 Cookie: 前缀的文本解析成键值对 */
export function parseCookieHeader(raw) {
  let text = String(raw ?? '').trim()
  if (!text) return []
  // 用户可能直接复制了 "Cookie: xxx" 整行
  text = text.replace(/^cookie\s*:\s*/i, '')
  return text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq < 0) return { name: part, value: '' }
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() }
    })
    .filter((c) => c.name.length > 0)
}

export function cookieHeaderFrom(pairs) {
  return pairs.map((c) => `${c.name}=${c.value}`).join('; ')
}

/** 关键键是否齐全。缺 jwt_token 时上游一定 10104。 */
export function missingKeys(pairs) {
  const names = new Set(pairs.map((c) => c.name))
  return REQUIRED_ANY.filter((k) => !names.has(k))
}

/**
 * 校验并规范化。
 * 返回 { cookie } 或抛错（错误信息直接给用户看）。
 */
export function normalizeCookie(raw) {
  const pairs = parseCookieHeader(raw)
  if (!pairs.length) throw new Error('Cookie 是空的。请从开发者工具的请求头里整段复制。')

  const missing = missingKeys(pairs)
  if (missing.length) {
    throw new Error(
      `Cookie 里缺少 ${missing.join('、')}。这个键是 HttpOnly 的，` +
      '必须在 DevTools → Network → 任一 /api 请求 → 请求头 → Cookie 里整段复制，' +
      '不能用 document.cookie。',
    )
  }
  return { cookie: cookieHeaderFrom(pairs) }
}

/** 从 cookie 里尽量读出账号标识（仅用于展示，不参与鉴权） */
export function hintsFromCookie(pairs) {
  const get = (name) => pairs.find((c) => c.name === name)?.value ?? ''
  return {
    qqUid: get('qlogin_uid'),
    pacUid: get('pac_uid'),
  }
}
