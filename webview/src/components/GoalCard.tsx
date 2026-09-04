/**
 * 目标模式状态卡（ChatView 右上角悬浮，ZCode 客户端同款位置）
 *
 * 会话设定了 /goal 目标后常驻显示：靶子图标（与 /goal 命令 chip 同款，颜色与
 * 脉冲动效兼承状态）+ 目标文本（最多三行，悬浮全文）+ 轮次统计（第 N 轮 · 用时）
 * + 校验中指示（轮边界，卡片末行），操作钮：暂停/继续 + 清除（二次确认，同
 * 历史会话归档按钮模式）。
 *
 * 折叠（0.3.2 真机反馈：展开遮挡主界面消息）：悬浮容器由本组件自带
 * （ChatView 只传 belowSearch，搜索浮层打开时下移避让）；卡片可折叠为迷你条
 * （靶子图标 + 第 N 轮 · 用时，点击整条展开），展开态 actions 区提供折叠钮，
 * 折叠态走 persist kv 记忆（zcode.goalCardCollapsed，重启保留）。曾实现过
 * 整卡拖动，真机反馈"难控制位置"已移除——位置固定右上角。
 * 卡宽稳定（真机反馈：不随目标文案变化）：目标文本定宽为统计行实测宽度，
 * 长文案在固定宽度内换行（最多三行），卡片宽度只由统计行主导。
 * token 不展示（真机反馈：占宽，ZCode 客户端同款只留轮次与耗时）——曾实现
 * 轮中字符量粗估增量（estimateStreamingTokens），随展示一并移除。
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

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { useTick } from '@/hooks/useTick'
import { getPersisted, setPersisted, isKvHydrated, KV_HYDRATED_EVENT, KV_DISABLED_EVENT } from '@/utils/persist'
import { ConfirmDialog } from './ConfirmDialog'
import '../styles/goal-card.less'

const STATUS_TONES: Record<string, { key: string; tone: 'active' | 'paused' | 'done' | 'warn' }> = {
  active: { key: 'chat.goal.status.active', tone: 'active' },
  paused: { key: 'chat.goal.status.paused', tone: 'paused' },
  budget_limited: { key: 'chat.goal.status.budgetLimited', tone: 'warn' },
  complete: { key: 'chat.goal.status.complete', tone: 'done' },
}

/** 折叠态记忆（'1'=迷你条）*/
const COLLAPSE_KEY = 'zcode.goalCardCollapsed'

/** 秒 → 人话时长（90 → 1m30s；不足 1 分钟显示 42s） */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return `${m}m${rest > 0 ? `${rest}s` : ''}`
  return `${Math.floor(m / 60)}h${m % 60 > 0 ? `${m % 60}m` : ''}`
}

