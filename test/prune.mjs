/**
 * 批量清理账号里堆积的项目。
 *
 * 插件正常版本会在每轮对话结束后自己删会话，所以这里只是兜底：
 * 历史版本（0.1.2 及以前）只建不删，跑几十轮就会撞 30006 项目数上限。
 *
 * 用法：
 *   node test/prune.mjs            # 只统计，不删
 *   node test/prune.mjs --delete   # 真的删
 *   node test/prune.mjs --keep 5   # 保留最近 5 个
 *
 * 只删 `unpublished` + `planning` 状态的（对话刚建的会话都是这个状态），
 * 已发布的游戏不会动。
 */
import { loadAccount } from '../lib/vault.mjs'

const BASE = 'https://craft.qq.com'
const args = process.argv.slice(2)
const doDelete = args.includes('--delete')
const keepIdx = args.indexOf('--keep')
const keep = keepIdx >= 0 ? Number(args[keepIdx + 1]) || 0 : 0

const account = loadAccount('36790')
const H = {
  Cookie: account.cookie,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'X-Client-Version': '21',
  'X-Client-Type': 'pc',
  Accept: 'application/json, text/plain, */*',
  Origin: BASE,
  Referer: BASE + '/chat',
}

const listProjects = async () => {
  const res = await fetch(BASE + '/api/ms/projects/list/all', { headers: H })
  const data = await res.json()
  return data?.data?.projects ?? []
}

const projects = await listProjects()
// 列表按最近编辑倒序，保留前 N 个
const targets = projects.slice(keep)
const safe = targets.filter((p) => p.status === 'unpublished' && p.progress === 'planning')

console.log(`项目总数：${projects.length}`)
console.log(`保留：${Math.min(keep, projects.length)}  待清理（unpublished+planning）：${safe.length}`)
const skipped = targets.length - safe.length
if (skipped > 0) console.log(`跳过 ${skipped} 个已发布或有进度的项目`)

if (!doDelete) {
  for (const p of safe.slice(0, 10)) console.log('  ', p.id, '|', (p.title || '').replace(/\n/g, ' ').slice(0, 40))
  if (safe.length > 10) console.log(`   …… 还有 ${safe.length - 10} 个`)
  console.log('\n这是演习模式。加 --delete 才会真删。')
  process.exit(0)
}

let ok = 0
let fail = 0
for (const p of safe) {
  try {
    // 先删。DELETE 对处理中的会话也直接成功且很快；cancel 反而会一直等，
    // 只在删不掉时才补一刀。
    let res = await fetch(BASE + '/api/ms/conversations/' + p.id, {
      method: 'DELETE',
      headers: H,
      signal: AbortSignal.timeout(25_000),
    })
    let text = await res.text()
    if (!/"code"\s*:\s*0/.test(text)) {
      await fetch(BASE + '/api/chathost/cancel', {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: p.id, scene_id: p.id }),
        signal: AbortSignal.timeout(15_000),
      })
      res = await fetch(BASE + '/api/ms/conversations/' + p.id, {
        method: 'DELETE',
        headers: H,
        signal: AbortSignal.timeout(25_000),
      })
      text = await res.text()
    }
    if (/"code"\s*:\s*0/.test(text)) ok++
    else {
      fail++
      console.log('  失败', p.id, res.status, text.slice(0, 80))
    }
  } catch (e) {
    fail++
    console.log('  异常', p.id, e.name)
  }
  await new Promise((r) => setTimeout(r, 200))
}

console.log(`\n删除成功：${ok}  失败：${fail}`)
console.log('剩余项目：', (await listProjects()).length)