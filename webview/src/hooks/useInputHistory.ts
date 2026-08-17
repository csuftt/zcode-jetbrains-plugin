/**
 * 输入历史导航 hook（参考 cc-gui ChatInputBox/hooks/useInputHistory）
 *
 * 行为（对齐 cc-gui）：
 * - 输入框为空时 ArrowUp 开始回溯历史（从最新一条开始）
 * - 导航中 ArrowUp 向更早移动（到头停住），ArrowDown 向更新移动
 * - ArrowDown 越过最新一条时恢复导航开始前的草稿（空输入触发时即清空）
 * - 导航中按任意其他键退出导航态（再次 ArrowUp 从最新重新开始）
 * - Ctrl/Meta/Alt 修饰或 IME 合成中不触发
 *
 * 与 cc-gui 的差异（简化）：
 * - 只记录完整发送文本，不做 fragment 拆分/使用计数/重要性清理
 * - 历史仅存 localStorage（JCEF 内持久），不同步到磁盘文件
 */

import { useCallback, useRef } from 'react'

const HISTORY_STORAGE_KEY = 'zcode-input-history'
const MAX_HISTORY_ITEMS = 200
const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF]/g

interface Options {
  /** 读输入框当前文本 */
  getTextContent: () => string
  /** 回填文本到输入框（含光标定位/状态同步，由 InputBox 实现）*/
  setText: (text: string) => void
}

function loadHistory(): string[] {
  if (memoryHistory) return memoryHistory
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    memoryHistory = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : []
  } catch {
    // localStorage 禁用时降级为仅内存历史（页面会话内有效）
    memoryHistory = []
  }
  return memoryHistory
}

/** 模块级内存历史：组件重挂载（流式重渲染/HMR）不丢 */
let memoryHistory: string[] | null = null

/** 幽灵补全最少输入长度（cc-gui minQueryLength 同款：输 2 字符才触发）*/
const MIN_SUGGESTION_QUERY = 2

/**
 * 历史前缀建议查询（cc-gui useInlineHistoryCompletion.findBestMatch 简化版）：
 * 大小写不敏感前缀匹配，最近的优先（历史数组时间序、尾部最新；本插件无使用计数，
 * 不照搬 cc-gui 的按次数排序）。返回建议全文，无命中返回 null。
 */
export function findHistorySuggestion(query: string): string | null {
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

export function useInputHistory({ getTextContent, setText }: Options) {
  /** 当前导航到的下标，-1 = 非导航态（导航态随组件实例，历史数据在模块级）*/
  const historyIndexRef = useRef(-1)
  /** 导航开始前的草稿（ArrowDown 越过最新一条时恢复）*/
  const draftRef = useRef('')

  /** 记录一条发送文本：去零宽字符、去重、追加尾部、截断后持久化 */
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
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // localStorage 禁用/写满时静默降级为仅内存历史
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
