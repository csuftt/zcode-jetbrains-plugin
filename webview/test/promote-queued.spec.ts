/**
 * 「已发出但被服务端排队」防御（缺陷FD）回归测试
 *
 * 复现场景（2026-10-19 真机实测，PyCharm 宿主）：
 *   有后台任务时点「立即」→ stop 的异步拆卸窗口内 flush 的 send 被服务端
 *   admitPrompt 静默降级为 delivery=queue（ack 正常无感）→ 消息不进转录、不开轮、
 *   也不自动排空（回合取消置 queueAutoDrain=false，排空是客户端职责）→ 三处不可见。
 *
 * 防御链路（对应实现 handleFlushedSendQueuedDefence / case 'promoteQueuedInput'）：
 *   1. doSend 打点 recentFlushedSends → turn.steerQueued（带 input 全文 + delivery=queue）
 *      按文本认领 → 补插乐观气泡 + 调 promoteQueuedInput（v4 sendQueuedNow）
 *   2. 应答 ok → 无动作（气泡等真身顶替）
 *   3. 应答 !ok removed=true（条目已取消）→ 回插客户端队列 + 横幅提示
 *   4. 应答 !ok removed=false（已落位/他方促发）→ 仅提示，不重发
 *   5. 负例：文本不匹配 / delivery=guide / 事件重放（同 queueItemId）/ TTL 过期，
 *      均不得误伤
 *
 * 事件形状取自 diag-fd-promote 真机探针（guide+附件降级 queue 的 steerQueued 载荷：
 * input 全文 + pendingInputId=queue_<commandId>；legacy 降级路径 intent.queueItemId
 * 亦在场——两者都认领，前两例分别覆盖）。
 * 注：handledQueueItems 等去重账本是模块级（页面生命周期），用例间用不同 queueItemId 隔离。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null
let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore, handleResponse } from '@/store/useStore'

const SID = 'sess_fd_1'
const TEXT = '还有就是删除按钮显示时就把那个时间隐藏吧，重叠在一起不好看'

/** 真机探针形状：deferred input 排队事件。qid 显式传入保证用例间隔离 + ack 配对 */
function steerQueuedPayload(qid: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputId: qid.replace(/^queue_/, ''),
    queryId: qid.replace(/^queue_/, ''),
    pendingInputId: qid,
    input: TEXT,
    inputPreview: TEXT,
    inputSize: TEXT.length,
    inputPresentation: 'user_steer',
    delivery: 'queue',
    intent: {
      sourceCommandId: qid.replace(/^queue_/, ''),
      queueItemId: qid, // legacy 降级路径在场（DB 实证）
      clientId: 'legacy-session-send',
      requestedDelivery: 'startNow',
      admittedDelivery: 'queue',
    },
    targetTurnId: 'turn_1fbc12ed',
    queueLength: 1,
    ...overrides,
  }
}

function pushBatchEvent(type: string, payload: Record<string, unknown>): void {
  streamBatchHandler!(SID, [{ type, seq: 1, sessionId: SID, turnId: 'turn_1fbc12ed', timestamp: Date.now(), payload }])
}

function userTexts(): string[] {
  return useStore.getState().messages
    .filter((m) => m.info.role === 'user')
    .map((m) => (m.parts[0] as { text?: string }).text ?? '')
}

function resetStore(): void {
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [],
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    lastNotice: null,
    lastError: null,
    editReplay: null,
    sessions: [],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
}

/** 模拟一次真实发送（doSend 打点），返回后清空请求账本 */
function realSend(text: string): void {
  useStore.getState().sendMessage(text)
  sentRequests.length = 0
}

/** 标准三段：真实发送 → 轮末快照抹掉气泡（真机同序）→ 排队事件到达 */
function sendThenQueuedEvent(qid: string): void {
  realSend(TEXT)
  useStore.setState({ messages: [] }) // 模拟 +300ms 权威快照（服务端没有这条消息）
  pushBatchEvent('turn.steerQueued', steerQueuedPayload(qid))
}

