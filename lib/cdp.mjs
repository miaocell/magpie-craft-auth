/**
 * 通过浏览器远程调试端口读站点的 Cookie。
 *
 * 为什么不用文件：浏览器运行时用独占锁占住 Cookies 数据库，文件级复制
 * （copyFile / robocopy / esentutl）一律 EBUSY，VSS 快照又要管理员。
 * 而浏览器自己开着调试端口时可以直接问它要 Cookie——绕开锁的问题。
 *
 * 两条用法：
 *  - cookiesFromDebugPort(domain, port)：读一个**已经在跑**的调试实例
 *  - launchDebugBrowser()：插件自己起一个隔离实例，用户登完再读
 *
 * Network.getCookies 是 page 级命令，必须先挂到一个 page target 上，
 * 只拿浏览器级 webSocketDebuggerUrl 会报 "not allowed"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const DEFAULT_PORTS = [9222, 9223, 9224, 9225, 9226]

export async function findDebugPorts(ports = DEFAULT_PORTS) {
  const found = []
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_200),
      })
      if (!res.ok) continue
      const info = await res.json()
      if (info?.webSocketDebuggerUrl) found.push({ port, info })
    } catch { /* 这个端口没开 */ }
  }
  return found
}

/** 极简 CDP 会话：只用到 Network.getCookies */
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let nextId = 1

    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      reject(new Error('连浏览器调试端口超时。'))
    }, 8_000)

    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        send(method, params) {
          const id = nextId++
          return new Promise((resolveCall, rejectCall) => {
            pending.set(id, { resolve: resolveCall, reject: rejectCall })
            socket.send(JSON.stringify({ id, method, params }))
            setTimeout(() => {
              if (!pending.has(id)) return
              pending.delete(id)
              rejectCall(new Error(`${method} 超时。`))
            }, 10_000)
          })
        },
        close() { try { socket.close() } catch { /* ignore */ } },
      })
    })

    socket.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      const slot = msg.id ? pending.get(msg.id) : undefined
      if (!slot) return
      pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(msg.error.message || 'CDP 调用失败。'))
      else slot.resolve(msg.result)
    })

    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('连不上浏览器调试端口。'))
    })
  })
}

/** 在给定浏览器上读某个域的全部 Cookie（含 HttpOnly） */
export async function readViaDebugPort(debugUrl, domain, httpBase) {
  let pageUrl = debugUrl
  if (httpBase) {
    try {
      const list = await fetch(`${httpBase}/json/list`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.json())
      const page = Array.isArray(list)
        ? list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        : undefined
      if (page) pageUrl = page.webSocketDebuggerUrl
    } catch { /* 用浏览器级连接兜底 */ }
  }

  const session = await connect(pageUrl)
  try {
    const result = await session.send('Network.getCookies', {
      urls: [`https://${domain}/`, ...(domain.split('.').length > 2 ? [] : [`https://www.${domain}/`])],
    })
    const list = Array.isArray(result?.cookies) ? result.cookies : []
    // 只要属于这个域的
    const mine = list.filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '')
      return d === domain || domain.endsWith('.' + d)
    })
    if (!mine.length) throw new Error(`浏览器里没有 ${domain} 的 Cookie，请先在该浏览器登录。`)
    return mine.map((c) => ({
      name: c.name,
      value: c.value,
      domain: String(c.domain || domain).replace(/^\./, ''),
      path: c.path || '/',
      expires: Math.floor(Number(c.expires) || 0),
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
    }))
  } finally {
    session.close()
  }
}

/** 一步到位：找端口 → 读 Cookie。给了 port 就只试那一个 */
export async function cookiesFromDebugPort(domain, port) {
  const targets = await findDebugPorts(port ? [port] : DEFAULT_PORTS)
  if (!targets.length) {
    throw new Error('没找到开着调试端口的浏览器。可以用「用浏览器登录」这个方式——插件会自动开一个窗口。')
  }
  const errors = []
  for (const t of targets) {
    try {
      const cookies = await readViaDebugPort(
        t.info.webSocketDebuggerUrl,
        domain,
        `http://127.0.0.1:${t.port}`,
      )
      return { cookies, port: t.port, browser: t.info.Browser || '' }
    } catch (error) {
      errors.push(`端口 ${t.port}: ${String(error?.message || error).slice(0, 120)}`)
    }
  }
  throw new Error(errors.join('；') || `调试端口读不到 ${domain} 的 Cookie。`)
}

/** 各平台浏览器可执行文件候选 */
export function browserCandidates() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || ''
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files'
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    return [
      { name: 'Edge', path: `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe` },
      { name: 'Edge', path: `${pf}\\Microsoft\\Edge\\Application\\msedge.exe` },
      { name: 'Chrome', path: `${pf}\\Google\\Chrome\\Application\\chrome.exe` },
      { name: 'Chrome', path: `${pf86}\\Google\\Chrome\\Application\\chrome.exe` },
      { name: 'Chrome', path: `${local}\\Google\\Chrome\\Application\\chrome.exe` },
    ]
  }
  if (process.platform === 'darwin') {
    return [
      { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    ]
  }
  return [
    { name: 'Chrome', path: '/usr/bin/google-chrome' },
    { name: 'Chromium', path: '/usr/bin/chromium' },
    { name: 'Chromium', path: '/usr/bin/chromium-browser' },
  ]
}

function pickPort() {
  return DEFAULT_PORTS[Math.floor(Math.random() * DEFAULT_PORTS.length)]
}

/**
 * 起一个隔离的调试实例让用户登录。
 *
 * 用临时 profile，不碰用户日常配置；登录完成后由调用方 close()，
 * 临时目录一并删掉——Cookie 已经进保管库了，没必要留着。
 */
export async function launchDebugBrowser(targetUrl = 'https://craft.qq.com/chat') {
  const candidates = browserCandidates().filter((c) => {
    try { return fs.existsSync(c.path) } catch { return false }
  })
  if (!candidates.length) {
    throw new Error('没找到可用的 Chrome / Edge。请改用「粘贴游点灵 Cookie」。')
  }

  const browser = candidates[0]
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-login-'))
  const port = pickPort()

  const child = spawn(browser.path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    targetUrl,
  ], { detached: false, stdio: 'ignore' })

  // 等调试端口可用
  const deadline = Date.now() + 25_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) })
      if (res.ok) { ready = true; break }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!ready) {
    try { child.kill() } catch { /* ignore */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw new Error(`启动了 ${browser.name} 但调试端口 ${port} 没起来，可能被安全软件拦了。`)
  }

  return {
    port,
    name: browser.name,
    async close() {
      try { child.kill() } catch { /* ignore */ }
      // 给进程一点退出时间再删目录，否则文件被占用
      await new Promise((r) => setTimeout(r, 1_200))
      try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}
