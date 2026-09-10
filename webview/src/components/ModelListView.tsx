/**
 * 模型列表面板（设置页「模型」条目，参考 cc-gui ProviderList 的展示模式）
 *
 * 数据：modelManageList（Kotlin 端读 config.json——路径走 Credentials.defaultConfigPath()
 *       跟随 dataBaseDir 迁移；apiKey 缺失的无效 provider 过滤；内置渠道只返回生效的）
 * 交互：内置渠道只读展示（启停以 ZCode 客户端配置为准，插件不代写 config——客户端
 *       与插件两个写者互相覆盖易出状态错乱）；第三方 provider 行内启用/禁用切换
 *       （modelToggleProvider 备份+原子写回 config.json，成功后输入框下拉经
 *       loadModels 同步刷新）；「新增模型」与行内「删除」点击后弹 ConfirmDialog
 *       引导前往 Zcode 配置（含「打开配置文件」快捷入口）。
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { sendToJava } from '@/ipc/bridge'
import { ConfirmDialog } from './ConfirmDialog'
import { PlanBadge } from './PlanBadge'
import type { ModelManageModel, ModelManageProvider } from '@/types/messages'
import '../styles/model-list-view.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** token 数 → K/M 缩写（1000000 → 1M、204800 → 200K）*/
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return `${n}`
}

/** 待提示的动作（add=工具栏新增、delete=行内删除、key=自定义渠道 key），null=对话框关闭 */
type PendingAction =
  | { kind: 'add' }
  | { kind: 'delete'; providerName: string; modelName: string }
  | { kind: 'key'; providerId: string; providerName: string }

/** 自定义 key 输入值（PendingAction.kind=key 期间的受控状态；空=清除） */
type KeyDraft = { value: string; configured: boolean }

/** 单个模型行：名称 + ID + 上下文/输出徽章 + 删除（提示前往 Zcode 配置）*/
function ModelRow({ model, onDelete }: { model: ModelManageModel; onDelete: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="model-list-view__model">
      <span className="codicon codicon-symbol-method model-list-view__model-icon" />
      <span className="model-list-view__model-name" title={model.modelName}>
        {model.modelName}
      </span>
      <span className="model-list-view__model-id" title={model.modelId}>
        {model.modelId}
      </span>
      {model.supportsImages && (
        <span className="model-list-view__model-badge model-list-view__model-badge--vision" title={t('models.vision')}>
          {t('models.vision')}
        </span>
      )}
      {model.contextWindow != null && (
        <span className="model-list-view__model-badge" title={t('models.contextTitle')}>
          {t('models.contextBadge', { size: formatTokens(model.contextWindow) })}
        </span>
      )}
      {model.maxOutput != null && (
        <span className="model-list-view__model-badge" title={t('models.outputTitle')}>
          {t('models.outputBadge', { size: formatTokens(model.maxOutput) })}
        </span>
      )}
      <button
        className="model-list-view__model-delete"
        onClick={onDelete}
        title={t('models.deleteTitle')}
      >
        <span className="codicon codicon-trash" />
      </button>
    </div>
  )
}

/**
 * provider 分组卡片：头部（选择控件/名称/套餐徽章/ID/状态徽章/baseURL/计数）+ 模型行列表。
 * builtin=true（内置渠道）：只读展示当前生效的渠道（状态徽章），启停以 ZCode 客户端
 * 配置为准，插件不代写；否则（自定义供应商）：行内 toggle 开关，独立启停。
 */
