/**
 * 凭据保管库。
 *
 * 存的是 cookie 原文 + 账号显示信息。和豆包插件一样，落盘在插件自己的
 * data 目录，不碰任何客户端文件——客户端退出登录/卸载都不影响已导入的账号。
 *
 * 加密用 DPAPI（Windows）/ 明文兜底（其它平台），与 doubao 插件的做法一致：
 * DPAPI 的密文只有同一 Windows 用户能解，换机或换用户读不出来是预期行为。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const VAULT_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
  'magpie-craft-auth',
)
const VAULT_FILE = path.join(VAULT_DIR, 'accounts.json')
const SECRET_MARK = 'dpapi:'

function ensureDir() {
  try { fs.mkdirSync(VAULT_DIR, { recursive: true }) } catch { /* 已存在 */ }
}

/* ─────────────── Windows DPAPI ─────────────── */

function dpapiProtect(plain) {
  if (process.platform !== 'win32') return null
  try {
    const script = `
Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes($env:CRAFT_VAULT_PLAIN)
$out = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($out)
`
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, CRAFT_VAULT_PLAIN: plain },
      encoding: 'utf8',
      timeout: 15_000,
    }).trim()
  } catch {
    return null
  }
}

function dpapiUnprotect(b64) {
  if (process.platform !== 'win32') return null
  try {
    const script = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String($env:CRAFT_VAULT_CIPHER)
$out = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($out)
`
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, CRAFT_VAULT_CIPHER: b64 },
      encoding: 'utf8',
      timeout: 15_000,
    }).trim()
  } catch {
    return null
  }
}

/* ─────────────── 读写 ─────────────── */

export function loadVault() {
  ensureDir()
  try {
    const raw = fs.readFileSync(VAULT_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      version: parsed.version ?? 1,
      accounts: parsed.accounts ?? {},
    }
  } catch {
    return { version: 1, accounts: {} }
  }
}

function persist(vault) {
  ensureDir()
  // 先写临时文件再改名，避免断电/崩溃留下半截 JSON
  const tmp = `${VAULT_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2), 'utf8')
  fs.renameSync(tmp, VAULT_FILE)
}

function encodeSecret(cookie) {
  const enc = dpapiProtect(cookie)
  return enc ? SECRET_MARK + enc : cookie
}

function decodeSecret(stored) {
  if (typeof stored !== 'string') return ''
  if (!stored.startsWith(SECRET_MARK)) return stored
  return dpapiUnprotect(stored.slice(SECRET_MARK.length)) ?? ''
}

/**
 * 存一个账号。同一个 userId 会被覆盖（重登同一账号只留最新 cookie）。
 */
export function saveAccount({ userId, nickname, cookie, roles = [], creatorStage = null }) {
  const vault = loadVault()
  const id = String(userId ?? '').trim() || `anon-${Date.now()}`
  vault.accounts[id] = {
    userId: id,
    nickname: nickname || '',
    cookie: encodeSecret(cookie),
    roles,
    creatorStage,
    savedAt: new Date().toISOString(),
  }
  persist(vault)
  return vault.accounts[id]
}

export function loadAccount(userId) {
  const vault = loadVault()
  const acc = vault.accounts[String(userId)]
  if (!acc) return null
  return { ...acc, cookie: decodeSecret(acc.cookie) }
}

export function listAccounts() {
  const vault = loadVault()
  return Object.values(vault.accounts).map((acc) => ({
    userId: acc.userId,
    nickname: acc.nickname,
    savedAt: acc.savedAt,
    roles: acc.roles ?? [],
  }))
}

export function removeAccount(userId) {
  const vault = loadVault()
  const id = String(userId)
  if (!vault.accounts[id]) return false
  delete vault.accounts[id]
  persist(vault)
  return true
}

export const VAULT_PATH = VAULT_FILE
