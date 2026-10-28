/**
 * 乐观标题回归测试：首条消息发出后标题立即占位（不等对话结束/服务端正式标题）
 * 覆盖缺陷：懒创建路径 createSession 响应后 sessions 列表无新会话，乐观标题
 * 的 map 匹配不到 → header 显示会话 id 前缀，标题要等 listSessions 刷新才出现。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\mock',
  getTabWorkspacePath: () => '',
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

function resetToIdleNoSession(): void {
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: null,
    currentWorkspacePath: 'G:\mock',
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
  useStore.getState().init()
  sentRequests.length = 0
  resetToIdleNoSession()
})

describe('乐观标题', () => {
  it('懒创建：createSession 响应后新会话立即入列表且首条消息设乐观标题（header 不等对话结束）', () => {
    useStore.getState().sendMessage('帮我看看这个报错')
    pushResponse({ op: 'createSession', sessionId: NEW_SID })

    const st = useStore.getState()
    // 新会话立即出现在列表（header 的 currentSession 可命中）
    expect(st.sessions.find((s) => s.sessionId === NEW_SID)).toBeTruthy()
    // 乐观标题立即生效（不再显示会话 id 前缀）
    expect(st.sessions.find((s) => s.sessionId === NEW_SID)?.title).toBe('帮我看看这个报错')
    expect(st.provisionalTitles[NEW_SID]).toBe('帮我看看这个报错')
  })

  it('listSessions 响应（服务端标题仍为空）不覆盖乐观标题', () => {
    useStore.getState().sendMessage('帮我看看这个报错')
    pushResponse({ op: 'createSession', sessionId: NEW_SID })
    // 服务端返回空标题 + 其他会话
    pushResponse({
      op: 'listSessions',
      sessions: [
        { sessionId: NEW_SID, title: '', status: 'running', mode: 'yolo', workspacePath: 'G:\mock', createdAt: 1, updatedAt: 1 },
        { sessionId: 'sess_old_1', title: '旧会话', status: 'idle', mode: 'yolo', workspacePath: 'G:\mock', createdAt: 1, updatedAt: 1 },
      ],
    })

    const st = useStore.getState()
    expect(st.sessions.find((s) => s.sessionId === NEW_SID)?.title).toBe('帮我看看这个报错')
    expect(st.provisionalTitles[NEW_SID]).toBe('帮我看看这个报错')
  })

  it('并发时序：早发起的 listSessions 旧快照（不含新会话）晚到 → 不抹掉乐观插入的会话', () => {
    useStore.getState().sendMessage('帮我看看这个报错')
    // createSession 响应先到：乐观插入 + 乐观标题生效
    pushResponse({ op: 'createSession', sessionId: NEW_SID })
    // init 时发起的 listSessions 响应此刻才到：快照不含新会话（请求发出时尚未创建）
    pushResponse({
      op: 'listSessions',
      sessions: [
        { sessionId: 'sess_old_1', title: '旧会话', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 1 },
      ],
    })

    const st = useStore.getState()
    // 新会话不被旧快照抹掉，乐观标题保留
    expect(st.sessions.some((s) => s.sessionId === NEW_SID)).toBe(true)
    expect(st.sessions.find((s) => s.sessionId === NEW_SID)?.title).toBe('帮我看看这个报错')
    expect(st.provisionalTitles[NEW_SID]).toBe('帮我看看这个报错')
  })

  it('旧快照缺失的本地会话保留，但已删除会话（sessionDeleted 已过滤）不复活', () => {
    useStore.getState().sendMessage('帮我看看这个报错')
    pushResponse({ op: 'createSession', sessionId: NEW_SID })
    // 会话被删除：本地过滤 + 事件广播
    pushResponse({ op: 'sessionDeleted', sessionId: NEW_SID })
    expect(useStore.getState().sessions.some((s) => s.sessionId === NEW_SID)).toBe(false)
    // 旧快照晚到：不应复活已删会话
    pushResponse({
      op: 'listSessions',
      sessions: [
        { sessionId: 'sess_old_1', title: '旧会话', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 1 },
      ],
    })
    expect(useStore.getState().sessions.some((s) => s.sessionId === NEW_SID)).toBe(false)
  })

  it('listSessions 响应到达时服务端已生成正式标题 → 替换乐观标题并清除临时记录', () => {
    useStore.getState().sendMessage('帮我看看这个报错')
    pushResponse({ op: 'createSession', sessionId: NEW_SID })
    pushResponse({
      op: 'listSessions',
      sessions: [
        { sessionId: NEW_SID, title: '服务端正式标题', status: 'idle', mode: 'yolo', workspacePath: 'G:\mock', createdAt: 1, updatedAt: 1 },
      ],
    })

    const st = useStore.getState()
    expect(st.sessions.find((s) => s.sessionId === NEW_SID)?.title).toBe('服务端正式标题')
    expect(st.provisionalTitles[NEW_SID]).toBeUndefined()
  })

  it('已有会话发首条消息也设乐观标题（服务端标题为会话 id 时）', () => {
    useStore.setState({
      currentSessionId: NEW_SID,
      sessions: [{ sessionId: NEW_SID, title: NEW_SID, status: 'idle', mode: 'yolo', workspacePath: 'G:\mock', createdAt: 1, updatedAt: 1 }],
      streaming: false,
      messages: [],
    })
    useStore.getState().sendMessage('新会话第一个问题')

    const st = useStore.getState()
    expect(st.sessions.find((s) => s.sessionId === NEW_SID)?.title).toBe('新会话第一个问题')
  })

  it('已有正式标题的会话发消息不覆盖正式标题', () => {
    useStore.setState({
      currentSessionId: NEW_SID,
      sessions: [{ sessionId: NEW_SID, title: '已有正式标题', status: 'idle', mode: 'yolo', workspacePath: 'G:\mock', createdAt: 1, updatedAt: 1 }],
      streaming: false,
      messages: [],
    })
    useStore.getState().sendMessage('再问一句')

    const st = useStore.getState()
    expect(st.sessions.find((s) => s.sessionId === NEW_SID)?.title).toBe('已有正式标题')
  })
})
