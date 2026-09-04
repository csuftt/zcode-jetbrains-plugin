/**
 * 目标模式状态卡（ChatView 右上角悬浮，ZCode 客户端同款位置）
 *
 * 会话设定了 /goal 目标后常驻显示：靶子图标（与 /goal 命令 chip 同款，颜色与
 * 脉冲动效兼承状态）+ 目标文本（最多三行，悬浮全文）+ 轮次统计（第 N 轮 · 用时 ·
 * token）+ 校验中指示（轮边界，卡片末行），操作钮：暂停/继续 + 清除。
 *
 * 折叠（0.3.2 真机反馈：展开遮挡主界面消息）：悬浮容器由本组件自带
 * （ChatView 只传 belowSearch，搜索浮层打开时下移避让）；卡片可折叠为迷你条
 * （靶子图标 + 第 N 轮 · 用时，点击整条展开），展开态 actions 区提供折叠钮，
 * 折叠态走 persist kv 记忆（zcode.goalCardCollapsed，重启保留）。曾实现过
 * 整卡拖动，真机反馈"难控制位置"已移除——位置固定右上角。
 *
 * 数据源 store.goal（三路汇入）：messages 首拉恢复（session.target）+
 * goalManaged 回执 + session.updated 目标 payload（set/run_started/
 * status_updated/usage_accounted/run_finished/cleared，diag-goal.py 实测）。
 * 自动续跑引擎在 app-server 内部，本卡纯展示 + 控制意图下发。
 *
 * 用时显示：服务端 timeUsedSeconds 事件间隔内不增长（usage_accounted 轮末才
 * 记账），active 态本地走秒递增（基准 syncedAt，服务端值到达即校准回零重数，
 * 少量跳变可接受）；paused/complete 冻结显示服务端值。
 * token 显示同思路：服务端只在轮末 run_finished 带权威值（轮中零推送），
 * 轮中以流式输出字符量粗估增量（见 estimateStreamingTokens），轮末校准归真。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { useTick } from '@/hooks/useTick'
import { compactTokens } from '@/utils/time'
import { getPersisted, setPersisted, isKvHydrated, KV_HYDRATED_EVENT, KV_DISABLED_EVENT } from '@/utils/persist'
import type { ZCodeMessage } from '@/types/messages'
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

/**
 * 流式输出 → token 粗估：服务端只在轮末 run_finished 带权威 tokensUsed（diag
 * 实测 + zcode.cjs 源码 accountTargetUsage 仅 run ended 执行），轮中零数据源。
 * 耗时已有本地走秒，token 同理做轮中增量估算——流式消息的正文/思考全字符量、
 * 工具输入 JSON 半字符量（结构字符占比高），按 3 字符/token 粗估。轮末权威
 * 值到达即校准归真，估算误差只活在单轮内。
 */
function estimateStreamingTokens(msg: ZCodeMessage | null): number {
  if (!msg) return 0
  let chars = 0
  for (const p of msg.parts ?? []) {
    if (p.type === 'text' || p.type === 'reasoning') {
      chars += ((p as { text?: string }).text ?? '').length
    } else if (p.type === 'tool') {
      // 工具输入优先用流式累积原文（恰为模型生成内容），无则序列化解析态
      const st = (p as { state?: { inputRaw?: string; input?: unknown } }).state
      const raw = st?.inputRaw ?? JSON.stringify(st?.input ?? '')
      chars += raw.length / 2
    }
  }
  return Math.ceil(chars / 3)
}

export function GoalCard({ belowSearch = false }: { belowSearch?: boolean }) {
  const { t } = useTranslation()
  const goal = useStore((s) => s.goal)
  const streaming = useStore((s) => s.streaming)
  const goalManage = useStore((s) => s.goalManage)
  // 轮中 token 估算的增量来源（find 返回既有引用，无 selector 对象陷阱）
  const streamingMessage = useStore((s) =>
    s.streamingMessageId ? s.messages.find((m) => m.info.id === s.streamingMessageId) ?? null : null)
  const isActive = goal?.status === 'active'
  // 本地走秒：active 期间每秒重渲染（useTick inactive 时静默）
  const now = useTick(!!goal && isActive, 1000)

  /* ============ 折叠（persist kv 记忆） ============ */
  // 初始读 localStorage 缓存（dev 即权威；生产冷启动为空按默认展开），
  // 水合/终止事件到达后重读权威值（changelog 弹窗竞态教训：启动读 persist 须等事件）
  const [collapsed, setCollapsed] = useState(() => getPersisted(COLLAPSE_KEY) === '1')

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

  if (!goal) return null

  const meta = STATUS_TONES[goal.status] ?? { key: 'chat.goal.status.active', tone: 'active' as const }
  const shownSeconds = isActive
    ? goal.timeUsedSeconds + Math.max(0, Math.floor((now - (goal.syncedAt ?? now)) / 1000))
    : goal.timeUsedSeconds
  // 轮中 token 估算：active 且本轮流式进行中（verifying=轮间隙，权威值已含本轮
  // 全部输出，再加估算会双计）；轮末 run_finished 权威校准归真
  const shownTokens = isActive && !goal.verifying
    ? goal.tokensUsed + estimateStreamingTokens(streamingMessage)
    : goal.tokensUsed

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
            {/* 目标文本：最多三行（长目标完整可读，悬浮 title 看全文）*/}
            <div className="goal-card__objective" title={goal.objective}>
              {goal.summaryTitle || goal.objective}
            </div>
            <div className="goal-card__stats">
              {t('chat.goal.stats.iteration', { count: goal.iterationCount })}
              <span className="goal-card__stat-sep">·</span>
              {/* 数字段固定占位（tabular-nums 等宽 + min-width）：走秒/token 估算
               * 轮中持续变化，无占位会不断推挤卡宽（0.3.2 真机反馈）*/}
              <span className="goal-card__stat-num goal-card__stat-duration">{formatDuration(shownSeconds)}</span>
              <span className="goal-card__stat-sep">·</span>
              <span className="goal-card__stat-num goal-card__stat-tokens">
                {t('chat.goal.stats.tokens', { tokens: compactTokens(shownTokens) })}
              </span>
              {goal.tokenBudget != null && (
                <>
                  <span className="goal-card__stat-sep">/</span>
                  {compactTokens(goal.tokenBudget)}
                </>
              )}
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
            <button className="goal-card__btn goal-card__btn--clear" onClick={() => goalManage('clear')} title={t('chat.goal.action.clear')}>
              <span className="codicon codicon-close" />
            </button>
          </span>
        </div>
      )}
    </div>
  )
}
