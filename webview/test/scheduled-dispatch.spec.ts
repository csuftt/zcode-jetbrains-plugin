/**
 * 定时消息（会话内定时发送）分派链路回归测试
 *
 * 断言链路（对齐设计第五节分派规则）：
 *   1. scheduledList → store 全量镜像
 *   2. scheduledDue 且会话空闲 → sendMessage 直发（send op 带原文本）+ ack + 本地移除
 *   3. scheduledDue 且会话流式中 → 入 queuedMessages 队尾（带 scheduledFireAt 标记）
 *      而不直接发；turn 结束 flushQueue 发出时徽标透传
 *   4. scheduledDue 但 sessionId 与当前会话不匹配 → 不受理不 ack（Java 超时降级直发）
 *   5. 切会话回退：队列中带 scheduledFireAt 的消息在 selectSession 时经
 *      scheduledRequeue 交还 Java（hold 挂起），普通排队消息仍按旧语义静默丢弃
 *   6. 发出的乐观用户消息带 scheduledFireAt（MessageBubble 徽标数据源）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import { handleResponse } from '@/store/useStore'

const SID = 'sess_sched_1'

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

function sentOps(): string[] {
  return sentRequests.map((r) => r.op as string)
}

function resetIdleWithSession(): void {
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    streaming: false,
    streamingMessageId: null,
    queuedMessages: [],
    scheduledMessages: [],
    firedHistory: [],
    lastScheduledListTs: 0,
    messages: [],
    creatingSession: false,
    pendingFirstMessage: null,
  })
}

function markStreaming(): void {
  useStore.setState({ streaming: true, streamingMessageId: 'stream_x' })
}

describe('定时消息分派链路', () => {
  beforeEach(() => {
    sentRequests.length = 0
    resetIdleWithSession()
  })

  it('scheduledList 全量镜像到 store', () => {
    handleResponse(
      {
        op: 'scheduledList',
        items: [
          { id: 's1', sessionId: SID, workspacePath: 'G:\\mock', text: 'hello', fireAt: 1000, createdAt: 0 },
          { id: 's2', sessionId: 'other', workspacePath: 'G:\\mock', text: 'world', fireAt: 2000, createdAt: 0 },
        ],
      },
      useStore.setState,
      useStore.getState,
    )
    expect(useStore.getState().scheduledMessages).toHaveLength(2)
  })

  it('到点且空闲：直发 + ack + 本地移除，乐观消息带 scheduledFireAt', () => {
    const fireAt = Date.now() - 1000
    useStore.setState({
      scheduledMessages: [
        { id: 's1', sessionId: SID, workspacePath: 'G:\\mock', text: '早安摘要', fireAt, createdAt: 0 },
      ],
    })

    handleResponse(
      { op: 'scheduledDue', id: 's1', sessionId: SID, text: '早安摘要', scheduledFireAt: fireAt },
      useStore.setState,
      useStore.getState,
    )

    // 直发（send op）+ ack
    expect(sentOps()).toContain('send')
    expect(sentOps()).toContain('scheduledDueAck')
    const sendReq = sentRequests.find((r) => r.op === 'send')!
    expect(sendReq.sessionId).toBe(SID)
    expect(sendReq.text).toBe('早安摘要')

    // 本地移除 + 乐观用户消息带徽标
    expect(useStore.getState().scheduledMessages).toHaveLength(0)
    const userMsg = useStore.getState().messages.find((m) => m.info.role === 'user')
    expect(userMsg?.info.scheduledFireAt).toBe(fireAt)
  })

  it('到点但流式中：入队尾不直发，徽标随队列透传；flushQueue 发出时同样带徽标', () => {
    markStreaming()
    const fireAt = Date.now() - 1000
    useStore.setState({
      queuedMessages: [
        { id: 'q0', text: '手动排队消息', queuedAt: 1 },
      ],
      scheduledMessages: [
        { id: 's1', sessionId: SID, workspacePath: 'G:\\mock', text: '定时任务', fireAt, createdAt: 0 },
      ],
    })

    handleResponse(
      { op: 'scheduledDue', id: 's1', sessionId: SID, text: '定时任务', scheduledFireAt: fireAt },
      useStore.setState,
      useStore.getState,
    )

    // 不直发（无 send op），入队尾且保留手动消息在前
    expect(sentOps()).not.toContain('send')
    const q = useStore.getState().queuedMessages
    expect(q.map((m) => m.text)).toEqual(['手动排队消息', '定时任务'])
    expect(q[1].scheduledFireAt).toBe(fireAt)

    // 回合结束 flushQueue：发出队头（手动消息）后队列剩定时消息；
    // 再 flush 一次发出定时消息，徽标透传到 sendMessage → 乐观消息
    expect(sentOps()).not.toContain('send')
    useStore.setState({ streaming: false })
    useStore.getState().flushQueue()
    useStore.setState({ streaming: false })
    useStore.getState().flushQueue()
    const sendReqs = sentRequests.filter((r) => r.op === 'send')
    expect(sendReqs.map((r) => r.text)).toEqual(['手动排队消息', '定时任务'])
    expect(useStore.getState().messages.find((m) => m.parts[0]?.type === 'text' && m.info.role === 'user'))
      .toBeDefined()
  })

  it('sessionId 不匹配：不受理不 ack（Java 15s 超时降级直发）', () => {
    handleResponse(
      { op: 'scheduledDue', id: 's1', sessionId: 'other_session', text: 'x', scheduledFireAt: 1 },
      useStore.setState,
      useStore.getState,
    )
    expect(sentOps()).not.toContain('send')
    expect(sentOps()).not.toContain('scheduledDueAck')
  })

  it('无会话定时到点（待命态）：走懒创建受理 + ack，定时标记穿透暂存', () => {
    useStore.setState({
      currentSessionId: null,
      creatingSession: false,
      streaming: false,
      pendingFirstMessage: null,
      pendingFirstScheduledFireAt: null,
    })

    handleResponse(
      { op: 'scheduledDue', id: 's1', sessionId: '', text: '早安摘要', scheduledFireAt: 123456 },
      useStore.setState,
      useStore.getState,
    )

    // 空 sessionId 不做会话匹配 → 受理并 ack；sendMessage 走懒创建（发 createSession）
    expect(sentOps()).toContain('scheduledDueAck')
    expect(sentOps()).not.toContain('send')
    expect(sentOps()).toContain('createSession')
    const st = useStore.getState()
    expect(st.pendingFirstMessage).toBe('早安摘要')
    expect(st.pendingFirstScheduledFireAt).toBe(123456)
  })

  it('切会话回退：定时来源的排队消息交还 Java（scheduledRequeue），普通消息静默丢弃', () => {
    useStore.setState({
      queuedMessages: [
        { id: 'q0', text: '手动排队消息', queuedAt: 1 },
        { id: 'q1', text: '定时任务', queuedAt: 2, scheduledFireAt: Date.now() + 60_000 },
      ],
      sessions: [
        { sessionId: SID, title: 'old' } as never,
        { sessionId: 'sess_new', title: 'new' } as never,
      ],
    })

    useStore.getState().selectSession({ sessionId: 'sess_new', title: 'new' } as never)

    const requeues = sentRequests.filter((r) => r.op === 'scheduledRequeue')
    expect(requeues).toHaveLength(1)
    expect(requeues[0].sessionId).toBe(SID) // 回退到旧会话
    expect(requeues[0].text).toBe('定时任务')
    // 队列整体清空（既有语义不变），本地 scheduledMessages 不受影响（等 Java 广播）
    expect(useStore.getState().queuedMessages).toHaveLength(0)
    expect(useStore.getState().currentSessionId).toBe('sess_new')
  })

  it('新会话待命态（currentSessionId=null）回退：无会话可挂，不发 scheduledRequeue', () => {
    useStore.setState({
      queuedMessages: [{ id: 'q1', text: '定时任务', queuedAt: 2, scheduledFireAt: 1 }],
    })
    useStore.getState().requeueScheduledQueuesFor(null)
    expect(sentOps()).not.toContain('scheduledRequeue')
  })

  it('广播丢失自愈：重拉 scheduledList 后权威快照收敛镜像（后台唤起卡片残留缺陷）', () => {
    const fireAt = Date.now() - 1000
    // ① 镜像收到含任务快照（用户面板卡片出现）
    handleResponse(
      {
        op: 'scheduledList',
        ts: 1000,
        items: [{ id: 's1', sessionId: SID, workspacePath: 'G:\\mock', text: '你有什么功能', fireAt, createdAt: 0 }],
        fired: [],
      },
      useStore.setState,
      useStore.getState,
    )
    expect(useStore.getState().scheduledMessages).toHaveLength(1)

    // ② remove/fired 广播在该面板静默丢失（后台唤起窗口 executeJavaScript 丢帧——
    //    Java 侧已 removed+recorded，本面板一无所知，卡片残留「待执行（即将补发）」）

    // ③ 用户切回 IDE / 打开定时列表触发重拉（focus/visibilitychange/弹窗入口）
    useStore.getState().refreshScheduledList()
    expect(sentRequests.some((r) => r.op === 'scheduledList')).toBe(true)

    // ④ Java 权威快照（items 空 + fired 含记录）到达 → 卡片消失、历史出现
    handleResponse(
      {
        op: 'scheduledList',
        ts: 2000,
        items: [],
        fired: [{ sessionId: SID, text: '你有什么功能', fireAt, firedAt: fireAt + 5000 }],
      },
      useStore.setState,
      useStore.getState,
    )
    expect(useStore.getState().scheduledMessages).toHaveLength(0)
    expect(useStore.getState().firedHistory).toHaveLength(1)
  })
})
