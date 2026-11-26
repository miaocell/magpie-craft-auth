/** 打印站点当前返回的模型清单，用来核对插件菜单是否漏项。 */
import { CraftSession } from '../lib/session.mjs'

const s = new CraftSession({ cookie: process.env.C })
const data = await s.json('/api/chathost/model-options')
const models = data?.data?.platform_models ?? []
console.log('站点返回', models.length, '个模型：')
for (const m of models) {
  const tags = (m.tags ?? []).map((t) => t?.label).filter(Boolean)
  console.log(`  ${JSON.stringify(m.id)}  name=${m.name}  tags=${JSON.stringify(tags)}`)
}
console.log('默认模型:', data?.data?.default_platform_model)