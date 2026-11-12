/**
 * 额度历史派生（用量页「额度趋势」纯计算层）
 *
 * 输入是 Kotlin 侧 [QuotaHistoryStore] 落盘的采样（ts 升序的 quota/limit 快照），
 * 输出曲线点、每日消耗、指标汇总与「每 1% ≈ 多少 Token」换算。全部纯函数，
 * 组件只负责渲染（便于 vitest 覆盖边界：重置、跨夜摊分、换算商切换）。
 *
 * 周额度语义：
 *  - percentage = 窗口内"已用百分比"，周重置会让它从高位跳回 0；
 *  - 相邻采样正差值 = 这段区间的消耗，按时间比例摊到覆盖的每一天；
 *  - 负差值 = 重置（或换了 provider），记 0 消耗，绝不产生负数。
 */

import type { ModelUsageData, QuotaHistoryLimit, QuotaHistorySample } from '@/types/messages'

/** 曲线选中的额度窗口（周额度优先，回退 5 小时/唯一 Tokens 窗口）*/
export interface SelectedWindow {
  type?: string
  unit?: number
}

/** 曲线上的一个采样点（percentage 已夹到 0..100）*/
export interface WindowPoint {
  ts: number
  pct: number
  resetAt?: number
}

/** 某一天的消耗（pct 按时间比例摊分；coveredMs = 当天被采样区间覆盖的毫秒数）*/
export interface DailyStat {
  /** 本地日期 yyyy-MM-dd */
  date: string
  pct: number
  coveredMs: number
}

/** 区间汇总（指标卡）*/
export interface TrendSummary {
  /** 最新采样点的已用百分比（null=无点）*/
  currentPct: number | null
  /** 区间总消耗（正差值之和，重置不计负）*/
  consumedPct: number
  /** 日均消耗（按有采样的天数平均）*/
  avgDailyPct: number | null
  /** 有采样的天数 */
  coveredDays: number
}

/** 「每 1% ≈ 多少 Token」结果（tokensPerPct 为折算值，附参与计算的天数与原始量）*/
export interface TokenPerPct {
  tokensPerPct: number
  /** 参与计算的天数 */
  days: number
  /** 参与计算的总 token（已按覆盖比例折算）*/
  tokens: number
  /** 参与计算的总消耗百分比 */
  pct: number
}

/** 本地日期键 yyyy-MM-dd */
export function localDateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 最近 days 天的本地日期键（升序，含今天）*/
export function dateRangeKeys(days: number, now: number = Date.now()): string[] {
  const out: string[] = []
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  for (let i = days - 1; i >= 0; i--) {
    const x = new Date(d)
    x.setDate(x.getDate() - i)
    out.push(localDateKey(x.getTime()))
  }
  return out
}

/**
 * 取最近一段同一 provider 的采样。
 * 凭证回退链可能落到别家 key（providerId 变化），两段数据不能接成一条曲线——
 * 否则跳变会被误判成"重置"，消耗统计全乱。只保留末尾连续同 provider 的一段。
 */
export function latestProviderSegment(samples: QuotaHistorySample[]): QuotaHistorySample[] {
  if (samples.length === 0) return []
  const lastPid = samples[samples.length - 1].providerId
  let start = samples.length - 1
  while (start > 0 && samples[start - 1].providerId === lastPid) start--
  return samples.slice(start)
}

/** 从最近一次采样里选跟踪窗口：周额度（unit=6）> 5 小时（unit=3）> 第一个 Tokens 窗口 */
export function pickWindow(samples: QuotaHistorySample[]): SelectedWindow | null {
  if (samples.length === 0) return null
  const limits = samples[samples.length - 1].limits ?? []
  const tokenLimits = limits.filter(
    (l) => l.type === 'TOKENS_LIMIT' && typeof l.percentage === 'number',
  )
  if (tokenLimits.length === 0) return null
  const pick = tokenLimits.find((l) => l.unit === 6) ?? tokenLimits.find((l) => l.unit === 3) ?? tokenLimits[0]
  return { type: pick.type, unit: pick.unit }
}

