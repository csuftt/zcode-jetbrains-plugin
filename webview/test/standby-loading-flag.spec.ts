/**
 * 缺陷FH 回归测试（2026-10-23 修复）：进入待命态/切换走时必须解除首拉加载标志
 *
 * 复现场景：会话加载中（selectSession 已置 loadingMessages=true、messages 首拉在途，
 * 大会话/服务端忙窗口可持续数十秒）点顶部 + 选「覆盖当前标签页」→ resetToNewSession
 * 把 currentSessionId 置回 null 但不清 loadingMessages → 在途快照回来被 case 'messages'
 * 的 sessionId 守卫整包丢弃 → applyMessagesSnapshot 永不执行 →「加载消息中」永久卡死、
 * 模型为空致发送键恒灰，标签假死只能重开。
 *
 * 修复后行为（本文件断言）：
 *   1. resetToNewSession 解除 loadingMessages（治本），迟到的旧会话快照仍被守卫丢弃
 *      （不落地到待命态），界面回落欢迎页。
 *   2. 同族三处补清：sessionDeleted（删当前会话）/ newSession（Java 自动切换）/
 *      createSession 响应（刁钻前置：加载标志在途时建会话响应先到）均解除标志。
 *   3. 对照组：正常 selectSession → 快照落地 → 标志复位，正常路径不回退。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- mock localStorage（node 环境无实现）----
const storage = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) },
  key: (i: number) => Array.from(storage.keys())[i] ?? null,
  get length() { return storage.size },
  clear: () => { storage.clear() },
}
vi.stubGlobal('localStorage', lsMock)
vi.stubGlobal('window', { localStorage: lsMock, dispatchEvent: () => {}, __ZCODE_KVSTORE__: null })

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
import type { ZCodeMessage } from '@/types/messages'

const SID = 'sess_fh_old'
const NEW_SID = 'sess_fh_new'

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

/** 历史会话条目 */
function sessionEntry(sessionId: string): Record<string, unknown> {
  return { sessionId, title: `会话-${sessionId}`, status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 1 }
}

/** 服务端快照消息（单条 user） */
function serverUserMessage(id = 'srv_u_1'): ZCodeMessage {
  return {
    info: { role: 'user', id, sessionID: SID, time: { created: Date.now() - 1_000 } },
    parts: [{ type: 'text', text: '历史消息' }],
  }
}

/** 复现链路头部：已选中会话、首拉在途（快照未达） */
function selectSessionFirstFetchInFlight(): void {
  useStore.getState().selectSession(sessionEntry(SID) as never)
  expect(useStore.getState().loadingMessages).toBe(true)
  expect(sentRequests.some((r) => r.op === 'messages' && r.sessionId === SID)).toBe(true)
}

beforeEach(() => {
  vi.useFakeTimers()
  storage.clear()
  sentRequests.length = 0
  useStore.getState().init() // 注册桥接回调（onMessage）
  sentRequests.length = 0 // 清掉 init 触发的 listSessions/listModels
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
    currentModel: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('缺陷FH：进入待命态解除首拉加载标志（加载中点 + 覆盖标签不再假死）', () => {
  it('主场景：首拉在途时 resetToNewSession 解除标志，迟到快照被守卫丢弃', () => {
    selectSessionFirstFetchInFlight()

    // 快照未达时用户点 + 选「覆盖当前标签页」
    useStore.getState().resetToNewSession()
    const st = useStore.getState()
    expect(st.currentSessionId).toBeNull()
    // 修复前：loadingMessages 仍 true →「加载消息中」永久卡死
    expect(st.loadingMessages).toBe(false)

    // 迟到的旧会话快照到达：待命态下仍须被 sessionId 守卫丢弃（不落地、不报错）
    expect(() => pushResponse({ op: 'messages', sessionId: SID, messages: [serverUserMessage()] })).not.toThrow()
    const after = useStore.getState()
    expect(after.currentSessionId).toBeNull()
    expect(after.messages).toHaveLength(0)
    expect(after.loadingMessages).toBe(false)
  })

  it('同族：首拉在途时删除当前会话（sessionDeleted）解除标志', () => {
    selectSessionFirstFetchInFlight()
    pushResponse({ op: 'sessionDeleted', sessionId: SID })
    const st = useStore.getState()
    expect(st.currentSessionId).toBeNull()
    expect(st.loadingMessages).toBe(false)
  })

  it('同族：首拉在途时 Java 自动 newSession 切走，新会话无历史、标志解除', () => {
    selectSessionFirstFetchInFlight()
    pushResponse({ op: 'newSession', sessionId: NEW_SID })
    const st = useStore.getState()
    expect(st.currentSessionId).toBe(NEW_SID)
    expect(st.messages).toHaveLength(0)
    expect(st.loadingMessages).toBe(false)
  })

  it('同族：加载标志在途时 createSession 响应先到（待命态切换），标志解除', () => {
    // 刁钻前置：待命态 + 标志残留（例如先 selectSession 加载中又经特殊路径回到无会话）
    useStore.setState({ currentSessionId: null, loadingMessages: true, creatingSession: true })
    pushResponse({ op: 'createSession', sessionId: NEW_SID })
    const st = useStore.getState()
    expect(st.currentSessionId).toBe(NEW_SID)
    expect(st.creatingSession).toBe(false)
    expect(st.loadingMessages).toBe(false)
  })

  it('对照组：正常 selectSession → 快照落地 → 标志复位、消息渲染（正常路径不回退）', () => {
    selectSessionFirstFetchInFlight()
    pushResponse({ op: 'messages', sessionId: SID, messages: [serverUserMessage()] })
    const st = useStore.getState()
    expect(st.currentSessionId).toBe(SID)
    expect(st.messages).toHaveLength(1)
    expect(st.loadingMessages).toBe(false)
  })
})
