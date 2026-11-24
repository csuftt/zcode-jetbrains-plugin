/**
 * 工具没走到 started 就出错（入参不合 schema 被拒）时的结果归约。
 *
 * 这类调用的 v4 行上只有 input 与 error、没有 output.text；帧映射把它们放进结果事件
 * （result.error 与顶层 input）。归约要两样都落到工具 part 上——否则卡片只剩一个出错标记，
 * 错误信息和「调了什么」都看不到（知识库工具卡真机实锤：展开后只有一行时间）。
 */

import { describe, it, expect } from 'vitest'
import { applyStreamEvent } from '@/utils/streamReducer'
import type { StreamEvent, ZCodeMessage, ToolPart } from '@/types/messages'

const SID = 'sess_toolerr_1'
const MID = 'msg_toolerr_1'
const CALL = 'call_toolerr_1'
const T0 = 1788226009870

function mkEvent(type: string, payload: Record<string, unknown>, timestamp: number): StreamEvent {
  return { type, seq: 1, sessionId: SID, turnId: 'turn_toolerr', timestamp, payload } as StreamEvent
}

function baseMessages(): ZCodeMessage[] {
  return [{
    info: { role: 'assistant', id: MID, sessionID: SID, time: { created: 1 } },
    parts: [],
  }] as ZCodeMessage[]
}

function toolPart(msgs: ZCodeMessage[]): ToolPart {
  const parts = msgs[0].parts.filter((p): p is ToolPart => p.type === 'tool')
  expect(parts.length).toBe(1)
  return parts[0]
}

describe('没走到 started 就出错的工具', () => {
  it('结果事件带 error 与 input：出错状态、失败原因、参数都落到工具 part 上', () => {
    let msgs = applyStreamEvent(baseMessages(), mkEvent('model.streaming', {
      kind: 'tool_input_start', toolCallId: CALL, toolName: 'mcp__zcgui-knowledge__kb_tag',
    }, T0), MID).messages
    msgs = applyStreamEvent(msgs, mkEvent('tool.updated', {
      kind: 'result', toolCallId: CALL, toolName: 'mcp__zcgui-knowledge__kb_tag',
      result: { success: false, content: '', error: 'Tool input failed inputSchema validation' },
      input: { action: 'create' },
      startedAt: T0, endedAt: T0 + 1400,
    }, T0 + 1400), MID).messages

    const tp = toolPart(msgs)
    expect(tp.state.status).toBe('error')
    expect(tp.state.error).toEqual({ message: 'Tool input failed inputSchema validation' })
    expect(tp.state.input).toEqual({ action: 'create' })
    expect(tp.state.inputRaw).toBeUndefined()
  })

  it('结果事件不带 error：出错状态照旧，不凭空造错误文本', () => {
    let msgs = applyStreamEvent(baseMessages(), mkEvent('model.streaming', {
      kind: 'tool_input_start', toolCallId: CALL, toolName: 'Bash',
    }, T0), MID).messages
    msgs = applyStreamEvent(msgs, mkEvent('tool.updated', {
      kind: 'result', toolCallId: CALL, toolName: 'Bash',
      result: { success: false, content: 'command failed' },
    }, T0 + 100), MID).messages

    const tp = toolPart(msgs)
    expect(tp.state.status).toBe('error')
    expect(tp.state.error).toBeUndefined()
    expect(tp.state.input).toBeUndefined()
  })

  it('started 已经带来参数时，结果事件里的参数不覆盖它', () => {
    let msgs = applyStreamEvent(baseMessages(), mkEvent('tool.updated', {
      kind: 'started', toolCallId: CALL, toolName: 'Read', input: { file_path: 'a.txt' },
    }, T0), MID).messages
    msgs = applyStreamEvent(msgs, mkEvent('tool.updated', {
      kind: 'result', toolCallId: CALL, toolName: 'Read',
      result: { success: false, content: '', error: 'boom' },
      input: { file_path: 'stale.txt' },
    }, T0 + 100), MID).messages

    expect(toolPart(msgs).state.input).toEqual({ file_path: 'a.txt' })
  })
})
