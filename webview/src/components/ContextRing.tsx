/**
 * 上下文用量圆环（输入框模型选择左边）
 *
 * 移植 CC-GUI TokenIndicator 的 SVG 双 circle 方案：
 *   - 背景灰圈 + 进度弧（strokeDasharray/strokeDashoffset），rotate(-90deg) 起点在顶部
 *   - 按百分比阈值变色：<70% 正常 / 70-90% 橙 / >90% 红
 *
 * hover 富 popover（createPortal + fixed，避免父级 overflow:hidden 裁剪 —— 坑 #10）：
 *   - 上下文用量（进度 + 已用/总量）
 *   - 上下文构成（model_complete 的 contextUsageBreakdown：消息/系统工具/技能/… 占比 + 缓存命中率）
 *   - GLM 额度概要（仅当前模型属于 GLM 套餐时显示），懒加载（5min 缓存 TTL）
 *
 * 数据：contextUsage（session/read）、contextBreakdown（model_complete 事件）、quota（HTTP quota/limit）
 */

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore, GLM_PLAN_PROVIDER } from '@/store/useStore'
import { fmtTokens, limitTitle, fmtResetTime, fmtTime } from '@/utils/format'
import type { ContextBreakdownItem, ContextSource } from '@/types/messages'

const POP_W = 280

/** 分类展示元数据（顺序即显示顺序；label 为 i18n key，渲染时经 t() 转文案）*/
const BREAKDOWN_META: { source: ContextSource; label: string; color: string }[] = [
  { source: 'messages', label: 'usage.context.categories.messages', color: '#4a9eff' },
  { source: 'system_tool_schemas', label: 'usage.context.categories.systemTools', color: '#b478f0' },
  { source: 'skills', label: 'usage.context.categories.skills', color: '#2bb3a3' },
  { source: 'system_prompt', label: 'usage.context.categories.systemPrompt', color: '#e09850' },
  { source: 'mcp_tool_schemas', label: 'usage.context.categories.mcpTools', color: '#4caf50' },
]
/** 合并为"其他"的 source（占比通常极小）*/
const OTHER_SOURCES: ContextSource[] = ['meta_user_context', 'tool_prompt']
const OTHER_COLOR = '#888888'
/** "其他"分类的 i18n key */
const OTHER_LABEL = 'usage.context.categories.other'

interface CategoryRow {
  label: string
  color: string
  chars: number
  pct: number
}

/** 把 breakdown 数组聚合成显示用的分类行（label 为 i18n key，含"其他"合并，按占比降序过滤 0 值）*/
function aggregateBreakdown(items: ContextBreakdownItem[]): CategoryRow[] {
  const total = items.reduce((sum, it) => sum + it.chars, 0) || 1
  const bySource = new Map<ContextSource, number>()
  for (const it of items) {
    bySource.set(it.source, (bySource.get(it.source) ?? 0) + it.chars)
  }
  const rows: CategoryRow[] = BREAKDOWN_META.filter((m) => bySource.has(m.source)).map((m) => {
    const chars = bySource.get(m.source) ?? 0
    return { label: m.label, color: m.color, chars, pct: (chars / total) * 100 }
  })
  // 其他：合并 meta_user_context + tool_prompt
  const otherChars = OTHER_SOURCES.reduce((sum, s) => sum + (bySource.get(s) ?? 0), 0)
  if (otherChars > 0) rows.push({ label: OTHER_LABEL, color: OTHER_COLOR, chars: otherChars, pct: (otherChars / total) * 100 })
  return rows
}

