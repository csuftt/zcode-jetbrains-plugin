/**
 * v2 编辑 ack 乐观截断时序测试（diag-v2-edit-rewind 实测 + 2026-09-17 23:02 真机复现）
 *
 * v2 特性：rewind.triggered / 新回合 turn.started 不在 legacy 流；ack 是唯一确认。
 * 真机时序（idea.log 23:02:22）：stop → 收尾帧(第二段编辑) → [139ms 窗口] →
 * editAccepted ack → 新回合流式 → turn.completed。
 * 疑点：v2 旧回合停止存在双终点（真实 + 遥测合成），第二个终点若落在 ack 前，
 * 会以 rewound=false 误判失败——本用例钉死该时序。
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
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { commitStagedRewindCuts } from '@/utils/editHistory'

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

const SID = 'sess_edit_v2'

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
  window.localStorage.removeItem('zcode.edit.rewind-cuts-v2')
  commitStagedRewindCuts(SID, [])
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
    editViaV4: null,
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
const editOps = () => sentRequests.filter((r) => r.op === 'editUserQuery')
const idOf = () => useStore.getState().messages.map((m) => m.info.id)

/** v2 两段式 + ack 乐观截断全链（无重复终点干扰）*/
describe('v2 ack 乐观路径', () => {
  it('两段式 → editAccepted(newCli,rewind) 就地截断 → 新回合终点干净收尾，全程无误报', () => {
    useStore.setState({ editingMessageId: 'u2', streaming: true })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    expect(sentRequests.filter((r) => r.op === 'stop')).toHaveLength(1)

    // 旧回合收尾帧 → 第二段编辑
    streamBatch([{ type: 'turn.completed', sessionId: SID, turnId: 't_old', timestamp: 11, payload: { response: '' } }])
    expect(editOps()).toHaveLength(1)

    // v2 ack（无 rewind.triggered 事件）：就地乐观截断 + 补插编辑气泡
    act(() => {
      messageHandler?.({ op: 'editAccepted', sessionId: SID, disposition: 'rewind', newCli: true })
    })
    expect(idOf()).toEqual(['u1', 'a1', expect.stringMatching(/^local_u_/)])
    expect(useStore.getState().editReplay).toMatchObject({ rewound: true, via: 'v4' })

    // 新回合流式（v2 无 turn.started，归约器自建壳）+ 终点：编排干净收尾
    streamBatch([
      { type: 'model.streaming', sessionId: SID, turnId: 't_new', timestamp: 14, payload: { messageId: 'u2_server', input: '问题二（改）', text: '好' } },
      { type: 'turn.completed', sessionId: SID, turnId: 't_new', timestamp: 20, payload: { response: '回答' } },
    ])
    expect(useStore.getState().editReplay).toBeNull()
    expect(useStore.getState().lastError).toBeNull()
  })

  it('v2 双终点乱序：旧回合重复终点落在 ack 前，不得误判失败', () => {
    useStore.setState({ editingMessageId: 'u2', streaming: true })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    streamBatch([{ type: 'turn.completed', sessionId: SID, turnId: 't_old', timestamp: 11, payload: { response: '' } }])
    expect(editOps()).toHaveLength(1)

    // 旧回合的重复终点（真实/遥测合成双 completed）先于 ack 到达：
    // 编排在途（命令已发、ack 未到），不能按「新回合结束且未确认」清理+报错
    streamBatch([{ type: 'turn.completed', sessionId: SID, turnId: 't_old', timestamp: 12, payload: { response: '' } }])
    expect(useStore.getState().editReplay).not.toBeNull()
    expect(useStore.getState().lastError).toBeNull()

    // ack 到达：乐观截断照常生效
    act(() => {
      messageHandler?.({ op: 'editAccepted', sessionId: SID, disposition: 'rewind', newCli: true })
    })
    expect(idOf()).toEqual(['u1', 'a1', expect.stringMatching(/^local_u_/)])

    // 新回合终点：干净收尾
    streamBatch([{ type: 'turn.completed', sessionId: SID, turnId: 't_new', timestamp: 20, payload: { response: '回答' } }])
    expect(useStore.getState().editReplay).toBeNull()
    expect(useStore.getState().lastError).toBeNull()
  })

  it('v1（无 newCli 标记）路径不受影响：等 rewind.triggered，ack 不触发乐观截断', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    act(() => {
      messageHandler?.({ op: 'editAccepted', sessionId: SID, disposition: 'rewind' })
    })
    expect(useStore.getState().editReplay).toMatchObject({ rewound: false, via: 'v4' })
    expect(idOf()).toEqual(['u1', 'a1', 'u2', 'a2']) // 未截断
  })
})
