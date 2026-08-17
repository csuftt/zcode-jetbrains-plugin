/**
 * 基础设置视图（对齐 cc-gui AppearanceTab 的主题必需项）
 *
 * 设置项：
 *   - 界面主题：跟随 IDE / 浅色 / 深色（三卡片，复用 useTheme 的 zcode-theme-pref）
 *   - 字体大小：6 级缩放（--font-scale，#root zoom）
 *   - 聊天背景色 / 顶栏颜色 / 用户气泡色：预设色板 + 取色器 + HEX 输入 + 重置
 *
 * 持久化纯 localStorage（与 cc-gui 一致），数据流经 utils/appearance.ts；
 * 多标签页通过 storage 事件实时同步。
 */

import { useEffect, useRef, useState } from 'react'
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
  label: string
}

const CHAT_BG_DARK_PRESETS: Preset[] = [
  { color: '#1e1e1e', label: '默认' },
  { color: '#1a1b26', label: 'Tokyo Night' },
  { color: '#282c34', label: 'One Dark' },
  { color: '#2b2d30', label: 'JetBrains' },
  { color: '#0d1117', label: 'GitHub Dark' },
  { color: '#1e1f29', label: 'Dracula' },
  { color: '#262335', label: 'SynthWave' },
  { color: '#292d3e', label: 'Palenight' },
]

const CHAT_BG_LIGHT_PRESETS: Preset[] = [
  { color: '#ffffff', label: '默认' },
  { color: '#fafafa', label: 'Soft White' },
  { color: '#f5f5f5', label: 'Light Gray' },
  { color: '#faf4ed', label: 'Rose Pine' },
  { color: '#f6f8fa', label: 'GitHub Light' },
  { color: '#fffbf0', label: 'Warm' },
  { color: '#f0f4f8', label: 'Cool Blue' },
  { color: '#f5f0eb', label: 'Solarized' },
]

const CHAT_BAR_DARK_PRESETS: Preset[] = [
  { color: '#252526', label: '默认' },
  { color: '#1e3a5f', label: '午夜蓝' },
  { color: '#263f36', label: '森林' },
  { color: '#3b3151', label: '紫色' },
  { color: '#4a3428', label: '咖啡' },
  { color: '#3f2b36', label: '玫瑰' },
  { color: '#243b4a', label: '青色' },
  { color: '#3b3b3b', label: '石墨' },
]

const CHAT_BAR_LIGHT_PRESETS: Preset[] = [
  { color: '#f3f3f3', label: '默认' },
  { color: '#e5f0fb', label: '天空' },
  { color: '#e5f2e9', label: '薄荷' },
  { color: '#eee8f7', label: '薰衣草' },
  { color: '#f6ebe3', label: '暖色' },
  { color: '#f7e8ee', label: '玫瑰' },
  { color: '#e4f1f3', label: '青色' },
  { color: '#e8e8e8', label: '石墨' },
]

const USER_MSG_DARK_PRESETS: Preset[] = [
  { color: '#005fb8', label: '默认' },
  { color: '#1a7f37', label: '绿色' },
  { color: '#6e40c9', label: '紫色' },
  { color: '#9a6700', label: '琥珀' },
  { color: '#cf222e', label: '红色' },
  { color: '#0e6b8a', label: '青色' },
  { color: '#6b4c9a', label: '紫罗兰' },
  { color: '#4a5568', label: '灰色' },
]

const USER_MSG_LIGHT_PRESETS: Preset[] = [
  { color: '#0078d4', label: '默认' },
  { color: '#1a7f37', label: '绿色' },
  { color: '#8250df', label: '紫色' },
  { color: '#bf8700', label: '琥珀' },
  { color: '#cf222e', label: '红色' },
  { color: '#0e8a9a', label: '青色' },
  { color: '#7c5cbf', label: '紫罗兰' },
  { color: '#57606a', label: '灰色' },
]

/** 当前项目主题默认色（variables.less 暗色/亮色值，点预设"默认"等价于清除自定义） */
const THEME_DEFAULTS: Record<'dark' | 'light', Record<CustomColorKey, string>> = {
  dark: { chatBg: '#1e1e1e', chatBar: '#252526', userMsg: '#005fb8' },
  light: { chatBg: '#ffffff', chatBar: '#f3f3f3', userMsg: '#0078d4' },
}

