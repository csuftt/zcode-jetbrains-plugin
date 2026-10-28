/**
 * 上下文窗口分母的事件权威通道（对齐官方 v4 投影 touchedByEvent）
 *
 * legacy session/read 的 runtime.contextUsage.size 被服务端投影初值锁死为 200000，
 * 模型真值（含用户自定义，如 ark-code-latest=256000）只随事件下发：
 *   - model_selected（切模即时，payload 无 querySource）
 *   - 主回合 model_complete（querySource=main_turn，与 contextUsageBreakdown 同包）
 * 二者在 legacy session/event 都映射为 session.updated。
 * applyContextBreakdownEvent 消费 payload.contextWindow 就地替换 contextUsage.size，
 * used/hitRate 保持 session/read 轮询读数；新会话无读数时不初始化（空环占位契约）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const storage = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) },
  key: (i: number) => Array.from(storage.keys())[i] ?? null,
  get length() { return storage.size },
  clear: () => storage.clear(),
}
vi.stubGlobal('localStorage', lsMock)
vi.stubGlobal('window', { localStorage: lsMock, dispatchEvent: () => {}, __ZCODE_KVSTORE__: null })

let messageHandler: ((msg: unknown) => void) | null = null
let streamHandler: ((sid: string, event: unknown) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamHandler = fn },
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import { useStore } from '@/store/useStore'

const SID = 'sess_ctxwin_1'
const OTHER_SID = 'sess_ctxwin_other'

function updated(payload: Record<string, unknown>, sessionId = SID): unknown {
  return { type: 'session.updated', seq: 1, sessionId, timestamp: 1791898970937, payload }
}

function dispatch(event: unknown): void {
  const ev = event as { sessionId?: string }
  streamHandler!(ev.sessionId ?? SID, event)
}

/** 模拟一次 session/read 用量读数（服务端 legacy size=200000）*/
function usageReading(overrides: Record<string, unknown> = {}): void {
  messageHandler!({ op: 'usage', sessionId: SID, used: 1234, size: 200000, hitRate: 0.42, ...overrides })
}

beforeEach(() => {
  storage.clear()
  useStore.setState({ currentSessionId: SID, contextUsage: null, streaming: false })
  useStore.getState().init()
})

describe('上下文窗口事件通道', () => {
  it('主回合完成事件 contextWindow 就地替换分母，used/hitRate 保持读数', () => {
    usageReading()
    dispatch(updated({ querySource: 'main_turn', contextWindow: 256000 }))
    expect(useStore.getState().contextUsage).toEqual({ used: 1234, size: 256000, hitRate: 0.42 })
  })

  it('切模事件（无 querySource、无 breakdown）即时更新分母', () => {
    usageReading()
    dispatch(updated({ model: 'glm-5.3', contextWindow: 1024000 }))
    expect(useStore.getState().contextUsage?.size).toBe(1024000)
    expect(useStore.getState().contextUsage?.used).toBe(1234)
  })

  it('新会话无用量读数时事件不初始化（空环占位契约不变）', () => {
    dispatch(updated({ model: 'x', contextWindow: 256000 }))
    expect(useStore.getState().contextUsage).toBeNull()
  })

  it('非当前会话事件不串分母', () => {
    usageReading()
    dispatch(updated({ querySource: 'main_turn', contextWindow: 256000 }, OTHER_SID))
    expect(useStore.getState().contextUsage?.size).toBe(200000)
  })

  it('querySource 非主回合（如 session_title）即使带窗口也忽略', () => {
    usageReading()
    dispatch(updated({ querySource: 'session_title', contextWindow: 256000 }))
    expect(useStore.getState().contextUsage?.size).toBe(200000)
  })

  it.each([
    ['缺失', {}],
    ['字符串', { contextWindow: '256000' }],
    ['零', { contextWindow: 0 }],
    ['负数', { contextWindow: -1 }],
    ['NaN', { contextWindow: Number.NaN }],
  ])('非法 contextWindow（%s）不动分母', (_label, payloadExtra) => {
    usageReading()
    dispatch(updated({ querySource: 'main_turn', ...payloadExtra }))
    expect(useStore.getState().contextUsage?.size).toBe(200000)
  })

  it('小数窗口向下取整（token 整数口径）', () => {
    usageReading()
    dispatch(updated({ querySource: 'main_turn', contextWindow: 256000.9 }))
    expect(useStore.getState().contextUsage?.size).toBe(256000)
  })

  it('同值事件不产生引用变化（避免无谓重渲染）', () => {
    usageReading({ size: 256000 })
    const before = useStore.getState().contextUsage
    dispatch(updated({ querySource: 'main_turn', contextWindow: 256000 }))
    expect(useStore.getState().contextUsage).toBe(before)
  })
})
