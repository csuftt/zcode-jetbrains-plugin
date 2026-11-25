// @vitest-environment jsdom
/**
 * 工具参数流停不下来提示条测试（2026-11-25 GLM-5.3-Flash 参数流陷入循环的复盘）
 *
 * 覆盖：
 *   1. 判定（utils/toolInputStall）：inputRaw 还在累积的工具 part 才算「参数在流」；
 *      tool_call 到达后不再算；没有起点时间 / 没有流式消息 → null
 *   2. 不满 60 秒不渲染；满 60 秒渲染（文案含工具名与秒数），秒数随 tick 跳动
 *   3. 停止本轮 → store.stopStreaming（sendToJava op=stop）
 *   4. 参数流结束（tool_call 到达）/ 回合不再流式 → 提示条消失
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const sendToJavaMock = vi.fn()
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (...args: unknown[]) => sendToJavaMock(...args),
}))

import * as React from 'react'
import { useStore } from '@/store/useStore'
import { applyStreamEvent } from '@/utils/streamReducer'
import { TOOL_INPUT_STALL_MS, findStreamingToolInput } from '@/utils/toolInputStall'
import { ToolInputStallBanner } from '@/components/ToolInputStallBanner'
import type { StreamEvent, ToolPart, ZCodeMessage } from '@/types/messages'

const SID = 'sess_1'
const MID = 'msg_1'
const CALL = 'call_1'
const TOOL = 'mcp__zcgui-knowledge__kb_add'
/** 提示条里显示的是工具卡上的名字（toolDisplayName），不是原始的 mcp__ 名 */
const TOOL_LABEL = '知识库收录'
const T0 = 1795574016000

function ev(payload: Record<string, unknown>, timestamp = T0): StreamEvent {
  return { type: 'model.streaming', seq: 1, sessionId: SID, turnId: 'turn_1', timestamp, payload } as StreamEvent
}

function baseMessages(): ZCodeMessage[] {
  return [{ info: { role: 'assistant', id: MID, sessionID: SID, time: { created: 1 } }, parts: [] }] as ZCodeMessage[]
}

/** 参数流刚开始的消息：工具 part 由 tool_input_start 建立，inputRaw 在累积（归约器真实产出） */
function streamingMessages(): ZCodeMessage[] {
  let msgs = applyStreamEvent(
    baseMessages(),
    ev({ kind: 'tool_input_start', toolCallId: CALL, toolName: TOOL }),
    MID,
  ).messages
  for (let i = 0; i < 3; i++) {
    msgs = applyStreamEvent(
      msgs,
      ev({ kind: 'tool_input_delta', toolCallId: CALL, delta: '{"path":"a"}' }, T0 + i),
      MID,
    ).messages
  }
  return msgs
}

function setStateWith(messages: ZCodeMessage[], streaming = true) {
  act(() => {
    useStore.setState({
      currentSessionId: SID,
      streaming,
      streamingMessageId: streaming ? MID : null,
      messages,
    })
  })
}

function renderBanner() {
  return render(<ToolInputStallBanner onStop={useStore.getState().stopStreaming} />)
}

const banner = (container: HTMLElement) => container.querySelector('.tool-input-stall-banner')

