/**
 * MCP 服务器列表面板（设置页「MCP」条目，对齐 cc-gui McpSettingsSection 视觉）
 *
 * 数据：listMcpServers（Kotlin 端 = McpConfigReader 磁盘三来源配置
 *       + RPC mcp/list 连接状态按名合并；RPC 失败降级为纯配置清单）
 *       + mcpServerTools（Kotlin 端 McpToolsClient 直连服务器调 tools/list，
 *       协议 mcp/list 无工具明细只能自连；对齐 cc-gui ServerToolsPanel）
 * 交互：刷新（status 快照）/ 检测连接（connect 真实连接，慢，连接成功的
 *       服务器自动拉工具清单）；工具栏状态汇总条 + 日志按钮（弹 McpLogDialog）；
 *       失败服务器卡片头部直接显示错误摘要（不必展开）；卡片展开看命令/URL
 *       详情 + 工具列表（hover 看描述，可强制刷新）；
 *       「打开配置文件」跳来源 config（openFile）
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useStore } from '@/store/useStore'
import { sendToJava, isInJcef } from '@/ipc/bridge'
import type { McpServerInfo, McpToolInfo } from '@/types/messages'
import { McpLogDialog } from './McpLogDialog'
import { fmtTime } from '@/utils/format'
import '../styles/mcp-list-view.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** 配置来源 → 文案 key（未知来源回退原值）*/
function scopeLabel(scope: string, t: TFunction): string {
  return t(`mcp.scope.${scope}`, { defaultValue: scope })
}

/** 连接状态 → 文案 + 状态点配色（对齐 cc-gui：绿=已连接 红=失败 灰=禁用/未知 黄=连接中）*/
const STATUS_CLS: Record<string, string> = {
  connected: 'connected',
  connecting: 'connecting',
  failed: 'failed',
  disabled: 'disabled',
  disconnected: 'disconnected',
  untrusted: 'untrusted',
}

function statusMeta(s: string | undefined, t: TFunction) {
  if (!s) return { label: t('mcp.status.unknown'), cls: 'unknown' }
  return STATUS_CLS[s]
    ? { label: t(`mcp.status.${s}`), cls: STATUS_CLS[s] }
    : { label: s, cls: 'unknown' }
}

/** 工具名 → codicon（照搬 cc-gui serverUtils.getToolIcon 关键词映射）*/
function toolIcon(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('search') || n.includes('query') || n.includes('find')) return 'codicon-search'
  if (n.includes('read') || n.includes('get') || n.includes('fetch')) return 'codicon-file-text'
  if (n.includes('write') || n.includes('create') || n.includes('add') || n.includes('insert')) return 'codicon-edit'
  if (n.includes('delete') || n.includes('remove')) return 'codicon-trash'
  if (n.includes('update') || n.includes('modify') || n.includes('change')) return 'codicon-sync'
  if (n.includes('list') || n.includes('all')) return 'codicon-list-tree'
  if (n.includes('execute') || n.includes('run') || n.includes('call')) return 'codicon-play'
  if (n.includes('connect')) return 'codicon-plug'
  if (n.includes('send') || n.includes('post')) return 'codicon-mail'
  if (n.includes('browser') || n.includes('navigate') || n.includes('page')) return 'codicon-globe'
  return 'codicon-tools'
}

/**
 * 卡片展开区的工具列表面板（对齐 cc-gui ServerToolsPanel 状态分支）
 * 未连接=提示；已连接未加载=点击加载；loading=spin；失败=错误+重试；
 * 空结果=黄色警告；正常=「工具 (N)」+ 列表（hover title=description）。
 */
