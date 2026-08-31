/**
 * 子代理弹窗实时流全时序集成测试（2026-08-31 用户实测"中途变空"缺陷复现）
 *
 * 用户场景：子代理搜索任务，弹窗起初实时刷（v4 归约），点一个工具后内容变空；
 * 刷新按钮仍 3s 转。
 *
 * 本测试用 diag-v4-search-repro.py 抓到的真实事件序列（WebSearch×5 + 最终报告）
 * 灌真实 store，逐步断言弹窗 display 数据源：
 *   阶段1 运行中：live 归约累积（turn.started → 工具流 → result → text_delta）
 *   阶段2 turn.completed（合成）：活动收尾 → running 翻转 → display 切源
 *   阶段3 subagents RPC 响应：权威状态合并（防降级）
 *   阶段4 subagentMessages 响应：权威转录替换（真实结构：timeline+user+7 assistant）
 *
 * 任一阶段 display 变空 = 缺陷复现。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/ipc/bridge', () => {
  const handlers: Record<string, (payload: unknown) => void> = {}
  return {
    sendToJava: vi.fn(),
    onStreamBatch: (cb: (sid: string, events: unknown[]) => void) => { handlers.batch = cb; return () => {} },
    onStreamEvent: (cb: (sid: string, event: unknown) => void) => { handlers.event = cb; return () => {} },
    onMessage: (cb: (msg: unknown) => void) => { handlers.message = cb; return () => {} },
    onDiagLog: () => () => {},
    getDiagLog: () => [],
    initBridge: () => {},
    isInJcef: () => false,
    getWorkspacePath: () => 'G:\\mock',
    __handlers: handlers,
  }
})

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { __handlers } from '@/ipc/bridge'

const MAIN = 'sess_main'
const CHILD = 'sess_subagent_agent_test'
const CALL_ID = 'call_x1'

/** v4 映射产出的 legacy 形状事件（与 V4FrameMapper 输出一致） */
function ev(type: string, payload: Record<string, unknown>, turnId = 'msg_turn1'): unknown {
  return { type, seq: Math.floor(Math.random() * 1e6), sessionId: CHILD, turnId, timestamp: Date.now(), payload }
}

/** 真实 v4 帧映射序列（复现实验：2 并行 WebSearch → 2 → 1 → 最终报告 2804 字） */
function realSearchFlow(): unknown[] {
  const t1 = 'msg_t1'
  return [
    ev('turn.started', { messageId: t1 }, t1),
    // WebSearch#1/#2 并行输入流
    ev('model.streaming', { kind: 'tool_input_start', toolCallId: 'c1', toolName: 'WebSearch' }, t1),
    ev('model.streaming', { kind: 'tool_input_delta', toolCallId: 'c1', delta: '{"query":"AI news"}' }, t1),
    ev('model.streaming', { kind: 'tool_input_start', toolCallId: 'c2', toolName: 'WebSearch' }, t1),
    ev('tool.updated', { kind: 'started', toolCallId: 'c1', toolName: 'WebSearch', input: { query: 'AI news' } }, t1),
    ev('tool.updated', { kind: 'started', toolCallId: 'c2', toolName: 'WebSearch', input: { query: 'AI' } }, t1),
    ev('tool.updated', { kind: 'result', toolCallId: 'c1', toolName: 'WebSearch', result: { success: true, content: '搜索结果1'.repeat(100) } }, t1),
    ev('tool.updated', { kind: 'result', toolCallId: 'c2', toolName: 'WebSearch', result: { success: true, content: '搜索结果2'.repeat(100) } }, t1),
    // 中间思考 + 短文本 + 更多搜索
    ev('model.streaming', { kind: 'reasoning_delta', delta: '需要进一步搜索' }, t1),
    ev('model.streaming', { kind: 'text_delta', delta: '继续搜索' }, t1),
    ev('model.streaming', { kind: 'tool_input_start', toolCallId: 'c3', toolName: 'WebSearch' }, t1),
    ev('tool.updated', { kind: 'started', toolCallId: 'c3', toolName: 'WebSearch', input: { query: 'AI 模型' } }, t1),
    ev('tool.updated', { kind: 'result', toolCallId: 'c3', toolName: 'WebSearch', result: { success: true, content: '结果3' } }, t1),
    // 最终报告
    ev('model.streaming', { kind: 'text_delta', delta: '以下是 3 条 AI 要闻：'.repeat(50) }, t1),
  ]
}

