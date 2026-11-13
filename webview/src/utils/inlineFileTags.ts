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
import { SESS_MD_RE, SESS_BARE_RE, sessionRefShortLabel, sessionRefTip } from '@/utils/sessionRefPattern'
import { SKILL_MD_RE, SKILL_BARE_RE, skillRefText, skillShortName, unescapeSkillMd } from '@/utils/skillRefPattern'

const CHIP_CLASS = 'file-ref--inline'
const CMD_CHIP_CLASS = 'cmd-ref--inline'

/** 内联命令 chip 类型：goal/compact 为内置命令专属图标，command/skill 通用 */
export type CmdChipKind = 'goal' | 'compact' | 'command' | 'skill'

/** 命令 chip 的类型 → 图标与配色 class（goal=靶子琥珀 / compact=归档橙 /
 *  command=终端绿 / skill=笔紫，与下拉条目图标配色一致；init 用户拍板用通用绿）*/
const CMD_META: Record<string, { icon: string; variant: string }> = {
  goal: { icon: 'codicon-target', variant: 'goal' },
  compact: { icon: 'codicon-fold', variant: 'compact' },
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

/** 编辑器里是否有任一类内联 chip（canSend/hasText 判定：chip 本身就是有效内容）*/
export function hasAnyInlineChip(el: HTMLElement): boolean {
  return !!el.querySelector(
    `.${CHIP_CLASS}, .${CMD_CHIP_CLASS}, .${SESS_CHIP_CLASS}, .${PASTE_CHIP_CLASS}`,
  )
}

// ============ 内联技能提及 chip（$ 面板选中，对齐官方 MentionPlugin 三 trigger）============
//
// 与命令 chip 同视觉同结构（cmd-ref--skill 紫色 wand），多两个属性：
//   data-skill="1"  序列化走 skillRefText（[$名称](路径) / 裸 $名称），区别于命令的 /name
//   data-path       技能目录绝对路径（Kotlin 扫描器透出；缺省=裸 token 形态）

/** 构造内联技能 chip 的 HTML（结构复用命令 chip；tip 完整路径/名称）
 *  展示走 skillShortName 短名（剥插件前缀，对齐官方客户端），data-cmd/tip 保留全名*/
export function buildSkillChipHTML(name: string, path?: string, description?: string): string {
  const tip = path ? `$${name} — ${path}` : `$${name}${description ? ` — ${description}` : ''}`
  return (
    `<span class="cmd-ref cmd-ref--inline cmd-ref--skill" contenteditable="false" data-cmd="${escapeHtml(name)}" data-skill="1"` +
    (path ? ` data-path="${escapeHtml(path)}"` : '') +
    ` data-tip="${escapeHtml(tip)}">` +
    `<span class="codicon codicon-wand cmd-ref__icon"></span>` +
    `<span class="cmd-ref__name">${escapeHtml(skillShortName(name))}</span>` +
    `<button class="cmd-ref__remove" type="button" tabindex="-1">✕</button>` +
    `</span>`
  )
}

/** 在当前光标位置插入内联技能 chip（chip 后补空格，光标移空格后可继续输入）*/
export function insertSkillChipAtCursor(el: HTMLElement, name: string, path?: string, description?: string): void {
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
  tpl.innerHTML = buildSkillChipHTML(name, path, description)
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

/**
 * convertCompletedXxx 系列的就地转换钉光标（缺陷DY 同族）：deleteContents 删除
 * 被转换文本时，恰好落在该文本边界上的光标（粘贴后光标停在粘贴文本末尾=中招
 * 形态）会被浏览器规范化到删除点，随后插入的 chip 恰在该点之后——光标被拖到
 * chip 前面。检测到光标恰在 chip 前时钉回 chip 之后：尾随空格是文本节点首字符
 * 时跳过该空格（convert 场景尾随空白可能是原文保留的混合文本节点，不能整节点
 * setStartAfter）。光标不在 chip 前（打字场景光标在路径后空白处、回填场景光标
 * 不在编辑器内）则不动，保持原语义位置。
 *
 * 导出仅为单测：jsdom 保留删空文本节点、光标规范化结果与 Chromium 不同，端到端
 * 复现不了「光标在 chip 前」形态，只能直接构造两种形态单测。
 */
export function pinCaretAfterChip(chip: Element): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const r = sel.getRangeAt(0)
  const parent = chip.parentNode
  if (!r.collapsed || !parent) return
  // 光标恰在 chip 前的两种规范化形态：父节点 offset 命中 chip 下标；或被收进
  // chip 前文本节点的末尾
  const idx = Array.prototype.indexOf.call(parent.childNodes, chip)
  const prev = chip.previousSibling
  const beforeChip =
    (r.startContainer === parent && r.startOffset === idx) ||
    (prev instanceof Text && r.startContainer === prev && r.startOffset === (prev.textContent?.length ?? -1))
  if (!beforeChip) return
  const next = chip.nextSibling
  const after = document.createRange()
  if (next instanceof Text && /^\s/.test(next.textContent ?? '')) after.setStart(next, 1)
  else after.setStartAfter(chip)
  after.collapse(true)
  sel.removeAllRanges()
  sel.addRange(after)
}

/**
 * 把编辑器里"已结束"的 $ 技能提及文本转成内联 chip（粘贴/历史回填/队列回填场景）。
 * markdown 链接形态（[$名称](路径)）任意位置可转；裸 token $名称 要求词边界且
 * 命中 skillNames 白名单（$5/成本$100 这类金额不转）。
 * @param skillResolver 裸 token 白名单反查：返回 undefined=未知名（不转），
 *                      空串=知名但无路径（转无 path chip），非空=路径
 * @returns 是否发生了转换
 */
export function convertCompletedSkillRefs(
  el: HTMLElement,
  skillResolver?: (name: string) => string | undefined,
): boolean {
  let converted = false
  for (let guard = 0; guard < 30; guard++) {
    const { full, spans } = collectEditableText(el)
    let hit: { start: number; end: number; name: string; path?: string } | null = null

    SKILL_MD_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SKILL_MD_RE.exec(full))) {
      // 组1 恒为 $ 符号（正则保证只匹配技能链接形态，普通 md 链接天然不命中）
      hit = {
        start: m.index,
        end: m.index + m[0].length,
        name: unescapeSkillMd(m[2] ?? ''),
        path: unescapeSkillMd(m[3] ?? '') || undefined,
      }
      break
    }
    if (!hit) {
      SKILL_BARE_RE.lastIndex = 0
      while ((m = SKILL_BARE_RE.exec(full))) {
        const name = m[2]
        const resolved = skillResolver?.(name)
        if (resolved === undefined) continue // 白名单外不转（未知名保留原文）
        const start = m.index + m[1].length
        hit = { start, end: start + name.length + 1, name, path: resolved || undefined }
        break
      }
    }
    if (!hit) break

    const range = offsetToRange(spans, hit.start, hit.end)
    if (!range) break
    range.deleteContents()
    const tpl = document.createElement('template')
    tpl.innerHTML = buildSkillChipHTML(hit.name, hit.path)
    const chip = tpl.content.firstElementChild as HTMLElement | null
    if (!chip) break
    range.insertNode(chip)
    chip.after(document.createTextNode(' '))
    pinCaretAfterChip(chip)
    converted = true
  }
  return converted
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
 * 技能条目展示短名（剥插件前缀，对齐官方客户端）；命令的冒号是嵌套目录名
 * （review:code），剥了丢语义，保持全名。data-cmd/tip 一律全名。
 */
