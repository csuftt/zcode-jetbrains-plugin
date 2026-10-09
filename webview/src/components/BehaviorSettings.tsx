/**
 * 基础设置「行为」子页签（BasicSettingsView 第三个子页签）
 *
 * 任务系统通知（IDE 内气泡通知 + 系统通知悬浮弹窗，两通道收进同一张卡片，均默认关闭）：
 * 气泡通知无提示音、无焦点门控——开启即始终弹；悬浮弹窗为纯 Swing
 * 置顶卡片（全平台），仅在 IDE 窗口非激活时弹，时长/位置可配（开关打开才显示）。
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
 *
 * 提问自动继续（默认关闭=一直等待，utils/askUserConfig.ts）：与 ZCode 客户端
 * 不同源的插件自有配置——开启后 Agent 提问 5 分钟未回答自动继续；关闭（默认）
 * 则当前和后续提问一直等待回答（弹窗无倒计时不自动关闭）。persist kv 通道存储，
 * Kotlin 侧（ZCodeAskUserConfig）即时读取，无消息往返。
 *
 * 文件上下文新会话自动启用（默认关闭，utils/currentFileConfig.ts）：开启后
 * 新建会话（按钮或新开标签页）自动点亮输入框的文件上下文 chip——仅影响新会话
 * 首条消息（发完即关）；读取方 = resetToNewSession + listSessions boot 待命分支
 * （均调用时取值），无变更事件。
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingToggle } from './SettingToggle'
import { PlanBadge } from './PlanBadge'
import { readNotifyConfig, writeNotifyConfig } from '@/utils/notifyConfig'
import { readEnhanceConfig, writeEnhanceConfig, type EnhanceModel } from '@/utils/enhanceConfig'
import { readTurnCollapseConfig, writeTurnCollapseConfig, type TurnCollapseConfig } from '@/utils/turnCollapseConfig'
import { readAskUserAutoConfig, writeAskUserAutoConfig } from '@/utils/askUserConfig'
import { readCommitPromptConfig, writeCommitPromptConfig } from '@/utils/commitPromptConfig'
import { readCurrentFileConfig, writeCurrentFileConfig } from '@/utils/currentFileConfig'
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
  // 提问自动继续（插件自有 persist kv 配置，默认关=一直等待回答）
  const [askUserAuto, setAskUserAuto] = useState(readAskUserAutoConfig)
  // 文件上下文新会话自动点亮（persist kv 配置，默认关；读取方 = store.resetToNewSession）
  const [currentFileAuto, setCurrentFileAuto] = useState(readCurrentFileConfig)

  // AI 提交信息附加要求（persist kv 配置，IDE 提交框 AI 按钮读取；失焦即存）
  const [commitPrompt, setCommitPrompt] = useState(readCommitPromptConfig)
  const [commitPromptSaved, setCommitPromptSaved] = useState(false)

  const saveCommitPrompt = (text: string) => {
    setCommitPrompt(text)
    writeCommitPromptConfig(text)
    setCommitPromptSaved(true)
    window.setTimeout(() => setCommitPromptSaved(false), 1500)
  }

  const updateAskUserAuto = (patch: Partial<typeof askUserAuto>) => {
    const next = { ...askUserAuto, ...patch }
    setAskUserAuto(next)
    writeAskUserAutoConfig(next)
  }

  const updateCurrentFileAuto = (patch: Partial<typeof currentFileAuto>) => {
    const next = { ...currentFileAuto, ...patch }
    setCurrentFileAuto(next)
    writeCurrentFileConfig(next)
  }

  // 悬浮弹窗时长输入（秒）本地态：允许编辑中间态（空串），合法整数才落配置，失焦回显
  const [popupDurationInput, setPopupDurationInput] = useState(() => String(readNotifyConfig().popupDurationSec))


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
        <div className="behavior-popup-card">
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
          <SettingToggle
            icon="codicon-browser"
            title={t('settings.behavior.popupNotifyEnabled.title')}
            desc={t('settings.behavior.popupNotifyEnabled.desc')}
            on={config.popupNotifyEnabled}
            onToggle={() => update({ popupNotifyEnabled: !config.popupNotifyEnabled })}
            onHint={t('settings.behavior.popupNotifyEnabled.offHint')}
            offHint={t('settings.behavior.popupNotifyEnabled.onHint')}
          />
          {config.popupNotifyEnabled && (
            <div className="basic-settings__path-row">
              <span className="basic-settings__field-label">
                {t('settings.behavior.popupNotifyEnabled.durationLabel')}
              </span>
              <input
                type="number"
                className="basic-settings__path-input"
                min={0}
                max={3600}
                value={popupDurationInput}
                onChange={(e) => {
                  setPopupDurationInput(e.target.value)
                  const v = Number(e.target.value)
                  if (e.target.value !== '' && Number.isInteger(v) && v >= 0) {
                    update({ popupDurationSec: Math.min(v, 3600) })
                  }
                }}
                onBlur={() => setPopupDurationInput(String(config.popupDurationSec))}
              />
            </div>
          )}
          {config.popupNotifyEnabled && (
            <small className="basic-settings__hint">
              <span className="codicon codicon-info" />
              <span>{t('settings.behavior.popupNotifyEnabled.durationHint')}</span>
            </small>
          )}
          {config.popupNotifyEnabled && (
            <div className="basic-settings__path-row behavior-popup-position-row">
              <span className="basic-settings__field-label">
                {t('settings.behavior.popupNotifyEnabled.positionLabel')}
              </span>
              <div className="behavior-popup-position">
                <button
                  type="button"
                  className={config.popupPosition === 'TOP_RIGHT' ? 'is-active' : ''}
                  onClick={() => update({ popupPosition: 'TOP_RIGHT' })}
                >
                  {t('settings.behavior.popupNotifyEnabled.positionTopRight')}
                </button>
                <button
                  type="button"
                  className={config.popupPosition === 'BOTTOM_RIGHT' ? 'is-active' : ''}
                  onClick={() => update({ popupPosition: 'BOTTOM_RIGHT' })}
                >
                  {t('settings.behavior.popupNotifyEnabled.positionBottomRight')}
                </button>
              </div>
            </div>
          )}
        </div>
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
                    <div className="selector-dropdown-group-title">{items[0]?.providerName ?? providerId}
                      <PlanBadge plan={items[0]?.plan} />
                    </div>
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
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-comment-discussion" />
          <span className="basic-settings__field-label">{t('settings.behavior.askUserAutoTitle')}</span>
        </div>
        <SettingToggle
          icon="codicon-comment-discussion"
          title={t('settings.behavior.askUserAuto.title')}
          desc={t('settings.behavior.askUserAuto.desc')}
          on={askUserAuto.autoContinueEnabled}
          onToggle={() => updateAskUserAuto({ autoContinueEnabled: !askUserAuto.autoContinueEnabled })}
          onHint={t('settings.behavior.askUserAuto.onHint')}
          offHint={t('settings.behavior.askUserAuto.offHint')}
        />
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.behavior.askUserAuto.hint')}</span>
        </small>
      </section>
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-git-commit" />
          <span className="basic-settings__field-label">{t('settings.behavior.commitPrompt.title')}</span>
          {commitPromptSaved && <span className="basic-settings__saved-hint">{t('settings.behavior.commitPrompt.saved')}</span>}
        </div>
        <textarea
          className="basic-settings__textarea"
          value={commitPrompt}
          placeholder={t('settings.behavior.commitPrompt.placeholder')}
          onChange={(e) => setCommitPrompt(e.target.value)}
          onBlur={(e) => {
            // 内容有实际变化才写（失焦即存，避免每次点击都触发 kv 回存）
            if (e.target.value !== readCommitPromptConfig()) saveCommitPrompt(e.target.value)
          }}
          rows={3}
        />
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.behavior.commitPrompt.hint')}</span>
        </small>
      </section>
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-file-code" />
          <span className="basic-settings__field-label">{t('settings.behavior.currentFileTitle')}</span>
        </div>
        <SettingToggle
          icon="codicon-file-code"
          title={t('settings.behavior.currentFileAuto.title')}
          desc={t('settings.behavior.currentFileAuto.desc')}
          on={currentFileAuto.autoOnNewSession}
          onToggle={() => updateCurrentFileAuto({ autoOnNewSession: !currentFileAuto.autoOnNewSession })}
          onHint={t('settings.behavior.currentFileAuto.onHint')}
          offHint={t('settings.behavior.currentFileAuto.offHint')}
        />
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.behavior.currentFileAuto.hint')}</span>
        </small>
      </section>
    </>
  )
}