/** 按选中窗口抽曲线点（保持原始采样密度；percentage 夹到 0..100）*/
export function extractWindow(samples: QuotaHistorySample[], sel: SelectedWindow): WindowPoint[] {
  const out: WindowPoint[] = []
  for (const s of samples) {
    const hit = (s.limits ?? []).find(
      (l: QuotaHistoryLimit) => l.type === sel.type && l.unit === sel.unit && typeof l.percentage === 'number',
    )
    if (!hit || typeof hit.percentage !== 'number' || !Number.isFinite(hit.percentage)) continue
    out.push({
      ts: s.ts,
      pct: Math.min(100, Math.max(0, hit.percentage)),
      ...(typeof hit.nextResetTime === 'number' ? { resetAt: hit.nextResetTime } : {}),
    })
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

/**
 * 降采样（曲线渲染用）：每个时间桶只留最后一个点。
 * 7 天用 15 分钟桶（≈672 点），30 天用 1 小时桶（≈720 点）。
 */
export function downsample(points: WindowPoint[], bucketMs: number): WindowPoint[] {
  if (points.length === 0 || bucketMs <= 0) return points.slice()
  const out: WindowPoint[] = []
  let bucket = Number.NaN
  for (const p of points) {
    const b = Math.floor(p.ts / bucketMs)
    if (b !== bucket) {
      bucket = b
      out.push(p)
    } else {
      out[out.length - 1] = p
    }
  }
  return out
}

/** 曲线范围对应的降采样桶宽 */
export function bucketForRange(days: number): number {
  return days > 7 ? 60 * 60 * 1000 : 15 * 60 * 1000
}

/** 本地次日 0 点时间戳 */
function nextLocalMidnight(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime()
}

function ensureDay(map: Map<string, DailyStat>, date: string): DailyStat {
  let v = map.get(date)
  if (!v) {
    v = { date, pct: 0, coveredMs: 0 }
    map.set(date, v)
  }
  return v
}

/**
 * 每日消耗：相邻采样正差值按「与每天的时间重叠比例」摊分。
 *
 * 这样跨夜/IDE 关机几天的空档不会把一大段增量全砸在恢复采样那一天；
 * 负差值（周重置）记 0；单区间增量超过 100（异常数据）按 100 封顶。
 */
export function dailyStats(points: WindowPoint[]): DailyStat[] {
  const map = new Map<string, DailyStat>()
  if (points.length === 0) return []
  // 有采样点的日期都建一条（即使当天消耗为 0，柱状图也要显示这天被覆盖）
  for (const p of points) ensureDay(map, localDateKey(p.ts))

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const span = cur.ts - prev.ts
    if (span <= 0) continue
    const delta = Math.min(100, cur.pct - prev.pct)
    let t = prev.ts
    while (t < cur.ts) {
      const dayEnd = nextLocalMidnight(t)
      const segEnd = Math.min(cur.ts, dayEnd)
      const weight = (segEnd - t) / span
      const day = ensureDay(map, localDateKey(t))
      // 负差值=重置：仅记覆盖时间，不计消耗
      if (delta > 0) day.pct += delta * weight
      day.coveredMs += segEnd - t
      if (segEnd <= t) break
      t = segEnd
    }
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** 区间汇总（当前已用 / 总消耗 / 日均 / 覆盖天数）*/
export function summarize(points: WindowPoint[], daily: DailyStat[]): TrendSummary {
  const currentPct = points.length > 0 ? points[points.length - 1].pct : null
  const consumedPct = daily.reduce((n, d) => n + d.pct, 0)
  const coveredDays = daily.filter((d) => d.coveredMs > 0).length
  return {
    currentPct,
    consumedPct,
    avgDailyPct: coveredDays > 0 ? consumedPct / coveredDays : null,
    coveredDays,
  }
}

/**
 * 「每 1% 额度 ≈ 多少 Token」：服务端 model-usage（账号口径）的每日 token
 * 与同一天的消耗百分比相除累计。
 *
 * 覆盖不全的天（IDE 中途才开、当天还没过完）按采样时长占「当天已流逝时长」的
 * 比例折算 token，避免"部分采样 vs 全天 token"把比值抬高；当天只流逝到当前时刻，
 * 分母用已流逝而不是 24h（否则今天会被系统性低估）。总消耗不足 1% 时不给结果
 * （整数百分比舍入误差会被放大成离谱数字）。
 */
export function tokenPerPercent(
  daily: DailyStat[],
  modelUsage: ModelUsageData | null | undefined,
  now: number = Date.now(),
): TokenPerPct | null {
  if (!modelUsage || !Array.isArray(modelUsage.x_time) || modelUsage.x_time.length === 0) return null
  const models = modelUsage.modelDataList ?? []
  if (models.length === 0) return null

  // 按日聚合 token（x_time 为 'yyyy-MM-dd' 或 'yyyy-MM-dd HH:mm'，前 10 位即日期）
  const tokensByDay = new Map<string, number>()
  modelUsage.x_time.forEach((label, i) => {
    const key = (label ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return
    let sum = 0
    for (const m of models) sum += m.tokensUsage?.[i] ?? 0
    if (sum > 0) tokensByDay.set(key, (tokensByDay.get(key) ?? 0) + sum)
  })

  let tokens = 0
  let pct = 0
  let days = 0
  for (const d of daily) {
    if (d.pct <= 0) continue
    const dayTokens = tokensByDay.get(d.date)
    if (!dayTokens || dayTokens <= 0) continue
    const dayStart = localDayStart(d.date)
    if (dayStart == null) continue
    const elapsed = Math.min(now, nextLocalMidnight(dayStart)) - dayStart
    if (elapsed <= 0) continue
    const coverage = Math.min(1, Math.max(0, d.coveredMs / elapsed))
    if (coverage <= 0) continue
    tokens += dayTokens * coverage
    pct += d.pct
    days++
  }
  if (days === 0 || pct < 1 || tokens <= 0) return null
  return { tokensPerPct: tokens / pct, days, tokens, pct }
}

/** 本地日期键 → 当天 0 点时间戳（非法键返回 null）*/
function localDayStart(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime()
  return Number.isNaN(ts) ? null : ts
}