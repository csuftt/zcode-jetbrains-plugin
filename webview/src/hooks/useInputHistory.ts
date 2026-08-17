/**
 * 输入历史导航 hook（参考 cc-gui ChatInputBox/hooks/useInputHistory）
 *
 * 行为（对齐 cc-gui）：
 * - 输入框为空时 ArrowUp 开始回溯历史（从最新一条开始）
 * - 导航中 ArrowUp 向更早移动（到头停住），ArrowDown 向最新移动
 * - ArrowDown 越过最新一条时恢复导航开始前的草稿（空输入触发时即清空）
 * - 导航中按任意其他键退出导航态（再次 ArrowUp 从最新重新开始）
 * - Ctrl/Meta/Alt 修饰或 IME 合成中不触发
 *
 * 与 cc-gui 的差异（简化）：
 * - 只记录完整发送文本，不做 fragment 拆分；重要度=整条使用计数
 * - 历史经 persist 通道持久化（IDE PropertiesComponent 权威源），不同步到磁盘文件
 *
 * 数据模型（三条 kv，均在 persist 域，kvSave 全量回存自动携带）：
 * - zcode-input-history：string[]（时间序，尾部最新，≤200 条）
 * - zcode-input-history-counts：Record<文本, 使用次数>（=重要度）
 * - zcode-input-history-timestamps：Record<文本, 最后使用 ISO 时间>
 * - zcode-history-completion-enabled：幽灵补全开关（'false' 关闭，默认开启）
 */

import { useCallback, useRef } from 'react'
import { getPersisted, setPersisted, removePersisted, KV_HYDRATED_EVENT } from '@/utils/persist'

const HISTORY_STORAGE_KEY = 'zcode-input-history'
const COUNTS_STORAGE_KEY = 'zcode-input-history-counts'
const TIMESTAMPS_STORAGE_KEY = 'zcode-input-history-timestamps'
const COMPLETION_ENABLED_KEY = 'zcode-history-completion-enabled'
const MAX_HISTORY_ITEMS = 200
const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF]/g

/** 设置页展示/管理用条目（cc-gui HistoryItem 同构）*/
export interface HistoryItem {
  text: string
  /** 重要度（使用计数，越大越常用）*/
  importance: number
  /** 最后使用时间（ISO 字符串）*/
  timestamp?: string
}

interface Options {
  /** 读输入框当前文本 */
  getTextContent: () => string
  /** 回填文本到输入框（含光标定位/状态同步，由 InputBox 实现）*/
  setText: (text: string) => void
}

