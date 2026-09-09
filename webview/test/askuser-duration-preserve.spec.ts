/**
 * preserveAskUserDurations（询问工具卡真实时长保护）单元测试
 *
 * 数据源实证（2026-09-09 db.sqlite + diag session/messages 直连）：
 * 服务端快照 state.time 是「应答后瞬时口径」——start≈end（差 3ms），start 并非
 * 提问时刻（真实等待窗口只在 part 行 time_created→time_updated，协议不透出）。
 * 本地流式 part 的 time.start 也不可靠：完成事件 kind=result 的服务端权威
 * startedAt 会把它覆盖成应答后瞬时值（0.0 秒三轮返工的真因）。
 * 因此修复起点首选 askAskedAt（弹窗打开时刻，随应答时刻一并记录），
 * 本地流式起点仅兜底；终点取应答时刻（recordAskUserAnswered 记录）。
 *
 * 覆盖：来源1（本地 batch 真实时长不被快照回退）、来源2（askAskedAt 起点/
 * 本地起点兜底/毒化起点场景）、无来源不动、缺应答时刻不动、快照已有真实时长不动。
 */
import { describe, it, expect } from 'vitest'

import { preserveAskUserDurations } from '@/store/useStore'
import type { ToolPart, ZCodeMessage } from '@/types/messages'

const CALL = 'call_ask_1'
const ASK_AT = 1_000_000_000 // 提问时刻（本地流式起点）
const ANSWER_AT = ASK_AT + 245_443 // 应答时刻（245 秒等待）

function askPart(time: { start: number; end?: number }, tool = 'AskUserQuestion'): ToolPart {
  return {
    type: 'tool',
    callID: CALL,
    tool,
    state: { status: 'completed', time },
  }
}

function msg(...parts: ToolPart[]): ZCodeMessage[] {
  return [{ info: { role: 'assistant', time: { created: 0 } }, parts }]
}

describe('preserveAskUserDurations 询问卡真实时长保护', () => {
  it('来源1：本地 batch 真实时长（>1s）不被快照瞬时口径回退', () => {
    const local = msg(askPart({ start: ASK_AT, end: ANSWER_AT }))
    const incoming = msg(askPart({ start: ANSWER_AT - 3, end: ANSWER_AT }))
    const out = preserveAskUserDurations(incoming, local, {})
    const p = out[0]!.parts[0] as ToolPart
    expect(p.state.time).toEqual({ start: ASK_AT, end: ANSWER_AT })
  })

  it('来源2：快照瞬时口径（start≈end 应答后）+ 应答时刻 + 本地起点 → 修复时长', () => {
    // 本地流式 part：start 是真实提问时刻，end 缺/瞬时（batch 被终态守卫跳过）
    const local = msg(askPart({ start: ASK_AT }))
    // 快照：start≈end≈应答后（服务端口径，db 实测形态）
    const incoming = msg(askPart({ start: ANSWER_AT - 3, end: ANSWER_AT }))
    const out = preserveAskUserDurations(incoming, local, { [CALL]: ANSWER_AT })
    const p = out[0]!.parts[0] as ToolPart
    expect(p.state.time).toEqual({ start: ASK_AT, end: ANSWER_AT })
  })

  it('来源2 起点：askAskedAt（弹窗时刻）优先于本地流式起点——后者会被 result 分支覆盖成应答后瞬时值', () => {
    // 本地流式 part 的 start 已被覆盖成应答后口径（毒化）
    const local = msg(askPart({ start: ANSWER_AT - 3 }))
    const incoming = msg(askPart({ start: ANSWER_AT - 3, end: ANSWER_AT }))
    const out = preserveAskUserDurations(
      incoming,
      local,
      { [CALL]: ANSWER_AT },
      { [CALL]: ASK_AT }, // 弹窗打开时刻 = 真实提问起点
    )
    const p = out[0]!.parts[0] as ToolPart
    expect(p.state.time).toEqual({ start: ASK_AT, end: ANSWER_AT })
  })

  it('只有 askAskedAt 无本地 part 时同样可修复', () => {
    const incoming = msg(askPart({ start: ANSWER_AT - 3, end: ANSWER_AT }))
    const out = preserveAskUserDurations(incoming, [], { [CALL]: ANSWER_AT }, { [CALL]: ASK_AT })
    const p = out[0]!.parts[0] as ToolPart
    expect(p.state.time).toEqual({ start: ASK_AT, end: ANSWER_AT })
  })

  it('有 askAskedAt 但无应答时刻：不修复（无法确定 end）', () => {
    const local = msg(askPart({ start: ANSWER_AT - 3 }))
    const incoming = msg(askPart({ start: ANSWER_AT - 3, end: ANSWER_AT }))
    const out = preserveAskUserDurations(incoming, local, {}, { [CALL]: ASK_AT })
    const p = out[0]!.parts[0] as ToolPart
    expect(p.state.time).toEqual({ start: ANSWER_AT - 3, end: ANSWER_AT })
  })

  it('旧语义反例自证：应答时刻早于快照 start（start 是应答后口径），旧判定必失败', () => {
    const local = msg(askPart({ start: ASK_AT }))
    const incoming = msg(askPart({ start: ANSWER_AT - 3, end: ANSWER_AT }))
    const out = preserveAskUserDurations(incoming, local, { [CALL]: ANSWER_AT - 100 })
    const p = out[0]!.parts[0] as ToolPart
    // 应答晚于本地提问起点即可修复（100ms 余量不影响）
    expect(p.state.time).toEqual({ start: ASK_AT, end: ANSWER_AT - 100 })
  })

  it('无本地起点（本地无该 part）时不动：历史会话首拉维持服务端口径', () => {
    const incoming = msg(askPart({ start: ANSWER_AT - 3, end: ANSWER_AT }))
    const out = preserveAskUserDurations(incoming, [], { [CALL]: ANSWER_AT })
    const p = out[0]!.parts[0] as ToolPart
    expect(p.state.time).toEqual({ start: ANSWER_AT - 3, end: ANSWER_AT })
  })

  it('无任何来源时原样返回', () => {
    const incoming = msg(askPart({ start: ANSWER_AT - 3, end: ANSWER_AT }))
    expect(preserveAskUserDurations(incoming, [], {})).toBe(incoming)
  })

  it('非 AskUserQuestion 工具不受影响', () => {
    const local = msg(askPart({ start: ASK_AT }, 'Bash'))
    const incoming = msg(askPart({ start: ANSWER_AT - 3, end: ANSWER_AT }, 'Bash'))
    const out = preserveAskUserDurations(incoming, local, { [CALL]: ANSWER_AT })
    const p = out[0]!.parts[0] as ToolPart
    expect(p.state.time).toEqual({ start: ANSWER_AT - 3, end: ANSWER_AT })
  })
})
