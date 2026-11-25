/**
 * 子智能体管理面板（设置页「子智能体」条目，数据与 ZCode 客户端 agents/*.md 打通）
 *
 * 数据：listAgents（Kotlin AgentScanner：~/.zcode/agents 用户级 + <项目>/.zcode/agents 项目级）
 * 交互：卡片列表（色点+名称+描述+作用域徽标）；新建/编辑弹窗（名称/颜色/模型/描述/
 *       可用工具/系统提示词/注入 AGENTS.md，字段对齐 ZCode 客户端设置页表单）；
 *       删除二次确认。生效时机看 builtInRuntimeConfigLive：当代 CLI 下运行时每个回合开始
 *       向插件重取子代理配置（改完下一回合生效），旧版 CLI 只有新会话才加载。
 * 底部另列内置子代理（general-purpose/Explore，对齐 ZCode 客户端「内置子智能体」）：
 *       无定义文件，只能改模型与思考深度（与客户端共用 ~/.zcode/v2/agents-state.json）。
 * 卡片样式复用 skill-card 体系（同页不同 tab，不冲突）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { sendToJava } from '@/ipc/bridge'
import type { AgentDef, AgentModelSelection, BuiltinAgentInfo } from '@/types/messages'
import { groupModelsByProvider } from '@/utils/modelGroups'
import { AgentColorDot, AGENT_COLORS } from './AgentSelect'
import { thoughtLevelLabel } from './ThoughtLevelSelect'
import '../styles/skill-list-view.less'
import '../styles/agent-list-view.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** name 校验（zcode.cjs 实测正则，与文件名一致）*/
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/

/** 设置页「可用工具」勾选项 = CLI 内置工具（ZCode 客户端设置页同清单）*/
const BUILTIN_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'TodoWrite']

type Scope = 'user' | 'project'

/** 编辑弹窗表单状态 */
interface AgentForm {
  scope: Scope
  name: string
  description: string
  color: string
  /** 'inherit' = 跟随主 Agent */
  model: string
  /** 'all' = 继承全部工具（tools 恒空）；'custom' = 仅勾选的 tools */
  toolsMode: 'all' | 'custom'
  tools: string[]
  systemPrompt: string
  injectAgentsMd: boolean
  /**
   * 表单不暴露的高级字段（ZCode 客户端可定义）：编辑时原样带回保存，
   * 不做 UI 编辑——否则插件内一保存就会把这些字段清空，破坏共用文件
   */
  thoughtLevel: string | null
  maxTurns: number | null
  disallowedTools: string[]
  mcpServers: string[]
}

const emptyForm = (scope: Scope): AgentForm => ({
  scope,
  name: '',
  description: '',
  color: 'blue',
  model: 'inherit',
  toolsMode: 'all',
  tools: [],
  systemPrompt: '',
  injectAgentsMd: true,
  thoughtLevel: null,
  maxTurns: null,
  disallowedTools: [],
  mcpServers: [],
})

const formFromDef = (a: AgentDef): AgentForm => ({
  scope: a.scope,
  name: a.name,
  description: a.description,
  color: a.color ?? 'blue',
  model: a.model ?? 'inherit',
  toolsMode: a.tools.length > 0 ? 'custom' : 'all',
  tools: [...a.tools],
  systemPrompt: a.systemPrompt,
  injectAgentsMd: a.injectAgentsMd,
  thoughtLevel: a.thoughtLevel ?? null,
  maxTurns: a.maxTurns ?? null,
  disallowedTools: [...a.disallowedTools],
  mcpServers: [...a.mcpServers],
})

