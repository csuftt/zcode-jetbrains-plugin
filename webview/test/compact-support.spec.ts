/**
 * /compact 上下文压缩支持回归测试（2026-08-21 缺陷 C1/C4）
 *
 * 复现缺陷（idea.log 11:43:14 窗口实测证据）：
 *   压缩摘要生成期间事件流完全静默（实测 63s，大上下文更久），旧逻辑：
 *   - turn.started 建空流式 assistant 消息 → 63s+ 空气泡转圈，无压缩提示
 *   - 看门狗 60s 静默对账可能误判流丢失提前收尾
 *
 * 断言：
 *   1. send 识别 /compact → compacting 置位（手动压缩即时反馈）
 *   2. usage 轮询的 activeTurnKind 权威同步（覆盖 autocompact 与残留清除）
 *   3. compacting 中 turn.started 不建流式消息（无空气泡）
 *   4. turn.completed → compacting 清除 + 触发消息重拉（落地摘要卡）
 *   5. 看门狗豁免：compacting 期间静默 60s+ 不发对账探测
 *   6. 摘要消息不被 isHiddenSyntheticMessage 过滤（无消息级 synthetic 标记）
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
import { isCompactSummaryMessage, isHiddenSyntheticMessage, findTimelinePart } from '@/utils/parseNotification'
import type { MessageInfo } from '@/types/messages'

const SID = 'sess_compact_1'

function pushEvent(type: string, payload: Record<string, unknown>): void {
  streamEventHandler!(SID, {
    type, seq: 100, sessionId: SID, turnId: 'turn_c1', timestamp: Date.now(), payload,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  stopSubagentStatusPolling()
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
    compacting: false,
    queuedMessages: [],
    subagentActivities: [],
    subagents: [],
    childSessionKeys: {},
    sessions: [{ sessionId: SID, title: 'compact-test', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('识别函数（RPC 实测结构）', () => {
  it('isCompactSummaryMessage：summary.body 存在才识别（title 单独不算）', () => {
    const mk = (summary?: MessageInfo['summary']): MessageInfo =>
      ({ id: 'm1', sessionID: SID, role: 'user', time: { created: 1 }, ...(summary ? { summary } : {}) })
    expect(isCompactSummaryMessage(mk({ title: 'Compact summary', body: 'Summary: …' }))).toBe(true)
    expect(isCompactSummaryMessage(mk({ title: 'Compact summary' }))).toBe(false)
    expect(isCompactSummaryMessage(mk())).toBe(false)
  })

  it('摘要消息无消息级 synthetic → 不被 isHiddenSyntheticMessage 过滤', () => {
    const info: MessageInfo = {
      id: 'm1', sessionID: SID, role: 'user', time: { created: 1 },
      summary: { title: 'Compact summary', body: 'Summary: …' },
    }
    // 消息级 synthetic 未置位（实测 RPC：标记只在 text part 级）——过滤不生效，
    // 须靠 MessageBubble 的 isCompactSummaryMessage 分流（渲染测试覆盖）
    expect(isHiddenSyntheticMessage(info)).toBe(false)
  })

  it('findTimelinePart：取首个 timeline part', () => {
    const parts = [
      { type: 'timeline', timelineType: 'context_compaction', display: 'separator' },
      { type: 'compaction', auto: false },
    ]
    expect(findTimelinePart(parts)?.timelineType).toBe('context_compaction')
    expect(findTimelinePart([{ type: 'text', text: 'x' }])).toBeUndefined()
  })
})

describe('compacting 状态机', () => {
  it('send /compact → compacting 置位 + 本地用户消息入列', () => {
    useStore.getState().sendMessage('/compact')
    let st = useStore.getState()
    expect(st.compacting).toBe(true)
    expect(st.streaming).toBe(true)
    // 用户自己的 /compact 输入仍显示（知道发了什么）
    expect(st.messages.some((m) => m.info.role === 'user')).toBe(true)

    // 普通 send 不置位
    useStore.setState({ compacting: false, streaming: false })
    useStore.getState().sendMessage('普通问题')
    st = useStore.getState()
    expect(st.compacting).toBe(false)
  })

  it('usage 轮询的 activeTurnKind 权威同步（autocompact 覆盖 + 残留清除）', () => {
    // autocompact：send 未识别，轮询发现
    messageHandler!({ op: 'usage', sessionId: SID, used: 1, size: 2, activeTurnKind: 'compact' })
    expect(useStore.getState().compacting).toBe(true)

    // 压缩结束（kind 切回普通）
    messageHandler!({ op: 'usage', sessionId: SID, used: 1, size: 2, activeTurnKind: 'chat' })
    expect(useStore.getState().compacting).toBe(false)

    // 残留清除
    useStore.setState({ compacting: true })
    messageHandler!({ op: 'usage', sessionId: SID, used: 1, size: 2, activeTurnKind: 'chat' })
    expect(useStore.getState().compacting).toBe(false)

    // 旧 Java 包不带字段 → 不动作（不能把手动压缩态误清）
    useStore.setState({ compacting: true })
    messageHandler!({ op: 'usage', sessionId: SID, used: 1, size: 2 })
    expect(useStore.getState().compacting).toBe(true)
  })

  it('compacting 中 turn.started 不建流式消息（无空气泡）', () => {
    useStore.setState({ compacting: true, streaming: true, messages: [], streamingMessageId: null })
    pushEvent('turn.started', { turnNumber: 1, messageId: 'msg_trig' })
    const st = useStore.getState()
    expect(st.streaming).toBe(true)
    expect(st.messages).toHaveLength(0)
    expect(st.streamingMessageId).toBeNull()

    // 非 compacting 的 turn.started 正常建流式消息（回归保护）
    useStore.setState({ compacting: false, messages: [], streamingMessageId: null })
    pushEvent('turn.started', { turnNumber: 2, messageId: 'msg_trig2' })
    const st2 = useStore.getState()
    expect(st2.messages).toHaveLength(1)
    expect(st2.streamingMessageId).toBe('msg_trig2')
  })

  it('turn.completed → compacting 清除 + 触发重拉（落地摘要卡）', () => {
    useStore.setState({ compacting: true, streaming: true })
    sentRequests.length = 0
    pushEvent('turn.completed', {})
    vi.advanceTimersByTime(500)
    const st = useStore.getState()
    expect(st.compacting).toBe(false)
    expect(st.streaming).toBe(false)
    expect(sentRequests.some((r) => r.op === 'messages' && r.sessionId === SID)).toBe(true)
  })

  it('看门狗豁免：compacting 期间静默 70s 不发对账探测', () => {
    // 看门狗只对 connected 连接探测（mock/dev 不复现断流）
    useStore.setState({ compacting: true, streaming: true, connectionStatus: 'connected' })
    sentRequests.length = 0
    vi.advanceTimersByTime(70_000)
    expect(sentRequests.some((r) => r.op === 'messages' && r.reconcile === true)).toBe(false)

    // 非 compacting 静默仍触发（回归保护：看门狗本体还在）。
    // 重新翻转 streaming 重置静默基准，再推进一个完整静默窗口
    useStore.setState({ streaming: false })
    useStore.setState({ compacting: false, streaming: true })
    vi.advanceTimersByTime(70_000)
    expect(sentRequests.some((r) => r.op === 'messages' && r.reconcile === true)).toBe(true)
  })

  it('摘要消息进 visibleMessages（重拉落地，不被 synthetic 过滤丢弃）', () => {
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        {
          info: { id: 'm_sum', sessionID: SID, role: 'user', time: { created: 1 }, summary: { title: 'Compact summary', body: 'Summary: …' } },
          parts: [{ type: 'text', text: 'This session is being continued…', synthetic: true }],
        },
        {
          info: { id: 'm_marker', sessionID: SID, role: 'assistant', time: { created: 2 }, semantics: { origin: 'system', kind: 'timeline_event' } },
          parts: [{ type: 'timeline', timelineType: 'context_compaction', display: 'separator' }],
        },
      ],
    })
    const st = useStore.getState()
    expect(st.messages.some((m) => m.info.id === 'm_sum')).toBe(true)
    expect(st.messages.some((m) => m.info.id === 'm_marker')).toBe(true)
  })
})

describe('压缩回合结束 + 排队消息：延迟 flush 到快照落地后', () => {
  /**
   * 复现缺陷（2026-08-22 实测）：/compact 期间排队一条消息，压缩结束 turn.completed
   * → flushQueue 立即发出 → 新 turn.started 抢先置 streaming → 300ms 重拉快照到达时
   * 被 streaming 守卫丢弃 → 压缩摘要卡/时间线屏障整轮缺失（摘要只能靠快照落地）。
   * 修复：压缩回合结束且队列非空时，flush 延迟到快照落地之后（兜底 1.5s）。
   */

  const queuedSpec = () => {
    // 压缩进行中（send /compact 已置位），用户又排队一条消息
    useStore.setState({ compacting: true, streaming: true, streamingMessageId: null, messages: [], queuedMessages: [] })
    useStore.getState().sendMessage('压缩完继续这个问题')
    expect(useStore.getState().queuedMessages).toHaveLength(1)
    sentRequests.length = 0
    pushEvent('turn.completed', {})
    // 回合收尾：不再立即 flush（send 未发出是修复的核心断言前提）
    expect(useStore.getState().streaming).toBe(false)
    expect(useStore.getState().compacting).toBe(false)
    expect(sentRequests.some((r) => r.op === 'send')).toBe(false)
  }

  it('快照落地摘要卡后才 flush 队列（send 不抢跑）', () => {
    queuedSpec()

    // 300ms 重拉发出，响应带回压缩摘要 + 屏障
    vi.advanceTimersByTime(400)
    expect(sentRequests.some((r) => r.op === 'messages')).toBe(true)
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        {
          info: { id: 'm_sum', sessionID: SID, role: 'user', time: { created: 1 }, summary: { title: 'Compact summary', body: 'Summary: …' } },
          parts: [{ type: 'text', text: 'This session is being continued…', synthetic: true }],
        },
        {
          info: { id: 'm_marker', sessionID: SID, role: 'assistant', time: { created: 2 }, semantics: { origin: 'system', kind: 'timeline_event' } },
          parts: [{ type: 'timeline', timelineType: 'context_compaction', display: 'separator' }],
        },
      ],
    })

    // 摘要卡已落地，且此刻（而非 turn.completed 瞬间）排队消息才发出
    const st = useStore.getState()
    expect(st.messages.some((m) => m.info.id === 'm_sum')).toBe(true)
    expect(sentRequests.some((r) => r.op === 'send' && r.text === '压缩完继续这个问题')).toBe(true)
    expect(st.queuedMessages).toHaveLength(0)

    // 新回合照常开始（摘要卡不被 streaming 守卫丢快照波及）
    pushEvent('turn.started', { turnNumber: 2, messageId: 'msg_after_compact' })
    expect(useStore.getState().streaming).toBe(true)
    expect(useStore.getState().messages.some((m) => m.info.id === 'm_sum')).toBe(true)
  })

  it('兜底：快照请求死亡，在途超 5s 后照常 flush（队列不卡死）', () => {
    queuedSpec()

    // 300ms 善后批发出 messages 重拉（在途标记置位）但响应永不到达
    vi.advanceTimersByTime(400)
    expect(sentRequests.some((r) => r.op === 'messages')).toBe(true)

    // 1.5s 兜底触发但快照在途（<5s）→ 续等不抢跑
    vi.advanceTimersByTime(1200)
    expect(sentRequests.some((r) => r.op === 'send')).toBe(false)

    // 在途超 5s（t=300 起算，兜底多轮续等到 t=6000）→ 硬 flush
    vi.advanceTimersByTime(4600)
    expect(sentRequests.some((r) => r.op === 'send' && r.text === '压缩完继续这个问题')).toBe(true)
    expect(useStore.getState().queuedMessages).toHaveLength(0)
  })

  it('大快照慢到达：兜底续等不抢跑，快照落地后正路径 flush（2026-08-24 复现）', () => {
    // 复现：727 条/7.7MB 会话快照端到端 1.7s > 1.5s 兜底窗，旧逻辑兜底先 flush →
    // 排队消息开启新 turn streaming → 慢到的快照被守卫丢弃 → 摘要卡整轮缺失
    queuedSpec()

    // 300ms 善后批的 messages 重拉发出（在途标记置位）
    vi.advanceTimersByTime(400)
    expect(sentRequests.some((r) => r.op === 'messages')).toBe(true)

    // 1.5s 兜底触发：快照在途 → 续等而非 flush
    vi.advanceTimersByTime(1200)
    expect(sentRequests.some((r) => r.op === 'send')).toBe(false)

    // 慢到的快照响应（模拟 t≈1.7s 注入完成）：落地摘要卡后正路径 flush
    messageHandler!({
      op: 'messages',
      sessionId: SID,
      messages: [
        {
          info: { id: 'm_sum', sessionID: SID, role: 'user', time: { created: 1 }, summary: { title: 'Compact summary', body: 'Summary: …' } },
          parts: [{ type: 'text', text: 'This session is being continued…', synthetic: true }],
        },
      ],
    })
    const st = useStore.getState()
    expect(st.messages.some((m) => m.info.id === 'm_sum')).toBe(true)
    expect(sentRequests.some((r) => r.op === 'send' && r.text === '压缩完继续这个问题')).toBe(true)
    expect(st.queuedMessages).toHaveLength(0)
  })

  it('切会话后延迟意图作废：不代发别的会话上下文的队列', () => {
    queuedSpec()

    // 用户在快照回来前切走（延迟 flush 登记的是旧会话）
    useStore.setState({ currentSessionId: 'sess_other', queuedMessages: [] })
    vi.advanceTimersByTime(6100)
    expect(sentRequests.some((r) => r.op === 'send')).toBe(false)
  })
})
