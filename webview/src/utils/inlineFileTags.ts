/**
 * contenteditable 输入框内的内联文件引用 chip（对齐 cc-gui useFileTags，按本项目简化）
 *
 * 输入框里的文件引用以 .file-ref--inline chip（contenteditable="false"）内联在
 * 光标位置，与正文保持上下文顺序；发送时序列化回 @path 文本（ZCode CLI 解析）。
 *
 * 三种来源都会渲染成 chip：
 *   1. IDE 右键发送文件/选中代码（filesToInput），输入框有内容时插到当前光标后
 *   2. 用户手打/粘贴完整绝对路径（盘符或 / 开头，后跟空白符视为路径结束）
 *   3. 历史回填/队列编辑回填的文本里含 @绝对路径
 *
 * React 不管理编辑器内部 DOM，chip 由本模块以纯 DOM API 生成；
 * 视觉复用顶部 chip 的 .file-ref 样式（file-ref.less）。
 */

import { getFileIcon, getFolderIcon } from '@/utils/fileIcons'
import { splitReference, basename, refTooltip } from '@/components/FileRef'

const CHIP_CLASS = 'file-ref--inline'
const CMD_CHIP_CLASS = 'cmd-ref--inline'

/** 内联命令 chip 类型：goal/compact 为内置命令专属图标，command/skill 通用 */
export type CmdChipKind = 'goal' | 'compact' | 'command' | 'skill'

/** 命令 chip 的类型 → 图标与配色 class（goal=靶子琥珀 / compact=归档橙 /
 *  command=终端绿 / skill=笔紫，与下拉条目图标配色一致；init 用户拍板用通用绿）*/
const CMD_META: Record<string, { icon: string; variant: string }> = {
  goal: { icon: 'codicon-target', variant: 'goal' },
  compact: { icon: 'codicon-archive', variant: 'compact' },
  command: { icon: 'codicon-terminal', variant: 'command' },
  skill: { icon: 'codicon-wand', variant: 'skill' },
}

/** HTML 属性/文本转义（路径拼进 innerHTML 前必须）*/
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 构造内联 chip 的 HTML（结构与顶部 FileRef 组件一致，图标用文件类型 SVG）*/
export function buildFileChipHTML(path: string): string {
  const { file, lines } = splitReference(path)
  const isDir = /[\\/]$/.test(file)
  const icon = isDir ? getFolderIcon() : getFileIcon(file)
  return (
    `<span class="file-ref ${CHIP_CLASS}" contenteditable="false" data-path="${escapeHtml(path)}" data-tip="${escapeHtml(refTooltip(path))}">` +
    `<span class="file-ref__icon file-type-icon">${icon}</span>` +
    `<span class="file-ref__name">${escapeHtml(basename(file))}</span>` +
    (lines ? `<span class="file-ref__lines">:${lines}</span>` : '') +
    `<button class="file-ref__remove" type="button" tabindex="-1">✕</button>` +
    `</span>`
  )
}

/** 编辑器里是否已有内联 chip */
export function hasInlineChips(el: HTMLElement): boolean {
  return !!el.querySelector(`.${CHIP_CLASS}`)
}

/** 收集编辑器内所有内联 chip 的路径（发送时合并引用列表用）*/
export function getInlineChipPaths(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll<HTMLSpanElement>(`.${CHIP_CLASS}`))
    .map((c) => c.getAttribute('data-path') ?? '')
    .filter(Boolean)
}

/**
 * 在当前光标位置插入内联 chip（光标不在编辑器内时追加到末尾），
 * chip 后补一个空格并把光标移到空格后，保证可继续输入。
 */
