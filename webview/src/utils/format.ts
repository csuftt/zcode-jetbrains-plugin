/**
 * 用量/额度相关的数字与文案格式化（ContextRing / QuotaView / UsageView / LineChart 共用）
 *
 * 规则对齐 glm-plan-usage-idea（智谱官方页源码同款）：
 *   - fmtTokens：上下文/额度数值（万/k）
 *   - fmtBig：汇总表数值（亿/万/原数）
 *   - compact：图表 Y 轴刻度缩写
 */

import i18n from '@/i18n/config'
import type { QuotaLimit } from '@/types/messages'

/** 按当前语言紧凑缩写数值（zh/ja/ko → 万/億/만，en → K/M/B；每次调用求值，随语言切换）*/
function compactNumber(n: number, maxFractionDigits: number): string {
  try {
    return new Intl.NumberFormat(i18n.resolvedLanguage ?? 'zh', {
      notation: 'compact',
      maximumFractionDigits: maxFractionDigits,
    }).format(n)
  } catch {
    return String(n)
  }
}

/** 格式化为万/k（上下文用量、额度已用/总量；万/亿缩写经 Intl 按语言本地化）*/
export function fmtTokens(n?: number | null): string {
  if (n == null) return '-'
  if (n >= 10000) return compactNumber(n, 1)
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** 格式化为亿/万/原数（汇总表「总 Token M」用，对齐 glm fmt；缩写经 Intl 按语言本地化）*/
export function fmtBig(n?: number | null): string {
  if (n == null) return '-'
  if (n >= 1e8) return compactNumber(n, 2)
  if (n >= 1e4) return compactNumber(n, 1)
  return n.toFixed(0)
}

/** Y 轴刻度缩写（对齐 glm LineChart compact；万/亿缩写经 Intl 按语言本地化）*/
export function compact(n: number): string {
  if (n >= 1e3) return compactNumber(n, 1)
  if (n >= 1) return String(Math.round(n))
  return '0'
}

/** unit/type → 标题（挖自智谱官方页源码，glm-plan-usage-idea 同款；文案经 i18n）*/
export function limitTitle(limit: QuotaLimit): string {
  if (limit.type === 'TIME_LIMIT') {
    return limit.unit === 5 ? i18n.t('utils.format.mcpMonthlyLimit') : i18n.t('utils.format.cycleLimit')
  }
  if (limit.unit === 3) return i18n.t('utils.format.per5HoursLimit')
  if (limit.unit === 6) return i18n.t('utils.format.weeklyLimit')
  return i18n.t('utils.format.usageLimit')
}

/** 单位文案（TIME_LIMIT → 次，TOKENS_LIMIT → Tokens）*/
export function limitUnitText(limit: QuotaLimit): string {
  return limit.type === 'TIME_LIMIT' ? i18n.t('utils.format.timesUnit') : 'Tokens'
}

/** 格式化重置时间（毫秒时间戳 → MM-dd HH:mm）*/
export function fmtResetTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

/** 格式化刷新时间（毫秒时间戳 → HH:mm:ss）*/
export function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** X 轴标签格式化（对齐 glm parseXTime）：daily → MM-DD，hourly → HH:mm */
export function formatXLabel(t: string, granularity?: string): string {
  if (granularity === 'daily') return t.slice(5) // MM-DD
  const sp = t.lastIndexOf(' ')
  return sp >= 0 ? t.slice(sp + 1) : t // HH:mm
}
