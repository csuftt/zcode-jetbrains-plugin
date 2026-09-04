/**
 * 校验分隔卡实时性复现（0.3.2 真机反馈：校验结果文案不实时展示，拖到
 * 下一轮流式完成（轮末重拉）才渲染）
 *
 * 模拟 goal 引擎快速轮转的真实事件序列（rollout+idea.log 实测顺序）：
 *   工作轮 turn.completed → run_finished（verifying=true）→ verifier
 *   turn.started（吞壳）→ 校验完成 → 下一轮 turn.started（先到，吞壳/
 *   或正常建壳两形态都测）→ run_started（清 verifying + goalRefresh
 *   800ms）→ goalRefresh 响应落地（streaming 中走增量合并）
 *
 * 断言：goalRefresh 落地后校验分隔卡（timeline goal_verification 消息）
 * 立即进入 store.messages 并渲染为 tl-sep——不等下一轮 turnEnded 重拉。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

let messageHandler: ((msg: unknown) => void) | null = null
let streamHandler: ((sid: string, event: unknown) => void) | null = null
let batchHandler: ((sid: string, events: unknown[]) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamHandler = fn },
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { batchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { ChatView } from '@/components/ChatView'

/** 订阅 store 的 ChatView（同 App.tsx 的渲染方式，消息变化驱动重渲染） */
function StoreBoundChatView() {
  const messages = useStore((s) => s.messages)
  const streamingMessageId = useStore((s) => s.streamingMessageId)
  const streaming = useStore((s) => s.streaming)
  return (
    <ChatView
      messages={messages}
      loading={false}
      waiting={!streaming && messages.length === 0}
      streamingMessageId={streamingMessageId}
      compacting={false}
      searchOpen={false}
    />
  )
}

class IOStub { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } }
;(globalThis as Record<string, unknown>).IntersectionObserver = IOStub
;(globalThis as Record<string, unknown>).ResizeObserver = IOStub

const SID = 'sess_verify'

function ev(type: string, payload: Record<string, unknown>, seq = 1, turnId?: string) {
  return { type, seq, sessionId: SID, ...(turnId ? { turnId } : {}), timestamp: Date.now(), payload }
}
function single(type: string, payload: Record<string, unknown>, turnId?: string) {
  act(() => { streamHandler?.(SID, ev(type, payload, Math.floor(Math.random() * 1e6), turnId)) })
}
function dispatch(msg: Record<string, unknown>) {
  act(() => { messageHandler?.(msg) })
}

const TARGET = { targetID: 'target_v1', objective: '五轮任务', summaryTitle: '五轮', status: 'active', tokensUsed: 100, timeUsedSeconds: 30, tokenBudget: null }

/** 落库形态的校验消息（sqlite 实测：assistant + 单 timeline part；pending=两阶段落库的占位形态，verification 空） */
function verifyMsg(iter: number, passed = false, pending = false) {
  return {
    info: { role: 'assistant', id: `msg_goal_verify_target_v1_${iter}`, sessionID: SID, time: { created: 1000 + iter } },
    parts: [{
      type: 'timeline', timelineType: 'goal_verification', display: 'separator', goalIteration: iter,
      ...(pending ? {} : { verification: { passed, reason: passed ? '全部判据满足' : '判据 a 不满足：还有轮次未完成', nextAction: '进入下一轮' } }),
    }],
  }
}
/** 普通工作轮 assistant 消息 */
function workMsg(n: number, text = '第 N 轮完成') {
  return { info: { role: 'assistant', id: `msg_work_${n}`, sessionID: SID, time: { created: 900 + n } }, parts: [{ type: 'text', text }] }
}

beforeEach(() => {
  cleanup()
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    streaming: false,
    streamingMessageId: null,
    compacting: false,
    goal: null,
    messages: [workMsg(1)],
    queuedMessages: [],
    editReplay: null,
    searchActive: false,
  })
})

