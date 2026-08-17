/**
 * 基础设置视图（对齐 cc-gui BasicConfigSection 的子 tab 结构）
 *
 * 子页签：
 *   - 外观：界面主题三态卡片 / 字体大小 / 语言 / 三组自定义颜色
 *   - 环境：Node.js 路径（版本徽章+过低警告）/ ZCode CLI 路径 / 凭证状态（只读）
 *     （参考 cc-gui EnvironmentTab：保存前后端验证，无效路径不落盘；留空=自动探测）
 *
 * 外观数据流经 utils/appearance.ts；语言经 i18n/language.ts；环境经 store envStatus
 * （checkEnv/envSave op，IDE 广播 onEnvStatusChanged 多标签同步）。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FONT_SCALE_MAP,
  DEFAULT_FONT_SCALE_LEVEL,
  getFontScaleLevel,
  setFontScaleLevel,
  isValidHexColor,
  getCustomColor,
  setCustomColor,
  type CustomColorKey,
  type FontScaleLevel,
} from '@/utils/appearance'
import { getThemePreference, setThemePreference, type IdeTheme } from '@/hooks/useTheme'
import { setLanguage } from '@/i18n/language'
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, isSupportedLanguage, type SupportedLanguage } from '@/i18n/config'
import { useStore } from '@/store/useStore'
import '../styles/basic-settings.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/* ============ 主题图标（cc-gui AppearanceTab 同款 SVG） ============ */

const SunIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 17C14.7614 17 17 14.7614 17 12C17 9.23858 14.7614 7 12 7C9.23858 7 7 9.23858 7 12C7 14.7614 9.23858 17 12 17Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 1V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M12 21V23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M4.22 4.22L5.64 5.64" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M18.36 18.36L19.78 19.78" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M1 12H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M21 12H23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M4.22 19.78L5.64 18.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M18.36 5.64L19.78 4.22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)

const MoonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const SystemIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
    <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)

/* ============ 预设色板（cc-gui AppearanceTab 原色值） ============ */

interface Preset {
  color: string
  /** 翻译 key（settings.presets.*）；专有名词（Tokyo Night 等）用 label 原样显示 */
  labelKey?: string
  label?: string
}

const CHAT_BG_DARK_PRESETS: Preset[] = [
  { color: '#1e1e1e', labelKey: 'default' },
  { color: '#1a1b26', label: 'Tokyo Night' },
  { color: '#282c34', label: 'One Dark' },
  { color: '#2b2d30', label: 'JetBrains' },
  { color: '#0d1117', label: 'GitHub Dark' },
  { color: '#1e1f29', label: 'Dracula' },
  { color: '#262335', label: 'SynthWave' },
  { color: '#292d3e', label: 'Palenight' },
]

const CHAT_BG_LIGHT_PRESETS: Preset[] = [
  { color: '#ffffff', labelKey: 'default' },
  { color: '#fafafa', label: 'Soft White' },
  { color: '#f5f5f5', label: 'Light Gray' },
  { color: '#faf4ed', label: 'Rose Pine' },
  { color: '#f6f8fa', label: 'GitHub Light' },
  { color: '#fffbf0', labelKey: 'warm' },
  { color: '#f0f4f8', label: 'Cool Blue' },
  { color: '#f5f0eb', label: 'Solarized' },
]

const CHAT_BAR_DARK_PRESETS: Preset[] = [
  { color: '#252526', labelKey: 'default' },
  { color: '#1e3a5f', labelKey: 'midnightBlue' },
  { color: '#263f36', labelKey: 'forest' },
  { color: '#3b3151', labelKey: 'purple' },
  { color: '#4a3428', labelKey: 'coffee' },
  { color: '#3f2b36', labelKey: 'rose' },
  { color: '#243b4a', labelKey: 'cyan' },
  { color: '#3b3b3b', labelKey: 'graphite' },
]

const CHAT_BAR_LIGHT_PRESETS: Preset[] = [
  { color: '#f3f3f3', labelKey: 'default' },
  { color: '#e5f0fb', labelKey: 'sky' },
  { color: '#e5f2e9', labelKey: 'mint' },
  { color: '#eee8f7', labelKey: 'lavender' },
  { color: '#f6ebe3', labelKey: 'warm' },
  { color: '#f7e8ee', labelKey: 'rose' },
  { color: '#e4f1f3', labelKey: 'cyan' },
  { color: '#e8e8e8', labelKey: 'graphite' },
]

