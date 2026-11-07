/**
 * 用户消息文本的引用 chip 化（2026-09-10）：
 *
 * 用户消息以纯文本入库（@路径 / [#标题](#sess_id) / /命令 都是序列化产物），气泡直接
 * 渲染裸文本会让引用呈现为原始 markdown/路径串。本模块把文本解析成
 * 「文本段 + 只读 chip」的 React 节点序列，与输入框 chip 同视觉（无删除按钮）。
 *
 * 识别四类（与 inlineFileTags 的序列化产物一一对应）：
 *   1. markdown 会话链接 [#标题](#sess_id)（优先，防止被拆成裸 token/路径）
 *   2. 词边界的裸会话 token #sess_xxx（标题经 resolveSessionTitle 反查，查不到显示 id 前缀）
 *   3. /命令·技能引用（仅匹配 cmdNames 已知名清单——斜杠词太多，无清单判据会误伤英文/路径）
 *   4. @绝对路径（含 #L10-20 行号后缀；@ 可选——输入框末尾未转 chip 的裸路径
 *      原样发送，序列化产物里两种都有）
 *
 * 纯函数返回 ReactNode（不碰 DOM/正则共享 lastIndex）。悬浮完整内容一律走
 * data-tip 自绘气泡（message-bubble.less 定死形态）——此前用原生 title 兜底，
 * 但现环境 JBR 会把 title 渲染成 Swing tooltip：弹层位置跟鼠标走不锚定元素，
 * 直接盖住 chip 自身文字（真机 2026-11-07），title 必须去净。
 * 气泡 nowrap 无 max-width（global.less 约定调用侧截断），统一 truncateMiddle(60)。
 */

import type { ReactNode } from 'react'
import { splitReference, basename } from '@/components/FileRef'
import { truncateMiddle } from '@/components/CurrentFileChip'
import { FileIcon } from '@/components/FileIcon'
import { SESS_MD_RE, SESS_BARE_RE, sessionRefShortLabel, sessionRefTip } from '@/utils/sessionRefPattern'
import { SKILL_MD_RE, SKILL_BARE_RE, unescapeSkillMd } from '@/utils/skillRefPattern'

/** /命令·技能引用（名字字符集对齐 SlashCommand.name，如 code-review、review:code；
 *  前缀限词首，@/ 路径不会被命中）*/
const CMD_TOKEN_RE = /(^|[\s\u4e00-\u9fa5])(\/[A-Za-z][A-Za-z0-9._:-]*)/g
/** @绝对路径（判据同 inlineFileTags PATH_RE：盘符/POSIX 绝对路径，排除空白/中英标点）*/
const PATH_CORE = String.raw`[^\s@，。；、！？：""''（）()【】\[\]「」『』<>]+`
const PATH_RE = new RegExp(
  String.raw`(^|[\s\u4e00-\u9fa5])@?((?:[A-Za-z]:[\\/])${PATH_CORE}|(?:/[^\s@/]*/)${PATH_CORE})`,
  'g',
)

/** 命令/技能引用的已知信息（kind 决定 chip 变体配色，与输入框下拉/内联 chip 一致；
 *  内置命令以命令名作 kind，与 inlineFileTags.CmdChipKind 同规则）*/
export interface CmdRefInfo {
  kind: 'skill' | 'command' | 'goal' | 'compact'
  icon?: string
  /** 技能目录路径（skill 条目；chip data-tip 悬浮展示用）*/
  path?: string
}

/** 消息内 cmd chip 的 kind → 图标与配色变体（inlineFileTags CMD_META 的只读子集；
 *  未配名的内置命令如 init 兜底 terminal，与输入框口径一致）*/
const MSG_CMD_META: Record<CmdRefInfo['kind'], { icon: string; variant: string }> = {
  goal: { icon: 'codicon-target', variant: 'goal' },
  compact: { icon: 'codicon-fold', variant: 'compact' },
  command: { icon: 'codicon-terminal', variant: 'command' },
  skill: { icon: 'codicon-wand', variant: 'skill' },
}