/** 真实权威转录结构（diag-v4-child-transcript-check.py 实测：timeline+user+7 assistant） */
function realTranscript(): unknown[] {
  const mk = (id: string, role: string, parts: unknown[]) => ({ info: { id, sessionID: CHILD, role, time: { created: 1 } }, parts })
  return [
    mk('msg_part_1', 'assistant', [{ type: 'timeline', timelineType: 'session_start', display: 'separator' }]),
    mk('msg_user_1', 'user', [{ type: 'text', text: '搜索 AI 新闻并总结 3 条'.repeat(3) }]),
    ...['a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map((id, i) =>
      mk(`msg_${id}`, 'assistant', [
        { type: 'step-start' },
        { type: 'reasoning', text: `思考${i}`, time: { start: 1, end: 2 } },
        { type: 'text', text: `第${i}轮` },
        { type: 'tool', callID: `c${i}`, tool: 'WebSearch', state: { status: 'completed', output: '结果', time: { start: 1, end: 2 } } },
        { type: 'step-finish' },
      ])),
    mk('msg_final', 'assistant', [
      { type: 'step-start' },
      { type: 'text', text: '以下是 3 条 AI 要闻：'.repeat(60) },
      { type: 'step-finish' },
    ]),
  ]
}

/** 弹窗 display 的同款计算（SubagentDetailDialog 逻辑） */
function displayOf() {
  const st = useStore.getState()
  const transcript = st.childMessages[CHILD]
  const live = st.childLiveMessages[CHILD]
  const item = st.agents.find((a) => a.callID === CALL_ID)
  const running = item?.status === 'running' || item?.status === 'pending'
  return {
    running,
    itemStatus: item?.status,
    display: running ? (live ?? transcript) : (transcript ?? live),
    liveLen: live?.length ?? -1,
    transcriptLen: transcript?.length ?? -1,
  }
}

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  // 切片回放（16ms/片）依赖定时器：假时钟可控快进（大块 text_delta 现在也会切片）
  vi.useFakeTimers()
  // 注册 store 的流回调（模拟 initBridge 时机）
  useStore.getState().init?.()
  useStore.setState({
    currentSessionId: MAIN,
    childSessionKeys: { [CHILD]: CALL_ID },
    subagentDetail: CALL_ID,
    childLiveMessages: {},
    childStreamingIds: {},
    childMessages: {},
    childMessagesLoading: false,
    childMessagesError: null,
    subagentActivities: [{ key: CALL_ID, agentId: 'agent_x', childSessionId: CHILD, status: 'running', tools: [], lastUpdate: 1, startedAt: 1 }],
    subagents: [],
    agents: [{ callID: CALL_ID, childSessionId: CHILD, status: 'running', description: '搜索任务' }],
    messages: [],
    subagentDetailSource: 'panel',
  } as never)
})

