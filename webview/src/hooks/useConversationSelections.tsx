/**
 * 划词引用 hook（conversation selections，官方客户端 hook yrt 的插件移植）。
 *
 * 交互（定稿方案 docs/internal/design-research/selection-quote-to-composer.md §2）：
 * - 容器 mouseup → rAF 评估（等选区落定）；selectionchange 折叠即收起；
 *   keyup 支持 Shift+方向键键盘选区（Escape 收起）；容器 scroll / 窗口 resize 收起。
 * - 评估：mouseup 瞬间一次性快照（selection.toString()），**不持久化 Range**——
 *   会话内搜索的 splitText 拆节点/流式重渲染摧毁 Range 时天然兼容（方案 §6.4-1/2）。
 * - 行归属：两端 closest('[data-selection-id]') 必须同一元素（= 官方同 row + 同
 *   selectable 的合并判定，插件行粒度 = part 单元）；交互元素黑名单（button/input/
 *   contentEditable 等）排除复制按钮/编辑器自身。
 * - 浮条：portal 到 body + fixed + translate(-50%,-100%) 浮在选区上方；
 *   onMouseDown preventDefault 保持选区（点按钮不丢选区，官方同款）。
 * - 超单条限额：警示浮条只显示限额文案无按钮（官方 _rt 同款）。
 *
 * 插件裁剪：只做「添加到当前任务」+「复制」两个按钮（side 会话线已撤出 0.3.5）；
 * 追加校验在 store（validateAddSelection 纯函数），duplicate 静默、其余错误内联提示。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { copyText } from '@/utils/clipboard'
import {
  SELECTION_LIMIT_SINGLE,
  type SelectionAddError,
  type SelectionContentType,
} from '@/utils/conversationSelections'

/** 浮条与警示态 */
interface SelectionCandidate {
  rowId: string
  contentType: SelectionContentType
  text: string
  rect: { left: number; top: number; width: number; height: number }
  /** 单条超限：只显示警示文案，无添加按钮（官方同款） */
  overLimit: boolean
}

/** 交互元素黑名单（官方 grt 四件套 + 插件的 contentEditable 输入坞） */
const BLACKLIST_SELECTOR = [
  'button',
  'input',
  'textarea',
  'select',
  "[contenteditable='']",
  '[contenteditable=true]',
  "[role='button']",
  "[role='dialog']",
  '[data-composer-dock]',
  '[data-conversation-selection-bar]',
].join(', ')

function findRow(node: Node | null): HTMLElement | null {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    // 文本节点：从父元素向上找
    const parent = (node as Node | null)?.parentElement
    if (!parent) return null
    return parent.closest<HTMLElement>('[data-selection-id]')
  }
  return (node as Element).closest<HTMLElement>('[data-selection-id]')
}

function isBlacklisted(node: Node | null): boolean {
  const el =
    node && node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement ?? null
  return !!el?.closest(BLACKLIST_SELECTOR)
}

