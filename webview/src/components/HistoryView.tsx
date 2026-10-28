/**
 * 历史视图（cc-gui HistoryView 移植 + 归档/回收站 + 自动归档）
 *
 * 结构：
 *   .history-tabs：会话 / 已归档 / 自动归档 tab 切换（归档是可逆的"收起"，已归档 tab
 *                 支持还原+软删；自动归档 tab 承载配置/手动扫描/归档记录面板）
 *   .history-header
 *     ├─ .history-header-main：左侧信息条「共 N 个会话」/「已选择 N 个会话」
 *     │                       右侧工具栏（多选 + 刷新；多选模式按 tab 提供 归档/恢复/删除所选 + 退出）
 *     └─ .history-search-container：搜索框（非多选模式显示，300ms 防抖 + mark 高亮）
 *   .history-list：会话列表（多选模式显示 checkbox）；自动归档 tab 渲染 AutoArchivePanel
 *
 * 操作语义：
 * - 会话 tab：日常操作=归档（可逆，SessionItem 内联二次确认）；多选=批量归档（modal 轻确认）
 * - 已归档 tab：还原（可逆，无确认）+ 删除（软删对齐 ZCode 客户端：tasks.deleted=1 数据保留，
 *   两端列表同步隐藏；语义重于还原，走 modal danger 确认，条目级与批量共用）
 * - 自动归档 tab：开关+保留天数与 ZCode 客户端共享配置；手动立即扫描；归档记录展开看详情
 * - 点击已归档项不进入会话，操作走专属还原/删除按钮
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionInfo, OpenTabInfo } from '@/types/messages'
import { SessionItem } from './SessionItem'
import { ConfirmDialog } from './ConfirmDialog'
import { AutoArchivePanel } from './AutoArchivePanel'
import { sortSessionsByPin } from '@/utils/sessionPinSort'
import { wsBasename } from '@/utils/format'
import '../styles/history-view.less'

interface Props {
  sessions: SessionInfo[]
  /** 切目录加载中（多目录会话：清空旧列表 + 动画，防旧目录残留误导）*/
  sessionsLoading?: boolean
  archivedSessions: SessionInfo[]
  archivedLoading: boolean
  currentSessionId: string | null
  /**
   * 打开会话前的定位查询：resolve true = 该会话已有宿主标签且 Java 已激活跳转
   * （本标签只需切回聊天视图）；false = 没有任何标签打开过它
   */
  onLocate: (sessionId: string) => Promise<boolean>
  /** 当前各标签已绑定的会话快照（行标「会话N」+ 点击已开项先确认再跳；瞬态查询不入 state）*/
  onLoadOpenTabs: () => Promise<OpenTabInfo[]>
  /** 「新标签页打开」选择：Java gotoSession 统一路径（定位已确认无宿主 → 必然新建标签）。
   *  workspacePath（多目录会话）：会话所属目录随标签注入，新标签按它拉列表才能恢复 */
  onOpenNewTab: (sessionId: string, workspacePath?: string) => void
  onSelect: (session: SessionInfo) => void
  /** 切回 chat 视图 */
  onBack: () => void
  /** 归档（会话 tab，标记 time_archived，可恢复）*/
  onArchive: (sessionId: string) => void
  /** 恢复（已归档 tab，置 time_archived=NULL）*/
  onRestore: (sessionId: string) => void
  /** 删除（已归档 tab，软删对齐 ZCode 客户端：数据保留，两端列表同步隐藏）*/
  onDeleteArchived: (sessionId: string) => void
  /** 置顶/取消置顶（会话 tab；写 tasks-index pinned 位，广播回调更新状态）*/
  onTogglePin: (sessionId: string, pinned: boolean) => void
  /** 置顶会话 id 集（列表置顶排序 + SessionItem 图标态）*/
  pinnedSessionIds: string[]
  /** 未读会话 id 集（列表蓝点 + 标题加粗；打开会话即清）*/
  unreadSessionIds: string[]
  onRefresh: () => void
  /** 进入已归档 tab 时拉取列表 */
  onLoadArchived: () => void
  /** 关联目录列表（多目录会话·变体A：chips 渲染；project 级 kv 持久化）*/
  linkedWorkspaces: string[]
  /** 激活目录（chips 高亮 + 列表/新建会话落位；空=本项目）*/
  activeWorkspacePath: string
  /** 本项目根（常驻第一个 chip，带徽标不可移除）*/
  projectWorkspacePath: string
  /** 切换激活目录（chips 点击）*/
  onSwitchWorkspace: (path: string) => void
  /** 添加关联目录（⊕：Java 弹系统目录选择框，应答带 added 自动切换）*/
  onAddWorkspace: () => void
  /** 移除关联目录（chip hover ×；若移除的是激活目录由 store 回退本项目）*/
  onRemoveWorkspace: (path: string) => void
  /** 新建会话（chips 行按钮）：进待命态并切回聊天视图，落位=当前浏览目录 */
  onNewSession: () => void
}

