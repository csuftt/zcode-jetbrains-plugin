/**
 * 语言初始化 / 切换 / 多标签同步
 *
 * 语言流转（cc-gui 同款"手动优先，否则跟随 IDE"）：
 *   - IDE 侧 ZCodeLanguageService 计算：kv store 中 zcode.language（用户手动选择）优先，
 *     否则 DynamicBundle.getLocale() 映射；经 buildBridgeJs 在 onLoadStart 注入
 *     window.__ZCODE_LANGUAGE__（早于 React bundle，通常同步可读）。
 *   - 手动切换：setLanguage() 写 localStorage zcode.language（kv 通道自动去抖回存 IDE）
 *     + i18n.changeLanguage；"跟随 IDE" 则清除该 key，下次注入恢复 IDE 语言。
 *   - 多标签：storage 事件（localStorage 跨标签广播）同步切换。
 */

import i18n from '@/i18n/config'
import { setPersisted } from '@/utils/persist'
import {
  LANGUAGE_STORAGE_KEY,
  isSupportedLanguage,
  type SupportedLanguage,
} from './config'

/**
 * 启动兜底（main.tsx render 前调用）：
 * onLoadStart 注入通常早于本模块，但 executeJavaScript 时序不保证（同 initPersist 的轮询模式）。
 * 注入比 i18n 初始值晚到且不一致时补一次 changeLanguage。
 */
export function initI18nLanguage(): void {
  let retries = 0
  const poll = () => {
    const inj = window.__ZCODE_LANGUAGE__
    if (isSupportedLanguage(inj)) {
      if (inj !== i18n.language) void i18n.changeLanguage(inj)
      return
    }
    if (++retries <= 40) setTimeout(poll, 50)
  }
  poll()

  // 多标签同步：其它标签写 zcode.language → storage 事件 → 本标签跟随切换
  try {
    window.addEventListener('storage', (ev) => {
      if (ev.key !== LANGUAGE_STORAGE_KEY) return
      if (isSupportedLanguage(ev.newValue)) {
        if (ev.newValue !== i18n.language) void i18n.changeLanguage(ev.newValue)
      } else {
        // 被清除（恢复跟随 IDE）：以注入值为准（若同标签已清除则回 IDE 语言）
        if (isSupportedLanguage(window.__ZCODE_LANGUAGE__) && window.__ZCODE_LANGUAGE__ !== i18n.language) {
          void i18n.changeLanguage(window.__ZCODE_LANGUAGE__)
        }
      }
    })
  } catch {
    /* 非浏览器环境忽略 */
  }

  // IDE 广播接收（多标签语言同步；JCEF 多 browser 间 storage 事件不派发，
  // 保存 kv 后 IDE 侧 broadcastLanguage 经 executeJavaScript 调用本全局函数）
  ;(window as unknown as Record<string, unknown>).onLanguageChanged = (lang: string) => {
    if (isSupportedLanguage(lang) && lang !== i18n.language) void i18n.changeLanguage(lang)
  }

  // <html lang> 同步（index.html 硬编码 zh-CN 的动态修正）
  const syncDocLang = () => {
    document.documentElement.lang =
      i18n.language === 'zh' ? 'zh-CN' : i18n.language === 'zh-TW' ? 'zh-TW' : i18n.language
  }
  syncDocLang()
  i18n.on('languageChanged', syncDocLang)
}

/**
 * 用户选择语言：立即生效 + kv 通道持久化（重启保持、多标签经 IDE 广播/storage 事件同步）。
 * 首次未选择时无手动值，初始语言取 IDE 注入值（ZCodeLanguageService 按 IDE locale 映射）。
 */
export function setLanguage(lang: SupportedLanguage): void {
  setPersisted(LANGUAGE_STORAGE_KEY, lang)
  void i18n.changeLanguage(lang)
}