export function useConversationSelections({
  containerRef,
  enabled,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  enabled: boolean
}) {
  const { t } = useTranslation()
  const [candidate, setCandidate] = useState<SelectionCandidate | null>(null)
  /** 追加被拒的内联提示（single/count/total；duplicate 静默不提示） */
  const [addError, setAddError] = useState<SelectionAddError | null>(null)
  const rafRef = useRef<number | null>(null)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const hide = useCallback(() => {
    setCandidate(null)
    setAddError(null)
  }, [])

  /** 选区评估：mouseup/keyup 瞬间一次性快照（官方 _rt 判定链的插件版） */
  const evaluate = useCallback(() => {
    if (!enabledRef.current) {
      setCandidate(null)
      return
    }
    const sel = window.getSelection()
    if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) {
      setCandidate(null)
      return
    }
    const range = sel.getRangeAt(0)
    const startRow = findRow(range.startContainer)
    const endRow = findRow(range.endContainer)
    // 同一行标记（两端同 selectable）：找不到/跨行 = 收起
    if (!startRow || startRow !== endRow) {
      setCandidate(null)
      return
    }
    if (isBlacklisted(range.startContainer) || isBlacklisted(range.endContainer)) {
      setCandidate(null)
      return
    }
    const contentType = startRow.getAttribute('data-selection-type') as SelectionContentType | null
    if (contentType !== 'user' && contentType !== 'assistant' && contentType !== 'reasoning' && contentType !== 'tool') {
      setCandidate(null)
      return
    }
    const rowId = startRow.getAttribute('data-selection-id') ?? ''
    const text = sel.toString().trim()
    if (!rowId || !text) {
      setCandidate(null)
      return
    }
    const rect = range.getBoundingClientRect()
    // hasLayout 判定（官方）：零尺寸矩形（如 display:none 内）不出浮条
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setCandidate(null)
      return
    }
    setCandidate({
      rowId,
      contentType,
      text,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      overLimit: text.length > SELECTION_LIMIT_SINGLE,
    })
  }, [])

  const scheduleEvaluate = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      evaluate()
    })
  }, [evaluate])

  useEffect(() => {
    // 监听面挂 document 而非容器（真机 2026-11-11 实锤）：ChatView 的 loading/
    // 空会话分支提前 return，容器 div 是之后才挂的——effect 首跑 ref.current 为
    // null 直接不挂监听，ref 后续赋值不会重跑 effect，浮条永不出现。官方同款
    // 方案：全局监听 + 评估时 containment 判定选区归属（容器 remount/ref 换绑
    // 天然免疫；scroll 不冒泡，capture 捕获容器内滚动）。
    const onMouseUp = (e: MouseEvent) => {
      // 浮条内部 mouseup（按钮点击）不重评：candidate 不变，防无谓重渲染
      if ((e.target as Element | null)?.closest?.('[data-conversation-selection-bar]')) return
      scheduleEvaluate()
    }
    const onSelectionChange = () => {
      // 选区折叠（点击空白/单击收选区）即收起浮条
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) hide()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hide()
        return
      }
      // 键盘选区（Shift+方向键）：rAF 重评估
      if (e.shiftKey) scheduleEvaluate()
    }
    const onScroll = () => hide()
    const onResize = () => hide()
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onResize)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [hide, scheduleEvaluate])

  // enabled 关闭（流式开始/容器未就绪）即收起——流式重渲染期间不评估（方案 §6.4-2）
  useEffect(() => {
    if (!enabled) hide()
  }, [enabled, hide])

  const addToTask = useCallback(() => {
    if (!candidate) return
    const error = useStore
      .getState()
      .addConversationSelection({ rowId: candidate.rowId, contentType: candidate.contentType, text: candidate.text })
    if (error && error !== 'duplicate') {
      setAddError(error)
      return
    }
    // duplicate 静默（官方：浮条不消失也不加）；成功收起浮条
    hide()
  }, [candidate, hide])

  const copySelection = useCallback(() => {
    if (candidate) void copyText(candidate.text)
  }, [candidate])

  /** 浮条（portal 到 body；JCEF 与浏览器同构，无 Java 改动） */
  const bar =
    candidate && containerRef.current ? (
      createPortal(
        <div
          className={`convsel-bar${candidate.overLimit ? ' convsel-bar--warn' : ''}`}
          data-conversation-selection-bar="1"
          style={{
            left: Math.max(12, Math.min(candidate.rect.left + candidate.rect.width / 2, window.innerWidth - 12)),
            top: Math.max(12, candidate.rect.top - 8),
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {candidate.overLimit ? (
            <span className="convsel-bar__limit">{t('chat.selections.limit.single')}</span>
          ) : (
            <>
              <button type="button" className="convsel-bar__btn convsel-bar__btn--primary" onClick={addToTask}>
                <span className="codicon codicon-quote" />
                {t('chat.selections.addToTask')}
              </button>
              <button type="button" className="convsel-bar__btn" onClick={copySelection}>
                <span className="codicon codicon-copy" />
                {t('chat.selections.copy')}
              </button>
            </>
          )}
          {addError && <span className="convsel-bar__error">{t(`chat.selections.limit.${addError}`)}</span>}
        </div>,
        document.body,
      )
    ) : null

  return bar
}
