/**
 * 用量查询面板（设置页「用量查询」条目）
 *
 * 主 tab 两页：
 *   - 应用用量（默认，在前）：usage/stats（app-server 本地会话聚合）——覆盖全部
 *     模型含第三方直连（DeepSeek/Qwen 等），不依赖 config.json 的 apiKey
 *   - GLM 套餐用量：monitor 三路 HTTP（quota/limit + model-usage + tool-usage），
 *     完整移植 glm-plan-usage-idea 的 GlmUsagePanel 布局：
 *     额度卡片 → 「用量明细」分隔 → 时间范围工具条 → 模型用量(曲线+表) → 工具用量(曲线+表)
 *
 * 数据：
 *   - 应用用量：getAppUsage（range: 7d/30d/all，协议口径无自定义区间）
 *   - 额度：getQuota（quota/limit，无参）
 *   - 模型曲线：getModelUsage（startTime/endTime）
 *   - 工具曲线：getToolUsage（startTime/endTime）
 */

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import type { AppUsageRange, UsageRange } from '@/types/messages'
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

/** GLM 家族模型（曲线/表里给第三方模型加徽章用）*/
const isGlmModel = (modelId?: string) => !!modelId && modelId.toLowerCase().includes('glm')

/** 用量明细表（模型/工具汇总）*/
function UsageTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
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

