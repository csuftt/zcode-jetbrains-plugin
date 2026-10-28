/**
 * 计划审批模式守卫（缺陷CG，2026-09-18）
 *
 * 缺陷：v2 服务端把「拒绝」的 ExitPlanMode 工具结果也记 success——batch 收尾
 * errorCount=0，前端缺陷E推断按「!isError = 已批准」把模式指示器乐观切到
 * prePlanMode ?? 'yolo'（完全控制），与服务端实际仍留在 plan 的权限面分叉
 * （v1 下拒绝带 errorCount≥1 不触发，故 v1 时代从未出现）；意见式拒绝同根因。
 *
 * 修复：审批弹窗是插件自绘，用户应答前端确切知道——PlanApprovalDialog 三个
 * handler 写 planApprovalAnswer 标记，applyModeEventToPatch 的 exit_plan 分支
 * 只认 'approve'（decline/feedback/无标记安全侧留在 plan），标记消费/进 plan 即清。
 *
 * 断言：
 *   1. 裸拒绝（decline + v2 形态 errorCount=0）：UI 留在 plan
 *   2. 意见式拒绝（feedback）：UI 留在 plan
 *   3. 无标记（5min 超时 / 多标签无弹窗 / webview 重载）：安全侧留在 plan
 *   4. 批准（approve，batch 兜底路径）：切到 prePlanMode（yolo），标记消费即清
 *   5. v1 形态拒绝（errorCount=1）：工具卡落 error、UI 留在 plan（原行为不回归）
 *   6. 幂等：批准乐观更新已切走时，迟到 batch 推断不覆盖
 *   7. enter_plan 重置陈旧标记
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null
let messageHandler: ((msg: Record<string, unknown>) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: Record<string, unknown>) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: () => {},
}))

import { useStore } from '@/store/useStore'

const SID = 'sess_plan_guard_1'
const TC_EXIT = 'tc_exit_plan_1'
const TC_ENTER = 'tc_enter_plan_1'

function pushEvent(type: string, payload: Record<string, unknown>, seq: number): void {
  streamEventHandler!(SID, { type, seq, sessionId: SID, turnId: 'turn_1', timestamp: Date.now(), payload })
}

/** ExitPlanMode 收尾 batch（v2 拒绝形态 errorCount=0；v1 拒绝形态 errorCount=1）。
 *  batch payload 的承载 type 是 tool.updated（handleToolUpdated 内按 kind 分发）*/
function pushBatch(toolCallIds: string[], errorCount: number, seq: number): void {
  streamBatchHandler!(SID, [{
    type: 'tool.updated',
    seq,
    sessionId: SID,
    turnId: 'turn_1',
    timestamp: Date.now(),
    payload: { kind: 'batch', toolCallIds, successCount: toolCallIds.length - errorCount, errorCount },
  }])
}

/** 前置：plan 模式会话 + 回合进行中 + ExitPlanMode 工具卡已建（turn.started 建流式壳）*/
function setupExitPlanTurn(): void {
  pushEvent('turn.started', { turnNumber: 1, messageId: 'msg_shell_1' }, 90)
  pushEvent('model.streaming', {
    kind: 'tool_call', toolCallId: TC_EXIT, toolName: 'ExitPlanMode',
    input: { plan: '# 测试计划\n1. 一步' },
  }, 91)
}

function toolStatus(callId: string): string {
  const st = useStore.getState()
  const shell = st.messages.find((m) => m.info.id === st.streamingMessageId)
  const part = shell?.parts.find((p) => p.type === 'tool' && (p as { callID?: string }).callID === callId)
  return (part as { state?: { status?: string } } | undefined)?.state?.status ?? 'missing'
}

beforeEach(() => {
  vi.useFakeTimers()
  useStore.getState().init()
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [],
    streaming: true,
    streamingMessageId: null,
    currentMode: 'plan',
    prePlanMode: 'yolo',
    planApprovalAnswer: null,
    agentPlanActive: false,
    sessions: [{ sessionId: SID, title: 'plan-guard', status: 'idle', mode: 'plan', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
  })
})

