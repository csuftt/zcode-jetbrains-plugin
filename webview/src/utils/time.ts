/**
 * 相对时间工具
 *
 * 规划文档第五节：刚刚 / N 分钟前 / N 小时前 / N 天前 / MM-DD
 * 时间戳统一按毫秒处理（ZCode 用的是毫秒级 epoch）
 */

import i18n from '@/i18n/config'

/** 把毫秒时间戳转成相对时间描述 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  if (!ts || ts <= 0) return ''

  const diff = now - ts
  if (diff < 0) return i18n.t('common.relativeTime.justNow') // 时间戳在未来（时钟偏差）

  const sec = Math.floor(diff / 1000)
  if (sec < 60) return i18n.t('common.relativeTime.justNow')

  const min = Math.floor(sec / 60)
  if (min < 60) return i18n.t('common.relativeTime.minutesAgo', { count: min })

  const hour = Math.floor(min / 60)
  if (hour < 24) return i18n.t('common.relativeTime.hoursAgo', { count: hour })

  const day = Math.floor(hour / 24)
  if (day < 7) return i18n.t('common.relativeTime.daysAgo', { count: day })

  // 超过 7 天：显示 MM-DD（跨年显示 YYYY-MM-DD）
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const nowYear = new Date(now).getFullYear()
  if (d.getFullYear() === nowYear) {
    return `${mm}-${dd}`
  }
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 耗时毫秒 → "X 秒" / "X 分 Y 秒"（人类可读时长，轮次/思考耗时共用；文案经 i18n） */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return i18n.t('utils.secondsShort', { count: sec })
  const m = Math.floor(sec / 60)
  return i18n.t('utils.minutesSeconds', { m, s: sec % 60 })
}

/**
 * 工具级耗时毫秒 → "X.X 秒" / "X 分 Y 秒"（单位统一为秒，含亚秒精度）
 * 工具调用常为亚秒级（Read/Edit 等），沿用 formatDuration 会全部显示"0 秒"
 */
export function formatToolDuration(ms: number): string {
  if (ms < 60000) return i18n.t('utils.secondsShort', { count: (Math.max(0, ms) / 1000).toFixed(1) })
  return formatDuration(ms)
}

/** 字节数 → "45.2 KB" / "1.2 MB"（1024 进制，保留 1 位小数；cc-gui 历史列表同款） */
export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KB'
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** 计时器描述：已耗时秒数 → "X 秒" / "X 分 Y 秒"（规划文档第四节 WaitingIndicator） */
export function elapsedDesc(startMs: number, now: number = Date.now()): string {
  return formatDuration(now - startMs)
}

/** 时间戳转 HH:MM（消息时间戳显示） */
export function clockTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
