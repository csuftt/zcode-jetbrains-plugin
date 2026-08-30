/**
 * 历史视图（cc-gui HistoryView 移植 + 归档/回收站）
 *
 * 结构：
 *   .history-tabs：会话 / 已归档 tab 切换（归档是可逆的"收起"，已归档 tab 仅支持还原）
 *   .history-header
 *     ├─ .history-header-main：左侧信息条「共 N 个会话」/「已选择 N 个会话」
 *     │                       右侧工具栏（多选 + 刷新；多选模式按 tab 提供 归档/恢复所选 + 退出）
 *     └─ .history-search-container：搜索框（非多选模式显示，300ms 防抖 + mark 高亮）
 *   .history-list：会话列表（多选模式显示 checkbox）
 *
 * 操作语义：
 * - 会话 tab：日常操作=归档（可逆，SessionItem 内联二次确认）；多选=批量归档（modal 轻确认）
 * - 已归档 tab：仅还原（可逆，无确认）；点击已归档项不进入会话，恢复走专属还原按钮
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '@/types/messages'
import { SessionItem } from './SessionItem'
import { ConfirmDialog } from './ConfirmDialog'
import '../styles/history-view.less'

interface Props {
  sessions: SessionInfo[]
  archivedSessions: SessionInfo[]
  archivedLoading: boolean
  currentSessionId: string | null
  /**
   * 打开会话前的定位查询：resolve true = 该会话已有宿主标签且 Java 已激活跳转
   * （本标签只需切回聊天视图）；false = 没有任何标签打开过它
   */
  onLocate: (sessionId: string) => Promise<boolean>
  /** 「新标签页打开」选择：Java gotoSession 统一路径（定位已确认无宿主 → 必然新建标签）*/
  onOpenNewTab: (sessionId: string) => void
  onSelect: (session: SessionInfo) => void
  /** 切回 chat 视图 */
  onBack: () => void
  /** 归档（会话 tab，标记 time_archived，可恢复）*/
  onArchive: (sessionId: string) => void
  /** 恢复（已归档 tab，置 time_archived=NULL）*/
  onRestore: (sessionId: string) => void
  onRefresh: () => void
  /** 进入已归档 tab 时拉取列表 */
  onLoadArchived: () => void
}

/** 待确认的批量操作（归档/恢复共用 modal 确认）*/
type ConfirmAction = { type: 'archive' | 'restore'; ids: string[] }

/** 标题高亮（cc-gui highlightText：<mark> 标黄匹配词）*/
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const idx = lower.indexOf(q)
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ backgroundColor: '#ffd700', color: '#000' }}>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}

