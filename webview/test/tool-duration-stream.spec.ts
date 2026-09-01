/**
 * 工具卡实时耗时回归测试（缺陷AN：实时耗时恒 0.0 秒）
 *
 * 复现根因（2026-09-01，v4 快照行一手捕获实锤）：
 *   v4 流中工具 part 先由 tool_input_start（model.streaming）建立——无 time；
 *   随后 tool.updated kind:started 携带服务端 startedAt 到达，reducer 的
 *   "已存在"分支只更新 status/input 丢弃了它；result 收尾时 prevTime 缺失，
 *   `start ?? Date.now()` + `end: Date.now()` 双本地兜底 = 同一瞬间 → 0.0 秒。
 *   同时 result 携带的 endedAt 也被忽略 → v4 订阅快照回放已完成工具时
 *   end=Date.now() 距真实完成可能几小时（耗时虚高的另一面）。
 *
 * 断言：
 *   1. v4 完整时序（input_start → started → result 都带服务端时间戳）
 *      → time 为服务端真值 {start: startedAt, end: endedAt}
 *   2. started 缺席时 result 自带的双时间戳同样生效
 *   3. 无任何服务端时间戳（legacy 形态）→ start 兜底为 input_start 事件时刻，
 *      end 兜底为 result 到达时刻（Date.now），不再是同一瞬间的 0
 *   4. startedAt 对兜底起点具备权威覆盖语义（服务端时间戳 > 事件到达时刻）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyStreamEvent } from '@/utils/streamReducer'
import type { StreamEvent, ZCodeMessage, ToolPart } from '@/types/messages'

const SID = 'sess_dur_1'
const MID = 'msg_a_1'
const CALL = 'call_dur_1'

function mkEvent(type: string, payload: Record<string, unknown>, timestamp: number): StreamEvent {
  return { type, seq: 1, sessionId: SID, turnId: 'turn_dur', timestamp, payload } as StreamEvent
}

function baseMessages(): ZCodeMessage[] {
  return [{
    info: { role: 'assistant', id: MID, sessionID: SID, time: { created: 1 } },
    parts: [],
  }] as ZCodeMessage[]
}

/** 取（唯一的）工具 part */
function toolPart(msgs: ZCodeMessage[]): ToolPart {
  const parts = msgs[0].parts.filter((p): p is ToolPart => p.type === 'tool')
  expect(parts.length).toBe(1)
  return parts[0]
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-01T10:00:00Z'))
})

describe('工具实时耗时（缺陷AN）', () => {
  it('v4 时序：started/result 的服务端时间戳被采用（不再是 0.0 秒）', () => {
    const S = 1788226009870
    const E = 1788226013270 // 真实执行 3.4s
    let msgs = applyStreamEvent(baseMessages(), mkEvent('model.streaming', {
      kind: 'tool_input_start', toolCallId: CALL, toolName: 'Bash',
    }, S - 1200), MID).messages
    msgs = applyStreamEvent(msgs, mkEvent('tool.updated', {
      kind: 'started', toolCallId: CALL, toolName: 'Bash', startedAt: S,
    }, S), MID).messages
    msgs = applyStreamEvent(msgs, mkEvent('tool.updated', {
      kind: 'result', toolCallId: CALL, toolName: 'Bash',
      result: { success: true, content: 'ok' },
      startedAt: S, endedAt: E,
    }, E), MID).messages

    const tp = toolPart(msgs)
    expect(tp.state.status).toBe('completed')
    expect(tp.state.time).toEqual({ start: S, end: E })
    expect(tp.state.time!.end - tp.state.time!.start).toBe(3400)
  })

  it('started 缺席：result 自带 startedAt/endedAt 生效', () => {
    const S = 1788226009870
    const E = 1788226010000
    let msgs = applyStreamEvent(baseMessages(), mkEvent('model.streaming', {
      kind: 'tool_input_start', toolCallId: CALL, toolName: 'Bash',
    }, S - 800), MID).messages
    msgs = applyStreamEvent(msgs, mkEvent('tool.updated', {
      kind: 'result', toolCallId: CALL, toolName: 'Bash',
      result: { success: true, content: 'ok' },
      startedAt: S, endedAt: E,
    }, E), MID).messages

    expect(toolPart(msgs).state.time).toEqual({ start: S, end: E })
  })

  it('无服务端时间戳（legacy 形态）：input_start 事件时刻兜底起点，end 为 result 到达时刻', () => {
    const T0 = 1788226000000
    let msgs = applyStreamEvent(baseMessages(), mkEvent('model.streaming', {
      kind: 'tool_input_start', toolCallId: CALL, toolName: 'Bash',
    }, T0), MID).messages
    msgs = applyStreamEvent(msgs, mkEvent('tool.updated', {
      kind: 'started', toolCallId: CALL, toolName: 'Bash',
    }, T0 + 500), MID).messages

    vi.setSystemTime(new Date(T0 + 5200)) // 工具执行 5.2s 后 result 到达
    msgs = applyStreamEvent(msgs, mkEvent('tool.updated', {
      kind: 'result', toolCallId: CALL, toolName: 'Bash',
      result: { success: true, content: 'ok' },
    }, T0 + 5200), MID).messages

    const time = toolPart(msgs).state.time!
    expect(time.start).toBe(T0)
    expect(time.end).toBe(T0 + 5200)
    expect(time.end - time.start).toBe(5200)
  })

  it('startedAt 权威覆盖兜底起点（服务端时间戳 > 事件到达时刻）', () => {
    const T0 = 1788226000000
    const S = 1788226000987 // 服务端起点比事件到达晚 987ms
    let msgs = applyStreamEvent(baseMessages(), mkEvent('model.streaming', {
      kind: 'tool_input_start', toolCallId: CALL, toolName: 'Bash',
    }, T0), MID).messages
    msgs = applyStreamEvent(msgs, mkEvent('tool.updated', {
      kind: 'started', toolCallId: CALL, toolName: 'Bash', startedAt: S,
    }, T0 + 100), MID).messages

    expect(toolPart(msgs).state.time?.start).toBe(S)
  })

  it('tool_call 整调用新建 part 也带起点兜底', () => {
    const T0 = 1788226000000
    const msgs = applyStreamEvent(baseMessages(), mkEvent('model.streaming', {
      kind: 'tool_call', toolCallId: CALL, toolName: 'Read',
      input: { path: '/a.txt' },
    }, T0), MID).messages

    expect(toolPart(msgs).state.time?.start).toBe(T0)
  })
})
