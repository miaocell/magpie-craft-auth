/**
 * 「每天登录送积分」这件事的读取与判断。
 *
 * 先说清楚机制：站点**没有**签到/领取接口。那笔积分是服务端按 point_day
 * （自然日，北京时间）自动发放的，网页前端的做法是：拿到 balance 后，若
 * `login_grant_today > 0` 且这个 (userId, point_day, grantToday) 组合没在
 * localStorage 里提示过，就弹一句「每日登录积分已到账」。
 *
 * 也就是说：
 *  - 领取 = 打开站点（或至少带着有效 cookie 发一次请求），让服务端认到
 *    这个自然日有活跃 —— 这正是"每天登录就行"的来源；
 *  - 不能代领，也没有幂等按钮可按，只能读状态；
 *  - 同一天重复登录不会重复发（login_grant_today 已经 > 0 就不再加）。
 *
 * 插件这边能做的：
 *  1. usage 里把这笔单独列出来（见 quota.mjs）；
 *  2. 提供 dailyStatus() 给 tool 用，判断"今天领没领到、要不要去网页醒一下"；
 *  3. 领到的积分会自动计入 available_balance，所以对话前不必额外动作。
 */

/** 今天是否已拿到登录赠送 */
export function isGrantedToday(balance) {
  return Number(balance?.login_grant_today ?? 0) > 0
}

/**
 * 组装一份人话状态。
 * @param {object} balance /api/ms/points/balance 的 data
 * @param {string} nickname
 */
export function dailyStatus(balance, nickname = '') {
  const b = balance ?? {}
  const granted = isGrantedToday(b)
  const day = b.point_day ?? ''
  const todayGrant = Number(b.login_grant_today ?? 0)
  const tomorrow = Number(b.next_login_grant ?? 0)
  const available = Number(b.available_balance ?? 0)
  const expiring = Array.isArray(b.expiring) ? b.expiring : []

  return {
    who: nickname || undefined,
    统计日: day || undefined,
    今日已领: granted,
    今日领取额: todayGrant,
    下个自然日可领: tomorrow,
    当前可用: available,
    即将过期: expiring.slice(0, 3).map((e) => ({
      日期: String(e.expires_at ?? '').slice(0, 10),
      额度: Number(e.amount ?? 0),
    })),
    说明: granted
      ? `今天（${day}）的 ${todayGrant} 积分已经到账，可用 ${available}。站点不会重复发，明天自然日再打开一次站点会自动再发 ${tomorrow}。`
      : `今天（${day || '今日'}）还没拿到登录赠送。打开一次 https://craft.qq.com/chat 让服务端认到这个自然日有活跃，之后 ${tomorrow} 积分会自动入账——站点没有领取按钮，纯自动发放。`,
    // 给 agent 的行动建议：点进网页只为了让服务端记到当天活跃
    action: granted ? 'none' : 'visit-site',
    site: 'https://craft.qq.com/chat',
  }
}