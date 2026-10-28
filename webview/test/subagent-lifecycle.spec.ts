/**
 * 后台子代理 stopped 生命周期收尾回归测试（缺陷 O，2026-08-20）
 *
 * 复现缺陷：后台子代理（Agent 工具 run_in_background）启动即返回——
 * result 事件早于转发事件创建活动条目，markActivityOutcome 当时无对象可标记；
 * 随后转发事件创建的活动停在 running，而 stopped 生命周期到达时旧逻辑
 * 只刷新详情弹窗（且仅当弹窗开着），既不收尾活动也不拉权威列表 →
 * 底部栏 0/1 转圈直到主回合 turnEnded 才自愈（长回合内永久卡住）。
 *
 * 断言：
 *   1. stopped 到达 → 活动即时 completed/failed，底部栏 agents 同步收尾
 *   2. stopped 到达 → 触发一次 op=subagents 权威刷新（无论弹窗是否开着）
 *   3. 已 completed 的活动不被后续 stopped 重复翻转（前台代理收尾早于 stopped）
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

import { useStore, stopSubagentStatusPolling } from '@/store/useStore'

const SID = 'sess_bg_agent_1'

function pushEvent(type: string, payload: Record<string, unknown>): void {
  streamEventHandler!(SID, {
    type, seq: 100, sessionId: SID, turnId: 'turn_1', timestamp: Date.now(), payload,
  })
}

/** 注入一条子代理转发事件（source=subagent），按需创建/更新活动条目 */
function pushSubagentTool(kind: string, parentToolCallId: string, toolCallId: string): void {
  pushEvent('tool.updated', {
    kind,
    source: 'subagent',
    parentToolCallId,
    childSessionId: `sess_child_${parentToolCallId}`,
    agentId: `agent_${parentToolCallId}`,
    toolCallId,
    toolName: 'Read',
    background: true,
  })
}

