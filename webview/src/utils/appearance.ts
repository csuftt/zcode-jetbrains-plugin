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

/** 色块颜色深度 key（外观设置页「色块颜色深度」滑条，0..100 百分比）*/
export const WS_DEPTH_KEY = 'zcode.wsColorDepth'

/** 多标签同步监听的 key 集合（storage 事件过滤用） */
const WATCHED_KEYS = [FONT_SCALE_KEY, CHAT_BG_COLOR_KEY, USER_MSG_COLOR_KEY, CHAT_BAR_COLOR_KEY, WS_DEPTH_KEY]

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

/* ============ 色块颜色深度（2026-11-07：横向滑条实时百分比，0..100）============ */

/** 百分比范围与默认：50=默认档（2026-11-06 五轮调色终稿色板，白字 2.7~2.9）。滑条两端较
 *  五档制放开：0%≈白字 5.5+（最深），100%≈1.9~2.1（贴近原金黄 1.95 洗白线，观感用户自担）。
 *  实现=对基准色板做 HSL 亮度等比偏移（色相/饱和度不动，同 Kotlin WsTabColors 公式），
 *  端点 ±0.14 与 WsTabColors.DEPTH_L_OFFSET_MAX 对齐，改动两处同步 */
export const WS_DEPTH_MIN = 0
export const WS_DEPTH_MAX = 100
export const DEFAULT_WS_DEPTH = 50
const WS_DEPTH_L_OFFSET_MAX = 0.14

/** 深度样式注入点（<style> 双主题规则，见 applyWsColorDepth） */
const WS_DEPTH_STYLE_ID = 'zcode-ws-depth-style'

/** 基准色板（=默认档 50%，与 variables.less 基础值一致，改动两处同步）：
 *  顺序=gold, dir1..dir9；[暗主题值, 浅主题值] */
const WS_DEPTH_VARS = [
  '--ws-badge-gold', '--ws-dir-1', '--ws-dir-2', '--ws-dir-3', '--ws-dir-4',
  '--ws-dir-5', '--ws-dir-6', '--ws-dir-7', '--ws-dir-8', '--ws-dir-9',
] as const
const WS_DEPTH_BASE: [string, string][] = [
  ['#ca8f00', '#c98d00'], // gold
  ['#f07500', '#f07500'], // dir1 橙
  ['#12ab9a', '#10ab98'], // dir2 青
  ['#539de6', '#549bec'], // dir3 蓝
  ['#9c8ce7', '#9c8eda'], // dir4 紫
  ['#a58dc8', '#a98dce'], // dir5 深紫
  ['#c182c4', '#d676c8'], // dir6 洋红
  ['#d27ac7', '#c67fc5'], // dir7 紫红
  ['#d77d94', '#da7c95'], // dir8 粉红
  ['#dd7d76', '#dd7d75'], // dir9 红
]

function clampWsDepth(depth: number): number {
  return Math.min(WS_DEPTH_MAX, Math.max(WS_DEPTH_MIN, Math.round(depth)))
}

/** 读取深度百分比（脏值/缺省回 50） */
export function getWsColorDepth(): number {
  const saved = parseInt(localStorage.getItem(WS_DEPTH_KEY) || '', 10)
  return Number.isFinite(saved) && saved >= WS_DEPTH_MIN && saved <= WS_DEPTH_MAX ? saved : DEFAULT_WS_DEPTH
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let rgb: [number, number, number]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return `#${rgb.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`
}

/** 十六进制色的 HSL 亮度偏移（色相/饱和度不动；δ=0 原样返回免浮点往返） */
function shiftLightnessHex(hex: string, delta: number): string {
  if (delta === 0) return hex
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255
  const [h, s, l] = rgbToHsl(r, g, b)
  return hslToHex(h, s, Math.min(1, Math.max(0, l + delta)))
}

/** 深度百分比 → 注入 <style> 双主题规则（:root 暗值 + :root[data-theme='light'] 浅值）。
 *  不用 html 内联变量（会同时压过两主题）也不用静态覆盖块（盖不住连续值）：样式表
 *  追加在 vite 产物之后，同特异性靠文档序取胜，data-theme 切主题自动跟随。
 *  50% 时注入值与基础值恒等（往返无损），统一注入免分叉。 */