export function GoalCard({ belowSearch = false }: { belowSearch?: boolean }) {
  const { t, i18n } = useTranslation()
  const goal = useStore((s) => s.goal)
  const streaming = useStore((s) => s.streaming)
  const goalManage = useStore((s) => s.goalManage)
  const isActive = goal?.status === 'active'
  // 本地走秒：active 期间每秒重渲染（useTick inactive 时静默）
  const now = useTick(!!goal && isActive, 1000)

  /* ============ 折叠（persist kv 记忆） ============ */
  // 初始读 localStorage 缓存（dev 即权威；生产冷启动为空按默认展开），
  // 水合/终止事件到达后重读权威值（changelog 弹窗竞态教训：启动读 persist 须等事件）
  const [collapsed, setCollapsed] = useState(() => getPersisted(COLLAPSE_KEY) === '1')
  // 清除目标二次确认（同历史会话归档模式：ConfirmDialog，清除属删除类红色确认）
  const [confirmingClear, setConfirmingClear] = useState(false)

  useEffect(() => {
    const reread = () => {
      setCollapsed(getPersisted(COLLAPSE_KEY) === '1')
    }
    if (isKvHydrated()) reread()
    window.addEventListener(KV_HYDRATED_EVENT, reread)
    window.addEventListener(KV_DISABLED_EVENT, reread)
    return () => {
      window.removeEventListener(KV_HYDRATED_EVENT, reread)
      window.removeEventListener(KV_DISABLED_EVENT, reread)
    }
  }, [])

  const toggleCollapse = (v: boolean) => {
    setCollapsed(v)
    setPersisted(COLLAPSE_KEY, v ? '1' : '0')
  }

  /* ============ 卡宽稳定（0.3.2 真机反馈：宽度不随目标文案变化） ============ */
  // 目标文本定宽为统计行宽：卡片 shrink-to-fit 的宽度即由统计行主导（文案不再
  // 参与撑宽），长文案在固定宽度内换行（最多三行 clamp 不变），高度随行数自适应。
  // 纯 CSS 无法"以另一行宽度定宽"，测量统计行写入文本宽度；走秒在 min-width
  // 占位内变化不改变统计行宽，无需逐帧重测。轮次位数/语言切换会改变统计行宽，
  // 列入依赖。
  const statsRef = useRef<HTMLDivElement>(null)
  const [textWidth, setTextWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const stats = statsRef.current
    if (!stats) return
    const w = Math.ceil(stats.getBoundingClientRect().width)
    if (w > 0) setTextWidth((prev) => (prev === w ? prev : w))
  }, [goal?.iterationCount, i18n.language])

  if (!goal) return null

  const meta = STATUS_TONES[goal.status] ?? { key: 'chat.goal.status.active', tone: 'active' as const }
  const shownSeconds = isActive
    ? goal.timeUsedSeconds + Math.max(0, Math.floor((now - (goal.syncedAt ?? now)) / 1000))
    : goal.timeUsedSeconds

  // 搜索浮层打开时（同占右上）目标卡下移避让
  const floatCls = `goal-card-float${belowSearch ? ' goal-card-float--below-search' : ''}`
  const targetIcon = (
    <span className={`goal-card__target${isActive ? ' goal-card__target--pulse' : ''}`} title={t(meta.key)}>
      <span className="codicon codicon-target" />
    </span>
  )

  return (
    <div className={floatCls}>
      {collapsed ? (
        // 折叠迷你条：靶子图标（状态色/脉动保留，一眼可辨目标仍在跑）+ 轮次·用时
        // 单行；title 悬浮看目标全文，点击展开
        <div
          className={`goal-card goal-card--collapsed goal-card--${meta.tone}`}
          title={goal.objective}
          onClick={() => toggleCollapse(false)}
        >
          {targetIcon}
          <span className="goal-card__mini">
            {t('chat.goal.stats.iteration', { count: goal.iterationCount })}
            <span className="goal-card__stat-sep">·</span>
            <span className="goal-card__stat-num goal-card__stat-duration">{formatDuration(shownSeconds)}</span>
          </span>
        </div>
      ) : (
        <div className={`goal-card goal-card--${meta.tone}`}>
          {targetIcon}
          <div className="goal-card__main">
            {/* 目标文本：最多三行（长目标完整可读，悬浮 title 看全文）；宽度锚定
             * 统计行（首帧未测得时暂不定宽，layoutEffect 同帧修正，无闪动）*/}
            <div
              className="goal-card__objective"
              title={goal.objective}
              style={textWidth != null ? { width: `${textWidth}px` } : undefined}
            >
              {goal.summaryTitle || goal.objective}
            </div>
            <div className="goal-card__stats" ref={statsRef}>
              {t('chat.goal.stats.iteration', { count: goal.iterationCount })}
              <span className="goal-card__stat-sep">·</span>
              {/* 数字段固定占位（tabular-nums 等宽 + min-width）：走秒轮中持续
               * 变化，无占位会不断推挤卡宽（0.3.2 真机反馈）*/}
              <span className="goal-card__stat-num goal-card__stat-duration">{formatDuration(shownSeconds)}</span>
            </div>
            {/* 校验中：独立一行，置于卡片最后一行（不插在目标与统计中间）；
             * 转圈图标放文字之后（0.3.2 真机反馈）*/}
            {goal.verifying && (
              <div className="goal-card__verify" title={t('chat.goal.verifyingTip')}>
                {t('chat.goal.verifying', { count: goal.iterationCount })}
                <span className="goal-card__verify-spin" />
              </div>
            )}
          </div>
          <span className="goal-card__actions">
            <button className="goal-card__btn" onClick={() => toggleCollapse(true)} title={t('chat.goal.action.collapse')}>
              <span className="codicon codicon-chevron-up" />
            </button>
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
            <button
              className="goal-card__btn goal-card__btn--clear"
              onClick={() => setConfirmingClear(true)}
              title={t('chat.goal.action.clear')}
            >
              <span className="codicon codicon-close" />
            </button>
          </span>
        </div>
      )}
      {/* 清除目标二次确认（portal 挂 body：float 容器 pointer-events:none 会闷死
       * 弹窗点击；同历史会话归档按钮模式，danger 红色确认）*/}
      {confirmingClear && createPortal(
        <ConfirmDialog
          title={t('chat.goal.confirmClear.title')}
          message={t('chat.goal.confirmClear.message')}
          confirmText={t('chat.goal.confirmClear.confirm')}
          danger
          onConfirm={() => {
            setConfirmingClear(false)
            goalManage('clear')
          }}
          onCancel={() => setConfirmingClear(false)}
        />,
        document.body,
      )}
    </div>
  )
}
