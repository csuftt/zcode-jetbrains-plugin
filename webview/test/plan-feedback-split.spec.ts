/**
 * 计划审批「意见式继续规划」反馈插入的拆分回归测试
 *
 * 复现缺陷Q（2026-08-24 实测，CLI 日志 + rollout 双证据）：
 *   ExitPlanMode 意见式拒绝（answer=意见文本 ≠ "approve"）服务端回合不终止——
 *   意见被合成 user 消息插入 transcript，拒绝结果回传后 AI 在同一 turn 内继续
 *   流式。旧实现把反馈乐观 append 到消息列表尾部：后续 delta 仍追加到原
 *   streamingMessageId 消息（位于反馈之前），反馈被钉在流式尾部，直到回合结束
 *   重拉按服务端树序归位——期间顺序颠倒（反馈显示在它触发的 AI 输出之后）。
 *
 * 断言：
 *   1. 反馈插入时拆分流式消息：[旧输出(封段), 反馈, 新空 assistant]
 *   2. streamingMessageId 切到新消息，后续 delta 进入新消息（不叠进旧消息/user）
 *   3. 兜底：无流式消息或指向非 assistant 时尾部追加，不拆分
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock 桥接层：捕获 sendToJava，手动注入事件/响应 ----
let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
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
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

const SID = 'sess_plan_fb_1'

/** 推一个流式事件（走单推通道）*/
function pushEvent(type: string, payload: Record<string, unknown>, turnId = 'turn_2', seq = 100): void {
  streamEventHandler!(SID, {
    type, seq, sessionId: SID, turnId, timestamp: Date.now(), payload,
  })
}

function userMsg(id: string, text: string): ZCodeMessage {
  return {
    info: { role: 'user', time: { created: 1 }, id, sessionID: SID },
    parts: [{ type: 'text', text }],
  }
}

function msgText(m: ZCodeMessage | undefined): string {
  return (m?.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
}

beforeEach(() => {
  vi.useFakeTimers()
  sentRequests.length = 0
  useStore.getState().init() // 注册桥接回调（onMessage/onStreamEvent）
  sentRequests.length = 0 // 清掉 init 触发的 listSessions/listModels
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [userMsg('msg_srv_u0', '继续，我验证了拒绝')],
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    sessions: [{ sessionId: SID, title: 'plan-fb', status: 'idle', mode: 'plan', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('意见式继续规划：反馈插入拆分流式消息', () => {
  it('反馈插在流式消息拆分处，后续 delta 进入新接管消息（不再钉尾）', () => {
    // ── 1. turn 进行中：流式 assistant 消息累积 v2 文本 + ExitPlanMode 工具卡 ──
    pushEvent('turn.started', { turnNumber: 2, messageId: 'msg_srv_u0' }, 'turn_2', 100)
    pushEvent('model.streaming', { kind: 'text_delta', delta: '探索完成，提交计划供审批。' }, 'turn_2', 101)
    pushEvent('tool.updated', { kind: 'scheduled', toolCallId: 'call_ep_1', toolName: 'ExitPlanMode' }, 'turn_2', 102)

    const before = useStore.getState()
    const oldStreamingId = before.streamingMessageId!
    expect(oldStreamingId).toBeTruthy()

    // ── 2. 用户在审批弹窗提交意见「继续修改」（反馈式拒绝，回合不终止）──
    useStore.getState().insertFeedbackMessage('继续修改')

    const st2 = useStore.getState()
    const roles = st2.messages.map((m) => m.info.role)
    // 拆分后顺序：[user(触发turn), assistant(旧输出封段), user(反馈), assistant(新接管)]
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    // 反馈消息内容
    expect(st2.messages[2].parts[0]).toMatchObject({ type: 'text', text: '继续修改' })
    // streamingMessageId 切到新建的空 assistant 消息
    const newStreaming = st2.messages[3]
    expect(st2.streamingMessageId).toBe(newStreaming.info.id)
    expect(newStreaming.parts).toHaveLength(0)
    // 旧消息封段保留已累积内容
    const oldMsg = st2.messages[1]
    expect(msgText(oldMsg)).toBe('探索完成，提交计划供审批。')
    expect(oldMsg.parts.some((p) => p.type === 'tool' && p.callID === 'call_ep_1')).toBe(true)

    // ── 3. 拒绝结果回传后 AI 同 turn 继续流式（v3），delta 必须进新接管消息 ──
    pushEvent('model.streaming', { kind: 'reasoning_delta', delta: '收到意见，修订计划。' }, 'turn_2', 103)
    pushEvent('model.streaming', { kind: 'text_delta', delta: '修订版计划：' }, 'turn_2', 104)

    const st3 = useStore.getState()
    // 新消息累积 v3 内容
    expect(msgText(st3.messages.find((m) => m.info.id === st3.streamingMessageId))).toContain('修订版计划')
    // 旧消息不再增长（封段）
    expect(msgText(st3.messages[1])).toBe('探索完成，提交计划供审批。')
    // 不叠字：user 消息不得混入 AI delta
    const userTexts = st3.messages
      .filter((m) => m.info.role === 'user')
      .map((m) => msgText(m))
      .join('\n')
    expect(userTexts).not.toContain('修订版计划')
    expect(userTexts).not.toContain('探索完成')
  })

  it('流式消息不在列表中（异常兜底）：反馈尾部追加，不新建接管消息', () => {
    useStore.setState({ streaming: true, streamingMessageId: 'ghost_id' })
    useStore.getState().insertFeedbackMessage('继续修改')
    const st = useStore.getState()
    expect(st.messages).toHaveLength(2) // 原 1 条 + 反馈
    expect(st.messages[1].parts[0]).toMatchObject({ type: 'text', text: '继续修改' })
    expect(st.streamingMessageId).toBe('ghost_id') // 不动既有指向
  })

  it('streamingMessageId 指向 user 消息（role 防护）：尾部追加，不拆分不叠字', () => {
    useStore.setState({ streaming: true, streamingMessageId: 'msg_srv_u0' })
    useStore.getState().insertFeedbackMessage('继续修改')
    const st = useStore.getState()
    expect(st.messages).toHaveLength(2)
    expect(st.messages[1].info.role).toBe('user')
    // 原 user 消息未被改动成 assistant，也无新 assistant 消息建立
    expect(st.messages.some((m) => m.info.role === 'assistant')).toBe(false)
  })

  it('空文本与无会话守卫：不动 messages', () => {
    useStore.getState().insertFeedbackMessage('   ')
    expect(useStore.getState().messages).toHaveLength(1)
    useStore.setState({ currentSessionId: null })
    useStore.getState().insertFeedbackMessage('继续修改')
    expect(useStore.getState().messages).toHaveLength(1)
  })
})