interface RefToken {
  start: number
  end: number
  node: ReactNode
}

/** 只读文件 chip（@路径 引用，含行号后缀展示；data-tip 完整路径）*/
function fileChip(path: string, key: string): ReactNode {
  const { file, lines } = splitReference(path)
  return (
    <span key={key} className="file-ref user-ref-chip" data-tip={truncateMiddle(file.replace(/[\\/]+$/, ''), 60)}>
      <FileIcon path={file} mono className="file-ref__icon file-type-icon" />
      <span className="file-ref__name">{basename(file)}</span>
      {lines && <span className="file-ref__lines">:{lines}</span>}
    </span>
  )
}

/** 只读会话 chip（data-tip 完整标题 + id）*/
function sessionChip(sessionId: string, title: string, key: string): ReactNode {
  return (
    <span key={key} className="sess-ref user-ref-chip" data-tip={truncateMiddle(sessionRefTip(sessionId, title), 60)}>
      <span className="codicon codicon-comment-discussion sess-ref__icon" />
      <span className="sess-ref__name">{sessionRefShortLabel(sessionId, title)}</span>
    </span>
  )
}

/** 只读命令/技能 chip（显示裸名不带斜杠，对齐输入框内联 cmd chip；data-tip 留完整前缀形态）*/
function cmdChip(name: string, info: CmdRefInfo, key: string, titlePrefix = '/'): ReactNode {
  const meta = MSG_CMD_META[info.kind] ?? MSG_CMD_META.command
  const tip = `${titlePrefix}${name}${info.path ? ` · ${info.path}` : ''}`
  return (
    <span key={key} className={`cmd-ref user-ref-chip cmd-ref--${meta.variant}`} data-tip={truncateMiddle(tip, 60)}>
      <span className={`codicon ${info.icon ?? meta.icon} cmd-ref__icon`} />
      <span className="cmd-ref__name">{name}</span>
    </span>
  )
}

/**
 * 解析用户消息文本为「文本 + 只读 chip」节点序列。
 * @param cmdNames 已知的命令/技能名 → 变体信息（来自 store.slashCommands + 内置 goal）；
 *                 缺省不识别命令引用（防误判）
 * @returns null = 文本不含任何引用（调用方回退原样渲染，零差异）
 */
