/**
 * 模型目录与 magpie 模型定义。
 *
 * 站点返回的 platform_models 只有 id / name / tags，没有上下文窗口、
 * 没有能力声明。所以这里给每个模型挂上一份保守的能力声明：
 * 只有 auto 之外的四项是账号菜单里真实存在的，其余按「通用对话模型」处理。
 *
 * 注意 `lgb-auto`：它是"自动分配模型"，服务端按负载挑一个（实测会选
 * deepseek-v4.1-flash）。想指定具体模型就明写 id。
 */

import { ProviderError } from './const.mjs'

export const PROVIDER = 'craft'

/** 站点没给上下文窗口，按 DeepSeek/GLM 这一档的通用值给，宁小勿大 */
export const DEFAULT_CONTEXT = 128_000
export const DEFAULT_OUTPUT = 8_192

/**
 * 已知模型的补充信息。键是站点 model id。
 * 站点新增模型时不在表里也没关系，会走下面的 fallback。
 *
 * 注意这里只是「补充信息」而非「模型清单」——真实清单每次登录后从站点
 * /api/chathost/model-options 现拉（见 index.mjs 的 provider.models）。
 * 站点会上下线模型：GLM-5.4 曾在菜单里，2026-11-26 已下线，这里留着它是
 * 为了万一站点恢复时能直接显示正确的中文名。
 */
const KNOWN = {
  'lgb-auto': {
    label: 'Auto（自动分配模型）',
    hint: '由游点灵按负载自动挑选后端模型，实测会选 deepseek-v4.1-flash',
  },
  'deepseek-v4.1-flash': {
    label: 'DeepSeek V4.1 Flash',
    hint: '快速档，积分消耗最低',
  },
  'Hy4-preview': {
    label: 'Hy4 Preview',
    hint: '腾讯混元预览版，站点标「限时免费」',
    free: true,
  },
  Hy4: {
    label: 'Hy4',
    hint: '腾讯混元正式版，站点标「限时免费」',
    free: true,
  },
  'GLM-5.4': {
    label: 'GLM 5.4',
    hint: '智谱 GLM，站点标「限时免费」',
    free: true,
  },
}

/** 站点的 model id 里有大小写和点号，magpie 的模型 key 用原 id 最省心 */
function modelKey(id) {
  return id
}

/**
 * magpie 模型定义的本体（provider 里的 entry）。
 *
 * 游点灵不按 token 计费，按「每轮扣积分」扣，所以 cost 一律 0；
 * 免费档用 rate: 0 表示不计费。
 */
/**
 * magpie 模型定义的本体（provider 里的 entry）。
 *
 * 注意返回的是**按模型 id 索引的对象**，不是数组 —— provider.models 是
 * `{ [id]: entry }` 的形状，传数组进去 key 会变成本标 "0"/"1"，界面和
 * 请求里就选不到具体模型了。
 *
 * 游点灵不按 token 计费，按「每轮扣积分」扣，所以 cost 一律 0；
 * 免费档用 rate: 0 表示不计费。
 */
export function buildModels(discovered) {
  const list = Array.isArray(discovered) && discovered.length
    ? discovered
    : Object.keys(KNOWN).map((id) => ({ id, name: id, free: KNOWN[id].free ?? false, tags: [] }))

  return Object.fromEntries(list.map((m) => {
    const known = KNOWN[m.id] ?? {}
    const free = m.free ?? known.free ?? false
    const id = modelKey(m.id)
    return [id, {
      id,
      name: known.label ?? m.name ?? m.id,
      // 站点 id 原样保留，selectModel 时要用
      upstream: m.id,
      attachment: false,
      reasoning: false,
      tool_call: false,
      temperature: true,
      context: DEFAULT_CONTEXT,
      output: DEFAULT_OUTPUT,
      ...(free ? { cost: { input: 0, output: 0 } } : {}),
      description: known.hint ?? (free ? '站点标注限时免费' : '游点灵平台模型'),
    }]
  }))
}

export function buildProvider(models) {
  return {
    id: PROVIDER,
    name: '游点灵',
    // 站点不是 OpenAI 兼容，实际转发在 auth.loader 的 fetch 里做
    npm: '@ai-sdk/openai-compatible',
    api: 'https://craft.qq.com/v1',
    doc: 'https://craft.qq.com/chat',
    models: models ?? buildModels(),
  }
}

/**
 * 从请求里的 model 字段找出要用的上游 model id。
 * magpie 可能传 "craft/Hy4" 这种带前缀的形式，也要认。
 */
export function selectModel(catalog, wanted) {
  const raw = String(wanted ?? '').trim()
  const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  if (!bare) return null

  const hit = catalog.find((m) => m.upstream === bare || m.id === bare)
  return hit ? hit.upstream : null
}

export const DEFAULT_MODEL = 'lgb-auto'
