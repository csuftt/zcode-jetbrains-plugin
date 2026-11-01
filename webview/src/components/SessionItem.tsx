/**
 * 历史列表项（cc-gui HistoryListItem 简化版）
 *
 *   ┌──────────────────────────────────────────┐
 *   │ 会话标题（active 蓝点）        时间 [📦]  │  ← 归档/还原按钮 hover 显现
 *   │ 12 条消息 · 45.2 KB · 运行中              │  ← meta 行（统计未就绪 * 占位；就绪后仍缺省且非 running 时整行隐藏）
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
 * - 置顶（active 变体）：hover 显示 codicon-pin；置顶后 codicon-pinned 常显（列表
 *   置顶排序由 HistoryView 承担）。可逆轻操作，无确认
 * - 点击 archived 变体项不进入会话（HistoryView 拦截），操作走专属还原/删除按钮
 */

import { memo, useEffect, useRef, useState, Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '@/types/messages'
import { relativeTime, formatFileSize } from '@/utils/time'
import { useStore } from '@/store/useStore'
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
  /** 置顶切换（active 模式；可逆轻操作，无确认——写库后广播回调统一刷新）*/
  onTogglePin?: (sessionId: string, pinned: boolean) => void
  /** 当前是否置顶（图标常显 + 列表置顶排序由父级承担）*/
  pinned?: boolean
  /** 未读标记（tasks-index unread_at：后台终态且无标签在看；标题前蓝点，打开即清）*/
  unread?: boolean
  /** 已在该名称的标签打开（历史列表行内标记，undefined 不渲染；点击确认由父级承担）*/
  openTabName?: string
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
  session, active, onSelect, onArchive, onRestore, onDelete, onTogglePin, pinned = false, unread = false, openTabName,
  renderTitle,
  variant = 'active',
  selectionMode = false, selected = false, onToggle,
}: Props) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 待交互数（审批/提问挂起）：红点角标。本地方案数据源（协议客户端反向请求计数，
  // pendingInteractions 推送）；0/无键不渲染
  const pendingCount = useStore((s) => s.pendingInteractionCounts[session.sessionId]) ?? 0
  // 列表统计（消息数/大小）就绪标志：未就绪（列表先渲染、后台 stats 算完经 patch 合并前）
  // meta 行以 * 占位，防止统计到达时整行从无到有引发布局跳动
  const statsReady = useStore((s) => s.sessionStatsReady)

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

  const handleTogglePin = (e: React.MouseEvent) => {
    e.stopPropagation() // 不触发会话选中
    onTogglePin?.(session.sessionId, !pinned)
  }

  const title = session.title || session.sessionId.slice(0, 12)

  return (
    <li
      className={`session-item ${active ? 'session-item--active' : ''} ${
        selectionMode ? 'selection-mode' : ''
      } ${selected ? 'selected' : ''} ${unread ? 'session-item--unread' : ''}`}
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
          {/* 未读蓝点优先于 active 灰点（未读会话被打开即清，两者共存窗口极小）*/}
          {!selectionMode && unread && <span className="session-item__unread-dot" />}
          {!selectionMode && !unread && active && <span className="session-item__dot">●</span>}
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
          {pendingCount > 0 && (
            <span className="session-item__pending-badge" title={t('history.pendingBadge', { count: pendingCount })}>
              {pendingCount > 9 ? '9+' : pendingCount}
            </span>
          )}
          {openTabName && <span className="session-item__open-tab">{openTabName}</span>}
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
              <>
                <button
                  type="button"
                  className={`session-item__action session-item__pin ${pinned ? 'session-item__pin--pinned' : ''}`}
                  onClick={handleTogglePin}
                  title={pinned ? t('history.unpin') : t('history.pin')}
                >
                  <span className={`codicon ${pinned ? 'codicon-pinned' : 'codicon-pin'}`} />
                </button>
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
              </>
            )}
          </div>
        )}
      </div>
      {/* meta 行：消息数 · 大小 · 运行中（统计未就绪渲染 * 占位防布局跳动；统计缺省
          （就绪后仍无，如乐观新建会话）且非 running 时整行隐藏）*/}
      {(() => {
        const metaParts: ReactNode[] = []
        const statsPending =
          !statsReady && session.messageCount == null && session.sizeBytes == null
        if (statsPending) {
          // 统计未就绪（列表响应不等后台 stats 计算）：数字以 * 占位，patch 合并后换真值
          metaParts.push(
            <span key="placeholder" className="session-item__meta-placeholder">
              {t('history.statsPlaceholder')}
            </span>,
          )
        }
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