function loadHistory(): string[] {
  if (memoryHistory) return memoryHistory
  try {
    const raw = getPersisted(HISTORY_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    memoryHistory = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : []
  } catch {
    // 存储不可用时降级为仅内存历史（页面会话内有效）
    memoryHistory = []
  }
  return memoryHistory
}

/** 模块级内存历史：组件重挂载（流式重渲染/HMR）不丢 */
let memoryHistory: string[] | null = null

// 冷启动注入晚于首次 loadHistory 时，memoryHistory 缓存了空数组且此后短路不再读
// localStorage——水合完成（localStorage 已被权威 kv 写回）时丢弃缓存，下次读取即恢复
if (typeof window !== 'undefined') {
  window.addEventListener(KV_HYDRATED_EVENT, () => {
    memoryHistory = null
  })
}

function loadCounts(): Record<string, number> {
  try {
    const raw = getPersisted(COUNTS_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function loadTimestamps(): Record<string, string> {
  try {
    const raw = getPersisted(TIMESTAMPS_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function saveHistory(items: string[]): void {
  memoryHistory = items
  try {
    setPersisted(HISTORY_STORAGE_KEY, JSON.stringify(items))
  } catch {
    // 存储禁用时仅保留内存态
  }
}

function saveCounts(counts: Record<string, number>): void {
  try {
    setPersisted(COUNTS_STORAGE_KEY, JSON.stringify(counts))
  } catch {
    /* 同上 */
  }
}

function saveTimestamps(timestamps: Record<string, string>): void {
  try {
    setPersisted(TIMESTAMPS_STORAGE_KEY, JSON.stringify(timestamps))
  } catch {
    /* 同上 */
  }
}

/** 幽灵补全最少输入长度（cc-gui minQueryLength 同款：输 2 字符才触发）*/
const MIN_SUGGESTION_QUERY = 2

/**
 * 历史前缀建议查询（cc-gui useInlineHistoryCompletion.findBestMatch 简化版）：
 * 大小写不敏感前缀匹配，最近的优先（历史数组时间序、尾部最新；本插件无使用计数，
 * 不照搬 cc-gui 的按次数排序）。返回建议全文，无命中返回 null。
 * 补全开关关闭时恒返回 null（仅停幽灵补全；ArrowUp 导航不受影响，对齐 cc-gui）。
 */
export function findHistorySuggestion(query: string): string | null {
  if (!isHistoryCompletionEnabled()) return null
  const clean = query.replace(INVISIBLE_CHARS_RE, '')
  if (clean.length < MIN_SUGGESTION_QUERY) return null
  const lower = clean.toLowerCase()
  const items = loadHistory()
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.length > clean.length && item.toLowerCase().startsWith(lower)) return item
  }
  return null
}

/* ============ 补全开关 ============ */

export function isHistoryCompletionEnabled(): boolean {
  try {
    return getPersisted(COMPLETION_ENABLED_KEY) !== 'false'
  } catch {
    return true
  }
}

export function setHistoryCompletionEnabled(enabled: boolean): void {
  try {
    setPersisted(COMPLETION_ENABLED_KEY, String(enabled))
  } catch {
    /* 存储不可用：本次会话内仍可读默认值 */
  }
}

/* ============ 历史管理 API（设置页用，cc-gui inputHistoryStorage 对齐简化） ============ */

/** 合并三份存储，按重要度降序（cc-gui loadHistoryWithImportance 同款排序）*/
export function loadHistoryWithImportance(): HistoryItem[] {
  const counts = loadCounts()
  const timestamps = loadTimestamps()
  const items = loadHistory().map((text) => ({
    text,
    importance: counts[text] || 1,
    timestamp: timestamps[text],
  }))
  items.sort((a, b) => b.importance - a.importance)
  return items
}

/** 删除单条（连带清理计数与时间戳；memoryHistory 同步，输入框导航立即感知）*/
export function deleteHistoryItem(text: string): void {
  const next = loadHistory().filter((item) => item !== text)
  saveHistory(next)
  const counts = loadCounts()
  delete counts[text]
  saveCounts(counts)
  const timestamps = loadTimestamps()
  delete timestamps[text]
  saveTimestamps(timestamps)
}

/** 清空全部历史 */
export function clearAllHistory(): void {
  memoryHistory = []
  try {
    removePersisted(HISTORY_STORAGE_KEY)
    removePersisted(COUNTS_STORAGE_KEY)
    removePersisted(TIMESTAMPS_STORAGE_KEY)
  } catch {
    /* 存储不可用时内存态已清 */
  }
}

/** 手动添加一条（已存在则移到尾部并覆盖重要度；时间戳取现在）*/
export function addHistoryItem(text: string, importance: number = 1): void {
  const clean = text.replace(INVISIBLE_CHARS_RE, '').trim()
  if (!clean) return
  const next = [...loadHistory().filter((item) => item !== clean), clean].slice(-MAX_HISTORY_ITEMS)
  saveHistory(next)
  const counts = loadCounts()
  counts[clean] = Math.max(1, Math.floor(importance))
  saveCounts(counts)
  const timestamps = loadTimestamps()
  timestamps[clean] = new Date().toISOString()
  saveTimestamps(timestamps)
}

/** 编辑一条：改文本时迁移计数/时间戳，与既有条目撞名时计数取较大、时间取较新 */
export function updateHistoryItem(oldText: string, newText: string, importance: number): void {
  const clean = newText.replace(INVISIBLE_CHARS_RE, '').trim()
  if (!clean) return
  const items = loadHistory()
  const index = items.indexOf(oldText)
  if (index === -1) {
    addHistoryItem(clean, importance)
    return
  }
  const counts = loadCounts()
  const timestamps = loadTimestamps()

  if (oldText === clean) {
    counts[clean] = Math.max(1, Math.floor(importance))
  } else {
    items.splice(index, 1)
    const dupIndex = items.indexOf(clean)
    if (dupIndex !== -1) items.splice(dupIndex, 1)
    items.push(clean) // 编辑后视为最近使用
    counts[clean] = Math.max(counts[clean] || 1, Math.floor(importance))
    delete counts[oldText]
    // 时间戳取新旧两者中较新的
    const newer = [timestamps[oldText], timestamps[clean]].filter(Boolean).sort().pop()
    if (newer) timestamps[clean] = newer
    delete timestamps[oldText]
    saveHistory(items.slice(-MAX_HISTORY_ITEMS))
  }
  saveCounts(counts)
  saveTimestamps(timestamps)
}

/** 清除低重要度（importance ≤ threshold）条目，返回删除条数 */
export function clearLowImportanceHistory(threshold: number = 1): number {
  const counts = loadCounts()
  const timestamps = loadTimestamps()
  const items = loadHistory()
  const keep: string[] = []
  let deleted = 0
  for (const item of items) {
    if ((counts[item] || 1) <= threshold) {
      delete counts[item]
      delete timestamps[item]
      deleted++
    } else {
      keep.push(item)
    }
  }
  if (deleted > 0) {
    saveHistory(keep)
    saveCounts(counts)
    saveTimestamps(timestamps)
  }
  return deleted
}

/* ============ hook ============ */

export function useInputHistory({ getTextContent, setText }: Options) {
  /** 当前导航到的下标，-1 = 非导航态（导航态随组件实例，历史数据在模块级）*/
  const historyIndexRef = useRef(-1)
  /** 导航开始前的草稿（ArrowDown 越过最新一条时恢复）*/
  const draftRef = useRef('')

  /** 记录一条发送文本：去零宽字符、去重、追加尾部、截断后持久化（计数+1、刷新时间戳） */
  const record = useCallback((text: string) => {
    const clean = text.replace(INVISIBLE_CHARS_RE, '').trim()
    if (!clean) return
    const next = [...loadHistory().filter((item) => item !== clean), clean].slice(
      -MAX_HISTORY_ITEMS,
    )
    memoryHistory = next
    historyIndexRef.current = -1
    draftRef.current = ''
    try {
      setPersisted(HISTORY_STORAGE_KEY, JSON.stringify(next))
      const counts = loadCounts()
      counts[clean] = (counts[clean] || 0) + 1
      setPersisted(COUNTS_STORAGE_KEY, JSON.stringify(counts))
      const timestamps = loadTimestamps()
      timestamps[clean] = new Date().toISOString()
      setPersisted(TIMESTAMPS_STORAGE_KEY, JSON.stringify(timestamps))
    } catch {
      // 存储禁用/写满时静默降级为仅内存历史
    }
  }, [])

  /** 外部重置导航态（切会话等场景）*/
  const resetNav = useCallback(() => {
    historyIndexRef.current = -1
    draftRef.current = ''
  }, [])

  /**
   * keydown 处理：返回 true 表示已消费（内部已 preventDefault 阻止光标移动）
   * 需在 @ / / 补全未打开时调用，方向键优先归补全下拉
   */
  const handleHistoryKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      // IME 合成中方向键留给候选窗口
      if (e.nativeEvent.isComposing) return false

      const key = e.key
      // 导航态下按非方向键：退出导航（用户开始编辑）
      if (historyIndexRef.current !== -1 && key !== 'ArrowUp' && key !== 'ArrowDown') {
        historyIndexRef.current = -1
        draftRef.current = ''
        return false
      }
      if (key !== 'ArrowUp' && key !== 'ArrowDown') return false
      if (e.metaKey || e.ctrlKey || e.altKey) return false

      const items = loadHistory()
      if (items.length === 0) return false

      const isNavigating = historyIndexRef.current !== -1
      // 仅空输入启动回溯：多行编辑中方向键仍归光标移动
      if (!isNavigating && getTextContent().replace(INVISIBLE_CHARS_RE, '').trim()) return false
      // ArrowDown 仅在导航态有效
      if (!isNavigating && key === 'ArrowDown') return false

      e.preventDefault()

      if (!isNavigating) draftRef.current = getTextContent()

      if (key === 'ArrowUp') {
        const nextIndex = isNavigating
          ? Math.max(0, historyIndexRef.current - 1)
          : items.length - 1
        historyIndexRef.current = nextIndex
        setText(items[nextIndex])
        return true
      }

      // ArrowDown：未到最新一条则前进，越过则恢复草稿并退出导航
      if (historyIndexRef.current < items.length - 1) {
        historyIndexRef.current += 1
        setText(items[historyIndexRef.current])
        return true
      }
      historyIndexRef.current = -1
      setText(draftRef.current)
      draftRef.current = ''
      return true
    },
    [getTextContent, setText],
  )

  return { record, resetNav, handleHistoryKeyDown }
}
