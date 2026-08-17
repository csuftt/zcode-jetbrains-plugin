/**
 * ConversationSearch —— 会话内搜索浮层面板（移植 cc-gui，中文化、去折叠机制）
 *
 * - 浮在消息区右上角（.messages-shell 内 absolute）
 * - 三开关：区分大小写(Alt+C) / 整词(Alt+W) / 正则(Alt+R)，localStorage 持久化
 * - Enter/↓ 下一个、Shift+Enter/↑ 上一个、F3/Shift+F3 同义、Esc 关闭
 * - 计数 n/total，非法正则红字提示
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConversationSearch, DEFAULT_SEARCH_OPTIONS } from '@/hooks/useConversationSearch'
import type { SearchOptions } from '@/hooks/useConversationSearch'
import { getPersisted, setPersisted } from '@/utils/persist'
import '../styles/conversation-search.less'

const STORAGE_KEY = 'zcode.search.options'

/** 从持久化通道读选项，坏数据回默认 */
function loadStoredOptions(): SearchOptions {
  try {
    const raw = typeof window !== 'undefined' ? getPersisted(STORAGE_KEY) : null
    if (!raw) return { ...DEFAULT_SEARCH_OPTIONS }
    const parsed = JSON.parse(raw) as Partial<SearchOptions>
    return {
      matchCase: !!parsed.matchCase,
      wholeWord: !!parsed.wholeWord,
      regex: !!parsed.regex,
    }
  } catch {
    return { ...DEFAULT_SEARCH_OPTIONS }
  }
}

function persistOptions(opts: SearchOptions): void {
  if (typeof window === 'undefined') return
  try {
    setPersisted(STORAGE_KEY, JSON.stringify(opts))
  } catch {
    // 存储配额 / 隐私模式 —— 静默忽略
  }
}

export interface ConversationSearchProps {
  /** 面板是否可见（父组件控制）*/
  open: boolean
  /** 用户关闭面板（Esc / × 按钮 / 切视图）*/
  onClose: () => void
  /** 搜索的 DOM 容器（消息列表滚动区）*/
  containerRef: React.RefObject<HTMLElement | null>
  /** 渲染消息变化信号，驱动重扫（流式追加 / 历史加载后重扫）*/
  messagesSignal: string | number
}

export const ConversationSearch = memo(function ConversationSearch({
  open,
  onClose,
  containerRef,
  messagesSignal,
}: ConversationSearchProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [searchOptions, setSearchOptions] = useState<SearchOptions>(loadStoredOptions)

  // 开关变化即持久化
  useEffect(() => {
    persistOptions(searchOptions)
  }, [searchOptions])

  const {
    query, setQuery,
    matches, currentIndex,
    next, previous,
    isSearching, isRegexInvalid,
    clear,
  } = useConversationSearch({
    containerRef,
    messagesSignal,
    enabled: open,
    searchOptions,
  })

  // 面板打开时自动聚焦
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  const handleClose = useCallback(() => {
    clear()
    onClose()
  }, [clear, onClose])

  const toggleMatchCase = useCallback(() => {
    setSearchOptions((o) => ({ ...o, matchCase: !o.matchCase }))
  }, [])
  const toggleWholeWord = useCallback(() => {
    setSearchOptions((o) => ({ ...o, wholeWord: !o.wholeWord }))
  }, [])
  const toggleRegex = useCallback(() => {
    setSearchOptions((o) => ({ ...o, regex: !o.regex }))
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return

    // Alt+C / Alt+W / Alt+R 切换开关（VS Code 查找组件同款快捷键）
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      const k = e.key.toLowerCase()
      if (k === 'c') { e.preventDefault(); e.stopPropagation(); toggleMatchCase(); return }
      if (k === 'w') { e.preventDefault(); e.stopPropagation(); toggleWholeWord(); return }
      if (k === 'r') { e.preventDefault(); e.stopPropagation(); toggleRegex(); return }
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) previous()
      else next()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      handleClose()
      return
    }
    if (e.key === 'F3') {
      e.preventDefault()
      if (e.shiftKey) previous()
      else next()
      return
    }
  }, [next, previous, handleClose, toggleMatchCase, toggleWholeWord, toggleRegex])

  const counterText = useMemo(() => {
    if (!query.trim()) return ''
    if (isRegexInvalid) return t('chat.search.regexError')
    if (isSearching) return t('chat.search.searching')
    if (matches.length === 0) return t('chat.search.noResults')
    return `${currentIndex + 1}/${matches.length}`
  }, [t, query, isSearching, isRegexInvalid, matches.length, currentIndex])

  if (!open) return null

  const hasResults = matches.length > 0
  const inputError = isRegexInvalid ||
    (query.trim().length > 0 && !isSearching && matches.length === 0)

  return (
    <div
      className="cc-search-panel"
      role="search"
      aria-label={t('chat.search.panelAria')}
      onMouseDown={(e) => {
        // 防止点击面板内其他元素导致输入框失焦
        if (e.target !== inputRef.current) e.preventDefault()
      }}
    >
      <span className="cc-search-icon codicon codicon-search" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        className={`cc-search-input${inputError ? ' is-no-results' : ''}`}
        placeholder={t('chat.search.placeholder')}
        aria-label={t('chat.search.panelAria')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="button"
        className={`cc-search-toggle${searchOptions.matchCase ? ' is-active' : ''}`}
        onClick={toggleMatchCase}
        title={t('chat.search.matchCase')}
        aria-label={t('chat.search.matchCaseAria')}
        aria-pressed={searchOptions.matchCase}
      >
        <span className="codicon codicon-case-sensitive" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`cc-search-toggle${searchOptions.wholeWord ? ' is-active' : ''}`}
        onClick={toggleWholeWord}
        title={t('chat.search.wholeWord')}
        aria-label={t('chat.search.wholeWordAria')}
        aria-pressed={searchOptions.wholeWord}
      >
        <span className="codicon codicon-whole-word" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`cc-search-toggle${searchOptions.regex ? ' is-active' : ''}`}
        onClick={toggleRegex}
        title={t('chat.search.regex')}
        aria-label={t('chat.search.regexAria')}
        aria-pressed={searchOptions.regex}
      >
        <span className="codicon codicon-regex" aria-hidden="true" />
      </button>
      <span className={`cc-search-counter${isRegexInvalid ? ' is-error' : ''}`} aria-live="polite">
        {counterText}
      </span>
      <button
        type="button"
        className="cc-search-btn"
        onClick={previous}
        disabled={!hasResults}
        title={t('chat.search.prevMatch')}
        aria-label={t('chat.search.prevMatchAria')}
      >
        <span className="codicon codicon-arrow-up" />
      </button>
      <button
        type="button"
        className="cc-search-btn"
        onClick={next}
        disabled={!hasResults}
        title={t('chat.search.nextMatch')}
        aria-label={t('chat.search.nextMatchAria')}
      >
        <span className="codicon codicon-arrow-down" />
      </button>
      <button
        type="button"
        className="cc-search-btn"
        onClick={handleClose}
        title={t('chat.search.close')}
        aria-label={t('chat.search.closeAria')}
      >
        <span className="codicon codicon-close" />
      </button>
    </div>
  )
})
