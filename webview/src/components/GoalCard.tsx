/**
 * 目标模式状态卡（ChatView 右上角悬浮，ZCode 客户端同款位置）
 *
 * 会话设定了 /goal 目标后常驻显示：目标文本（最多三行，悬浮全文）+ 状态徽标 +
 * 轮次统计（第 N 轮 · 用时 · token）+ 校验中指示（轮边界，独立一行），操作钮：暂停/继续 + 清除。
 *
 * 数据源 store.goal（三路汇入）：messages 首拉恢复（session.target）+
 * goalManaged 回执 + session.updated 目标 payload（set/run_started/
 * status_updated/usage_accounted/run_finished/cleared，diag-goal.py 实测）。
 * 自动续跑引擎在 app-server 内部，本卡纯展示 + 控制意图下发。
 *
 * 用时显示：服务端 timeUsedSeconds 事件间隔内不增长（usage_accounted 轮末才
 * 记账），active 态本地走秒递增（基准 syncedAt，服务端值到达即校准回零重数，
 * 少量跳变可接受）；paused/complete 冻结显示服务端值。
 */

import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { useTick } from '@/hooks/useTick'
import { compactTokens } from '@/utils/time'
import '../styles/goal-card.less'

const STATUS_META: Record<string, { icon: string; key: string; tone: 'active' | 'paused' | 'done' | 'warn' }> = {
  active: { icon: 'codicon-play-circle', key: 'chat.goal.status.active', tone: 'active' },
  paused: { icon: 'codicon-debug-pause', key: 'chat.goal.status.paused', tone: 'paused' },
  budget_limited: { icon: 'codicon-graph-line', key: 'chat.goal.status.budgetLimited', tone: 'warn' },
  complete: { icon: 'codicon-pass', key: 'chat.goal.status.complete', tone: 'done' },
}

/** 秒 → 人话时长（90 → 1m30s；不足 1 分钟显示 42s） */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return `${m}m${rest > 0 ? `${rest}s` : ''}`
  return `${Math.floor(m / 60)}h${m % 60 > 0 ? `${m % 60}m` : ''}`
}

export function GoalCard() {
  const { t } = useTranslation()
  const goal = useStore((s) => s.goal)
  const streaming = useStore((s) => s.streaming)
  const goalManage = useStore((s) => s.goalManage)
  const isActive = goal?.status === 'active'
  // 本地走秒：active 期间每秒重渲染（useTick inactive 时静默）
  const now = useTick(!!goal && isActive, 1000)

  if (!goal) return null

  const meta = STATUS_META[goal.status] ?? { icon: 'codicon-target', key: 'chat.goal.status.active', tone: 'active' as const }
  const shownSeconds = isActive
    ? goal.timeUsedSeconds + Math.max(0, Math.floor((now - (goal.syncedAt ?? now)) / 1000))
    : goal.timeUsedSeconds

  return (
    <div className={`goal-card goal-card--${meta.tone}`}>
      <span className={`goal-card__status ${isActive ? 'goal-card__status--pulse' : ''}`} title={t(meta.key)}>
        <span className={`codicon ${meta.icon}`} />
      </span>
      <div className="goal-card__main">
        {/* 目标文本：最多三行（长目标完整可读，悬浮 title 看全文）*/}
        <div className="goal-card__objective" title={goal.objective}>
          {goal.summaryTitle || goal.objective}
        </div>
        {/* 校验中：独立一行（与轮次统计同行会把卡片顶宽，0.3.2 真机反馈）*/}
        {goal.verifying && (
          <div className="goal-card__verify" title={t('chat.goal.verifyingTip')}>
            <span className="goal-card__verify-spin" />
            {t('chat.goal.verifying', { count: goal.iterationCount })}
          </div>
        )}
        <div className="goal-card__stats">
          {t('chat.goal.stats.iteration', { count: goal.iterationCount })}
          <span className="goal-card__stat-sep">·</span>
          {formatDuration(shownSeconds)}
          <span className="goal-card__stat-sep">·</span>
          {t('chat.goal.stats.tokens', { tokens: compactTokens(goal.tokensUsed) })}
          {goal.tokenBudget != null && (
            <>
              <span className="goal-card__stat-sep">/</span>
              {compactTokens(goal.tokenBudget)}
            </>
          )}
        </div>
      </div>
      <span className="goal-card__actions">
        {(goal.status === 'active' || goal.status === 'budget_limited') && (
          <button
            className="goal-card__btn"
            onClick={() => goalManage('pause')}
            title={t('chat.goal.action.pause')}
            disabled={streaming && !isActive}
          >
            <span className="codicon codicon-debug-pause" />
          </button>
        )}
        {goal.status === 'paused' && (
          <button className="goal-card__btn" onClick={() => goalManage('resume')} title={t('chat.goal.action.resume')}>
            <span className="codicon codicon-play" />
          </button>
        )}
        <button className="goal-card__btn goal-card__btn--clear" onClick={() => goalManage('clear')} title={t('chat.goal.action.clear')}>
          <span className="codicon codicon-close" />
        </button>
      </span>
    </div>
  )
}
