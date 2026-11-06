/**
 * 缺陷GQ 回归测试：多条排队消息点「立即」后连环发出多条
 *
 * 复现链（点「排队B」的立即）：
 *   sendQueuedNow(B) → 移队头 + stop → stopped 应答清 streaming → 终止帧 turn_1
 *   → flushQueue 发出 B（点击那条，正确）→ send 撞清算窗口 / NEW CLI 被停回合不发
 *   终态帧 → Java 合成 turn.completed 与迟到的服务端真实帧**双到**（同一 turnId）
 *   → 第二次终态善后无条件 patch.streaming=false 把 B 新回合的流式清掉
 *   → flushQueue 守卫失效 → 再发 A → 连环（每条 send 又撞清算窗口）
 *
 * 断言：
 *   1. 同 turnId 终止帧双到（单推+单推、批量+单推混合通道）：send 只发一条（点击那条）、
 *      streaming 不被清、队列剩余条目原样保留
 *   2. 不同 turnId 的正常链式终止帧照常逐条自动发出（幂等拦截不误伤）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock 桥接层：捕获 sendToJava，手动注入事件/响应 ----
let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
let batchHandler: ((sid: string, events: unknown[]) => void) | null = null
let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { batchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'

// 每用例独立会话 id：lastCompletedTurn 是模块级状态（绑 sid），跨用例不重置——
// 同 sid 情况下前用例的 turnId 会拦住本用例的同名终止帧
let sidSeq = 0
let SID: string

function pushEvent(type: string, payload: Record<string, unknown>, turnId: string, seq: number): void {
  streamEventHandler!(SID, {
    type, seq, sessionId: SID, turnId, timestamp: Date.now(), payload,
  })
}

function pushBatch(events: Array<{ type: string; payload: Record<string, unknown>; turnId?: string; seq?: number }>): void {
  batchHandler!(SID, events.map((e) => ({
    type: e.type, seq: e.seq ?? 100, sessionId: SID, turnId: e.turnId, timestamp: Date.now(), payload: e.payload,
  })))
}

function sendOps(): Array<Record<string, unknown>> {
  return sentRequests.filter((r) => r.op === 'send')
}

beforeEach(() => {
  vi.useFakeTimers()
  sentRequests.length = 0
  SID = `sess_gq_${++sidSeq}`
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [],
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    sessions: [{ sessionId: SID, title: 'sess_gq_1', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('缺陷GQ：点「立即」后终止帧双到不连环发出队列', () => {
  it('单推通道：同 turnId 终止帧第二次到达不发第二条、不清流式', () => {
    const store = useStore.getState()

    // ── 1. 回合 turn_1 进行中，队列排三条 ──
    useStore.setState({ streaming: true, streamingMessageId: 'msg_a1' })
    store.sendMessage('排队A')
    store.sendMessage('排队B')
    store.sendMessage('排队C')
    expect(useStore.getState().queuedMessages).toHaveLength(3)

    // ── 2. 点「排队B」的立即：移队头 + stop；stopped 应答清 streaming（真实时序）──
    const bid = useStore.getState().queuedMessages[1].id
    store.sendQueuedNow(bid)
    expect(useStore.getState().queuedMessages[0].text).toBe('排队B')
    expect(sentRequests.some((r) => r.op === 'stop')).toBe(true)
    useStore.setState({ streaming: false })
    sentRequests.length = 0

    // ── 3. turn_1 终止帧到达 → flushQueue 发出点击那条 ──
    pushEvent('turn.completed', {}, 'turn_1', 99)
    expect(sendOps()).toHaveLength(1)
    expect(sendOps()[0].text).toBe('排队B')
    expect(useStore.getState().queuedMessages.map((m) => m.text)).toEqual(['排队A', '排队C'])
    expect(useStore.getState().streaming).toBe(true)
    // 排队B 的新回合开跑（send 已受理）
    pushEvent('turn.started', { turnNumber: 2 }, 'turn_2', 100)

    // ── 4. 同 turnId 终止帧再次到达（合成帧 + 迟到真实帧双到）──
    pushEvent('turn.completed', {}, 'turn_1', 101)
    // 第二次终态善后被幂等拦截：不再发第二条、streaming 保持、队列原样
    expect(sendOps()).toHaveLength(1)
    expect(useStore.getState().streaming).toBe(true)
    expect(useStore.getState().queuedMessages.map((m) => m.text)).toEqual(['排队A', '排队C'])
  })

  it('混合通道：批量终止帧（合成）+ 单推终止帧（迟到真实帧）双到同样只发一条', () => {
    const store = useStore.getState()

    useStore.setState({ streaming: true, streamingMessageId: 'msg_a1' })
    store.sendMessage('排队A')
    store.sendMessage('排队B')
    const bid = useStore.getState().queuedMessages[1].id
    store.sendQueuedNow(bid)
    useStore.setState({ streaming: false })
    sentRequests.length = 0

    // 合成帧走批量通道 → 发出排队B
    pushBatch([{ type: 'turn.completed', payload: { synthetic: true }, turnId: 'turn_1', seq: 99 }])
    expect(sendOps()).toHaveLength(1)
    expect(sendOps()[0].text).toBe('排队B')
    pushEvent('turn.started', { turnNumber: 2 }, 'turn_2', 100)

    // 迟到的服务端真实帧走单推通道（同 turnId）→ 幂等拦截
    pushEvent('turn.completed', {}, 'turn_1', 101)
    expect(sendOps()).toHaveLength(1)
    expect(useStore.getState().streaming).toBe(true)
    expect(useStore.getState().queuedMessages.map((m) => m.text)).toEqual(['排队A'])
  })

  it('不同 turnId 的链式终止帧照常逐条自动发出（幂等拦截不误伤）', () => {
    const store = useStore.getState()

    useStore.setState({ streaming: true, streamingMessageId: 'msg_a1' })
    store.sendMessage('排队A')
    store.sendMessage('排队B')
    sentRequests.length = 0

    // 第一轮（turn_1）结束 → 自动发排队A
    pushEvent('turn.completed', {}, 'turn_1', 10)
    expect(sendOps()).toHaveLength(1)
    expect(sendOps()[0].text).toBe('排队A')
    pushEvent('turn.started', { turnNumber: 2 }, 'turn_2', 11)

    // 第二轮（turn_2）结束 → 自动发排队B（turn_2 ≠ turn_1，不拦）
    pushEvent('turn.completed', {}, 'turn_2', 20)
    expect(sendOps()).toHaveLength(2)
    expect(sendOps()[1].text).toBe('排队B')
    expect(useStore.getState().queuedMessages).toHaveLength(0)

    // 第三轮（turn_3）结束 → 队列空，流式收尾
    pushEvent('turn.started', { turnNumber: 3 }, 'turn_3', 21)
    pushEvent('turn.completed', {}, 'turn_3', 22)
    expect(useStore.getState().streaming).toBe(false)
  })
})
