/**
 * 编辑重放全链路测试（编辑历史消息，2026-09-04）
 *
 * 锁定 submitEdit 编排（store 级，无 UI）：
 * 1. 提交 → 发 `/rewind conversation <msgId>`（不插乐观消息）
 * 2. rewind.triggered 事件 → 内存消息截断（目标轮删除）+ kv 落记忆
 * 3. turn.completed → 300ms 重拉 → 快照落地（applyRewindCuts 重放 kv 记忆）→ 自动重发编辑文本
 * 4. 失败路径：rewind turn 结束但 rewind.triggered 未到 → 放弃重发 + 错误提示
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, act } from '@testing-library/react'

let messageHandler: ((msg: unknown) => void) | null = null
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'

/* localStorage mock（jsdom 空壳，同 goal-card.spec 模式）*/
function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  }
}
Object.defineProperty(window, 'localStorage', { value: makeLocalStorage(), configurable: true, writable: true })

const SID = 'sess_edit'

/** 两轮完整会话（服务端 id 形态，u2 是最后一轮可编辑消息）*/
function twoTurns() {
  return [
    { info: { role: 'user', time: { created: 1 }, id: 'u1', sessionID: SID }, parts: [{ type: 'text', text: '问题一' }] },
    { info: { role: 'assistant', time: { created: 2, completed: 3 }, id: 'a1', sessionID: SID, anchor: { turnId: 't1' } }, parts: [{ type: 'text', text: '回答一' }] },
    { info: { role: 'user', time: { created: 4 }, id: 'u2', sessionID: SID }, parts: [{ type: 'text', text: '问题二' }] },
    { info: { role: 'assistant', time: { created: 5, completed: 6 }, id: 'a2', sessionID: SID, anchor: { turnId: 't2' } }, parts: [{ type: 'text', text: '回答二' }] },
  ] as never[]
}

beforeEach(() => {
  vi.useFakeTimers()
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  window.localStorage.removeItem('zcode.edit.rewind-cuts')
  useStore.setState({
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: twoTurns(),
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    compacting: false,
    editingMessageId: null,
    editReplay: null,
    loadingMessages: false,
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function streamBatch(events: unknown[]) {
  act(() => { streamBatchHandler?.(SID, events) })
}
const sends = () => sentRequests.filter((r) => r.op === 'send')
const idOf = () => useStore.getState().messages.map((m) => m.info.id)

describe('编辑重放全链路', () => {
  it('提交 → rewind 命令发出（无乐观消息）', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    // rewind 命令发出
    expect(sends().map((r) => r.text)).toEqual(['/rewind conversation u2'])
    // hiddenCommand：不插乐观用户消息
    expect(idOf()).toEqual(['u1', 'a1', 'u2', 'a2'])
    // 进入编辑重放态
    expect(useStore.getState().editReplay).toEqual({ targetMsgId: 'u2', text: '问题二（改）', rewound: false })
    expect(useStore.getState().editingMessageId).toBeNull()
  })

  it('rewind.triggered → 内存截断 + kv 落记忆 + 快照落地后自动重发', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    sentRequests.length = 0

    // rewind turn：started → triggered → completed
    streamBatch([
      { type: 'turn.started', sessionId: SID, turnId: 't_rw', timestamp: 10, payload: { turnNumber: 2, input: '/rewind conversation u2', messageId: 'u2' } },
    ])
    expect(useStore.getState().streaming).toBe(true)
    streamBatch([
      { type: 'rewind.triggered', sessionId: SID, turnId: 't_rw', timestamp: 11, payload: { rewindId: 'rw1', scope: 'conversation', strategy: 'active_chain', targetMessageId: 'u2', branchCutAfterMessageId: 'cmd1', branchGeneration: 1 } },
    ])
    // 内存截断：目标轮（u2+a2）删除，流式空壳（turn.started 借 messageId=u2 建
    // assistant 空壳后随截断一并清除）
    expect(idOf()).toEqual(['u1', 'a1'])
    expect(useStore.getState().editReplay?.rewound).toBe(true)
    // kv 记忆落盘
    expect(window.localStorage.getItem('zcode.edit.rewind-cuts')).toContain('"u2"')

    streamBatch([
      { type: 'turn.completed', sessionId: SID, turnId: 't_rw', timestamp: 12, payload: { response: 'Rewound conversation to before message u2.' } },
    ])
    expect(useStore.getState().streaming).toBe(false)

    // turnEnded 的 300ms 延迟重拉
    act(() => { vi.advanceTimersByTime(350) })
    expect(sentRequests.some((r) => r.op === 'messages')).toBe(true)

    // 服务端快照仍全量（快照不反映 rewind，实测行为）——落地按 kv 记忆截断为
    // [u1,a1]，随即自动重发编辑文本（乐观用户消息入列，最终态 3 条）
    act(() => {
      messageHandler?.({ op: 'messages', sessionId: SID, messages: twoTurns() })
    })
    expect(sends().map((r) => r.text)).toEqual(['问题二（改）'])
    expect(idOf().length).toBe(3) // u1 a1 + 重发的乐观新消息
    expect(idOf().slice(0, 2)).toEqual(['u1', 'a1'])
    expect(useStore.getState().editReplay).toBeNull()
  })

  it('rewind 未生效（无 rewind.triggered）→ 放弃重发 + 错误提示', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    sentRequests.length = 0

    streamBatch([
      { type: 'turn.started', sessionId: SID, turnId: 't_rw', timestamp: 10, payload: { turnNumber: 2, input: '/rewind conversation u2', messageId: 'u2' } },
    ])
    streamBatch([
      { type: 'turn.completed', sessionId: SID, turnId: 't_rw', timestamp: 12, payload: { response: 'Rewind unavailable' } },
    ])
    // 无 rewind.triggered → 失败路径：editReplay 清空
    expect(useStore.getState().editReplay).toBeNull()
    expect(useStore.getState().lastError).toBeTruthy()

    act(() => { vi.advanceTimersByTime(350) })
    act(() => { messageHandler?.({ op: 'messages', sessionId: SID, messages: twoTurns() }) })
    // 不重发；快照无 kv 记忆全量保留（上下文未变）
    expect(sends()).toEqual([])
    expect(idOf()).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('重进会话（快照首拉）按 kv 记忆截断显示', () => {
    // 模拟此前编辑过 u2（kv 已有记忆），重进会话快照全量落地
    window.localStorage.setItem('zcode.edit.rewind-cuts', JSON.stringify({ [SID]: ['u2'] }))
    act(() => {
      messageHandler?.({ op: 'messages', sessionId: SID, messages: twoTurns() })
    })
    expect(idOf()).toEqual(['u1', 'a1'])
  })

  it('多轮连续编辑的 kv 记忆顺序重放（编辑 u2 后又编辑新消息 u3）', () => {
    window.localStorage.setItem('zcode.edit.rewind-cuts', JSON.stringify({ [SID]: ['u2', 'u3'] }))
    const threeTurns = [
      ...twoTurns(),
      { info: { role: 'user', time: { created: 7 }, id: 'u3', sessionID: SID }, parts: [{ type: 'text', text: '问题三（编辑后）' }] },
      { info: { role: 'assistant', time: { created: 8, completed: 9 }, id: 'a3', sessionID: SID, anchor: { turnId: 't3' } }, parts: [{ type: 'text', text: '回答三' }] },
    ] as never[]
    act(() => {
      messageHandler?.({ op: 'messages', sessionId: SID, messages: threeTurns })
    })
    expect(idOf()).toEqual(['u1', 'a1'])
  })
})