/** 注入 subagent.lifecycle 通知 */
function pushLifecycle(phase: 'spawned' | 'stopped', parentToolCallId: string, status?: string): void {
  pushEvent('session.updated', {
    kind: 'subagent.lifecycle',
    phase,
    agentId: `agent_${parentToolCallId}`,
    childSessionId: `sess_child_${parentToolCallId}`,
    parentToolCallId,
    background: true,
    ...(status ? { status } : {}),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  stopSubagentStatusPolling() // 清掉上一用例遗留的轮询句柄（假时钟换代后句柄失效）
  sentRequests.length = 0
  useStore.getState().init() // 注册桥接回调（onMessage/onStreamEvent）
  sentRequests.length = 0 // 清掉 init 触发的请求
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [],
    streaming: true,
    streamingMessageId: 'msg_a1',
    waitingSince: null,
    queuedMessages: [],
    subagentActivities: [],
    subagents: [],
    childSessionKeys: {},
    sessions: [{ sessionId: SID, title: 'sess_bg_agent_1', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('后台子代理 stopped 生命周期收尾（缺陷 O）', () => {
  it('stopped 到达 → 活动即时 completed、底部栏同步、触发权威刷新', () => {
    // ── 1. 后台代理开始干活：转发事件创建活动（running），Agent 工具的
    //      启动 ack 已错过的场景 ──
    pushSubagentTool('started', 'call_bg_1', 'call_t1')
    let st = useStore.getState()
    expect(st.subagentActivities).toHaveLength(1)
    expect(st.subagentActivities[0].status).toBe('running')
    expect(st.agents.find((a) => a.callID === 'call_bg_1')?.status).toBe('running')

    // ── 2. 子代理真实完成：stopped 到达（弹窗未开）──
    sentRequests.length = 0
    pushLifecycle('stopped', 'call_bg_1', 'completed')

    // 活动/底部栏即时收尾（缺陷点：此前永远停在 running）
    st = useStore.getState()
    const act = st.subagentActivities.find((a) => a.key === 'call_bg_1')
    expect(act?.status).toBe('completed')
    expect(act?.endedAt).toBeTruthy()
    expect(st.agents.find((a) => a.callID === 'call_bg_1')?.status).toBe('completed')

    // 权威刷新已发出（summary/completedAt 由 RPC 补齐）
    expect(sentRequests.some((r) => r.op === 'subagents' && r.sessionId === SID)).toBe(true)
  })

  it('stopped 带 failed 状态 → 活动标 failed、底部栏显示 error', () => {
    pushSubagentTool('started', 'call_bg_2', 'call_t1')
    pushLifecycle('stopped', 'call_bg_2', 'failed')

    const st = useStore.getState()
    expect(st.subagentActivities.find((a) => a.key === 'call_bg_2')?.status).toBe('failed')
    expect(st.agents.find((a) => a.callID === 'call_bg_2')?.status).toBe('error')
  })

  it('已 completed 的活动不被后续 stopped 翻转（前台代理收尾早于 stopped）', () => {
    pushSubagentTool('started', 'call_bg_3', 'call_t1')
    // 前台路径：Agent 工具 result 先把活动收尾成 completed
    pushEvent('tool.updated', { kind: 'result', toolCallId: 'call_bg_3', result: { success: true } })
    expect(useStore.getState().subagentActivities[0].status).toBe('completed')

    // stopped 迟到且带 failed：不得把 completed 翻成 failed
    pushLifecycle('stopped', 'call_bg_3', 'failed')
    expect(useStore.getState().subagentActivities[0].status).toBe('completed')
  })
})

describe('子会话 turn 结束收尾（主路径：session/subscribe 流无 lifecycle 事件）', () => {
  it('子会话 turn.completed 到达 → 活动即时收尾 + 触发权威刷新', () => {
    // 转发事件创建活动并自动注册子会话（spawned 缺失时的兜底注册路径）
    pushSubagentTool('started', 'call_bg_4', 'call_t1')
    expect(useStore.getState().subagentActivities[0].status).toBe('running')
    expect(useStore.getState().childSessionKeys['sess_child_call_bg_4']).toBe('call_bg_4')

    // 子会话原生流：turn.started → turn.completed（sessionId = 子会话）
    sentRequests.length = 0
    const childSid = 'sess_child_call_bg_4'
    streamEventHandler!(childSid, {
      type: 'turn.started', seq: 200, sessionId: childSid, turnId: 'ct_1', timestamp: Date.now(),
      payload: { turnNumber: 1, messageId: 'child_m1' },
    })
    streamEventHandler!(childSid, {
      type: 'turn.completed', seq: 201, sessionId: childSid, turnId: 'ct_1', timestamp: Date.now(),
      payload: {},
    })

    const st = useStore.getState()
    expect(st.subagentActivities.find((a) => a.key === 'call_bg_4')?.status).toBe('completed')
    expect(st.agents.find((a) => a.callID === 'call_bg_4')?.status).toBe('completed')
    expect(sentRequests.some((r) => r.op === 'subagents' && r.sessionId === SID)).toBe(true)
  })

  it('子会话 turn.failed → 活动标 failed、底部栏 error', () => {
    pushSubagentTool('started', 'call_bg_5', 'call_t1')
    const childSid = 'sess_child_call_bg_5'
    streamEventHandler!(childSid, {
      type: 'turn.failed', seq: 202, sessionId: childSid, turnId: 'ct_2', timestamp: Date.now(),
      payload: { error: { type: 'runtime', message: 'boom' } },
    })
    const st = useStore.getState()
    expect(st.subagentActivities.find((a) => a.key === 'call_bg_5')?.status).toBe('failed')
    expect(st.agents.find((a) => a.callID === 'call_bg_5')?.status).toBe('error')
  })
})

describe('权威轮询兜底（快子代理场景：事件路径全部错过）', () => {
  it('running 活动期间每 3s 拉权威列表；RPC 报告 ended 后活动收尾、轮询自停', () => {
    // 转发事件创建 running 活动 → 轮询启动
    pushSubagentTool('started', 'call_bg_8', 'call_t1')
    sentRequests.length = 0
    vi.advanceTimersByTime(3100)
    expect(sentRequests.some((r) => r.op === 'subagents' && r.sessionId === SID)).toBe(true)

    // RPC 返回 ended：活动收尾 + 底部栏翻转
    messageHandler!({
      op: 'subagents', sessionId: SID,
      data: {
        running: [],
        ended: { items: [{ toolCallId: 'call_bg_8', status: 'completed', title: '统计组件' }] },
      },
    })
    const st = useStore.getState()
    expect(st.subagentActivities.find((a) => a.key === 'call_bg_8')?.status).toBe('completed')
    expect(st.agents.find((a) => a.callID === 'call_bg_8')?.status).toBe('completed')

    // 无 running 活动 → 轮询自停（推进 7s 不再有请求）
    sentRequests.length = 0
    vi.advanceTimersByTime(7000)
    expect(sentRequests.some((r) => r.op === 'subagents')).toBe(false)
  })

  it('RPC 报告 failed → 活动 failed、底部栏 error', () => {
    pushSubagentTool('started', 'call_bg_9', 'call_t1')
    messageHandler!({
      op: 'subagents', sessionId: SID,
      data: {
        running: [],
        ended: { items: [{ toolCallId: 'call_bg_9', status: 'failed', title: '失败任务' }] },
      },
    })
    const st = useStore.getState()
    expect(st.subagentActivities.find((a) => a.key === 'call_bg_9')?.status).toBe('failed')
    expect(st.agents.find((a) => a.callID === 'call_bg_9')?.status).toBe('error')
  })

  it('防降级：过期的 RPC running 不得把事件已收尾的活动盖回（前台代理实测回归）', () => {
    // 活动创建（running）→ 轮询拿到 running 快照（完成前最后一次 RPC）
    pushSubagentTool('started', 'call_bg_10', 'call_t1')
    messageHandler!({
      op: 'subagents', sessionId: SID,
      data: {
        running: [{ toolCallId: 'call_bg_10', status: 'running', title: '前台任务' }],
        ended: { items: [] },
      },
    })
    expect(useStore.getState().agents.find((a) => a.callID === 'call_bg_10')?.status).toBe('running')

    // 父会话 Agent 工具 result 事件 → 活动即时收尾；此后轮询自停，不再有新 RPC
    pushEvent('tool.updated', { kind: 'result', toolCallId: 'call_bg_10', result: { success: true } })

    const st = useStore.getState()
    // 缓存确实过期（仍是 running），但活动/底部栏不得回退——修复点
    expect(st.subagents.find((x) => x.toolCallId === 'call_bg_10')?.status).toBe('running')
    expect(st.subagentActivities.find((a) => a.key === 'call_bg_10')?.status).toBe('completed')
    expect(st.agents.find((a) => a.callID === 'call_bg_10')?.status).toBe('completed')
  })
})

describe('消息重拉的通知扫描自愈（兜底：子会话流与 lifecycle 都错过）', () => {
  /** 构造合成 task-notification 消息（实测结构：synthetic + source + XML text part）*/
  function notificationMessage(toolUseId: string, status: string) {
    return {
      info: {
        role: 'user', synthetic: true, source: 'background_task',
        semantics: { origin: 'agent_runtime', kind: 'background_notification' },
        id: `msg_ntf_${toolUseId}`, sessionID: SID, time: { created: 1 },
      },
      parts: [{
        type: 'text',
        text: `<task-notification><task-id>agent_x1</task-id><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status><summary>Agent Explore task "demo" completed</summary></task-notification>`,
      }],
    }
  }

  it('重拉带回 task-notification → running 活动自愈收尾 + 权威刷新', () => {
    pushSubagentTool('started', 'call_bg_6', 'call_t1')
    expect(useStore.getState().subagentActivities[0].status).toBe('running')

    // 回合结束后的权威重拉（非流式期间到达）
    useStore.setState({ streaming: false, streamingMessageId: null })
    sentRequests.length = 0
    messageHandler!({ op: 'messages', sessionId: SID, messages: [notificationMessage('call_bg_6', 'completed')] })

    const st = useStore.getState()
    expect(st.subagentActivities.find((a) => a.key === 'call_bg_6')?.status).toBe('completed')
    expect(st.agents.find((a) => a.callID === 'call_bg_6')?.status).toBe('completed')
    expect(sentRequests.some((r) => r.op === 'subagents' && r.sessionId === SID)).toBe(true)
  })

  it('通知 status=failed → 活动 failed；后台 Bash 的 tool-use-id 不在活动中则无副作用', () => {
    pushSubagentTool('started', 'call_bg_7', 'call_t1')
    useStore.setState({ streaming: false, streamingMessageId: null })
    messageHandler!({
      op: 'messages', sessionId: SID,
      messages: [notificationMessage('call_bg_7', 'failed'), notificationMessage('call_bash_9', 'completed')],
    })
    const st = useStore.getState()
    expect(st.subagentActivities.find((a) => a.key === 'call_bg_7')?.status).toBe('failed')
    expect(st.subagentActivities.some((a) => a.key === 'call_bash_9')).toBe(false)
  })
})
