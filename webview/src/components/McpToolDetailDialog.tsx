/**
 * MCP 工具详情弹窗（设置页「MCP → 卡片工具列表 → 点工具行」）
 *
 * 内容（对齐参考稿 ops_query_trace 弹窗结构）：
 *   头部：工具 icon + 名称 + 所属服务器徽标 + 关闭
 *   描述：全文（whitespace-pre-wrap）
 *   输入参数表：参数/类型/必填/说明（utils/mcpSchema.ts schemaToRows 推导）
 *   输出：静态说明（MCP 工具统一以 content 文本返回，无独立输出结构）
 *   原始入参 Schema（JSON）：折叠区，默认折叠，展开后 pretty JSON 限高滚动
 * 壳复用全局 .modal-overlay/.modal-content（history-view.less），专属样式
 * mcp-tool-detail-dialog.less。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpToolInfo } from '@/types/messages'
import { hasRawSchema, schemaToRows } from '@/utils/mcpSchema'
import '../styles/mcp-tool-detail-dialog.less'

interface Props {
  serverName: string
  tool: McpToolInfo
  onClose: () => void
}

export function McpToolDetailDialog({ serverName, tool, onClose }: Props) {
  const { t } = useTranslation()
  const [schemaOpen, setSchemaOpen] = useState(false) // 原始 Schema 默认折叠

  const rows = schemaToRows(tool.inputSchema)
  const showRaw = hasRawSchema(tool.inputSchema)

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content mcp-tool-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-tool-dialog__header">
          <span className="codicon codicon-tools mcp-tool-dialog__icon" />
          <span className="mcp-tool-dialog__name">{tool.name}</span>
          <span className="mcp-tool-dialog__server" title={t('mcp.toolDetail.serverTip')}>
            {serverName}
          </span>
          <button className="mcp-tool-dialog__close" onClick={onClose} title={t('mcp.toolDetail.close')}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className="mcp-tool-dialog__body">
          {tool.description && <div className="mcp-tool-dialog__desc">{tool.description}</div>}

          <div className="mcp-tool-dialog__section-title">{t('mcp.toolDetail.inputParams')}</div>
          {rows ? (
            <div className="mcp-tool-dialog__table-wrap">
              <table className="mcp-tool-dialog__table">
                <thead>
                  <tr>
                    <th>{t('mcp.toolDetail.colParam')}</th>
                    <th>{t('mcp.toolDetail.colType')}</th>
                    <th>{t('mcp.toolDetail.colRequired')}</th>
                    <th>{t('mcp.toolDetail.colDesc')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.name}>
                      <td className="mcp-tool-dialog__mono">{r.name}</td>
                      <td className="mcp-tool-dialog__mono">{r.type}</td>
                      <td className={r.required ? 'required' : undefined}>
                        {r.required ? t('mcp.toolDetail.yes') : t('mcp.toolDetail.no')}
                      </td>
                      <td className="mcp-tool-dialog__param-desc">{r.description || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mcp-tool-dialog__no-params">{t('mcp.toolDetail.noParams')}</div>
          )}

          <div className="mcp-tool-dialog__section-title">{t('mcp.toolDetail.output')}</div>
          <div className="mcp-tool-dialog__output-note">{t('mcp.toolDetail.outputNote')}</div>

          {showRaw && (
            <div className="mcp-tool-dialog__schema">
              <button
                className="mcp-tool-dialog__schema-toggle"
                onClick={() => setSchemaOpen(!schemaOpen)}
              >
                <span className={chevronCls(schemaOpen)} />
                {t('mcp.toolDetail.rawSchema')}
              </button>
              {schemaOpen && (
                <pre className="mcp-tool-dialog__schema-json">{schemaPretty(tool.inputSchema)}</pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 折叠箭头类名（展开转 90°）*/
function chevronCls(open: boolean): string {
  return 'codicon codicon-chevron-right mcp-tool-dialog__schema-chevron' + (open ? ' open' : '')
}

/** 原始 Schema 展示文本：字符串形态先解析美化（与 schemaToRows 的兼容对齐），解析失败原样 */
function schemaPretty(schema: unknown): string {
  if (typeof schema === 'string') {
    try {
      return JSON.stringify(JSON.parse(schema), null, 2)
    } catch {
      return schema
    }
  }
  return JSON.stringify(schema, null, 2)
}
