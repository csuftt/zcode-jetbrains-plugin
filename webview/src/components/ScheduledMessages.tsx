/**
 * 定时消息列表（输入框 topbar 下方、排队消息上方）
 *
 * 显示当前会话的待发定时消息（权威列表在 Java 侧，store 镜像；按执行时间升序）：
 *   - 时钟图标 + 目标时间与相对倒计时 + 单行省略预览
 *   - 立即执行：走 Java 分派（与到点分派同一路径——回合活跃入队尾/空闲直发）
 *   - 改时间：经 onReschedule 上抛 InputBox 打开时间选择器
 *   - 取消：从 Java 列表移除
 *
 * 状态判定（与 Java GRACE_MS 对齐）：
 *   - 未来：正常待执行态（显示目标时间 + 倒计时）
 *   - 已过期：fireAt 超过宽限窗（30min）仍未发出——Java 不再自动发，等用户手动决定
 *   - 已挂起：切会话回退的 hold 项，永不自动发，同呈过期态
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore, type ScheduledMessageItem } from '@/store/useStore'
import { sendToJava } from '@/ipc/bridge'
import { useTick } from '@/hooks/useTick'
import '../styles/scheduled-messages.less'

/** 与 Java 侧 ZCodeScheduledMessageService.GRACE_MS 对齐 */
const GRACE_MS = 30 * 60_000

interface Props {
  /** 改时间：上抛给 InputBox 打开时间选择器（编辑器内容不动） */
  onReschedule?: (item: ScheduledMessageItem) => void
}

export function ScheduledMessages({ onReschedule }: Props) {
  const scheduled = useStore((s) => s.scheduledMessages)
  const currentSessionId = useStore((s) => s.currentSessionId)

  const items = useMemo(
    () =>
      scheduled
        // 空sessionId=待命态定时（到点懒创建会话），只在待命态显示
        .filter((m) => (m.sessionId || null) === currentSessionId)
        .sort((a, b) => a.fireAt - b.fireAt),
    [scheduled, currentSessionId],
  )

  // 有未来项才开秒级跳动（倒计时用）；已过期列表静止不烧 CPU
  const hasFuture = items.some((m) => m.fireAt > Date.now())
  const now = useTick(hasFuture, 1000)

  if (items.length === 0) return null

  return (
    <div className="scheduled-messages">
      {items.map((m) => (
        <ScheduleCard key={m.id} item={m} now={now} onReschedule={onReschedule} />
      ))}
    </div>
  )
}

/** 执行模型的显示名：清单里查 modelName，已下架显示原 modelId */
export function useModelName() {
  const models = useStore((s) => s.models)
  return (modelId?: string) => {
    if (!modelId) return undefined
    return models.find((m) => m.modelId === modelId)?.modelName || modelId
  }
}

function ScheduleCard({
  item,
  now,
  onReschedule,
}: {
  item: ScheduledMessageItem
  now: number
  onReschedule?: (item: ScheduledMessageItem) => void
}) {
  const { t } = useTranslation()
  const sendScheduledNow = useStore((s) => s.sendScheduledNow)
  const cancelScheduled = useStore((s) => s.cancelScheduled)
  const modelName = useModelName()(item.modelId)
  const expired = item.hold || now > item.fireAt + GRACE_MS
  const dueSoon = !expired && item.fireAt <= now
  const stateText = expired
    ? item.hold
      ? t('input.schedule.holdState')
      : t('input.schedule.expiredState')
    : dueSoon
      ? t('input.schedule.dueState')
      : t('input.schedule.pendingState', { time: formatFireTime(item.fireAt, t) })

  return (
    <div className={`scheduled-messages__item${expired ? ' scheduled-messages__item--expired' : ''}`}>
      <span className="codicon codicon-calendar scheduled-messages__icon" />
      <div className="scheduled-messages__main">
        <div className="scheduled-messages__meta">
          <span className="scheduled-messages__state">{stateText}</span>
          {!expired && !dueSoon && item.fireAt > now && (
            <span className="scheduled-messages__countdown">{formatCountdown(item.fireAt - now, t)}</span>
          )}
          {modelName && <span className="scheduled-messages__countdown">{modelName}</span>}
        </div>
        <span className="scheduled-messages__text" title={item.text}>
          {item.text.replace(/\n/g, ' ')}
        </span>
      </div>
      <div className="scheduled-messages__actions">
        <button
          className="scheduled-messages__btn scheduled-messages__btn--send"
          onClick={() => sendScheduledNow(item.id)}
          title={t('input.schedule.sendNow')}
        >
          <span className="codicon codicon-export" />
          <span className="scheduled-messages__btn-label">{t('input.schedule.sendNowShort')}</span>
        </button>
        {onReschedule && (
          <button
            className="scheduled-messages__btn"
            onClick={() => onReschedule(item)}
            title={t('input.schedule.reschedule')}
          >
            <span className="codicon codicon-edit" />
          </button>
        )}
        <button
          className="scheduled-messages__btn"
          onClick={() => cancelScheduled(item.id)}
          title={t('input.schedule.cancel')}
        >
          <span className="codicon codicon-close" />
        </button>
      </div>
    </div>
  )
}

/** 目标时间的短格式：今天/明天 HH:mm（前缀走 i18n）、跨天 M/d HH:mm */
function formatFireTime(fireAt: number, t: (k: string) => string): string {
  const d = new Date(fireAt)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000)
  if (dayDiff === 0) return `${t('input.schedule.today')} ${hhmm}`
  if (dayDiff === 1) return `${t('input.schedule.tomorrow')} ${hhmm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`
}

