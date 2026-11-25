/**
 * 模型清单按 provider 分组（ModelSelect 主下拉与内置子代理模型下拉共用）
 *
 * 保持清单原有顺序；组标题由调用方取组内首项的 providerName（缺省回退 providerId）。
 */
import type { ModelOption } from '@/types/messages'

export function groupModelsByProvider(models: ModelOption[]): Array<[providerId: string, items: ModelOption[]]> {
  const map = new Map<string, ModelOption[]>()
  for (const m of models) {
    const list = map.get(m.providerId) ?? []
    list.push(m)
    map.set(m.providerId, list)
  }
  return [...map.entries()]
}
