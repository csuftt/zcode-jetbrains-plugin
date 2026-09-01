/**
 * /compact 压缩摘要卡片
 *
 * 压缩摘要消息（role=user + info.summary）的专门渲染（2026-08-21 RPC 实测）：
 * 不当用户气泡（8k+ 字符摘要塞右对齐蓝气泡的视觉灾难），改为左对齐单行卡——
 * 头部一行元信息（标题 + 被摘要消息数），点击弹出全文弹窗阅读
 * （壳复用子代理报告弹窗样式，图标同用书本 codicon-book）。
 *
 * token 元信息优先取 compaction part 的 compactBoundary（摘要消息自带），
 * 缺失时退化为纯标题行（boundary 是压缩点固有产物，正常都在）。
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { ZCodeMessage, CompactionPart } from '@/types/messages'
import { MarkdownBlock } from './MarkdownBlock'
import { ScrollJumpButton } from './ScrollJumpButton'
import '../styles/compaction.less'

interface Props {
  message: ZCodeMessage
  time: string
}

export function CompactionSummaryCard({ message, time }: Props) {
  const { t } = useTranslation()
  const { info, parts } = message
  const body = info.summary?.body ?? ''
  const [open, setOpen] = useState(false)

  const boundary = parts.find(
    (p): p is CompactionPart => p.type === 'compaction',
  )?.compactBoundary
  const count = boundary?.summarizedMessageCount

  return (
    <div className="compact-card">
      <div
        className="compact-card__header"
        onClick={() => setOpen(true)}
        role="button"
        title={t('chat.compaction.viewSummary')}
      >
        <span className="compact-card__icon">
          <span className="codicon codicon-book" />
        </span>
        <span className="compact-card__label">{t('chat.compaction.title')}</span>
        {count != null && (
          <span className="compact-card__meta">
            {t('chat.compaction.messagesSummarized', { count })}
          </span>
        )}
        <span className="compact-card__time">{time}</span>
        <span className="codicon codicon-chevron-right compact-card__toggle" />
      </div>
      {open && (
        <CompactionSummaryDialog
          body={body}
          count={count}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * 摘要全文阅读弹窗：portal 挂 body（脱离 messages-container，
 * 不进会话内搜索的 TreeWalker 范围），壳复用子代理报告弹窗样式
 * （subagent-detail-overlay/dialog/header + MarkdownBlock 正文）。
 */
function CompactionSummaryDialog({
  body,
  count,
  onClose,
}: {
  body: string
  count: number | undefined
  onClose: () => void
}) {
  const { t } = useTranslation()
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="subagent-detail-overlay" onClick={onClose}>
      <div className="subagent-detail-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="subagent-detail-header">
          <span className="codicon codicon-book subagent-detail-header__icon" />
          <div className="subagent-detail-header__main">
            <span className="subagent-detail-header__title">
              {t('chat.compaction.title')}
            </span>
            <div className="subagent-detail-header__meta">
              <span className="subagent-detail-meta-item">
                {count != null
                  ? t('chat.compaction.messagesSummarized', { count })
                  : t('chat.compaction.viewSummary')}
              </span>
            </div>
          </div>
          <button className="subagent-detail-icon-btn" data-tip={t('tool.close')} onClick={onClose}>
            <span className="codicon codicon-chrome-close" />
          </button>
        </div>
        <div className="subagent-detail-body subagent-report-body" ref={bodyRef}>
          <MarkdownBlock markdown={body} />
        </div>
        {/* 滚动跳转按钮（↑置顶/↓置底，对齐主界面）：长摘要快速回顶/到底 */}
        <ScrollJumpButton containerRef={bodyRef} />
      </div>
    </div>,
    document.body,
  )
}