describe('子代理弹窗实时流全时序', () => {
  it('运行中 live 累积 → 合成收尾 → 权威转录替换，display 每步非空', () => {
    // 阶段1：运行中实时流（含 550 字大块报告 delta → 切片回放逐字累积）
    ;(__handlers as Record<string, (s: string, e: unknown[]) => void>).batch!(CHILD, realSearchFlow())
    // 快进回放（550 字 / 4 字每片 ≈ 138 片 × 16ms ≈ 2.2s）
    vi.advanceTimersByTime(4000)
    let d = displayOf()
    expect(d.running).toBe(true)
    expect(d.liveLen).toBeGreaterThan(0)
    expect(d.display!.length).toBeGreaterThan(0)
    expect(d.display!.some((m) => m.parts.some((p) => p.type === 'tool'))).toBe(true)
    // 切片回放完整性：报告全文最终累积齐（不丢字）
    const texts = d.display!.flatMap((m) => m.parts).filter((p) => p.type === 'text') as Array<{ text: string }>
    const report = texts.find((p) => p.text.includes('以下是 3 条 AI 要闻'))
    expect(report).toBeTruthy()
    expect(report!.text.length).toBeGreaterThanOrEqual(550)  // 切片回放不丢字

    // 阶段2：合成 turn.completed（v4 映射的 turnHeader 收尾）→ 活动翻转 → running=false
    ;(__handlers as Record<string, (s: string, e: unknown[]) => void>).batch!(CHILD, [ev('turn.completed', {})])
    vi.advanceTimersByTime(4000)
    d = displayOf()
    // —— 防回归断言：合成收尾后 display 仍不得为空（live 保留或 transcript 兜底）
    expect(d.itemStatus).toBe('completed')
    expect(d.display?.length ?? 0).toBeGreaterThan(0)

    // 阶段3：subagents RPC 权威响应（真实 case 'subagents' msg 形状，RPC=running 场景
    // 用于验证防降级；防降级后 status 保持 completed 也不得让 display 变空）
    ;(__handlers as Record<string, (m: unknown) => void>).message!({
      op: 'subagents',
      childSessionIds: [CHILD],
      running: [{ toolCallId: CALL_ID, childSessionId: CHILD, subagentType: 'general-purpose', title: '搜索任务', status: 'running', startedAt: 1 }],
    })
    d = displayOf()
    expect(d.display?.length ?? 0).toBeGreaterThan(0)

    // 阶段4：权威转录到达（subagentMessages 响应）
    ;(__handlers as Record<string, (m: unknown) => void>).message!({
      op: 'subagentMessages',
      sessionId: CHILD,
      messages: realTranscript(),
    })
    d = displayOf()
    expect(d.transcriptLen).toBe(9)
    expect(d.display?.length ?? 0).toBeGreaterThan(0)
  })

  it('多批交错流（含大块切片回放）不卡泵：全部事件最终归约到位', () => {
    const t1 = 'msg_t1'
    const h = __handlers as Record<string, (s: string, e: unknown[]) => void>
    // 批1：回合开始 + 工具输入流（enqueue 泵启动场景）
    h.batch!(CHILD, [
      ev('turn.started', { messageId: t1 }, t1),
      ev('model.streaming', { kind: 'tool_input_start', toolCallId: 'c1', toolName: 'WebSearch' }, t1),
      ev('model.streaming', { kind: 'tool_input_delta', toolCallId: 'c1', delta: '{"query":"国内高校热点新闻 人事任命 校长 2026年8月30日"}' }, t1),
    ])
    // 批2（回放未完时到达——enqueue 排队保序路径）
    h.batch!(CHILD, [
      ev('tool.updated', { kind: 'started', toolCallId: 'c1', toolName: 'WebSearch', input: { query: '高校新闻' } }, t1),
    ])
    // 批3：大块 text_delta（切片回放）+ 工具结果交错
    h.batch!(CHILD, [
      ev('model.streaming', { kind: 'text_delta', delta: '先搜高校人事任命相关的热点新闻，再汇总。'.repeat(10) }, t1),
      ev('tool.updated', { kind: 'result', toolCallId: 'c1', toolName: 'WebSearch', result: { success: true, content: '搜索完成' } }, t1),
    ])
    // 批4：后续新工具（若泵死，这些永远不归约——用户实测症状：后续工具停在 loading）
    h.batch!(CHILD, [
      ev('model.streaming', { kind: 'tool_input_start', toolCallId: 'c2', toolName: 'WebSearch' }, t1),
      ev('tool.updated', { kind: 'started', toolCallId: 'c2', toolName: 'WebSearch', input: { query: '第二条' } }, t1),
      ev('tool.updated', { kind: 'result', toolCallId: 'c2', toolName: 'WebSearch', result: { success: true, content: '结果2' } }, t1),
    ])
    // 快进回放（多批积压：text 大块切片 + 全部直通事件）
    vi.advanceTimersByTime(3000)

    const st = useStore.getState()
    const live = st.childLiveMessages[CHILD]
    expect(live?.length).toBeGreaterThan(0)
    const tools = live!.flatMap((m) => m.parts).filter((p) => p.type === 'tool') as Array<{ callID: string; state: { status: string } }>
    // 两个工具全部归约到位且到终态（泵若死，c2 永远缺失、c1 停 running）
    const c1 = tools.find((t) => t.callID === 'c1')
    const c2 = tools.find((t) => t.callID === 'c2')
    expect(c1?.state.status).toBe('completed')
    expect(c2?.state.status).toBe('completed')
  })

  it('v4 snapshot 回放：reset 清旧防重复 + prompt 进 live 首位 + 全量文本不切片直通', () => {
    const t1 = 'msg_t1'
    const h = __handlers as Record<string, (s: string, e: unknown[]) => void>
    // 订阅后已归约过一段增量（重订阅/重同步前态）
    h.batch!(CHILD, [
      ev('turn.started', { messageId: t1 }, t1),
      ev('model.streaming', { kind: 'text_delta', delta: '旧增量内容' }, t1),
    ])
    vi.advanceTimersByTime(500)
    expect(useStore.getState().childLiveMessages[CHILD]!.length).toBe(1)

    // snapshot 回放（mapSnapshot 产出形状）：reset → prompt → started → 全量文本
    const mk = (type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      type, seq: Math.floor(Math.random() * 1e6), sessionId: CHILD, turnId: t1, timestamp: Date.now(), payload, ...extra,
    })
    h.batch!(CHILD, [
      mk('stream.snapshotReset', {}),
      mk('turn.userInput', { messageId: 'msg_t1', text: '搜索本日热点新闻' }),
      mk('turn.started', { messageId: t1 }),
      // 100 字全量 + deliveryKind=snapshot：不进切片回放队列，同步直通全长
      mk('model.streaming', { kind: 'text_delta', delta: '快照全文。'.repeat(20) }, { deliveryKind: 'snapshot' }),
    ])

    // 不快进时钟：snapshot 直通要求"到场即完整"（若误入切片队列，此刻只有第一片 8 字）
    const live = useStore.getState().childLiveMessages[CHILD]
    expect(live!.length).toBe(2) // reset 清旧后重建为 [user, assistant]
    expect(live![0].info.role).toBe('user')
    expect((live![0].parts[0] as { text: string }).text).toBe('搜索本日热点新闻')
    expect(JSON.stringify(live)).not.toContain('旧增量内容') // reset 防重同步内容重复追加
    const fullText = live![1].parts.find((p) => p.type === 'text') as { text: string } | undefined
    expect(fullText?.text.length).toBe(100) // 100 字全量立即到位（不切片）

    // 快照回放幂等：同 messageId 的 userInput 重放不重复 append
    h.batch!(CHILD, [mk('turn.userInput', { messageId: 'msg_t1', text: '搜索本日热点新闻' })])
    vi.advanceTimersByTime(500)
    expect(useStore.getState().childLiveMessages[CHILD]!.length).toBe(2)
  })

  it('多 turn 续跑不误收尾：同批 turn 终态+新 turn.started 以最后生命周期为准', () => {
    const t1 = 'msg_t1'
    const t2 = 'msg_t2'
    const h = __handlers as Record<string, (s: string, e: unknown[]) => void>
    // turn1 流式 + 终态（failed）+ turn2 立即开跑（重试/续轮）——同一批
    h.batch!(CHILD, [
      ev('turn.started', { messageId: t1 }, t1),
      ev('model.streaming', { kind: 'text_delta', delta: '第一轮输出' }, t1),
      ev('turn.failed', { error: { type: 'turn_state', message: 'subagent turn ended: failed' } }, t1),
      ev('turn.started', { messageId: t2 }, t2),
      ev('model.streaming', { kind: 'tool_input_start', toolCallId: 'c9', toolName: 'WebSearch' }, t2),
    ])
    vi.advanceTimersByTime(500)
    const st = useStore.getState()
    // 活动不得被 turn1 终态收尾（批内最后生命周期 = turn2 started）
    const activity = st.subagentActivities.find((a) => a.key === CALL_ID)
    expect(activity?.status).toBe('running') // 多 turn 续跑中不得误收尾为失败
    // live 两轮消息都在
    const roles = st.childLiveMessages[CHILD]!.map((m) => m.info.id)
    expect(roles).toContain(t1)
    expect(roles).toContain(t2)
  })

  it('跨批恢复：turn 终态误收尾后新 turn.started 恢复活动 running', () => {
    const t1 = 'msg_t1'
    const t2 = 'msg_t2'
    const h = __handlers as Record<string, (s: string, e: unknown[]) => void>
    // 批1：turn1 正常收尾（此批收尾合法——当时无新 turn）
    h.batch!(CHILD, [
      ev('turn.started', { messageId: t1 }, t1),
      ev('model.streaming', { kind: 'text_delta', delta: '第一轮' }, t1),
      ev('turn.completed', {}, t1),
    ])
    vi.advanceTimersByTime(500)
    expect(useStore.getState().subagentActivities.find((a) => a.key === CALL_ID)?.status).toBe('completed')

    // 批2：子代理续跑 turn2（跨批到达）——恢复 running
    h.batch!(CHILD, [
      ev('turn.started', { messageId: t2 }, t2),
      ev('model.streaming', { kind: 'text_delta', delta: '第二轮' }, t2),
    ])
    vi.advanceTimersByTime(500)
    const activity = useStore.getState().subagentActivities.find((a) => a.key === CALL_ID)
    expect(activity?.status).toBe('running') // 续轮恢复（防误终态被防降级锁死）
  })
})
