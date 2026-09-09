/**
 * 反向请求弹窗的应答超时倒计时（AskUserQuestion / ExitPlanMode 审批共用）
 *
 * Java 侧 interaction/requestUserInput 等待用户应答有 5 分钟超时（超时自动 decline
 * 并关弹窗），推送弹窗时随消息附带 deadlineMs（超时时刻，epoch 毫秒）。本组件据其
 * 显示剩余时间；deadlineMs 缺省（旧链路 / mock）时不渲染，秒级跳动复用 useTick。
 *
 * 另有 DialogElapsed：永远等待模式（提问自动继续关，无 deadlineMs）下的已等待
 * 正计时，起点为 store 收到 askUser 事件的时刻。
 */

import { useTranslation } from 'react-i18next'
import { useTick } from '@/hooks/useTick'
import { formatDuration } from '@/utils/time'
import '../styles/dialog-countdown.less'

interface Props {
  deadlineMs?: number
}

/** 剩余 ≤60s 的警示阈值（毫秒） */
const WARN_THRESHOLD_MS = 60_000

export function DialogCountdown({ deadlineMs }: Props) {
  const { t } = useTranslation()
  const now = useTick(deadlineMs != null, 1000)
  if (deadlineMs == null) return null
  const remain = deadlineMs - now
  if (remain <= 0) return null
  return (
    <span
      className={`dialog-countdown${remain <= WARN_THRESHOLD_MS ? ' dialog-countdown--warning' : ''}`}
      title={t('app.dialogCountdownTitle')}
    >
      <span className="codicon codicon-clock" />
      {t('app.dialogCountdown', { time: formatDuration(remain) })}
    </span>
  )
}

/** 永远等待模式的已等待正计时（无警示态；无起点数据时不渲染） */
export function DialogElapsed({ sinceMs }: { sinceMs?: number }) {
  const { t } = useTranslation()
  const now = useTick(sinceMs != null, 1000)
  if (sinceMs == null) return null
  return (
    <span className="dialog-countdown" title={t('app.dialogElapsedTitle')}>
      <span className="codicon codicon-clock" />
      {t('app.dialogElapsed', { time: formatDuration(now - sinceMs) })}
    </span>
  )
}