export function insertChipAtCursor(el: HTMLElement, path: string): void {
  el.focus()
  const sel = window.getSelection()
  let range: Range
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0)
    range.deleteContents()
    range.collapse(true)
  } else {
    range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
  }

  const tpl = document.createElement('template')
  tpl.innerHTML = buildFileChipHTML(path)
  const chip = tpl.content.firstElementChild as HTMLElement | null
  if (!chip) return
  range.insertNode(chip)
  const space = document.createTextNode(' ')
  chip.after(space)

  if (sel) {
    const after = document.createRange()
    after.setStartAfter(space)
    after.collapse(true)
    sel.removeAllRanges()
    sel.addRange(after)
  }
}

// ============ 内联命令 chip（斜杠命令/技能/goal，0.3.2 真机反馈：命令入输入框）============

/**
 * 构造内联命令 chip 的 HTML（/ 下拉选中后插进输入框，替代顶部附件栏 chip）。
 * 序列化（serializeEditor）回 /name 前缀文本：goal 走 doSend 正则拦截，
 * 命令/技能由服务端 CLI 解析。
 */
export function buildCommandChipHTML(name: string, kind: CmdChipKind, description?: string): string {
  const meta = CMD_META[kind] ?? CMD_META.command
  const tip = description ? `/${name} — ${description}` : `/${name}`
  return (
    `<span class="cmd-ref cmd-ref--inline cmd-ref--${meta.variant}" contenteditable="false" data-cmd="${escapeHtml(name)}" data-tip="${escapeHtml(tip)}">` +
    `<span class="codicon ${meta.icon} cmd-ref__icon"></span>` +
    `<span class="cmd-ref__name">${escapeHtml(name)}</span>` +
    `<button class="cmd-ref__remove" type="button" tabindex="-1">✕</button>` +
    `</span>`
  )
}

/** 在当前光标位置插入内联命令 chip（chip 后补空格，光标移空格后可继续输入）*/
export function insertCommandChipAtCursor(el: HTMLElement, name: string, kind: CmdChipKind, description?: string): void {
  el.focus()
  const sel = window.getSelection()
  let range: Range
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0)
    range.deleteContents()
    range.collapse(true)
  } else {
    range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
  }
  const tpl = document.createElement('template')
  tpl.innerHTML = buildCommandChipHTML(name, kind, description)
  const chip = tpl.content.firstElementChild as HTMLElement | null
  if (!chip) return
  range.insertNode(chip)
  const space = document.createTextNode(' ')
  chip.after(space)
  if (sel) {
    const after = document.createRange()
    after.setStartAfter(space)
    after.collapse(true)
    sel.removeAllRanges()
    sel.addRange(after)
  }
}

// ============ 完整路径检测与转换 ============

/**
 * "看起来是绝对文件路径"的文本模式：
 *   Windows：C:\xxx 或 C:/xxx（盘符 + 分隔符开头）
 *   POSIX：/xxx/yyy（至少一层目录，避免匹配 URL 片段）
 * 路径字符集排除空白/@ 和常见中英文标点（否则会把整句中文吸进路径）。
 */
const PATH_CORE = String.raw`[^\s@，。；、！？：""''（）()【】\[\]「」『』<>]+`
const PATH_RE = new RegExp(
  String.raw`(^|[\s\u4e00-\u9fa5])@?((?:[A-Za-z]:[\\/])${PATH_CORE}|(?:/[^\s@/]*/)${PATH_CORE})`,
  'g',
)

interface TextNodeSpan {
  node: Text
  start: number // 在全文本中的起始偏移
  len: number
}

/** 遍历编辑器，收集可编辑文本节点（跳过 chip 等 contenteditable=false 子树），返回全文本与节点映射 */
function collectEditableText(el: HTMLElement): { full: string; spans: TextNodeSpan[] } {
  let full = ''
  const spans: TextNodeSpan[] = []
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      spans.push({ node: node as Text, start: full.length, len: text.length })
      full += text
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const elm = node as HTMLElement
    if (elm.isContentEditable === false) return // chip 等装饰元素
    if (elm.tagName === 'BR') {
      full += '\n'
      return
    }
    const block = elm.tagName === 'DIV' || elm.tagName === 'P'
    if (block) full += '\n'
    elm.childNodes.forEach(visit)
  }
  el.childNodes.forEach(visit)
  return { full, spans }
}