describe('校验分隔卡实时性（goalRefresh 落地即渲染）', () => {
  it('场景A｜下一轮 turn.started 先于 run_started（吞壳形态）：goalRefresh 增量合并后校验卡立即可见', () => {
    render(<StoreBoundChatView />)
    // 第 1 轮结束 → run_finished（verifying=true）
    single('session.updated', { action: 'run_finished', source: 'runtime', target: { ...TARGET } })
    expect(useStore.getState().goal?.verifying).toBe(true)
    // verifier 回合（吞壳：只置流式不建消息）
    single('turn.started', { messageId: 'm_verify_1' })
    expect(useStore.getState().streamingMessageId).toBeNull()
    // 校验完成：下一工作轮 turn.started 先到（缺陷AX 实测顺序，仍被吞——verifying 未清）
    single('turn.started', { messageId: 'm_user_2' })
    // run_started 后到：清 verifying + 触发 goalRefresh（800ms）
    single('session.updated', { action: 'run_started', source: 'runtime', target: { ...TARGET, iterationCount: 2 } })
    expect(useStore.getState().goal?.verifying).toBeUndefined()
    // goalRefresh 响应落地（streaming=true → 增量合并；快照=已落库全量：轮1消息+校验1+控制消息）
    dispatch({
      op: 'messages', sessionId: SID, goalRefresh: true,
      messages: [workMsg(1), verifyMsg(1), { info: { role: 'user', id: 'm_cont_2', sessionID: SID, time: { created: 1002 } }, parts: [{ type: 'text', text: '继续' }], metadata: { source: 'goal-continuation', visibility: 'model-only' } }],
      goalTarget: { ...TARGET, iterationCount: 2 }, goalStats: { iterationCount: 2 },
    })
    // ★ 断言1：校验消息已进 store（不等下一轮 turnEnded 重拉）
    const ids = useStore.getState().messages.map((m) => m.info.id)
    expect(ids).toContain('msg_goal_verify_target_v1_1')
    // ★ 断言2：DOM 已渲染校验卡（tl-sep）
    expect(document.querySelectorAll('.tl-sep').length).toBeGreaterThan(0)
  })

  it('场景B｜run_started 先清 verifying（正常建壳形态）：同样立即可见', () => {
    render(<StoreBoundChatView />)
    single('session.updated', { action: 'run_finished', source: 'runtime', target: { ...TARGET } })
    single('turn.started', { messageId: 'm_verify_2' })
    // run_started 先到 → verifying 清
    single('session.updated', { action: 'run_started', source: 'runtime', target: { ...TARGET, iterationCount: 3 } })
    // 下一轮 turn.started 正常建壳（verifying 已清）
    single('turn.started', { messageId: 'm_user_3' })
    expect(useStore.getState().streamingMessageId).toBeTruthy()
    single('model.streaming', { kind: 'text_delta', delta: '第 3 轮开始', assistantMessageId: 'm_a_3' })
    dispatch({
      op: 'messages', sessionId: SID, goalRefresh: true,
      messages: [workMsg(1), verifyMsg(1), workMsg(2), verifyMsg(2)],
      goalTarget: { ...TARGET, iterationCount: 3 }, goalStats: { iterationCount: 3 },
    })
    expect(useStore.getState().messages.map((m) => m.info.id)).toContain('msg_goal_verify_target_v1_2')
    expect(document.querySelectorAll('.tl-sep').length).toBeGreaterThanOrEqual(2)
  })

  it('缺陷AY｜两阶段落库回填：pending 空形态先落地，goalRefresh 的 completed 形态必须覆盖并渲染', () => {
    render(<StoreBoundChatView />)
    // 轮末常规重拉（turnEnded 300ms，streaming=false 全量落地）：拉到 pending
    // 占位（sqlite 实测：工作轮结束即创建，verification 空）→ 渲染 null
    dispatch({
      op: 'messages', sessionId: SID,
      messages: [workMsg(1), verifyMsg(1, false, true)],
      goalTarget: { ...TARGET }, goalStats: { iterationCount: 1 },
    })
    expect(useStore.getState().messages.map((m) => m.info.id)).toContain('msg_goal_verify_target_v1_1')
    expect(document.querySelectorAll('.tl-sep').length).toBe(0) // pending 空 verification 不渲染（TimelineSeparator 判据）
    // 校验完成：run_finished → 下一轮 turn.started（吞壳，streaming=true）→ run_started → goalRefresh
    single('session.updated', { action: 'run_finished', source: 'runtime', target: { ...TARGET } })
    single('turn.started', { messageId: 'm_user_2' })
    single('session.updated', { action: 'run_started', source: 'runtime', target: { ...TARGET, iterationCount: 2 } })
    // goalRefresh 响应：同 id 的校验消息已带回填 verification——必须覆盖本地 pending
    //（修复前：hit 命中且非空壳 → return false 被滤 → 校验卡滞后到下一轮轮末重拉）
    dispatch({
      op: 'messages', sessionId: SID, goalRefresh: true,
      messages: [workMsg(1), verifyMsg(1)],
      goalTarget: { ...TARGET, iterationCount: 2 }, goalStats: { iterationCount: 2 },
    })
    // ★ 回填生效：store 里该消息带 verification，DOM 渲染出校验卡
    const updated = useStore.getState().messages.find((m) => m.info.id === 'msg_goal_verify_target_v1_1')
    expect((updated?.parts?.[0] as { verification?: unknown }).verification).toBeTruthy()
    expect(document.querySelectorAll('.tl-sep').length).toBe(1)
    expect(document.querySelectorAll('.tl-sep .codicon-refresh').length).toBe(1) // 未通过形态
  })

  it('缺陷AY修复回归｜历史校验卡不得被拔起堆叠：内容未变时原位不动', () => {
    render(<StoreBoundChatView />)
    // 前端已就位：verify1（在 work1 后）、verify2（在 work2 后），内容为完成态
    useStore.setState({
      messages: [workMsg(1), verifyMsg(1), workMsg(2), verifyMsg(2)],
      streaming: false, streamingMessageId: null,
    })
    const idx1Before = useStore.getState().messages.findIndex((m) => m.info.id === 'msg_goal_verify_target_v1_1')
    const idx2Before = useStore.getState().messages.findIndex((m) => m.info.id === 'msg_goal_verify_target_v1_2')
    // 第 3 轮流式中 goalRefresh：快照含 verify1/verify2（内容相同）+ 新 verify3
    single('session.updated', { action: 'run_started', source: 'runtime', target: { ...TARGET, iterationCount: 4 } })
    single('turn.started', { messageId: 'm_user_4' })
    single('model.streaming', { kind: 'text_delta', delta: '第 4 轮', assistantMessageId: 'm_a_4' })
    dispatch({
      op: 'messages', sessionId: SID, goalRefresh: true,
      messages: [workMsg(1), verifyMsg(1), workMsg(2), verifyMsg(2), workMsg(3), verifyMsg(3)],
      goalTarget: { ...TARGET, iterationCount: 4 }, goalStats: { iterationCount: 4 },
    })
    const after = useStore.getState().messages
    // ★ 历史校验卡索引不变（不被拔起挪位）；新校验卡进来、无重复
    expect(after.findIndex((m) => m.info.id === 'msg_goal_verify_target_v1_1')).toBe(idx1Before)
    expect(after.findIndex((m) => m.info.id === 'msg_goal_verify_target_v1_2')).toBe(idx2Before)
    expect(after.filter((m) => m.info.id === 'msg_goal_verify_target_v1_1')).toHaveLength(1)
    expect(after.filter((m) => m.info.id === 'msg_goal_verify_target_v1_2')).toHaveLength(1)
    expect(after.some((m) => m.info.id === 'msg_goal_verify_target_v1_3')).toBe(true)
    expect(document.querySelectorAll('.tl-sep').length).toBe(3)
  })

  it('回填原位覆盖：pending 版在前端中间位置时，回填只换内容不挪位', () => {
    render(<StoreBoundChatView />)
    // verify2(pending) 已由轮末重拉落在 work2 后（位置正确）
    useStore.setState({
      messages: [workMsg(1), verifyMsg(1), workMsg(2), verifyMsg(2, false, true)],
      streaming: false, streamingMessageId: null,
    })
    const idxBefore = useStore.getState().messages.findIndex((m) => m.info.id === 'msg_goal_verify_target_v1_2')
    single('session.updated', { action: 'run_started', source: 'runtime', target: { ...TARGET, iterationCount: 3 } })
    single('turn.started', { messageId: 'm_user_3' })
    single('model.streaming', { kind: 'text_delta', delta: '第 3 轮', assistantMessageId: 'm_a_3' })
    dispatch({
      op: 'messages', sessionId: SID, goalRefresh: true,
      messages: [workMsg(1), verifyMsg(1), workMsg(2), verifyMsg(2)],
      goalTarget: { ...TARGET, iterationCount: 3 }, goalStats: { iterationCount: 3 },
    })
    const after = useStore.getState().messages
    // ★ 原位覆盖：索引不变、verification 已回填、无重复条目
    expect(after.findIndex((m) => m.info.id === 'msg_goal_verify_target_v1_2')).toBe(idxBefore)
    expect(after.filter((m) => m.info.id === 'msg_goal_verify_target_v1_2')).toHaveLength(1)
    const v2 = after.find((m) => m.info.id === 'msg_goal_verify_target_v1_2')
    expect((v2?.parts?.[0] as { verification?: unknown }).verification).toBeTruthy()
    expect(document.querySelectorAll('.tl-sep').length).toBe(2)
  })
})
