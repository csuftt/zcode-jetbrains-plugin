/**
 * IDE 主题同步 hook
 *
 * 规划文档第二节第 5 点（来源 cc-gui useThemeInit.ts）：
 *   - IDE 启动注入 window.__INITIAL_IDE_THEME__（'light'|'dark'）
 *   - 注册 window.onIdeThemeChanged，IDE 主题切换时实时推送
 *   - 用 document.documentElement.setAttribute('data-theme', ...)
 *   - 用户偏好存 localStorage：跟随 IDE / 手动覆盖
 */

import { useEffect } from 'react'
import { persistAppearance, THEME_PREF_KEY } from '@/utils/appearance'

export type IdeTheme = 'light' | 'dark'

/** localStorage key（THEME_PREF_KEY 定义于 utils/appearance.ts，两处共用）*/

/** 读取用户主题偏好（null/'' = 跟随 IDE）*/
export function getThemePreference(): IdeTheme | null {
  const v = localStorage.getItem(THEME_PREF_KEY)
  if (v === 'light' || v === 'dark') return v
  return null
}

/** 设置主题偏好（null = 跟随 IDE）*/
export function setThemePreference(theme: IdeTheme | null): void {
  if (theme === null) {
    localStorage.removeItem(THEME_PREF_KEY)
  } else {
    localStorage.setItem(THEME_PREF_KEY, theme)
  }
  // 立即应用 + 回存 IDE（PropertiesComponent，重启还原）
  applyTheme()
  persistAppearance()
}

/** 获取 IDE 当前主题（注入值，mock 模式默认暗色）*/
function getIdeTheme(): IdeTheme {
  // dev 验收：通过 URL 参数 ?theme=light 强制亮色（mock 模式用）
  if (typeof URLSearchParams !== 'undefined') {
    const t = new URLSearchParams(window.location.search).get('theme')
    if (t === 'light' || t === 'dark') return t
  }
  return window.__INITIAL_IDE_THEME__ ?? 'dark'
}

/** 计算实际生效的主题（用户偏好优先，否则跟随 IDE）*/
function getEffectiveTheme(): IdeTheme {
  const pref = getThemePreference()
  return pref ?? getIdeTheme()
}

/** 应用主题到 DOM（设置 data-theme 属性 + 切换 highlight.js 主题）*/
function applyTheme(): void {
  const theme = getEffectiveTheme()
  document.documentElement.setAttribute('data-theme', theme)
  console.log(`[theme] 应用主题: ${theme}`)
}

/**
 * 主题同步 hook：在 App 顶层调用一次。
 * 读取初始主题 + 注册 IDE 主题变化回调。
 */
export function useTheme(): void {
  useEffect(() => {
    // 应用初始主题
    applyTheme()

    // 注册 IDE 主题变化回调（Java 端通过 executeJavaScript 调用此函数）
    window.onIdeThemeChanged = (isDark: boolean) => {
      window.__INITIAL_IDE_THEME__ = isDark ? 'dark' : 'light'
      console.log(`[theme] IDE 主题变化: ${isDark ? 'dark' : 'light'}`)
      // 只有用户没手动覆盖时才跟随
      if (getThemePreference() === null) {
        applyTheme()
      }
    }

    // 监听系统主题变化（用户改了 OS 主题，且偏好是"跟随"时）
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handleSystemChange = () => {
      if (getThemePreference() === null && !window.__INITIAL_IDE_THEME__) {
        applyTheme()
      }
    }
    mql.addEventListener('change', handleSystemChange)

    return () => {
      mql.removeEventListener('change', handleSystemChange)
      delete window.onIdeThemeChanged
    }
  }, [])
}
