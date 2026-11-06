/**
 * 新增/编辑 MCP 服务器弹窗（设置页「MCP」，对齐官方客户端新建/编辑表单）
 *
 * 双模式：表单（名称/作用域/类型 + stdio 命令·参数·环境变量 / 远程 URL·请求头）
 * 与 JSON（完整配置形态 name 为键；粘贴兼容 {"server":{...}} 与 {"mcpServers":
 * {"server":{...}}} 包裹，解析在 utils/mcpServerJson）；双向切换时互相回填
 * （JSON 解析失败保留表单原值，保存时才报错）。
 * 编辑模式（initial 传入卡片服务器）：名称/配置可改、作用域锁定（跨文件移动不做），
 * 保存带 previousName —— 同名覆盖 / 改名由 Kotlin 单次写原子完成；表单外字段
 * （cwd 等）同类型编辑时原样保留。数据：saveMcpServer（store → McpConfigWriter
 * 落盘 user/project 配置）；监听 mcpSavedSignal 成功信号关弹窗，mcpSaveError 内联展示。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { parseServerJson, serializeServerJson } from '@/utils/mcpServerJson'
import '../styles/mcp-server-edit-dialog.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

type Transport = 'stdio' | 'http' | 'sse'
type Scope = 'user' | 'project'
interface KvRow {
  k: string
  v: string
}

/** 编辑模式的预填来源（McpListView 从卡片 server 构造；raw=磁盘原始条目）*/
export interface McpServerEditInitial {
  name: string
  scope: Scope
  raw?: Record<string, unknown>
}

/** 从 form 状态拼 mcp.servers 条目（与 McpConfigReader 解析字段对齐）*/
function buildEntry(transport: Transport, command: string, argsText: string, envRows: KvRow[], url: string, headerRows: KvRow[]): Record<string, unknown> {
  if (transport === 'stdio') {
    const args = argsText.trim().split(/\s+/).filter(Boolean)
    const env = kvRowsToRecord(envRows)
    return {
      command: command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    }
  }
  const headers = kvRowsToRecord(headerRows)
  return {
    type: transport,
    url: url.trim(),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  }
}

function kvRowsToRecord(rows: KvRow[]): Record<string, string> | null {
  const out: Record<string, string> = {}
  rows.forEach((r) => {
    const k = r.k.trim()
    if (k) out[k] = r.v
  })
  return out
}

function recordToRows(v: unknown): KvRow[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return []
  return Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => typeof val === 'string')
    .map(([k, val]) => ({ k, v: val as string }))
}

/** 原始条目与表单所选类型是否一致（一致才做表单外字段保留，换类型从零构造）*/
function rawMatchesTransport(raw: Record<string, unknown>, transport: Transport): boolean {
  if (typeof raw.command === 'string' && raw.command) return transport === 'stdio'
  if (typeof raw.url === 'string' && raw.url) return transport === (raw.type === 'sse' ? 'sse' : 'http')
  return false
}

