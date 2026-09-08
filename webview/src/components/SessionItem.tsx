/**
 * 历史列表项（cc-gui HistoryListItem 简化版）
 *
 *   ┌──────────────────────────────────────────┐
 *   │ 会话标题（active 蓝点）        时间 [📦]  │  ← 归档/还原按钮 hover 显现
 *   │ 12 条消息 · 45.2 KB · 运行中              │  ← meta 行（统计缺省时整行隐藏）
 *   └──────────────────────────────────────────┘
 * - hover：浅高亮
 * - active：标题前蓝点 ●，背景 accent 10%
 * - 大小超 1MB 橙色警示（上下文已很大，cc-gui history-filesize-large 同款）
 * - 归档（active 变体）：hover 显示 codicon-archive，点击进入"确认归档"（强调色，
 *   3s 未确认自动恢复），再点触发归档；归档可逆，可在「已归档」中还原
 * - 还原（archived 变体）：hover 显示 codicon-unarchive，点击进入"确认还原"（强调色，
 *   3s 未确认自动恢复），再点触发恢复；恢复可逆
 * - 删除（archived 变体）：hover 显示 codicon-trash，点击直接回调 onDelete（确认由
 *   HistoryView 的 danger modal 承担——删除语义重于还原，不走 3s 内联轻确认）
 * - 点击 archived 变体项不进入会话（HistoryView 拦截），操作走专属还原/删除按钮
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
  /** 归档（active 模式；可逆，内联二次确认）*/
  onArchive?: (sessionId: string) => void
  /** 恢复（archived 模式；可逆，无确认）*/
  onRestore?: (sessionId: string) => void
  /** 删除（archived 模式；软删，确认由父级 danger modal 承担）*/
  onDelete?: (sessionId: string) => void
  /** active=历史会话（默认）/ archived=已归档（回收站）*/
  variant?: 'active' | 'archived'
  /** 自定义标题渲染（搜索高亮用）*/
  renderTitle?: (title: string) => ReactNode
  /** 多选模式（cc-gui selection mode：显示 checkbox，点击切换选中）*/
  selectionMode?: boolean
  selected?: boolean
  onToggle?: (sessionId: string) => void
}

function SessionItemInner({
  session, active, onSelect, onArchive, onRestore, onDelete, renderTitle,
  variant = 'active',
  selectionMode = false, selected = false, onToggle,
}: Props) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 卸载时清理确认定时器
  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
  }, [])

  // 归档（active 模式）：内联二次确认，3s 未确认自动恢复（防误触；归档可逆）
  const handleArchive = (e: React.MouseEvent) => {
    e.stopPropagation() // 不触发会话选中
    if (!confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 3000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirming(false)
    onArchive?.(session.sessionId)
  }

  // 恢复（archived 模式）：内联二次确认，3s 未确认自动恢复（防误触；恢复可逆）
  const handleRestore = (e: React.MouseEvent) => {
    e.stopPropagation() // 不触发会话选中
    if (!confirming) {
      setConfirming(true)
      confirmTimer.current = setTimeout(() => setConfirming(false), 3000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirming(false)
    onRestore?.(session.sessionId)
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
          {session.sessionKind === 'fork' && (
            <span
              className="codicon codicon-git-branch session-item__fork-badge"
              style={{ fontSize: '12px' }}
              title={t('history.forkedSession')}
            />
          )}
          {session.goalTarget && (
            <span
              className="codicon codicon-target session-item__fork-badge"
              style={{ fontSize: '12px' }}
              title={t('history.goalSession')}
            />
          )}
        </div>
        <span className="session-item__time">
          {relativeTime(variant === 'archived' ? (session.archivedAt ?? session.updatedAt) : session.updatedAt)}
        </span>
        {!selectionMode && (
          <div className="session-item__actions">
            {variant === 'archived' ? (
              <>
                <button
                  type="button"
                  className={`session-item__action session-item__restore ${confirming ? 'session-item__restore--confirming' : ''}`}
                  onClick={handleRestore}
                  title={confirming ? t('history.confirmRestoreAgain') : t('history.restore')}
                >
                  {confirming ? (
                    <span className="codicon codicon-check" style={{ color: 'var(--accent-primary)' }} />
                  ) : (
                    <span className="codicon codicon-unarchive" />
                  )}
                </button>
                {onDelete && (
                  <button
                    type="button"
                    className="session-item__action session-item__delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(session.sessionId)
                    }}
                    title={t('history.delete')}
                  >
                    <span className="codicon codicon-trash" />
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className={`session-item__action session-item__archive ${confirming ? 'session-item__archive--confirming' : ''}`}
                onClick={handleArchive}
                title={confirming ? t('history.confirmArchiveAgain') : t('history.archive')}
              >
                {confirming ? (
                  <span className="codicon codicon-check" style={{ color: 'var(--accent-primary)' }} />
                ) : (
                  <span className="codicon codicon-archive" />
                )}
              </button>
            )}
          </div>
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