export function HistoryView({
  sessions,
  archivedSessions,
  archivedLoading,
  currentSessionId,
  onLocate,
  onOpenNewTab,
  onSelect,
  onBack,
  onArchive,
  onRestore,
  onRefresh,
  onLoadArchived,
}: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'active' | 'archived'>('active')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 多选模式状态（cc-gui selection mode）
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // 批量操作确认 modal（null = 不显示）
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  // 切换确认 modal（当前标签有会话时的打开方式选择，null = 不显示）
  const [switchTarget, setSwitchTarget] = useState<SessionInfo | null>(null)
  // 定位应答在途标记：模态未开前的 IPC 往返窗口内拦截重复点击
  const locatingRef = useRef(false)

  // 切到已归档 tab 时拉取列表（每次切换都刷新，保证归档项新鲜）
  useEffect(() => {
    if (tab === 'archived') onLoadArchived()
  }, [tab, onLoadArchived])

  // 搜索防抖 300ms
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query.trim().toLowerCase())
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  // 当前 tab 的数据源
  const list = tab === 'archived' ? archivedSessions : sessions

  const filtered = useMemo(() => {
    if (!debouncedQuery) return list
    return list.filter(
      (s) =>
        s.title.toLowerCase().includes(debouncedQuery) ||
        s.sessionId.toLowerCase().includes(debouncedQuery),
    )
  }, [list, debouncedQuery])

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((s) => selectedIds.has(s.sessionId))

  // 切 tab：清空多选 + 搜索（两套列表各自干净）
  const switchTab = (next: 'active' | 'archived') => {
    if (next === tab) return
    setTab(next)
    setSelectionMode(false)
    setSelectedIds(new Set())
    setQuery('')
    setDebouncedQuery('')
  }

  // ============ 多选操作 ============
  const toggleSelection = (sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        filtered.forEach((s) => next.delete(s.sessionId))
      } else {
        filtered.forEach((s) => next.add(s.sessionId))
      }
      return next
    })
  }

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }

  const handleItemClick = async (session: SessionInfo) => {
    if (selectionMode) {
      toggleSelection(session.sessionId)
      return
    }
    // 已归档会话：点击不进入会话，恢复走专属「还原」按钮（防止误触进入归档会话）
    if (tab === 'archived') return
    // 点当前会话：无操作，切回 chat 视图
    if (session.sessionId === currentSessionId) {
      onSelect(session)
      onBack()
      return
    }
    // 防抖：定位应答在途时忽略重复点击
    if (locatingRef.current) return
    locatingRef.current = true
    let found = false
    try {
      found = await onLocate(session.sessionId)
    } finally {
      locatingRef.current = false
    }
    // 任一标签已打开该会话 → Java 已激活那个标签（跨标签跳转），本标签切回聊天视图
    if (found) {
      onBack()
      return
    }
    // 当前标签无真实会话（新标签待命态）→ 直接在当前标签打开，无需打扰
    if (!currentSessionId) {
      onSelect(session)
      onBack()
      return
    }
    // 当前标签已有会话 → 让用户选：覆盖当前标签页 / 新标签页打开
    setSwitchTarget(session)
  }

  // ============ 批量操作确认 ============
  const requestArchiveSelected = () =>
    setConfirmAction({ type: 'archive', ids: [...selectedIds] })
  const requestRestoreSelected = () =>
    setConfirmAction({ type: 'restore', ids: [...selectedIds] })

  const execConfirmAction = () => {
    if (!confirmAction) return
    const { type, ids } = confirmAction
    if (type === 'archive') ids.forEach(onArchive)
    else ids.forEach(onRestore)
    setConfirmAction(null)
    exitSelectionMode()
  }

  const cancelConfirmAction = () => setConfirmAction(null)

  // 批量操作的文案
  const confirmModalProps = (() => {
    if (!confirmAction) return null
    const { type, ids } = confirmAction
    if (type === 'archive') {
      return {
        title: t('history.confirmArchiveTitle'),
        message: t('history.archiveConfirm', { count: ids.length }),
        confirmText: t('history.archive'),
        danger: false,
      }
    }
    return {
      title: t('history.confirmRestoreTitle'),
      message: t('history.restoreConfirm', { count: ids.length }),
      confirmText: t('history.restore'),
      danger: false,
    }
  })()

  return (
    <div className="history-view">
      <div className="history-header">
        {/* tab 切换：会话 / 已归档 */}
        <div className="history-tabs">
          <button
            className={`history-tab ${tab === 'active' ? 'history-tab--active' : ''}`}
            onClick={() => switchTab('active')}
          >
            {t('history.tabSessions')}
          </button>
          <button
            className={`history-tab ${tab === 'archived' ? 'history-tab--active' : ''}`}
            onClick={() => switchTab('archived')}
          >
            {t('history.tabArchived')}
          </button>
        </div>

        <div className="history-header-main">
          {selectionMode ? (
            <div className="history-selection-summary">{t('history.selectedSessions', { count: selectedIds.size })}</div>
          ) : (
            <div className="history-info">
              {tab === 'archived'
                ? t('history.archivedTotal', { count: archivedSessions.length })
                : t('history.totalSessions', { count: sessions.length })}
            </div>
          )}

          {/* 工具栏（cc-gui HistoryActions）*/}
          <div className="history-header-actions">
            {selectionMode ? (
              <>
                <button
                  className="history-toolbar-btn"
                  onClick={toggleSelectAllVisible}
                  disabled={filtered.length === 0}
                  title={allVisibleSelected ? t('history.clearSelection') : t('history.selectAll')}
                >
                  <span className={`codicon ${allVisibleSelected ? 'codicon-clear-all' : 'codicon-check-all'}`} />
                  <span>{allVisibleSelected ? t('history.clearSelection') : t('history.selectAll')}</span>
                </button>
                {tab === 'active' ? (
                  <button
                    className="history-toolbar-btn"
                    onClick={requestArchiveSelected}
                    disabled={selectedIds.size === 0}
                    title={t('history.archiveSelected')}
                  >
                    <span className="codicon codicon-archive" />
                    <span>{t('history.archiveSelected')}</span>
                  </button>
                ) : (
                  <button
                    className="history-toolbar-btn"
                    onClick={requestRestoreSelected}
                    disabled={selectedIds.size === 0}
                    title={t('history.restoreSelected')}
                  >
                    <span className="codicon codicon-unarchive" />
                    <span>{t('history.restoreSelected')}</span>
                  </button>
                )}
                <button
                  className="history-toolbar-btn"
                  onClick={exitSelectionMode}
                  title={t('history.exitMultiSelect')}
                >
                  <span className="codicon codicon-close" />
                </button>
              </>
            ) : (
              <>
                <button
                  className="history-toolbar-btn"
                  onClick={() => setSelectionMode(true)}
                  title={t('history.multiSelect')}
                >
                  <span className="codicon codicon-checklist" />
                  <span>{t('history.multiSelect')}</span>
                </button>
                <button
                  className="history-toolbar-btn"
                  onClick={tab === 'archived' ? onLoadArchived : onRefresh}
                  title={t('history.refresh')}
                >
                  <span className="codicon codicon-refresh" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* 搜索框（非多选模式显示，cc-gui HistoryFilters）*/}
        {!selectionMode && (
          <div className="history-search-container">
            <input
              type="text"
              className="history-search-input"
              placeholder={t('history.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="codicon codicon-search history-search-icon" />
          </div>
        )}
      </div>

      <div className="history-list">
        {tab === 'archived' && archivedLoading && archivedSessions.length === 0 ? (
          <div className="history-empty">{t('history.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="history-empty">
            {debouncedQuery
              ? t('history.noMatch')
              : tab === 'archived'
                ? t('history.archivedEmpty')
                : t('history.empty')}
          </div>
        ) : (
          <ul className="history-items">
            {filtered.map((s) => (
              <SessionItem
                key={s.sessionId}
                session={s}
                active={s.sessionId === currentSessionId}
                onSelect={handleItemClick}
                variant={tab === 'archived' ? 'archived' : 'active'}
                onArchive={onArchive}
                onRestore={onRestore}
                renderTitle={(title) => <Highlight text={title} query={debouncedQuery} />}
                selectionMode={selectionMode}
                selected={selectedIds.has(s.sessionId)}
                onToggle={toggleSelection}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 批量操作确认 modal（归档/恢复共用）*/}
      {confirmModalProps && (
        <ConfirmDialog
          title={confirmModalProps.title}
          message={confirmModalProps.message}
          confirmText={confirmModalProps.confirmText}
          danger={confirmModalProps.danger}
          onConfirm={execConfirmAction}
          onCancel={cancelConfirmAction}
        />
      )}

      {/* 打开方式选择 modal（当前标签已有会话：覆盖当前标签页 / 新标签页打开）*/}
      {switchTarget && (
        <ConfirmDialog
          title={t('history.openChoiceTitle')}
          message={t('history.openChoiceMessage', { title: switchTarget.title.slice(0, 30) })}
          confirmText={t('history.openHere')}
          extraText={t('history.openNewTab')}
          onConfirm={() => {
            const target = switchTarget
            setSwitchTarget(null)
            onSelect(target)
            onBack()
          }}
          onExtra={() => {
            const sid = switchTarget.sessionId
            setSwitchTarget(null)
            onOpenNewTab(sid)
            onBack()
          }}
          onCancel={() => setSwitchTarget(null)}
        />
      )}
    </div>
  )
}
