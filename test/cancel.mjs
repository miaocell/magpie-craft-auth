/** 释放卡住的会话槽位。用法：node test/cancel.mjs <conversationId> [...] */
import { loadAccount } from '../lib/vault.mjs'

const BASE = 'https://craft.qq.com'
const a = loadAccount('36790')
const H = {
  Cookie: a.cookie,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'X-Client-Version': '21',
  'X-Client-Type': 'pc',
  Accept: 'application/json',
  Origin: BASE,
  Referer: BASE + '/chat',
  'Content-Type': 'application/json',
}

for (const cid of process.argv.slice(2)) {
  const r = await fetch(BASE + '/api/chathost/cancel', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ conversation_id: cid, scene_id: cid }),
  })
  console.log(cid, '->', r.status, (await r.text()).slice(0, 140))
}