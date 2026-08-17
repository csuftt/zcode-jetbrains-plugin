/**
 * 外观应用层（来源 cc-gui chatBarTheme.ts / useThemeInit / useSettingsThemeSync）
 *
 * 职责：字号缩放 + 三组自定义颜色（聊天背景/顶栏/用户气泡）+ 主题偏好的读写与应用。
 *
 * 持久化双轨：
 *   - 权威源 = IDE 侧 PropertiesComponent（生产模式内置 server 端口随机，origin 每次
 *     重启变化，localStorage 按 origin 隔离会丢）——启动时 Java 经 buildBridgeJs 注入
 *     window.__ZCODE_APPEARANCE__，变更时经 appearanceSave op 全量回存；
 *   - localStorage = 会话内缓存（注入值启动时写回）：承担多标签 storage 事件实时同步
 *     （多标签 webview 同 origin 共享），dev mock 模式下即权威源。
 *
 * 变量钩子（variables.less 已预留）：
 *   --font-scale              → global.less 挂 #root transform scale
 *   --bg-chat                 → 聊天区+输入区背景（chat-view/input-box）
 *   --color-message-user-bg   → 用户气泡背景（message-bubble）
 *   --color-chat-bars-*       → 顶栏 6 变量组（header.less 带 fallback）
 */

import { sendToJava, isInJcef } from '@/ipc/bridge'

/* ============ localStorage key ============ */

/** 主题偏好 key（useTheme.ts 共用，跟随 IDE 时 key 不存在）*/
export const THEME_PREF_KEY = 'zcode-theme-pref'

const FONT_SCALE_KEY = 'zcode.fontScale'
const CHAT_BG_COLOR_KEY = 'zcode.chatBgColor'
const USER_MSG_COLOR_KEY = 'zcode.userMsgColor'
const CHAT_BAR_COLOR_KEY = 'zcode.chatBarColor'

/** 多标签同步监听的 key 集合（storage 事件过滤用） */
const WATCHED_KEYS = [FONT_SCALE_KEY, CHAT_BG_COLOR_KEY, USER_MSG_COLOR_KEY, CHAT_BAR_COLOR_KEY]

/* ============ 字号缩放（cc-gui：6 级 → --font-scale，global.less #root zoom） ============ */

export type FontScaleLevel = 1 | 2 | 3 | 4 | 5 | 6

/** 级别 → 缩放比（cc-gui fontSizeMap 同款） */
export const FONT_SCALE_MAP: Record<FontScaleLevel, number> = {
  1: 0.8,
  2: 0.9,
  3: 1.0,
  4: 1.1,
  5: 1.2,
  6: 1.4,
}

/** 默认 3 级（100%）：升级前后观感不变 */
export const DEFAULT_FONT_SCALE_LEVEL: FontScaleLevel = 3

export function getFontScaleLevel(): FontScaleLevel {
  const saved = parseInt(localStorage.getItem(FONT_SCALE_KEY) || '', 10)
  return saved >= 1 && saved <= 6 ? (saved as FontScaleLevel) : DEFAULT_FONT_SCALE_LEVEL
}

/** 应用字号级别：写 --font-scale + 持久化 */
export function setFontScaleLevel(level: FontScaleLevel): void {
  localStorage.setItem(FONT_SCALE_KEY, String(level))
  applyFontScale(level)
  persistAppearance()
}

function applyFontScale(level: FontScaleLevel): void {
  const scale = FONT_SCALE_MAP[level] ?? 1
  document.documentElement.style.setProperty('--font-scale', String(scale))
}

/* ============ 颜色工具（cc-gui chatBarTheme.ts 同款算法） ============ */

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
const LIGHT_TEXT = '#ffffff'
const DARK_TEXT = '#1f2328'

export function isValidHexColor(color: string): boolean {
  return HEX_COLOR_PATTERN.test(color)
}

type Rgb = [number, number, number]

function hexToRgb(color: string): Rgb {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ]
}

function rgbToHex([red, green, blue]: Rgb): string {
  return `#${[red, green, blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')}`
}

