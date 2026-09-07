/**
 * 引导（steer）消息标识的持久化
 *
 * 被 steer 注入的 user 消息（drainedInputs 带服务端正式 messageId）记录在案，
 * 气泡渲染「⚡引导」徽标（对齐定时消息「定时执行」徽标语义）。id 是服务端
 * 真身，轮末重拉/历史重开保持稳定，kv 持久化即可跨重拉、跨重启。
 * 乐观兜底 id（steer_ 前缀，drainedInputs 缺失时）重拉后换成真身 id，徽标
 * 随之丢失——罕见路径，接受。
 */
import { getPersisted, setPersisted } from './persist'

const KEY = 'zcode.steer.markers'

export function readSteerMarkers(): string[] {
  const raw = getPersisted(KEY)
  if (!raw) return []
  try {
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function addSteerMarkers(ids: string[]): void {
  if (ids.length === 0) return
  const cur = readSteerMarkers()
  const next = [...cur]
  for (const id of ids) if (!next.includes(id)) next.push(id)
  setPersisted(KEY, JSON.stringify(next))
}