export function renderUserRefChips(
  text: string,
  resolveSessionTitle?: (sessionId: string) => string | undefined,
  cmdNames?: Map<string, CmdRefInfo>,
): ReactNode | null {
  const tokens: RefToken[] = []
  let chipSeq = 0

  const overlap = (start: number, end: number) =>
    tokens.some((t) => start < t.end && end > t.start)

  SESS_MD_RE.lastIndex = 0
  for (let m = SESS_MD_RE.exec(text); m; m = SESS_MD_RE.exec(text)) {
    const raw = (m[1] ?? '').replace(/\\(.)/g, '$1')
    tokens.push({ start: m.index, end: m.index + m[0].length, node: sessionChip(m[2], raw, `c${chipSeq++}`) })
  }
  // $ 技能提及 markdown 链接 [$名称](路径)（正则保证 label 以 $ 开头，与普通 md
  // 链接/会话链接天然互斥；名称/路径按序列化侧同款转义还原）
  SKILL_MD_RE.lastIndex = 0
  for (let m = SKILL_MD_RE.exec(text); m; m = SKILL_MD_RE.exec(text)) {
    const name = unescapeSkillMd(m[2] ?? '')
    const path = unescapeSkillMd(m[3] ?? '') || undefined
    tokens.push({ start: m.index, end: m.index + m[0].length, node: cmdChip(name, { kind: 'skill', path }, `c${chipSeq++}`, '$') })
  }
  SESS_BARE_RE.lastIndex = 0
  for (let m = SESS_BARE_RE.exec(text); m; m = SESS_BARE_RE.exec(text)) {
    const start = m.index + m[1].length
    const end = start + m[2].length + 1 // 组2是裸 id，+1 补被消费的 #
    if (overlap(start, end)) continue
    const title = resolveSessionTitle?.(m[2]) ?? ''
    tokens.push({ start, end, node: sessionChip(m[2], title, `c${chipSeq++}`) })
  }
  if (cmdNames) {
    CMD_TOKEN_RE.lastIndex = 0
    for (let m = CMD_TOKEN_RE.exec(text); m; m = CMD_TOKEN_RE.exec(text)) {
      // 尾部连接符不算名字一部分（"用/code-review:" 的冒号是标点）
      const name = m[2].slice(1).replace(/[._:-]+$/, '')
      const info = cmdNames.get(name)
      if (!info) continue
      const start = m.index + m[1].length
      const end = start + name.length + 1
      if (overlap(start, end)) continue
      tokens.push({ start, end, node: cmdChip(name, info, `c${chipSeq++}`) })
    }
    // 裸 $技能 token（词边界 + 已知技能名白名单——$5/成本$100 这类金额不误伤；
    // 尾部连接符处理与 CMD_TOKEN_RE 同款）
    SKILL_BARE_RE.lastIndex = 0
    for (let m = SKILL_BARE_RE.exec(text); m; m = SKILL_BARE_RE.exec(text)) {
      const name = m[2].replace(/[._:-]+$/, '')
      const info = cmdNames.get(name)
      if (!info || info.kind !== 'skill') continue
      const start = m.index + m[1].length
      const end = start + name.length + 1
      if (overlap(start, end)) continue
      tokens.push({ start, end, node: cmdChip(name, info, `c${chipSeq++}`, '$') })
    }
  }
  PATH_RE.lastIndex = 0
  for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
    const start = m.index + m[1].length
    // m[2] 不含被 @? 消耗的 @，end 必须取匹配全长，否则差一位（chip 后残留路径尾字符）
    const end = m.index + m[0].length
    if (overlap(start, end)) continue
    tokens.push({ start, end, node: fileChip(m[2], `c${chipSeq++}`) })
  }
  if (tokens.length === 0) return null

  tokens.sort((a, b) => a.start - b.start)
  const out: ReactNode[] = []
  let cursor = 0
  for (const t of tokens) {
    if (t.start < cursor) continue // 重叠防护（前缀字符段已在 token 外保留）
    if (t.start > cursor) out.push(text.slice(cursor, t.start))
    out.push(t.node)
    cursor = t.end
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}

/** 文本是否含可 chip 化的引用（切换按钮的显隐判据，与 renderUserRefChips 判据一致）。
 *  g 正则的 test 会推进 lastIndex（同源正则与主函数共享），每次重置防状态残留 */
export function hasUserRefChips(text: string, cmdNames?: Map<string, CmdRefInfo>): boolean {
  SESS_MD_RE.lastIndex = 0
  if (SESS_MD_RE.test(text)) return true
  SKILL_MD_RE.lastIndex = 0
  if (SKILL_MD_RE.test(text)) return true
  SESS_BARE_RE.lastIndex = 0
  if (SESS_BARE_RE.test(text)) return true
  if (cmdNames) {
    CMD_TOKEN_RE.lastIndex = 0
    for (let m = CMD_TOKEN_RE.exec(text); m; m = CMD_TOKEN_RE.exec(text)) {
      if (cmdNames.has(m[2].slice(1).replace(/[._:-]+$/, ''))) return true
    }
    SKILL_BARE_RE.lastIndex = 0
    for (let m = SKILL_BARE_RE.exec(text); m; m = SKILL_BARE_RE.exec(text)) {
      const info = cmdNames.get(m[2].replace(/[._:-]+$/, ''))
      if (info?.kind === 'skill') return true
    }
  }
  PATH_RE.lastIndex = 0
  return PATH_RE.test(text)
}