function mixColors(base: string, overlay: string, overlayRatio: number): string {
  const baseRgb = hexToRgb(base)
  const overlayRgb = hexToRgb(overlay)
  return rgbToHex(
    baseRgb.map((channel, index) => channel * (1 - overlayRatio) + overlayRgb[index] * overlayRatio) as Rgb,
  )
}

function relativeLuminance(color: string): number {
  const channels = hexToRgb(color).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

/** WCAG 对比度自动选黑白文字色 */
function getReadableTextColor(background: string): string {
  return contrastRatio(background, LIGHT_TEXT) >= contrastRatio(background, DARK_TEXT)
    ? LIGHT_TEXT
    : DARK_TEXT
}

/* ============ 顶栏颜色（6 派生变量，cc-gui applyChatBarThemeColor 原样移植） ============ */

const CHAT_BAR_CSS_VARIABLES = {
  background: '--color-chat-bars-bg',
  hoverBackground: '--color-chat-bars-hover-bg',
  activeBackground: '--color-chat-bars-active-bg',
  border: '--color-chat-bars-border',
  text: '--color-chat-bars-text',
  mutedText: '--color-chat-bars-muted-text',
} as const

function applyChatBarThemeColor(color: string, root: HTMLElement = document.documentElement): void {
  if (!isValidHexColor(color)) {
    Object.values(CHAT_BAR_CSS_VARIABLES).forEach((variable) => root.style.removeProperty(variable))
    return
  }
  const normalizedColor = color.toLowerCase()
  const textColor = getReadableTextColor(normalizedColor)
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.background, normalizedColor)
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.hoverBackground, mixColors(normalizedColor, textColor, 0.08))
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.activeBackground, mixColors(normalizedColor, textColor, 0.14))
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.border, mixColors(normalizedColor, textColor, 0.24))
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.text, textColor)
  root.style.setProperty(CHAT_BAR_CSS_VARIABLES.mutedText, mixColors(normalizedColor, textColor, 0.72))
}

/* ============ 三组自定义颜色读写 ============ */

export type CustomColorKey = 'chatBg' | 'userMsg' | 'chatBar'

const COLOR_KEYS: Record<CustomColorKey, string> = {
  chatBg: CHAT_BG_COLOR_KEY,
  userMsg: USER_MSG_COLOR_KEY,
  chatBar: CHAT_BAR_COLOR_KEY,
}

/** 读取自定义色（'' = 未自定义，用主题默认） */
export function getCustomColor(key: CustomColorKey): string {
  const saved = localStorage.getItem(COLOR_KEYS[key])
  return saved && isValidHexColor(saved) ? saved : ''
}

/** 应用自定义色到 DOM（不落盘） */
function applyCustomColor(key: CustomColorKey, color: string): void {
  const root = document.documentElement
  if (!color) {
    if (key === 'chatBar') {
      applyChatBarThemeColor('')
    } else {
      root.style.removeProperty(key === 'chatBg' ? '--bg-chat' : '--color-message-user-bg')
      if (key === 'userMsg') root.style.removeProperty('--color-message-user-text')
    }
    return
  }
  if (key === 'chatBg') {
    root.style.setProperty('--bg-chat', color)
  } else if (key === 'chatBar') {
    applyChatBarThemeColor(color)
  } else {
    // 气泡背景自定义时按对比度自动选黑/白文字（比 cc-gui 固定白字的已知缺陷更进一步）
    root.style.setProperty('--color-message-user-bg', color)
    root.style.setProperty('--color-message-user-text', getReadableTextColor(color.toLowerCase()))
  }
}

/** 设置自定义色：立即生效 + 持久化（'' = 清除恢复主题默认） */
export function setCustomColor(key: CustomColorKey, color: string): void {
  if (color) {
    localStorage.setItem(COLOR_KEYS[key], color)
  } else {
    localStorage.removeItem(COLOR_KEYS[key])
  }
  applyCustomColor(key, color)
  persistAppearance()
}

/* ============ IDE 侧持久化（权威源） ============ */

/** Java 注入的外观配置（buildBridgeJs 生成，无配置时为 null）*/
interface InjectedAppearance {
  fontScale?: number
  themePref?: string
  chatBg?: string
  chatBar?: string
  userMsg?: string
}