beforeEach(() => {
  sendToJavaMock.mockClear()
  useStore.getState().init()
  useStore.setState({ connectionStatus: 'mock', currentWorkspacePath: 'G:\\mock', currentView: 'chat' })
  vi.useFakeTimers()
  // 参数流从 T0 开始；挂载时离 60 秒还差 1 秒
  vi.setSystemTime(new Date(T0 + TOOL_INPUT_STALL_MS - 1000))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('参数在流的判定', () => {
  it('inputRaw 还在累积的工具 part，带它的起点时刻', () => {
    expect(findStreamingToolInput(streamingMessages(), MID)).toEqual({ callID: CALL, tool: TOOL, startedAt: T0 })
  })

  it('tool_call 到达后参数流结束 → null', () => {
    const done = applyStreamEvent(
      streamingMessages(),
      ev({ kind: 'tool_call', toolCallId: CALL, input: { path: 'a' } }, T0 + 5),
      MID,
    ).messages
    expect(findStreamingToolInput(done, MID)).toBeNull()
  })

  it('同一消息里前面的工具已完成、后面的在流：取在流的那个', () => {
    let msgs = applyStreamEvent(
      streamingMessages(),
      ev({ kind: 'tool_call', toolCallId: CALL, input: { path: 'a' } }, T0 + 5),
      MID,
    ).messages
    msgs = applyStreamEvent(
      msgs,
      ev({ kind: 'tool_input_start', toolCallId: 'call_2', toolName: 'Write' }, T0 + 9000),
      MID,
    ).messages
    expect(findStreamingToolInput(msgs, MID)).toEqual({ callID: 'call_2', tool: 'Write', startedAt: T0 + 9000 })
  })

  it('没有流式消息 / 找不到消息 → null', () => {
    expect(findStreamingToolInput(streamingMessages(), null)).toBeNull()
    expect(findStreamingToolInput(streamingMessages(), 'msg_other')).toBeNull()
  })

  it('part 没有起点时间 → null（无从计时，宁可不提示）', () => {
    const msgs = streamingMessages()
    const part = msgs[0].parts[0] as ToolPart
    msgs[0].parts = [{ ...part, state: { ...part.state, time: undefined } }]
    expect(findStreamingToolInput(msgs, MID)).toBeNull()
  })
})

describe('提示条', () => {
  it('不满 60 秒不渲染', () => {
    setStateWith(streamingMessages())
    const { container } = renderBanner()
    expect(banner(container)).toBeNull()
  })

  it('满 60 秒渲染：文案含工具名与秒数，秒数随 tick 跳动', () => {
    setStateWith(streamingMessages())
    const { container } = renderBanner()
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(banner(container)).not.toBeNull()
    expect(screen.getByRole('note').textContent).toContain(TOOL_LABEL)
    expect(screen.getByRole('note').textContent).not.toContain(TOOL)
    expect(screen.getByRole('note').textContent).toContain('60 秒')

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByRole('note').textContent).toContain('62 秒')
  })

  it('停止本轮 → store.stopStreaming（发 stop）', () => {
    setStateWith(streamingMessages())
    renderBanner()
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(sendToJavaMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '停止本轮' }))
    expect(sendToJavaMock).toHaveBeenCalledTimes(1)
    expect(sendToJavaMock.mock.calls[0][0]).toEqual({ op: 'stop', sessionId: SID, taskIds: undefined })
  })

  it('参数流结束（tool_call 到达）→ 消失', () => {
    setStateWith(streamingMessages())
    const { container } = renderBanner()
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(banner(container)).not.toBeNull()

    setStateWith(
      applyStreamEvent(
        useStore.getState().messages,
        ev({ kind: 'tool_call', toolCallId: CALL, input: { path: 'a' } }, T0 + TOOL_INPUT_STALL_MS),
        MID,
      ).messages,
    )
    expect(banner(container)).toBeNull()
  })

  it('回合不再流式 → 消失', () => {
    setStateWith(streamingMessages())
    const { container } = renderBanner()
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(banner(container)).not.toBeNull()

    setStateWith(useStore.getState().messages, false)
    expect(banner(container)).toBeNull()
  })

  it('没有参数流的普通回合 → 不渲染', () => {
    let msgs = applyStreamEvent(
      baseMessages(),
      ev({ kind: 'tool_call', toolCallId: CALL, toolName: TOOL, input: { path: 'a' } }),
      MID,
    ).messages
    msgs = applyStreamEvent(
      msgs,
      { ...ev({}), type: 'tool.updated', payload: { kind: 'started', toolCallId: CALL, toolName: TOOL } },
      MID,
    ).messages
    setStateWith(msgs)
    const { container } = renderBanner()
    act(() => {
      vi.advanceTimersByTime(TOOL_INPUT_STALL_MS * 3)
    })
    expect(banner(container)).toBeNull()
  })

  it('真实事件通道：turn.started + 参数流经 onStreamBatch 进 store → 满 60 秒出现，tool_call 到达后消失', () => {
    act(() => {
      useStore.setState({ currentSessionId: SID })
    })
    renderBanner()
    // 走 store 的批量入口（不手摆 messages/streamingMessageId）：与线上一致由 turn.started
    // 建 assistant 壳、tool_input_start 建工具 part，起点取事件的到达时刻
    act(() => {
      streamBatchHandler!(SID, [
        { type: 'turn.started', seq: 0, sessionId: SID, turnId: 'turn_1', timestamp: T0, payload: { messageId: MID } },
        ev({ kind: 'tool_input_start', toolCallId: CALL, toolName: TOOL }),
        ev({ kind: 'tool_input_delta', toolCallId: CALL, delta: '{"path":"a"}' }, T0 + 1),
      ])
    })
    expect(useStore.getState().streaming).toBe(true)
    expect(useStore.getState().streamingMessageId).toBe(MID)
    expect(screen.queryByRole('note')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.getByRole('note').textContent).toContain(TOOL_LABEL)

    act(() => {
      streamBatchHandler!(SID, [
        ev({ kind: 'tool_call', toolCallId: CALL, input: { path: 'a' } }, T0 + TOOL_INPUT_STALL_MS),
      ])
    })
    expect(screen.queryByRole('note')).toBeNull()
  })
})
