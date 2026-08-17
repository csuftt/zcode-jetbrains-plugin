/**
 * 排队消息流式竞态回归测试
 *
 * 复现缺陷（2026-08-15，idea.log 时序证据）：
 *   turn.completed → flushQueue 立即发出排队消息 → 新 turn.started（292ms 后）
 *   → 旧 turn 的 300ms 延迟重拉这时才执行（resume+messages，响应再晚 ~200ms）
 *   → 全量替换 messages，把新 turn 的流式状态抹掉。
 *
 * turn.started.messageId = 触发 turn 的 user 消息 id：
 *   替换前列表只有本地乐观 user 消息（local_u_*），不命中 → 借该 id 建 assistant 流式消息；
 *   替换后同 id 的是服务端 user 消息 → streamingMessageId 指到 user 消息
 *   → 后续 text_delta 叠进 user 气泡（"叠字"），assistant 实时流中断。
 *
 * 断言：
 *   1. 过期重拉到达后，AI delta 不得进入任何 user 消息（不叠字）
 *   2. 流式不中断：后续 delta 仍进入 assistant 消息
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
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

const SID = 'sess_race_1'

/** 推一个流式事件（走单推通道，真实环境 turn 生命周期走此通道）*/
function pushEvent(type: string, payload: Record<string, unknown>, turnId = 'turn_2', seq = 100): void {
  streamEventHandler!(SID, {
    type, seq, sessionId: SID, turnId, timestamp: Date.now(), payload,
  })
}

function pushMessageResponse(messages: ZCodeMessage[]): void {
  messageHandler!({ op: 'messages', sessionId: SID, messages })
}