function ProviderCard({
  provider,
  builtin = false,
  onDeleteModel,
  onEditKey,
}: {
  provider: ModelManageProvider
  builtin?: boolean
  onDeleteModel: (provider: ModelManageProvider, model: ModelManageModel) => void
  onEditKey?: (provider: ModelManageProvider) => void
}) {
  const { t } = useTranslation()
  const modelTogglingId = useStore((s) => s.modelTogglingId)
  const toggleModelProvider = useStore((s) => s.toggleModelProvider)
  const toggling = modelTogglingId === provider.providerId
  // 激活 key 眼睛切换（常态脱敏，点开看全）
  const [keyVisible, setKeyVisible] = useState(false)

  const handleToggle = () => {
    if (!toggling) toggleModelProvider(provider.providerId, !provider.enabled)
  }

  return (
    <div className={cx('model-list-view__provider', !provider.enabled && 'disabled')}>
      <div className="model-list-view__provider-header">
        <div className="model-list-view__provider-main">
          {builtin ? (
            <span
              className="model-list-view__provider-active"
              title={t('models.builtinReadonlyHint')}
            >
              <span className="codicon codicon-pass-filled" />
            </span>
          ) : (          <button
              className={cx('model-list-view__toggle', provider.enabled && 'on')}
              onClick={handleToggle}
              disabled={toggling}
              title={provider.enabled ? t('models.disableHint') : t('models.enableHint')}
            >
              <span
                className={cx(
                  'codicon',
                  toggling ? 'codicon-loading spin' : provider.enabled ? 'codicon-check' : 'codicon-circle-slash',
                )}
              />
            </button>
          )}
          {builtin && provider.via && (() => {
            // 兜底原因细分：captchaGated（体验套餐被门控排除）换专属文案，区分于凭证失效
            const captchaFallback = provider.via === 'fallback' && provider.viaReason === 'captchaGated'
            const viaText = captchaFallback
              ? t('models.viaFallbackCaptcha')
              : provider.via === 'fallback'
                ? t('models.viaFallback')
                : t('models.viaSelected')
            const viaTitle = captchaFallback
              ? t('models.viaFallbackCaptchaHint')
              : provider.via === 'fallback'
                ? t('models.viaFallbackHint')
                : t('models.viaSelectedHint')
            return (
              <span
                className={cx(
                  'model-list-view__provider-via',
                  provider.via === 'fallback' && 'is-fallback',
                )}
                title={viaTitle}
              >
                {viaText}
              </span>
            )
          })()}
          <span className={cx('codicon', provider.enabled ? 'codicon-server-environment' : 'codicon-server-process')} />
          <span className="model-list-view__provider-name">{provider.providerName}</span>
          <PlanBadge plan={provider.plan} />
          {/* 自定义 key 入口=状态合一的文字按钮：已配置紫色、未配置灰色弱化，点击打开编辑弹窗 */}
          {builtin && (
            <button
              className={cx('model-list-view__provider-key-btn', provider.customKey && 'is-set')}
              onClick={() => onEditKey?.(provider)}
              title={provider.customKey ? t('models.customKeyBadgeHint') : t('models.customKeyTitle')}
            >
              <span className="codicon codicon-key" />
              {t('models.customKeyBadge')}
            </button>
          )}
          {!provider.enabled && (
            <span className="model-list-view__provider-off">{t('models.providerDisabled')}</span>
          )}
          <span className="model-list-view__provider-count">
            {t('models.modelsCount', { count: provider.models.length })}
          </span>
        </div>
        <div className="model-list-view__provider-meta">
          <span className="model-list-view__provider-id" title={provider.providerId}>
            {provider.providerId}
          </span>
          {provider.baseURL && (
            <span className="model-list-view__provider-url" title={provider.baseURL}>
              {provider.baseURL}
            </span>
          )}
        </div>
        {/* 实际生效的计费 key（与 RuntimeModels 构造同优先级，所见即所扣） */}
        {provider.activeKeyMasked && (
          <div className="model-list-view__active-key">
            <span className="model-list-view__active-key-label">
              <span className="codicon codicon-key" />
              {t('models.activeKeyLabel')}
            </span>
            <span className="model-list-view__active-key-value" title={keyVisible ? undefined : t('models.showKeyTitle')}>
              {keyVisible ? provider.activeKeyValue : provider.activeKeyMasked}
            </span>
            <span className={cx('model-list-view__active-key-src', `src-${provider.activeKeySource}`)}>
              {provider.activeKeySource === 'custom'
                ? t('models.activeKeyCustom')
                : provider.activeKeySource === 'config'
                  ? t('models.activeKeyConfig')
                  : t('models.activeKeyOauth')}
            </span>
            <button
              type="button"
              className="model-list-view__key-eye"
              onClick={() => setKeyVisible((v) => !v)}
              title={keyVisible ? t('models.hideKey') : t('models.showKey')}
            >
              <span className={cx('codicon', keyVisible ? 'codicon-eye-closed' : 'codicon-eye')} />
            </button>
          </div>
        )}
        {/* 团队选中未配覆盖：实际按个人 key 计费（黄色提醒 + 直达配置） */}
        {provider.teamPlanNoOverride && (
          <div className="model-list-view__bill-warn" role="alert">
            <span className="codicon codicon-warning" />
            <span className="model-list-view__bill-warn-text">{t('models.teamNoOverrideWarn')}</span>
            <button type="button" className="model-list-view__bill-warn-btn" onClick={() => onEditKey?.(provider)}>
              {t('models.teamNoOverrideAction')}
            </button>
          </div>
        )}
        {/* 个人选中配了覆盖：客户端 key 未使用（歧义消解提示） */}
        {provider.overrideOnPersonal && (
          <div className="model-list-view__bill-note" role="status">
            <span className="codicon codicon-info" />
            <span>{t('models.overrideOnPersonalWarn')}</span>
          </div>
        )}
      </div>
      {provider.models.length > 0 ? (
        <div className="model-list-view__models">
          {provider.models.map((m) => (
            <ModelRow
              key={m.modelId}
              model={m}
              onDelete={() => onDeleteModel(provider, m)}
            />
          ))}
        </div>
      ) : (
        <div className="model-list-view__models-empty">{t('models.providerNoModels')}</div>
      )}
    </div>
  )
}