describe('缺陷CG：计划审批应答守卫 exit_plan 推断', () => {
  it('裸拒绝（decline + v2 形态 errorCount=0）：UI 留在 plan，不误切完全控制', () => {
    setupExitPlanTurn()
    useStore.setState({ planApprovalAnswer: 'decline' })

    pushBatch([TC_EXIT], 0, 300)

    const st = useStore.getState()
    expect(st.currentMode).toBe('plan')
    // 标记不被消费（守卫早退），下次进 plan 时才重置
    expect(st.planApprovalAnswer).toBe('decline')
  })

  it('意见式拒绝（feedback + errorCount=0）：UI 留在 plan，回合继续修订', () => {
    setupExitPlanTurn()
    useStore.setState({ planApprovalAnswer: 'feedback' })

    pushBatch([TC_EXIT], 0, 300)

    const st = useStore.getState()
    expect(st.currentMode).toBe('plan')
    expect(st.planApprovalAnswer).toBe('feedback')
  })

  it('无标记（超时自动 decline / 多标签无弹窗 / 重载）：安全侧留在 plan', () => {
    setupExitPlanTurn()
    expect(useStore.getState().planApprovalAnswer).toBeNull()

    pushBatch([TC_EXIT], 0, 300)

    const st = useStore.getState()
    expect(st.currentMode).toBe('plan')
    expect(st.planApprovalAnswer).toBeNull()
  })

  it('批准（approve，batch 兜底路径）：切到 prePlanMode，标记消费即清', () => {
    setupExitPlanTurn()
    useStore.setState({ planApprovalAnswer: 'approve' })

    pushBatch([TC_EXIT], 0, 300)

    const st = useStore.getState()
    expect(st.currentMode).toBe('yolo')
    expect(st.planApprovalAnswer).toBeNull()
    expect(st.agentPlanActive).toBe(false)
    expect(st.prePlanMode).toBeNull()
    // 工具卡正常落 completed（批准收尾形态）
    expect(toolStatus(TC_EXIT)).toBe('completed')
  })

  it('v1 形态拒绝（decline + errorCount=1）：工具卡落 error，UI 留在 plan（原行为不回归）', () => {
    setupExitPlanTurn()
    useStore.setState({ planApprovalAnswer: 'decline' })

    pushBatch([TC_EXIT], 1, 300)

    const st = useStore.getState()
    expect(st.currentMode).toBe('plan')
    expect(toolStatus(TC_EXIT)).toBe('error')
  })

  it('幂等：批准乐观更新已切走 currentMode 时，迟到 batch 推断不覆盖', () => {
    setupExitPlanTurn()
    // PlanApprovalDialog.handleApprove 已乐观切走（currentMode != plan）
    useStore.setState({ planApprovalAnswer: 'approve', currentMode: 'yolo', prePlanMode: null })

    pushBatch([TC_EXIT], 0, 300)

    const st = useStore.getState()
    expect(st.currentMode).toBe('yolo')
  })

  it('enter_plan 重置陈旧标记：再次进入计划模式时 approve 残留被清', () => {
    useStore.setState({ planApprovalAnswer: 'approve', currentMode: 'build', prePlanMode: null })
    pushEvent('turn.started', { turnNumber: 2, messageId: 'msg_shell_2' }, 400)
    // EnterPlanMode 走 kind:'result' 单条收尾（enter_plan 推断在 result 分支，非 batch）
    pushEvent('model.streaming', { kind: 'tool_call', toolCallId: TC_ENTER, toolName: 'EnterPlanMode', input: {} }, 401)
    pushEvent('tool.updated', { kind: 'result', toolCallId: TC_ENTER, result: { success: true, content: 'entered plan mode' } }, 402)

    const st = useStore.getState()
    expect(st.currentMode).toBe('plan')
    expect(st.prePlanMode).toBe('build')
    expect(st.planApprovalAnswer).toBeNull()
    // agent 计划阶段开启（缺陷CG 真根因路径的置位链路）
    expect(st.agentPlanActive).toBe(true)
  })
})

