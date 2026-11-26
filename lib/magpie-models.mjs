/**
 * magpie 的模型表格式（OpenCode v1 provider.models 结构）。
 *
 * 每个模型都要给出 api / limit / capabilities / cost 这几组字段，
 * 缺了 magpie 界面上会显示成未知能力，agent 侧也可能误判能否传图。
 *
 * 游点灵这套的特点：
 *  - 不按 token 计费，按「每轮扣积分」扣，所以 cost 一律 0，
 *    真实消耗放大在 usage.rate 上（免费档用 rate: 0）。
 *  - 上游不支持图片/工具调用，照实标 false —— 标 true 只会让错误推迟到
 *    发送后才发生，反而更难解释。
 */
import { PROVIDER, DEFAULT_CONTEXT, DEFAULT_OUTPUT } from './models.mjs'

export { PROVIDER }

export function magpieModels(catalog, providerId = PROVIDER) {
  return Object.fromEntries(
    catalog.map((m) => {
      const context = m.context ?? DEFAULT_CONTEXT
      const entry = {
        id: m.upstream ?? m.id,
        providerID: providerId,
        name: m.name ?? m.id,
        api: {
          id: m.upstream ?? m.id,
          url: 'https://craft.qq.com/v1',
          npm: '@ai-sdk/openai-compatible',
        },
        status: 'active',
        headers: {},
        options: {},
        // 按积分扣费，没有 token 单价
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context, output: m.output ?? DEFAULT_OUTPUT },
        capabilities: {
          temperature: false,
          // 上游是「游戏开发 Agent」，但我们只取它的对话正文，没有暴露推理档位
          reasoning: false,
          // 站点这套接口不接受图片输入（foldMessages 会把图片降级成占位文字）
          attachment: false,
          // 上游不转发 function calling
          toolcall: false,
          input: { text: true, image: false, audio: false, video: false, pdf: false },
          output: { text: true, image: false, audio: false, video: false, pdf: false },
          interleaved: false,
        },
        release_date: '',
        variants: {},
      }
      // magpie 的自定义字段：界面渲染成「0.02x」那种倍率徽章
      entry.rate = m.free ? 0 : undefined
      if (entry.rate === undefined) delete entry.rate
      return [entry.id, entry]
    }),
  )
}