export function ModelListView() {
  const { t } = useTranslation()
  const providers = useStore((s) => s.modelProviders)
  const loading = useStore((s) => s.modelManageLoading)
  const error = useStore((s) => s.modelManageError)
  const configPath = useStore((s) => s.modelConfigPath)
  const loadModelManage = useStore((s) => s.loadModelManage)

  const [query, setQuery] = useState('')
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const setProviderKey = useStore((s) => s.setProviderKey)
  // 自定义 key 对话框的受控草稿（configured=当前已配置，供"清除"语义提示）
  const [keyDraft, setKeyDraft] = useState<KeyDraft>({ value: '', configured: false })
  // 输入框明文切换（密码态常态，眼睛看全——与卡片激活 key 同模式）
  const [keyInputVisible, setKeyInputVisible] = useState(false)

  useEffect(() => {
    loadModelManage()
  }, [loadModelManage])

  // 搜索过滤：provider 名/ID 直接命中保留整组；否则按模型名/ID 过滤组内条目
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return providers ?? []
    return (providers ?? [])
      .map((p) => ({
        ...p,
        models: p.models.filter(
          (m) => m.modelId.toLowerCase().includes(q) || m.modelName.toLowerCase().includes(q),
        ),
      }))
      .filter(
        (p) =>
          p.models.length > 0 ||
          p.providerName.toLowerCase().includes(q) ||
          p.providerId.toLowerCase().includes(q),
      )
  }, [providers, query])

  const openConfig = () => {
    if (configPath) sendToJava({ op: 'openFile', filePath: configPath, line: 1 })
    setPendingAction(null)
  }

  const handleDeleteModel = (provider: ModelManageProvider, model: ModelManageModel) => {
    setPendingAction({
      kind: 'delete',
      providerName: provider.providerName,
      modelName: model.modelName,
    })
  }

  const openKeyEditor = (provider: ModelManageProvider) => {
    // 已存覆盖回填明文（本地手填值）；无覆盖开空表单
    setKeyDraft({ value: provider.customKeyValue ?? '', configured: !!provider.customKey })
    setPendingAction({ kind: 'key', providerId: provider.providerId, providerName: provider.providerName })
  }

  const commitKey = () => {
    if (pendingAction?.kind === 'key') {
      setProviderKey(pendingAction.providerId, keyDraft.value.trim())
    }
    setPendingAction(null)
  }

  // 一键清空：等价留空保存，但明确告诉用户清空后回到什么（客户端配置 key / OAuth）
  const commitClear = () => {
    if (pendingAction?.kind === 'key') {
      setProviderKey(pendingAction.providerId, '')
    }
    setPendingAction(null)
  }

  return (
    <div className="model-list-view">
      <div className="model-list-view__toolbar">
        <span className="model-list-view__hint">
          <span className="codicon codicon-info" />
          {t('models.toolbarHint')}
        </span>
        <div className="model-list-view__search">
          <span className="codicon codicon-search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('models.searchPlaceholder')}
            spellCheck={false}
          />
          {query && (
            <button
              className="model-list-view__search-clear"
              onClick={() => setQuery('')}
              title={t('models.searchClear')}
            >
              <span className="codicon codicon-close" />
            </button>
          )}
        </div>
        <button
          className="model-list-view__refresh"
          onClick={() => loadModelManage()}
          disabled={loading}
          title={t('models.refreshTitle')}
        >
          <span className={cx('codicon', loading ? 'codicon-loading spin' : 'codicon-refresh')} />
        </button>
        <button className="model-list-view__add" onClick={() => setPendingAction({ kind: 'add' })}>
          <span className="codicon codicon-add" />
          {t('models.add')}
        </button>
      </div>

      {configPath && (
        <div
          className="model-list-view__config-path"
          onClick={openConfig}
          title={t('models.configPathOpenTitle')}
        >
          <span className="codicon codicon-file-code" />
          <span className="model-list-view__config-label">{t('models.configPathLabel')}</span>
          <span className="model-list-view__config-value">{configPath}</span>
          <span className="codicon codicon-go-to-file" />
        </div>
      )}

      {error && <div className="model-list-view__error">{t('models.errorLoad', { error })}</div>}

      {loading && !providers ? (
        <div className="model-list-view__loading">
          <span className="codicon codicon-loading spin" /> {t('models.loading')}
        </div>
      ) : visible.length === 0 ? (
        <div className="model-list-view__empty">
          <span className="codicon codicon-server-process" />
          <span>{t('models.empty')}</span>
          <span className="model-list-view__empty-hint">{t('models.emptyHint')}</span>
        </div>
      ) : (
        <div className="model-list-view__list">
          {/* 内置渠道区：只读展示生效渠道（启停以 ZCode 客户端配置为准，禁用不展示）*/}
          {visible.some((p) => p.providerId.startsWith('builtin:')) && (
            <div className="model-list-view__section">
              <span className="model-list-view__section-title">{t('models.section.builtin')}</span>
              <span className="model-list-view__section-hint">{t('models.section.builtinHint')}</span>
            </div>
          )}
          {visible
            .filter((p) => p.providerId.startsWith('builtin:'))
            .map((p) => (
              <ProviderCard
                key={p.providerId}
                provider={p}
                builtin
                onDeleteModel={handleDeleteModel}
                onEditKey={openKeyEditor}
              />
            ))}

          {/* 自定义供应商区：独立启停 */}
          {visible.some((p) => !p.providerId.startsWith('builtin:')) && (
            <div className="model-list-view__section">
              <span className="model-list-view__section-title">{t('models.section.custom')}</span>
            </div>
          )}
          {visible
            .filter((p) => !p.providerId.startsWith('builtin:'))
            .map((p) => (
              <ProviderCard key={p.providerId} provider={p} onDeleteModel={handleDeleteModel} />
            ))}
        </div>
      )}

      {pendingAction?.kind === 'key' && (
        <ConfirmDialog
          title={t('models.customKeyTitle')}
          message={
            <div className="model-list-view__dialog-body">
              <p>
                {t('models.customKeyHint', { provider: pendingAction.providerName })}
              </p>
              <div className="model-list-view__key-input-wrap">
                <input
                  className="model-list-view__key-input"
                  type={keyInputVisible ? 'text' : 'password'}
                  value={keyDraft.value}
                  onChange={(e) => setKeyDraft({ ...keyDraft, value: e.target.value })}
                  placeholder={t('models.customKeyPlaceholder')}
                  spellCheck={false}
                  autoFocus
                />
                <button
                  type="button"
                  className="model-list-view__key-eye"
                  onClick={() => setKeyInputVisible((v) => !v)}
                  title={keyInputVisible ? t('models.hideKey') : t('models.showKey')}
                >
                  <span className={cx('codicon', keyInputVisible ? 'codicon-eye-closed' : 'codicon-eye')} />
                </button>
              </div>
              <p className="model-list-view__key-sub">
                {keyDraft.value.trim() === ''
                  ? keyDraft.configured
                    ? t('models.customKeyClearHint')
                    : t('models.customKeyKeepHint')
                  : t('models.customKeyApplyHint')}
              </p>
              {keyDraft.configured && (
                <div className="model-list-view__key-clear-row">
                  <button type="button" className="model-list-view__key-clear-btn" onClick={commitClear}>
                    {t('models.customKeyClearBtn')}
                  </button>
                  <span className="model-list-view__key-clear-note">{t('models.customKeyClearNote')}</span>
                </div>
              )}
            </div>
          }
          confirmText={t('models.customKeySave')}
          cancelText={t('models.dialog.dismiss')}
          onConfirm={commitKey}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {pendingAction && pendingAction.kind !== 'key' && (
        <ConfirmDialog
          title={
            pendingAction.kind === 'add'
              ? t('models.dialog.addTitle')
              : t('models.dialog.deleteTitle')
          }
          message={
            <div className="model-list-view__dialog-body">
              <p>
                {pendingAction.kind === 'add'
                  ? t('models.dialog.addBody')
                  : t('models.dialog.deleteBody', {
                      name: pendingAction.modelName,
                      provider: pendingAction.providerName,
                    })}
              </p>
              {configPath && <code className="model-list-view__dialog-path">{configPath}</code>}
            </div>
          }
          confirmText={t('models.dialog.openConfig')}
          cancelText={t('models.dialog.dismiss')}
          onConfirm={openConfig}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </div>
  )
}