/** 应用用量 tab（usage/stats：本地聚合，含第三方模型）*/
function AppUsageTab() {
  const { t } = useTranslation()
  const appUsage = useStore((s) => s.appUsage)
  const appUsageRange = useStore((s) => s.appUsageRange)
  const appUsageError = useStore((s) => s.appUsageError)
  const setAppUsageRange = useStore((s) => s.setAppUsageRange)
  const loadAppUsage = useStore((s) => s.loadAppUsage)

  const rangeTabs: { key: AppUsageRange; label: string }[] = [
    { key: '7d', label: t('usage.range.last7') },
    { key: '30d', label: t('usage.range.last30') },
    { key: 'all', label: t('usage.app.range.all') },
  ]

  const s = appUsage?.summary
  // 指标卡（值缺省整卡不渲染）
  const stats: { label: string; value: string }[] = [
    { label: t('usage.app.stat.totalTokens'), value: s?.totalTokens != null ? fmtBig(s.totalTokens) : '' },
    { label: t('usage.app.stat.requests'), value: s != null && appUsage?.models ? String(appUsage.models.reduce((n, m) => n + (m.requestCount ?? 0), 0)) : '' },
    { label: t('usage.app.stat.sessions'), value: s?.totalSessions != null ? String(s.totalSessions) : '' },
    { label: t('usage.app.stat.turns'), value: s?.totalTurns != null ? String(s.totalTurns) : '' },
    { label: t('usage.app.stat.cacheHit'), value: s?.cacheHitRate != null ? `${(s.cacheHitRate * 100).toFixed(1)}%` : '' },
    { label: t('usage.app.stat.activeDays'), value: s?.activeDays != null ? String(s.activeDays) : '' },
  ].filter((x) => x.value !== '')

  // 每日模型曲线：日期轴对齐补 0，按总量取前 6（调色板 6 色 + 图例，超出的模型看下方明细表）
  const daily = appUsage?.dailyModelUsage ?? []
  const dailyIds = [...new Set(daily.flatMap((d) => (d.models ?? []).map((m) => m.modelId ?? '?')))]
  const topIds = new Set(
    dailyIds
      .map((id) => ({ id, total: daily.reduce((n, d) => n + ((d.models ?? []).find((m) => m.modelId === id)?.totalTokens ?? 0), 0) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6)
      .map((x) => x.id),
  )
  const series: ChartSeries[] = dailyIds
    .filter((id) => topIds.has(id))
    .map((id) => ({
      name: id,
      values: daily.map((d) => (d.models ?? []).find((m) => m.modelId === id)?.totalTokens ?? 0),
    }))
  const xLabels = daily.map((d) => d.date ?? '')

  const models = appUsage?.models ?? []
  const tools = (appUsage?.tools ?? []).slice().sort((a, b) => (b.callCount ?? 0) - (a.callCount ?? 0))

  return (
    <>
      <section className="usage-view__section">
        <div className="usage-view__section-head">
          <h3 className="usage-view__section-title">{t('usage.app.title')}</h3>
          <span className="usage-view__refresh-time">{t('usage.app.source')}</span>
          <button
            className="usage-view__icon-btn"
            onClick={() => loadAppUsage()}
            title={t('usage.quota.refresh')}
          >
            <span className="codicon codicon-refresh" />
          </button>
        </div>

        <div className="usage-view__range-bar">
          <div className="usage-view__range-tabs">
            {rangeTabs.map((r) => (
              <button
                key={r.key}
                className={cx('usage-view__range-tab', appUsageRange === r.key && 'active')}
                onClick={() => setAppUsageRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {appUsageError ? <div className="usage-view__error">{appUsageError}</div> : null}

        {appUsage ? (
          <>
            {stats.length > 0 && (
              <div className="usage-view__stat-grid">
                {stats.map((x) => (
                  <div key={x.label} className="usage-view__stat">
                    <span className="usage-view__stat-label">{x.label}</span>
                    <span className="usage-view__stat-value">{x.value}</span>
                  </div>
                ))}
              </div>
            )}

            {series.length > 0 && (
              <section className="usage-view__chart-section">
                <div className="usage-view__chart-head">
                  <span className="usage-view__chart-title">{t('usage.app.model.title')}</span>
                </div>
                <LineChart series={series} xLabels={xLabels} granularity="daily" />
              </section>
            )}

            <section className="usage-view__chart-section">
              <div className="usage-view__chart-head">
                <span className="usage-view__chart-title">{t('usage.app.model.tableTitle')}</span>
              </div>
              <UsageTable
                headers={[
                  t('usage.model.colName'),
                  t('usage.model.colTokens'),
                  t('usage.app.model.colCalls'),
                  t('usage.app.model.colShare'),
                ]}
                rows={models.map((m) => [
                  <span key="n" className="usage-table__model">
                    {m.modelId ?? '-'}
                    {!isGlmModel(m.modelId) && <span className="usage-view__badge">{t('usage.app.thirdParty')}</span>}
                  </span>,
                  fmtBig(m.totalTokens ?? 0),
                  String(m.requestCount ?? 0),
                  m.share != null ? `${(m.share * 100).toFixed(1)}%` : '-',
                ])}
              />
            </section>

            {tools.length > 0 && (
              <section className="usage-view__chart-section">
                <div className="usage-view__chart-head">
                  <span className="usage-view__chart-title">{t('usage.app.tool.title')}</span>
                </div>
                <UsageTable
                  headers={[t('usage.app.tool.colName'), t('usage.app.tool.colCalls'), t('usage.app.tool.colErrRate')]}
                  rows={tools.map((x) => [
                    x.toolName ?? '-',
                    String(x.callCount ?? 0),
                    x.errorRate != null ? `${(x.errorRate * 100).toFixed(1)}%` : '-',
                  ])}
                />
              </section>
            )}
          </>
        ) : (
          !appUsageError && <div className="usage-view__loading">{t('usage.quota.loading')}</div>
        )}
      </section>
    </>
  )
}

/** GLM 套餐用量 tab（monitor HTTP：额度 + 模型/工具曲线）*/
// 订阅制渠道（两家 coding-plan）：凭证来源提示不标「非订阅渠道」警示
const SUBSCRIPTION_PROVIDERS = new Set(['builtin:bigmodel-coding-plan', 'builtin:zai-coding-plan'])

function PlanUsageTab() {
  const { t } = useTranslation()
  const quota = useStore((s) => s.quota)
  const quotaLoading = useStore((s) => s.quotaLoading)
  const quotaFetchedAt = useStore((s) => s.quotaFetchedAt)
  const usageProvider = useStore((s) => s.usageProvider)
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
    <>
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
        {/* 查询凭证提示：回退链可能落到非订阅渠道（API Key 渠道/第三方），数据口径不同需区分 */}
        {usageProvider && (
          <div
            className={cx(
              'usage-view__cred-hint',
              !SUBSCRIPTION_PROVIDERS.has(usageProvider.id) && 'is-foreign',
            )}
          >
            {SUBSCRIPTION_PROVIDERS.has(usageProvider.id)
              ? t('usage.plan.credHint', { name: usageProvider.name })
              : t('usage.plan.credForeign', { name: usageProvider.name })}
          </div>
        )}
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
    </>
  )
}

export function UsageView() {
  const { t } = useTranslation()
  const loadAppUsage = useStore((s) => s.loadAppUsage)
  const [tab, setTab] = useState<'app' | 'plan'>('app')

  // 应用用量随挂载预拉（tab 切换回来即有数据）
  useEffect(() => {
    loadAppUsage()
  }, [loadAppUsage])

  const mainTabs: { key: 'app' | 'plan'; label: string }[] = [
    { key: 'app', label: t('usage.app.tab') },
    { key: 'plan', label: t('usage.plan.tab') },
  ]

  return (
    <div className="usage-view">
      <div className="usage-view__main-tabs">
        {mainTabs.map((x) => (
          <button
            key={x.key}
            className={cx('usage-view__main-tab', tab === x.key && 'active')}
            onClick={() => setTab(x.key)}
          >
            {x.label}
          </button>
        ))}
      </div>
      {tab === 'app' ? <AppUsageTab /> : <PlanUsageTab />}
    </div>
  )
}
