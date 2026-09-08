/**
 * AskUserQuestion 工具卡答案解析
 *
 * 数据源实证（2026-09-07 diag-askuser-history.py + zcode.cjs bri()）：工具完成后
 * state.output 是服务端拼给模型的自然语言回执，用户答案嵌在 `"问题"="答案"` 对里：
 *   - 全答：  User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue...
 *   - 部分答：The user answered some questions and skipped N. Provided answers: "Q"="A". Continue...
 *   - 未答：  The user did not provide answers to these questions. Continue using your best judgment...
 * 条目还可附加 selected preview:/user notes: 注释（在 pair 之后、下一 pair 之前）。
 * 拒绝（decline）/异常路径的 output 是其他文本，识别不出模板。
 *
 * 解析策略：不做全局正则扫 pair（preview/notes 噪音会误配），而是拿 input.questions
 * 的已知问题文本做字面量锚点 `"Q"="` 定位，读到下一个 `"` 即答案——问题文本来自
 * 结构化 input，比解析结果更可信。
 */

import type { AskUserQuestion, AskUserOption } from '@/types/messages'

/** output 三种已知模板的特征串（zcode.cjs bri() 原文）*/
const MARK_ALL = 'User has answered your questions:'
const MARK_PARTIAL = 'answered some questions and skipped'
const MARK_NONE = 'did not provide answers'

export interface AskUserAnswerParse {
  /** 问题文本 → 原始答案串（多选为服务端 join 后的串）*/
  answers: Record<string, string>
  /** output 命中已知模板（false = 拒绝/异常文本，UI 回退展示原文回执）*/
  recognized: boolean
}

/**
 * 从工具 output 提取各问题的答案。output 为空返回 null；文本无法识别时
 * 返回 { answers: {}, recognized: false }（答案对仍按锚点尽力提取）。
 */
export function parseAskUserAnswers(
  output: string | undefined,
  questions: Pick<AskUserQuestion, 'question'>[],
): AskUserAnswerParse | null {
  if (!output) return null
  const answers: Record<string, string> = {}
  for (const q of questions) {
    const anchor = `"${q.question}"="`
    const start = output.indexOf(anchor)
    if (start < 0) continue
    const valueStart = start + anchor.length
    const end = output.indexOf('"', valueStart)
    // 答案本身含引号会提前截断——服务端未转义，best-effort
    if (end > valueStart || end === valueStart) {
      answers[q.question] = output.slice(valueStart, end)
    }
  }
  const recognized = output.includes(MARK_ALL) || output.includes(MARK_PARTIAL) || output.includes(MARK_NONE)
  return { answers, recognized }
}

/**
 * 答案串 → 选中选项匹配。单选精确匹配 label；多选为服务端拼接串，
 * 按逗号（中英）切分逐段匹配。匹配不上的剩余文本 = 用户自定义答案（「其他」）。
 */
export function matchAnswerToOptions(
  answer: string,
  options: AskUserOption[],
): { matched: string[]; extra: string | null } {
  const labels = options.map((o) => o.label)
  if (labels.includes(answer)) return { matched: [answer], extra: null }
  const parts = answer.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const matched = parts.filter((p) => labels.includes(p))
  const unmatched = parts.filter((p) => !labels.includes(p))
  return { matched, extra: unmatched.length ? unmatched.join(', ') : null }
}

/** 从工具 input 提取 questions（形态不对返回空数组，不抛错）*/
export function extractAskQuestions(input: Record<string, unknown> | undefined): AskUserQuestion[] {
  const qs = input?.questions
  if (!Array.isArray(qs)) return []
  return qs.filter(
    (q): q is AskUserQuestion => !!q && typeof q === 'object' && typeof (q as AskUserQuestion).question === 'string',
  )
}