/** 全文本偏移 → DOM Range（跨文本节点时折叠到所在节点内）*/
function offsetToRange(spans: TextNodeSpan[], start: number, end: number): Range | null {
  const find = (offset: number): { node: Text; inner: number } | null => {
    for (const s of spans) {
      if (offset >= s.start && offset <= s.start + s.len) {
        return { node: s.node, inner: offset - s.start }
      }
    }
    return null
  }
  const a = find(start)
  const b = find(end)
  if (!a || !b) return null
  const range = document.createRange()
  range.setStart(a.node, a.inner)
  range.setEnd(b.node, b.inner)
  return range
}

/**
 * 把编辑器里"已结束"的完整路径文本转成内联 chip。
 *
 * @param includeTrailing 文本末尾（后面没有空白符）的路径是否也转换：
 *   打字场景 false（用户可能还在继续输入，末尾路径未定型）；
 *   粘贴/历史回填/队列回填 true（内容已完整落地）。
 * @returns 是否发生了转换
 */
export function convertCompletedPaths(el: HTMLElement, includeTrailing = false): boolean {
  let converted = false
  // 每转换一个 chip DOM 即变化，重新扫描；上限防御异常循环
  for (let guard = 0; guard < 30; guard++) {
    const { full, spans } = collectEditableText(el)
    PATH_RE.lastIndex = 0
    let hit: { start: number; end: number; path: string; atEnd: boolean } | null = null

    let m: RegExpExecArray | null
    while ((m = PATH_RE.exec(full))) {
      const prefixLen = m[1].length
      // 删除范围含可选的 @ 前缀（chip 序列化时会补回 @，原文里的 @ 不能留下）
      const start = m.index + prefixLen
      const pathEnd = start + m[0].length - prefixLen
      const afterChar = full[pathEnd]
      if (afterChar === undefined ? !includeTrailing : !/\s/.test(afterChar)) continue
      hit = { start, end: pathEnd, path: m[2], atEnd: afterChar === undefined }
      break
    }
    if (!hit) break

    const range = offsetToRange(spans, hit.start, hit.end)
    if (!range) break
    range.deleteContents()
    const tpl = document.createElement('template')
    tpl.innerHTML = buildFileChipHTML(hit.path)
    const chip = tpl.content.firstElementChild as HTMLElement | null
    if (!chip) break
    range.insertNode(chip)
    // 路径原本以空白结束时空白已保留；落在文本末尾时补一个空格便于继续输入
    if (hit.atEnd) chip.after(document.createTextNode(' '))
    converted = true
  }
  return converted
}

/**
 * 序列化编辑器内容为纯文本（发送用）：
 * 内联文件 chip → @data-path（含 #L10-20 行号引用），内联命令 chip → /data-cmd，
 * BR/DIV → 换行。
 */
export function serializeEditor(el: HTMLElement): string {
  let out = ''
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const elm = node as HTMLElement
    if (elm.classList?.contains(CHIP_CLASS)) {
      out += `@${elm.getAttribute('data-path') ?? ''}`
      return
    }
    if (elm.classList?.contains(CMD_CHIP_CLASS)) {
      out += `/${elm.getAttribute('data-cmd') ?? ''}`
      return
    }
    if (elm.isContentEditable === false) return
    if (elm.tagName === 'BR') {
      out += '\n'
      return
    }
    if (elm.tagName === 'DIV' || elm.tagName === 'P') out += '\n'
    elm.childNodes.forEach(visit)
  }
  el.childNodes.forEach(visit)
  // 块级换行近似产生的连续空行压缩为最多 2 个换行
  return out.replace(/\n{3,}/g, '\n\n')
}