const FONT_SIZE_OPTIONS: { level: FontScaleLevel; label: string }[] = (
  [1, 2, 3, 4, 5, 6] as FontScaleLevel[]
).map((level) => ({
  level,
  label: `字号 ${Math.round(FONT_SCALE_MAP[level] * 100)}%${level === DEFAULT_FONT_SCALE_LEVEL ? '（默认）' : ''}`,
}))

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
            title={preset.label}
            className={cx('basic-settings__color-swatch', isPresetActive(preset.color) && 'active')}
            onClick={() => onChange(preset.color === defaultColor ? '' : preset.color)}
          >
            <span className="basic-settings__color-swatch-inner" style={{ backgroundColor: preset.color }} />
          </button>
        ))}
      </div>

      <div className="basic-settings__custom-color-row">
        <span className="basic-settings__custom-color-label">自定义</span>
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
            重置
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

function readResolvedTheme(): IdeTheme {
  return (document.documentElement.getAttribute('data-theme') as IdeTheme) || 'dark'
}

export function BasicSettingsView() {
  const [themePref, setThemePref] = useState<ThemeOption>(() => getThemePreference() ?? 'system')
  const [resolvedTheme, setResolvedTheme] = useState<IdeTheme>(readResolvedTheme)
  const [fontLevel, setFontLevel] = useState<FontScaleLevel>(() => getFontScaleLevel())
  const [chatBg, setChatBg] = useState(() => getCustomColor('chatBg'))
  const [chatBar, setChatBar] = useState(() => getCustomColor('chatBar'))
  const [userMsg, setUserMsg] = useState(() => getCustomColor('userMsg'))

  // 跟随 IDE 模式下 IDE 主题切换时，预设色板组（明/暗）跟随刷新
  useEffect(() => {
    const observer = new MutationObserver(() => setResolvedTheme(readResolvedTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  const handleThemeChange = (t: ThemeOption) => {
    setThemePreference(t === 'system' ? null : t)
    setThemePref(t)
    // setThemePreference 同步改 DOM，立即可读到新的 resolvedTheme
    setResolvedTheme(readResolvedTheme())
  }

  const defaults = THEME_DEFAULTS[resolvedTheme]
  const presets = resolvedTheme === 'light'

  return (
    <div className="basic-settings">
      {/* 界面主题 */}
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-symbol-color" />
          <span className="basic-settings__field-label">界面主题</span>
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
            <span className="basic-settings__theme-option-label">跟随 IDE</span>
          </button>
          <button
            type="button"
            className={cx('basic-settings__theme-option', themePref === 'light' && 'active')}
            onClick={() => handleThemeChange('light')}
          >
            <span className="basic-settings__theme-icon basic-settings__theme-icon--light">
              <SunIcon />
            </span>
            <span className="basic-settings__theme-option-label">浅色</span>
          </button>
          <button
            type="button"
            className={cx('basic-settings__theme-option', themePref === 'dark' && 'active')}
            onClick={() => handleThemeChange('dark')}
          >
            <span className="basic-settings__theme-icon basic-settings__theme-icon--dark">
              <MoonIcon />
            </span>
            <span className="basic-settings__theme-option-label">深色</span>
          </button>
        </div>
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>跟随 IDE 时随 IDE 的亮/暗主题自动切换</span>
        </small>
      </section>

      {/* 字体大小 */}
      <section className="basic-settings__section">
        <div className="basic-settings__field-header">
          <span className="codicon codicon-text-size" />
          <span className="basic-settings__field-label">字体大小</span>
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
          {FONT_SIZE_OPTIONS.map((opt) => (
            <option key={opt.level} value={opt.level}>
              {opt.label}
            </option>
          ))}
        </select>
        <small className="basic-settings__hint">
          <span className="codicon codicon-info" />
          <span>缩放整个界面（含图标与间距），对所有会话标签生效</span>
        </small>
      </section>

      {/* 聊天背景色 */}
      <ColorSection
        icon="codicon-paintcan"
        label="聊天背景色"
        hint="自定义聊天区域和输入框的背景色"
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
        label="顶栏颜色"
        hint="自定义顶部标题栏颜色，文字与边框颜色按对比度自动适配"
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
        label="用户消息气泡色"
        hint="自定义用户消息气泡背景色，文字颜色按对比度自动适配"
        value={userMsg}
        defaultColor={defaults.userMsg}
        presets={presets ? USER_MSG_LIGHT_PRESETS : USER_MSG_DARK_PRESETS}
        onChange={(c) => {
          setCustomColor('userMsg', c)
          setUserMsg(c)
        }}
      />
    </div>
  )
}
