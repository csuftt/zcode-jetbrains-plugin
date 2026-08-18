/**
 * i18n 初始化（来源 cc-gui i18n/config.ts，适配本项目注入/持久化体系）
 *
 * 语言包按模块拆分文件（避免巨型单文件），在 config 层合并为单个 translation 命名空间：
 * 各模块文件内容即该命名空间对象，如 locales/zh/settings.json = {"title": "设置"} → t('settings.title')。
 *
 * 初始语言解析优先级（见 language.ts）：
 *   window.__ZCODE_LANGUAGE__（IDE onLoadStart 注入，权威）> localStorage zcode.language（手动选择，
 *   经 kv 通道回存 IDE）> 默认 zh。
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import zhCommon from './locales/zh/common.json'
import zhApp from './locales/zh/app.json'
import zhSettings from './locales/zh/settings.json'
import zhInput from './locales/zh/input.json'
import zhChat from './locales/zh/chat.json'
import zhTool from './locales/zh/tool.json'
import zhHistory from './locales/zh/history.json'
import zhMcp from './locales/zh/mcp.json'
import zhUsage from './locales/zh/usage.json'
import zhMemory from './locales/zh/memory.json'
import zhSkills from './locales/zh/skills.json'
import zhUtils from './locales/zh/utils.json'
import zhModels from './locales/zh/models.json'

import zhTwCommon from './locales/zh-TW/common.json'
import zhTwApp from './locales/zh-TW/app.json'
import zhTwSettings from './locales/zh-TW/settings.json'
import zhTwInput from './locales/zh-TW/input.json'
import zhTwChat from './locales/zh-TW/chat.json'
import zhTwTool from './locales/zh-TW/tool.json'
import zhTwHistory from './locales/zh-TW/history.json'
import zhTwMcp from './locales/zh-TW/mcp.json'
import zhTwUsage from './locales/zh-TW/usage.json'
import zhTwMemory from './locales/zh-TW/memory.json'
import zhTwSkills from './locales/zh-TW/skills.json'
import zhTwUtils from './locales/zh-TW/utils.json'
import zhTwModels from './locales/zh-TW/models.json'

import enCommon from './locales/en/common.json'
import enApp from './locales/en/app.json'
import enSettings from './locales/en/settings.json'
import enInput from './locales/en/input.json'
import enChat from './locales/en/chat.json'
import enTool from './locales/en/tool.json'
import enHistory from './locales/en/history.json'
import enMcp from './locales/en/mcp.json'
import enUsage from './locales/en/usage.json'
import enMemory from './locales/en/memory.json'
import enSkills from './locales/en/skills.json'
import enUtils from './locales/en/utils.json'
import enModels from './locales/en/models.json'

import jaCommon from './locales/ja/common.json'
import jaApp from './locales/ja/app.json'
import jaSettings from './locales/ja/settings.json'
import jaInput from './locales/ja/input.json'
import jaChat from './locales/ja/chat.json'
import jaTool from './locales/ja/tool.json'
import jaHistory from './locales/ja/history.json'
import jaMcp from './locales/ja/mcp.json'
import jaUsage from './locales/ja/usage.json'
import jaMemory from './locales/ja/memory.json'
import jaSkills from './locales/ja/skills.json'
import jaUtils from './locales/ja/utils.json'
import jaModels from './locales/ja/models.json'

import koCommon from './locales/ko/common.json'
import koApp from './locales/ko/app.json'
import koSettings from './locales/ko/settings.json'
import koInput from './locales/ko/input.json'
import koChat from './locales/ko/chat.json'
import koTool from './locales/ko/tool.json'
import koHistory from './locales/ko/history.json'
import koMcp from './locales/ko/mcp.json'
import koUsage from './locales/ko/usage.json'
import koMemory from './locales/ko/memory.json'
import koSkills from './locales/ko/skills.json'
import koUtils from './locales/ko/utils.json'
import koModels from './locales/ko/models.json'

/** 支持的语言码（IDE 侧 ZCodeLanguageService 同款白名单）*/
export const SUPPORTED_LANGUAGES = ['zh', 'zh-TW', 'en', 'ja', 'ko'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const DEFAULT_LANGUAGE: SupportedLanguage = 'zh'

export const LANGUAGE_STORAGE_KEY = 'zcode.language'

function merge(
  common: object,
  app: object,
  settings: object,
  input: object,
  chat: object,
  tool: object,
  history: object,
  mcp: object,
  usage: object,
  memory: object,
  skills: object,
  utils: object,
  models: object,
) {
  return { common, app, settings, input, chat, tool, history, mcp, usage, memory, skills, utils, models }
}

/** IDE 注入的权威语言（buildBridgeJs 生成；无注入为 undefined）*/
declare global {
  interface Window {
    __ZCODE_LANGUAGE__?: string
  }
}

export function isSupportedLanguage(v: unknown): v is SupportedLanguage {
  return typeof v === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(v)
}

/**
 * 初始语言（i18n init 用；同步）：
 * IDE 注入值优先；未注入（dev 浏览器/mock/注入未到）回退 localStorage 手动值；再回退默认 zh。
 */
export function getInitialLanguage(): SupportedLanguage {
  // 非 browser 环境（vitest node env）无 window，直接回退默认
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE
  if (isSupportedLanguage(window.__ZCODE_LANGUAGE__)) return window.__ZCODE_LANGUAGE__
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (isSupportedLanguage(saved)) return saved
  } catch {
    /* localStorage 不可用 */
  }
  return DEFAULT_LANGUAGE
}

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: merge(zhCommon, zhApp, zhSettings, zhInput, zhChat, zhTool, zhHistory, zhMcp, zhUsage, zhMemory, zhSkills, zhUtils, zhModels) },
    'zh-TW': { translation: merge(zhTwCommon, zhTwApp, zhTwSettings, zhTwInput, zhTwChat, zhTwTool, zhTwHistory, zhTwMcp, zhTwUsage, zhTwMemory, zhTwSkills, zhTwUtils, zhTwModels) },
    en: { translation: merge(enCommon, enApp, enSettings, enInput, enChat, enTool, enHistory, enMcp, enUsage, enMemory, enSkills, enUtils, enModels) },
    ja: { translation: merge(jaCommon, jaApp, jaSettings, jaInput, jaChat, jaTool, jaHistory, jaMcp, jaUsage, jaMemory, jaSkills, jaUtils, jaModels) },
    ko: { translation: merge(koCommon, koApp, koSettings, koInput, koChat, koTool, koHistory, koMcp, koUsage, koMemory, koSkills, koUtils, koModels) },
  },
  lng: getInitialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: {
    escapeValue: false, // React 已处理 XSS
  },
})

export default i18n
