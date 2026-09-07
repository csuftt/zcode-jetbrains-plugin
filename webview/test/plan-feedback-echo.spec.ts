/**
 * 计划审批意见回显豁免（steer 通道劫持缺陷修复，2026-09-07 真机实测）
 *
 * 缺陷：意见式拒绝（answer=意见文本）后，服务端把意见经 guide 通道回显进当前
 * 回合，事件面与 steer 插队同形（turn.steerDrained）——旧实现不区分来源，
 * steerDrained 注入带「⚡引导」徽标的气泡，与缺陷Q拆分处本地插入
 * （insertFeedbackMessage）叠加成双条；回合结束重拉后剩单条带徽标。
 *
 * 修复：insertFeedbackMessage 置 planFeedbackEcho 豁免标志（15s 窗口），
 * steerDrained 命中（窗口内 + 文本一致）跳过注入与徽标；意见气泡由本地条
 * 在拆分处呈现，后续 delta 继续进本地壳，轮末重拉权威对账。
 *
 * 断言：
 *   1. 豁免命中：不注入服务端气泡、不进徽标账本、标志清空、流式壳不动
 *   2. 豁免后 delta 继续进本地壳（不建协议新壳，输出连续）
 *   3. 文本不一致 = 真 steer 并发：照常注入 + 徽标
 *   4. 窗口过期：照常注入 + 徽标
 *   5. 批量通道同豁免（handleStreamBatchDirect 对称行为）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock 桥接层：捕获 sendToJava，手动注入事件/响应 ----
let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

const SID = 'sess_fb_echo_1'
const FEEDBACK = '继续修改：补充回滚方案'

function pushEvent(type: string, payload: Record<string, unknown>, turnId = 'turn_2', seq = 100): void {
  streamEventHandler!(SID, {
    type, seq, sessionId: SID, turnId, timestamp: Date.now(), payload,
  })
}

function pushBatch(events: Array<{ type: string; payload: Record<string, unknown>; seq?: number }>, turnId = 'turn_2'): void {
  streamBatchHandler!(SID, events.map((e, i) => ({
    type: e.type, seq: e.seq ?? 200 + i, sessionId: SID, turnId, timestamp: Date.now(), payload: e.payload,
  })))
}

function drainedPayload(text: string, messageId = 'msg_echo_srv'): Record<string, unknown> {
  return {
    pendingInputIds: ['queue_sendText-x'],
    targetTurnId: 'turn_2',
    injectedMessageIds: [messageId],
    drainedInputs: [{ pendingInputId: 'queue_sendText-x', messageId, text, delivery: 'guide' }],
  }
}

function userMsg(id: string, text: string): ZCodeMessage {
  return {
    info: { role: 'user', time: { created: 1 }, id, sessionID: SID },
    parts: [{ type: 'text', text }],
  }
}

function userCount(): number {
  return useStore.getState().messages.filter((m) => m.info.role === 'user').length
}

/** 前置：turn 进行中 + 意见已本地插入（缺陷Q拆分），返回插入时的消息数 */
function setupFeedbackInFlight(): { messagesAfterInsert: number; localShellId: string } {
  pushEvent('turn.started', { turnNumber: 2, messageId: 'msg_srv_u0' }, 'turn_2', 100)
  pushEvent('model.streaming', { kind: 'text_delta', delta: '初版计划已提交。' }, 'turn_2', 101)
  useStore.getState().insertFeedbackMessage(FEEDBACK)
  const st = useStore.getState()
  return { messagesAfterInsert: st.messages.length, localShellId: st.streamingMessageId! }
}

