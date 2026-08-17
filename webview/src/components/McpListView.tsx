/**
 * MCP 服务器列表面板（设置页「MCP」条目，对齐 cc-gui McpSettingsSection 视觉）
 *
 * 数据：listMcpServers（Kotlin 端 = McpConfigReader 磁盘三来源配置
 *       + RPC mcp/list 连接状态按名合并；RPC 失败降级为纯配置清单）
 * 交互：刷新（status 快照）/ 检测连接（connect 真实连接，慢）；
 *       工具栏状态汇总条 + 日志按钮（弹 McpLogDialog，读 CLI 落盘的真实连接日志）；
 *       失败服务器卡片头部直接显示错误摘要（不必展开）；卡片展开看命令/URL 详情；
 *       「打开配置文件」跳来源 config（openFile）
 * 注：协议 mcp/list 不含单服务器工具清单（只有 toolCount），工具列表不做。
 */

import { useEffect, useState } from 'react'
import { useStore } from '@/store/useStore'
import { sendToJava } from '@/ipc/bridge'
import type { McpServerInfo } from '@/types/messages'
import { McpLogDialog } from './McpLogDialog'
import { fmtTime } from '@/utils/format'
import '../styles/mcp-list-view.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

const SCOPE_LABEL: Record<string, string> = {
  user: '全局',
  project: '项目',
  plugin: '插件',
  runtime: '运行时',
}

/** 连接状态 → 中文 + 状态点配色（对齐 cc-gui：绿=已连接 红=失败 灰=禁用/未知 黄=连接中）*/
const STATUS_META: Record<string, { label: string; cls: string }> = {
  connected: { label: '已连接', cls: 'connected' },
  connecting: { label: '连接中', cls: 'connecting' },
  failed: { label: '失败', cls: 'failed' },
  disabled: { label: '已禁用', cls: 'disabled' },
  disconnected: { label: '未连接', cls: 'disconnected' },
  untrusted: { label: '未信任', cls: 'untrusted' },
}

function statusMeta(s?: string) {
  return s ? STATUS_META[s] ?? { label: s, cls: 'unknown' } : { label: '未知', cls: 'unknown' }
}

/** 单个服务器卡片（手风琴展开）*/
function ServerCard({ server, expanded, onToggleExpand }: { server: McpServerInfo; expanded: boolean; onToggleExpand: () => void }) {
  const meta = statusMeta(server.status)
  const showToolCount = server.status === 'connected' && (server.toolCount ?? 0) > 0
  const zeroToolsWarning = server.status === 'connected' && (server.toolCount ?? 0) === 0

  return (
    <div className={cx('mcp-card', expanded && 'expanded', !server.enabled && 'off')}>
      <div className="mcp-card__header" onClick={onToggleExpand}>
        <span className={cx('codicon mcp-card__chevron', expanded && 'open', 'codicon-chevron-right')} />
        <span className={cx('mcp-card__status-dot', meta.cls)} title={meta.label + (server.statusError ? `：${server.statusError}` : '')} />
        <span className="mcp-card__name">{server.name}</span>
        <span className={cx('mcp-card__status-text', meta.cls)}>{meta.label}</span>
        {server.status === 'failed' && server.statusError && (
          <span className="mcp-card__err-brief" title={server.statusError}>
            {server.statusError}
          </span>
        )}
        <span className="mcp-card__transport">{server.transport}</span>
        {showToolCount && (
          <span className="mcp-card__tools" title="工具数（mcp/list toolCount）">
            <span className="codicon codicon-tools" />
            {server.toolCount}
          </span>
        )}
        {zeroToolsWarning && <span className="mcp-card__tools warn" title="已连接但无工具">0 工具</span>}
        <span className={cx('mcp-card__scope', server.scope)}>{SCOPE_LABEL[server.scope] ?? server.scope}</span>
        <span className="codicon mcp-card__chevron" style={{ visibility: 'hidden' }} />
      </div>

      {expanded && (
        <div className="mcp-card__body">
          {server.command && (
            <div className="mcp-card__row">
              <span className="mcp-card__row-label">命令</span>
              <code className="mcp-card__code">
                {[server.command, ...(server.args ?? [])].join(' ')}
              </code>
            </div>
          )}
          {server.url && (
            <div className="mcp-card__row">
              <span className="mcp-card__row-label">地址</span>
              <code className="mcp-card__code">{server.url}</code>
            </div>
          )}
          {server.envKeys && server.envKeys.length > 0 && (
            <div className="mcp-card__row">
              <span className="mcp-card__row-label">环境变量</span>
              <span className="mcp-card__env-keys">{server.envKeys.join(' · ')}</span>
            </div>
          )}
          {server.statusError && (
            <div className="mcp-card__row">
              <span className="mcp-card__row-label">错误</span>
              <span className="mcp-card__error-text">{server.statusError}</span>
            </div>
          )}
          <div className="mcp-card__row">
            <span className="mcp-card__row-label">来源</span>
            <span className="mcp-card__row-value">
              {(SCOPE_LABEL[server.scope] ?? server.scope) + (server.pluginName ? ` · 插件 ${server.pluginName}` : '')}
              {server.updatedAt ? ` · 状态更新于 ${fmtTime(new Date(server.updatedAt).getTime())}` : ''}
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
                打开配置文件
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function McpListView() {
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
        <span className="mcp-list-view__hint">MCP 服务器与连接状态</span>
        <button
          className="mcp-list-view__btn"
          onClick={() => loadMcpServers('connect')}
          disabled={mcpChecking || mcpLoading}
          title="真实连接各服务器并刷新状态（较慢，完成后日志自动更新）"
        >
          <span className={cx('codicon', mcpChecking ? 'codicon-loading spin' : 'codicon-plug')} />
          {mcpChecking ? '检测中…' : '检测连接'}
        </button>
        <button className="mcp-list-view__log-btn" onClick={openLogs} title="连接日志（CLI 落盘的真实连接过程）">
          <span className="codicon codicon-output" />
          日志
          {mcpLogs && mcpLogs.length > 0 && <span className="mcp-list-view__log-badge">{mcpLogs.length}</span>}
        </button>
        <button
          className="mcp-list-view__icon-btn"
          onClick={() => loadMcpServers('status')}
          disabled={mcpLoading || mcpChecking}
          title="刷新（状态快照，不实际连接）"
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
                {statusMeta(k).label} {summary[k]}
              </span>
            ))}
          <span className="mcp-list-view__summary-total">共 {servers.length} 台</span>
        </div>
      )}

      {mcpChecking && (
        <div className="mcp-list-view__checking">
          <span className="codicon codicon-loading spin" /> 正在连接各 MCP 服务器（可能需要几十秒）…
        </div>
      )}

      {mcpError && (
        <div className="mcp-list-view__error" title={mcpError}>
          状态查询失败：{mcpError}（以下为磁盘配置清单）
        </div>
      )}

      {mcpLoading && !mcpServers ? (
        <div className="mcp-list-view__loading">
          <span className="codicon codicon-loading spin" /> 正在读取 MCP 配置…
        </div>
      ) : servers.length === 0 ? (
        <div className="mcp-list-view__empty">
          <span className="codicon codicon-server-process" />
          <div>未配置任何 MCP 服务器</div>
          <span className="mcp-list-view__empty-hint">
            在 ~/.zcode/cli/config.json 的 mcp.servers 节点添加，或安装含 MCP 的插件
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