describe('缺陷CG 真根因：agent plan 期间 session 模式推送不翻转指示器', () => {
  /** 回合边界权威推送（真实形态：prompt_completed 携带 session 模式 yolo）*/
  function pushStateUpdated(mode: string, seq: number, reason = 'prompt_completed'): void {
    streamEventHandler!(SID, {
      type: 'state.updated', seq, sessionId: SID, turnId: 'turn_1', timestamp: Date.now(),
      payload: { reason, patch: { mode: { current: mode } } },
    })
  }

  /** 前置：agent 计划阶段活跃（EnterPlanMode 已批准推断）*/
  function setupAgentPlan(): void {
    pushEvent('turn.started', { turnNumber: 1, messageId: 'msg_shell_1' }, 90)
    pushEvent('model.streaming', { kind: 'tool_call', toolCallId: TC_ENTER, toolName: 'EnterPlanMode', input: {} }, 91)
    pushEvent('tool.updated', { kind: 'result', toolCallId: TC_ENTER, result: { success: true, content: 'entered plan mode' } }, 92)
  }

  it('裸拒绝后回合边界推 yolo：指示器保持 plan，推送值记入 prePlanMode', () => {
    setupAgentPlan()
    useStore.setState({ planApprovalAnswer: 'decline' })

    pushStateUpdated('yolo', 300)

    const st = useStore.getState()
    expect(st.currentMode).toBe('plan')
    expect(st.prePlanMode).toBe('yolo')
    expect(st.agentPlanActive).toBe(true)
  })

  it('意见式拒绝后同一形态推送：同样保持 plan（回合继续修订场景）', () => {
    setupAgentPlan()
    useStore.setState({ planApprovalAnswer: 'feedback' })

    pushStateUpdated('yolo', 300)

    expect(useStore.getState().currentMode).toBe('plan')
    expect(useStore.getState().prePlanMode).toBe('yolo')
  })

  it('批准后（agentPlanActive 已清）同一推送：指示器正常同步 yolo', () => {
    setupAgentPlan()
    // 弹窗批准：乐观切离 + 清标志（handleApprove 链路）
    useStore.setState({ planApprovalAnswer: 'approve', agentPlanActive: false, currentMode: 'yolo', prePlanMode: null })

    pushStateUpdated('yolo', 300)

    const st = useStore.getState()
    expect(st.currentMode).toBe('yolo')
    expect(st.prePlanMode).toBeNull()
  })

  it('agent plan 期间手动切档：agentPlanActive 清除，指示器跟随用户选择', () => {
    setupAgentPlan()
    expect(useStore.getState().agentPlanActive).toBe(true)

    useStore.getState().setMode('yolo')

    const st = useStore.getState()
    expect(st.currentMode).toBe('yolo')
    expect(st.agentPlanActive).toBe(false)
    // 切档后的推送照旧同步（不再被 hold）
    pushStateUpdated('build', 301)
    expect(useStore.getState().currentMode).toBe('build')
  })

  it('agent plan 期间推 plan 模式（v1 形态）：照旧同步，无需 hold', () => {
    setupAgentPlan()

    pushStateUpdated('plan', 300)

    expect(useStore.getState().currentMode).toBe('plan')
  })
})

describe('缺陷CG 三轮：轮末兜底 loadSettings 响应不翻转指示器', () => {
  /** Java → webview 的 getSettings 响应（轮末兜底重拉设置真实形态）*/
  function pushSettings(mode: string): void {
    messageHandler!({
      op: 'settings',
      sessionId: SID,
      mode: { current: mode },
      thoughtLevel: { available: [{ label: 'max', value: 'max' }], current: 'max', enabled: true },
    })
  }

  /** 前置：agent 计划阶段活跃（EnterPlanMode 已批准推断）*/
  function setupAgentPlan(): void {
    pushEvent('turn.started', { turnNumber: 1, messageId: 'msg_shell_1' }, 90)
    pushEvent('model.streaming', { kind: 'tool_call', toolCallId: TC_ENTER, toolName: 'EnterPlanMode', input: {} }, 91)
    pushEvent('tool.updated', { kind: 'result', toolCallId: TC_ENTER, result: { success: true, content: 'entered plan mode' } }, 92)
  }

  it('裸拒绝后轮末兜底拉设置（mode=yolo）：指示器保持 plan，yolo 记入 prePlanMode，thoughtLevel 照常同步', () => {
    setupAgentPlan()
    useStore.setState({ planApprovalAnswer: 'decline' })

    pushSettings('yolo')

    const st = useStore.getState()
    expect(st.currentMode).toBe('plan')
    expect(st.prePlanMode).toBe('yolo')
    expect(st.agentPlanActive).toBe(true)
    // thoughtLevel 不受 hold 影响（级别与模式两层互不干扰）
    expect(st.thoughtLevel?.current).toBe('max')
  })

  it('批准后（agentPlanActive 已清）同一响应：指示器正常同步 yolo', () => {
    setupAgentPlan()
    useStore.setState({ planApprovalAnswer: 'approve', agentPlanActive: false, currentMode: 'yolo', prePlanMode: null })

    pushSettings('yolo')

    const st = useStore.getState()
    expect(st.currentMode).toBe('yolo')
    expect(st.prePlanMode).toBeNull()
  })

  it('v1 形态（mode=plan）无需 hold：照旧同步', () => {
    setupAgentPlan()

    pushSettings('plan')

    expect(useStore.getState().currentMode).toBe('plan')
  })
})
