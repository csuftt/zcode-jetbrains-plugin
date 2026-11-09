/**
 * 新建/编辑钩子弹窗（设置页「钩子」；2026-11-09 反转 2026-10-12「不做内置编辑页」
 * 旧决策，表单形态对齐官方客户端）
 *
 * 字段映射（CLI zod schema + 官方 zcode-guide 文档核实）：
 *   - 事件固定 7 枚举；运行方式 = type（Shell 命令=command / 进程=process）
 *   - command 型：命令=shell 串 + Shell 覆盖（shell，空=系统默认）+ 后台运行（async）
 *     + 超时秒（timeout）；process 型：命令=可执行文件 + 参数多行（args）+ 超时毫秒
 *     （timeoutMs）——两型字段互斥，Kotlin parseSavePayload 兜底校验
 *   - matcher 属于事件组（组内钩子共享）：编辑改 matcher 时单钩组直改、多钩组拆分
 *     （Kotlin upsertHookInConfig）
 * 作用域编辑态锁定（跨文件移动不做）；工作区作用域保存后 digest 变化需重新信任
 * （官方机制，弹窗内提示）。保存走 workspaceHooksSave，成功按权威对账回包
 * （sourceOp=workspaceHooksSave）关闭，失败 error.sourceOp 同名内联展示；
 * 编辑态左下角删除复用页面既有 ConfirmDialog 流程。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { onMessage, sendToJava } from '@/ipc/bridge'
import type { HookRawEntry, HookSavePayload, WorkspaceHooksStatusItem } from '@/types/messages'
import '../styles/hook-edit-dialog.less'

/** CLI zod enum 同款 7 事件（Kotlin HOOK_EVENTS 同源；保存校验双侧一致） */
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
] as const

type RunType = 'command' | 'process'
type Scope = 'workspace' | 'user'

/** 弹窗目标：item=null=新建（scope 可选）；编辑态 scope 随条目来源锁定 */
export interface HookEditTarget {
  scope: Scope
  /** scope=workspace 时的目录（新建落盘 <ws>/.zcode/config.json） */
  workspace?: string
  item: WorkspaceHooksStatusItem | null
}

interface Props {
  target: HookEditTarget
  /** 预填的原始钩子对象（新建={}；编辑=workspaceHooksGet 结果，未就绪不渲染） */
  raw: HookRawEntry | null
  onClose: () => void
  /** 编辑态左下角删除：交给页面既有 ConfirmDialog 流程（页面先关本弹窗） */
  onRequestDelete: (item: WorkspaceHooksStatusItem) => void
}

/** 工作区 basename（显示用；与 HookListView 同款规则，本地复制避免循环依赖） */
function workspaceBasename(p?: string): string {
  if (!p) return ''
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return norm.slice(norm.lastIndexOf('/') + 1)
}