declare global {
  interface Window {
    __ZCODE_APPEARANCE__?: InjectedAppearance | null
  }
}

/** 应用注入配置：IDE 侧为权威源，覆盖并写回 localStorage（后续 storage 机制照常工作）*/
function applyInjectedAppearance(cfg: InjectedAppearance): void {
  const fs = cfg.fontScale
  if (typeof fs === 'number' && fs >= 1 && fs <= 6) {
    localStorage.setItem(FONT_SCALE_KEY, String(fs))
    applyFontScale(fs as FontScaleLevel)
  }
  // 主题偏好（''=跟随 IDE=移除 key）；useTheme 的 useEffect 随后读 localStorage 生效
  if (typeof cfg.themePref === 'string') {
    if (cfg.themePref === 'light' || cfg.themePref === 'dark') {
      localStorage.setItem(THEME_PREF_KEY, cfg.themePref)
    } else {
      localStorage.removeItem(THEME_PREF_KEY)
    }
  }
  const colors: [CustomColorKey, string][] = [
    ['chatBg', cfg.chatBg ?? ''],
    ['chatBar', cfg.chatBar ?? ''],
    ['userMsg', cfg.userMsg ?? ''],
  ]
  colors.forEach(([key, v]) => {
    const color = v && isValidHexColor(v) ? v : ''
    if (color) localStorage.setItem(COLOR_KEYS[key], color)
    else localStorage.removeItem(COLOR_KEYS[key])
    applyCustomColor(key, color)
  })
}

/** 全量配置回存 IDE（PropertiesComponent）。localStorage 组装，JCEF 内才发送；
 *  fire-and-forget：前端乐观更新，不依赖应答。 */
export function persistAppearance(): void {
  if (!isInJcef()) return // mock/dev 模式 localStorage 即权威源
  try {
    const themePref = localStorage.getItem(THEME_PREF_KEY)
    sendToJava({
      op: 'appearanceSave',
      config: {
        fontScale: getFontScaleLevel(),
        themePref: themePref === 'light' || themePref === 'dark' ? themePref : '',
        chatBg: getCustomColor('chatBg'),
        chatBar: getCustomColor('chatBar'),
        userMsg: getCustomColor('userMsg'),
      },
    })
  } catch {
    /* 保存失败静默：会话内观感不受影响，仅重启回退 */
  }
}

/* ============ 启动恢复 + 多标签同步 ============ */

let storageListenerInstalled = false

/**
 * 启动恢复（main.tsx 在 render 前调用）：
 * 1. 先应用 localStorage（同 origin 会话内有值则首帧即正确）；
 * 2. JCEF 内等待 Java 注入的权威配置（onLoadStart 注入，通常早于本模块；executeJavaScript
 *    时序不保证，轮询兜底 2s），到达后覆盖应用并写回 localStorage；
 * 3. 注册 storage 监听实现多标签页实时同步（同 origin 共享 localStorage，改一处其余跟随）。
 */
export function initAppearance(): void {
  applyFontScale(getFontScaleLevel())
  applyCustomColor('chatBg', getCustomColor('chatBg'))
  applyCustomColor('userMsg', getCustomColor('userMsg'))
  applyCustomColor('chatBar', getCustomColor('chatBar'))

  // 权威配置注入等待（非 JCEF mock 模式无注入，跳过）
  if (isInJcef()) {
    let retries = 0
    const poll = () => {
      const cfg = window.__ZCODE_APPEARANCE__
      if (cfg) {
        applyInjectedAppearance(cfg)
        return
      }
      if (++retries <= 40) setTimeout(poll, 50) // 最多 2s
    }
    poll()
  }

  if (storageListenerInstalled) return
  storageListenerInstalled = true
  window.addEventListener('storage', (e) => {
    if (!e.key || !WATCHED_KEYS.includes(e.key)) return
    // 读新值重新应用（被删 key → getCustomColor 返回 '' 恢复默认）
    applyFontScale(getFontScaleLevel())
    applyCustomColor('chatBg', getCustomColor('chatBg'))
    applyCustomColor('userMsg', getCustomColor('userMsg'))
    applyCustomColor('chatBar', getCustomColor('chatBar'))
  })
}
