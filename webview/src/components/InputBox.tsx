/**
 * 输入区（cc-gui ChatInputBox 风格）
 *
 * - contenteditable div，多行，自动高度（4 行 ~ 240px）
 * - IME 安全的 Enter 发送（useKeyboard hook）
 * - 对话进行中仍可输入：Enter 入队（store sendMessage 分流），回合结束自动发送
 * - @文件引用（FileRef chip + 补全下拉）
 * - /斜杠命令技能选择（行首 / 触发，磁盘扫描 skill/command）
 * - 输入历史导航（useInputHistory：空输入 ArrowUp 回溯、ArrowDown 前进）
 * - 历史前缀幽灵补全（findHistorySuggestion：输入匹配历史前缀显示灰色后缀，Tab 采纳/Esc 关闭）
 * - 发送/停止 28×28 互斥（isStreaming ? codicon-debug-stop : codicon-send）
 * - 排队消息列表（卡片顶部，MessageQueue 组件：序号+预览+立即发送+删除）
 * - 引用 chips 区（技能+文件，对齐 cc-gui：MessageQueue 之下、ContextBar 之上，不贴输入框）
 *
 * 文件引用的两种形态（utils/inlineFileTags）：
 *   顶部 chip 栏：输入框为空时右键发送/@ 补全选择 → 引用与正文无位置关系
 *   内联 chip：输入框已有内容时右键发送插到光标后；手打/粘贴完整绝对路径
 *   （后跟空白符）自动转 chip——引用与正文有上下文关系，发送时序列化回 @路径
 *
 * / 技能选中后加到 SkillRef chip 列表（笔图标+技能名，紫色调），
 * 发送时拼回 /技能名 前缀（由 ZCode CLI 解析）。
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useKeyboard } from '@/hooks/useKeyboard'
import { useInputHistory, findHistorySuggestion } from '@/hooks/useInputHistory'
import { useStore } from '@/store/useStore'
import { FileRef } from './FileRef'
import { SkillRef } from './SkillRef'
import { ModelSelect } from './ModelSelect'
import { ThoughtLevelSelect } from './ThoughtLevelSelect'
import { ModeSelect } from './ModeSelect'
import { ContextRing } from './ContextRing'
import { MessageQueue } from './MessageQueue'
import { sendToJava, onMessage } from '@/ipc/bridge'
import type { JavaResponse, SlashCommand } from '@/types/messages'
import { insertChipAtCursor, convertCompletedPaths, serializeEditor } from '@/utils/inlineFileTags'
import { PastedTextRef, PastedTextPreview, type PastedTextItem } from './PastedTextRef'
import '../styles/input-box.less'

/** 内联 chip hover tooltip 的 DOM 节点 id（挂 document.body）*/
const INLINE_CHIP_TIP_ID = 'zcode-inline-chip-tip'

/**
 * 粘贴折叠阈值：≥10 行或 ≥500 字符的粘贴文本折叠为顶部 chip（点击预览），
 * 不进输入框正文（撑爆编辑区影响阅读）。正常短句/几行说明不受影响。
 * 量级参考 GitHub Copilot Chat 的 Pasted 折叠行为。
 */
const PASTE_COLLAPSE_LINES = 10
const PASTE_COLLAPSE_CHARS = 500

interface Props {
  /** 发送回调（文本 + 引用文件路径列表）*/
  onSend: (text: string, filePaths: string[]) => void
  /** 是否正在生成（显示停止按钮）*/
  isStreaming?: boolean
  /** 停止生成回调 */
  onStop?: () => void
  /** 是否禁用（无会话等）*/
  disabled?: boolean
  /** placeholder */
  placeholder?: string
  /** 当前会话模型（null 时 ModelSelect 回退消息推断）*/
  currentModel?: { modelId: string; providerId: string } | null
  /** 切换模型回调 */
  onModelSelect?: (modelId: string, providerId: string) => void
}

