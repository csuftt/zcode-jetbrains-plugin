/**
 * 回合失败 / 后端 API 错误的展示回归测试
 *
 * 复现缺陷（2026-08-18，idea.log 时序证据）：
 *   模型后端 429 token_quota_exceeded → app-server 按可重试分类指数退避，
 *   turn 终止帧迟迟不发 → 前端无限转圈且无任何提示；
 *   即使 turn.failed 到达，streamReducer 也与 turn.completed 同分支处理，
 *   payload.error 被整体丢弃——失败只表现为"转圈停了"。
 *
 * 断言：
 *   1. turn.failed 的 payload.error 被提取（turnError），store 写入顶栏 lastError
 *   2. turn.completed 不产生错误提示
 *   3. backendError（stderr 兜底通道）：配额类给专门文案，且不复位 streaming
 *   4. 配额类 turn.failed 同样归一为配额文案
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
import { applyStreamEvent, looksLikeQuotaError } from '@/utils/streamReducer'
import type { StreamEvent } from '@/types/messages'

const SID = 'sess_err_1'

function pushEvent(type: string, payload: Record<string, unknown>, seq = 100): void {
  streamEventHandler!(SID, {
    type, seq, sessionId: SID, turnId: 'turn_err', timestamp: Date.now(), payload,
  })
}

function mkEvent(type: string, payload: Record<string, unknown>): StreamEvent {
  return { type, seq: 1, sessionId: SID, turnId: 't', timestamp: 1, payload } as StreamEvent
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
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('reducer：turn.failed 错误提取', () => {
  it('payload.error 被提取为 turnError', () => {
    const r = applyStreamEvent([], mkEvent('turn.failed', {
      error: { type: 'api_error', code: 'internal_error', message: 'boom' },
    }), null)
    expect(r.turnEnded).toBe(true)
    expect(r.turnError).toEqual({ message: 'boom', type: 'api_error', code: 'internal_error' })
  })

  it('turn.failed 缺 error 时 turnError.message 为空（store 走兜底文案）', () => {
    const r = applyStreamEvent([], mkEvent('turn.failed', {}), null)
    expect(r.turnError).toEqual({ message: '' })
  })

  it('turn.completed 不产生 turnError', () => {
    const r = applyStreamEvent([], mkEvent('turn.completed', { usage: {} }), null)
    expect(r.turnEnded).toBe(true)
    expect(r.turnError).toBeUndefined()
  })
})

describe('looksLikeQuotaError', () => {
  it('识别 token_quota_exceeded', () => {
    expect(looksLikeQuotaError('token_quota_exceeded')).toBe(true)
    expect(looksLikeQuotaError(undefined, 'Token Plan Person monthly quota limit exceeded')).toBe(false) // 无 quota_exceeded/token_quota 子串
    expect(looksLikeQuotaError(undefined, '... {\'type\': \'quota_exceeded\'}')).toBe(true)
    expect(looksLikeQuotaError('rate_limit_exceeded')).toBe(false)
  })
})

describe('store：turn.failed 顶栏提示', () => {
  it('失败回合写入 lastError 并复位 streaming', () => {
    useStore.setState({ streaming: true, streamingMessageId: 'msg_a1' })
    pushEvent('turn.failed', {
      error: { type: 'api_error', code: 'internal_error', message: 'Error code: 500 - mock 内部错误' },
    })
    const st = useStore.getState()
    expect(st.streaming).toBe(false)
    expect(st.lastError).toBeTruthy()
    expect(st.lastError).toContain('mock 内部错误')
  })

  it('turn.completed 不写 lastError', () => {
    useStore.setState({ streaming: true, streamingMessageId: 'msg_a1', lastError: null })
    pushEvent('turn.completed', {})
    expect(useStore.getState().lastError).toBeNull()
  })

  it('配额类 turn.failed 归一为配额文案（含"不会成功"提示）', () => {
    useStore.setState({ streaming: true, streamingMessageId: 'msg_a1' })
    pushEvent('turn.failed', {
      error: { type: 'api_error', message: "Error code: 429 - {'code': 'token_quota_exceeded'}" },
    })
    const st = useStore.getState()
    expect(st.lastError).toContain('配额')
  })
})

describe('store：backendError（stderr 兜底通道）', () => {
  it('配额超限给专门文案，且不复位 streaming（服务端仍在重试）', () => {
    useStore.setState({ streaming: true, streamingMessageId: 'msg_a1', lastError: null })
    messageHandler!({
      op: 'backendError',
      statusCode: 429,
      code: 'token_quota_exceeded',
      message: 'Token Plan Person monthly quota limit exceeded',
    })
    const st = useStore.getState()
    expect(st.lastError).toContain('配额')
    expect(st.streaming).toBe(true) // 关键：不误判回合已结束
  })

  it('非配额错误透传 statusCode 与 message', () => {
    messageHandler!({
      op: 'backendError',
      statusCode: 503,
      code: 'service_unavailable',
      message: 'upstream overloaded',
    })
    const lastError = useStore.getState().lastError || ''
    expect(lastError).toContain('503')
    expect(lastError).toContain('upstream overloaded')
  })
})
