/**
 * 额度换算 + 每日登录赠送状态。
 *
 * 上游：GET /api/ms/points/balance
 *   available_balance        可用积分
 *   frozen_balance           冻结
 *   chat_point_hold_amount   对话预扣
 *   login_grant_today        今日已发放的登录赠送（>0 表示今天已经拿过）
 *   next_login_grant         明天登录会发多少
 *   point_day                判定"今天"用的自然日（服务端时区）
 *   today_ai_chat_consumed   今日对话消耗
 *   today_aigc_consumed      今日 AIGC 消耗
 *   expiring[]               各批积分的过期时间和额度
 *
 * 关于"每天登录送积分"：站点**没有**领取接口。这笔积分是服务端按 point_day
 * 自动发放的，前端只是拿 login_grant_today 判断要不要弹一句「每日登录积分已到账」
 * （见网页里的 localStorage 提示逻辑）。所以插件能做的不是"代领"，而是
 * 读状态告诉用户今天领没领到、会不会补发——见 lib/daily.mjs。
 *
 * magpie 的 usage 形状是 { windows: [{ label, used, limit, resetAt? }] }，
 * 这里把「积分」当额度：used = 已消耗，limit = 总可得（余额+已消耗）。
 */

function fmtDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export function normalizeQuota(balance, nickname = '', expiring = []) {
  const b = balance ?? {}
  const avail = Number(b.available_balance ?? 0)
  const frozen = Number(b.frozen_balance ?? 0)
  const hold = Number(b.chat_point_hold_amount ?? 0)
  const chatUsed = Number(b.today_ai_chat_consumed ?? 0)
  const aigcUsed = Number(b.today_aigc_consumed ?? 0)
  const grantToday = Number(b.login_grant_today ?? 0)
  const nextGrant = Number(b.next_login_grant ?? 0)
  const total = Number(b.total_balance ?? avail + frozen)
  const day = b.point_day ?? ''

  const windows = [{
    label: nickname ? `${nickname} · 可用积分` : '可用积分',
    used: chatUsed + aigcUsed,
    limit: avail + chatUsed + aigcUsed,
    remaining: avail,
    // 积分是按批过期的，取最近一批的时间提示用户
    resetAt: fmtDate(expiring?.[0]?.expires_at),
    note: [
      `余额 ${avail}`,
      hold > 0 ? `预扣 ${hold}` : '',
      frozen > 0 ? `冻结 ${frozen}` : '',
      total !== avail + frozen ? `总计 ${total}` : '',
    ].filter(Boolean).join(' · '),
    breakdown: {
      今日对话消耗: chatUsed,
      今日AIGC消耗: aigcUsed,
      今日已赠: grantToday,
      下次登录赠送: nextGrant,
      ...(day ? { 统计日: day } : {}),
    },
  }]

  // 登录赠送单独一栏：这是这个平台唯一的免费补血方式，值得单独显示
  if (grantToday > 0 || nextGrant > 0) {
    windows.push({
      label: grantToday > 0 ? `每日登录赠送（${day || '今日'} 已到账）` : '每日登录赠送（今日未到账）',
      used: grantToday > 0 ? 1 : 0,
      limit: 1,
      remaining: grantToday > 0 ? 0 : 1,
      note: [
        grantToday > 0 ? `已发 ${grantToday}` : '今天还没发',
        nextGrant > 0 ? `下个自然日发 ${nextGrant}` : '',
        '站点没有领取接口，服务端按自然日自动发放',
      ].filter(Boolean).join(' · '),
    })
  }

  // 有明确过期批次的，单独列一组，方便看出"这些点不用就没了"
  if (Array.isArray(expiring) && expiring.length) {
    const soonest = expiring[0]
    windows.push({
      label: `即将过期（${String(soonest.expires_at ?? '').slice(0, 10)}）`,
      used: 0,
      limit: Number(soonest.amount ?? 0),
      remaining: Number(soonest.amount ?? 0),
      resetAt: fmtDate(soonest.expires_at),
      note: expiring
        .slice(0, 3)
        .map((e) => `${String(e.expires_at ?? '').slice(0, 10)} 过期 ${e.amount}`)
        .join(' · '),
    })
  }

  return { windows }
}
