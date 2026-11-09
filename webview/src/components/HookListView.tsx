/**
 * 钩子管理页（设置页「钩子」tab，形态对齐官方 ZCode 客户端）
 *
 * 作用域：
 *   - workspace（默认）：当前 IDE 项目 <ws>/.zcode/config.json 的工作区钩子，
 *     有信任准入——未信任禁止启用，信任/状态走一次性 `zcode hooks trust` CLI
 *     （node 冷启动单次约 1s 的结构性延迟）。
 *   - user：用户级 ~/.zcode/cli/config.json 的钩子，Kotlin 直读直写（无 CLI
 *     延迟），**无信任评审**（官方机制：用户级 enabled 即生效），对所有项目生效。
 * 缓存策略：挂载时并行预取两域并各自缓存，**切换作用域零请求**（工作区 CLI
 *   ~1s 的成本只付一次）；迟到响应按自身 scope 落账（不丢弃，切回去即新鲜）；
 *   仅手动刷新、工作区路径变化（重取工作区域）、写操作对账时更新缓存。
 * 动作（两域同构）：
 *   - 信任（仅工作区）：grant 单条 digest
 *   - 启停：toggle（Kotlin 写对应 config + 回读列表）
 *   - 删除：delete（Kotlin 从 config 移除登记项并逐级剪枝；脚本文件保留在磁盘；
 *     二次确认弹窗）
 *   - 新建/编辑（2026-11-09 反转 2026-10-12「不做内置编辑页」决策）：表单弹窗
 *     直写 config.json——新建走 workspaceHooksSave（工作区新建自动补根开关
 *     hooks.enabled:true，信任准入仍生效）；编辑先 workspaceHooksGet 拉原始对象
 *     预填（列表条目缺 args/shell/timeout 字段），保存成功按权威对账回包
 *     （sourceOp=workspaceHooksSave）关弹窗。仅 .zcode/config.json 来源可编辑
 *     （与删除同款约束），用户级恒可编辑。
 * 写操作乐观更新按作用域隔离——点击瞬间翻转/消行，权威列表到达后清该域覆盖，
 * error 响应回退到上一份权威数据并报错。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { onMessage, sendToJava } from '@/ipc/bridge'
import { useStore } from '@/store/useStore'
import { ConfirmDialog } from './ConfirmDialog'
import { HookEditDialog, type HookEditTarget } from './HookEditDialog'
import type {
  HookRawEntry,
  HookScope,
  JavaResponse,
  WorkspaceHooksStatus,
  WorkspaceHooksStatusItem,
} from '@/types/messages'
import '../styles/hook-list-view.less'

const TRUSTED_STATE = 'trusted_persistent'

type StatusCache = Record<HookScope, WorkspaceHooksStatus | null>
type EnabledOverrides = Record<HookScope, Record<string, boolean>>
type IdOverrides = Record<HookScope, Set<string>>

const EMPTY_STATUS_CACHE: StatusCache = { workspace: null, user: null }
const EMPTY_ENABLED: EnabledOverrides = { workspace: {}, user: {} }
const EMPTY_IDS: IdOverrides = { workspace: new Set(), user: new Set() }

/** 权威行 + 本地乐观覆盖（信任/启停/删除）合成的视图模型 */
interface RowView {
  item: WorkspaceHooksStatusItem
  trusted: boolean
  enabled: boolean
}

/** 需要信任审核：非 trusted_persistent 一律算（pending/blocked/revoked/stale；仅工作区） */
function requiresTrust(state: string): boolean {
  return state !== TRUSTED_STATE
}

/** 工作区 basename（显示用） */
function workspaceBasename(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return norm.slice(norm.lastIndexOf('/') + 1)
}

