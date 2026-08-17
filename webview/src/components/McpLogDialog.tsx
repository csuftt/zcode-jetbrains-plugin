/**
 * MCP 连接日志弹窗（设置页「MCP → 连接日志」，对齐 cc-gui McpLogDialog 视觉）
 *
 * 数据：getMcpLogs（Kotlin 端 McpLogReader 读 ZCode CLI 落盘的
 *       ~/.zcode/cli/log/zcode-<日期>.jsonl 中 mcp.* 事件——真实的连接过程，
 *       含 connected 耗时/工具数、failed 的 error+stderr，非前端模拟时间线）。
 * 交互：服务器过滤（前端过滤，无需重拉）、刷新；检测连接完成后 store 自动重拉。
 * 壳复用全局 .modal-overlay/.modal-content（history-view.less）。
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import type { McpLogEntry } from '@/types/messages'
import '../styles/mcp-log-dialog.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** 事件 → 语气色（connected 系绿 / failed 系红 / reconnect·skipped 橙 / 其余灰）*/
function eventTone(e: McpLogEntry): 'success' | 'error' | 'warn' | 'info' {
  if (/\.connected$|tools\.registered|startup\.completed/.test(e.event)) return 'success'
  if (/failed|connection_lost/.test(e.event)) return 'error'
  if (/reconnect\.started|connect\.skipped/.test(e.event)) return 'warn'
  if (e.level === 'warn') return 'warn'
  if (e.level === 'error') return 'error'
  return 'info'
}

const TONE_ICON: Record<string, string> = {
  success: 'codicon-check',
  error: 'codicon-error',
  warn: 'codicon-warning',
  info: 'codicon-info',
}

/** UTC ISO → 本地 HH:mm:ss */
function fmtTime(ts: string): string {
  const d = new Date(ts)
  return isNaN(d.getTime())
    ? ts.slice(11, 19)
    : d.toLocaleTimeString('zh-CN', { hour12: false })
}

export function McpLogDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const mcpLogs = useStore((s) => s.mcpLogs)
  const mcpLogsLoading = useStore((s) => s.mcpLogsLoading)
  const loadMcpLogs = useStore((s) => s.loadMcpLogs)

  const [serverFilter, setServerFilter] = useState('')

  const servers = useMemo(() => {
    const set = new Set<string>()
    mcpLogs?.forEach((e) => e.serverName && set.add(e.serverName))
    return Array.from(set).sort()
  }, [mcpLogs])

  const visible = useMemo(
    () => (serverFilter ? mcpLogs?.filter((e) => e.serverName === serverFilter) : mcpLogs) ?? [],
    [mcpLogs, serverFilter],
  )

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content mcp-log-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-log-dialog__header">
          <span className="codicon codicon-output" />
          <h3 className="mcp-log-dialog__title">{t('mcp.log.title')}</h3>
          <span className="mcp-log-dialog__hint" title={t('mcp.log.sourceHint')}>
            {t('mcp.log.recentCount', { count: visible.length })}
          </span>
          <button
            className="mcp-log-dialog__icon-btn"
            onClick={() => loadMcpLogs()}
            disabled={mcpLogsLoading}
            title={t('mcp.log.refresh')}
          >
            <span className={cx('codicon', mcpLogsLoading ? 'codicon-loading spin' : 'codicon-refresh')} />
          </button>
          <button className="mcp-log-dialog__icon-btn" onClick={onClose} title={t('mcp.log.close')}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        {servers.length > 0 && (
          <div className="mcp-log-dialog__filter">
            <span className="mcp-log-dialog__filter-label">{t('mcp.log.server')}</span>
            <select value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}>
              <option value="">{t('mcp.log.all')}</option>
              {servers.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="mcp-log-dialog__body">
          {mcpLogsLoading && !mcpLogs ? (
            <div className="mcp-log-dialog__empty">
              <span className="codicon codicon-loading spin" /> {t('mcp.log.loading')}
            </div>
          ) : visible.length === 0 ? (
            <div className="mcp-log-dialog__empty">
              <span className="codicon codicon-output" />
              {t('mcp.log.empty')}
            </div>
          ) : (
            <div className="mcp-log-dialog__list">
              {visible
                .slice()
                .reverse()
                .map((e, i) => {
                  const tone = eventTone(e)
                  return (
                    <div key={`${e.timestamp}-${i}`} className={cx('mcp-log-dialog__entry', tone)}>
                      <span className="mcp-log-dialog__time" title={e.timestamp}>
                        {fmtTime(e.timestamp)}
                      </span>
                      <span className={cx('codicon', TONE_ICON[tone])} />
                      {e.serverName && <span className="mcp-log-dialog__server">{e.serverName}</span>}
                      <span className="mcp-log-dialog__msg" title={e.message}>
                        {e.message}
                      </span>
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