function lastUserMsg(): ZCodeMessage | undefined {
  const arr = useStore.getState().messages.filter((m) => m.info.role === 'user')
  return arr[arr.length - 1]
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
    messages: [],
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    sessions: [{ sessionId: SID, title: 'sess_race_1', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('排队消息自动发出后的流式竞态', () => {
  it('过期重拉不得把 AI 回复叠进 user 消息、不得中断流式', () => {
    const store = useStore.getState()

    // ── 1. 会话进行中，用户输入排队 ──
    useStore.setState({ streaming: true, streamingMessageId: 'msg_a1' })
    store.sendMessage('@build.sh\n执行构建')
    expect(useStore.getState().queuedMessages).toHaveLength(1)

    // ── 2. turn.completed 单推到达：flushQueue 自动发出排队消息 ──
    pushEvent('turn.completed', {}, 'turn_1', 99)
    expect(useStore.getState().streaming).toBe(true)
    // send op 已发出（排队消息）
    expect(sentRequests.some((r) => r.op === 'send')).toBe(true)
    // 本地乐观 user 消息已入列
    expect(lastUserMsg()?.parts[0]).toMatchObject({ type: 'text', text: '@build.sh\n执行构建' })

    // ── 3. 新 turn.started（messageId = 服务端为排队消息分配的 user 消息 id）──
    const srvUserId = 'msg_srv_u9'
    pushEvent('turn.started', { turnNumber: 2, messageId: srvUserId }, 'turn_2', 101)
    expect(useStore.getState().streamingMessageId).toBeTruthy()

    // ── 4. 流式开始，第一段 delta 正常进 assistant 消息 ──
    pushEvent('model.streaming', { kind: 'text_delta', delta: '浏览器环境不可用，改按用户指令执行构建脚本。' }, 'turn_2', 102)
    const st4 = useStore.getState()
    const streamingMsg4 = st4.messages.find((m) => m.info.id === st4.streamingMessageId)
    expect(streamingMsg4?.info.role).toBe('assistant')

    // ── 5. 旧 turn 的 300ms 延迟重拉这时才到达（竞态核心）──
    //    服务端快照：排队消息已持久化为 user 消息（id=turn.started.messageId），
    //    进行中的 assistant 消息尚未落 transcript → 列表里没有流式消息
    vi.advanceTimersByTime(400)
    expect(sentRequests.some((r) => r.op === 'messages')).toBe(true)
    pushMessageResponse([
      {
        info: { role: 'user', time: { created: 1 }, id: 'msg_srv_u0', sessionID: SID },
        parts: [{ type: 'text', text: '第一条消息' }],
      },
      {
        info: { role: 'assistant', time: { created: 2, completed: 3 }, id: 'msg_srv_a1', sessionID: SID },
        parts: [{ type: 'text', text: '第一轮回复' }],
      },
      {
        info: { role: 'user', time: { created: 4 }, id: srvUserId, sessionID: SID },
        parts: [{ type: 'text', text: '@build.sh\n执行构建' }],
      },
    ])

    // ── 6. 重拉之后的 delta：断言不叠字 + 不断流 ──
    pushEvent('model.streaming', { kind: 'text_delta', delta: '先看脚本内容：' }, 'turn_2', 103)

    const st6 = useStore.getState()

    // 断言 1（不叠字）：user 消息 parts 不得出现 AI delta
    const userTexts = st6.messages
      .filter((m) => m.info.role === 'user')
      .flatMap((m) => m.parts)
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n')
    expect(userTexts).not.toContain('先看脚本内容')
    expect(userTexts).not.toContain('浏览器环境不可用')

    // 断言 2（不断流）：delta 仍在 assistant 消息里累积
    const assistantTexts = st6.messages
      .filter((m) => m.info.role === 'assistant')
      .flatMap((m) => m.parts)
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n')
    expect(assistantTexts).toContain('浏览器环境不可用')
    expect(assistantTexts).toContain('先看脚本内容')
  })

  it('非排队正常对话：turn 结束后的重拉照常落地（不误伤既有行为）', () => {
    const store = useStore.getState()
    store.sendMessage('你好')
    expect(useStore.getState().streaming).toBe(true)

    pushEvent('turn.started', { turnNumber: 1, messageId: 'msg_srv_u1' }, 'turn_1', 1)
    pushEvent('model.streaming', { kind: 'text_delta', delta: '你好！' }, 'turn_1', 2)
    pushEvent('turn.completed', {}, 'turn_1', 3)
    expect(useStore.getState().streaming).toBe(false)

    // 重拉响应正常替换（streaming=false 时不丢弃）
    vi.advanceTimersByTime(400)
    expect(sentRequests.some((r) => r.op === 'messages')).toBe(true)
    pushMessageResponse([
      {
        info: { role: 'user', time: { created: 1 }, id: 'msg_srv_u1', sessionID: SID },
        parts: [{ type: 'text', text: '你好' }],
      },
      {
        info: { role: 'assistant', time: { created: 2, completed: 3 }, id: 'msg_srv_a1', sessionID: SID },
        parts: [{ type: 'text', text: '你好！（服务端权威版本）' }],
      },
    ])
    const st = useStore.getState()
    expect(st.messages).toHaveLength(2)
    expect(st.messages[1].parts[0]).toMatchObject({ type: 'text', text: '你好！（服务端权威版本）' })
  })

  it('链式排队：多条消息连续自动发出，中间轮次流式不叠字不断流，末轮重拉落地', () => {
    const store = useStore.getState()

    // 第一轮进行中，连续排两条消息
    useStore.setState({ streaming: true, streamingMessageId: 'msg_a1' })
    store.sendMessage('排队消息1')
    store.sendMessage('排队消息2')

    // ── 第一轮结束 → 自动发出"排队消息1" ──
    pushEvent('turn.completed', {}, 'turn_1', 10)
    pushEvent('turn.started', { turnNumber: 2, messageId: 'msg_srv_u1' }, 'turn_2', 11)
    pushEvent('model.streaming', { kind: 'text_delta', delta: '回复1-' }, 'turn_2', 12)
    // 第一轮的过期重拉到达（不含进行中的流式消息）
    vi.advanceTimersByTime(400)
    pushMessageResponse([
      { info: { role: 'user', time: { created: 1 }, id: 'msg_srv_u1', sessionID: SID }, parts: [{ type: 'text', text: '排队消息1' }] },
    ])
    pushEvent('model.streaming', { kind: 'text_delta', delta: '后半段' }, 'turn_2', 13)

    let st = useStore.getState()
    let userTexts = st.messages.filter((m) => m.info.role === 'user').flatMap((m) => m.parts).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    expect(userTexts).not.toContain('后半段')
    let asstTexts = st.messages.filter((m) => m.info.role === 'assistant').flatMap((m) => m.parts).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    expect(asstTexts).toContain('回复1-后半段')

    // ── 第二轮结束 → 自动发出"排队消息2" ──
    pushEvent('turn.completed', {}, 'turn_2', 20)
    pushEvent('turn.started', { turnNumber: 3, messageId: 'msg_srv_u2' }, 'turn_3', 21)
    pushEvent('model.streaming', { kind: 'text_delta', delta: '回复2' }, 'turn_3', 22)

    // ── 第三轮（最后一条）结束 → 队列空，重拉落地权威数据 ──
    pushEvent('turn.completed', {}, 'turn_3', 23)
    expect(useStore.getState().streaming).toBe(false)
    expect(useStore.getState().queuedMessages).toHaveLength(0)
    vi.advanceTimersByTime(400)
    pushMessageResponse([
      { info: { role: 'user', time: { created: 1 }, id: 'msg_srv_u1', sessionID: SID }, parts: [{ type: 'text', text: '排队消息1' }] },
      { info: { role: 'assistant', time: { created: 2, completed: 3 }, id: 'msg_srv_a1', sessionID: SID }, parts: [{ type: 'text', text: '回复1（权威）' }] },
      { info: { role: 'user', time: { created: 4 }, id: 'msg_srv_u2', sessionID: SID }, parts: [{ type: 'text', text: '排队消息2' }] },
      { info: { role: 'assistant', time: { created: 5, completed: 6 }, id: 'msg_srv_a2', sessionID: SID }, parts: [{ type: 'text', text: '回复2（权威）' }] },
    ])

    st = useStore.getState()
    expect(st.messages).toHaveLength(4)
    // 末位 assistant 是服务端权威版本
    expect(st.messages[3].parts[0]).toMatchObject({ type: 'text', text: '回复2（权威）' })
    // 全程无叠字
    userTexts = st.messages.filter((m) => m.info.role === 'user').flatMap((m) => m.parts).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    expect(userTexts).toBe('排队消息1\n排队消息2')
  })
})
