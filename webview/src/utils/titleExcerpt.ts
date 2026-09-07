/**
 * 会话标题重生成的输入摘录（全会话对话摘要，偏向最新内容）
 *
 * 使用场景：会话主题会随轮次漂移（开头聊 A 后面聊 B），重新生成的标题应
 * 匹配「当前」的对话主题，而不是开头第一条消息。因此摘录从最新消息往回
 * 收集带文本的对话轮次（User/AI 带标签多行），在总字符预算内尽量多拿——
 * 短会话等于全文，长会话自然以最近内容为主。
 *
 * 过滤口径复用 parseNotification 的识别器 + part 级 synthetic 标记：
 * - isHiddenSyntheticMessage：子agent/任务回调、goal-continuation 等系统注入
 * - isCompactSummaryMessage：/compact 压缩摘要（role=user 的 summary 消息）
 * - text part 级 synthetic：合成通知消息的 XML text part（消息级标记可能缺失）
 * - visibility=model-only：服务端建议 UI 不直接展示的原始内容
 * 只取 text part（工具调用/思考过程对主题归纳是噪声）。
 */

import type { ZCodeMessage } from '@/types/messages'
import { isHiddenSyntheticMessage, isCompactSummaryMessage } from '@/utils/parseNotification'

/** 最多收录的消息条数（从最新往回）*/
export const TITLE_EXCERPT_MAX_MESSAGES = 16
/** 单条消息文本截断长度 */
export const TITLE_EXCERPT_MSG_MAX = 1000
/** 摘录总字符预算（含标签前缀与换行）*/
export const TITLE_EXCERPT_TOTAL_MAX = 8000

function messageText(m: ZCodeMessage): string {
  return m.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text' && !p.synthetic)
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 提取标题生成素材：按时间顺序的多行对话摘录（"User: ..." / "AI: ..."），
 * 内容偏向最新轮次；无可用对话文本返回 null（调用方提示无法生成）。
 */
export function extractTitleExcerpt(messages: ZCodeMessage[]): string | null {
  const items: { label: string; text: string }[] = []
  for (const m of messages) {
    if (m.info.role !== 'user' && m.info.role !== 'assistant') continue
    if (m.info.role === 'user') {
      if (isHiddenSyntheticMessage(m.info)) continue
      if (isCompactSummaryMessage(m.info)) continue
    }
    if (m.info.visibility === 'model-only') continue
    const text = messageText(m)
    if (!text) continue
    items.push({ label: m.info.role === 'user' ? 'User' : 'AI', text: text.slice(0, TITLE_EXCERPT_MSG_MAX) })
  }
  if (items.length === 0) return null
  // 从最新往回收，直到条数/总预算上限（预算不足时保底收进最新一条），再还原时序——
  // 摘录越靠后越能代表当前主题（系统提示词同口径声明）
  const picked: string[] = []
  let total = 0
  for (let i = items.length - 1; i >= 0 && picked.length < TITLE_EXCERPT_MAX_MESSAGES; i--) {
    const line = `${items[i].label}: ${items[i].text}`
    if (picked.length > 0 && total + line.length + 1 > TITLE_EXCERPT_TOTAL_MAX) break
    picked.unshift(line)
    total += line.length + 1
  }
  return picked.join('\n')
}
