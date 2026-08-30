/**
 * 基础设置「行为」子页签（BasicSettingsView 第三个子页签）
 *
 * 对话结束系统通知（仅系统消息，无提示音、无焦点门控——开启即始终弹，默认关闭）：
 * 配置走 persist kv 通道（utils/notifyConfig.ts），Kotlin ZCodeNotifyService
 * 触发通知时即时读同一 key——前端无请求往返，改动即时生效。
 * 手动 stop 的回合不通知（Kotlin 侧 markManualStop 语义，无需前端配置）。
 *
 * 提示词润色（默认关闭，utils/enhanceConfig.ts）：控制输入框润色按钮（✨）
 * 是否显示；可配润色专用模型（默认跟随会话当前所选模型，失效后端回退默认
 * provider）；思考深度不设——generateText 为裸 AI SDK 调用天然不思考。开启
 * 即时生效（InputBox 监听变更事件重读）。
 *
 * 完成轮自动折叠（默认开启，utils/turnCollapseConfig.ts）：完成的对话轮默认
 * 只显示最终结论，点「执行过程」折叠栏展开；关闭则完整展开、可手动收起。
 * 消息渲染时读取，切回聊天视图（ChatView 重挂）即应用新值。
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingToggle } from './SettingToggle'
import { readNotifyConfig, writeNotifyConfig } from '@/utils/notifyConfig'
import { readEnhanceConfig, writeEnhanceConfig, type EnhanceModel } from '@/utils/enhanceConfig'
import { readTurnCollapseConfig, writeTurnCollapseConfig, type TurnCollapseConfig } from '@/utils/turnCollapseConfig'
import { useStore } from '@/store/useStore'
import '../styles/basic-settings.less'
import '../styles/agent-select.less'

export function BehaviorSettings() {
  const { t } = useTranslation()
  const [config, setConfig] = useState(readNotifyConfig)
  const [enhance, setEnhance] = useState(readEnhanceConfig)
  const [collapse, setCollapse] = useState(readTurnCollapseConfig)
  const models = useStore((s) => s.models)
  const [modelOpen, setModelOpen] = useState(false)

  const update = (patch: Partial<typeof config>) => {
    const next = { ...config, ...patch }
    setConfig(next)
    writeNotifyConfig(next)
  }

  const updateEnhance = (patch: Partial<typeof enhance>) => {
    const next = { ...enhance, ...patch }
    setEnhance(next)
    writeEnhanceConfig(next)
  }

  const updateCollapse = (patch: Partial<TurnCollapseConfig>) => {
    const next = { ...collapse, ...patch }
    setCollapse(next)
    writeTurnCollapseConfig(next)
  }

  /** 按选中模型是否仍在模型清单里判失效（provider 删除/订阅过期后清单不再含它）*/
  const selectedInvalid =
    enhance.enhanceModel != null &&
    !models.some((m) => m.providerId === enhance.enhanceModel!.providerId && m.modelId === enhance.enhanceModel!.modelId)

  // 按供应商分组（ModelSelect 同款展示结构）
  const groups = useMemo(() => {
    const map = new Map<string, typeof models>()
    for (const m of models) {
      const arr = map.get(m.providerId) ?? []
      arr.push(m)
      map.set(m.providerId, arr)
    }
    return [...map.entries()]
  }, [models])

  return (
    <>
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-bell" />
          <span className="basic-settings__field-label">{t('settings.behavior.notifyTitle')}</span>
        </div>
        <SettingToggle
          icon="codicon-bell"
          title={t('settings.behavior.notifyEnabled.title')}
          desc={t('settings.behavior.notifyEnabled.desc')}
          on={config.notifyEnabled}
          onToggle={() => update({ notifyEnabled: !config.notifyEnabled })}
          onHint={t('settings.behavior.notifyEnabled.offHint')}
          offHint={t('settings.behavior.notifyEnabled.onHint')}
        />
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.behavior.notifyEnabled.hint')}</span>
        </small>
      </section>
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-sparkle" />
          <span className="basic-settings__field-label">{t('settings.behavior.enhanceTitle')}</span>
        </div>
        <SettingToggle
          icon="codicon-sparkle"
          title={t('settings.behavior.enhanceEnabled.title')}
          desc={t('settings.behavior.enhanceEnabled.desc')}
          on={enhance.enhanceEnabled}
          onToggle={() => updateEnhance({ enhanceEnabled: !enhance.enhanceEnabled })}
          onHint={t('settings.behavior.enhanceEnabled.offHint')}
          offHint={t('settings.behavior.enhanceEnabled.onHint')}
        />
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.behavior.enhanceEnabled.hint')}</span>
        </small>
        {enhance.enhanceEnabled && (
          <div className="selector-button-wrap behavior-enhance-model">
            <span className="behavior-enhance-model__label">{t('settings.behavior.enhanceModel.title')}</span>
            <button
              type="button"
              className="selector-button"
              onClick={() => setModelOpen((v) => !v)}
            >
              {enhance.enhanceModel
                ? models.find(
                    (m) => m.providerId === enhance.enhanceModel!.providerId && m.modelId === enhance.enhanceModel!.modelId,
                  )?.modelName ?? enhance.enhanceModel.modelId
                : t('settings.behavior.enhanceModel.followSession')}
              <span className="codicon codicon-chevron-down selector-button-chevron" />
            </button>
            {selectedInvalid && (
              <small className="behavior-enhance-model__invalid">
                <span className="codicon codicon-warning" />
                <span>{t('settings.behavior.enhanceModel.invalidHint')}</span>
              </small>
            )}
            {modelOpen && (
              <div className="selector-dropdown behavior-enhance-model__dropdown">
                <div className="selector-dropdown-group">
                  <div
                    className={`selector-dropdown-item ${enhance.enhanceModel == null ? 'is-selected' : ''}`}
                    onClick={() => {
                      updateEnhance({ enhanceModel: null })
                      setModelOpen(false)
                    }}
                  >
                    {t('settings.behavior.enhanceModel.followSession')}
                  </div>
                </div>
                {groups.map(([providerId, items]) => (
                  <div key={providerId} className="selector-dropdown-group">
                    <div className="selector-dropdown-group-title">{items[0]?.providerName ?? providerId}</div>
                    {items.map((m) => (
                      <div
                        key={`${m.providerId}/${m.modelId}`}
                        className={`selector-dropdown-item ${
                          enhance.enhanceModel?.providerId === m.providerId && enhance.enhanceModel?.modelId === m.modelId
                            ? 'is-selected'
                            : ''
                        }`}
                        onClick={() => {
                          updateEnhance({ enhanceModel: { providerId: m.providerId, modelId: m.modelId } as EnhanceModel })
                          setModelOpen(false)
                        }}
                      >
                        {m.modelName}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-collapse-all" />
          <span className="basic-settings__field-label">{t('settings.behavior.turnCollapseTitle')}</span>
        </div>
        <SettingToggle
          icon="codicon-collapse-all"
          title={t('settings.behavior.turnCollapseEnabled.title')}
          desc={t('settings.behavior.turnCollapseEnabled.desc')}
          on={collapse.autoCollapse}
          onToggle={() => updateCollapse({ autoCollapse: !collapse.autoCollapse })}
          onHint={t('settings.behavior.turnCollapseEnabled.offHint')}
          offHint={t('settings.behavior.turnCollapseEnabled.onHint')}
        />
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.behavior.turnCollapseEnabled.hint')}</span>
        </small>
      </section>
    </>
  )
}
