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

/** 待提示的动作（add=工具栏新增、delete=行内删除），null=对话框关闭 */
type PendingAction =
  | { kind: 'add' }
  | { kind: 'delete'; providerName: string; modelName: string }

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
}: {
  provider: ModelManageProvider
  builtin?: boolean
  onDeleteModel: (provider: ModelManageProvider, model: ModelManageModel) => void
}) {
  const { t } = useTranslation()
  const modelTogglingId = useStore((s) => s.modelTogglingId)
  const toggleModelProvider = useStore((s) => s.toggleModelProvider)
  const toggling = modelTogglingId === provider.providerId

  const handleToggle = () => {
    if (!toggling) toggleModelProvider(provider.providerId, !provider.enabled)
  }

  return (
    <div className={cx('model-list-view__provider', !provider.enabled && 'disabled')}>
      <div className="model-list-view__provider-header">
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
        {builtin && provider.via && (
          <span
            className={cx(
              'model-list-view__provider-via',
              provider.via === 'fallback' && 'is-fallback',
            )}
            title={provider.via === 'fallback' ? t('models.viaFallbackHint') : t('models.viaSelectedHint')}
          >
            {provider.via === 'fallback' ? t('models.viaFallback') : t('models.viaSelected')}
          </span>
        )}
        <span className={cx('codicon', provider.enabled ? 'codicon-server-environment' : 'codicon-server-process')} />
        <span className="model-list-view__provider-name">{provider.providerName}</span>
        <PlanBadge plan={provider.plan} />
        <span className="model-list-view__provider-id" title={provider.providerId}>
          {provider.providerId}
        </span>
        {!provider.enabled && (
          <span className="model-list-view__provider-off">{t('models.providerDisabled')}</span>
        )}
        {provider.baseURL && (
          <span className="model-list-view__provider-url" title={provider.baseURL}>
            {provider.baseURL}
          </span>
        )}
        <span className="model-list-view__provider-count">
          {t('models.modelsCount', { count: provider.models.length })}
        </span>
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

      {pendingAction && (
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
