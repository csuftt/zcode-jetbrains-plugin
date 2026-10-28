/**
 * 服务端运行中会话空标题覆盖回归测试（缺陷X 残留，2026-08-25 PyCharm 实测）
 *
 * 背景：zcode.cjs 的 session/list 对「运行中的会话」用内存对象补列（dee({app})），
 * title 恒空；0.16.5 创建的正斜杠行会话在主查询（反斜杠形态）缺失、alt 补查的
 * sqlite 完整行被 sessionId 去重丢弃 → 响应里该会话 title 空 → header/历史列表
 * 回退会话 id 前缀，且随会话运行状态反复横跳（17:01:00 正确→17:01:04 回退实测）。
 *
 * 断言：响应 title 空/占位时，上一帧 sessions 有非占位标题 → 沿用旧值，不回退
 * sess_id；响应 title 完整时正常采用（不误伤服务端权威值）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock 桥接层：捕获 sendToJava，手动注入响应 ----
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

import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

const SID = 'sess_37b3cf88-4929-4f91-bec6-d0d1b0f56618'

function pushSessions(sessions: Array<Record<string, unknown>>): void {
  messageHandler!({ op: 'listSessions', sessions })
}

function makeSession(title: string, id = SID): Record<string, unknown> {
  return {
    sessionId: id,
    title,
    status: 'idle',
    mode: 'yolo',
    workspacePath: 'G:\\mock',
    workspaceKey: 'G:\\mock',
    createdAt: 1,
    updatedAt: 1,
  }
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
    sessions: [],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('listSessions 空标题沿用上一帧（防服务端运行中会话空值覆盖）', () => {
  it('响应 title 空但上一帧有完整标题：沿用旧标题，不回退 sess_id', () => {
    useStore.setState({ sessions: [makeSession('脚本索引名后缀改为读取STAGE环境变量')] })
    // 刷新：服务端对该运行中会话返回空 title（内存序列化缺陷）
    pushSessions([makeSession('')])
    const st = useStore.getState()
    expect(st.sessions[0].title).toBe('脚本索引名后缀改为读取STAGE环境变量')
  })

  it('响应 title 为会话 id 占位时同样沿用上一帧完整标题', () => {
    useStore.setState({ sessions: [makeSession('脚本索引名后缀改为读取STAGE环境变量')] })
    pushSessions([makeSession(SID)])
    expect(useStore.getState().sessions[0].title).toBe('脚本索引名后缀改为读取STAGE环境变量')
  })

  it('响应 title 完整：正常采用服务端权威值（不误伤）', () => {
    useStore.setState({ sessions: [makeSession('旧标题')] })
    pushSessions([makeSession('新标题（服务端权威）')])
    expect(useStore.getState().sessions[0].title).toBe('新标题（服务端权威）')
  })

  it('上一帧无该会话（新会话首次出现且 title 空）：保持原样，不凭空造标题', () => {
    pushSessions([makeSession('')])
    expect(useStore.getState().sessions[0].title).toBe('')
  })

  it('上一帧也是占位标题：不沿用，保持空（防把占位当权威）', () => {
    useStore.setState({ sessions: [makeSession(SID)] })
    pushSessions([makeSession('')])
    expect(useStore.getState().sessions[0].title).toBe('')
  })

  it('连贯序列：完整 → 空（沿用）→ 完整（更新），无横跳且不粘死', () => {
    useStore.setState({ sessions: [makeSession('脚本索引名后缀改为读取STAGE环境变量')] })
    // 会话运行中 → 空 title 刷新
    pushSessions([makeSession('')])
    expect(useStore.getState().sessions[0].title).toBe('脚本索引名后缀改为读取STAGE环境变量')
    // 会话退出运行 → 服务端恢复完整标题
    pushSessions([makeSession('脚本索引名后缀改为读取STAGE环境变量（权威更新）')])
    expect(useStore.getState().sessions[0].title).toBe('脚本索引名后缀改为读取STAGE环境变量（权威更新）')
  })
})