export function ContextRing() {
  const { t } = useTranslation()
  const ctx = useStore((s) => s.contextUsage)
  const breakdown = useStore((s) => s.contextBreakdown)
  const currentModel = useStore((s) => s.currentModel)
  const quota = useStore((s) => s.quota)
  const quotaLoading = useStore((s) => s.quotaLoading)
  const quotaFetchedAt = useStore((s) => s.quotaFetchedAt)
  const usageError = useStore((s) => s.usageError)
  const loadQuota = useStore((s) => s.loadQuota)

  const [hovered, setHovered] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const ringRef = useRef<HTMLDivElement>(null)

  // 无数据时显示空环占位（不隐藏，新会话也能看到圆环，数据来了自动更新）
  const hasData = ctx && ctx.size > 0
  const percentage = hasData ? Math.min(100, Math.max(0, (ctx!.used / ctx!.size) * 100)) : 0
  const color = !hasData
    ? 'var(--text-muted)'
    : percentage > 90
      ? 'var(--status-error)'
      : percentage > 70
        ? 'var(--status-warning)'
        : 'var(--status-success)'

  // 仅 GLM 套餐模型可查额度（apiKey 认证），其他 provider 不显示也不拉取
  const isGlmPlan = currentModel?.providerId === GLM_PLAN_PROVIDER

  // 分类明细聚合
  const categoryRows = breakdown && breakdown.length > 0 ? aggregateBreakdown(breakdown) : []

  const onEnter = () => {
    setHovered(true)
    // 额度懒加载：仅 GLM 套餐模型才拉取；无数据或超过 5 分钟则拉取
    if (isGlmPlan) {
      const stale = !quota || Date.now() - quotaFetchedAt > 5 * 60 * 1000
      if (stale && !quotaLoading) loadQuota()
    }
    const rect = ringRef.current?.getBoundingClientRect()
    if (rect) {
      let left = rect.left + rect.width / 2 - POP_W / 2
      left = Math.max(8, Math.min(left, window.innerWidth - POP_W - 8))
      setPos({ left, bottom: window.innerHeight - rect.top + 6 })
    }
  }

  const size = 14
  const stroke = 1.5
  const radius = (size - stroke) / 2
  const center = size / 2
  const circumference = 2 * Math.PI * radius
  const strokeOffset = circumference * (1 - percentage / 100)

  return (
    <>
      <div
        className="context-ring"
        ref={ringRef}
        onMouseEnter={onEnter}
        onMouseLeave={() => setHovered(false)}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--border-primary)" strokeWidth={stroke} />
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
            style={{ transition: 'stroke-dashoffset 0.3s ease' }}
          />
        </svg>
      </div>

      {hovered && pos &&
        createPortal(
          <div className="ctx-popover" style={{ position: 'fixed', left: pos.left, bottom: pos.bottom, width: POP_W }}>
            {/* 上下文用量 */}
            <div className="ctx-popover__section">
              <div className="ctx-popover__title">{t('usage.context.titleUsage')}</div>
              <div className="ctx-popover__bar">
                <div className="ctx-popover__bar-fill" style={{ width: `${percentage}%`, background: color }} />
              </div>
              <div className="ctx-popover__row">
                <span>{t('usage.context.used')}</span>
                <span className="ctx-popover__num">
                  {hasData ? `${fmtTokens(ctx!.used)} / ${fmtTokens(ctx!.size)} (${percentage.toFixed(1)}%)` : t('usage.context.waitingData')}
                </span>
              </div>
            </div>

            {/* 上下文构成（model_complete 的 contextUsageBreakdown，仅主 turn 有数据）*/}
            <div className="ctx-popover__section">
              <div className="ctx-popover__title">{t('usage.context.titleBreakdown')}</div>
              {categoryRows.length > 0 ? (
                categoryRows.map((row, i) => (
                  <div className="ctx-popover__row ctx-popover__cat" key={i}>
                    <span className="ctx-popover__dot" style={{ background: row.color }} />
                    <span className="ctx-popover__label">{t(row.label)}</span>
                    <span className="ctx-popover__bar-mini">
                      <span style={{ width: `${Math.max(2, row.pct)}%`, background: row.color }} />
                    </span>
                    <span className="ctx-popover__num">{row.pct.toFixed(1)}%</span>
                  </div>
                ))
              ) : (
                <div className="ctx-popover__muted">{t('usage.context.noBreakdown')}</div>
              )}
              <div className="ctx-popover__row ctx-popover__row--highlight">
                <span className="ctx-popover__label">{t('usage.context.hitRate')}</span>
                {/* hitRate=null 表示本 turn 暂无统计（新 turn 首次模型调用完成前），显示"—"而非误导性的 0% */}
                <span className="ctx-popover__num">
                  {hasData && ctx!.hitRate != null ? `${(ctx!.hitRate * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
            </div>

            {/* GLM 额度（仅 GLM 套餐模型）*/}
            {isGlmPlan && (
              <div className="ctx-popover__section">
                <div className="ctx-popover__title">
                  {quota?.level ? t('usage.context.glmQuotaWithLevel', { level: quota.level }) : t('usage.context.glmQuota')}
                </div>
                {quota?.limits?.length ? (
                  quota.limits.map((l, i) => {
                    const p = Math.min(100, Math.max(0, l.percentage ?? 0))
                    return (
                      <div className="ctx-popover__row" key={i}>
                        <span className="ctx-popover__label">{limitTitle(l)}</span>
                        <span className="ctx-popover__num">{p.toFixed(0)}%</span>
                        {l.nextResetTime ? (
                          <span className="ctx-popover__reset">{t('usage.quota.resetAt', { time: fmtResetTime(l.nextResetTime) })}</span>
                        ) : null}
                      </div>
                    )
                  })
                ) : quotaLoading ? (
                  <div className="ctx-popover__muted">{t('usage.context.quotaLoading')}</div>
                ) : usageError ? (
                  <div className="ctx-popover__muted ctx-popover__muted--error">{usageError}</div>
                ) : (
                  <div className="ctx-popover__muted">{t('usage.context.noQuota')}</div>
                )}
                {quotaFetchedAt > 0 && (
                  <div className="ctx-popover__refresh">{t('usage.quota.lastRefresh', { time: fmtTime(quotaFetchedAt) })}</div>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
