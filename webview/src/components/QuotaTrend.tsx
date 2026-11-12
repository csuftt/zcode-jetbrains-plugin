/**
 * 额度趋势（用量页「GLM 套餐用量」tab 区块）
 *
 * 数据源：Kotlin [QuotaHistoryStore] 落盘的额度采样（op=getQuotaHistory），
 * 每次成功查询额度顺手记一行；采样密度由 app 级 10 分钟定时器保证。
 *
 * 展示四块：
 *   1. 指标卡：当前已用 / 区间消耗 / 日均消耗 / 平均 1% ≈ Token
 *   2. 周额度已用百分比折线（LineChart 固定 0-100 轴）
 *   3. 每日消耗柱状图（重置不计负、跨天空档按时间摊分，见 utils/quotaHistory）
 *   4. 空态/加载态兜底
 *
 * 区间切换（近 7 天 / 近 30 天）只影响本区块，与下方「用量明细」的日期范围独立。
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import type { QuotaLimit } from '@/types/messages'
import { fmtBig, limitTitle } from '@/utils/format'
import {
  bucketForRange,
  dailyStats,
  dateRangeKeys,
  downsample,
  extractWindow,
  latestProviderSegment,
  localDateKey,
  pickWindow,
  summarize,
  tokenPerPercent,
} from '@/utils/quotaHistory'
import { LineChart } from './LineChart'
import '../styles/quota-trend.less'

/** 条件 className 拼接 */
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** 曲线 X 轴/浮层标签：yyyy-MM-dd HH:mm（LineChart hourly 口径）*/
function fmtAxisTime(ts: number): string {
  const d = new Date(ts)
  return `${localDateKey(ts)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const RANGE_OPTIONS = [7, 30] as const

export function QuotaTrend() {
  const { t } = useTranslation()
  const samples = useStore((s) => s.quotaHistory)
  const loading = useStore((s) => s.quotaHistoryLoading)
  const modelUsage = useStore((s) => s.modelUsage)
  const loadQuotaHistory = useStore((s) => s.loadQuotaHistory)
  const loadQuota = useStore((s) => s.loadQuota)
  const [days, setDays] = useState<number>(7)

  // 进页/切范围拉历史；区块常驻时每 5 分钟刷新一次（采样由 app 级定时器持续写入）
  useEffect(() => {
    loadQuotaHistory(days)
  }, [loadQuotaHistory, days])
  useEffect(() => {
    const timer = window.setInterval(() => loadQuotaHistory(days), 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [loadQuotaHistory, days])

  const seg = useMemo(() => latestProviderSegment(samples ?? []), [samples])
  const sel = useMemo(() => pickWindow(seg), [seg])
  const windowName = sel ? limitTitle({ type: sel.type, unit: sel.unit } as QuotaLimit) : ''

  const rangeStart = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - (days - 1))
    return d.getTime()
  }, [days])

  // 原始点用于统计（保留完整密度）；曲线再降采样控制点数
  const rawPoints = useMemo(
    () => (sel ? extractWindow(seg.filter((s) => s.ts >= rangeStart), sel) : []),
    [seg, sel, rangeStart],
  )
  const chartPoints = useMemo(() => downsample(rawPoints, bucketForRange(days)), [rawPoints, days])
  const daily = useMemo(() => dailyStats(rawPoints), [rawPoints])
  const summary = useMemo(() => summarize(rawPoints, daily), [rawPoints, daily])
  const perPct = useMemo(() => tokenPerPercent(daily, modelUsage), [daily, modelUsage])

  // 柱状图：按区间生成完整日期轴（无采样的天显示为 0）
  const barKeys = useMemo(() => dateRangeKeys(days), [days])
  const dailyMap = useMemo(() => new Map(daily.map((d) => [d.date, d.pct])), [daily])
  const maxDaily = useMemo(() => Math.max(1, ...daily.map((d) => d.pct)), [daily])
  const labelStep = Math.max(1, Math.ceil(barKeys.length / 10))

  const onRefresh = () => {
    loadQuota()
    // 采样在 getQuota 应答里由 Kotlin 落盘，历史读取稍后一拍（避免读到落盘前的旧快照）
    window.setTimeout(() => loadQuotaHistory(days), 1200)
  }

  // 首次加载（尚无数据）才占位；已有数据时刷新不闪
  if (samples == null) {
    return (
      <section className="usage-view__chart-section quota-trend">
        <div className="usage-view__loading">{t('usage.quota.loading')}</div>
      </section>
    )
  }

  return (
    <section className="usage-view__chart-section quota-trend">
      <div className="usage-view__chart-head">
        <span className="usage-view__chart-title">{t('usage.trend.title')}</span>
        <div className="usage-view__range-tabs">
          {RANGE_OPTIONS.map((d) => (
            <button
              key={d}
              className={cx('usage-view__range-tab', days === d && 'active')}
              onClick={() => setDays(d)}
            >
              {d === 7 ? t('usage.range.last7') : t('usage.range.last30')}
            </button>
          ))}
        </div>
        <button className="usage-view__icon-btn" onClick={onRefresh} title={t('usage.quota.refresh')}>
          <span className={cx('codicon codicon-refresh', loading && 'spin')} />
        </button>
      </div>

      {samples.length === 0 ? (
        <div className="usage-view__empty">{t('usage.trend.empty')}</div>
      ) : !sel ? (
        <div className="usage-view__empty">{t('usage.trend.noWindow')}</div>
      ) : rawPoints.length === 0 ? (
        <div className="usage-view__empty">{t('usage.trend.empty')}</div>
      ) : (
        <>
          <div className="usage-view__stat-grid">
            <div className="usage-view__stat">
              <span className="usage-view__stat-label">{t('usage.trend.current')}</span>
              <span className="usage-view__stat-value">
                {summary.currentPct != null ? `${Math.round(summary.currentPct)}%` : '—'}
              </span>
            </div>
            <div className="usage-view__stat" title={t('usage.trend.consumedHint')}>
              <span className="usage-view__stat-label">{t('usage.trend.consumed')}</span>
              <span className="usage-view__stat-value">{summary.consumedPct.toFixed(1)}%</span>
            </div>
            <div className="usage-view__stat">
              <span className="usage-view__stat-label">{t('usage.trend.dailyAvg')}</span>
              <span className="usage-view__stat-value">
                {summary.avgDailyPct != null ? `${summary.avgDailyPct.toFixed(1)}%` : '—'}
              </span>
            </div>
            {perPct && (
              <div className="usage-view__stat" title={t('usage.trend.tokenPerPctHint', {
                days: perPct.days,
                tokens: fmtBig(perPct.tokens),
                pct: perPct.pct.toFixed(1),
              })}>
                <span className="usage-view__stat-label">{t('usage.trend.tokenPerPct')}</span>
                <span className="usage-view__stat-value">{fmtBig(perPct.tokensPerPct)}</span>
              </div>
            )}
          </div>
          {!perPct && (
            <div className="quota-trend__hint">{t('usage.trend.tokenPerPctUnavailable')}</div>
          )}

          <div className="quota-trend__chart-head">
            <span className="quota-trend__chart-title">{t('usage.trend.curveTitle', { name: windowName })}</span>
            <span className="quota-trend__chart-sub">
              {t('usage.trend.coveredDays', { days: summary.coveredDays })}
            </span>
          </div>
          <LineChart
            series={[{ name: windowName, values: chartPoints.map((p) => p.pct) }]}
            xLabels={chartPoints.map((p) => fmtAxisTime(p.ts))}
            granularity="hourly"
            yMax={100}
            valueFormat={(v) => `${v.toFixed(0)}%`}
            hideTotal
          />

          <div className="quota-trend__chart-head">
            <span className="quota-trend__chart-title">{t('usage.trend.dailyTitle')}</span>
          </div>
          <div className="quota-trend__bars">
            {barKeys.map((key, i) => {
              const value = dailyMap.get(key) ?? 0
              const height = maxDaily > 0 ? (value / maxDaily) * 100 : 0
              const showLabel = i % labelStep === 0 || i === barKeys.length - 1
              return (
                <div
                  key={key}
                  className="quota-trend__bar-col"
                  title={t('usage.trend.barTip', { date: key, pct: value.toFixed(1) })}
                >
                  <div className="quota-trend__bar-track">
                    <div
                      className={cx('quota-trend__bar', value <= 0 && 'is-zero')}
                      style={{ height: `${height}%` }}
                    />
                  </div>
                  {barKeys.length <= 14 && value > 0 && (
                    <span className="quota-trend__bar-value">{value.toFixed(1)}%</span>
                  )}
                  <span className="quota-trend__bar-label">
                    {showLabel ? key.slice(5) : '\u00a0'}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}