const USER_MSG_DARK_PRESETS: Preset[] = [
  { color: '#005fb8', labelKey: 'default' },
  { color: '#1a7f37', labelKey: 'green' },
  { color: '#6e40c9', labelKey: 'purple' },
  { color: '#9a6700', labelKey: 'amber' },
  { color: '#cf222e', labelKey: 'red' },
  { color: '#0e6b8a', labelKey: 'cyan' },
  { color: '#6b4c9a', labelKey: 'violet' },
  { color: '#4a5568', labelKey: 'gray' },
]

const USER_MSG_LIGHT_PRESETS: Preset[] = [
  { color: '#0078d4', labelKey: 'default' },
  { color: '#1a7f37', labelKey: 'green' },
  { color: '#8250df', labelKey: 'purple' },
  { color: '#bf8700', labelKey: 'amber' },
  { color: '#cf222e', labelKey: 'red' },
  { color: '#0e8a9a', labelKey: 'cyan' },
  { color: '#7c5cbf', labelKey: 'violet' },
  { color: '#57606a', labelKey: 'gray' },
]

/** 当前项目主题默认色（variables.less 暗色/亮色值，点预设"默认"等价于清除自定义） */
const THEME_DEFAULTS: Record<'dark' | 'light', Record<CustomColorKey, string>> = {
  dark: { chatBg: '#1e1e1e', chatBar: '#252526', userMsg: '#005fb8' },
  light: { chatBg: '#ffffff', chatBar: '#f3f3f3', userMsg: '#0078d4' },
}

const FONT_SIZE_LEVELS = [1, 2, 3, 4, 5, 6] as FontScaleLevel[]

/** 语言名固定以各自母语显示（国际惯例，不随界面语言翻译）*/
const LANGUAGE_NATIVE_NAMES: Record<SupportedLanguage, string> = {
  zh: '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
}

/* ============ 颜色配置区（三组复用） ============ */

interface ColorSectionProps {
  icon: string
  label: string
  hint: string
  value: string
  defaultColor: string
  presets: Preset[]
  onChange: (color: string) => void
}

function ColorSection({ icon, label, hint, value, defaultColor, presets, onChange }: ColorSectionProps) {
  const { t } = useTranslation()
  const pickerRef = useRef<HTMLInputElement>(null)
  const [hexInput, setHexInput] = useState(value)

  // 外部值变化（重置/storage 同步）时回填 HEX 输入框
  useEffect(() => {
    setHexInput(value)
  }, [value])

  const displayColor = value || defaultColor

  const isPresetActive = (presetColor: string) => {
    // 未自定义时"默认"色块高亮；否则按色值匹配
    if (presetColor === defaultColor && !value) return true
    return value.toLowerCase() === presetColor.toLowerCase()
  }

  return (
    <section className="basic-settings__section">
      <div className="basic-settings__field-header">
        <span className={cx('codicon', icon)} />
        <span className="basic-settings__field-label">{label}</span>
      </div>

      <div className="basic-settings__color-presets">
        {presets.map((preset) => (
          <button
            key={preset.color}
            type="button"
            title={preset.labelKey ? t(`settings.presets.${preset.labelKey}`) : preset.label}
            className={cx('basic-settings__color-swatch', isPresetActive(preset.color) && 'active')}
            onClick={() => onChange(preset.color === defaultColor ? '' : preset.color)}
          >
            <span className="basic-settings__color-swatch-inner" style={{ backgroundColor: preset.color }} />
          </button>
        ))}
      </div>

      <div className="basic-settings__custom-color-row">
        <span className="basic-settings__custom-color-label">{t('settings.colors.custom')}</span>
        <div className="basic-settings__color-picker" onClick={() => pickerRef.current?.click()}>
          <span className="basic-settings__color-picker-preview" style={{ backgroundColor: displayColor }} />
          <input
            ref={pickerRef}
            type="color"
            className="basic-settings__color-picker-input"
            value={displayColor}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
        <input
          type="text"
          className="basic-settings__hex-input"
          value={hexInput}
          onChange={(e) => {
            const v = e.target.value
            setHexInput(v)
            if (isValidHexColor(v)) onChange(v)
          }}
          placeholder="#000000"
          maxLength={7}
        />
        {value && (
          <button type="button" className="basic-settings__reset-btn" onClick={() => onChange('')}>
            <span className="codicon codicon-discard" />
            {t('settings.colors.reset')}
          </button>
        )}
      </div>

      <small className="basic-settings__hint">
        <span className="codicon codicon-info" />
        <span>{hint}</span>
      </small>
    </section>
  )
}

