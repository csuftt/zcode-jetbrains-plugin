/**
 * 会话懒创建回归测试
 *
 * 行为变更：新建标签页不再立即建会话（避免误点多开标签堆积空会话），
 * 「无会话」成为合法待命态——发首条消息时才触发建会话，建好后自动发出。
 * 「新建会话」按钮（已有会话时）同样延迟创建：先重置为待命态（clearTabSession
 * 通知 Java 清 TabState 绑定），首条消息再触发建会话。
 *
 * 断言：
 *   1. listSessions 响应到达（新标签无注入）不自动 createSession
 *   2. 无会话 sendMessage → 发 createSession 而非 send，streaming=true，消息暂存
 *   3. createSession 响应 → 自动发出暂存消息（send 带新 sid + 乐观用户消息入列）
 *   4. 等待建会话期间的后续消息入队，不重复 createSession
 *   5. 建会话失败（error op）→ 标志/暂存/流式全部复位
 *   6. 已有会话点「新建会话」（resetToNewSession）→ 不建会话，重置待命态 + clearTabSession
 *   7. 重置后发首条消息 → 走懒创建（建会话而非 send）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock 桥接层：捕获 sendToJava，手动注入事件/响应 ----
let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'

const NEW_SID = 'sess_lazy_1'

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

function sentOps(): string[] {
  return sentRequests.map((r) => r.op as string)
}

function resetToIdleNoSession(): void {
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: null,
    currentWorkspacePath: 'G:\\mock',
    creatingSession: false,
    pendingFirstMessage: null,
    messages: [],
    loadingMessages: false,
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    sessions: [],
    provisionalTitles: {},
    lastError: null,
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  sentRequests.length = 0
  useStore.getState().init() // 注册桥接回调（onMessage）
  sentRequests.length = 0 // 清掉 init 触发的 listSessions/listModels
  resetToIdleNoSession()
})

describe('会话懒创建', () => {
  it('新标签的 listSessions 响应不自动建会话（保持无会话待命态）', () => {
    pushResponse({
      op: 'listSessions',
      sessions: [{ sessionId: 'sess_old_1', title: '旧会话', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    })

    const st = useStore.getState()
    expect(st.currentSessionId).toBeNull()
    expect(st.creatingSession).toBe(false)
    expect(sentOps()).not.toContain('createSession')
  })

  it('无会话发首条消息：触发建会话而非直接 send，streaming 立即置位', () => {
    useStore.getState().sendMessage('帮我看看这个报错')

    const st = useStore.getState()
    expect(sentOps()).toContain('createSession')
    expect(sentOps()).not.toContain('send')
    expect(st.creatingSession).toBe(true)
    expect(st.pendingFirstMessage).toBe('帮我看看这个报错')
    // 等待动画立即反馈（用户消息在会话建好发出后才乐观入列）
    expect(st.streaming).toBe(true)
    expect(st.messages).toHaveLength(0)
  })

  it('createSession 响应到达：自动发出暂存消息，乐观用户消息入列', () => {
    useStore.getState().sendMessage('帮我看看这个报错')
    pushResponse({ op: 'createSession', sessionId: NEW_SID })

    const st = useStore.getState()
    // 会话已绑定，暂存清空
    expect(st.currentSessionId).toBe(NEW_SID)
    expect(st.creatingSession).toBe(false)
    expect(st.pendingFirstMessage).toBeNull()
    // 首条消息带新 sid 发出（subscribe + send）
    expect(sentOps()).toContain('subscribe')
    const send = sentRequests.find((r) => r.op === 'send')
    expect(send).toMatchObject({ sessionId: NEW_SID, text: '帮我看看这个报错' })
    // 乐观用户消息已入列，流式置位
    expect(st.streaming).toBe(true)
    const userMsg = st.messages.find((m) => m.info.role === 'user')
    expect(userMsg?.parts[0]).toMatchObject({ type: 'text', text: '帮我看看这个报错' })
  })

  it('等待建会话期间的后续消息入队，不重复 createSession', () => {
    useStore.getState().sendMessage('第一条')
    useStore.getState().sendMessage('第二条')

    const st = useStore.getState()
    expect(sentOps().filter((op) => op === 'createSession')).toHaveLength(1)
    expect(st.queuedMessages).toHaveLength(1)
    expect(st.queuedMessages[0].text).toBe('第二条')
    // 首条仍为暂存
    expect(st.pendingFirstMessage).toBe('第一条')
  })

  it('建会话失败（error op）：标志/暂存/流式复位，错误可见', () => {
    useStore.getState().sendMessage('帮我看看这个报错')
    pushResponse({ op: 'error', message: '处理失败: app-server 未启动' })

    const st = useStore.getState()
    expect(st.creatingSession).toBe(false)
    expect(st.pendingFirstMessage).toBeNull()
    expect(st.streaming).toBe(false)
    expect(st.currentSessionId).toBeNull()
    expect(st.lastError).toContain('处理失败')
    // 未发出任何 send
    expect(sentOps()).not.toContain('send')
  })

  it('createSession 防重入：进行中不重复发请求', () => {
    useStore.getState().createSession()
    useStore.getState().createSession()

    expect(sentOps().filter((op) => op === 'createSession')).toHaveLength(1)
    expect(useStore.getState().creatingSession).toBe(true)
  })
})

describe('「新建会话」按钮延迟创建', () => {
  /** 模拟已绑定会话且有对话历史的标签 */
  function resetToBoundSession(): void {
    useStore.setState({
      currentSessionId: 'sess_old_1',
      messages: [{
        info: { role: 'user', time: { created: 1 }, id: 'm1', sessionID: 'sess_old_1' },
        parts: [{ type: 'text', text: '旧会话消息' }],
      }],
      creatingSession: false,
      pendingFirstMessage: null,
      streaming: false,
    })
  }

  it('已有会话点新建：不建会话，重置待命态并通知 Java 清 TabState 绑定', () => {
    resetToBoundSession()
    useStore.getState().resetToNewSession()

    const st = useStore.getState()
    expect(sentOps()).not.toContain('createSession')
    expect(sentOps()).toContain('clearTabSession')
    expect(st.currentSessionId).toBeNull()
    expect(st.messages).toHaveLength(0)
    expect(st.pendingFirstMessage).toBeNull()
    expect(st.creatingSession).toBe(false)
  })

  it('重置后发首条消息：走懒创建（建会话而非 send）', () => {
    resetToBoundSession()
    useStore.getState().resetToNewSession()
    sentRequests.length = 0
    useStore.getState().sendMessage('新会话的第一个问题')

    const st = useStore.getState()
    expect(sentOps()).toContain('createSession')
    expect(sentOps()).not.toContain('send')
    expect(st.pendingFirstMessage).toBe('新会话的第一个问题')
    expect(st.streaming).toBe(true)
  })
})