export function buildCommandChipHTML(name: string, kind: CmdChipKind, description?: string): string {
  const meta = CMD_META[kind] ?? CMD_META.command
  const tip = description ? `/${name} — ${description}` : `/${name}`
  const displayName = kind === 'skill' ? skillShortName(name) : name
  return (
    `<span class="cmd-ref cmd-ref--inline cmd-ref--${meta.variant}" contenteditable="false" data-cmd="${escapeHtml(name)}" data-tip="${escapeHtml(tip)}">` +
    `<span class="codicon ${meta.icon} cmd-ref__icon"></span>` +
    `<span class="cmd-ref__name">${escapeHtml(displayName)}</span>` +
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

// ============ 内联会话引用 chip（#会话引用，2026-09-10 协议定案）============
//
// 协议形态（桌面端 renderer asar + 真机探针实证）：引用以 markdown 链接随正文
// 纯文本发送 `[#标题](#sess_<id>)`，模型看到后自主调用内置工具 ReadSessionContext
// 拉取目标会话上下文（只读免审批）。标题为空时退化为裸 token `#sess_<id>`。

const SESS_CHIP_CLASS = 'sess-ref--inline'

/** 标题进 markdown 链接的转义（桌面端 ky 同款：`\` `[` `]`）*/
export function escapeSessionTitle(title: string): string {
  return title.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

/** 上述转义的逆操作（回显解析 markdown 链接标题用）*/
function unescapeSessionTitle(title: string): string {
  return title.replace(/\\(.)/g, '$1')
}

/** 会话 id 形态（服务端 ReadSessionContext input schema 同款正则）*/
export const SESSION_ID_RE = /^sess_[A-Za-z0-9._-]+$/

/** 会话引用的发送文本：markdown 链接（空标题退化裸 token）*/
export function sessionRefText(sessionId: string, title: string): string {
  const t = title.trim()
  return !t ? `#${sessionId}` : `[#${escapeSessionTitle(t)}](#${sessionId})`
}

/** 构造内联会话 chip 的 HTML（图标 + 标题，结构与命令 chip 一致）*/
export function buildSessionChipHTML(sessionId: string, title: string): string {
  const t = title.trim()
  // 裸 token 无标题：显示 id 前缀（sess_ 后 8 位 + …），tooltip 给完整 id
  const label = sessionRefShortLabel(sessionId, t)
  const tip = sessionRefTip(sessionId, t)
  return (
    `<span class="sess-ref ${SESS_CHIP_CLASS}" contenteditable="false" data-sess="${escapeHtml(sessionId)}" data-title="${escapeHtml(t)}" data-tip="${escapeHtml(tip)}">` +
    `<span class="codicon codicon-comment-discussion sess-ref__icon"></span>` +
    `<span class="sess-ref__name">${escapeHtml(label)}</span>` +
    `<button class="sess-ref__remove" type="button" tabindex="-1">✕</button>` +
    `</span>`
  )
}

/** 在当前光标位置插入内联会话 chip（chip 后补空格，光标移空格后可继续输入）*/
export function insertSessionChipAtCursor(el: HTMLElement, sessionId: string, title: string): void {
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
  tpl.innerHTML = buildSessionChipHTML(sessionId, title)
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

/** 编辑器内文本中的会话引用两种形态（markdown 链接优先，避免链接被拆成裸 token）。
 *  链接标题允许 `\x` 转义序列（sessionRefText 会转义 [ ] \，`[^\]]*` 会在 `\]` 处截断）。
 *  正则定义收口在 utils/sessionRefPattern（与消息 chip 渲染共享同一来源）*/

/**
 * # 会话引用补全触发判定：光标前文本命中"未完成的 #query"时返回 query，否则 null。
 * 防误判三条（缺陷BJ）：
 *   1. `##`（markdown 标题，# 前还是 #）不触发；
 *   2. query 是行号模式（L10 / L10-20，文件 chip 后补行号引用的既有输入习惯）不触发；
 *   3. # 前紧跟 ASCII 词字符或 URL 标点（. : / -）不触发——URL 锚点
 *      （https://host/path#frag）和 issue#123 这类粘连纯文本不该弹会话列表；
 *      空白/起始/中文/括号等边界后仍正常触发（与 SESS_BARE_RE 的词边界语义对齐）。
 */
export function matchSessionRefTrigger(beforeCursor: string): string | null {
  const m = beforeCursor.match(/([^#]|^)#([^\s#]*)$/)
  if (!m) return null
  if (/^L\d*(-\d*)?$/.test(m[2])) return null
  if (m[1] && /[\w.:/-]/.test(m[1])) return null
  return m[2]
}

/**
 * 把编辑器里"已结束"的会话引用文本转成内联 chip（粘贴/历史回填/队列回填场景；
 * 打字中间不转换——用户几乎不会手打 36 位 id，此函数只服务内容已完整落地的回显）。
 * markdown 链接形态可出现在任意位置；裸 token 要求词边界（空白/行首/中文边界）。
 * @param titleResolver 裸 token 无标题时反查会话标题（store sessions 映射）
 * @returns 是否发生了转换
 */
export function convertCompletedSessionRefs(
  el: HTMLElement,
  titleResolver?: (sessionId: string) => string | undefined,
): boolean {
  let converted = false
  for (let guard = 0; guard < 30; guard++) {
    const { full, spans } = collectEditableText(el)
    let hit: { start: number; end: number; sessionId: string; title: string } | null = null

    SESS_MD_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SESS_MD_RE.exec(full))) {
      hit = {
        start: m.index,
        end: m.index + m[0].length,
        sessionId: m[2],
        title: unescapeSessionTitle(m[1] ?? ''),
      }
      break
    }
    if (!hit) {
      SESS_BARE_RE.lastIndex = 0
      while ((m = SESS_BARE_RE.exec(full))) {
        const start = m.index + m[1].length
        hit = {
          start,
          end: start + m[2].length + 1,
          sessionId: m[2],
          title: titleResolver?.(m[2]) ?? '',
        }
        break
      }
    }
    if (!hit) break

    const range = offsetToRange(spans, hit.start, hit.end)
    if (!range) break
    range.deleteContents()
    const tpl = document.createElement('template')
    tpl.innerHTML = buildSessionChipHTML(hit.sessionId, hit.title)
    const chip = tpl.content.firstElementChild as HTMLElement | null
    if (!chip) break
    range.insertNode(chip)
    chip.after(document.createTextNode(' '))
    pinCaretAfterChip(chip)
    converted = true
  }
  return converted
}

// ============ 内联粘贴文本 chip（超阈值粘贴跟随光标，issue #22②）============
//
// 与文件/命令/会话 chip「属性携带内容」不同，粘贴原文可能很大（≥500 字符甚至
// 数 MB 日志），不进 DOM 属性：chip 只带 data-paste-id，原文存调用方的 id→原文
// 映射（InputBox 的 Map ref），序列化时经 pasteText resolver 按位展开。
// 插入走 execCommand('insertHTML')（进 undo 栈，误粘贴 Ctrl+Z 可整体撤销）。

const PASTE_CHIP_CLASS = 'paste-ref--inline'

/** 构造内联粘贴文本 chip 的 HTML（label/tip 由调用方 i18n 后传入；✕ 复用顶部 chip 同类名）*/
export function buildPasteChipHTML(id: string, label: string, tip: string): string {
  return (
    `<span class="pasted-text-ref ${PASTE_CHIP_CLASS}" contenteditable="false" data-paste-id="${escapeHtml(id)}" data-tip="${escapeHtml(tip)}">` +
    `<span class="codicon codicon-note pasted-text-ref__icon"></span>` +
    `<span class="pasted-text-ref__name">${escapeHtml(label)}</span>` +
    `<button class="pasted-text-ref__remove" type="button" tabindex="-1">✕</button>` +
    `</span>`
  )
}

/**
 * 在当前光标位置插入内联粘贴 chip：前后皆补空格可继续输入，且粘贴块不与前文
 * 粘连（/goal 等命令后直粘场景 serialize 仍保留命令分隔）。优先 execCommand
 * ('insertHTML')（进 undo 栈，误粘贴可撤销）；失效时手动 range 插入兜底
 * （绕过 undo 也不丢粘贴，与 insertPlainText 兜底同哲学）。
 * @returns 是否插入了 chip（失败时调用方应回收映射条目）
 */
export function insertPasteChipAtCursor(
  el: HTMLElement,
  id: string,
  label: string,
  tip: string,
): boolean {
  // focus 前快照光标并随后恢复：Chromium focus 不动光标（恢复幂等），jsdom 会把
  // selection 收敛到元素 0 位（不恢复则 chip 插错位置）
  const sel = window.getSelection()
  const saved =
    sel && sel.rangeCount > 0 && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null
  el.focus()
  if (sel && saved) {
    sel.removeAllRanges()
    sel.addRange(saved)
  }
  // 光标前是非空白字符时 chip 前补空格（对称 chip 后的补空格）
  const lead = needsLeadingSpace(saved) ? ' ' : ''
  const chipHTML = buildPasteChipHTML(id, label, tip)
  const html = `${lead}${chipHTML} `
  // execCommand 在非 Chromium 环境/jsdom 可能不存在（调用即抛），统一按失败走手动兜底
  let inserted = false
  try {
    inserted = document.execCommand('insertHTML', false, html)
  } catch {
    inserted = false
  }
  if (inserted) {
    // execCommand 的光标落点由浏览器决定：空白编辑器下 Chromium 会把光标规范到
    // contenteditable=false 的 chip 之前（现象=接着输入的字跑到 chip 前面）。
    // 统一手动钉回尾随空格之后，与下方手动兜底路径及其他三类 chip 插入一致；
    // 也保证连续粘贴第二个 chip 时插在空格之后，serialize 后两段原文不粘连。
    const chip = el.querySelector(`[data-paste-id="${id}"]`)
    if (chip && sel) {
      const space = chip.nextSibling
      const after = document.createRange()
      if (space && space.nodeType === Node.TEXT_NODE) after.setStartAfter(space)
      else after.setStartAfter(chip)
      after.collapse(true)
      sel.removeAllRanges()
      sel.addRange(after)
    }
    return true
  }
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return false
  const range = sel.getRangeAt(0)
  range.deleteContents()
  const tpl = document.createElement('template')
  tpl.innerHTML = chipHTML
  const chip = tpl.content.firstElementChild as HTMLElement | null
  if (!chip) return false
  // 前导空格/chip/尾随空格组装成一个 fragment 一次插入：collapsed range 的
  // insertNode 恒插在 start 处，分次插入会让后插者排到先插者前面
  const frag = document.createDocumentFragment()
  if (needsLeadingSpace(range)) frag.appendChild(document.createTextNode(' '))
  frag.appendChild(chip)
  frag.appendChild(document.createTextNode(' '))
  range.insertNode(frag)
  const after = document.createRange()
  after.setStartAfter(chip)
  after.collapse(true)
  sel.removeAllRanges()
  sel.addRange(after)
  return true
}

/** range 折叠点前一个字符是否为非空白（决定 chip 前是否补空格）。
 *  折叠点可能落在文本节点内，也可能落在元素上（前一个子节点承载该字符）*/
function needsLeadingSpace(range: Range | null): boolean {
  if (!range) return false
  const { startContainer: sc, startOffset: off } = range
  if (sc.nodeType === Node.TEXT_NODE) {
    const ch = sc.textContent?.[off - 1]
    return !!ch && !/\s/.test(ch)
  }
  if (sc.nodeType === Node.ELEMENT_NODE && off > 0) {
    const prev = sc.childNodes[off - 1]
    if (prev?.nodeType === Node.TEXT_NODE) {
      const ch = prev.textContent?.slice(-1)
      return !!ch && !/\s/.test(ch)
    }
  }
  return false
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
    pinCaretAfterChip(chip)
    converted = true
  }
  return converted
}

/** serializeEditor 的可选依赖：粘贴 chip 原文不在 DOM 里，序列化时经此按 id 取回 */
export interface SerializeOptions {
  /** id → 粘贴原文；返回 undefined 时降级占位（正常不会发生，映射与编辑器同生命周期）*/
  pasteText?: (id: string) => string | undefined
}

/**
 * 序列化编辑器内容为纯文本（发送用）：
 * 内联文件 chip → @data-path（含 #L10-20 行号引用），内联命令 chip → /data-cmd，
 * 内联技能 chip（data-skill）→ [$名称](路径) / 裸 $名称（$ 技能提及协议），
 * 内联会话 chip → [#标题](#sess_id)（ReadSessionContext 引用协议），
 * 内联粘贴 chip → 原文按位展开（pasteText resolver 取回），BR/DIV → 换行。
 */
export function serializeEditor(el: HTMLElement, opts?: SerializeOptions): string {
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
      // 技能提及 chip（data-skill 标记）序列化为 [$名称](路径) / 裸 $名称（$ 面板语义，
      // 官方 mentionMarkdown 同款双形态）；普通命令 chip 序列化为 /name
      if (elm.getAttribute('data-skill') === '1') {
        out += skillRefText(
          elm.getAttribute('data-cmd') ?? '',
          elm.getAttribute('data-path') ?? undefined,
        )
        return
      }
      out += `/${elm.getAttribute('data-cmd') ?? ''}`
      return
    }
    if (elm.classList?.contains(SESS_CHIP_CLASS)) {
      out += sessionRefText(
        elm.getAttribute('data-sess') ?? '',
        elm.getAttribute('data-title') ?? '',
      )
      return
    }
    if (elm.classList?.contains(PASTE_CHIP_CLASS)) {
      const text = opts?.pasteText?.(elm.getAttribute('data-paste-id') ?? '')
      out += text ?? '[粘贴内容已丢失]'
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