describe('发送被服务端排队防御（缺陷FD）', () => {
  beforeEach(() => {
    sentRequests.length = 0
    resetStore()
    void useStore.getState().init()
    sentRequests.length = 0
  })

  it('命中：按 input 全文认领 → 补插气泡 + 发 promoteQueuedInput（intent.queueItemId）', () => {
    const qid = 'queue_fd_hit_1'
    sendThenQueuedEvent(qid)

    // 气泡补插（消息不再"消失"）
    expect(userTexts()).toEqual([TEXT])
    // 促发 op 发出（queueItemId 取 intent.queueItemId）
    const promote = sentRequests.find((r) => r.op === 'promoteQueuedInput')
    expect(promote).toBeTruthy()
    expect(promote!.sessionId).toBe(SID)
    expect(promote!.queueItemId).toBe(qid)
    // 服务端真身未到：不写错误/提示
    expect(useStore.getState().lastNotice).toBeNull()
    expect(useStore.getState().lastError).toBeNull()
  })

  it('队列条目缺 intent.queueItemId 时回退 pendingInputId（v4 路径形状）', () => {
    const qid = 'queue_fd_v4path_1'
    realSend(TEXT)
    useStore.setState({ messages: [] })
    pushBatchEvent('turn.steerQueued', steerQueuedPayload(qid, {
      intent: { sourceCommandId: 'fdprobe-8264c216', requestedDelivery: 'guide', admittedDelivery: 'queue' },
    }))
    const promote = sentRequests.find((r) => r.op === 'promoteQueuedInput')
    expect(promote?.queueItemId).toBe(qid)
    expect(userTexts()).toEqual([TEXT])
  })

  it('促发成功（ok）：气泡保留、不回队列、无提示', () => {
    const qid = 'queue_fd_ok_1'
    sendThenQueuedEvent(qid)
    messageHandler!({ op: 'promoteQueuedInput', sessionId: SID, queueItemId: qid, ok: true })
    expect(userTexts()).toEqual([TEXT])
    expect(useStore.getState().queuedMessages).toHaveLength(0)
    expect(useStore.getState().lastNotice).toBeNull()
  })

  it('促发失败且条目已取消（removed=true）：回插客户端队列 + 撤气泡 + 横幅提示', () => {
    const qid = 'queue_fd_req_1'
    sendThenQueuedEvent(qid)
    handleResponse(
      { op: 'promoteQueuedInput', sessionId: SID, queueItemId: qid, ok: false, removed: true, error: 'stale' },
      useStore.setState, useStore.getState,
    )
    const q = useStore.getState().queuedMessages
    expect(q).toHaveLength(1)
    expect(q[0].text).toBe(TEXT)
    // 补插气泡撤下（由队列卡片接管表现）
    expect(userTexts()).toEqual([])
    expect(useStore.getState().lastNotice).toContain('立即发送')
  })

  it('促发失败但条目已不存在（removed=false）：仅提示，不重发不撤气泡', () => {
    const qid = 'queue_fd_gone_1'
    sendThenQueuedEvent(qid)
    handleResponse(
      { op: 'promoteQueuedInput', sessionId: SID, queueItemId: qid, ok: false, removed: false, error: 'queue.itemMissing' },
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().queuedMessages).toHaveLength(0)
    expect(userTexts()).toEqual([TEXT]) // 气泡保留等真身
    expect(useStore.getState().lastNotice).toContain('立即发送')
  })

  it('负例：文本不匹配不认领（他人排队事件不误伤）', () => {
    realSend(TEXT)
    sentRequests.length = 0
    pushBatchEvent('turn.steerQueued', steerQueuedPayload('queue_fd_other_1', { input: '别的地方的排队消息' }))
    expect(sentRequests.some((r) => r.op === 'promoteQueuedInput')).toBe(false)
    expect(userTexts()).toEqual([TEXT])
  })

  it('负例：delivery=guide（引导注入）不认领——走 steerDrained 正常落位', () => {
    realSend(TEXT)
    sentRequests.length = 0
    pushBatchEvent('turn.steerQueued', steerQueuedPayload('queue_fd_guide_1', { delivery: 'guide' }))
    expect(sentRequests.some((r) => r.op === 'promoteQueuedInput')).toBe(false)
  })

  it('负例：同 queueItemId 事件重放不二次促发', () => {
    const qid = 'queue_fd_replay_1'
    sendThenQueuedEvent(qid)
    expect(sentRequests.filter((r) => r.op === 'promoteQueuedInput')).toHaveLength(1)
    sentRequests.length = 0
    // 重放同一事件（事件流对账/重连回放）
    pushBatchEvent('turn.steerQueued', steerQueuedPayload(qid))
    expect(sentRequests.some((r) => r.op === 'promoteQueuedInput')).toBe(false)
  })

  it('超时未认领：发送 60s 后的 steerQueued 不再认领（TTL）', () => {
    realSend(TEXT)
    sentRequests.length = 0
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(Date.now() + 61_000) // 61s 后事件才到
    pushBatchEvent('turn.steerQueued', steerQueuedPayload('queue_fd_ttl_1'))
    nowSpy.mockRestore()
    expect(sentRequests.some((r) => r.op === 'promoteQueuedInput')).toBe(false)
  })

  it('编辑重发防御优先：editReplay 命中时不走本防御（两者不打架）', () => {
    realSend(TEXT)
    useStore.setState({
      editReplay: { targetMsgId: 'msg_edit_x', text: TEXT, via: 'v4', rewound: true, stopping: false },
    })
    sentRequests.length = 0
    pushBatchEvent('turn.steerQueued', steerQueuedPayload('queue_fd_edit_1'))
    // 编辑防御命中（清 editReplay + lastError），不发促发
    expect(sentRequests.some((r) => r.op === 'promoteQueuedInput')).toBe(false)
    expect(useStore.getState().editReplay).toBeNull()
  })

  it('单推路径同链（turn.steerQueued 走非批量通道时不丢）', () => {
    const qid = 'queue_fd_single_1'
    realSend(TEXT)
    useStore.setState({ messages: [] })
    streamEventHandler!(SID, { type: 'turn.steerQueued', seq: 1, sessionId: SID, turnId: 'turn_1fbc12ed', timestamp: Date.now(), payload: steerQueuedPayload(qid) })
    const promote = sentRequests.find((r) => r.op === 'promoteQueuedInput')
    expect(promote?.queueItemId).toBe(qid)
    expect(userTexts()).toEqual([TEXT])
  })

  it('原乐观气泡健在（事件先于快照到达）：不重复补插、removed=true 撤下同一气泡', () => {
    const qid = 'queue_fd_existing_1'
    realSend(TEXT)
    // 不清 messages：原气泡仍在（快照尚未到达）
    pushBatchEvent('turn.steerQueued', steerQueuedPayload(qid))
    expect(sentRequests.some((r) => r.op === 'promoteQueuedInput')).toBe(true)
    expect(userTexts()).toEqual([TEXT]) // 单条，不双插
    // 促发失败回插：撤下的应是原气泡（bubbleId 复用）
    handleResponse(
      { op: 'promoteQueuedInput', sessionId: SID, queueItemId: qid, ok: false, removed: true },
      useStore.setState, useStore.getState,
    )
    expect(userTexts()).toEqual([])
    expect(useStore.getState().queuedMessages).toHaveLength(1)
  })

  it('应答回到时已切会话：不往新会话队列插旧会话消息', () => {
    const qid = 'queue_fd_switch_1'
    sendThenQueuedEvent(qid)
    useStore.setState({ currentSessionId: 'sess_other', messages: [] })
    handleResponse(
      { op: 'promoteQueuedInput', sessionId: SID, queueItemId: qid, ok: false, removed: true },
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().queuedMessages).toHaveLength(0)
    expect(useStore.getState().lastNotice).toBeNull()
  })
})