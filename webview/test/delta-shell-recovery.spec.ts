/**
 * 流式断头自愈：delta 无壳补建（0.3.2 真机 goal 多轮断流缺陷）
 *
 * 根因（2026-09-04 真机 goal 多轮实测 + flash-probe DOM 证据 + idea.log 时序）：
 *   goal 续跑轮事件顺序 = turn.started 先于 run_started(session.updated) 到达，
 *   上一轮 run_finished 置的 verifying=true 未被清 → useStore verifying 守卫
 *   吞掉 turn.started 的建壳（防校验器零 delta 空气泡，缺陷AW）→ 后续正文
 *   delta 进 handleModelStreaming 时 streamingMessageId 为 null，旧代码注释
 *   写"创建一个临时消息"实际直接丢弃 → 整轮流式断头，轮末重拉才整段渲染。
 *
 * 断言：
 *   1. text/reasoning delta 无壳 → 就地补建流式壳，delta 落在壳上，后续累加
 *   2. 壳 id 优先协议 assistantMessageId（与落库真身同 id，对账去重），
 *      缺省回退 stream_${turnId} 命名空间
 *   3. 工具输入流（tool_input_start）无壳同样建壳，工具 part 建立其上
 *   4. 非产出型 kind 无壳 → 不建壳（校验器回合零 delta 防空气泡的语义保持）
 *   5. 壳已存在（事件重放）→ 复用不重建（幂等）
 */

import { describe, it, expect } from 'vitest'
import { applyStreamEvent } from '@/utils/streamReducer'
import type { StreamEvent, ZCodeMessage } from '@/types/messages'

const SID = 'sess_shell'

function mkEvent(type: string, payload: Record<string, unknown>, turnId = 'turn_x'): StreamEvent {
  return { type, seq: 7, sessionId: SID, turnId, timestamp: 1788300000000, payload } as StreamEvent
}

function noShell(): { messages: ZCodeMessage[]; id: string | null } {
  return { messages: [], id: null }
}

describe('delta 无壳补建流式壳（goal 多轮断流修复）', () => {
  it('text_delta 无壳：建壳 + 文本落在壳上，后续 delta 累加', () => {
    const base = noShell()
    let r = applyStreamEvent(base.messages, mkEvent('model.streaming', { kind: 'text_delta', delta: '第 2 轮', assistantMessageId: 'msg_a_real' }), null)
    expect(r.streamingMessageId).toBe('msg_a_real')
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0].info.role).toBe('assistant')
    expect(r.messages[0].info.id).toBe('msg_a_real')
    r = applyStreamEvent(r.messages, mkEvent('model.streaming', { kind: 'text_delta', delta: '开始执行', assistantMessageId: 'msg_a_real' }), r.streamingMessageId)
    const text = r.messages[0].parts.find((p) => p.type === 'text') as { text: string }
    expect(text.text).toBe('第 2 轮开始执行')
  })

  it('缺 assistantMessageId：回退 stream_${turnId} 命名空间壳', () => {
    const r = applyStreamEvent([], mkEvent('model.streaming', { kind: 'reasoning_delta', delta: '思考中' }, 'turn_9'), null)
    expect(r.streamingMessageId).toBe('stream_turn_9')
    expect(r.messages[0].info.id).toBe('stream_turn_9')
    expect(r.messages[0].parts[0].type).toBe('reasoning')
  })

  it('tool_input_start 无壳：建壳 + 工具 part 建立其上', () => {
    let r = applyStreamEvent([], mkEvent('model.streaming', { kind: 'tool_input_start', toolCallId: 'call_1', toolName: 'Read' }), null)
    expect(r.streamingMessageId).toBe('stream_turn_x')
    const tool = r.messages[0].parts.find((p) => p.type === 'tool')
    expect(tool).toBeTruthy()
    // 工具事件随后挂到同一壳上
    r = applyStreamEvent(r.messages, mkEvent('tool.updated', { kind: 'result', toolCallId: 'call_1', toolName: 'Read', result: { success: true } }), r.streamingMessageId)
    expect(r.messages).toHaveLength(1)
  })

  it('非产出型 kind 无壳：不建壳（校验器零 delta 语义保持）', () => {
    const r = applyStreamEvent([], mkEvent('model.streaming', { kind: 'heartbeat' }), null)
    expect(r.messages).toHaveLength(0)
    expect(r.streamingMessageId).toBeNull()
  })

  it('壳已存在（事件重放）：复用不重建', () => {
    const shell: ZCodeMessage = {
      info: { role: 'assistant', id: 'msg_a_real', sessionID: SID, time: { created: 1 } },
      parts: [{ type: 'text', text: '已有内容' }],
    } as ZCodeMessage
    const r = applyStreamEvent([shell], mkEvent('model.streaming', { kind: 'text_delta', delta: '续写', assistantMessageId: 'msg_a_real' }), 'msg_a_real')
    expect(r.messages).toHaveLength(1)
    const text = r.messages[0].parts.find((p) => p.type === 'text') as { text: string }
    expect(text.text).toBe('已有内容续写')
  })
})