function applyWsColorDepth(percent: number): void {
  const delta = ((clampWsDepth(percent) - 50) / 50) * WS_DEPTH_L_OFFSET_MAX
  let el = document.getElementById(WS_DEPTH_STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = WS_DEPTH_STYLE_ID
    document.head.appendChild(el)
  }
  const rule = (themeIdx: 0 | 1) =>
    WS_DEPTH_VARS.map((v, i) => `${v}: ${shiftLightnessHex(WS_DEPTH_BASE[i][themeIdx], delta)}`).join('; ')
  el.textContent = `:root { ${rule(0)} }\n:root[data-theme='light'] { ${rule(1)} }`
}

let wsDepthPersistTimer: ReturnType<typeof setTimeout> | null = null

/** 设置深度百分比：视觉即时生效（滑条拖动每帧触发），持久化+广播防抖 400ms
 *  （appearanceSave 全量回存会推所有标签与 Java 图标重挂，逐帧发太吵） */
export function setWsColorDepth(depth: number): void {
  const clamped = clampWsDepth(depth)
  localStorage.setItem(WS_DEPTH_KEY, String(clamped))
  applyWsColorDepth(clamped)
  if (wsDepthPersistTimer) clearTimeout(wsDepthPersistTimer)
  wsDepthPersistTimer = setTimeout(persistAppearance, 400)
}

/* ============ IDE 侧持久化（权威源） ============ */

/** Java 注入的外观配置（buildBridgeJs 生成，无配置时为 null）*/
interface InjectedAppearance {
  fontScale?: number
  themePref?: string
  chatBg?: string
  chatBar?: string
  userMsg?: string
  /** 色块颜色深度百分比 0..100（旧包/缺省不动本端档位）*/
  wsColorDepth?: number
}

declare global {
  interface Window {
    __ZCODE_APPEARANCE__?: InjectedAppearance | null
    __INITIAL_IDE_THEME__?: 'light' | 'dark'
    /** Java 侧外观广播（保存后推送到所有已开标签；JCEF 多 browser 间 storage 事件不派发）*/
    onAppearanceChanged?: (cfg: InjectedAppearance) => void
  }
}

/** 应用主题偏好到 DOM：显式 light/dark 直接生效；''（跟随 IDE）回落注入的 IDE 主题 */
function applyThemePref(themePref: string): void {
  if (themePref === 'light' || themePref === 'dark') {
    localStorage.setItem(THEME_PREF_KEY, themePref)
    document.documentElement.setAttribute('data-theme', themePref)
  } else {
    localStorage.removeItem(THEME_PREF_KEY)
    document.documentElement.setAttribute('data-theme', window.__INITIAL_IDE_THEME__ ?? 'dark')
  }
}

/** 应用注入配置：IDE 侧为权威源，覆盖并写回 localStorage（后续 storage 机制照常工作）*/
function applyInjectedAppearance(cfg: InjectedAppearance): void {
  const fs = cfg.fontScale
  if (typeof fs === 'number' && fs >= 1 && fs <= 6) {
    localStorage.setItem(FONT_SCALE_KEY, String(fs))
    applyFontScale(fs as FontScaleLevel)
  }
  // 主题偏好：localStorage + data-theme 都要应用——广播场景其他标签的 useTheme
  // 已跑完挂载逻辑不会重读 localStorage，DOM 属性必须在此直接设置
  if (typeof cfg.themePref === 'string') {
    applyThemePref(cfg.themePref)
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
  const depth = cfg.wsColorDepth
  if (typeof depth === 'number' && depth >= WS_DEPTH_MIN && depth <= WS_DEPTH_MAX) {
    localStorage.setItem(WS_DEPTH_KEY, String(depth))
    applyWsColorDepth(depth)
  }
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
        wsColorDepth: getWsColorDepth(),
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
  applyWsColorDepth(getWsColorDepth())
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

    // Java 侧多标签广播：任一标签保存外观后，所有已开标签经此回调幂等应用
    // （JCEF 多 browser 间 storage 事件不派发，localStorage 写入不会通知其他标签）
    window.onAppearanceChanged = (cfg) => applyInjectedAppearance(cfg)
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
    applyWsColorDepth(getWsColorDepth())
  })
}
