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
import { useStore, isBigmodelProvider, isQuotaInFlight } from '@/store/useStore'
import { fmtTokens, limitTitle, fmtResetTimeCompact, fmtTime } from '@/utils/format'
import { quotaWindowRows, remainingPercent, formatRemainPct, WINDOW_LABEL_I18N } from '@/utils/quotaWindows'
import type { QuotaWindowKey } from '@/utils/quotaWindows'
import { lastTpsRound, weightedAvgTps } from '@/utils/tps'
import type { ContextBreakdownItem, ContextSource } from '@/types/messages'
import { ConfirmDialog } from './ConfirmDialog'
import '../styles/input-box.less'

const POP_W = 320

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

/** 上下文圆环配色（2026-10-08 用户从四方案预览中选定 B，基环透明度两轮微调后定 30%）：
 *  基环 = 青绿 30% 透明底（替代原灰底——灰色在顶栏彩色图标间突兀），常态弧 = 青绿实色
 *  （与下方 BREAKDOWN_META 的 skills 分类同族色）；>70% 黄 / >90% 红警示档不变。
 *  预览页 docs/internal/probe/context-ring-color-preview.html（本地 8471 服务） */
const RING_TRACK_COLOR = 'rgba(43,179,163,0.30)'
const RING_NORMAL_COLOR = '#2bb3a3'

/** 额度窗口进度条颜色（对齐官方客户端 chat-input-toolbar 额度面板：
    5h 蓝 / 周 绿 / 工具 紫 / 兜底行 橙。官方工具调用=--color-usage-chart-3，
    暗色主题下解析到 Tailwind violet-400=#a78bfa，取同值）
    2026-10-13 用户裁定：工具调用对齐官方紫，勿改青绿 */