/** 待确认的批量操作（归档/恢复/删除共用 modal 确认；删除为 danger 样式）*/
type ConfirmAction = { type: 'archive' | 'restore' | 'delete'; ids: string[] }

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
      <mark style={{ backgroundColor: '#ffd700', color: '#000' }}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

/** 目录归一比较（与 store normalizeWsPath 同口径；此处独立小函数避免跨模块测试依赖）*/
function wsSame(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function HistoryView({
  sessions,
  sessionsLoading = false,
  archivedSessions,
  archivedLoading,
  currentSessionId,
  onLocate,
  onLoadOpenTabs,
  onOpenNewTab,
  onSelect,
  onBack,
  onArchive,
  onRestore,
  onDeleteArchived,
  onTogglePin,
  pinnedSessionIds,
  unreadSessionIds,
  onRefresh,
  onLoadArchived,
  linkedWorkspaces = [],
  activeWorkspacePath = '',
  projectWorkspacePath = '',
  onSwitchWorkspace = () => {},
  onAddWorkspace = () => {},
  onRemoveWorkspace = () => {},
  onNewSession = () => {},
}: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'active' | 'archived' | 'auto'>('active')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 多选模式状态（cc-gui selection mode）
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // 批量操作确认 modal（null = 不显示）
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  // 待二次确认移除的关联目录（点 × 先弹确认，防误触——用户定稿 2026-10-28）
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  // 关联目录编辑模式（用户定稿 2026-10-28）：× 随 hover 显示会让 chip 宽度变化导致
  // 换行抖动，删除又是低频操作——加独立管理开关，编辑态下 × 才常显
  const [wsEditing, setWsEditing] = useState(false)
  // 切换确认 modal（当前标签有会话时的打开方式选择，null = 不显示）
  const [switchTarget, setSwitchTarget] = useState<SessionInfo | null>(null)
  // 跳转确认 modal（点击已在其他标签打开的会话：先确认再跳，防标题相似误点）
  const [jumpTarget, setJumpTarget] = useState<SessionInfo | null>(null)
  // 定位应答在途标记：模态未开前的 IPC 往返窗口内拦截重复点击
  const locatingRef = useRef(false)

  // 各标签已绑定会话的瞬态快照（sessionId → 标签名）：仅本组件局部 state，挂载/手动刷新时查一次
  const [openTabMap, setOpenTabMap] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    let cancelled = false
    onLoadOpenTabs().then((tabs) => {
      if (!cancelled) setOpenTabMap(new Map(tabs.map((x) => [x.sessionId, x.tabName])))
    })
    return () => {
      cancelled = true
    }
  }, [onLoadOpenTabs])
  const refreshOpenTabs = () => {
    onLoadOpenTabs().then((tabs) => setOpenTabMap(new Map(tabs.map((x) => [x.sessionId, x.tabName]))))
  }

  // 切到已归档 tab 时拉取列表（每次切换都刷新，保证归档项新鲜）；
  // activeWorkspacePath 入依赖：归档 tab 内切目录也要跟随刷新（store 切目录只清空
  // archivedSessions 并重拉普通列表，归档靠这里补拉。切目录同步置 sessionsWorkspace，
  // 归档响应的乱序守卫即时认新目录，不会被误丢——真机 2026-10-28：归档列表停在旧目录）
  useEffect(() => {
    if (tab === 'archived') onLoadArchived()
  }, [tab, onLoadArchived, activeWorkspacePath])

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
    const base = debouncedQuery
      ? list.filter(
          (s) =>
            s.title.toLowerCase().includes(debouncedQuery) ||
            s.sessionId.toLowerCase().includes(debouncedQuery),
        )
      : list
    // 置顶分层（仅会话 tab；归档页无置顶概念）。上游已按 updatedAt 倒序，组内保序
    return tab === 'active' ? sortSessionsByPin(base, pinnedSessionIds, (s) => s.sessionId) : base
  }, [list, debouncedQuery, tab, pinnedSessionIds])

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((s) => selectedIds.has(s.sessionId))

  // 切 tab：清空多选 + 搜索（各 tab 各自干净）
  const switchTab = (next: 'active' | 'archived' | 'auto') => {
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

  // 定位+打开的实际流程：已开项确认后与未开项共用（found 路径只激活目标标签，不向其 webview 推送，
  // 目标页输入草稿与进行中的回合都不受影响）
  const proceedOpen = async (session: SessionInfo) => {
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
    // 已在其他标签打开：先确认再跳（列表行有同名标签标记，双重防标题相似误点）
    if (openTabMap.has(session.sessionId)) {
      setJumpTarget(session)
      return
    }
    await proceedOpen(session)
  }

  // ============ 批量操作确认 ============
  const requestArchiveSelected = () =>
    setConfirmAction({ type: 'archive', ids: [...selectedIds] })
  const requestRestoreSelected = () =>
    setConfirmAction({ type: 'restore', ids: [...selectedIds] })
  const requestDeleteSelected = () =>
    setConfirmAction({ type: 'delete', ids: [...selectedIds] })
  // 条目级删除：与批量共用 modal 确认（删除语义重，不用还原那套 3s 内联轻确认）
  const requestDeleteArchived = (sessionId: string) =>
    setConfirmAction({ type: 'delete', ids: [sessionId] })

  const execConfirmAction = () => {
    if (!confirmAction) return
    const { type, ids } = confirmAction
    // forEach 回调收 (item, index, array) 三参，箭头收窄避免透传给下游（mock/转发场景会暴露）
    if (type === 'archive') ids.forEach((id) => onArchive(id))
    else if (type === 'restore') ids.forEach((id) => onRestore(id))
    else ids.forEach((id) => onDeleteArchived(id))
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
    if (type === 'delete') {
      return {
        title: t('history.confirmDeleteTitle'),
        message: t('history.deleteConfirm', { count: ids.length }),
        confirmText: t('history.delete'),
        danger: true,
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
      {/* 关联目录 chips 行（多目录会话·方案B定稿 2026-10-28）：左侧目录 chips 独立换行
          （__flow flex:1），右侧动作区固定第一行最右（__actions 不换行）——添加/编辑/
          新建三钮位置稳定不随目录数量漂移。常驻渲染（含空态）——添加目录是关联第一个
          目录的唯一入口，空态藏行=功能不可达（首版真机踩坑）*/}
      <div className={`history-ws-chips ${wsEditing ? 'history-ws-chips--editing' : ''}`}>
        <div className="history-ws-chips__flow">
          <button
            type="button"
            className={`history-ws-chip history-ws-chip--project ${wsSame(activeWorkspacePath || projectWorkspacePath, projectWorkspacePath) ? 'history-ws-chip--active' : ''}`}
            data-tooltip={projectWorkspacePath}
            onClick={() => onSwitchWorkspace(projectWorkspacePath)}
          >
            <span className="history-ws-chip__name">{t('history.wsChips.project')}</span>
          </button>
          {linkedWorkspaces.map((ws) => {
            const active = wsSame(activeWorkspacePath || projectWorkspacePath, ws)
            return (
              <button
                type="button"
                key={ws}
                className={`history-ws-chip ${active ? 'history-ws-chip--active' : ''}`}
                data-tooltip={ws}
                onClick={() => onSwitchWorkspace(ws)}
              >
                <span className="history-ws-chip__name">{wsBasename(ws)}</span>
                <span
                  className="history-ws-chip__remove codicon codicon-close"
                  title={t('history.wsChips.remove')}
                  onClick={(e) => {
                    e.stopPropagation()
                    setRemoveTarget(ws)
                  }}
                />
              </button>
            )
          })}
        </div>
        <div className="history-ws-chips__actions">
          {/* 管理开关（用户定稿 2026-10-28）：× 随 hover 显隐会让 chip 宽度变化挤出换行；
              编辑态下各关联目录 chip 的 × 才常显，删除仍走二次确认 */}
          <button
            type="button"
            className={`history-ws-chip history-ws-chip--edit ${wsEditing ? 'history-ws-chip--edit-active' : ''}`}
            data-tooltip={t('history.wsChips.editTitle')}
            onClick={() => setWsEditing((v) => !v)}
          >
            <span className="codicon codicon-edit" />
          </button>
          {/* 添加关联目录：图标钮（folder+ 消加号歧义），悬浮 data-tooltip 说明（定稿 2026-10-28：去文字只留图标）*/}
          <button
            type="button"
            className="history-ws-chip history-ws-chip--add"
            data-tooltip={t('history.wsChips.addTitle')}
            onClick={onAddWorkspace}
          >
            <span className="codicon codicon-new-folder" />
          </button>
        </div>
      </div>
      <div className="history-header">
        {/* tab 切换：会话 / 已归档；右端「新建会话」实底主钮（方案B定稿：与列表同视野，
            建的就是当前浏览目录的会话；自动归档 tab 无列表不显示，多选模式让位批量操作） */}
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
          <button
            className={`history-tab ${tab === 'auto' ? 'history-tab--active' : ''}`}
            onClick={() => switchTab('auto')}
          >
            {t('history.tabAutoArchive')}
          </button>
          {tab !== 'auto' && !selectionMode && (
            <>
              <span className="history-tabs__sp" />
              <button
                type="button"
                className="history-tabs__new"
                data-tooltip={t('history.wsChips.newSession')}
                onClick={onNewSession}
              >
                <span className="codicon codicon-plus" />
                <span>{t('history.wsChips.newSession')}</span>
              </button>
            </>
          )}
        </div>

        {/* 自动归档 tab：不显示列表工具栏/搜索（面板自成一体，挂在 header 外的主体区） */}
        {tab !== 'auto' && (
          <>
        <div className="history-header-main">
          {selectionMode ? (
            <div className="history-selection-summary">{t('history.selectedSessions', { count: selectedIds.size })}</div>
          ) : (
            <div className="history-info">
              {tab === 'archived'
                ? t('history.archivedTotal', { count: archivedSessions.length })
                : t('history.totalSessions', { count: sessions.length })}
              {/* 浏览目录全路径（本项目也显示，风格一致；悬浮同值）*/}
              <span className="history-info__ws" data-tooltip={activeWorkspacePath || projectWorkspacePath}>
                {activeWorkspacePath || projectWorkspacePath}
              </span>
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
                  <>
                    <button
                      className="history-toolbar-btn"
                      onClick={requestRestoreSelected}
                      disabled={selectedIds.size === 0}
                      title={t('history.restoreSelected')}
                    >
                      <span className="codicon codicon-unarchive" />
                      <span>{t('history.restoreSelected')}</span>
                    </button>
                    <button
                      className="history-toolbar-btn"
                      onClick={requestDeleteSelected}
                      disabled={selectedIds.size === 0}
                      title={t('history.deleteSelected')}
                    >
                      <span className="codicon codicon-trash" />
                      <span>{t('history.deleteSelected')}</span>
                    </button>
                  </>
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
                  onClick={() => {
                    if (tab === 'archived') onLoadArchived()
                    else onRefresh()
                    refreshOpenTabs()
                  }}
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
          </>
        )}
      </div>

      {tab === 'auto' ? <AutoArchivePanel /> : (
      <div className="history-list">
        {tab === 'active' && sessionsLoading ? (
          /* 切目录加载中（用户定稿：切换即清空旧列表 + 加载动画，防旧目录列表误导）*/
          <div className="history-empty history-loading">
            <span className="codicon codicon-loading codicon-modifier-spin" />
            {t('history.loading')}
          </div>
        ) : tab === 'archived' && (archivedLoading || sessionsLoading) && archivedSessions.length === 0 ? (
          /* sessionsLoading 并入：切目录瞬间归档请求还没发出（effect 在渲染后跑），
             借切目录加载态占位，防「回收站为空」闪一帧再跳加载动画 */
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
            {filtered.map((s) => {
              const pinned = tab === 'active' && pinnedSessionIds.includes(s.sessionId)
              return (
                <SessionItem
                  key={s.sessionId}
                  session={s}
                  active={s.sessionId === currentSessionId}
                  onSelect={handleItemClick}
                  variant={tab === 'archived' ? 'archived' : 'active'}
                  onArchive={onArchive}
                  onRestore={onRestore}
                  onDelete={tab === 'archived' ? requestDeleteArchived : undefined}
                  pinned={pinned}
                  unread={tab === 'active' && unreadSessionIds.includes(s.sessionId)}
                  openTabName={tab === 'active' ? openTabMap.get(s.sessionId) : undefined}
                  onTogglePin={tab === 'active' ? onTogglePin : undefined}
                  renderTitle={(title) => <Highlight text={title} query={debouncedQuery} />}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(s.sessionId)}
                  onToggle={toggleSelection}
                />
              )
            })}
          </ul>
        )}
      </div>
      )}

      {/* 批量操作确认 modal（归档/恢复/删除共用）*/}
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

      {/* 移除关联目录二次确认（× hover 显示 + 误触防护，用户定稿 2026-10-28）*/}
      {removeTarget && (
        <ConfirmDialog
          title={t('history.wsChips.removeConfirmTitle')}
          message={t('history.wsChips.removeConfirmMessage', { name: wsBasename(removeTarget) })}
          confirmText={t('history.wsChips.remove')}
          onConfirm={() => {
            const target = removeTarget
            setRemoveTarget(null)
            onRemoveWorkspace(target)
          }}
          onCancel={() => setRemoveTarget(null)}
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
            const target = switchTarget
            setSwitchTarget(null)
            // 会话自身目录随标签传递（多目录会话）：新标签 boot 首拉按它过滤才能恢复
            onOpenNewTab(target.sessionId, target.workspacePath)
            onBack()
          }}
          onCancel={() => setSwitchTarget(null)}
        />
      )}

      {/* 跳转确认 modal（会话已在其他标签打开：确认后才激活那个标签）*/}
      {jumpTarget && (
        <ConfirmDialog
          title={t('history.openTabConfirmTitle')}
          message={t('history.openTabConfirmMessage', {
            tabName: openTabMap.get(jumpTarget.sessionId) ?? '',
            title: jumpTarget.title.slice(0, 30),
          })}
          confirmText={t('history.jumpToTab')}
          onConfirm={() => {
            const target = jumpTarget
            setJumpTarget(null)
            void proceedOpen(target)
          }}
          onCancel={() => setJumpTarget(null)}
        />
      )}
    </div>
  )
}
