/**
 * 划词引用（conversation selections）纯函数集——官方客户端逆向定稿方案
 * （docs/internal/design-research/selection-quote-to-composer.md 2026-09-14）。
 *
 * 协议核心：引用不是独立协议字段，发送时以 markdown 围栏块拼在消息文本**末尾**
 * （正则锚 \s*$），服务端/模型侧零感知（纯 prompt 约定）；展示侧剥块只显示块前正文，
 * 原文完整落库、完整发给模型。序列化只保留 {text} 字段——与官方客户端双向互认
 * （官方发的带块消息在插件里正确剥块展示，反之亦然）。
 *
 * 限额三件套（对齐官方 i18n chat.selections.*）：单条 8000 字、最多 8 条、总量 16000 字。
 * 判定与限额照抄官方；插件裁剪：不做辅助对话按钮（side 会话已撤出 0.3.5）。
 */

/** 引用内容类型（官方 type.* 四类；行元素按 part kind 映射） */
export type SelectionContentType = 'user' | 'assistant' | 'reasoning' | 'tool'

/** 单条划词引用（插件版；官方还有 sourceSessionId/sourceRowId，插件单 webview 单会话不需要） */
export interface ConversationSelection {
  id: string
  /** 来源行标记（DOM data-selection-id；消息 id-partIdx），脚注与去重指纹用 */
  rowId: string
  contentType: SelectionContentType
  text: string
}

/** 单条引用字符上限（官方 limit.single） */
export const SELECTION_LIMIT_SINGLE = 8_000
/** 最多引用条数（官方 limit.count） */
export const SELECTION_LIMIT_COUNT = 8
/** 引用总字符上限（官方 limit.total） */
export const SELECTION_LIMIT_TOTAL = 16_000

/** 追加校验拒绝原因（duplicate 官方为静默返回，UI 不提示） */
export type SelectionAddError = 'single' | 'count' | 'total' | 'duplicate'

/**
 * 追加校验（照抄官方 Dfe，按序）：
 * 1. text.length > 8000 → 拒（single）
 * 2. 指纹去重 [rowId, contentType, text] 已存在 → duplicate（调用方静默处理）
 * 3. 条数 ≥ 8 → 拒（count）
 * 4. 累计长度 + 新条 > 16000 → 拒（total）
 *
 * 纯函数不直接 set store：返回新数组（追加成功时）与错误码，调用方决定 state 与提示。
 */
export function validateAddSelection(
  list: ConversationSelection[],
  candidate: { rowId: string; contentType: SelectionContentType; text: string },
): { list: ConversationSelection[]; error: SelectionAddError | null } {
  const text = candidate.text
  if (text.length > SELECTION_LIMIT_SINGLE) return { list, error: 'single' }
  const fingerprint = `${candidate.rowId}\u0000${candidate.contentType}\u0000${text}`
  if (list.some((s) => `${s.rowId}\u0000${s.contentType}\u0000${s.text}` === fingerprint)) {
    return { list, error: 'duplicate' }
  }
  if (list.length >= SELECTION_LIMIT_COUNT) return { list, error: 'count' }
  const total = list.reduce((n, s) => n + s.text.length, 0) + text.length
  if (total > SELECTION_LIMIT_TOTAL) return { list, error: 'total' }
  const item: ConversationSelection = {
    id: nextSelectionId(),
    rowId: candidate.rowId,
    contentType: candidate.contentType,
    text,
  }
  return { list: [...list, item], error: null }
}

/** 引用 id（官方 nanoid；插件用 crypto.randomUUID 截短，仅 UI 键用途） */
function nextSelectionId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }
  } catch {
    /* jsdom 老版本无 randomUUID，走下面兜底 */
  }
  return `sel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 发送序列化（照抄官方 Ofe）：引用数组拼到文本尾部；块必须在整条消息**末尾**
 * （展示剥离正则锚 $），正文先包 userselect 块，其他附加块（图片引导等）都在它之前。
 */
export function appendSelectionBlock(text: string, selections: ConversationSelection[]): string {
  if (!selections.length) return text
  const block = [
    '# userselect:',
    '```userselect',
    JSON.stringify(selections.map(({ text: t }) => ({ text: t }))),
    '```',
  ].join('\n')
  return text ? `${text}\n\n${block}` : block
}

/**
 * 展示回读（照抄官方 kfe 双格式：新格式优先，兼容旧版）。
 * 匹配 → JSON.parse → 逐条校验 {text}（只收字符串 text 字段的条目）→
 * { visibleContent, references }；任何一步失败 → 整段原文展示、references=[]
 * （fail-open，不吞消息）。
 */
export function splitSelectionBlock(text: string): {
  visibleContent: string
  references: Array<{ text: string }>
} {
  // 新格式：# userselect: 围栏（官方现行）
  let m = /(?:\n\n)?# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/.exec(text)
  if (!m) {
    // 旧格式：官方旧版 zcode-conversation-selections 围栏
    m = /(?:\n\n)?# Conversation selections:\n```zcode-conversation-selections\n([\s\S]*?)\n```\s*$/.exec(
      text,
    )
  }
  if (!m) return { visibleContent: text, references: [] }
  try {
    const parsed: unknown = JSON.parse(m[1])
    if (!Array.isArray(parsed)) return { visibleContent: text, references: [] }
    const references = parsed
      .filter(
        (item): item is { text: string } =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as { text?: unknown }).text === 'string' &&
          ((item as { text: string }).text.length as number) > 0,
      )
      .map((item) => ({ text: item.text }))
    return { visibleContent: text.slice(0, m.index).trimEnd(), references }
  } catch {
    return { visibleContent: text, references: [] }
  }
}

/**
 * 行标记属性（DOM data-selection-id / data-selection-type）：
 * selectable 容器打标（MarkdownBlock 外层 / 思考块正文 / 工具卡输出区 / 用户气泡正文），
 * hook 用 closest 反查行归属。聚组渲染双路径：组卡与单卡都要打标（项目老坑）。
 */
export function selectionMark(
  rowId: string,
  contentType: SelectionContentType,
): { 'data-selection-id': string; 'data-selection-type': SelectionContentType } {
  return { 'data-selection-id': rowId, 'data-selection-type': contentType }
}
