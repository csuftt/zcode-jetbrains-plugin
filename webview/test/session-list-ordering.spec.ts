/**
 * 历史会话列表时间倒序回归测试（排序收口在 store 的 listSessions 归约）：
 * 服务端快照本应整体按 updatedAt 倒序，但两类本地补插会破坏全局顺序——
 *   ① 旧快照缺失的本地会话 staleLocal 追加在数组尾部（并发时序防御的副作用）
 *   ② 乐观新建插在头部（其 updatedAt 更大，头部恰好正确，但作为输入一并验证）
 * 表现：历史列表出现"最新的会话垫底"——不再严格按时间倒序。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
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
  useStore.getState().init()
  sentRequests.length = 0
  resetToIdleNoSession()
})

function session(id: string, updatedAt: number): Record<string, unknown> {
  return { sessionId: id, title: id, status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', createdAt: updatedAt, updatedAt }
}

describe('历史列表时间倒序', () => {
  it('服务端快照本身乱序（双形态并集拼接）→ 按 updatedAt 倒序重排', () => {
    pushResponse({
      op: 'listSessions',
      sessions: [
        session('sess_new', 3000),
        session('sess_mid', 2000),
        session('sess_old', 1000),
      ],
    })
    // 模拟服务端乱序：最新会话垫底（如旧版本拼接缺陷的响应形态）
    useStore.setState({
      sessions: [
        session('sess_mid', 2000) as never,
        session('sess_old', 1000) as never,
        session('sess_new', 3000) as never,
      ],
    })
    pushResponse({
      op: 'listSessions',
      sessions: [
        session('sess_mid', 2000),
        session('sess_old', 1000),
        session('sess_new', 3000),
      ],
    })
    expect(useStore.getState().sessions.map((s) => s.sessionId)).toEqual([
      'sess_new',
      'sess_mid',
      'sess_old',
    ])
  })

  it('旧快照晚到：本地保留的会话（staleLocal）不再垫底，按时间归位', () => {
    // 本地已有一个更新的会话（乐观创建场景）
    useStore.setState({
      currentSessionId: 'sess_local_new',
      sessions: [session('sess_local_new', 9000) as never],
      streaming: false,
      messages: [],
    })
    // 旧快照（不含本地会话）晚到
    pushResponse({
      op: 'listSessions',
      sessions: [
        session('sess_mid', 2000),
        session('sess_old', 1000),
      ],
    })
    const ids = useStore.getState().sessions.map((s) => s.sessionId)
    expect(ids).toContain('sess_local_new')
    expect(ids[0]).toBe('sess_local_new') // 最新的本地会话应排第一，而非数组尾
    expect(ids).toEqual(['sess_local_new', 'sess_mid', 'sess_old'])
  })
})
