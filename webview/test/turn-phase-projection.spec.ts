/**
 * 运行相位投影到流式标志（重开会话/切回会话时输入框按钮态与事实一致）：
 *
 * 场景（2026-09-28 用户报障）：回合进行中关闭标签，再从历史列表打开——新 webview
 * 没经历过该会话的 turn.started（快照回放有意不置流式=状态重建非实时相位），
 * 实时流接上了但按钮停在发送态。Kotlin 订阅完成时查 V4FrameMapper 活跃投影，
 * 回合在跑则补推 sessionTurnPhase(running)；前端在相位分支补投影 streaming。
 *
 * 断言：
 *   1. running 相位 + 当前会话 + 未在流式 → 补置 streaming=true，列表行运行中
 *   2. running 相位 + 非当前会话 → 只更新列表行/集合，不动 streaming
 *   3. ended 相位 → 不置 streaming（收尾由事件归约负责）
 *   4. 已在流式时 running 相位幂等（不重复投影/不清等待态）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// @vitest-environment jsdom
// （ended 相位走 scheduleTurnEndListRefresh 的 window.setTimeout 防抖，需 DOM 环境）

// ---- mock 桥接层：捕获 sendToJava，手动注入广播消息 ----
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

const SID = 'sess_reopen_1'

function pushPhase(sessionId: string, phase: 'running' | 'ended'): void {
  messageHandler!({ op: 'sessionTurnPhase', sessionId, phase })
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
    messages: [],
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    lastError: null,
    remoteRunningTurns: {},
    sessions: [
      { sessionId: SID, title: '运行中会话', status: 'idle', workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 1 },
      { sessionId: 'sess_other_2', title: '别的会话', status: 'idle', workspacePath: 'G:\\mock', createdAt: 2, updatedAt: 2 },
    ],
  })
})

describe('sessionTurnPhase 运行相位投影 streaming', () => {
  it('当前会话 running 相位补置 streaming=true（重开会话按钮停止态）', () => {
    pushPhase(SID, 'running')
    const st = useStore.getState()
    expect(st.streaming).toBe(true)
    expect(st.remoteRunningTurns[SID]).toBeGreaterThan(0)
    expect(st.sessions.find((s) => s.sessionId === SID)?.status).toBe('running')
  })

  it('非当前会话 running 相位只更新列表，不投影 streaming', () => {
    pushPhase('sess_other_2', 'running')
    const st = useStore.getState()
    expect(st.streaming).toBe(false)
    expect(st.remoteRunningTurns['sess_other_2']).toBeGreaterThan(0)
  })

  it('ended 相位不置 streaming（收尾由 turn.completed 事件归约负责）', () => {
    pushPhase(SID, 'ended')
    expect(useStore.getState().streaming).toBe(false)
  })

  it('已在流式中收到 running 相位幂等（不清 waitingSince 等流式伴随态）', () => {
    useStore.setState({ streaming: true, waitingSince: 12345 })
    pushPhase(SID, 'running')
    const st = useStore.getState()
    expect(st.streaming).toBe(true)
    expect(st.waitingSince).toBe(12345)
  })
})

describe('投影 streaming 后的首拉应答（messages 守卫豁免）', () => {
  it('loadingMessages=true 时守卫放行：首拉快照落地并复位加载态（投影置 streaming 不挡首拉）', () => {
    // 重开运行中会话的时序：selectSession 置 loadingMessages → 投影先到置 streaming →
    // 首拉应答后到——守卫若照丢，「加载消息中」卡到回合结束（2026-09-29 真机）
    useStore.setState({ streaming: true, loadingMessages: true, messages: [] })
    messageHandler!({ op: 'messages', sessionId: SID, messages: [] })
    const st = useStore.getState()
    expect(st.loadingMessages).toBe(false)
    expect(st.streaming).toBe(true) // 落地不清流式标志（回合还在跑，按钮保持停止态）
  })

  it('正常流式中的重拉仍被守卫丢弃（loadingMessages=false 不豁免，防断流/叠字）', () => {
    useStore.setState({
      streaming: true,
      loadingMessages: false,
      messages: [{ info: { id: 'keep' } } as never],
    })
    messageHandler!({ op: 'messages', sessionId: SID, messages: [] })
    const st = useStore.getState()
    expect(st.messages).toHaveLength(1)
    expect((st.messages[0] as { info: { id: string } }).info.id).toBe('keep')
  })
})