export function InputBox({ onSend, isStreaming = false, onStop, disabled = false, placeholder, currentModel, onModelSelect }: Props) {
  const editorRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  /** 当前 tooltip 宿主的内联 chip（删除 chip 后清理残留 tooltip 用）*/
  const tipChipRef = useRef<HTMLElement | null>(null)
  const [fileRefs, setFileRefs] = useState<string[]>([])
  const [skillRefs, setSkillRefs] = useState<string[]>([])
  /** 折叠的粘贴长文本（≥10 行或 ≥500 字符），发送时拼到正文末尾 */
  const [pastedTexts, setPastedTexts] = useState<PastedTextItem[]>([])
  /** 正在预览的粘贴文本 id（null = 弹窗关闭）*/
  const [previewPasteId, setPreviewPasteId] = useState<string | null>(null)
  const [hasText, setHasText] = useState(false)
  /** 输入框高度（拖拽调整，null = 自适应）*/
  const [inputHeight, setInputHeight] = useState<number | null>(null)

  // @ 补全状态
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)

  // / 斜杠命令补全状态
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [slashItems, setSlashItems] = useState<SlashCommand[]>([])
  const [slashIndex, setSlashIndex] = useState(0)
  /** 首次加载缓存（会话切换不重复请求磁盘）*/
  const slashCacheRef = useRef<SlashCommand[] | null>(null)

  /** 历史前缀幽灵补全后缀（cc-gui data-completion-suffix 同款，Tab 采纳）*/
  const [ghostSuffix, setGhostSuffix] = useState('')

  const { handleKeyDown, handleCompositionEnd } = useKeyboard({
    onSend: doSend,
    // streaming 中不禁用：Enter 走 sendMessage 入队（回合结束自动发送）
    disabled,
  })

  // ============ 输入历史导航（cc-gui useInputHistory）============
  const getText = useCallback(() => editorRef.current?.innerText ?? '', [])

  /** 历史回填：innerText 赋值（\n 自动转 <br>）+ 光标移末尾 + 关闭补全 */
  const setTextFromHistory = useCallback((text: string) => {
    const el = editorRef.current
    if (!el) return
    el.innerText = text
    setHasText(!!text.trim())
    // 回填不算输入行为，直接关闭 @ / / 补全与幽灵建议（程序赋值不触发 onInput）
    setMentionQuery(null)
    setMentionFiles([])
    setSlashQuery(null)
    setGhostSuffix('')
    // 历史文本里的 @绝对路径 回显为内联 chip（includeTrailing：回填内容已完整）
    convertCompletedPaths(el, true)
    placeCursorEnd(el)
  }, [])

  const { record, resetNav, handleHistoryKeyDown } = useInputHistory({
    getTextContent: getText,
    setText: setTextFromHistory,
  })

  // 历史跨会话共享（localStorage），切会话仅重置导航位置
  const sessionId = useStore((s) => s.currentSessionId)
  useEffect(() => {
    resetNav()
    setGhostSuffix('')
  }, [sessionId, resetNav])

  // ============ 发送 ============
  function doSend() {
    // 未选模型时不发送（引导用户先选择，避免 CLI 偷偷用默认模型）
    if (!currentModel) return
    // 序列化：内联 chip → @路径（chip 与正文的位置关系保留在文本流中）
    const text = serializeEditor(editorRef.current ?? document.createElement('div')).replace(/\s+$/, '')
    if (!text.trim() && fileRefs.length === 0 && skillRefs.length === 0 && pastedTexts.length === 0) return

    // 技能引用拼到最前（/技能名），顶部文件引用次之（@路径），正文（含内联引用）最后，
    // 折叠的粘贴文本按粘贴顺序拼到正文末尾（CLI 收到完整原文）
    const parts: string[] = []
    if (skillRefs.length > 0) {
      parts.push(skillRefs.map((s) => `/${s}`).join(' '))
    }
    if (fileRefs.length > 0) {
      parts.push(fileRefs.map((f) => `@${f}`).join(' '))
    }
    if (text) parts.push(text)
    if (pastedTexts.length > 0) {
      parts.push(pastedTexts.map((p) => p.text).join('\n\n'))
    }
    const fullText = parts.join('\n')
    onSend(fullText, fileRefs)
    record(fullText)

    // 清空
    clearEditor()
    setFileRefs([])
    setSkillRefs([])
    setPastedTexts([])
    setSlashQuery(null)
  }

  function clearEditor() {
    if (editorRef.current) {
      editorRef.current.textContent = ''
      setHasText(false)
    }
    setGhostSuffix('')
  }

  /** 队列消息回填输入框（编辑）：非空时换行追加，光标移到末尾并聚焦 */
  function editQueuedToInput(text: string) {
    const el = editorRef.current
    if (!el) return
    const existing = serializeEditor(el).replace(/\s+$/, '')
    el.textContent = existing ? `${existing}\n${text}` : text
    setHasText(true)
    // 回填文本里的 @绝对路径 回显为内联 chip
    convertCompletedPaths(el, true)
    el.focus()
    // 光标移到末尾（contenteditable 聚焦后默认在开头）
    const sel = window.getSelection()
    if (sel) {
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  // ============ contenteditable 输入处理 ============
  const handleInput = useCallback((e: React.FormEvent) => {
    const el = editorRef.current
    if (!el) return
    setHasText(!!el.textContent?.trim())

    // Backspace 删除 chip 不触发 mouseout → 输入时兜底清理宿主已消失的 tooltip
    hideTipIfChipGone()

    // 输入空白符（空格/回车）= 刚结束一个词 → 把光标前已完成的完整路径转成内联 chip。
    // 打字中间不转换（路径未定型，转换会打断输入）
    const data = (e.nativeEvent as InputEvent).data
    if (data !== null && /\s/.test(data)) {
      if (convertCompletedPaths(el, false)) {
        setMentionQuery(null)
        setMentionFiles([])
      }
    }

    // 检测 / 斜杠命令（行首），命中时 @ 不触发（互斥）
    const slashOpen = checkSlashTrigger(el)
    const mentionOpen = !slashOpen && checkMentionTrigger(el)
    // 历史前缀幽灵建议（@ / / 补全打开时不显示，方向键归下拉）
    updateGhostSuggestion(el, slashOpen, mentionOpen)
  }, [])

  /**
   * 粘贴处理：
   *   超阈值（≥PASTE_COLLAPSE_LINES 行或 ≥PASTE_COLLAPSE_CHARS 字符）→ 阻止默认粘贴，
   *   折叠为顶部 chip（点击预览），避免长文本撑爆输入框；
   *   未超阈值 → 走默认粘贴，落地后扫描完整路径转内联 chip（末尾路径也算完成）
   */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text/plain')
    if (pasted) {
      const lines = pasted.split('\n').length
      if (lines >= PASTE_COLLAPSE_LINES || pasted.length >= PASTE_COLLAPSE_CHARS) {
        e.preventDefault()
        setPastedTexts((prev) => [
          ...prev,
          {
            id: `paste_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            text: pasted,
            chars: pasted.length,
          },
        ])
        return
      }
    }
    setTimeout(() => {
      const el = editorRef.current
      if (!el) return
      convertCompletedPaths(el, true)
      setHasText(!!el.textContent?.trim())
    }, 0)
  }, [])

  /** 内联 chip 的 ✕ 删除（编辑器内动态 DOM，事件委托）*/
  const handleEditorClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const closeBtn = target.closest('.file-ref__remove')
    if (!closeBtn) return
    e.preventDefault()
    e.stopPropagation()
    closeBtn.closest('.file-ref--inline')?.remove()
    // chip 被删后 mouseout 不再触发（元素已脱离 DOM），tooltip 须主动清掉
    document.getElementById(INLINE_CHIP_TIP_ID)?.remove()
    tipChipRef.current = null
    const el = editorRef.current
    setHasText(!!el?.textContent?.trim())
  }, [])

  // ============ 内联 chip hover tooltip ============
  // 编辑区 wrapper 是 overflow:auto，CSS ::after tooltip 伸出即被裁剪；
  // 改为 JS 创建 fixed 定位 tooltip 挂 document.body（脱离裁剪，同 StatusPanel popover 方案）
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const ensureTip = (): HTMLDivElement => {
      let node = document.getElementById(INLINE_CHIP_TIP_ID) as HTMLDivElement | null
      if (!node) {
        node = document.createElement('div')
        node.id = INLINE_CHIP_TIP_ID
        node.className = 'inline-chip-tip'
        document.body.appendChild(node)
      }
      return node
    }
    const showTip = (chip: HTMLElement) => {
      const tip = chip.getAttribute('data-tip')
      if (!tip) return
      const node = ensureTip()
      tipChipRef.current = chip
      node.textContent = tip
      const rect = chip.getBoundingClientRect()
      // 期望左对齐 chip；但 chip 靠行尾且路径长时右边缘会超出视口 →
      // 按实际渲染宽度回退左起点，保证整个 tooltip 留在视口内（留 8px 边距）
      const vw = window.innerWidth
      let left = Math.max(8, rect.left)
      const w = node.offsetWidth
      if (left + w > vw - 8) left = Math.max(8, vw - 8 - w)
      node.style.left = `${left}px`
      // 优先弹上方（chip 常在最后一行，下方是按钮区），顶部空间不够再弹下方
      if (rect.top - node.offsetHeight - 6 >= 8) {
        node.style.top = `${rect.top - 6}px`
        node.style.transform = 'translateY(-100%)'
      } else {
        node.style.top = `${rect.bottom + 6}px`
        node.style.transform = 'none'
      }
    }
    const hideTip = () => document.getElementById(INLINE_CHIP_TIP_ID)?.remove()
    const onOver = (e: MouseEvent) => {
      const chip = (e.target as HTMLElement)?.closest?.('.file-ref--inline') as HTMLElement | null
      if (chip) showTip(chip)
    }
    const onOut = (e: MouseEvent) => {
      const from = (e.target as HTMLElement)?.closest?.('.file-ref--inline')
      const to = (e.relatedTarget as HTMLElement)?.closest?.('.file-ref--inline')
      if (from && !to) hideTip()
    }
    el.addEventListener('mouseover', onOver)
    el.addEventListener('mouseout', onOut)
    return () => {
      el.removeEventListener('mouseover', onOver)
      el.removeEventListener('mouseout', onOut)
      hideTip()
    }
  }, [])

  /**
   * 输入时兜底清理 tooltip：Backspace 整体删除 chip 同样不触发 mouseout，
   * 若 tooltip 正在显示而其宿主 chip 已脱离 DOM，直接移除。
   */
  const hideTipIfChipGone = useCallback(() => {
    const tip = document.getElementById(INLINE_CHIP_TIP_ID)
    if (tip && tipChipRef.current && !tipChipRef.current.isConnected) {
      tip.remove()
      tipChipRef.current = null
    }
  }, [])

  // 粘贴预览弹窗打开时 Escape 关闭（焦点不在弹窗上，须 window 级监听）
  useEffect(() => {
    if (!previewPasteId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewPasteId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewPasteId])

  /** 检测光标前是否有未完成的 @xxx，触发文件补全（textBeforeCaret 跳过内联 chip）；返回是否命中 */
  function checkMentionTrigger(el: HTMLDivElement): boolean {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const beforeCursor = textBeforeCaret(el, sel.getRangeAt(0))
    const atMatch = beforeCursor.match(/@([^\s@]*)$/)
    if (atMatch) {
      const query = atMatch[1]
      setMentionQuery(query)
      requestFiles(query)
      return true
    }
    setMentionQuery(null)
    setMentionFiles([])
    return false
  }

  /**
   * 光标是否在编辑器内容末尾（幽灵建议只在末尾输入时显示，中间编辑不提示）。
   * 不能用 compareBoundaryPoints 与 selectNodeContents(el) 的末 range 比较：
   * 打字后光标在文本节点内 (text, len)，而容器末 range 是 (el, childNodes.length)，
   * DOM 边界点比较对这两个等价位置返回 -1 而非 0，导致恒判 false。
   * 改判：光标 offset 在其所在节点末尾，且该节点在 el 的 lastChild 链上（或就是 el）。
   */
  function isCaretAtEnd(el: HTMLDivElement): boolean {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const node = sel.focusNode
    if (!node || !el.contains(node)) return false
    const endOffset =
      node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').length : node.childNodes.length
    if (sel.focusOffset !== endOffset) return false
    let cur: Node | null = node
    while (cur && cur !== el) {
      const parent: Node | null = cur.parentNode
      if (!parent || parent.lastChild !== cur) return false
      cur = parent
    }
    return cur === el
  }

  /**
   * 历史前缀幽灵建议（cc-gui useInlineHistoryCompletion 简化版）：
   * 单行、≥2 字符、光标在末尾、@ / / 补全未打开时，从输入历史找前缀匹配，
   * 命中则把建议的剩余部分作为灰色后缀显示（data-completion-suffix，Tab 采纳）。
   * 内存数组 ≤200 条同步扫描，无需防抖。
   */
  function updateGhostSuggestion(el: HTMLDivElement, slashOpen: boolean, mentionOpen: boolean) {
    const text = el.innerText.replace(/\n$/, '')
    if (slashOpen || mentionOpen || text.length < 2 || text.includes('\n') || !isCaretAtEnd(el)) {
      setGhostSuffix('')
      return
    }
    const suggestion = findHistorySuggestion(text)
    // 后缀取建议文本去掉已输入前缀的剩余部分（保留用户实际输入的大小写）
    setGhostSuffix(suggestion ? suggestion.slice(text.length) : '')
  }

  /** 请求文件列表（防抖）*/
  const fileReqTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function requestFiles(query: string) {
    if (fileReqTimer.current) clearTimeout(fileReqTimer.current)
    fileReqTimer.current = setTimeout(() => {
      sendToJava({ op: 'listFiles', query })
    }, 200)
  }

  // ============ / 斜杠命令补全 ============

  /** 提取光标前的完整文本（<br> 折算为 \n；contenteditable 的 textContent 不含 <br> 换行）*/
  function textBeforeCaret(el: HTMLDivElement, range: Range): string {
    let result = ''
    let found = false
    const visit = (node: Node): void => {
      if (found) return
      if (node === range.startContainer) {
        result += (node.textContent ?? '').slice(0, range.startOffset)
        found = true
        return
      }
      if (node.nodeName === 'BR') {
        result += '\n'
        return
      }
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent ?? ''
        return
      }
      // 内联 chip 等装饰元素整体跳过（不参与补全文本）
      if ((node as HTMLElement).isContentEditable === false) return
      for (const child of Array.from(node.childNodes)) visit(child)
    }
    visit(el)
    return result
  }

  /** 检测光标前是否为行首 /xxx，命中返回 true（slash 与 @ 互斥）*/
  function checkSlashTrigger(el: HTMLDivElement): boolean {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const range = sel.getRangeAt(0)

    // 行首 /：光标前以 / 开头（前面是文本起点或换行）
    const beforeCursor = textBeforeCaret(el, range)
    const slashMatch = beforeCursor.match(/(?:^|\n)\/([^\s/]*)$/)
    if (slashMatch) {
      setSlashQuery(slashMatch[1])
      // 关闭 @ 补全（互斥）
      setMentionQuery(null)
      setMentionFiles([])
      requestCommands()
    } else {
      setSlashQuery(null)
    }
    return !!slashMatch
  }

  /** 请求斜杠命令列表（防抖 + 首次缓存）*/
  const slashReqTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function requestCommands() {
    if (slashReqTimer.current) clearTimeout(slashReqTimer.current)
    slashReqTimer.current = setTimeout(() => {
      if (slashCacheRef.current) {
        setSlashItems(slashCacheRef.current)
        setSlashIndex(0)
        return
      }
      sendToJava({ op: 'listCommands' })
    }, 150)
  }

  // 监听斜杠命令列表响应（缓存复用）
  useEffect(() => {
    const unsub = onMessage((msg: JavaResponse) => {
      if (msg.op === 'commands') {
        slashCacheRef.current = msg.commands
        setSlashItems(msg.commands)
        setSlashIndex(0)
      }
    })
    return unsub
  }, [])

  // 监听 IDE 右键菜单推送（filesToInput：文件引用 / 选中代码行号引用）
  useEffect(() => {
    const unsub = onMessage((msg: JavaResponse) => {
      if (msg.op === 'filesToInput') {
        // refs 形如 "@C:\abs\path" / "@C:\abs\path#L10-20"，存入时去掉 @ 前缀
        const clean = msg.refs.map((r) => (r.startsWith('@') ? r.slice(1) : r))
        const el = editorRef.current
        // 输入框已有内容：引用与正文有上下文关系 → 内联插到当前光标后（chip 形态），
        // 不再挂到顶部 chip 栏
        if (clean.length > 0 && el && el.textContent?.trim()) {
          insertChipAtCursor(el, clean[0])
          for (const p of clean.slice(1)) insertChipAtCursor(el, p)
          setHasText(true)
          return
        }
        // 空输入框：维持顶部 chip 栏（现状），方便继续打字
        if (clean.length > 0) {
          setFileRefs((prev) => [...prev, ...clean.filter((r) => !prev.includes(r))])
        }
        // 聚焦输入框（空 refs 时仅聚焦，对应右键无选区场景）
        if (el) {
          el.focus()
          placeCursorEnd(el)
        }
      }
    })
    return unsub
  }, [])

  /** 按输入过滤（名称/描述，大小写不敏感）*/
  const filteredSlashItems =
    slashQuery === null
      ? slashItems
      : slashItems.filter(
          (c) =>
            c.name.toLowerCase().includes(slashQuery.toLowerCase()) ||
            (c.description ?? '').toLowerCase().includes(slashQuery.toLowerCase())
        )

  /** 选中命令：把技能名加到 SkillRef chip 列表 + 清除输入框里的 /xxx 文本 */
  function selectSlash(item: SlashCommand) {
    // 先加 chip（确保 UI 更新不受 DOM 操作异常影响）
    setSkillRefs((prev) => (prev.includes(item.name) ? prev : [...prev, item.name]))
    setSlashQuery(null)

    // 再清除输入框里的 /xxx 文本（容错：失败不影响 chip）
    const el = editorRef.current
    if (el) {
      try {
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0) {
          const beforeCursor = textBeforeCaret(el, sel.getRangeAt(0))
          const m = beforeCursor.match(/(?:^|\n)\/([^\s/]*)$/)
          const queryLen = m ? m[0].length : 0
          if (queryLen > 0) {
            const tmpRange = sel.getRangeAt(0).cloneRange()
            tmpRange.collapse(true)
            sel.removeAllRanges()
            sel.addRange(tmpRange)
            for (let i = 0; i < queryLen; i++) {
              sel.modify('extend', 'backward', 'character')
            }
            sel.getRangeAt(0).deleteContents()
          }
        }
      } catch {
        // DOM Selection API 异常时降级：直接清空（单个 / 时有效）
        el.textContent = el.textContent?.replace(/\/[^\s/]*$/, '') ?? ''
      }
      setHasText(!!el.textContent?.trim())
      el.focus()
    }
  }

  // 监听文件列表响应
  useEffect(() => {
    const unsub = onMessage((msg: JavaResponse) => {
      if (msg.op === 'files' && mentionQuery !== null) {
        setMentionFiles(msg.files)
        setMentionIndex(0)
      }
    })
    return unsub
  }, [mentionQuery])

  // ============ @ 补全选择 ============
  function selectMention(file: string) {
    setFileRefs((prev) => (prev.includes(file) ? prev : [...prev, file]))
    // 从编辑器删除光标前的 @xxx 文本（Selection API 精确删除，
    // 不能 textContent 全量替换——会把已渲染的内联 chip 抹成纯文本）
    const el = editorRef.current
    if (el) {
      try {
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0) {
          const beforeCursor = textBeforeCaret(el, sel.getRangeAt(0))
          const m = beforeCursor.match(/@([^\s@]*)$/)
          if (m) {
            const tmpRange = sel.getRangeAt(0).cloneRange()
            tmpRange.collapse(true)
            sel.removeAllRanges()
            sel.addRange(tmpRange)
            for (let i = 0; i < m[0].length; i++) {
              sel.modify('extend', 'backward', 'character')
            }
            sel.getRangeAt(0).deleteContents()
          }
        }
      } catch {
        // DOM Selection API 异常时降级：正则替换（无内联 chip 时等效）
        el.textContent = el.textContent?.replace(/@([^\s@]*)$/, '') ?? ''
      }
      setHasText(!!el.textContent?.trim())
      placeCursorEnd(el)
    }
    setMentionQuery(null)
    setMentionFiles([])
  }

  function placeCursorEnd(el: HTMLDivElement) {
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  // ============ 输入框拖拽调高 ============
  // 手柄在顶部，向上拖（deltaY < 0）增大高度，向下拖减小
  const MIN_HEIGHT = 56 // 约 3 行
  const MAX_HEIGHT = 400 // 约 16 行

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault()
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const startY = e.clientY
    const startHeight = wrapper.offsetHeight

    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY // 向上为正
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + delta))
      setInputHeight(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  // ============ 补全键盘导航（@ 文件 + / 命令，互斥同时只开一个）============
  function handleEditorKeyDown(e: React.KeyboardEvent) {
    // / 斜杠命令补全打开时优先
    const slashOpen = slashQuery !== null && filteredSlashItems.length > 0
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % filteredSlashItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + filteredSlashItems.length) % filteredSlashItems.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashQuery(null)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        selectSlash(filteredSlashItems[slashIndex])
        return
      }
    }
    // @ 补全打开时，方向键/Enter/Escape 由补全处理
    if (mentionQuery !== null && mentionFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionFiles.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionFiles.length) % mentionFiles.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionQuery(null)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        selectMention(mentionFiles[mentionIndex])
        return
      }
    }
    // 历史前缀幽灵建议：Tab 采纳 / Escape 关闭（IME 合成中按键留给输入法）
    if (!e.nativeEvent.isComposing && ghostSuffix) {
      if (e.key === 'Tab') {
        e.preventDefault()
        const el = editorRef.current
        if (el) setTextFromHistory(el.innerText.replace(/\n$/, '') + ghostSuffix)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setGhostSuffix('')
        return
      }
    }
    // 历史导航（补全关闭时）：空输入 ArrowUp 回溯 / 导航中 ArrowDown 前进
    if (handleHistoryKeyDown(e)) return
    // 正常的 IME 安全发送
    handleKeyDown(e)
  }

  // streaming 中 Enter = 入队（sendMessage 内部分流），按钮仍显示停止
  const canSend =
    !disabled && !!currentModel && (hasText || fileRefs.length > 0 || skillRefs.length > 0 || pastedTexts.length > 0)

  return (
    <div className="input-area">
      {/* 拖拽调高手柄（顶部细条，向上拖增大）*/}
      <div className="input-box__resize-handle" onMouseDown={handleResizeStart} title="拖拽调整高度" />
      <div className="chat-input-box">
        {/* 排队消息（streaming 中 Enter 入队的，回合结束自动发送）*/}
        <MessageQueue onEdit={editQueuedToInput} />

        {/* 技能引用 chips（紫色调，笔图标）+ 文件引用 chips（蓝色）+ 粘贴文本（灰色）。
            对齐 cc-gui ChatInputBoxHeader：AttachmentList 在 ContextBar 之上，
            不贴输入框 */}
        {(skillRefs.length > 0 || fileRefs.length > 0 || pastedTexts.length > 0) && (
          <div className="input-box__refs">
            {skillRefs.map((s) => {
              const desc = slashCacheRef.current?.find((c) => c.name === s)?.description
              return (
                <SkillRef
                  key={s}
                  name={s}
                  description={desc}
                  onRemove={() => setSkillRefs((prev) => prev.filter((x) => x !== s))}
                />
              )
            })}
            {fileRefs.map((f) => (
              <FileRef
                key={f}
                path={f}
                onRemove={() => setFileRefs((prev) => prev.filter((x) => x !== f))}
              />
            ))}
            {pastedTexts.map((p) => (
              <PastedTextRef
                key={p.id}
                item={p}
                onPreview={() => setPreviewPasteId(p.id)}
                onRemove={() => setPastedTexts((prev) => prev.filter((x) => x.id !== p.id))}
              />
            ))}
          </div>
        )}

        {/* 上方条（cc-gui ContextBar）：附件按钮 + 上下文圆环 */}
        <div className="input-box-topbar">
          <button
            className="context-tool-btn"
            onClick={() => sendToJava({ op: 'pickFiles' })}
            disabled={disabled}
            title="添加附件（选择文件）"
          >
            <span className="codicon codicon-attach" />
          </button>
          <ContextRing />
        </div>

        <div
          ref={wrapperRef}
          className="input-editable-wrapper"
          style={inputHeight ? { height: inputHeight, maxHeight: inputHeight } : undefined}
        >
          <div
            ref={editorRef}
            className={`input-editable ${hasText ? '' : 'input-editable--empty'}`}
            contentEditable={!disabled}
            suppressContentEditableWarning
            data-placeholder={
              isStreaming
                ? '回复生成中，Enter 加入发送队列…'
                : placeholder || '@引用文件，/ 调用技能，Enter 发送'
            }
            data-completion-suffix={ghostSuffix || undefined}
            onInput={handleInput}
            onKeyDown={handleEditorKeyDown}
            onCompositionEnd={handleCompositionEnd}
            onPaste={handlePaste}
            onClick={handleEditorClick}
          />
        </div>

        <div className="button-area">
          {/* 底部左区顺序对齐 cc-gui ButtonArea：权限模式 → 模型 → 思考深度 */}
          <div className="button-area-left">
            <ModeSelect />
            {onModelSelect && (
              <ModelSelect
                currentModel={currentModel ?? null}
                onSelect={onModelSelect}
                disabled={disabled}
              />
            )}
            <ThoughtLevelSelect />
          </div>
          <div className="button-area-right">
            <div className="button-divider" />
            {isStreaming ? (
              <button
                className="submit-button stop-button"
                onClick={onStop}
                title="停止生成"
                disabled={disabled}
              >
                <span className="codicon codicon-debug-stop" />
              </button>
            ) : (
              <button
                className="submit-button"
                onClick={doSend}
                disabled={!canSend}
                title="发送 (Enter)"
              >
                <span className="codicon codicon-send" />
              </button>
            )}
          </div>
        </div>

        {/* @ 文件补全下拉 */}
        {mentionQuery !== null && mentionFiles.length > 0 && (
          <div className="input-box__mention">
            {mentionFiles.map((f, i) => (
              <div
                key={f}
                className={`input-box__mention-item ${i === mentionIndex ? 'active' : ''}`}
                onMouseEnter={() => setMentionIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault() // 不让编辑器失焦
                  selectMention(f)
                }}
              >
                <span className="codicon codicon-file input-box__mention-icon" />
                <span className="input-box__mention-path">{f}</span>
              </div>
            ))}
          </div>
        )}

        {/* / 斜杠命令补全下拉 */}
        {slashQuery !== null && filteredSlashItems.length > 0 && (
          <div className="input-box__slash">
            {filteredSlashItems.map((c, i) => (
              <div
                key={`${c.kind}:${c.name}`}
                className={`input-box__slash-item ${i === slashIndex ? 'active' : ''}`}
                onMouseEnter={() => setSlashIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault() // 不让编辑器失焦
                  selectSlash(c)
                }}
              >
                <span
                  className={`codicon ${
                    c.kind === 'skill' ? 'codicon-wand' : 'codicon-terminal'
                  } input-box__slash-icon input-box__slash-icon--${c.kind}`}
                />
                <span className="input-box__slash-main">
                  <span className="input-box__slash-name">/{c.name}</span>
                  {c.description && (
                    <span className="input-box__slash-desc">{c.description}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 粘贴文本预览弹窗（fixed 全屏遮罩，Escape/点遮罩关闭）*/}
      {previewPasteId &&
        (() => {
          const item = pastedTexts.find((p) => p.id === previewPasteId)
          return item ? (
            <PastedTextPreview item={item} onClose={() => setPreviewPasteId(null)} />
          ) : null
        })()}
    </div>
  )
}