export function HookListView() {
  const { t } = useTranslation()
  // 工作区取会话工作区，待命态（未选/新建会话，currentWorkspacePath 为空）
  // 回退 IDE 项目根 projectPath（init 时由桥注入，可靠有值）。
  const currentWorkspace = useStore((s) => s.currentWorkspacePath)
  const projectPath = useStore((s) => s.projectPath)
  const linkedWorkspaces = useStore((s) => s.linkedWorkspaces)
  const connectionStatus = useStore((s) => s.connectionStatus)
  // 浏览目录（多目录会话）：'' = 跟随会话目录（现行为）；显式选择后定死为该目录，
  // workspace 域的重取/乐观覆盖清空由下方 seenWorkspace effect 统一接管
  const [hooksWorkspace, setHooksWorkspace] = useState('')
  const workspace = hooksWorkspace || currentWorkspace || projectPath

  const [scope, setScope] = useState<HookScope>('workspace')
  const [statusCache, setStatusCache] = useState<StatusCache>(EMPTY_STATUS_CACHE)
  const [loadingScopes, setLoadingScopes] = useState<Set<HookScope>>(new Set())
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  /** 乐观覆盖（按作用域隔离）：reviewItemId → enabled；权威列表到达后清该域 */
  const [enabledOverride, setEnabledOverride] = useState<EnabledOverrides>(EMPTY_ENABLED)
  /** 乐观信任（仅工作区）：点击信任后到权威响应前按已信任渲染 */
  const [trustOverride, setTrustOverride] = useState<IdOverrides>(EMPTY_IDS)
  /** 乐观撤销（仅工作区）：点击撤销信任后到权威响应前按未信任渲染 */
  const [revokeOverride, setRevokeOverride] = useState<IdOverrides>(EMPTY_IDS)
  /** 乐观删除：确认后到权威响应前隐藏该行；权威列表到达清该域，error 回退重现 */
  const [removedOverride, setRemovedOverride] = useState<IdOverrides>(EMPTY_IDS)
  /** 待确认删除的钩子（ConfirmDialog）；null=弹窗关闭 */
  const [pendingDelete, setPendingDelete] = useState<WorkspaceHooksStatusItem | null>(null)
  /** 新建/编辑弹窗目标；item=null=新建。编辑态先 workspaceHooksGet 预填，
   *  editRaw 就绪（非 null）才渲染弹窗（新建直接给 {} 即就绪） */
  const [editTarget, setEditTarget] = useState<HookEditTarget | null>(null)
  const [editRaw, setEditRaw] = useState<HookRawEntry | null>(null)

  const isUser = scope === 'user'

  const requestScope = useCallback((target: HookScope) => {
    if (target === 'workspace' && !workspace) return
    setLoadingScopes((prev) => new Set(prev).add(target))
    sendToJava(
      target === 'user'
        ? { op: 'workspaceHooksList', scope: 'user' }
        : { op: 'workspaceHooksList', workspace, scope: 'workspace' },
    )
  }, [workspace])

  // 订阅只建一次：响应按自带 scope 落各自缓存（迟到也不丢，切换零请求的关键）
  useEffect(() => {
    const off = onMessage((msg: JavaResponse) => {
      if (msg.op === 'workspaceHooksList') {
        const respondedScope: HookScope = msg.status.scope ?? 'workspace'
        setStatusCache((prev) => ({ ...prev, [respondedScope]: msg.status }))
        setLoadingScopes((prev) => {
          const next = new Set(prev)
          next.delete(respondedScope)
          return next
        })
        // 权威数据到达：只清该作用域的乐观覆盖
        setEnabledOverride((prev) => ({ ...prev, [respondedScope]: {} }))
        setTrustOverride((prev) => ({ ...prev, [respondedScope]: new Set() }))
        setRevokeOverride((prev) => ({ ...prev, [respondedScope]: new Set() }))
        setRemovedOverride((prev) => ({ ...prev, [respondedScope]: new Set() }))
        // 保存成功对账回包（弹窗自己也在听同一信号，这里只负责关弹窗清目标）
        if (msg.sourceOp === 'workspaceHooksSave') setEditTarget(null)
      } else if (msg.op === 'workspaceHooksGet') {
        // 编辑预填就绪：弹窗从等待态转为表单
        setEditRaw(msg.hook)
      } else if (msg.op === 'error' && typeof msg.sourceOp === 'string' && msg.sourceOp.startsWith('workspaceHooks')) {
        // 失败回退（仅钩子域错误，面板 errorResponseFor 带 sourceOp 归属）：丢弃乐观覆盖，
        // 界面回到上一份权威数据；其他操作的失败与本页无关，不误吞不清态
        setLoadingScopes(new Set())
        setEnabledOverride(EMPTY_ENABLED)
        setTrustOverride(EMPTY_IDS)
        setRevokeOverride(EMPTY_IDS)
        setRemovedOverride(EMPTY_IDS)
        setError(msg.message)
        // 预填失败（如配置被外部改坏）：撤掉等待中的编辑目标，不留挂起态
        if (msg.sourceOp === 'workspaceHooksGet') setEditTarget(null)
      }
    })
    return off
  }, [])

  // 首次挂载并行预取两域；之后 workspace 变化只重取工作区域（用户域与项目无关）
  const seenWorkspace = useRef<string | null>(null)
  // 桥就绪前挂载的首屏请求会被丢弃（dev mock 回退 10s 才就绪 / 真机冷启动窗口）：
  // 连接态落定后补拉一次。mountStatus 记挂载时连接态——热刷新（mount 即 connected）
  // 不重复拉；冷启动/回退 mock 后落定才补。
  const mountStatus = useRef(connectionStatus)
  useEffect(() => {
    if (mountStatus.current === connectionStatus) return
    mountStatus.current = connectionStatus
    if (connectionStatus === 'connected' || connectionStatus === 'mock') {
      requestScope('user')
      requestScope('workspace')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStatus])
  useEffect(() => {
    if (seenWorkspace.current === workspace) return
    const firstMount = seenWorkspace.current === null
    seenWorkspace.current = workspace
    if (firstMount) {
      requestScope('user')
      requestScope('workspace')
    } else {
      setStatusCache((prev) => ({ ...prev, workspace: null }))
      setEnabledOverride((prev) => ({ ...prev, workspace: {} }))
      setTrustOverride((prev) => ({ ...prev, workspace: new Set() }))
      setRevokeOverride((prev) => ({ ...prev, workspace: new Set() }))
      setRemovedOverride((prev) => ({ ...prev, workspace: new Set() }))
      requestScope('workspace')
    }
  }, [workspace, requestScope])

  const status = statusCache[scope]
  const busy = loadingScopes.has(scope)

  /** 权威行叠加该域乐观覆盖；用户级无信任概念恒为 trusted；搜索过滤在合成视图上做 */
  const rows = useMemo<RowView[]>(() => {
    const q = query.trim().toLowerCase()
    return (status?.items ?? [])
      .filter((item) => !removedOverride[scope].has(item.reviewItemId))
      .map((item) => {
        const trusted =
          !revokeOverride[scope].has(item.reviewItemId) &&
          (isUser || trustOverride[scope].has(item.reviewItemId) || item.trustState === TRUSTED_STATE)
        const enabled = enabledOverride[scope][item.reviewItemId] ?? item.configuredEnabled
        return { item, trusted, enabled }
      })
      .filter((v) => {
        if (!q) return true
        return (
          v.item.event.toLowerCase().includes(q) ||
          v.item.displayCommand.toLowerCase().includes(q) ||
          (v.item.matcher ?? '').toLowerCase().includes(q)
        )
      })
  }, [status, query, trustOverride, revokeOverride, enabledOverride, removedOverride, isUser, scope])

  /** 信任（仅工作区）：乐观置信任态，响应对账；并发安全由 Kotlin 锁保证 */
  const grant = (it: WorkspaceHooksStatusItem) => {
    setError('')
    setTrustOverride((prev) => ({ ...prev, workspace: new Set(prev.workspace).add(it.reviewItemId) }))
    sendToJava({
      op: 'workspaceHooksGrant',
      workspace,
      hookDigests: [it.hookDeclarationDigest],
    })
  }

  /** 撤销信任（仅工作区，UI 既有信任无撤销的缺口补齐）：乐观回未信任态，
   *  权威列表（Kotlin 同步回读）到达清该域覆盖；钩子随即回到被阻止状态 */
  const revoke = (it: WorkspaceHooksStatusItem) => {
    setError('')
    setRevokeOverride((prev) => ({ ...prev, workspace: new Set(prev.workspace).add(it.reviewItemId) }))
    sendToJava({
      op: 'workspaceHooksRevoke',
      workspace,
      hookDigests: [it.hookDeclarationDigest],
    })
  }

  /** 启停：乐观翻转；未信任行不允许（UI 已禁用，双保险） */
  const toggleEnabled = (v: RowView) => {
    if (!isUser && !v.trusted) return
    setError('')
    setEnabledOverride((prev) => ({
      ...prev,
      [scope]: { ...prev[scope], [v.item.reviewItemId]: !v.enabled },
    }))
    sendToJava({
      op: 'workspaceHooksToggle',
      ...(isUser ? { scope: 'user' as const } : { workspace, scope: 'workspace' as const }),
      reviewItemId: v.item.reviewItemId,
      sourcePath: v.item.sourcePath,
      enabled: !v.enabled,
    })
  }

  /** 确认删除：乐观消行后发 op；脚本文件保留在磁盘，失败由 error 响应清覆盖重现 */
  const confirmDelete = () => {
    const it = pendingDelete
    setPendingDelete(null)
    if (!it) return
    setError('')
    setRemovedOverride((prev) => ({ ...prev, [scope]: new Set(prev[scope]).add(it.reviewItemId) }))
    sendToJava({
      op: 'workspaceHooksDelete',
      ...(isUser ? { scope: 'user' as const } : { workspace, scope: 'workspace' as const }),
      reviewItemId: it.reviewItemId,
      sourcePath: it.sourcePath,
    })
  }

  /** 切换作用域只换本地视图：数据已在挂载时预取缓存，不发请求 */
  const switchScope = (next: HookScope) => {
    if (next === scope) return
    setScope(next)
    setError('')
  }

  /** 仅 .zcode/config.json 来源的登记项可编辑（与删除的 requireConfigSource 同款约束；
   *  用户级直读直写恒可编辑） */
  const editableSource = (it: WorkspaceHooksStatusItem) =>
    isUser || it.sourcePath.replace(/\\/g, '/') === '.zcode/config.json'

  /** 新建：当前作用域落盘（工作区=当前浏览目录；用户级无需工作区） */
  const openCreate = () => {
    setError('')
    setEditRaw({})
    setEditTarget({ scope, workspace: scope === 'workspace' ? workspace : undefined, item: null })
  }

  /** 编辑：先 workspaceHooksGet 拉原始对象（列表条目缺 args/shell/timeout 等字段），
   *  到达后渲染弹窗预填；失败由 error 分支撤目标 */
  const openEdit = (it: WorkspaceHooksStatusItem) => {
    setError('')
    setEditRaw(null)
    setEditTarget({ scope, workspace, item: it })
    sendToJava({
      op: 'workspaceHooksGet',
      ...(isUser ? { scope: 'user' as const } : { workspace, scope: 'workspace' as const }),
      reviewItemId: it.reviewItemId,
      sourcePath: it.sourcePath,
    })
  }

  /** 弹窗内删除 → 复用页面既有 ConfirmDialog 流程（先关编辑弹窗再弹确认） */
  const requestDeleteFromDialog = (it: WorkspaceHooksStatusItem) => {
    setEditTarget(null)
    setPendingDelete(it)
  }

  /** 在 IDE 打开对应配置文件（工作区=.zcode/config.json；用户级=~/.zcode/cli/config.json） */
  const openConfig = () => {
    const path = isUser ? statusCache.user?.userConfigPath : `${workspace}/.zcode/config.json`
    if (path) sendToJava({ op: 'openFile', filePath: path })
  }

  const hasUntrusted = !isUser && (status?.items ?? []).some((it) => requiresTrust(it.trustState))
  // 根开关缺失（插件附加字段）：CLI 运行时默认禁用钩子系统，条目照列但永不生效
  const rootDisabled = !isUser && status?.rootEnabled === false
  const configOpenable = isUser ? Boolean(statusCache.user?.userConfigPath) : Boolean(workspace)
  // 工作区作用域但当前无项目：列表区给提示（不发请求），工具栏仍允许切到用户级
  const showNoWorkspace = !isUser && !workspace

  return (
    <div className="hook-list">
      {/* 浏览目录行（多目录会话）：独占一行——''=跟随会话目录；切目录重取工作区钩子域（用户域与目录无关） */}
      {linkedWorkspaces.length > 0 && (
        <div className="hook-list__ws-row">
          <span className="hook-list__ws-label">{t('history.wsChips.workspace')}</span>
          <select
            className="hook-list__ws-select"
            value={hooksWorkspace}
            onChange={(e) => setHooksWorkspace(e.target.value)}
          >
            <option value="" title={currentWorkspace || projectPath}>
              {workspaceBasename(currentWorkspace || projectPath)}
            </option>
            {[...new Set([projectPath, ...linkedWorkspaces])]
              .filter((w) => w && w !== (currentWorkspace || projectPath))
              .map((w) => (
                <option key={w} value={w} title={w}>{workspaceBasename(w)}</option>
              ))}
          </select>
        </div>
      )}
      {/* 工具栏：作用域切换 + 搜索 + 打开配置 + 刷新 */}
      <div className="hook-list__toolbar">
        <div className="hook-list__scope" role="tablist" aria-label={t('hooks.scopeLabel')}>
          <button
            type="button"
            role="tab"
            aria-selected={!isUser}
            className={!isUser ? 'hook-list__scope-btn is-active' : 'hook-list__scope-btn'}
            onClick={() => switchScope('workspace')}
            title={workspace}
          >
            <span className="codicon codicon-folder" />
            {workspace ? workspaceBasename(workspace) : t('hooks.scopeWorkspace')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isUser}
            className={isUser ? 'hook-list__scope-btn is-active' : 'hook-list__scope-btn'}
            onClick={() => switchScope('user')}
          >
            <span className="codicon codicon-person" />
            {t('hooks.scopeUser')}
          </button>
        </div>
        <span className="hook-list__divider" />
        <span className="hook-list__count">
          {t('hooks.titleCount', { count: status?.items.length ?? 0 })}
        </span>
      </div>
      {/* 工具行（固定第二行）：搜索撑满 + 打开配置 + 刷新——窄面板不挤第一行 */}
      <div className="hook-list__toolbar-tools">
        <div className="hook-list__search">
          <span className="codicon codicon-search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('hooks.searchPlaceholder')}
            spellCheck={false}
          />
        </div>
        <button
          type="button"
          className="hook-list__icon-btn"
          onClick={openConfig}
          disabled={!configOpenable}
          title={t('hooks.openConfig')}
        >
          <span className="codicon codicon-json" />
        </button>
        <button
          type="button"
          className="hook-list__refresh"
          onClick={() => requestScope(scope)}
          disabled={busy}
          title={t('hooks.refresh')}
        >
          <span className="codicon codicon-refresh" />
        </button>
        <button
          type="button"
          className="hook-list__new"
          onClick={openCreate}
          disabled={busy || (!isUser && !workspace)}
          title={t('hooks.newHook')}
        >
          <span className="codicon codicon-add" />
          {t('hooks.newHook')}
        </button>
      </div>

      {/* 横幅：工作区=根开关缺失警告（条目照列但钩子系统未启用）/未信任安全警告（与官方同一判定）；用户级=全局生效说明（中性） */}
      {isUser ? (
        <div className="hook-list__notice hook-list__notice--info" role="note">
          <span className="codicon codicon-info" />
          <span>{t('hooks.userNotice')}</span>
        </div>
      ) : rootDisabled && (status?.items.length ?? 0) > 0 ? (
        <div className="hook-list__notice" role="note">
          <span className="codicon codicon-warning" />
          <span>{t('hooks.rootDisabledNotice')}</span>
          <button type="button" className="hook-list__notice-action" onClick={openConfig}>
            {t('hooks.openConfig')}
          </button>
        </div>
      ) : hasUntrusted ? (
        <div className="hook-list__notice" role="note">
          <span className="codicon codicon-warning" />
          <span>{t('hooks.sandboxNotice')}</span>
        </div>
      ) : null}

      {error && (
        <div className="hook-list__error">
          <span>⚠️ {error}</span>
        </div>
      )}

      {/* 标题行 */}
      {!showNoWorkspace && (
        <div className="hook-list__header-row">
          <span className="hook-list__installed">
            {t('hooks.installed', { count: rows.length })}
          </span>
        </div>
      )}

      {/* 列表区：无工作区提示 / 空态 / 钩子行 */}
      {showNoWorkspace ? (
        <div className="hook-list-empty">{t('hooks.noWorkspace')}</div>
      ) : rows.length === 0 ? (
        <div className="hook-list-empty">
          {busy ? t('hooks.loading') : isUser ? t('hooks.emptyUser') : t('hooks.empty')}
        </div>
      ) : (
        <div className="hook-list__cards">
          {rows.map((v) => {
            const { item: it, trusted, enabled } = v
            return (
              <div key={it.reviewItemId} className="hook-row">
                <div className="hook-row__main">
                  <div className="hook-row__top">
                    <span className="hook-row__name">
                      {it.event}
                      {it.matcher ? <span className="hook-row__matcher"> · {it.matcher}</span> : null}
                    </span>
                    {!isUser && <HookTrustBadge trusted={trusted} state={it.trustState} />}
                  </div>
                  {/* 钩子条目唯一入口：在 IDE 打开命令对应的钩子脚本文件
                      （Kotlin 从 displayCommand 解析，失败回退来源配置；用户级相对路径基准 home） */}
                  <button
                    type="button"
                    className="hook-row__command"
                    title={t('hooks.openScript')}
                    onClick={() => sendToJava({
                      op: 'workspaceHooksOpenScript',
                      ...(isUser ? { scope: 'user' as const } : { workspace, scope: 'workspace' as const }),
                      displayCommand: it.displayCommand,
                      sourcePath: it.sourcePath,
                    })}
                  >
                    <code>{it.displayCommand}</code>
                  </button>
                </div>
                {/* 未信任（仅工作区）：显示单条信任按钮，开关强制关闭并禁用 */}
                {!isUser && !trusted && (
                  <button
                    type="button"
                    className="hook-row__trust"
                    onClick={() => grant(it)}
                  >
                    <span className="codicon codicon-shield" />
                    {t('hooks.trust')}
                  </button>
                )}
                {/* 已信任（仅工作区）：撤销信任入口（CLI revoke 通道；撤销后钩子回到被阻止态，可重授） */}
                {!isUser && trusted && (
                  <button
                    type="button"
                    className="hook-row__revoke"
                    onClick={() => revoke(it)}
                    title={t('hooks.revokeTitle')}
                  >
                    <span className="codicon codicon-unlock" />
                    {t('hooks.revoke')}
                  </button>
                )}
                <button
                  type="button"
                  className={`hook-switch ${trusted && enabled ? 'hook-switch--on' : ''}`}
                  role="switch"
                  aria-checked={trusted && enabled}
                  disabled={!trusted}
                  onClick={() => toggleEnabled(v)}
                  title={!trusted ? t('hooks.trustFirst') : (enabled ? t('hooks.disable') : t('hooks.enable'))}
                >
                  <span className="hook-switch__knob" />
                </button>
                <button
                  type="button"
                  className="hook-row__edit"
                  title={editableSource(it) ? t('hooks.editHook') : t('hooks.editDisabledReason')}
                  disabled={!editableSource(it)}
                  onClick={() => openEdit(it)}
                >
                  <span className="codicon codicon-edit" />
                </button>
                <button
                  type="button"
                  className="hook-row__delete"
                  title={t('hooks.delete')}
                  onClick={() => setPendingDelete(it)}
                >
                  <span className="codicon codicon-trash" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          danger
          title={t('hooks.deleteTitle')}
          confirmText={t('hooks.delete')}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
          message={
            // ConfirmDialog 用 <p> 包裹正文，只能放 phrasing 元素（span/code），块级效果靠 class
            <>
              <span className="hook-delete-dialog__name">
                {pendingDelete.event}
                {pendingDelete.matcher ? <span> · {pendingDelete.matcher}</span> : null}
                {isUser ? <span> · {t('hooks.scopeUser')}</span> : null}
              </span>
              <code>{pendingDelete.displayCommand}</code>
              <span className="hook-delete-dialog__note">{t('hooks.deleteKeepScript')}</span>
            </>
          }
        />
      )}

      {/* 新建/编辑弹窗：编辑态等 workspaceHooksGet 预填就绪（editRaw 非 null）才渲染 */}
      {editTarget && editRaw !== null && (
        <HookEditDialog
          target={editTarget}
          raw={editRaw}
          onClose={() => setEditTarget(null)}
          onRequestDelete={requestDeleteFromDialog}
        />
      )}
    </div>
  )
}

/** 信任状态徽标（颜色按状态；乐观信任瞬间直接呈已信任） */
function HookTrustBadge({ state, trusted }: { state: string; trusted: boolean }) {
  const { t } = useTranslation()
  const key: Record<string, string> = {
    trusted_persistent: 'stateTrusted',
    pending_trust: 'stateUntrusted',
    blocked_untrusted: 'stateUntrusted',
    revoked: 'stateRevoked',
    stale_digest: 'stateStale',
  }
  const labelKey = trusted ? 'stateTrusted' : (key[state] ?? 'stateUntrusted')
  return (
    <span className={`hook-badge hook-badge--${labelKey}`}>
      {/* 信任/未信任不用图标，纯文字徽标；撤销/过期加符号（乐观信任期间不显示旧符号） */}
      {!trusted && state === 'revoked' && '✕ '}
      {!trusted && state === 'stale_digest' && '⚠ '}
      {t(`hooks.${labelKey}`)}
    </span>
  )
}