function ToolsSection({ server }: { server: McpServerInfo }) {
  const { t } = useTranslation()
  const state = useStore((s) => s.mcpToolsByServer[server.name])
  const loadMcpServerTools = useStore((s) => s.loadMcpServerTools)

  if (server.status !== 'connected') {
    return (
      <div className="mcp-card__row">
        <span className="mcp-card__row-label">{t('mcp.tools')}</span>
        <span className="mcp-card__tools-hint">
          {server.status === 'connecting' ? t('mcp.toolsHintConnecting') : t('mcp.toolsHint')}
        </span>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="mcp-card__row">
        <span className="mcp-card__row-label">{t('mcp.tools')}</span>
        <button className="mcp-card__tools-load" onClick={() => loadMcpServerTools(server.name)}>
          <span className="codicon codicon-refresh" />
          {t('mcp.loadTools')}
        </button>
      </div>
    )
  }

  if (state.loading) {
    return (
      <div className="mcp-card__row">
        <span className="mcp-card__row-label">{t('mcp.tools')}</span>
        <span className="mcp-card__tools-hint">
          <span className="codicon codicon-loading spin" /> {t('mcp.loadingTools')}
        </span>
      </div>
    )
  }

  if (state.error) {
    return (
      <div className="mcp-card__row">
        <span className="mcp-card__row-label">{t('mcp.tools')}</span>
        <span className="mcp-card__tools-error" title={state.error}>
          {t('mcp.fetchToolsFailed', { error: state.error })}
        </span>
        <button className="mcp-card__tools-retry" onClick={() => loadMcpServerTools(server.name, true)} title={t('mcp.retry')}>
          <span className="codicon codicon-refresh" />
        </button>
      </div>
    )
  }

  if (state.tools.length === 0) {
    return (
      <div className="mcp-card__row">
        <span className="mcp-card__row-label">{t('mcp.tools')}</span>
        <span className="mcp-card__tools-warning">{t('mcp.noToolsWarning')}</span>
        <button className="mcp-card__tools-retry" onClick={() => loadMcpServerTools(server.name, true)} title={t('mcp.refetch')}>
          <span className="codicon codicon-refresh" />
        </button>
      </div>
    )
  }

  return (
    <div className="mcp-card__tools-panel">
      <div className="mcp-card__tools-panel-header">
        <span className="mcp-card__tools-title">
          <span className="codicon codicon-tools" /> {t('mcp.toolsPanelTitle', { count: state.tools.length })}
        </span>
        <span className="mcp-card__tools-meta">{fmtTime(state.fetchedAt)}</span>
        <button
          className="mcp-card__tools-retry"
          onClick={() => loadMcpServerTools(server.name, true)}
          title={t('mcp.forceRefresh')}
        >
          <span className="codicon codicon-sync" />
        </button>
      </div>
      <div className="mcp-card__tool-list">
        {state.tools.map((t: McpToolInfo) => (
          <div key={t.name} className="mcp-card__tool-item" title={t.description || t.name}>
            <div className="mcp-card__tool-name-row">
              <span className={cx('codicon', 'mcp-card__tool-icon', toolIcon(t.name))} />
              <span className="mcp-card__tool-name">{t.name}</span>
            </div>
            {t.description && <div className="mcp-card__tool-desc">{t.description}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 单个服务器卡片（手风琴展开）*/
function ServerCard({ server, expanded, onToggleExpand }: { server: McpServerInfo; expanded: boolean; onToggleExpand: () => void }) {
  const { t } = useTranslation()
  const meta = statusMeta(server.status, t)
  // 头部工具数徽章：直连结果优先（mcp/list 的 toolCount 在 status 快照模式下
  // app-server 未真实连接恒为 0，与 McpToolsClient 直连拿到的实际数对不上）；
  // 直连失败/未加载时回退 RPC toolCount
  const toolsState = useStore((s) => s.mcpToolsByServer[server.name])
  const liveCount = toolsState && !toolsState.loading && !toolsState.error ? toolsState.tools.length : null
  const displayCount = liveCount ?? server.toolCount
  const showToolCount = server.status === 'connected' && (displayCount ?? 0) > 0
  // 「0 工具」警告只在直连确认 0 时显示（RPC 0 未直连不误导）
  const zeroToolsWarning = server.status === 'connected' && liveCount === 0

  return (
    <div className={cx('mcp-card', expanded && 'expanded', !server.enabled && 'off')}>
      <div className="mcp-card__header" onClick={onToggleExpand}>
        <span className={cx('codicon mcp-card__chevron', expanded && 'open', 'codicon-chevron-right')} />
        <span className={cx('mcp-card__status-dot', meta.cls)} title={server.statusError ? t('mcp.statusWithError', { label: meta.label, error: server.statusError }) : meta.label} />
        <span className="mcp-card__name">{server.name}</span>
        <span className={cx('mcp-card__status-text', meta.cls)}>{meta.label}</span>
        {server.status === 'failed' && server.statusError && (
          <span className="mcp-card__err-brief" title={server.statusError}>
            {server.statusError}
          </span>
        )}
        <span className="mcp-card__transport">{server.transport}</span>
        {showToolCount && (
          <span className="mcp-card__tools" title={t('mcp.toolsCountBadge')}>
            <span className="codicon codicon-tools" />
            {displayCount}
          </span>
        )}
        {zeroToolsWarning && <span className="mcp-card__tools warn" title={t('mcp.zeroToolsTitle')}>{t('mcp.zeroTools')}</span>}
        <span className={cx('mcp-card__scope', server.scope)}>{scopeLabel(server.scope, t)}</span>
        <span className="codicon mcp-card__chevron" style={{ visibility: 'hidden' }} />
      </div>

      {expanded && (
        <div className="mcp-card__body">
          <ToolsSection server={server} />
          {server.command && (
            <div className="mcp-card__row">
              <span className="mcp-card__row-label">{t('mcp.command')}</span>
              <code className="mcp-card__code">
                {[server.command, ...(server.args ?? [])].join(' ')}
              </code>
            </div>
          )}
          {server.url && (
            <div className="mcp-card__row">
              <span className="mcp-card__row-label">{t('mcp.address')}</span>
              <code className="mcp-card__code">{server.url}</code>
            </div>
          )}
          {server.envKeys && server.envKeys.length > 0 && (
            <div className="mcp-card__row">
              <span className="mcp-card__row-label">{t('mcp.envVars')}</span>
              <span className="mcp-card__env-keys">{server.envKeys.join(' · ')}</span>
            </div>
          )}
          {server.statusError && (
            <div className="mcp-card__row">
              <span className="mcp-card__row-label">{t('mcp.error')}</span>
              <span className="mcp-card__error-text">{server.statusError}</span>
            </div>
          )}
          <div className="mcp-card__row">
            <span className="mcp-card__row-label">{t('mcp.source')}</span>
            <span className="mcp-card__row-value">
              {(scopeLabel(server.scope, t)) + (server.pluginName ? ` · ${t('mcp.sourcePlugin', { name: server.pluginName })}` : '')}
              {server.updatedAt ? ` · ${t('mcp.statusUpdatedAt', { time: fmtTime(new Date(server.updatedAt).getTime()) })}` : ''}
            </span>
          </div>
          {server.scope !== 'runtime' && server.configPath && (
            <div className="mcp-card__actions">
              <button
                className="mcp-card__action"
                onClick={() => sendToJava({ op: 'openFile', filePath: server.configPath })}
                title={server.configPath}
              >
                <span className="codicon codicon-go-to-file" />
                {t('mcp.openConfigFile')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function McpListView() {
  const { t } = useTranslation()
  const mcpServers = useStore((s) => s.mcpServers)
  const mcpLoading = useStore((s) => s.mcpLoading)
  const mcpChecking = useStore((s) => s.mcpChecking)
  const mcpError = useStore((s) => s.mcpError)
  const mcpLogs = useStore((s) => s.mcpLogs)
  const loadMcpServers = useStore((s) => s.loadMcpServers)
  const loadMcpLogs = useStore((s) => s.loadMcpLogs)

  const [expandedName, setExpandedName] = useState<string | null>(null)
  const [logOpen, setLogOpen] = useState(false)

  useEffect(() => {
    loadMcpServers('status')
    // dev 辅助：#mcp/<服务器名> 直达并自动展开该卡片（点击通道在 IAB 里不稳定，
    // 验收靠 hash；JCEF 内 hash 恒空不影响生产）
    if (!isInJcef()) {
      const m = window.location.hash.match(/^#mcp\/(.+)$/)
      if (m) setExpandedName(decodeURIComponent(m[1]))
    }
  }, [loadMcpServers])

  const servers = mcpServers ?? []

  // 状态汇总（检测连接后一眼看清连上几台/挂了几台）
  const summary = servers.reduce<Record<string, number>>((acc, s) => {
    const key = s.status ?? 'unknown'
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const hasStatusData = servers.length > 0 && servers.some((s) => s.status)

  const openLogs = () => {
    setLogOpen(true)
    if (!mcpLogs) loadMcpLogs()
  }

  return (
    <div className="mcp-list-view">
      <div className="mcp-list-view__toolbar">
        <span className="mcp-list-view__hint">{t('mcp.toolbarHint')}</span>
        <button
          className="mcp-list-view__btn"
          onClick={() => loadMcpServers('connect')}
          disabled={mcpChecking || mcpLoading}
          title={t('mcp.checkConnectionTitle')}
        >
          <span className={cx('codicon', mcpChecking ? 'codicon-loading spin' : 'codicon-plug')} />
          {mcpChecking ? t('mcp.checking') : t('mcp.checkConnection')}
        </button>
        <button className="mcp-list-view__log-btn" onClick={openLogs} title={t('mcp.logsTitle')}>
          <span className="codicon codicon-output" />
          {t('mcp.logs')}
          {mcpLogs && mcpLogs.length > 0 && <span className="mcp-list-view__log-badge">{mcpLogs.length}</span>}
        </button>
        <button
          className="mcp-list-view__icon-btn"
          onClick={() => loadMcpServers('status')}
          disabled={mcpLoading || mcpChecking}
          title={t('mcp.refreshTitle')}
        >
          <span className={cx('codicon', mcpLoading ? 'codicon-loading spin' : 'codicon-refresh')} />
        </button>
      </div>

      {hasStatusData && (
        <div className="mcp-list-view__summary">
          {(['connected', 'failed', 'connecting', 'disconnected', 'disabled', 'untrusted', 'unknown'] as const)
            .filter((k) => summary[k])
            .map((k) => (
              <span key={k} className={cx('mcp-list-view__summary-item', k)}>
                {statusMeta(k, t).label} {summary[k]}
              </span>
            ))}
          <span className="mcp-list-view__summary-total">{t('mcp.totalServers', { count: servers.length })}</span>
        </div>
      )}

      {mcpChecking && (
        <div className="mcp-list-view__checking">
          <span className="codicon codicon-loading spin" /> {t('mcp.checkingServers')}
        </div>
      )}

      {mcpError && (
        <div className="mcp-list-view__error" title={mcpError}>
          {t('mcp.queryFailed', { error: mcpError })}
        </div>
      )}

      {mcpLoading && !mcpServers ? (
        <div className="mcp-list-view__loading">
          <span className="codicon codicon-loading spin" /> {t('mcp.loadingConfig')}
        </div>
      ) : servers.length === 0 ? (
        <div className="mcp-list-view__empty">
          <span className="codicon codicon-server-process" />
          <div>{t('mcp.empty')}</div>
          <span className="mcp-list-view__empty-hint">
            {t('mcp.emptyHint')}
          </span>
        </div>
      ) : (
        <div className="mcp-list-view__list">
          {servers.map((s) => (
            <ServerCard
              key={s.name}
              server={s}
              expanded={expandedName === s.name}
              onToggleExpand={() => setExpandedName(expandedName === s.name ? null : s.name)}
            />
          ))}
        </div>
      )}

      {logOpen && <McpLogDialog onClose={() => setLogOpen(false)} />}
    </div>
  )
}
