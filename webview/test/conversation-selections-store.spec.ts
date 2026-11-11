/**
 * 划词引用 store 集成回归（调研 ⑩）：
 *   - addConversationSelection 走 validateAddSelection（重复静默返回 null、限额返回原因）
 *   - remove/clear
 *   - 会话切换（selectSession）清空引用——引用挂在旧会话时间线上，带着发到新会话
 *     会让 AI 读到无从解析的上下文（sessionResetBase 清空）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

beforeEach(() => {
  vi.useRealTimers()
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: null,
    sessions: [],
    conversationSelections: [],
  })
})

describe('addConversationSelection', () => {
  it('成功追加并返回 null', () => {
    const err = useStore.getState().addConversationSelection({ rowId: 'm-0', contentType: 'assistant', text: '引用内容' })
    expect(err).toBeNull()
    const list = useStore.getState().conversationSelections
    expect(list).toHaveLength(1)
    expect(list[0].text).toBe('引用内容')
    expect(list[0].rowId).toBe('m-0')
    expect(list[0].id).toBeTruthy()
  })

  it('重复引用静默：返回 null 且不追加', () => {
    useStore.getState().addConversationSelection({ rowId: 'm-0', contentType: 'assistant', text: '同一段' })
    const err = useStore.getState().addConversationSelection({ rowId: 'm-0', contentType: 'assistant', text: '同一段' })
    expect(err).toBeNull()
    expect(useStore.getState().conversationSelections).toHaveLength(1)
  })

  it('超限返回原因（count）且不追加', () => {
    useStore.setState({
      conversationSelections: Array.from({ length: 8 }, (_, i) => ({
        id: `s${i}`, rowId: `m-${i}`, contentType: 'assistant' as const, text: `t${i}`,
      })),
    })
    const err = useStore.getState().addConversationSelection({ rowId: 'm-9', contentType: 'assistant', text: 't9' })
    expect(err).toBe('count')
    expect(useStore.getState().conversationSelections).toHaveLength(8)
  })

  it('超限返回原因（single）', () => {
    const err = useStore.getState().addConversationSelection({ rowId: 'm-0', contentType: 'assistant', text: 'a'.repeat(8001) })
    expect(err).toBe('single')
  })
})

describe('remove / clear', () => {
  it('单条移除按 id', () => {
    useStore.getState().addConversationSelection({ rowId: 'm-0', contentType: 'user', text: 'a' })
    useStore.getState().addConversationSelection({ rowId: 'm-1', contentType: 'tool', text: 'b' })
    const list = useStore.getState().conversationSelections
    useStore.getState().removeConversationSelection(list[0].id)
    const after = useStore.getState().conversationSelections
    expect(after).toHaveLength(1)
    expect(after[0].text).toBe('b')
  })

  it('clear 清空全部', () => {
    useStore.getState().addConversationSelection({ rowId: 'm-0', contentType: 'reasoning', text: 'a' })
    useStore.getState().clearConversationSelections()
    expect(useStore.getState().conversationSelections).toEqual([])
  })
})

describe('会话切换清空', () => {
  it('selectSession 后 conversationSelections 清空', () => {
    useStore.setState({ currentSessionId: 's-old' })
    useStore.getState().addConversationSelection({ rowId: 'old-0', contentType: 'assistant', text: '旧会话引用' })
    expect(useStore.getState().conversationSelections).toHaveLength(1)

    // 服务端会话行（selectSession 依赖 sessions 快照行）
    pushResponse({
      type: 'response',
      op: 'listSessions',
      requestId: 'req-sessions-1',
      success: true,
      sessions: [{ sessionId: 's-new', title: '新会话', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 2 }],
    })
    useStore.setState({ sessions: [{ sessionId: 's-new', title: '新会话', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 2 }] })
    useStore.getState().selectSession(useStore.getState().sessions[0])
    expect(useStore.getState().currentSessionId).toBe('s-new')
    expect(useStore.getState().conversationSelections).toEqual([])
  })
})