export function McpServerEditDialog({ initial, onClose }: { initial?: McpServerEditInitial; onClose: () => void }) {
  const { t } = useTranslation()
  const mcpSaving = useStore((s) => s.mcpSaving)
  const mcpSaveError = useStore((s) => s.mcpSaveError)
  const mcpSavedSignal = useStore((s) => s.mcpSavedSignal)
  const saveMcpServer = useStore((s) => s.saveMcpServer)
  const clearMcpSaveError = useStore((s) => s.clearMcpSaveError)

  const editing = !!initial
  const initRaw = initial?.raw ?? {}
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [scope, setScope] = useState<Scope>(initial?.scope ?? 'user')
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState<Transport>(() => {
    if (typeof initRaw.command === 'string' && initRaw.command) return 'stdio'
    if (typeof initRaw.url === 'string' && initRaw.url) return initRaw.type === 'sse' ? 'sse' : 'http'
    return 'stdio'
  })
  const [command, setCommand] = useState(typeof initRaw.command === 'string' ? initRaw.command : '')
  const [argsText, setArgsText] = useState(() =>
    Array.isArray(initRaw.args) ? initRaw.args.filter((x) => typeof x === 'string').join(' ') : '',
  )
  const [envRows, setEnvRows] = useState<KvRow[]>(() => recordToRows(initRaw.env))
  const [url, setUrl] = useState(typeof initRaw.url === 'string' ? initRaw.url : '')
  const [headerRows, setHeaderRows] = useState<KvRow[]>(() => recordToRows(initRaw.headers))
  const [jsonText, setJsonText] = useState(() => serializeServerJson(initial?.name ?? '', initRaw))
  const [localError, setLocalError] = useState<string | null>(null)
  /** 本弹窗发起保存的时间戳基线（挂载时刻起算，区分历史信号——重开弹窗时上一次
   *  保存的成功信号还留在 store 里，无守卫会挂载即自关，AgentListView 同款防线）*/
  const savedAtRef = useRef(Date.now())

  // 保存成功信号（at >= 发起时刻才认）→ 关弹窗；展开新卡片由列表监听同一信号
  useEffect(() => {
    if (mcpSavedSignal && mcpSavedSignal.at >= savedAtRef.current) onClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpSavedSignal?.at])

  // 关闭时清错误文案（下次打开是干净态）
  useEffect(() => () => clearMcpSaveError(), [clearMcpSaveError])

  /** 编辑模式同类型保留表单外字段（cwd/timeout 等读侧透传的原始键），换类型从零构造。
   *  表单保存与表单→JSON 序列化共用——JSON 视图所见即所存，切换不会静默丢字段 */
  const mergeRawExtras = (entry: Record<string, unknown>): Record<string, unknown> => {
    if (!editing || !rawMatchesTransport(initRaw, transport)) return entry
    const extra: Record<string, unknown> = { ...initRaw }
    for (const k of ['name', 'command', 'args', 'env', 'url', 'headers', 'type']) delete extra[k]
    return { ...extra, ...entry }
  }

  const switchMode = (next: 'form' | 'json') => {
    if (next === mode) return
    setLocalError(null)
    if (next === 'json') {
      // 表单 → JSON：当前表单序列化（含半填状态，粘贴改写更顺手；编辑态并入保留字段）
      setJsonText(serializeServerJson(name, mergeRawExtras(buildEntry(transport, command, argsText, envRows, url, headerRows))))
    } else {
      // JSON → 表单：尽力回填（三形态兼容解析），解析失败保留表单原值（保存时才报错）
      const parsed = parseServerJson(jsonText)
      if (parsed.ok) {
        setName(parsed.name)
        const obj = parsed.entry
        const cmd = typeof obj.command === 'string' ? obj.command : ''
        const u = typeof obj.url === 'string' ? obj.url : ''
        if (cmd) {
          setTransport('stdio')
          setCommand(cmd)
          setArgsText(Array.isArray(obj.args) ? obj.args.filter((x) => typeof x === 'string').join(' ') : '')
          setEnvRows(recordToRows(obj.env))
        } else if (u) {
          setTransport(obj.type === 'sse' ? 'sse' : 'http')
          setUrl(u)
          setHeaderRows(recordToRows(obj.headers))
        }
      }
    }
    setMode(next)
  }

  const submit = () => {
    setLocalError(null)
    let entry: Record<string, unknown>
    let finalName: string
    if (mode === 'json') {
      const parsed = parseServerJson(jsonText)
      if (!parsed.ok) {
        setLocalError(
          parsed.code === 'parse'
            ? t('mcp.edit.jsonParseError', { error: parsed.message })
            : parsed.code === 'multi'
              ? t('mcp.edit.jsonMultiServer')
              : t('mcp.edit.invalidEntry'),
        )
        return
      }
      finalName = parsed.name
      entry = parsed.entry
    } else {
      finalName = name.trim()
      if (!finalName || finalName.length > 128 || /\s/.test(finalName)) {
        setLocalError(t('mcp.edit.invalidName'))
        return
      }
      entry = buildEntry(transport, command, argsText, envRows, url, headerRows)
      // 编辑模式同类型保留表单外字段（与 JSON 视图同源，见 mergeRawExtras）
      entry = mergeRawExtras(entry)
    }
    if (!finalName) {
      setLocalError(t('mcp.edit.invalidName'))
      return
    }
    if (typeof entry.command !== 'string' && typeof entry.url !== 'string') {
      setLocalError(t('mcp.edit.invalidEntry'))
      return
    }
    if (typeof entry.url === 'string' && !/^https?:\/\//.test(entry.url)) {
      setLocalError(t('mcp.edit.invalidUrl'))
      return
    }
    savedAtRef.current = Date.now()
    saveMcpServer(scope, finalName, entry, initial?.name)
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content mcp-edit-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-edit-dialog__header">
          <div className="mcp-edit-dialog__heading">
            <h3 className="mcp-edit-dialog__title">
              {editing ? t('mcp.edit.titleEdit') : t('mcp.edit.title')}
            </h3>
            {editing && <div className="mcp-edit-dialog__subtitle">{t('mcp.edit.tipEdit')}</div>}
          </div>
          <div className="mcp-edit-dialog__mode">
            <button className={cx('mcp-edit-dialog__mode-btn', mode === 'form' && 'active')} onClick={() => switchMode('form')}>
              {t('mcp.edit.modeForm')}
            </button>
            <button className={cx('mcp-edit-dialog__mode-btn', mode === 'json' && 'active')} onClick={() => switchMode('json')}>
              JSON
            </button>
          </div>
        </div>

        <div className="mcp-edit-dialog__body">
          {mode === 'form' ? (
            <>
              <div className="mcp-edit-dialog__row2">
                <label className="mcp-edit-dialog__field">
                  <span className="mcp-edit-dialog__label">{t('mcp.edit.name')}</span>
                  <input
                    className="mcp-edit-dialog__input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="my-mcp-server"
                    autoFocus={!editing}
                  />
                </label>
                <label className="mcp-edit-dialog__field">
                  <span className="mcp-edit-dialog__label">{t('mcp.edit.scope')}</span>
                  <select
                    className="mcp-edit-dialog__input"
                    value={scope}
                    onChange={(e) => setScope(e.target.value as Scope)}
                    disabled={editing}
                    title={editing ? t('mcp.edit.scopeLocked') : undefined}
                  >
                    <option value="user">{t('mcp.scope.user')}</option>
                    <option value="project">{t('mcp.scope.project')}</option>
                  </select>
                  <span className="mcp-edit-dialog__field-hint">
                    {scope === 'user' ? '~/.zcode/cli/config.json' : '.zcode/config.json'}
                  </span>
                </label>
              </div>
              <label className="mcp-edit-dialog__field">
                <span className="mcp-edit-dialog__label">{t('mcp.edit.type')}</span>
                <select
                  className="mcp-edit-dialog__input mcp-edit-dialog__input--narrow"
                  value={transport}
                  onChange={(e) => setTransport(e.target.value as Transport)}
                >
                  <option value="stdio">{t('mcp.edit.typeStdio')}</option>
                  <option value="http">{t('mcp.edit.typeHttp')}</option>
                  <option value="sse">{t('mcp.edit.typeSse')}</option>
                </select>
              </label>
              {transport === 'stdio' ? (
                <>
                  <label className="mcp-edit-dialog__field">
                    <span className="mcp-edit-dialog__label">{t('mcp.edit.command')}</span>
                    <input
                      className="mcp-edit-dialog__input"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder="npx"
                    />
                  </label>
                  <label className="mcp-edit-dialog__field">
                    <span className="mcp-edit-dialog__label">{t('mcp.edit.args')}</span>
                    <input
                      className="mcp-edit-dialog__input"
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      placeholder="-y @modelcontextprotocol/server-memory"
                    />
                  </label>
                  <KvEditor title={t('mcp.edit.env')} rows={envRows} onChange={setEnvRows} />
                </>
              ) : (
                <>
                  <label className="mcp-edit-dialog__field">
                    <span className="mcp-edit-dialog__label">{t('mcp.edit.url')}</span>
                    <input
                      className="mcp-edit-dialog__input"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://example.com/mcp"
                    />
                  </label>
                  <KvEditor title={t('mcp.edit.headers')} rows={headerRows} onChange={setHeaderRows} />
                </>
              )}
            </>
          ) : (
            <>
              <div className="mcp-edit-dialog__json-hint">{t('mcp.edit.jsonHint')}</div>
              <textarea
                className="mcp-edit-dialog__json"
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                spellCheck={false}
              />
            </>
          )}

          {(localError || mcpSaveError) && (
            <div className="mcp-edit-dialog__error">
              <span className="codicon codicon-error" />
              {localError || mcpSaveError}
            </div>
          )}
        </div>

        <div className="mcp-edit-dialog__footer">
          <button className="mcp-edit-dialog__btn mcp-edit-dialog__btn--primary" onClick={submit} disabled={mcpSaving}>
            {mcpSaving ? (
              <>
                <span className="codicon codicon-loading spin" /> {t('mcp.edit.saving')}
              </>
            ) : (
              t('common.actions.save')
            )}
          </button>
          <button className="mcp-edit-dialog__btn" onClick={onClose} disabled={mcpSaving}>
            {t('common.confirm.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 环境变量/请求头动态行编辑器（key 空行保存时忽略）*/
function KvEditor({ title, rows, onChange }: { title: string; rows: KvRow[]; onChange: (rows: KvRow[]) => void }) {
  const { t } = useTranslation()
  const update = (i: number, patch: Partial<KvRow>) => {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  return (
    <div className="mcp-edit-dialog__field">
      <span className="mcp-edit-dialog__label">{title}</span>
      {rows.map((r, i) => (
        <div key={i} className="mcp-edit-dialog__kv-row">
          <input className="mcp-edit-dialog__input" value={r.k} onChange={(e) => update(i, { k: e.target.value })} placeholder="KEY" />
          <input className="mcp-edit-dialog__input" value={r.v} onChange={(e) => update(i, { v: e.target.value })} placeholder="VALUE" />
          <button
            className="mcp-edit-dialog__kv-del"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            title={t('mcp.edit.removeVar')}
          >
            <span className="codicon codicon-trash" />
          </button>
        </div>
      ))}
      <button className="mcp-edit-dialog__kv-add" onClick={() => onChange([...rows, { k: '', v: '' }])}>
        <span className="codicon codicon-add" />
        {t('mcp.edit.addVar')}
      </button>
    </div>
  )
}