/**
 * 全部定时任务面板（schedule-popover 的列表视图）：跨会话聚合可见性——
 * 挂在其他标签/后台的待发任务不再无处可寻。待执行可改时间/取消/跳转会话；
 * 已发记录只读（最近 5 条）。跳转=当前标签切到该会话（selectSession）。
 */
export function AllScheduledPanel({
  onReschedule,
  onGoto,
}: {
  onReschedule?: (item: ScheduledMessageItem) => void
  /** 跳转会话后的收尾（InputBox 传入：关闭弹窗，避免遮住刚切过去的会话） */
  onGoto?: () => void
}) {
  const { t } = useTranslation()
  const scheduled = useStore((s) => s.scheduledMessages)
  const fired = useStore((s) => s.firedHistory)
  const sessions = useStore((s) => s.sessions)
  const cancelScheduled = useStore((s) => s.cancelScheduled)
  const modelName = useModelName()

  const sessionName = (sid: string) =>
    sid ? sessions.find((s) => s.sessionId === sid)?.title || sid.slice(0, 8) : t('input.schedule.standbySession')

  /** 跳转到任务所属会话：Java 判定——已开标签直接激活那个标签；未开由 gotoSessionLocal 回来本标签切换 */
  const gotoSession = (sid: string) => {
    onGoto?.()
    sendToJava({ op: 'gotoSession', sessionId: sid })
  }

  const pending = useMemo(() => [...scheduled].sort((a, b) => a.fireAt - b.fireAt), [scheduled])
  // 已发只展示最近 5 条（本地映射仅服务于徽标归属，堆太多没有可读价值）
  const firedRecent = useMemo(() => [...fired].sort((a, b) => b.firedAt - a.firedAt).slice(0, 5), [fired])

  if (pending.length === 0 && firedRecent.length === 0) {
    return <div className="schedule-tasks__empty">{t('input.schedule.emptyTasks')}</div>
  }

  return (
    <div className="schedule-tasks">
      {pending.length > 0 && (
        <>
          <div className="schedule-tasks__group">{t('input.schedule.pendingGroup')}</div>
          {pending.map((m) => (
            <div key={m.id} className="schedule-tasks__row">
              <div className="schedule-tasks__main">
                <span className="schedule-tasks__meta">
                  <span className="schedule-tasks__session">{sessionName(m.sessionId)}</span>
                  <span className="schedule-tasks__time">{formatFireTime(m.fireAt, t)}</span>
                  {modelName(m.modelId) && <span className="schedule-tasks__time">{modelName(m.modelId)}</span>}
                </span>
                <span className="schedule-tasks__text" title={m.text}>
                  {m.text.replace(/\n/g, ' ')}
                </span>
              </div>
              {m.sessionId && (
                <button
                  className="schedule-tasks__btn"
                  onClick={() => gotoSession(m.sessionId)}
                  title={t('input.schedule.goto')}
                >
                  <span className="codicon codicon-arrow-right" />
                </button>
              )}
              {onReschedule && (
                <button
                  className="schedule-tasks__btn"
                  onClick={() => onReschedule(m)}
                  title={t('input.schedule.reschedule')}
                >
                  <span className="codicon codicon-edit" />
                </button>
              )}
              <button
                className="schedule-tasks__btn"
                onClick={() => cancelScheduled(m.id)}
                title={t('input.schedule.cancel')}
              >
                <span className="codicon codicon-close" />
              </button>
            </div>
          ))}
        </>
      )}
      {firedRecent.length > 0 && (
        <>
          <div className="schedule-tasks__group">{t('input.schedule.firedGroup')}</div>
          {firedRecent.map((f, i) => {
            // 提前执行（立即按钮触发早于原定时间）：主位改显实际执行时刻+提前标识，原定时间进悬停提示
            const early = f.firedAt < f.fireAt - 60_000
            return (
              <div key={`${f.sessionId}-${f.fireAt}-${i}`} className="schedule-tasks__row schedule-tasks__row--fired">
                <div className="schedule-tasks__main">
                  <span className="schedule-tasks__meta">
                    <span className="schedule-tasks__session">{sessionName(f.sessionId)}</span>
                    <span
                      className="schedule-tasks__time"
                      title={early ? `${t('input.schedule.origFireAt')} ${formatFireTime(f.fireAt, t)}` : undefined}
                    >
                      {early
                        ? `${formatFireTime(f.firedAt, t)} ${t('input.schedule.firedEarly')}`
                        : formatFireTime(f.fireAt, t)}
                    </span>
                  </span>
                  <span className="schedule-tasks__text" title={f.text}>
                    {f.text.replace(/\n/g, ' ')}
                  </span>
                </div>
                <button
                  className="schedule-tasks__btn"
                  onClick={() => gotoSession(f.sessionId)}
                  title={t('input.schedule.goto')}
                >
                  <span className="codicon codicon-arrow-right" />
                </button>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

/** 相对倒计时：<1min 即将执行；否则 Xh Ym / Ym */
function formatCountdown(ms: number, t: (k: string, opts?: Record<string, unknown>) => string): string {
  if (ms < 60_000) return t('input.schedule.countdownSoon')
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? t('input.schedule.countdownHM', { h, m }) : t('input.schedule.countdownM', { m })
}