beforeEach(() => {
  vi.useFakeTimers()
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [userMsg('msg_srv_u0', '进入计划模式探索')],
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    steerPending: null,
    steeredMessageIds: [],
    planFeedbackEcho: null,
    sessions: [{ sessionId: SID, title: 'fb-echo', status: 'idle', mode: 'plan', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('审批意见回显豁免（steerDrained 劫持修复）', () => {
  it('豁免命中：不注入服务端气泡、不进徽标账本、标志清空、流式壳不动', () => {
    const { messagesAfterInsert, localShellId } = setupFeedbackInFlight()

    pushEvent('turn.steerDrained', drainedPayload(FEEDBACK), 'turn_2', 102)

    const st = useStore.getState()
    // 服务端回显条未注入（本地插入条之外无新增 user 气泡）
    expect(st.messages).toHaveLength(messagesAfterInsert)
    expect(st.messages.filter((m) => m.info.id === 'msg_echo_srv')).toHaveLength(0)
    // 不误标「⚡引导」徽标
    expect(st.steeredMessageIds).not.toContain('msg_echo_srv')
    // 豁免标志消费即清
    expect(st.planFeedbackEcho).toBeNull()
    // 流式壳保持缺陷Q本地壳（后续 delta 续流），不被封口
    expect(st.streamingMessageId).toBe(localShellId)
  })

  it('豁免后 delta 继续进本地壳：输出连续，不建协议新壳', () => {
    const { localShellId } = setupFeedbackInFlight()
    pushEvent('turn.steerDrained', drainedPayload(FEEDBACK), 'turn_2', 102)

    pushEvent('model.streaming', { kind: 'text_delta', delta: '修订版计划：补充回滚。' }, 'turn_2', 103)

    const st = useStore.getState()
    expect(st.streamingMessageId).toBe(localShellId)
    const shell = st.messages.find((m) => m.info.id === localShellId)
    expect(shell?.parts.some((p) => p.type === 'text' && (p as { text: string }).text.includes('修订版计划'))).toBe(true)
  })

  it('文本不一致（真 steer 并发）：照常注入 + 徽标', () => {
    setupFeedbackInFlight()

    pushEvent('turn.steerDrained', drainedPayload('改要求：每行加 # 号', 'msg_real_steer'), 'turn_2', 102)

    const st = useStore.getState()
    expect(st.messages.some((m) => m.info.id === 'msg_real_steer')).toBe(true)
    expect(st.steeredMessageIds).toContain('msg_real_steer')
  })

  it('窗口过期（>15s）：照常注入 + 徽标', () => {
    setupFeedbackInFlight()
    // 懒过期：把标志时间戳拨回窗口外
    const echo = useStore.getState().planFeedbackEcho!
    useStore.setState({ planFeedbackEcho: { ...echo, at: Date.now() - 16000 } })

    pushEvent('turn.steerDrained', drainedPayload(FEEDBACK), 'turn_2', 102)

    const st = useStore.getState()
    expect(st.messages.some((m) => m.info.id === 'msg_echo_srv')).toBe(true)
    expect(st.steeredMessageIds).toContain('msg_echo_srv')
  })

  it('批量通道同豁免（handleStreamBatchDirect 对称行为）', () => {
    const { messagesAfterInsert } = setupFeedbackInFlight()

    pushBatch([
      { type: 'turn.steerDrained', payload: drainedPayload(FEEDBACK) },
      { type: 'model.streaming', payload: { kind: 'text_delta', delta: '批量续流。' } },
    ])

    const st = useStore.getState()
    expect(st.messages).toHaveLength(messagesAfterInsert)
    expect(st.messages.some((m) => m.info.id === 'msg_echo_srv')).toBe(false)
    expect(st.steeredMessageIds).not.toContain('msg_echo_srv')
    expect(st.planFeedbackEcho).toBeNull()
  })

  it('insertFeedbackMessage 置豁免标志（置位链路）', () => {
    pushEvent('turn.started', { turnNumber: 2, messageId: 'msg_srv_u0' }, 'turn_2', 100)
    pushEvent('model.streaming', { kind: 'text_delta', delta: '计划。' }, 'turn_2', 101)

    expect(useStore.getState().planFeedbackEcho).toBeNull()
    useStore.getState().insertFeedbackMessage(FEEDBACK)

    const echo = useStore.getState().planFeedbackEcho
    expect(echo).not.toBeNull()
    expect(echo!.text).toBe(FEEDBACK)
  })
})
