/**
 * 上下文构成明细的事件权威通道（NEW 代唯一活通道）
 *
 * NEW 代 zcode.cjs 的 session/read 永远不挂 breakdown：runtime 装配要求事件
 * contextWindow === runtime.size，而 runtime 模板默认 200000 与模型真值恒不等。
 * 主回合 model_complete 投影（legacy 事件面 type=session.updated，
 * querySource=main_turn）的 payload.contextUsageBreakdown [{source, chars}]
 * 是唯一数据源（temp_ai/probe-events-dump.txt 实证）。
 * applyContextBreakdownEvent 消费它落 contextBreakdown，并复用 breakdown 缓存
 * （used 取 payload.usage.totalTokens，与 session/read 的 contextUsage.used 同口径），
 * resume 到新进程后由 usage 响应的 loadBreakdownCache 兜底恢复。
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
import type { ContextBreakdownItem } from '@/types/messages'

const SID = 'sess_bd_evt_1'
const OTHER_SID = 'sess_bd_evt_other'
const PREFIX = 'zcode.ctxBreakdown.'

const BD: ContextBreakdownItem[] = [
  { source: 'system_prompt', chars: 7557 },
  { source: 'system_tool_schemas', chars: 87053 },
  { source: 'messages', chars: 48 },
]

function updated(payload: Record<string, unknown>, sessionId = SID): unknown {
  return { type: 'session.updated', seq: 1, sessionId, timestamp: 1791898970937, payload }
}

function dispatch(event: unknown): void {
  const ev = event as { sessionId?: string }
  streamHandler!(ev.sessionId ?? SID, event)
}

/** 主回合完成事件（与 probe-events-dump.txt 同构的最小形态）*/
function mainTurnEvent(breakdown: unknown, extra: Record<string, unknown> = {}): unknown {
  return updated({
    querySource: 'main_turn',
    contextWindow: 256000,
    usage: { inputTokens: 19959, outputTokens: 22, totalTokens: 19981 },
    contextUsageBreakdown: breakdown,
    ...extra,
  })
}

function resetState(sessionId = SID): void {
  useStore.setState({ currentSessionId: sessionId, contextUsage: null, contextBreakdown: null, streaming: false })
}

beforeEach(() => {
  storage.clear()
  resetState()
  useStore.getState().init()
})

describe('上下文构成事件通道', () => {
  it('主回合完成事件落 contextBreakdown 并按 used=usage.totalTokens 写缓存', () => {
    dispatch(mainTurnEvent(BD))
    expect(useStore.getState().contextBreakdown).toEqual(BD)
    const parsed = JSON.parse(storage.get(PREFIX + SID)!) as { breakdown: ContextBreakdownItem[]; used: number }
    expect(parsed.breakdown).toEqual(BD)
    expect(parsed.used).toBe(19981)
  })

  it('title 等非主回合 querySource 即使携带明细也忽略', () => {
    dispatch(mainTurnEvent(BD, { querySource: 'session_title' }))
    expect(useStore.getState().contextBreakdown).toBeNull()
  })

  it('querySource 缺失（如切模事件）不消费明细', () => {
    dispatch(updated({ contextWindow: 256000, contextUsageBreakdown: BD }))
    expect(useStore.getState().contextBreakdown).toBeNull()
  })

  it('非当前会话事件不串构成', () => {
    dispatch(mainTurnEvent(BD))
    // 直接以其他会话身份派发
    streamHandler!(OTHER_SID, updated({
      querySource: 'main_turn',
      usage: { totalTokens: 999 },
      contextUsageBreakdown: [{ source: 'messages', chars: 1 }],
    }, OTHER_SID))
    expect(useStore.getState().contextBreakdown).toEqual(BD)
    expect(storage.has(PREFIX + OTHER_SID)).toBe(false)
  })

  it('非法 source / chars 逐项过滤，合法项保留；全非法则整体忽略', () => {
    dispatch(mainTurnEvent([
      { source: 'messages', chars: 100 },
      { source: 'not_a_source', chars: 50 },
      { source: 'skills', chars: '200' },
      { source: 'skills', chars: -1 },
      { source: 'skills', chars: Number.NaN },
      'garbage',
    ]))
    expect(useStore.getState().contextBreakdown).toEqual([{ source: 'messages', chars: 100 }])
  })

  it('空数组/非数组/缺失不覆盖现有数据', () => {
    dispatch(mainTurnEvent(BD))
    dispatch(mainTurnEvent([]))
    expect(useStore.getState().contextBreakdown).toEqual(BD)
    dispatch(updated({ querySource: 'main_turn', usage: { totalTokens: 1 } }))
    expect(useStore.getState().contextBreakdown).toEqual(BD)
  })

  it('同值重放不产生引用变化（快照回放不触发无谓重渲染）', () => {
    dispatch(mainTurnEvent(BD))
    const before = useStore.getState().contextBreakdown
    dispatch(mainTurnEvent(BD))
    expect(useStore.getState().contextBreakdown).toBe(before)
  })

  it('缓存/usage 兜底互通：事件落缓存后，resume 无 breakdown 的 usage 同 used 恢复', () => {
    dispatch(mainTurnEvent(BD))
    // 模拟 resume 到新进程：内存态清空，服务端 session/read 无 breakdown
    resetState()
    messageHandler!({ op: 'usage', sessionId: SID, used: 19981, size: 256000, hitRate: 0.9 })
    expect(useStore.getState().contextBreakdown).toEqual(BD)
  })

  it('事件无 usage.totalTokens 时退化用当前 contextUsage.used 落缓存键', () => {
    useStore.setState({ contextUsage: { used: 321, size: 256000, hitRate: null } })
    dispatch(updated({
      querySource: 'main_turn',
      contextUsageBreakdown: [{ source: 'messages', chars: 10 }],
    }))
    const parsed = JSON.parse(storage.get(PREFIX + SID)!) as { used: number }
    expect(parsed.used).toBe(321)
  })
})
