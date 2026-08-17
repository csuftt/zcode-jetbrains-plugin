/**
 * 历史列表项（cc-gui HistoryListItem 简化版）
 *
 *   ┌──────────────────────────────────────────┐
 *   │ 会话标题（active 蓝点）        时间 [🗑]  │  ← 删除按钮 hover 显现
 *   │ 12 条消息 · 45.2 KB · 运行中              │  ← meta 行（统计缺省时整行隐藏）
 *   └──────────────────────────────────────────┘
 * - hover：浅高亮
 * - active：标题前蓝点 ●，背景 accent 10%
 * - 大小超 1MB 橙色警示（上下文已很大，cc-gui history-filesize-large 同款）
 * - 删除：hover 显示 codicon-trash，点击进入"确认删除"（红色，3s 未确认自动恢复），再点触发删除
 */

import { memo, useEffect, useRef, useState, Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '@/types/messages'
import { relativeTime, formatFileSize } from '@/utils/time'
import '../styles/session-item.less'

interface Props {
  session: SessionInfo
  active: boolean
  onSelect: (session: SessionInfo) => void
  onDelete: (sessionId: string) => void
  /** 自定义标题渲染（搜索高亮用）*/
  renderTitle?: (title: string) => ReactNode
  /** 多选模式（cc-gui selection mode：显示 checkbox，点击切换选中）*/
  selectionMode?: boolean
  selected?: boolean
  onToggle?: (sessionId: string) => void
}

function SessionItemInner({
  session, active, onSelect, onDelete, renderTitle,
  selectionMode = false, selected = false, onToggle,
}: Props) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 卸载时清理确认定时器
  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
  }, [])

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation() // 不触发会话选中
    if (!confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 3000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    onDelete(session.sessionId)
  }

  const handleClick = () => {
    if (selectionMode) onToggle?.(session.sessionId)
    else onSelect(session)
  }

  const title = session.title || session.sessionId.slice(0, 12)

  return (
    <li
      className={`session-item ${active ? 'session-item--active' : ''} ${
        selectionMode ? 'selection-mode' : ''
      } ${selected ? 'selected' : ''}`}
      onClick={handleClick}
    >
      <div className="session-item__header">
        {selectionMode && (
          <span className="session-item__checkbox">
            <input
              type="checkbox"
              className="session-item__checkbox-input"
              checked={selected}
              onChange={() => onToggle?.(session.sessionId)}
              onClick={(e) => e.stopPropagation()}
            />
          </span>
        )}
        <div className="session-item__title">
          {!selectionMode && active && <span className="session-item__dot">●</span>}
          <span className="session-item__title-text">
            {renderTitle ? renderTitle(title) : title}
          </span>
        </div>
        <span className="session-item__time">{relativeTime(session.updatedAt)}</span>
        {!selectionMode && (
          <button
            type="button"
            className={`session-item__delete ${confirming ? 'session-item__delete--confirming' : ''}`}
            onClick={handleDelete}
            title={confirming ? t('history.confirmDeleteAgain') : t('history.deleteSession')}
          >
            {confirming ? (
              <span className="codicon codicon-check" style={{ color: 'var(--color-danger)' }} />
            ) : (
              <span className="codicon codicon-trash" />
            )}
          </button>
        )}
      </div>
      {/* meta 行：消息数 · 大小 · 运行中（统计缺省且非 running 时整行隐藏）*/}
      {(() => {
        const metaParts: ReactNode[] = []
        if (session.messageCount != null) {
          metaParts.push(<span key="cnt">{t('history.messageCount', { count: session.messageCount })}</span>)
        }
        if (session.sizeBytes != null && session.sizeBytes > 0) {
          metaParts.push(
            <span key="size" className={session.sizeBytes > 1024 * 1024 ? 'session-item__size-large' : ''}>
              {formatFileSize(session.sizeBytes)}
            </span>,
          )
        }
        if (session.status === 'running') {
          metaParts.push(<span key="run" className="session-item__status">{t('history.running')}</span>)
        }
        if (metaParts.length === 0) return null
        return (
          <div className="session-item__meta">
            {metaParts.map((part, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="session-item__meta-dot">·</span>}
                {part}
              </Fragment>
            ))}
          </div>
        )
      })()}
    </li>
  )
}

export const SessionItem = memo(SessionItemInner)
