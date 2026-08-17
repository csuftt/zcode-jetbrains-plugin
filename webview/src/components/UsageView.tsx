/**
 * 用量查询面板（设置页「用量查询」条目）
 *
 * 完整移植 glm-plan-usage-idea 的 GlmUsagePanel 布局：
 *   额度卡片 → 「用量明细」分隔 → 时间范围工具条 → 模型用量(曲线+表) → 工具用量(曲线+表)
 *
 * 数据：
 *   - 额度：getQuota（quota/limit，无参）
 *   - 模型曲线：getModelUsage（startTime/endTime）
 *   - 工具曲线：getToolUsage（startTime/endTime）
 *   token 沿用 config.json，无需配置（oauth 模式给出 usageError 提示）
 */

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import type { UsageRange } from '@/types/messages'
import { fmtBig, fmtTime } from '@/utils/format'
import { QuotaCards } from './QuotaCards'
import { LineChart } from './LineChart'
import type { ChartSeries } from './LineChart'
import '../styles/usage-view.less'

/** 条件 className 拼接 */
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** 本地日期 yyyy-MM-dd */
function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 用量明细表（模型/工具汇总）*/
function UsageTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (rows.length === 0) return null
  return (
    <table className="usage-table">
      <thead>
        <tr>
          {headers.map((h, i) => (
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri}>
            {r.map((c, ci) => (
              <td key={ci} className={ci === 0 ? 'usage-table__name' : 'usage-table__num'}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function UsageView() {
  const { t } = useTranslation()
  const quota = useStore((s) => s.quota)
  const quotaLoading = useStore((s) => s.quotaLoading)
  const quotaFetchedAt = useStore((s) => s.quotaFetchedAt)
  const usageError = useStore((s) => s.usageError)
  const modelUsage = useStore((s) => s.modelUsage)
  const toolUsage = useStore((s) => s.toolUsage)
  const usageRange = useStore((s) => s.usageRange)
  const customStart = useStore((s) => s.customStart)
  const customEnd = useStore((s) => s.customEnd)
  const loadQuota = useStore((s) => s.loadQuota)
  const setUsageRange = useStore((s) => s.setUsageRange)
  const setUsageDates = useStore((s) => s.setUsageDates)
  const loadUsageData = useStore((s) => s.loadUsageData)

  useEffect(() => {
    loadQuota()
    loadUsageData()
  }, [loadQuota, loadUsageData])

  // date input 范围（today-31 ~ today）
  const now = new Date()
  const todayISO = localISO(now)
  const minD = new Date(now)
  minD.setDate(minD.getDate() - 31)
  const minISO = localISO(minD)

  const onDateChange = (start: string, end: string) => {
    let s = start || todayISO
    let e = end || todayISO
    if (s > todayISO) s = todayISO
    if (s < minISO) s = minISO
    if (e > todayISO) e = todayISO
    if (e < minISO) e = minISO
    if (s > e) s = e
    setUsageDates(s, e)
  }

  // 模型用量派生
  const modelSeries: ChartSeries[] = (modelUsage?.modelDataList ?? []).map((d) => ({
    name: d.modelName ?? '?',
    values: d.tokensUsage ?? [],
  }))
  const modelSummary = modelUsage?.modelSummaryList ?? modelUsage?.modelDataList ?? []
  const modelTotalCalls = modelUsage?.totalUsage?.totalModelCallCount
  const modelTotalTokens = modelUsage?.totalUsage?.totalTokensUsage

  // 工具用量派生（工具名三级 fallback）
  const toolSeries: ChartSeries[] = (toolUsage?.toolDataList ?? []).map((d) => ({
    name: d.toolName ?? d.toolNameI18n ?? d.toolCode ?? '?',
    values: d.usageCount ?? [],
  }))
  const toolSummary = toolUsage?.toolSummaryList ?? toolUsage?.toolDataList ?? []
  const toolTotalCalls = toolSummary.reduce((s, t) => s + (t.totalUsageCount ?? 0), 0)

  const rangeTabs: { key: UsageRange; label: string }[] = [
    { key: 'today', label: t('usage.range.today') },
    { key: '7d', label: t('usage.range.last7') },
    { key: '30d', label: t('usage.range.last30') },
  ]

  return (
    <div className="usage-view">
      {/* 额度区 */}
      <section className="usage-view__section">
        <div className="usage-view__section-head">
          <h3 className="usage-view__section-title">
            {quota?.level ? t('usage.quota.titleWithPlan', { level: quota.level }) : t('usage.quota.title')}
          </h3>
          {quotaFetchedAt > 0 && (
            <span className="usage-view__refresh-time">{t('usage.quota.lastRefresh', { time: fmtTime(quotaFetchedAt) })}</span>
          )}
          <button
            className="usage-view__icon-btn"
            onClick={() => loadQuota()}
            disabled={quotaLoading}
            title={t('usage.quota.refresh')}
          >
            <span className={cx('codicon codicon-refresh', quotaLoading && 'spin')} />
          </button>
        </div>
        {quotaLoading && !quota ? (
          <div className="usage-view__loading">{t('usage.quota.loading')}</div>
        ) : quota?.limits?.length ? (
          <QuotaCards limits={quota.limits} />
        ) : (
          <div className="usage-view__empty">{usageError || t('usage.quota.empty')}</div>
        )}
      </section>

      {/* 用量明细分隔 */}
      <h3 className="usage-view__divider">{t('usage.detail')}</h3>

      {/* 时间范围工具条 */}
      <div className="usage-view__range-bar">
        <div className="usage-view__range-tabs">
          {rangeTabs.map((t) => (
            <button
              key={t.key}
              className={cx('usage-view__range-tab', usageRange === t.key && 'active')}
              onClick={() => setUsageRange(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="usage-view__range-dates">
          <input
            type="date"
            className="usage-view__date-input"
            value={customStart ?? todayISO}
            min={minISO}
            max={todayISO}
            onChange={(e) => onDateChange(e.target.value, customEnd ?? todayISO)}
          />
          <span className="usage-view__date-sep">~</span>
          <input
            type="date"
            className="usage-view__date-input"
            value={customEnd ?? todayISO}
            min={customStart ?? minISO}
            max={todayISO}
            onChange={(e) => onDateChange(customStart ?? todayISO, e.target.value)}
          />
        </div>
      </div>

      {usageError ? <div className="usage-view__error">{usageError}</div> : null}

      {/* 模型用量 */}
      <section className="usage-view__chart-section">
        <div className="usage-view__chart-head">
          <span className="usage-view__chart-title">{t('usage.model.title')}</span>
          <span className="usage-view__chart-summary">
            {modelTotalCalls != null ? t('usage.model.totalCalls', { count: modelTotalCalls }) : ''}
            {modelTotalTokens != null ? ` · ${t('usage.model.totalTokens', { value: fmtBig(modelTotalTokens) })}` : ''}
          </span>
        </div>
        {modelUsage ? (
          <>
            <LineChart
              series={modelSeries}
              xLabels={modelUsage.x_time ?? []}
              granularity={modelUsage.granularity}
            />
            <UsageTable
              headers={[t('usage.model.colName'), t('usage.model.colTokens')]}
              rows={modelSummary.map((m) => [m.modelName ?? '-', fmtBig(m.totalTokens)])}
            />
          </>
        ) : (
          <div className="usage-view__loading">{t('usage.quota.loading')}</div>
        )}
      </section>

      {/* 工具用量 */}
      <section className="usage-view__chart-section">
        <div className="usage-view__chart-head">
          <span className="usage-view__chart-title">{t('usage.tool.title')}</span>
          <span className="usage-view__chart-summary">
            {toolTotalCalls ? t('usage.tool.totalCalls', { count: toolTotalCalls }) : ''}
          </span>
        </div>
        {toolUsage ? (
          <>
            <LineChart
              series={toolSeries}
              xLabels={toolUsage.x_time ?? []}
              granularity={toolUsage.granularity}
            />
            <UsageTable
              headers={[t('usage.tool.colName'), t('usage.tool.colCount')]}
              rows={toolSummary.map((t) => [
                t.toolName ?? t.toolNameI18n ?? t.toolCode ?? '-',
                String(t.totalUsageCount ?? 0),
              ])}
            />
          </>
        ) : (
          <div className="usage-view__loading">{t('usage.quota.loading')}</div>
        )}
      </section>
    </div>
  )
}