/** 新建/编辑弹窗（字段对齐 ZCode 客户端「新建子智能体」表单）*/
function AgentEditDialog({
  initial,
  originalName,
  onClose,
}: {
  initial: AgentForm
  /** 编辑前的名称（null = 新建）；编辑态锁定作用域（跨作用域移动不做）*/
  originalName: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const saveAgent = useStore((s) => s.saveAgent)
  const models = useStore((s) => s.models)
  const savedSignal = useStore((s) => s.agentSavedSignal)
  const [form, setForm] = useState<AgentForm>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 本弹窗发起保存的时间戳（区分历史信号；响应到达时关弹窗）*/
  const savedAtRef = useRef(0)

  // 写盘成功回包（store 的 agentSavedSignal）→ 关闭弹窗（弹窗由父级 setEditing(null) 卸载）
  useEffect(() => {
    if (saving && savedSignal && savedSignal.at >= savedAtRef.current) {
      onClose()
    }
  }, [savedSignal, saving, onClose])

  // 模型下拉：inherit + 全部已注册模型（跨 provider 去重）
  const modelIds = useMemo(() => [...new Set(models.map((m) => m.modelId))].sort(), [models])

  const nameInvalid = form.name.length > 0 && !NAME_RE.test(form.name)
  const canSave =
    !!form.name.trim() &&
    !nameInvalid &&
    !!form.description.trim() &&
    !!form.systemPrompt.trim() &&
    // 自定义档勾 0 个工具 = 档位落盘后静默变回所有权限，直接拦下
    !(form.toolsMode === 'custom' && form.tools.length === 0) &&
    !saving

  const handleSave = () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    savedAtRef.current = Date.now()
    saveAgent(
      form.scope,
      {
        name: form.name.trim(),
        description: form.description.trim(),
        color: form.color || undefined,
        model: form.model === 'inherit' ? undefined : form.model,
        tools: form.toolsMode === 'all' ? [] : form.tools,
        // 表单未暴露的高级字段原样带回（编辑不清空 ZCode 客户端定义的内容）
        thoughtLevel: form.thoughtLevel ?? undefined,
        maxTurns: form.maxTurns ?? undefined,
        disallowedTools: form.disallowedTools,
        mcpServers: form.mcpServers,
        injectAgentsMd: form.injectAgentsMd,
        systemPrompt: form.systemPrompt,
      },
      originalName ?? undefined,
    )
    // 兜底：3s 无 agentSaved 回包（Kotlin 异常走全局 error 栏）解锁并提示可重试
    setTimeout(() => {
      setSaving((s) => {
        if (s) setError(t('agents.edit.saveTimeout'))
        return false
      })
    }, 3000)
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={saving ? undefined : onClose}>
      <div
        className="modal-content agent-edit-dialog"
        role="dialog"
        aria-label={t(originalName ? 'agents.edit.titleEdit' : 'agents.edit.titleNew')}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t(originalName ? 'agents.edit.titleEdit' : 'agents.edit.titleNew')}</h3>

        <div className="agent-edit-dialog__grid">
          <label className="agent-edit-dialog__field">
            <span className="agent-edit-dialog__label">{t('agents.edit.scope')}</span>
            <select
              value={form.scope}
              disabled={!!originalName}
              onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value as Scope }))}
            >
              <option value="user">{t('skills.scope.user')}</option>
              <option value="project">{t('skills.scope.project')}</option>
            </select>
          </label>

          <label className="agent-edit-dialog__field">
            <span className="agent-edit-dialog__label">{t('agents.edit.name')}</span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="my-agent"
              spellCheck={false}
            />
            {nameInvalid && <span className="agent-edit-dialog__error">{t('agents.edit.nameInvalid')}</span>}
          </label>

          <div className="agent-edit-dialog__field">
            <span className="agent-edit-dialog__label">{t('agents.edit.color')}</span>
            <div className="agent-edit-dialog__colors">
              {Object.entries(AGENT_COLORS).map(([key, hex]) => (
                <button
                  key={key}
                  type="button"
                  className={cx('agent-edit-dialog__color', form.color === key && 'selected')}
                  style={{ background: hex }}
                  title={key}
                  onClick={() => setForm((f) => ({ ...f, color: key }))}
                />
              ))}
            </div>
          </div>

          <label className="agent-edit-dialog__field">
            <span className="agent-edit-dialog__label">{t('agents.edit.model')}</span>
            <select
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            >
              <option value="inherit">{t('agents.edit.modelInherit')}</option>
              {modelIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="agent-edit-dialog__field">
          <span className="agent-edit-dialog__label">{t('agents.edit.description')}</span>
          <input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder={t('agents.edit.descriptionPlaceholder')}
          />
        </label>

        <div className="agent-edit-dialog__field">
          <span className="agent-edit-dialog__label">
            {t('agents.edit.tools')}
            <span className="agent-edit-dialog__hint">{t('agents.edit.toolsHint')}</span>
          </span>
          {/* 对齐 ZCode 客户端：下拉两档（默认所有权限 / 自定义可用工具），选自定义才展开勾选。
              切档不动 form.tools（暂存原勾选）：自定义→所有权限→自定义可恢复原配置；
              原配置为所有权限（tools 空）首次切自定义档预填全量——从"全选"收窄而非从零勾起；
              序列化时按档位处理（all 恒写空列表） */}
          <select
            value={form.toolsMode}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                toolsMode: e.target.value as 'all' | 'custom',
                ...(e.target.value === 'custom' && f.tools.length === 0
                  ? { tools: [...BUILTIN_TOOLS] }
                  : null),
              }))
            }
          >
            <option value="all">{t('agents.edit.toolsAllOption')}</option>
            <option value="custom">{t('agents.edit.toolsCustomOption')}</option>
          </select>
          {form.toolsMode === 'custom' && (
            <>
              <div className="agent-edit-dialog__tools">
                {BUILTIN_TOOLS.map((tool) => {
                  const checked = form.tools.includes(tool)
                  return (
                    <label key={tool} className={cx('agent-edit-dialog__tool', checked && 'checked')}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setForm((f) => ({
                            ...f,
                            tools: checked ? f.tools.filter((x) => x !== tool) : [...f.tools, tool],
                          }))
                        }
                      />
                      {tool}
                    </label>
                  )
                })}
              </div>
              <span className="agent-edit-dialog__hint">
                {form.tools.length === 0
                  ? t('agents.edit.toolsCustomEmpty')
                  : t('agents.edit.toolsSelected', { count: form.tools.length })}
              </span>
            </>
          )}
        </div>

        <label className="agent-edit-dialog__field agent-edit-dialog__field--grow">
          <span className="agent-edit-dialog__label">{t('agents.edit.systemPrompt')}</span>
          <textarea
            value={form.systemPrompt}
            onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
            rows={9}
            placeholder={t('agents.edit.systemPromptPlaceholder')}
          />
        </label>

        <label className="agent-edit-dialog__switch">
          <input
            type="checkbox"
            checked={form.injectAgentsMd}
            onChange={(e) => setForm((f) => ({ ...f, injectAgentsMd: e.target.checked }))}
          />
          <span>{t('agents.edit.injectAgentsMd')}</span>
          <span className="agent-edit-dialog__hint">{t('agents.edit.injectAgentsMdHint')}</span>
        </label>

        {error && <div className="agent-edit-dialog__error agent-edit-dialog__error--block">{error}</div>}

        <div className="modal-actions">
          <button className="modal-btn" onClick={onClose} disabled={saving} type="button">
            {t('common.confirm.cancel')}
          </button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={handleSave}
            disabled={!canSave}
            type="button"
          >
            <span className={cx('codicon', saving ? 'codicon-loading codicon-modifier-spin' : '')} />
            {t('common.actions.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 卡片头部的工具数摘要（全部工具 / N 个工具）*/
function AgentToolsHint({ tools }: { tools: string[] }) {
  const { t } = useTranslation()
  return (
    <span className="agent-card__tools-hint">
      {tools.length === 0 ? t('agents.card.allTools') : t('agents.card.toolsCount', { count: tools.length })}
    </span>
  )
}

/** 详情区的描述行 */
function AgentDescriptionRow({ description }: { description: string }) {
  const { t } = useTranslation()
  return (
    <div className="skill-card__row">
      <span className="skill-card__row-label">{t('skills.card.descLabel')}</span>
      <span className="skill-card__row-value">{description}</span>
    </div>
  )
}

/** 单张子智能体卡片（复用 skill-card 布局体系）*/
function AgentCard({
  agent,
  expanded,
  onToggleExpand,
  onEdit,
  onDelete,
}: {
  agent: AgentDef
  expanded: boolean
  onToggleExpand: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className={cx('skill-card agent-card', expanded && 'expanded')}>
      <div className="skill-card__header" onClick={onToggleExpand}>
        <AgentColorDot color={agent.color} />
        <span className="skill-card__name">{agent.name}</span>
        <span className={cx('skill-card__scope', agent.scope === 'user' ? 'global' : 'local')}>
          <span
            className={cx(
              'codicon',
              agent.scope === 'user' ? 'codicon-globe' : 'codicon-device-desktop',
            )}
          />
          {t(agent.scope === 'user' ? 'skills.scope.user' : 'skills.scope.project')}
        </span>
        <span className="skill-card__path" title={agent.path}>
          {agent.model ? agent.model : t('agents.card.modelInherit')}
        </span>
        <AgentToolsHint tools={agent.tools} />
        <span className={cx('codicon skill-card__chevron', expanded && 'open', 'codicon-chevron-right')} />
      </div>

      {expanded && (
        <div className="skill-card__body">
          <AgentDescriptionRow description={agent.description} />
          <div className="skill-card__row">
            <span className="skill-card__row-label">{t('agents.edit.systemPrompt')}</span>
            <pre className="agent-card__prompt">{agent.systemPrompt}</pre>
          </div>
          {agent.tools.length > 0 && (
            <div className="skill-card__row">
              <span className="skill-card__row-label">{t('agents.edit.tools')}</span>
              <span className="skill-card__row-value">{agent.tools.join(', ')}</span>
            </div>
          )}
          <div className="skill-card__row">
            <span className="skill-card__row-label">{t('agents.edit.injectAgentsMd')}</span>
            <span className="skill-card__row-value">
              {agent.injectAgentsMd ? t('agents.card.injected') : t('agents.card.notInjected')}
            </span>
          </div>
          <div className="skill-card__actions">
            <button
              className="skill-card__action"
              onClick={() => sendToJava({ op: 'openFile', filePath: agent.path, line: 1 })}
              title={t('skills.card.openTitle')}
            >
              <span className="codicon codicon-go-to-file" />
              {t('skills.card.openInEditor')}
            </button>
            <button className="skill-card__action" onClick={onEdit} title={t('agents.card.editTitle')}>
              <span className="codicon codicon-edit" />
              {t('agents.card.edit')}
            </button>
            <button
              className="skill-card__action skill-card__action--danger"
              onClick={onDelete}
              title={t('agents.card.deleteTitle')}
            >
              <span className="codicon codicon-trash" />
              {t('agents.card.delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 内置子代理行（general-purpose/Explore）：没有定义文件可编辑，只有模型与思考深度两个下拉。
 * 模型下拉形态对齐 ZCode 客户端「内置子智能体」分区：按供应商分组，「继承默认」固定在末尾。
 * 思考深度同桌面端：候选 = 所选模型的档位集（因模型而异，取不到就不展示）；选了新模型时
 * 不带档位下发，Kotlin 补该模型最高档落盘；只改档位则带档位下发。
 */
function BuiltinAgentCard({
  agent,
  selection,
  onSelect,
}: {
  agent: BuiltinAgentInfo
  selection: AgentModelSelection | null
  onSelect: (selection: AgentModelSelection | null) => void
}) {
  const { t } = useTranslation()
  const models = useStore((s) => s.models)
  const reasoningLevels = useStore((s) => s.modelReasoningLevels)
  const loadModelReasoningLevels = useStore((s) => s.loadModelReasoningLevels)
  const groups = useMemo(() => groupModelsByProvider(models), [models])
  // 原生 select 的 value 只能是字符串：拿模型在扁平清单里的下标当 value、按位取回，
  // 不去拆 providerId/modelId 的拼接串（两者都可能含任意字符）
  const flat = useMemo(() => groups.flatMap(([, items]) => items), [groups])
  const current = selection
    ? flat.findIndex((m) => m.providerId === selection.providerId && m.modelId === selection.modelId)
    : -1
  const value = !selection ? 'inherit' : current >= 0 ? String(current) : 'stale'
  // 所选模型的档位集：键与 store 的缓存键同构；清单外的存量模型（stale）不取
  const selectedModel = selection && current >= 0 ? flat[current] : null
  const levelsKey = selectedModel ? `${selectedModel.providerId}|${selectedModel.modelId}` : ''
  const levelOptions = selectedModel ? (reasoningLevels[levelsKey] ?? null) : null
  // selectedModel 是 models 清单里的稳定对象引用，依赖它即「随所选模型变化」
  useEffect(() => {
    if (selectedModel) loadModelReasoningLevels(selectedModel.providerId, selectedModel.modelId)
  }, [selectedModel, loadModelReasoningLevels])
  const currentLevel = selection?.options?.reasoningLevel
  const levelSelected = !!currentLevel && !!levelOptions?.includes(currentLevel)
  return (
    <div className="skill-card agent-builtin-card">
      <div className="skill-card__header agent-builtin-card__header">
        <AgentColorDot color={agent.color} />
        <span className="skill-card__name">{agent.name}</span>
        <span className="agent-builtin-card__badge">{t('agents.builtin.badge')}</span>
        <AgentToolsHint tools={agent.tools} />
        {/* 模型/思考深度两个下拉成组：窄面板时整组换到第二行，组内只让模型下拉收缩——
            原先两个 select 各自 flex-shrink:0，面板一窄整行溢出，思考深度下拉被卡片
            overflow:hidden 整个裁掉 */}
        <div className="agent-builtin-card__controls">
          <select
            className="agent-builtin-card__model"
            aria-label={t('agents.edit.model')}
            value={value}
            onChange={(e) => {
              if (e.target.value === 'inherit') return onSelect(null)
              const m = flat[Number(e.target.value)]
              // 不带档位 = 选了新模型，由 Kotlin 补该模型最高档
              if (m) onSelect({ providerId: m.providerId, modelId: m.modelId })
            }}
          >
            {/* 存量覆盖指向的模型不在当前清单（渠道停用等）：如实显示存量值，仍可切回继承默认 */}
            {selection && current < 0 && (
              <option value="stale">{t('agents.builtin.staleModel', { model: selection.modelId })}</option>
            )}
            {groups.map(([providerId, items]) => (
              <optgroup key={providerId} label={items[0]?.providerName ?? providerId}>
                {items.map((m) => (
                  <option key={m.modelId} value={String(flat.indexOf(m))}>
                    {m.modelName || m.modelId}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value="inherit">{t('agents.builtin.inheritDefault')}</option>
          </select>
          {levelOptions && levelOptions.length > 0 && (
            <select
              className="agent-builtin-card__level"
              aria-label={t('agents.builtin.levelLabel')}
              value={levelSelected ? currentLevel : ''}
              onChange={(e) => {
                // 空值是「未选择」占位，不可选成档位
                if (e.target.value && selection) {
                  onSelect({ ...selection, options: { reasoningLevel: e.target.value } })
                }
              }}
            >
              {/* 存量条目缺档位、或档位已不在该模型的档位集里：如实显示「未选择」，不替用户猜 */}
              {!levelSelected && <option value="">{t('agents.builtin.levelUnset')}</option>}
              {levelOptions.map((level) => (
                <option key={level} value={level}>{thoughtLevelLabel(level, t)}</option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="skill-card__body">
        <AgentDescriptionRow description={agent.description} />
      </div>
    </div>
  )
}

export function AgentListView() {
  const { t } = useTranslation()
  const agents = useStore((s) => s.subagentDefs)
  const loadAgents = useStore((s) => s.loadAgents)
  const deleteAgent = useStore((s) => s.deleteAgent)
  const selectedAgent = useStore((s) => s.selectedAgent)
  const selectAgent = useStore((s) => s.selectAgent)
  const builtInAgents = useStore((s) => s.builtInAgents)
  const builtInSelections = useStore((s) => s.builtInSelections)
  const setBuiltInAgentModel = useStore((s) => s.setBuiltInAgentModel)
  const runtimeConfigLive = useStore((s) => s.builtInRuntimeConfigLive)

  const [query, setQuery] = useState('')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  /** 编辑弹窗：{ form, originalName } | null */
  const [editing, setEditing] = useState<{ form: AgentForm; originalName: string | null } | null>(null)
  /** 删除确认目标 */
  const [deleting, setDeleting] = useState<AgentDef | null>(null)

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return agents ?? []
    return (agents ?? []).filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.systemPrompt.toLowerCase().includes(q),
    )
  }, [agents, query])

  const visibleBuiltIn = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return builtInAgents
    return builtInAgents.filter(
      (b) => b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q),
    )
  }, [builtInAgents, query])

  return (
    <div className="skill-list-view agent-list-view">
      <div className="skill-list-view__toolbar">
        <div className="skill-list-view__tabs">
          <span className="agent-list-view__title">{t('agents.title')}</span>
        </div>
        <div className="skill-list-view__search">
          <span className="codicon codicon-search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('agents.searchPlaceholder')}
            spellCheck={false}
          />
        </div>
        <button
          className="skill-list-view__refresh"
          onClick={() => loadAgents()}
          title={t('skills.toolbar.rescan')}
        >
          <span className="codicon codicon-refresh" />
        </button>
        <button
          className="agent-list-view__new"
          onClick={() => setEditing({ form: emptyForm('user'), originalName: null })}
          title={t('agents.new')}
        >
          <span className="codicon codicon-add" />
          {t('agents.new')}
        </button>
      </div>

      <p className="agent-list-view__desc">
        {t('agents.desc')}
        {/* 独立 span 加间距：西文两句之间不能粘连，中文也不靠空格断句 */}
        <span className="agent-list-view__effect">
          {t(runtimeConfigLive ? 'agents.effectHintLive' : 'agents.effectHint')}
        </span>
      </p>

      {visible.length === 0 ? (
        <div className="skill-list-view__empty">
          <span className="codicon codicon-robot" />
          <span>{agents === null ? t('skills.list.scanning') : t('agents.empty')}</span>
        </div>
      ) : (
        <div className="skill-list-view__list">
          {visible.map((a) => {
            const key = `${a.scope}:${a.name}`
            return (
              <AgentCard
                key={key}
                agent={a}
                expanded={expandedKey === key}
                onToggleExpand={() => setExpandedKey(expandedKey === key ? null : key)}
                onEdit={() => setEditing({ form: formFromDef(a), originalName: a.name })}
                onDelete={() => setDeleting(a)}
              />
            )
          })}
        </div>
      )}

      {/* 内置子代理（general-purpose/Explore；模型覆盖与 ZCode 客户端共用 agents-state.json）*/}
      {visibleBuiltIn.length > 0 && (
        <div className="agent-builtin">
          <div className="agent-builtin__heading">
            {t('agents.builtin.title')}
            <span className="agent-builtin__count">{visibleBuiltIn.length}</span>
          </div>
          {/* 设置页没有 toast 通道（同 StarSupportSection 的取舍）：生效时机写成常驻说明，
              选择结果本身由下拉的当前值直接体现；实时供给（当代 CLI）与旧版 CLI 文案不同 */}
          <p className="agent-builtin__hint">
            {t(runtimeConfigLive ? 'agents.builtin.effectiveHintLive' : 'agents.builtin.effectiveHint')}
          </p>
          <div className="skill-list-view__list">
            {visibleBuiltIn.map((b) => (
              <BuiltinAgentCard
                key={b.name}
                agent={b}
                selection={builtInSelections[b.name] ?? null}
                onSelect={(sel) => setBuiltInAgentModel(b.name, sel)}
              />
            ))}
          </div>
        </div>
      )}

      {editing && (
        <AgentEditDialog
          initial={editing.form}
          originalName={editing.originalName}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <div className="modal-overlay" role="presentation" onClick={() => setDeleting(null)}>
          <div
            className="modal-content agent-delete-dialog"
            role="dialog"
            aria-label={t('agents.delete.title')}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{t('agents.delete.title')}</h3>
            <p className="agent-delete-dialog__message">
              {t('agents.delete.message', { name: deleting.name })}
            </p>
            <div className="modal-actions">
              <button className="modal-btn" onClick={() => setDeleting(null)} type="button">
                {t('common.confirm.cancel')}
              </button>
              <button
                className="modal-btn modal-btn-danger"
                onClick={() => {
                  deleteAgent(deleting.scope, deleting.name)
                  // 删除的是当前选中项 → 取消选择（store agentDeleted 响应也会兜底）
                  if (selectedAgent?.name === deleting.name) selectAgent(null)
                  setDeleting(null)
                }}
                type="button"
              >
                {t('agents.delete.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