/* ============ 主视图 ============ */

type ThemeOption = 'system' | 'light' | 'dark'
type BasicTab = 'appearance' | 'environment'

function readResolvedTheme(): IdeTheme {
  return (document.documentElement.getAttribute('data-theme') as IdeTheme) || 'dark'
}

export function BasicSettingsView() {
  const { t, i18n } = useTranslation()
  // EnvBanner「去设置」直达环境子 tab（消费后清除；条件挂载组件，初始值即够，effect 兜底常驻场景）
  const pendingSection = useStore((s) => s.pendingSettingsSection)
  const setPendingSection = useStore((s) => s.setPendingSettingsSection)
  const [tab, setTab] = useState<BasicTab>(() => (pendingSection === 'env' ? 'environment' : 'appearance'))

  useEffect(() => {
    if (pendingSection === 'env') {
      setTab('environment')
      setPendingSection(null)
    }
  }, [pendingSection, setPendingSection])

  const [themePref, setThemePref] = useState<ThemeOption>(() => getThemePreference() ?? 'system')
  const [resolvedTheme, setResolvedTheme] = useState<IdeTheme>(readResolvedTheme)
  const [fontLevel, setFontLevel] = useState<FontScaleLevel>(() => getFontScaleLevel())
  const [chatBg, setChatBg] = useState(() => getCustomColor('chatBg'))
  const [chatBar, setChatBar] = useState(() => getCustomColor('chatBar'))
  const [userMsg, setUserMsg] = useState(() => getCustomColor('userMsg'))

  // 下拉选中值 = 当前生效语言（手动选择即切换，广播同步时随 languageChanged 刷新）
  const currentLanguage = isSupportedLanguage(i18n.language) ? i18n.language : DEFAULT_LANGUAGE

  // 字号选项（label 带插值，随语言刷新须在组件内计算）
  const fontSizeOptions = FONT_SIZE_LEVELS.map((level) => ({
    level,
    label: t(level === DEFAULT_FONT_SCALE_LEVEL ? 'settings.font.defaultOption' : 'settings.font.option', {
      percent: Math.round(FONT_SCALE_MAP[level] * 100),
    }),
  }))

  // 跟随 IDE 模式下 IDE 主题切换时，预设色板组（明/暗）跟随刷新
  useEffect(() => {
    const observer = new MutationObserver(() => setResolvedTheme(readResolvedTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  const handleThemeChange = (t2: ThemeOption) => {
    setThemePreference(t2 === 'system' ? null : t2)
    setThemePref(t2)
    // setThemePreference 同步改 DOM，立即可读到新的 resolvedTheme
    setResolvedTheme(readResolvedTheme())
  }

  const handleLanguageChange = (lang: SupportedLanguage) => {
    setLanguage(lang) // i18n 切换 + kv 通道持久化（IDE 广播多标签同步）
  }

  const defaults = THEME_DEFAULTS[resolvedTheme]
  const presets = resolvedTheme === 'light'

  return (
    <div className="basic-settings">
      {/* 子页签选择器（cc-gui BasicConfigSection 同款外观/环境结构） */}
      <div className="basic-settings__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'appearance'}
          className={cx('basic-settings__tab', tab === 'appearance' && 'active')}
          onClick={() => setTab('appearance')}
        >
          <span className="codicon codicon-symbol-color" />
          <span>{t('settings.basicTabs.appearance')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'environment'}
          className={cx('basic-settings__tab', tab === 'environment' && 'active')}
          onClick={() => setTab('environment')}
        >
          <span className="codicon codicon-terminal" />
          <span>{t('settings.basicTabs.environment')}</span>
        </button>
      </div>

      {tab === 'environment' && <EnvironmentSettings />}

      {tab === 'appearance' && (
        <>
          {/* 界面主题 */}
          <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-symbol-color" />
          <span className="basic-settings__field-label">{t('settings.theme.label')}</span>
        </div>
        <div className="basic-settings__theme-selector">
          <button
            type="button"
            className={cx('basic-settings__theme-option', themePref === 'system' && 'active')}
            onClick={() => handleThemeChange('system')}
          >
            <span className="basic-settings__theme-icon basic-settings__theme-icon--system">
              <SystemIcon />
            </span>
            <span className="basic-settings__theme-option-label">{t('settings.theme.followIde')}</span>
          </button>
          <button
            type="button"
            className={cx('basic-settings__theme-option', themePref === 'light' && 'active')}
            onClick={() => handleThemeChange('light')}
          >
            <span className="basic-settings__theme-icon basic-settings__theme-icon--light">
              <SunIcon />
            </span>
            <span className="basic-settings__theme-option-label">{t('settings.theme.light')}</span>
          </button>
          <button
            type="button"
            className={cx('basic-settings__theme-option', themePref === 'dark' && 'active')}
            onClick={() => handleThemeChange('dark')}
          >
            <span className="basic-settings__theme-icon basic-settings__theme-icon--dark">
              <MoonIcon />
            </span>
            <span className="basic-settings__theme-option-label">{t('settings.theme.dark')}</span>
          </button>
        </div>
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.theme.hint')}</span>
        </small>
      </section>

      {/* 字体大小 */}
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-text-size" />
          <span className="basic-settings__field-label">{t('settings.font.label')}</span>
        </div>
        <select
          className="basic-settings__select"
          value={fontLevel}
          onChange={(e) => {
            const level = Number(e.target.value) as FontScaleLevel
            setFontScaleLevel(level)
            setFontLevel(level)
          }}
        >
          {fontSizeOptions.map((opt) => (
            <option key={opt.level} value={opt.level}>
              {opt.label}
            </option>
          ))}
        </select>
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.font.hint')}</span>
        </small>
      </section>

      {/* 语言（cc-gui 同款下拉；语言名固定以各自母语显示，首次未选择时默认取 IDE 注入语言） */}
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-globe" />
          <span className="basic-settings__field-label">{t('settings.language.label')}</span>
        </div>
        <select
          className="basic-settings__select"
          value={currentLanguage}
          onChange={(e) => handleLanguageChange(e.target.value as SupportedLanguage)}
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {LANGUAGE_NATIVE_NAMES[lang]}
            </option>
          ))}
        </select>
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.language.hint')}</span>
        </small>
      </section>

      {/* 聊天背景色 */}
      <ColorSection
        icon="codicon-paintcan"
        label={t('settings.colors.chatBg.label')}
        hint={t('settings.colors.chatBg.hint')}
        value={chatBg}
        defaultColor={defaults.chatBg}
        presets={presets ? CHAT_BG_LIGHT_PRESETS : CHAT_BG_DARK_PRESETS}
        onChange={(c) => {
          setCustomColor('chatBg', c)
          setChatBg(c)
        }}
      />

      {/* 顶栏颜色 */}
      <ColorSection
        icon="codicon-layout"
        label={t('settings.colors.chatBar.label')}
        hint={t('settings.colors.chatBar.hint')}
        value={chatBar}
        defaultColor={defaults.chatBar}
        presets={presets ? CHAT_BAR_LIGHT_PRESETS : CHAT_BAR_DARK_PRESETS}
        onChange={(c) => {
          setCustomColor('chatBar', c)
          setChatBar(c)
        }}
      />

      {/* 用户气泡色 */}
      <ColorSection
        icon="codicon-comment"
        label={t('settings.colors.userMsg.label')}
        hint={t('settings.colors.userMsg.hint')}
        value={userMsg}
        defaultColor={defaults.userMsg}
        presets={presets ? USER_MSG_LIGHT_PRESETS : USER_MSG_DARK_PRESETS}
        onChange={(c) => {
          setCustomColor('userMsg', c)
          setUserMsg(c)
        }}
      />
        </>
      )}
    </div>
  )
}

/* ============ 环境子页签（参考 cc-gui EnvironmentTab） ============ */

function EnvironmentSettings() {
  const { t } = useTranslation()
  const envStatus = useStore((s) => s.envStatus)
  const envSaving = useStore((s) => s.envSaving)
  const saveEnvConfig = useStore((s) => s.saveEnvConfig)
  const checkEnv = useStore((s) => s.checkEnv)
  const [nodeInput, setNodeInput] = useState('')
  const [cliInput, setCliInput] = useState('')
  /** 正在保存哪一项（按钮转圈定位；envSaving 复位时清除） */
  const [savingWhich, setSavingWhich] = useState<'node' | 'cli' | null>(null)
  const [rechecking, setRechecking] = useState(false)
  /** 上次同步进输入框的值：仅当输入框仍是上次同步值时才跟随刷新（不覆盖用户编辑） */
  const lastSyncRef = useRef({ node: '', cli: '' })

  const nodePath = envStatus?.node.path ?? ''
  const cliPath = envStatus?.cli.path ?? ''

  useEffect(() => {
    setNodeInput((cur) => (cur === lastSyncRef.current.node ? nodePath : cur))
    setCliInput((cur) => (cur === lastSyncRef.current.cli ? cliPath : cur))
    lastSyncRef.current = { node: nodePath, cli: cliPath }
  }, [nodePath, cliPath])

  useEffect(() => {
    if (!envSaving) setSavingWhich(null)
  }, [envSaving])

  const handleSave = (which: 'node' | 'cli') => {
    setSavingWhich(which)
    if (which === 'node') saveEnvConfig(nodeInput.trim())
    else saveEnvConfig(undefined, cliInput.trim())
  }

  const handleRecheck = () => {
    if (rechecking) return
    setRechecking(true)
    checkEnv()
    setTimeout(() => setRechecking(false), 3000)
  }

  return (
    <>
      {/* Node.js 路径 */}
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-terminal" />
          <span className="basic-settings__field-label">{t('settings.env.node.label')}</span>
          {envStatus?.node.version && (
            <span
              className={cx(
                'basic-settings__version-badge',
                envStatus.node.versionTooLow ? 'is-error' : 'is-ok'
              )}
            >
              {envStatus.node.version}
            </span>
          )}
        </div>
        {envStatus?.node.versionTooLow && (
          <div className="basic-settings__version-warning">
            <span className="codicon codicon-warning" />
            <span>{t('settings.env.node.versionTooLow', { min: envStatus.node.minVersion })}</span>
          </div>
        )}
        <div className="basic-settings__path-row">
          <input
            type="text"
            className="basic-settings__path-input"
            value={nodeInput}
            onChange={(e) => setNodeInput(e.target.value)}
            placeholder={t('settings.env.node.placeholder')}
            spellCheck={false}
          />
          <button
            type="button"
            className="basic-settings__save-btn"
            onClick={() => handleSave('node')}
            disabled={envSaving}
          >
            {savingWhich === 'node' && <span className="codicon codicon-loading codicon-modifier-spin" />}
            {t('settings.env.save')}
          </button>
        </div>
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.env.node.hint')}</span>
        </small>
      </section>

      {/* ZCode CLI 路径 */}
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-rocket" />
          <span className="basic-settings__field-label">{t('settings.env.cli.label')}</span>
          {envStatus?.cli.found && cliPath && (
            <span className="basic-settings__version-badge is-ok">{t('settings.env.cli.found')}</span>
          )}
        </div>
        <div className="basic-settings__path-row">
          <input
            type="text"
            className="basic-settings__path-input"
            value={cliInput}
            onChange={(e) => setCliInput(e.target.value)}
            placeholder={t('settings.env.cli.placeholder')}
            spellCheck={false}
          />
          <button
            type="button"
            className="basic-settings__save-btn"
            onClick={() => handleSave('cli')}
            disabled={envSaving}
          >
            {savingWhich === 'cli' && <span className="codicon codicon-loading codicon-modifier-spin" />}
            {t('settings.env.save')}
          </button>
        </div>
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.env.cli.hint')}</span>
        </small>
      </section>

      {/* 凭证状态（只读：由 ZCode 客户端登录生成，无配置入口） */}
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-key" />
          <span className="basic-settings__field-label">{t('settings.env.credentials.label')}</span>
          {envStatus && (
            <span
              className={cx(
                'basic-settings__version-badge',
                envStatus.credentials.ok ? 'is-ok' : 'is-error'
              )}
            >
              {envStatus.credentials.ok
                ? t('settings.env.credentials.ok', { model: envStatus.credentials.model ?? '' })
                : t('settings.env.credentials.invalid')}
            </span>
          )}
        </div>
        {!envStatus?.credentials.ok && envStatus?.credentials.error && (
          <div className="basic-settings__version-warning">
            <span className="codicon codicon-error" />
            <span>{envStatus.credentials.error}</span>
          </div>
        )}
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.env.credentials.hint')}</span>
        </small>
      </section>

      {/* 重新检测 */}
      <section className="basic-settings__section">
        <button type="button" className="basic-settings__save-btn" onClick={handleRecheck} disabled={rechecking}>
          {rechecking && <span className="codicon codicon-loading codicon-modifier-spin" />}
          <span className="codicon codicon-refresh" />
          {t('settings.env.recheck')}
        </button>
      </section>
    </>
  )
}
