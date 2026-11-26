/**
 * 常量与错误类型。
 *
 * 请求头这三条是能不能打通的关键：`X-Client-Version` / `X-Client-Type`
 * 缺任一个，站点就回 10001「请求参数错误」，跟 body 无关。当前网页版的
 * 版本号是 21，从 bundle 里读出来的（HEADERS 里 ES 请求头的 `X-Client-Version`）。
 */

export const BASE = 'https://craft.qq.com'
export const ORIGIN = 'https://craft.qq.com'

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36'

export const CLIENT_VERSION = '21'
export const CLIENT_TYPE = 'pc'

export const HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'X-Client-Version': CLIENT_VERSION,
  'X-Client-Type': CLIENT_TYPE,
  Origin: ORIGIN,
  Referer: `${ORIGIN}/chat`,
}

export class ProviderError extends Error {
  constructor(message, status = 502, code = 'provider_error', extra = {}) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.code = code
    Object.assign(this, extra)
  }
}