export function HookEditDialog({ target, raw, onClose, onRequestDelete }: Props) {
  const { t } = useTranslation()
  const editing = !!target.item
  const [event, setEvent] = useState(target.item?.event ?? 'PreToolUse')
  const [runType, setRunType] = useState<RunType>(raw?.type === 'process' ? 'process' : 'command')
  const [scope, setScope] = useState<Scope>(target.scope)
  const [matcher, setMatcher] = useState(target.item?.matcher ?? '')
  const [command, setCommand] = useState(typeof raw?.command === 'string' ? raw.command : '')
  const [argsText, setArgsText] = useState(Array.isArray(raw?.args) ? raw.args.join('\n') : '')
  const [shell, setShell] = useState(typeof raw?.shell === 'string' ? raw.shell : '')
  const [asyncRun, setAsyncRun] = useState(raw?.async === true)
  // 高级·超时：command 存秒（timeout）/ process 存毫秒（timeoutMs，官方优先字段）；
  // 原始两者都有时按各自型回显权威字段
  const [timeoutText, setTimeoutText] = useState(() => {
    if (raw?.timeoutMs != null) return String(raw.timeoutMs)
    if (raw?.timeout != null) return String(raw.timeout)
    return ''
  })
  const [advancedOpen, setAdvancedOpen] = useState(raw?.timeoutMs != null || raw?.timeout != null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // onClose 经 ref 进订阅（依赖数组空——弹窗生命周期内订阅只建一次）
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.op === 'workspaceHooksList' && msg.sourceOp === 'workspaceHooksSave') {
        // 保存成功：权威对账回包 → 关弹窗（列表落账由钩子页统一分支完成）
        onCloseRef.current()
      } else if (msg.op === 'error' && msg.sourceOp === 'workspaceHooksSave') {
        setSaving(false)
        setError(msg.message)
      }
    })
    return off
  }, [])

  const canSave = command.trim().length > 0 && !saving && (scope === 'user' || !!target.workspace)

  const submit = () => {
    if (!canSave) return
    setError('')
    const payload: HookSavePayload = { event, type: runType, command: command.trim() }
    if (matcher.trim()) payload.matcher = matcher.trim()
    if (runType === 'process') {
      const args = argsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      if (args.length > 0) payload.args = args
      const ms = Number(timeoutText.trim())
      if (timeoutText.trim()) {
        if (!Number.isFinite(ms) || ms <= 0) {
          setError(t('hooks.timeoutInvalid'))
          return
        }
        payload.timeoutMs = ms
      }
    } else {
      if (shell.trim()) payload.shell = shell.trim()
      if (asyncRun) payload.async = true
      const sec = Number(timeoutText.trim())
      if (timeoutText.trim()) {
        if (!Number.isFinite(sec) || sec <= 0) {
          setError(t('hooks.timeoutInvalid'))
          return
        }
        payload.timeout = sec
      }
    }
    setSaving(true)
    sendToJava({
      op: 'workspaceHooksSave',
      ...(scope === 'user' ? { scope: 'user' as const } : { scope: 'workspace' as const, workspace: target.workspace }),
      payload,
      ...(editing && target.item
        ? { reviewItemId: target.item.reviewItemId, sourcePath: target.item.sourcePath }
        : {}),
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content hook-edit" onClick={(e) => e.stopPropagation()}>
        <div className="hook-edit__header">
          <h3 className="hook-edit__title">{editing ? t('hooks.editHook') : t('hooks.newHook')}</h3>
          <div className="hook-edit__desc">{t('hooks.formDesc')}</div>
        </div>
        <div className="hook-edit__body">
          <div className="hook-edit__row">
            <label className="hook-edit__field">
              <span className="hook-edit__label">{t('hooks.fieldEvent')}</span>
              <select className="hook-edit__input" value={event} onChange={(e) => setEvent(e.target.value)}>
                {HOOK_EVENTS.map((ev) => (
                  <option key={ev} value={ev}>{ev}</option>
                ))}
              </select>
            </label>
            <label className="hook-edit__field">
              <span className="hook-edit__label">{t('hooks.fieldRunMode')}</span>
              <select
                className="hook-edit__input"
                value={runType}
                onChange={(e) => setRunType(e.target.value as RunType)}
              >
                <option value="command">{t('hooks.runModeCommand')}</option>
                <option value="process">{t('hooks.runModeProcess')}</option>
              </select>
            </label>
            <label className="hook-edit__field hook-edit__field--scope">
              <span className="hook-edit__label">{t('hooks.fieldScope')}</span>
              <select
                className="hook-edit__input"
                value={scope}
                disabled={editing}
                title={editing ? target.item?.sourcePath : undefined}
                onChange={(e) => setScope(e.target.value as Scope)}
              >
                <option value="workspace">
                  {t('hooks.scopeOptionWorkspace', { name: workspaceBasename(target.workspace) })}
                </option>
                <option value="user">{t('hooks.scopeOptionUser')}</option>
              </select>
            </label>
          </div>
          <div className="hook-edit__row">
            <label className="hook-edit__field">
              <span className="hook-edit__label">{t('hooks.fieldMatcher')}</span>
              <input
                className="hook-edit__input"
                value={matcher}
                onChange={(e) => setMatcher(e.target.value)}
                placeholder={t('hooks.matcherPlaceholder')}
                spellCheck={false}
              />
              <span className="hook-edit__hint">{t('hooks.matcherHint')}</span>
            </label>
            <label className="hook-edit__field">
              <span className="hook-edit__label">{t('hooks.fieldCommand')}</span>
              <input
                className="hook-edit__input"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={runType === 'process' ? t('hooks.commandPlaceholderProcess') : t('hooks.commandPlaceholder')}
                spellCheck={false}
                autoFocus={!editing}
              />
            </label>
          </div>
          {runType === 'command' ? (
            <div className="hook-edit__row">
              <label className="hook-edit__field">
                <span className="hook-edit__label">{t('hooks.fieldShell')}</span>
                <input
                  className="hook-edit__input"
                  value={shell}
                  onChange={(e) => setShell(e.target.value)}
                  placeholder={t('hooks.shellPlaceholder')}
                  spellCheck={false}
                />
              </label>
              <div className="hook-edit__field hook-edit__field--toggle">
                <span className="hook-edit__label">{t('hooks.backgroundRun')}</span>
                <button
                  type="button"
                  className={`hook-switch ${asyncRun ? 'hook-switch--on' : ''}`}
                  role="switch"
                  aria-checked={asyncRun}
                  onClick={() => setAsyncRun(!asyncRun)}
                >
                  <span className="hook-switch__knob" />
                </button>
              </div>
            </div>
          ) : (
            <label className="hook-edit__field">
              <span className="hook-edit__label">{t('hooks.fieldArgs')}</span>
              <textarea
                className="hook-edit__input hook-edit__input--area"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder={'--verbose\n--out result.txt'}
                rows={3}
                spellCheck={false}
              />
              <span className="hook-edit__hint">{t('hooks.argsHint')}</span>
            </label>
          )}
          <div className="hook-edit__divider" />
          <div className="hook-edit__advanced">
            <button
              type="button"
              className="hook-edit__advanced-toggle"
              onClick={() => setAdvancedOpen(!advancedOpen)}
            >
              <span className={`codicon ${advancedOpen ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} />
              {t('hooks.advanced')}
            </button>
            {advancedOpen && (
              <label className="hook-edit__field hook-edit__field--narrow">
                <span className="hook-edit__label">
                  {runType === 'command' ? t('hooks.fieldTimeout') : t('hooks.fieldTimeoutMs')}
                </span>
                <input
                  className="hook-edit__input"
                  value={timeoutText}
                  onChange={(e) => setTimeoutText(e.target.value)}
                  placeholder={t('hooks.timeoutPlaceholder')}
                  spellCheck={false}
                  inputMode="decimal"
                />
              </label>
            )}
          </div>
          {scope === 'workspace' && (
            <div className="hook-edit__trust-hint" role="note">
              <span className="codicon codicon-shield" />
              <span>{t('hooks.trustHint')}</span>
            </div>
          )}
          {error && (
            <div className="hook-edit__error">
              <span className="codicon codicon-error" />
              {error}
            </div>
          )}
        </div>
        <div className="hook-edit__footer">
          {editing && target.item ? (
            <button type="button" className="hook-edit__delete" onClick={() => onRequestDelete(target.item!)}>
              <span className="codicon codicon-trash" />
              {t('hooks.delete')}
            </button>
          ) : (
            <span />
          )}
          <div className="hook-edit__footer-right">
            <button
              type="button"
              className="hook-edit__btn hook-edit__btn--primary"
              onClick={submit}
              disabled={!canSave}
            >
              {saving ? t('hooks.saving') : t('common.actions.save')}
            </button>
            <button type="button" className="hook-edit__btn" onClick={onClose} disabled={saving}>
              {t('common.confirm.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
