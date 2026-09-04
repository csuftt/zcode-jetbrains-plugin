/**
 * 定时消息 /goal 拦截分派（dispatchScheduledGoalText）——2026-09-04 缺陷修复：
 * 定时文本是 /goal 命令时必须转 goalManage（session/goal RPC），走普通 send 会把
 * 命令原文发给模型、goal 引擎不触发、目标卡不出现。
 *
 * 覆盖：scheduledDue 空闲/流式、sendScheduledNow 本地受理、flushQueue 队列关口、
 * scheduledFired 上报（text=objective 才能与落库 user 消息对上徽标）。
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

import { useStore, handleResponse } from '@/store/useStore'

const SID = 'sess_goal_1'

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
    goal: null,
  })
}

describe('定时消息 /goal 拦截', () => {
  beforeEach(() => {
    sentRequests.length = 0
    resetIdleWithSession()
  })

  it('到点空闲：/goal set 转 goalManage（非 send），fired 上报 text=objective，乐观用户消息与目标卡就位', () => {
    const fireAt = Date.now() - 1000
    useStore.setState({
      scheduledMessages: [
        { id: 's1', sessionId: SID, workspacePath: 'G:\\mock', text: '/goal 修复登录页崩溃', fireAt, createdAt: 0 },
      ],
    })

    handleResponse(
      { op: 'scheduledDue', id: 's1', sessionId: SID, text: '/goal 修复登录页崩溃', scheduledFireAt: fireAt },
      useStore.setState,
      useStore.getState,
    )

    // 转 goalManage 控制意图，不走普通 send
    expect(sentOps()).not.toContain('send')
    const goalReq = sentRequests.find((r) => r.op === 'goalManage')!
    expect(goalReq.action).toBe('set')
    expect(goalReq.objective).toBe('修复登录页崩溃')
    expect(goalReq.sessionId).toBe(SID)

    // 已发历史上报：set 落库 user 消息文本=objective（服务端剥 /goal 前缀），
    // 用 objective 记录才能与历史消息对上「定时执行」徽标
    const firedReq = sentRequests.find((r) => r.op === 'scheduledFired')!
    expect(firedReq.text).toBe('修复登录页崩溃')
    expect(firedReq.fireAt).toBe(fireAt)

    // 受理闭环：ack + 本地移除；乐观目标卡 + 乐观用户消息（objective 文本）
    expect(sentOps()).toContain('scheduledDueAck')
    expect(useStore.getState().scheduledMessages).toHaveLength(0)
    expect(useStore.getState().goal?.objective).toBe('修复登录页崩溃')
    const userMsg = useStore.getState().messages.find((m) => m.info.role === 'user')
    expect(userMsg?.parts[0]).toMatchObject({ type: 'text', text: '修复登录页崩溃' })
  })

  it('到点空闲：/goal pause 等非 set 子命令同样拦截（fired 用原文本记录）', () => {
    const fireAt = Date.now() - 1000
    handleResponse(
      { op: 'scheduledDue', id: 's1', sessionId: SID, text: '/goal pause', scheduledFireAt: fireAt },
      useStore.setState,
      useStore.getState,
    )
    expect(sentOps()).not.toContain('send')
    expect(sentRequests.find((r) => r.op === 'goalManage')?.action).toBe('pause')
    expect(sentRequests.find((r) => r.op === 'scheduledFired')?.text).toBe('/goal pause')
  })

  it('到点流式中：/goal 入队暂存（服务端会拒绝运行中的 goal 操作），回合结束 flushQueue 再拦截', () => {
    useStore.setState({ streaming: true, streamingMessageId: 'stream_x' })
    const fireAt = Date.now() - 1000
    handleResponse(
      { op: 'scheduledDue', id: 's1', sessionId: SID, text: '/goal 写周报', scheduledFireAt: fireAt },
      useStore.setState,
      useStore.getState,
    )

    // 不立即 goalManage 也不 send：入队（带定时标记，切会话回退链路可用）
    expect(sentOps()).not.toContain('send')
    expect(sentOps()).not.toContain('goalManage')
    const q = useStore.getState().queuedMessages
    expect(q).toHaveLength(1)
    expect(q[0].text).toBe('/goal 写周报')
    expect(q[0].scheduledFireAt).toBe(fireAt)

    // 回合结束：flushQueue 关口拦截转 goalManage + fired 上报
    useStore.setState({ streaming: false })
    useStore.getState().flushQueue()
    expect(sentRequests.find((r) => r.op === 'goalManage')?.objective).toBe('写周报')
    expect(sentRequests.find((r) => r.op === 'scheduledFired')?.text).toBe('写周报')
    expect(sentOps()).not.toContain('send')
  })

  it('普通定时文本不受影响：照走 send（回归保护）', () => {
    const fireAt = Date.now() - 1000
    handleResponse(
      { op: 'scheduledDue', id: 's1', sessionId: SID, text: '早安摘要', scheduledFireAt: fireAt },
      useStore.setState,
      useStore.getState,
    )
    expect(sentOps()).toContain('send')
    expect(sentOps()).not.toContain('goalManage')
    expect(sentRequests.find((r) => r.op === 'send')?.text).toBe('早安摘要')
  })

  it('sendScheduledNow 本地受理：/goal 同样拦截（空闲直转；流式入队由 sendMessage 分流）', () => {
    const fireAt = Date.now() + 60_000
    useStore.setState({
      scheduledMessages: [
        { id: 's1', sessionId: SID, workspacePath: 'G:\\mock', text: '/goal 部署演练', fireAt, createdAt: 0 },
      ],
    })
    useStore.getState().sendScheduledNow('s1')

    expect(sentOps()).not.toContain('send')
    expect(sentRequests.find((r) => r.op === 'goalManage')?.objective).toBe('部署演练')
    expect(sentOps()).toContain('scheduledDueAck')
    expect(useStore.getState().scheduledMessages).toHaveLength(0)
  })

  it('sendQueuedNow（排队消息立即发送）：/goal 队列关口拦截', () => {
    useStore.setState({
      queuedMessages: [
        { id: 'q1', text: '/goal 排队目标', queuedAt: 1, scheduledFireAt: 123456 },
      ],
    })
    useStore.getState().sendQueuedNow('q1')

    expect(sentOps()).not.toContain('send')
    expect(sentRequests.find((r) => r.op === 'goalManage')?.objective).toBe('排队目标')
    expect(useStore.getState().queuedMessages).toHaveLength(0)
  })
})
