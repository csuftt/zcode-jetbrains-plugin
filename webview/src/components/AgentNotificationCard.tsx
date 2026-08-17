/**
 * 子 agent / 任务回调通知卡片
 *
 * 渲染 app-server 注入的合成通知消息（详见 utils/parseNotification.ts）。
 * 与普通用户消息区分：左对齐独立卡片，正文走 MarkdownBlock，默认按长度决定折叠。
 *
 * 三种形态：
 *   - kind:'task' + subagent  后台子代理（run_in_background）完成，含 status/usage/result
 *   - kind:'task' + bash      后台 shell 命令（Bash run_in_background）完成——与子代理
 *                             共用 task-notification 通道，靠 resolveTaskSource 区分
 *   - kind:'message'          同步子代理中途回消息，含 agentType/message
 */

import { useMemo, useState } from 'react'
import type { ZCodeMessage, TextPart } from '@/types/messages'
import { MarkdownBlock } from './MarkdownBlock'
import {
  parseNotificationText,
  notificationTitle,
  resolveTaskSource,
  type ParsedNotification,
} from '@/utils/parseNotification'
import { formatToolDuration } from '@/utils/time'
import '../styles/notification-card.less'

interface Props {
  message: ZCodeMessage
  time: string
}

export function AgentNotificationCard({ message, time }: Props) {
  const { info, parts } = message
  // 合成通知只有一个 text part，内容是 XML
  const textPart = parts.find((p): p is TextPart => p.type === 'text')
  const text = textPart?.text ?? ''

  const parsed = useMemo<ParsedNotification>(() => parseNotificationText(text), [text])
  const title = notificationTitle(info, parsed)
  // 后台 bash 命令与子代理共用 task-notification 通道，按执行体类型分流文案/图标
  const src = resolveTaskSource(info, parsed)
  const label = src === 'subagent' ? '子代理' : src === 'bash' ? '后台命令' : '后台任务'
  const icon =
    src === 'bash' ? 'codicon-terminal' : src === 'subagent' ? 'codicon-hubot' : 'codicon-bell'

  const body = parsed.kind === 'task' ? parsed.result : parsed.kind === 'message' ? parsed.message : ''
  const hasBody = !!body && body.trim().length > 0
  // 短正文默认展开，长正文（>1500 字符，如完整架构文档）默认折叠避免刷屏
  const [expanded, setExpanded] = useState(!hasBody || body.length <= 1500)

  const usage = parsed.kind === 'task' ? parsed.usage : undefined
  // unknown（XML 解析不出）用中性徽标——兜底显示"完成"会误导读者（todo_reminder
  // 误判事故的放大器：识别层已收紧，这里再兜一层防御）
  const status = parsed.kind === 'task' ? parsed.status ?? 'completed'
    : parsed.kind === 'message' ? 'completed' : 'unknown'
  const badgeCls = status === 'completed' ? 'ok' : status === 'error' ? 'err' : 'info'
  const badgeText = status === 'completed' ? '✓ 完成' : status === 'error' ? '✗ 失败' : '通知'

  return (
    <div className={`notif-card notif-card--${badgeCls}`}>
      <div
        className="notif-card__header"
        onClick={() => hasBody && setExpanded((e) => !e)}
        role={hasBody ? 'button' : undefined}
      >
        <span className="notif-card__icon">
          <span className={`codicon ${icon}`} />
        </span>
        <span className="notif-card__label">{label}</span>
        <span className="notif-card__title" title={title}>{title}</span>
        <span className={`notif-card__badge notif-card__badge--${badgeCls}`}>{badgeText}</span>
        {usage?.durationMs != null && (
          <span className="notif-card__meta">⏱ {formatToolDuration(usage.durationMs)}</span>
        )}
        {usage?.tokens != null && (
          <span className="notif-card__meta">💡 {usage.tokens.toLocaleString()}</span>
        )}
        {parsed.kind === 'message' && parsed.agentType && (
          <span className="notif-card__meta">{parsed.agentType}</span>
        )}
        <span className="notif-card__time">{time}</span>
        {hasBody && <span className="notif-card__toggle">{expanded ? '▼' : '▶'}</span>}
      </div>
      {expanded && hasBody && (
        <div className="notif-card__body">
          <MarkdownBlock markdown={body} />
        </div>
      )}
    </div>
  )
}
