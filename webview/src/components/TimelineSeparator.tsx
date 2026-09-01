/**
 * 时间线分隔符（timeline part 渲染）
 *
 * marker 消息（role=assistant + timeline part）的专门渲染：官方语义
 * display:"separator"——横线 + 居中短文案，标记聊天流的结构性事件。
 * 已实测两类（2026-08-21 RPC 抓包）：
 *   - context_compaction：上下文已压缩（token 收缩指标）
 *   - model_change：模型切换（from → to）
 * 未知 timelineType 退化为中性「时间线事件」，不吞不炸。
 */

import { useTranslation } from 'react-i18next'
import type { TimelinePart } from '@/types/messages'
import { compactTokens } from '@/utils/time'
import '../styles/compaction.less'

interface Props {
  part: TimelinePart
}

export function TimelineSeparator({ part }: Props) {
  const { t } = useTranslation()

  if (part.timelineType === 'context_compaction') {
    const pre = part.preCompactTokenCount
    const post = part.truePostCompactTokenCount ?? part.postCompactTokenCount
    return (
      <div className="tl-sep">
        <span className="tl-sep__line" />
        <span className="tl-sep__text">
          <span className="codicon codicon-compress" />
          {t('chat.compaction.title')}
          {pre != null && post != null && (
            <span className="tl-sep__meta" title={`${pre.toLocaleString()} → ${post.toLocaleString()}`}>
              {' '}{compactTokens(pre)} → {compactTokens(post)} tokens
            </span>
          )}
        </span>
        <span className="tl-sep__line" />
      </div>
    )
  }

  if (part.timelineType === 'model_change') {
    const from = part.fromModel?.label ?? part.fromModel?.modelID
    const to = part.toModel?.label ?? part.toModel?.modelID
    return (
      <div className="tl-sep">
        <span className="tl-sep__line" />
        <span className="tl-sep__text">
          <span className="codicon codicon-arrow-swap" />
          {t('chat.timeline.modelChanged')}
          {from && to && <span className="tl-sep__meta">{`${from} → ${to}`}</span>}
        </span>
        <span className="tl-sep__line" />
      </div>
    )
  }

  return (
    <div className="tl-sep">
      <span className="tl-sep__line" />
      <span className="tl-sep__text">{t('chat.timeline.event')}</span>
      <span className="tl-sep__line" />
    </div>
  )
}
