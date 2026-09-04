/**
 * 目标模式（session/goal）功能测试（store 级，2026-09-03）
 *
 * 锁定（diag-goal*.py 协议实测定案的形状）：
 * 1. /goal set → 乐观出卡 + goalManage op 下发；goalManaged 回执权威落地
 * 2. goalManaged error 回执 → lastError 提示 + show 校准下发
 * 3. session.updated 目标 payload（run_started/status_updated/usage_accounted）实时推进
 * 4. cleared payload → goal 清空
 * 5. messages 响应 goalTarget/goalStats 恢复（切会话首拉路径）
 * 6. goal-continuation / goal_state_change 合成消息隐藏，不进消息列表
 * 7. goal_verification timeline 消息保留（校验分隔卡渲染数据源）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null
let streamHandler: ((sid: string, event: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamHandler = fn },
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import { isHiddenSyntheticMessage } from '@/utils/parseNotification'
import type { ZCodeMessage } from '@/types/messages'

function dispatch(msg: Record<string, unknown>) {
  messageHandler?.(msg)
}

function dispatchStreamEvent(type: string, payload: Record<string, unknown>, sessionId = 'sess_g') {
  streamHandler?.(sessionId, { type, seq: 1, sessionId, timestamp: Date.now(), payload })
}

const MOCK_TARGET = {
  targetID: 'target_x',
  objective: '重构登录页并保持测试通过',
  summaryTitle: '重构登录页',
  status: 'active',
  tokensUsed: 1000,
  timeUsedSeconds: 30,
  tokenBudget: null,
}

describe('目标模式', () => {
  beforeEach(() => {
    // 绑定桥接 handler（幂等；messageHandler/streamHandler 在此捕获）
    useStore.getState().init()
    useStore.setState({
      currentSessionId: 'sess_g',
      goal: null,
      lastError: null,
      streaming: false,
      messages: [],
      queuedMessages: [],
      pendingGoalCreation: null,
    })
    sentRequests.length = 0
  })

  it('goalManage set：乐观出卡并下发 goalManage op', () => {
    useStore.getState().goalManage('set', '  重构登录页  ')
    expect(useStore.getState().goal?.objective).toBe('重构登录页')
    expect(useStore.getState().goal?.status).toBe('active')
    const op = sentRequests.find((r) => r.op === 'goalManage')
    expect(op).toMatchObject({ sessionId: 'sess_g', action: 'set', objective: '重构登录页' })
  })

  it('goalManage set：乐观插入用户消息（目标文本，/goal 前缀服务端剥掉）', () => {
    useStore.getState().goalManage('set', '当前目录结构')
    const msgs = useStore.getState().messages
    // set 落库的 user 消息只含目标文本；实时流 turn.started 只建 assistant 消息，
    // 不乐观插入则目标轮整段无用户气泡（0.3.2 真机反馈）
    expect(msgs).toHaveLength(1)
    expect(msgs[0].info.role).toBe('user')
    expect(msgs[0].info.id.startsWith('local_u_')).toBe(true)
    expect((msgs[0].parts[0] as { text: string }).text).toBe('当前目录结构')
  })

  it('goalManaged error：乐观用户消息随目标卡回滚（服务端拒绝时消息不会落地）', () => {
    useStore.getState().goalManage('set', '目标B')
    expect(useStore.getState().messages).toHaveLength(1)
    dispatch({ op: 'goalManaged', sessionId: 'sess_g', action: 'set', error: 'Cannot manage goals while a prompt is running' })
    expect(useStore.getState().messages).toHaveLength(0)
  })

  it('goalManaged 成功回执：乐观用户消息保留（由回合结束全量重拉的真身替换）', () => {
    useStore.getState().goalManage('set', '目标A')
    dispatch({
      op: 'goalManaged', sessionId: 'sess_g', action: 'set',
      target: MOCK_TARGET, goalStats: { iterationCount: 1, tokensUsed: 100, timeUsedSeconds: 5 },
    })
    expect(useStore.getState().messages).toHaveLength(1)
  })

  it('goalManaged 回执：target/goalStats 权威落地', () => {
    useStore.getState().goalManage('set', '目标A')
    dispatch({
      op: 'goalManaged', sessionId: 'sess_g', action: 'set',
      target: MOCK_TARGET,
      goalStats: { iterationCount: 3, tokensUsed: 2000, timeUsedSeconds: 60, toolCallCount: 5 },
    })
    const goal = useStore.getState().goal
    expect(goal?.targetId).toBe('target_x')
    expect(goal?.status).toBe('active')
    expect(goal?.iterationCount).toBe(3)
    // target.tokensUsed 非零时权威（goalStats 仅回退）
    expect(goal?.tokensUsed).toBe(1000)
  })

  it('goalManaged 回执：target 统计缺失时回退 goalStats', () => {
    useStore.getState().goalManage('set', '目标A')
    dispatch({
      op: 'goalManaged', sessionId: 'sess_g', action: 'set',
      target: { ...MOCK_TARGET, tokensUsed: 0, timeUsedSeconds: 0 },
      goalStats: { iterationCount: 3, tokensUsed: 2000, timeUsedSeconds: 60 },
    })
    expect(useStore.getState().goal?.tokensUsed).toBe(2000)
    expect(useStore.getState().goal?.timeUsedSeconds).toBe(60)
  })

  it('replace 换目标：统计/摘要/轮次不继承旧目标（服务端按 target 独立记账）', () => {
    // 旧目标真身（有真实 targetId 与统计；target.tokensUsed 非零时 target 权威）
    dispatch({
      op: 'goalManaged', sessionId: 'sess_g', action: 'set',
      target: MOCK_TARGET, goalStats: { iterationCount: 4, tokensUsed: 5000, timeUsedSeconds: 90 },
    })
    expect(useStore.getState().goal?.tokensUsed).toBe(1000)
    // 换新目标：新 targetId + 统计 0（真实值，尚未记账）、摘要未生成
    dispatch({
      op: 'goalManaged', sessionId: 'sess_g', action: 'replace',
      target: { ...MOCK_TARGET, targetID: 'target_new', objective: '新目标', summaryTitle: null, tokensUsed: 0, timeUsedSeconds: 0 },
      goalStats: { iterationCount: 1, tokensUsed: 0, timeUsedSeconds: 0 },
    })
    const goal = useStore.getState().goal
    expect(goal?.objective).toBe('新目标')
    // 权威 0 不得被 || 链吞成旧目标值（replace 后耗时/token 永不重置的根因）
    expect(goal?.tokensUsed).toBe(0)
    expect(goal?.timeUsedSeconds).toBe(0)
    expect(goal?.iterationCount).toBe(1)
    expect(goal?.summaryTitle).toBeNull()
  })

  it('goalManage set 乐观卡统计从零起（不继承旧目标）', () => {
    useStore.setState({ goal: { targetId: 'target_old', objective: '旧目标', status: 'active', tokensUsed: 5000, timeUsedSeconds: 90, iterationCount: 4, syncedAt: Date.now() } })
    useStore.getState().goalManage('set', '新目标')
    const goal = useStore.getState().goal
    expect(goal?.objective).toBe('新目标')
    expect(goal?.tokensUsed).toBe(0)
    expect(goal?.timeUsedSeconds).toBe(0)
    expect(goal?.iterationCount).toBe(1)
  })

  it('goalManaged error：置 lastError 并下发 show 校准', () => {
    useStore.getState().goalManage('set', '目标B')
    dispatch({ op: 'goalManaged', sessionId: 'sess_g', action: 'set', error: 'Cannot manage goals while a prompt is running' })
    expect(useStore.getState().lastError).toContain('prompt')
    expect(sentRequests.some((r) => r.op === 'goalManage' && r.action === 'show')).toBe(true)
  })

  it('session.updated 目标 payload：状态实时推进', () => {
    dispatchStreamEvent('session.updated', { action: 'set', source: 'command', target: MOCK_TARGET })
    expect(useStore.getState().goal?.objective).toBe('重构登录页并保持测试通过')

    dispatchStreamEvent('session.updated', {
      action: 'status_updated', source: 'runtime',
      target: { ...MOCK_TARGET, status: 'paused' },
    })
    expect(useStore.getState().goal?.status).toBe('paused')
  })

  it('session.updated cleared payload：目标清空', () => {
    useStore.setState({ goal: { targetId: 'target_x', objective: 'x', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, iterationCount: 1 } })
    dispatchStreamEvent('session.updated', { action: 'cleared', source: 'command', target: null })
    expect(useStore.getState().goal).toBeNull()
  })

  it('其他会话的目标事件不串台', () => {
    dispatchStreamEvent('session.updated', { action: 'set', source: 'command', target: MOCK_TARGET }, 'sess_other')
    expect(useStore.getState().goal).toBeNull()
  })

  it('messages 响应 goalTarget/goalStats 恢复目标状态', () => {
    dispatch({ op: 'messages', sessionId: 'sess_g', messages: [], goalTarget: MOCK_TARGET, goalStats: { iterationCount: 2, tokensUsed: 1000, timeUsedSeconds: 30 } })
    const goal = useStore.getState().goal
    expect(goal?.objective).toBe('重构登录页并保持测试通过')
    expect(goal?.iterationCount).toBe(2)
  })

  it('goal-continuation / goal_state_change 合成消息隐藏', () => {
    const cont = { role: 'user', id: 'm1', time: { created: 1 }, metadata: { source: 'goal-continuation', visibility: 'model-only' } }
    const cleared = { role: 'user', id: 'm2', time: { created: 2 }, metadata: { source: 'goal_state_change', visibility: 'model-only' } }
    const normal = { role: 'user', id: 'm3', time: { created: 3 } }
    expect(isHiddenSyntheticMessage(cont as never)).toBe(true)
    expect(isHiddenSyntheticMessage(cleared as never)).toBe(true)
    expect(isHiddenSyntheticMessage(normal as never)).toBe(false)
  })

  it('goal-continuation 消息在快照落地时被过滤出消息列表', () => {
    const contMsg: ZCodeMessage = {
      info: { role: 'user', id: 'm_cont', time: { created: 1 }, metadata: { source: 'goal-continuation', visibility: 'model-only' } } as never,
      parts: [{ type: 'text', text: '<system-reminder>Continue working toward the active session goal.</system-reminder>' }],
    }
    const goalVerifyMsg: ZCodeMessage = {
      info: { role: 'assistant', id: 'msg_goal_verify_t_1', time: { created: 2 } } as never,
      parts: [{
        type: 'timeline', timelineType: 'goal_verification', display: 'separator', status: 'completed',
        goalIteration: 1, verification: { passed: true, reason: '已完成' },
      }] as never,
    }
    dispatch({ op: 'messages', sessionId: 'sess_g', messages: [contMsg, goalVerifyMsg] })
    const msgs = useStore.getState().messages
    expect(msgs.some((m) => m.info.id === 'm_cont')).toBe(false)
    expect(msgs.some((m) => m.info.id === 'msg_goal_verify_t_1')).toBe(true)
  })

  it('无参 /goal（show）无目标时给用法提示', () => {
    useStore.getState().goalManage('show')
    expect(useStore.getState().lastError).toBeTruthy()
    expect(sentRequests.some((r) => r.op === 'goalManage' && r.action === 'show')).toBe(false)
  })

  it('clear：立即清卡', () => {
    useStore.setState({ goal: { targetId: 't', objective: 'x', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, iterationCount: 1 } })
    useStore.getState().goalManage('clear')
    expect(useStore.getState().goal).toBeNull()
  })

  // ============ 0.3.2 实测修复（diag-goal-live.py）============

  it('新会话（待命态）set：暂存并建会话，subscribe 回执后自动补发（防 op 并发竞态断流）', () => {
    useStore.setState({ currentSessionId: null, pendingGoalCreation: null })
    useStore.getState().goalManage('set', '新会话目标')
    // 暂存 + 触发建会话（控制轮需要会话语境）
    expect(useStore.getState().pendingGoalCreation?.objective).toBe('新会话目标')
    expect(sentRequests.some((r) => r.op === 'createSession')).toBe(true)
    expect(sentRequests.some((r) => r.op === 'goalManage')).toBe(false)
    // 会话建好：暂存保留（订阅未回执前不下发——Kotlin op 并发，goal 抢跑会让
    // 控制轮 turn.started 在订阅白名单生效前被丢，实时流整段断）
    dispatch({ op: 'createSession', sessionId: 'sess_new' })
    expect(useStore.getState().currentSessionId).toBe('sess_new')
    expect(useStore.getState().pendingGoalCreation?.objective).toBe('新会话目标')
    expect(sentRequests.some((r) => r.op === 'goalManage')).toBe(false)
    // 订阅回执到达：补发 set
    dispatch({ op: 'subscribed', sessionId: 'sess_new' })
    expect(useStore.getState().pendingGoalCreation).toBeNull()
    expect(sentRequests.some((r) => r.op === 'goalManage' && r.action === 'set' && r.sessionId === 'sess_new' && r.objective === '新会话目标')).toBe(true)
    // 补发即乐观插入用户消息：新会话发目标后立即见到目标气泡（真机反馈：
    // 此前要到回合结束重拉才渲染），回合结束全量重拉被服务端真身替换
    const local = useStore.getState().messages.find((m) => m.info.role === 'user')
    expect(local?.info.id.startsWith('local_u_')).toBe(true)
  })

  it('新会话非 set 动作（pause/show）：无会话语境给提示，不建会话', () => {
    useStore.setState({ currentSessionId: null, pendingGoalCreation: null })
    useStore.getState().goalManage('pause')
    expect(useStore.getState().lastError).toBeTruthy()
    expect(sentRequests.some((r) => r.op === 'createSession')).toBe(false)
  })

  it('快照落地保留"校验中"（目标仍 active 时常规重拉不冲掉，终态清除）', () => {
    dispatchStreamEvent('session.updated', { action: 'run_finished', source: 'runtime', target: { ...MOCK_TARGET, status: 'active' } })
    expect(useStore.getState().goal?.verifying).toBe(true)
    // 回合结束 300ms 常规重拉（非 goalRefresh）：快照无校验信号，active 态保持
    dispatch({ op: 'messages', sessionId: 'sess_g', messages: [], goalTarget: { ...MOCK_TARGET, status: 'active' }, goalStats: { iterationCount: 1 } })
    expect(useStore.getState().goal?.verifying).toBe(true)
    // 终态快照不再保持
    dispatch({ op: 'messages', sessionId: 'sess_g', messages: [], goalTarget: { ...MOCK_TARGET, status: 'complete' } })
    expect(useStore.getState().goal?.verifying).toBeUndefined()
  })

  it('run_finished → 卡片转校验中；run_started → 清除并定向重拉（goalRefresh）', () => {
    vi.useFakeTimers()
    try {
      dispatchStreamEvent('session.updated', { action: 'set', source: 'command', target: { ...MOCK_TARGET, iterationCount: 1 } })
      dispatchStreamEvent('session.updated', { action: 'run_finished', source: 'runtime', target: { ...MOCK_TARGET, tokensUsed: 36745, timeUsedSeconds: 11 } })
      expect(useStore.getState().goal?.verifying).toBe(true)
      expect(useStore.getState().goal?.tokensUsed).toBe(36745)

      dispatchStreamEvent('session.updated', { action: 'run_started', source: 'runtime', target: { ...MOCK_TARGET, iterationCount: 2 } })
      expect(useStore.getState().goal?.verifying).toBeUndefined()
      // 轮边界定向重拉（800ms 防抖后）：goalRefresh 标记让 streaming 守卫放行
      vi.advanceTimersByTime(900)
      expect(sentRequests.some((r) => r.op === 'messages' && r.goalRefresh === true)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('续跑轮流式断头自愈（0.3.2 真机 goal 多轮缺陷）：verifying 吞壳后 delta 到达补建流式壳', () => {
    // 事件顺序实锤：run_finished（verifying=true）→ 下一工作轮 turn.started
    // 先于 run_started(session.updated) 到达 → verifying 守卫吞壳（防校验器
    // 空气泡）→ 此前正文 delta 因无 streamingMessageId 全丢 = 整轮无流式、
    // 轮末重拉才整段渲染。修复：产出型 delta 到达即就地补建流式壳（id 用
    // 协议 assistantMessageId，与落库真身同 id，轮末对账天然去重）
    dispatchStreamEvent('session.updated', { action: 'run_finished', source: 'runtime', target: { ...MOCK_TARGET, status: 'active' } })
    expect(useStore.getState().goal?.verifying).toBe(true)
    dispatchStreamEvent('turn.started', { messageId: 'm_user_next' })
    expect(useStore.getState().streaming).toBe(true)
    expect(useStore.getState().streamingMessageId).toBeNull()
    dispatchStreamEvent('model.streaming', { kind: 'text_delta', delta: '第 2 轮', assistantMessageId: 'm_a_real' })
    dispatchStreamEvent('model.streaming', { kind: 'text_delta', delta: '开始执行', assistantMessageId: 'm_a_real' })
    const st = useStore.getState()
    expect(st.streamingMessageId).toBe('m_a_real')
    const shell = st.messages.find((m) => m.info.id === 'm_a_real')
    expect(shell?.info.role).toBe('assistant')
    expect((shell?.parts?.[0] as { text?: string })?.text).toBe('第 2 轮开始执行')
  })

  it('校验器回合零 delta 不建壳（吞壳守卫保持：空气泡/闪屏不回归）', () => {
    useStore.setState({ streaming: false, streamingMessageId: null })
    dispatchStreamEvent('session.updated', { action: 'run_finished', source: 'runtime', target: { ...MOCK_TARGET, status: 'active' } })
    const before = useStore.getState().messages.length
    dispatchStreamEvent('turn.started', { messageId: 'm_verify_turn' })
    expect(useStore.getState().messages.length).toBe(before)
    // 校验窗口结束（run_started 到达）仍无产出 → 无壳
    dispatchStreamEvent('session.updated', { action: 'run_started', source: 'runtime', target: { ...MOCK_TARGET, iterationCount: 2 } })
    expect(useStore.getState().messages.length).toBe(before)
    expect(useStore.getState().streamingMessageId).toBeNull()
  })

  it('goalRefresh 响应：streaming 中增量合并（校验卡插到流式消息前，不顶掉流内容）', () => {
    const userMsg: ZCodeMessage = { info: { role: 'user', id: 'm_user', time: { created: 1 } } as never, parts: [{ type: 'text', text: 'go' }] }
    const streamMsg: ZCodeMessage = { info: { role: 'assistant', id: 'm_stream', time: { created: 2 } } as never, parts: [{ type: 'text', text: '正在写' }] }
    const verifyMsg: ZCodeMessage = {
      info: { role: 'assistant', id: 'msg_goal_verify_t_1', time: { created: 3 } } as never,
      parts: [{ type: 'timeline', timelineType: 'goal_verification', display: 'separator', goalIteration: 1, verification: { passed: true } }] as never,
    }
    useStore.setState({
      streaming: true, streamingMessageId: 'm_stream', messages: [userMsg, streamMsg],
      goal: { targetId: 't', objective: '目标', status: 'active', tokensUsed: 1000, timeUsedSeconds: 10, iterationCount: 1 },
    })
    dispatch({ op: 'messages', sessionId: 'sess_g', goalRefresh: true, messages: [userMsg, verifyMsg], goalStats: { iterationCount: 2, tokensUsed: 5000, timeUsedSeconds: 40 } })
    const msgs = useStore.getState().messages.map((m) => m.info.id)
    expect(msgs).toEqual(['m_user', 'msg_goal_verify_t_1', 'm_stream'])
    expect(useStore.getState().streamingMessageId).toBe('m_stream')
    // goal 统计随定向刷新校准
    expect(useStore.getState().goal?.tokensUsed).toBe(5000)
  })

  it('goalRefresh 响应：非 streaming 走权威全量落地', () => {
    useStore.setState({ streaming: false, streamingMessageId: null, messages: [] })
    dispatch({ op: 'messages', sessionId: 'sess_g', goalRefresh: true, messages: [], goalTarget: MOCK_TARGET, goalStats: { iterationCount: 1 } })
    expect(useStore.getState().goal?.objective).toBe('重构登录页并保持测试通过')
  })

  it('goalRefresh 增量合并：user 真身与乐观 local_u_ 同文本时去重防双条（messageId 缺失兜底）', () => {
    // turn.started 未带 messageId 时流式 assistant 用 fallback id，user 真身不再
    // 被撞车滤掉而进入 incoming——须按文本识别并删除乐观版
    const localUser: ZCodeMessage = { info: { role: 'user', id: 'local_u_1', time: { created: 1 } } as never, parts: [{ type: 'text', text: '当前目录结构' }] }
    const streamMsg: ZCodeMessage = { info: { role: 'assistant', id: 'stream_fallback', time: { created: 2 } } as never, parts: [{ type: 'text', text: '正在分析' }] }
    const serverUser: ZCodeMessage = { info: { role: 'user', id: 'msg_real', time: { created: 3 } } as never, parts: [{ type: 'text', text: '当前目录结构' }] }
    useStore.setState({
      streaming: true, streamingMessageId: 'stream_fallback', messages: [localUser, streamMsg],
      goal: { targetId: 't', objective: '当前目录结构', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, iterationCount: 1 },
    })
    dispatch({ op: 'messages', sessionId: 'sess_g', goalRefresh: true, messages: [serverUser, streamMsg] })
    const ids = useStore.getState().messages.map((m) => m.info.id)
    // 乐观版被真身替换（不双条），真身插到流式消息之前
    expect(ids).toEqual(['msg_real', 'stream_fallback'])
  })
})