const QUOTA_WINDOW_COLORS: Record<QuotaWindowKey | 'other', string> = {
  '5h': '#4a9eff',
  weekly: '#4caf50',
  tool: '#a78bfa',
  other: '#e09850',
}

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
  const sessionDebug = useStore((s) => s.sessionDebug)
  const loadSessionDebug = useStore((s) => s.loadSessionDebug)
  const sendMessage = useStore((s) => s.sendMessage)

  const [hovered, setHovered] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const [confirmCompact, setConfirmCompact] = useState(false)
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
        : RING_NORMAL_COLOR

  // bigmodel 系模型可查额度（coding-plan 订阅 + API Key 渠道，monitor 按账号返回套餐；
  // 第三方 provider 不显示也不拉取）
  const isGlmPlan = isBigmodelProvider(currentModel?.providerId)

  // 分类明细聚合（v1：session/read 的 runtime.breakdown；NEW 代：主回合完成事件的
  // contextUsageBreakdown，见 applyContextBreakdownEvent）
  const categoryRows = breakdown && breakdown.length > 0 ? aggregateBreakdown(breakdown) : []

  // 额度窗口行（三标准窗 + 兜底行），弹窗额度区渲染唯一输入
  const quotaRows = quotaWindowRows(quota?.limits)

  // 生成速度聚合（session/debug 真值；空 = agent 进程内尚无完成请求，重启后从新回合累计）
  const tpsRounds = sessionDebug?.rounds ?? []
  const tpsLast = lastTpsRound(tpsRounds)
  const tpsAvg = weightedAvgTps(tpsRounds)
  // 有任一真值才渲染速度行（无数据不占行，弹窗不因本功能变长）——并成命中率下的
  // 单行而非独立区块：弹窗纵向已很长，独立区块（标题+3行+明细）真机反馈过长
  const hasTps = tpsLast != null || tpsAvg != null

  const onEnter = () => {
    setHovered(true)
    // 生成速度懒加载：每次 hover 拉一次（单请求 RPC，官方客户端常态 1s 轮询，
    // hover 触发量可忽略）；streaming 期间 WaitingIndicator 的 2s 轮询会让本区跟着活
    loadSessionDebug()
    // 额度懒加载：仅 GLM 套餐模型才拉取；无数据或超过 5 分钟则拉取
    // （在途判定用 isQuotaInFlight 而非裸 quotaLoading：应答丢失时超时放行，缺陷FM）
    if (isGlmPlan) {
      const stale = !quota || Date.now() - quotaFetchedAt > 5 * 60 * 1000
      if (stale && !isQuotaInFlight()) loadQuota()
    }
    const rect = ringRef.current?.getBoundingClientRect()
    if (rect) {
      let left = rect.left + rect.width / 2 - POP_W / 2
      left = Math.max(8, Math.min(left, window.innerWidth - POP_W - 8))
      setPos({ left, bottom: window.innerHeight - rect.top + 6 })
    }
  }

  // 双击 = 压缩上下文：确认后发 /compact（与输入框发出完全同路，回合进行中由
  // sendMessage 自动入队）。尚无上下文数据（新会话未对话）时双击不响应
  const onDoubleClick = () => {
    // Chromium 双击默认产生词选区，可能落到相邻「智能」按钮文字上，清掉
    window.getSelection()?.removeAllRanges()
    if (!hasData) return
    setHovered(false)
    setConfirmCompact(true)
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
        onDoubleClick={onDoubleClick}
        data-tip={t('usage.context.titleUsage')}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={center} cy={center} r={radius} fill="none" stroke={RING_TRACK_COLOR} strokeWidth={stroke} />
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

            {/* 上下文构成（v1：session/read runtime.breakdown；NEW 代：主回合完成事件
                payload.contextUsageBreakdown，仅主 turn 有数据；新会话首回合前显空态）*/}
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
              {/* 缓存命中在上（用户定稿排序），生成速度在下；hitRate=null 表示本 turn
                  暂无统计（新 turn 首次模型调用完成前），显示"—"而非误导性的 0% */}
              <div className="ctx-popover__row ctx-popover__row--highlight">
                <span className="ctx-popover__label">{t('usage.context.hitRate')}</span>
                <span className="ctx-popover__num">
                  {hasData && ctx!.hitRate != null ? `${(ctx!.hitRate * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
              {/* 生成速度（session/debug 真值，官方开发者工具面板同源）；明细（输出/耗时/累计）
                  不进弹窗保长度 */}
              {hasTps && (
                <div className="ctx-popover__row">
                  <span className="ctx-popover__label">{t('usage.speed.title')}</span>
                  <span className="ctx-popover__num">
                    {tpsLast?.tokensPerSecond != null
                      ? t('usage.speed.live', { tps: tpsLast.tokensPerSecond.toFixed(1) })
                      : '—'}
                    {tpsAvg != null && (
                      <span className="ctx-popover__num-suffix">
                        {t('usage.speed.avgSuffix', { tps: tpsAvg.toFixed(1) })}
                      </span>
                    )}
                  </span>
                </div>
              )}
            </div>

            {/* GLM 额度窗口卡（仅 GLM 套餐模型）：官方客户端同构三列并排——
                每列「窗口名 / 剩余% · 重置时间 / 彩色进度条」（5h 蓝/周 绿/工具 紫），
                填充即剩余占比。三标准窗按 (type,unit,number) 挑选；其余形状落「通用额度」列
                （超过 3 列自动换行）。套餐档位（MAX 等）以 chip 徽标缀标题右侧，
                首字母大写其余小写（MAX→Max，2026-10-13 用户定稿）。
                reset 统一到分（fmtResetTimeCompact：当日 HH:mm / 跨日 MM-dd HH:mm），
                MCP 额度独立接口不在 quota/limit 返回内，不展示 */}
            {isGlmPlan && (
              <div className="ctx-popover__section">
                <div className="ctx-popover__title">
                  {t('usage.context.glmQuota')}
                  {quota?.level ? (
                    <span className="ctx-popover__quota-badge">
                      {quota.level.charAt(0).toUpperCase() + quota.level.slice(1).toLowerCase()}
                    </span>
                  ) : null}
                </div>
                {quotaRows.length ? (
                  <div className="ctx-popover__quota-grid">
                    {quotaRows.map(({ key, limit }, i) => {
                      const remain = remainingPercent(limit)
                      return (
                        <div className="ctx-popover__quota" key={i}>
                          <div className="ctx-popover__quota-label">
                            {key === 'other' ? limitTitle(limit) : t(WINDOW_LABEL_I18N[key])}
                          </div>
                          <div className="ctx-popover__quota-meta">
                            <span className="ctx-popover__quota-pct">{remain !== null ? formatRemainPct(remain) : '--'}</span>
                            {limit.nextResetTime ? (
                              <span className="ctx-popover__quota-reset">· {fmtResetTimeCompact(limit.nextResetTime)}</span>
                            ) : null}
                          </div>
                          <div className="ctx-popover__quota-bar">
                            <div
                              className="ctx-popover__quota-bar-fill"
                              style={{ width: `${remain ?? 0}%`, background: QUOTA_WINDOW_COLORS[key] }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
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

            {/* 双击压缩提示（悬浮栏常驻提示位）*/}
            <div className="ctx-popover__hint">{t('usage.context.doubleClickHint')}</div>
          </div>,
          document.body,
        )}

      {confirmCompact && (
        <ConfirmDialog
          title={t('usage.context.compactConfirmTitle')}
          message={t('usage.context.compactConfirmMessage')}
          onConfirm={() => {
            setConfirmCompact(false)
            sendMessage('/compact')
          }}
          onCancel={() => setConfirmCompact(false)}
        />
      )}
    </>
  )
}
