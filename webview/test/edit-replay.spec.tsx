/**
 * 编辑重放全链路测试（编辑历史消息，2026-09-04；v4 editUserQuery 双通道 2026-09-12）
 *
 * v4 通道（diag-edit-v4 实测定案，主路径）：
 * 1. 提交 → op:editUserQuery（服务端 abort+rewind+重发一气呵成，回合中可用）
 * 2. rewind.triggered 事件 → 内存截断 + kv 落记忆（不依赖 editReplay 匹配）
 * 3. 编辑后新 turn 结束 → editReplay 清理，**不自动重发**（重发是服务端行为）
 * 4. editUnsupported（-32601）→ editViaV4 记 false；空闲时回退 legacy 编排
 *
 * legacy 通道（老 CLI /rewind 回退）：
 * 1. 提交 → 发 `/rewind conversation <msgId>`（不插乐观消息）
 * 2. rewind.triggered → 截断；turn.completed → 300ms 重拉 → 快照落地 → 自动重发
 * 3. 失败路径：rewind turn 结束但 rewind.triggered 未到 → 放弃重发 + 错误提示
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
  window.localStorage.removeItem('zcode.edit.rewind-cuts-v2')
  commitStagedRewindCuts(SID, []) // 清空模块级 staged cuts（跨用例隔离）
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
const sends = () => sentRequests.filter((r) => r.op === 'send')
const editOps = () => sentRequests.filter((r) => r.op === 'editUserQuery')
const idOf = () => useStore.getState().messages.map((m) => m.info.id)

const REWIND_EVENT = { type: 'rewind.triggered', sessionId: SID, turnId: 't_rw', timestamp: 11, payload: { rewindId: 'rw1', scope: 'conversation', strategy: 'active_chain', targetMessageId: 'u2', branchCutAfterMessageId: 'cmd1', branchGeneration: 1 } }

describe('v4 通道（editUserQuery，主路径）', () => {
  it('提交 → op:editUserQuery 发出（不插乐观消息、不发 /rewind），editReplay 乐观置位', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    expect(editOps()).toHaveLength(1)
    expect(editOps()[0]).toMatchObject({ sessionId: SID, messageId: 'u2', newText: '问题二（改）' })
    expect(editOps()[0].attachments).toBeUndefined()
    expect(sends()).toEqual([])
    expect(idOf()).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(useStore.getState().editReplay).toEqual({
      targetMsgId: 'u2', text: '问题二（改）', rewound: false, via: 'v4', ackPending: true,
    })
    expect(useStore.getState().editingMessageId).toBeNull()
  })

  it('带图编辑：附件全量清单随 op 透传（[] 也不能丢）', () => {
    useStore.setState({ editingMessageId: 'u2' })
    const images = [{ source: 'cache' as const, url: 'http://127.0.0.1:9/zcode-image/s1/image-x.png', mime: 'image/png' }]
    act(() => { useStore.getState().submitEdit('看图（改）', images) })
    expect(editOps()[0].attachments).toEqual(images)
    // 原带图消息编辑时删光图片 → 显式空数组透传（服务端语义=清空附件）
    useStore.setState({ editReplay: null, editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('删光图片', []) })
    expect(editOps()[1].attachments).toEqual([])
  })

  it('回合中编辑走两段式：先 stop，收尾帧后转第二段发 editUserQuery', () => {
    // diag-edit-blocked 实锤：服务端对「执行工具中」的回合 abort 不生效，直接编辑
    // 会被 steerQueued 静默排队且队列不自动排水（accepted 却永不生效）
    useStore.setState({ editingMessageId: 'u2', streaming: true })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    // 第一段：只发 stop，不发编辑
    expect(sentRequests.filter((r) => r.op === 'stop')).toHaveLength(1)
    expect(editOps()).toHaveLength(0)
    expect(useStore.getState().editReplay).toMatchObject({ targetMsgId: 'u2', via: 'v4', stopping: true })

    // stop 收尾帧（单独一批：turnEnded && !turnStarted）
    streamBatch([
      { type: 'turn.completed', sessionId: SID, turnId: 't_old', timestamp: 11, payload: { response: '' } },
    ])
    // 第二段：回合已死，发 editUserQuery（服务端走空闲编辑路径）
    expect(editOps()).toHaveLength(1)
    expect(editOps()[0]).toMatchObject({ messageId: 'u2', newText: '问题二（改）' })
    expect(useStore.getState().editReplay).toMatchObject({ via: 'v4', stopping: false })
    sentRequests.length = 0

    // 后续编排不变：rewind 截断 + 补插气泡（实时流立即可见）+ 新 turn 流式
    streamBatch([REWIND_EVENT])
    expect(idOf()).toEqual(['u1', 'a1', expect.stringMatching(/^local_u_/)])
    const bubble = useStore.getState().messages[2]
    expect(bubble.parts.some((p) => p.type === 'text' && (p as { text?: string }).text === '问题二（改）')).toBe(true)
    expect(useStore.getState().editReplay?.rewound).toBe(true)
    // v4 通道不直接落 kv（staged 判别提交）
    expect(window.localStorage.getItem('zcode.edit.rewind-cuts-v2')).toBeNull()

    streamBatch([
      { type: 'turn.started', sessionId: SID, turnId: 't_new', timestamp: 12, payload: { turnNumber: 1, input: '问题二（改）', messageId: 'u2_edited' } },
      { type: 'turn.completed', sessionId: SID, turnId: 't_new', timestamp: 20, payload: { response: '回答' } },
    ])
    // 编排终点：editReplay 清理、不发任何重发消息（重发是服务端行为）
    expect(useStore.getState().editReplay).toBeNull()
    expect(sends()).toEqual([])
    expect(idOf()).toEqual(['u1', 'a1', 'u2_edited', 'stream_u2_edited'])
  })

  it('编辑被服务端排队（steerQueued 命中编辑文本）：清编排 + 提示', () => {
    // diag-edit-blocked：工具执行中编辑 → 重发被排队不排水。防御：明确失败防指示器悬挂
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    streamBatch([
      { type: 'turn.steerQueued', sessionId: SID, turnId: 't_x', timestamp: 11, payload: { inputId: 'edit-1', input: '问题二（改）', queueLength: 1 } },
    ])
    expect(useStore.getState().editReplay).toBeNull()
    expect(useStore.getState().lastError).toBeTruthy()
  })

  it('steer 自身的 steerQueued（无 input 字段）不误伤编辑编排', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    streamBatch([
      { type: 'turn.steerQueued', sessionId: SID, turnId: 't_x', timestamp: 11, payload: { queueLength: 1 } },
    ])
    expect(useStore.getState().editReplay).not.toBeNull()
  })

  it('回合中编辑的就地改写语义（快照复用同 id）：staged cut 判别丢弃，不毒化 kv', () => {
    // 真机实锤（sess_4c4c67ae）：回合中编辑 → 新消息复用被编辑消息 id + 快照自行截断
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    streamBatch([REWIND_EVENT]) // targetId=u2，截断 + 补气泡 + staged
    streamBatch([
      { type: 'turn.started', sessionId: SID, turnId: 't_new', timestamp: 12, payload: { turnNumber: 1, input: '问题二（改）', messageId: 'u2' } },
    ])
    streamBatch([
      { type: 'turn.completed', sessionId: SID, turnId: 't_new', timestamp: 20, payload: { response: '回答' } },
    ])
    // 轮末重拉：快照复用 u2（新文本）+ 新回复——若 staged cut 落了 kv，重放会把新轮删光（空白主屏事故）
    act(() => {
      messageHandler?.({
        op: 'messages',
        sessionId: SID,
        messages: [
          { info: { role: 'user', time: { created: 1 }, id: 'u2', sessionID: SID }, parts: [{ type: 'text', text: '问题二（改）' }] },
          { info: { role: 'assistant', time: { created: 9, completed: 10 }, id: 'a2n', sessionID: SID, anchor: { turnId: 't_new' } }, parts: [{ type: 'text', text: '回答（改后）' }] },
        ] as never[],
      })
    })
    expect(idOf()).toEqual(['u2', 'a2n'])
    expect(window.localStorage.getItem('zcode.edit.rewind-cuts-v2')).toBeNull()
  })

  it('空闲编辑（快照保留旧轮 + 重发为新 id）：staged cut 判别落 kv，旧轮隐藏', () => {
    // 真机实锤（sess_34858bc0）：空闲编辑 → 旧轮原样留在快照，重发是新 id 消息
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    streamBatch([REWIND_EVENT]) // targetId=u2 截断 + staged
    streamBatch([
      { type: 'turn.started', sessionId: SID, turnId: 't_new', timestamp: 12, payload: { turnNumber: 3, input: '问题二（改）', messageId: 'u_new' } },
    ])
    streamBatch([
      { type: 'turn.completed', sessionId: SID, turnId: 't_new', timestamp: 20, payload: { response: '回答' } },
    ])
    // 轮末重拉：快照仍全量（旧轮在）+ 重发的新 id 消息
    act(() => {
      messageHandler?.({
        op: 'messages',
        sessionId: SID,
        messages: [
          ...twoTurns(),
          { info: { role: 'user', time: { created: 7 }, id: 'u_new', sessionID: SID }, parts: [{ type: 'text', text: '问题二（改）' }] },
          { info: { role: 'assistant', time: { created: 8, completed: 9 }, id: 'a_new', sessionID: SID, anchor: { turnId: 't_new' } }, parts: [{ type: 'text', text: '回答（改后）' }] },
        ] as never[],
      })
    })
    // staged 判别：目标 u2 在快照且其后有同文本重发（u_new）→ 落 kv → 旧轮隐藏
    expect(window.localStorage.getItem('zcode.edit.rewind-cuts-v2')).toContain('"u2"')
    expect(idOf()).toEqual(['u1', 'a1', 'u_new', 'a_new'])
  })

  it('editUnsupported（老 CLI）：editViaV4 记 false，空闲时回退 legacy /rewind 编排', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    expect(editOps()).toHaveLength(1)

    act(() => { messageHandler?.({ op: 'editUnsupported' }) })
    expect(useStore.getState().editViaV4).toBe(false)
    // 回退：/rewind 命令发出，via 修正为 legacy
    expect(sends().map((r) => r.text)).toEqual(['/rewind conversation u2'])
    expect(useStore.getState().editReplay).toMatchObject({ targetMsgId: 'u2', via: 'legacy' })
  })

  it('editUnsupported 在回合中发起的编辑只能放弃（legacy 与活动回合互斥）', () => {
    useStore.setState({ editingMessageId: 'u2', streaming: true })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    act(() => { messageHandler?.({ op: 'editUnsupported' }) })
    expect(useStore.getState().editViaV4).toBe(false)
    expect(useStore.getState().editReplay).toBeNull()
    expect(sends()).toEqual([])
    expect(useStore.getState().lastError).toBeTruthy()
  })

  it('editRejected：清编排 + 错误提示（专用 op 不复位 streaming）', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    useStore.setState({ streaming: true })
    act(() => { messageHandler?.({ op: 'editRejected', message: '只能编辑最后一轮用户消息' }) })
    expect(useStore.getState().editReplay).toBeNull()
    expect(useStore.getState().lastError).toContain('只能编辑最后一轮用户消息')
    expect(useStore.getState().streaming).toBe(true)
  })

  it('editRejected reason 码优先映射 i18n 文案（2026-09-13 review：协议层只发机器码）', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    useStore.setState({ streaming: true })
    // 已知码：文案取语言包（zh），message 原文（假设为英文/他语环境产物）不顶到用户
    act(() => { messageHandler?.({ op: 'editRejected', reason: 'attachmentResolveFailed', message: 'image attachment resolve failed' }) })
    expect(useStore.getState().lastError).toContain('图片附件解析失败')
    // 未知码：回退 message 原文
    act(() => { messageHandler?.({ op: 'editRejected', reason: 'futureCode', message: 'fallback text' }) })
    expect(useStore.getState().lastError).toBe('fallback text')
  })

  it('rewind.triggered 无 editReplay 匹配（ack 丢失）也照常截断并落 kv 记忆', () => {
    streamBatch([
      { type: 'turn.started', sessionId: SID, turnId: 't_rw', timestamp: 10, payload: { turnNumber: 2, input: 'x', messageId: 'u2' } },
    ])
    streamBatch([REWIND_EVENT])
    expect(idOf()).toEqual(['u1', 'a1'])
    expect(window.localStorage.getItem('zcode.edit.rewind-cuts-v2')).toContain('"u2"')
  })

  it('editUnsupported reason=targetGone（行流缺失）：纯文本空闲回退 legacy，不记全局不可用', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    act(() => { messageHandler?.({ op: 'editUnsupported', reason: 'targetGone', message: '原对话已不包含那条消息' }) })
    // 会话级瞬态：不记 editViaV4=false（误伤后续新会话）
    expect(useStore.getState().editViaV4).toBeNull()
    // 纯文本目标：本次降级 legacy /rewind（legacy 不依赖行流）
    expect(sends().map((r) => r.text)).toEqual(['/rewind conversation u2'])
    expect(useStore.getState().editReplay).toMatchObject({ targetMsgId: 'u2', via: 'legacy' })
    expect(useStore.getState().lastError).toBeNull()
  })

  it('editUnsupported reason=targetGone：带图目标不得回退（legacy 重发丢图），明确提示', () => {
    useStore.setState({ editingMessageId: 'u2' })
    const images = [{ source: 'cache' as const, url: 'http://127.0.0.1:9/zcode-image/s1/image-x.png', mime: 'image/png' }]
    act(() => { useStore.getState().submitEdit('看图（改）', images) })
    act(() => { messageHandler?.({ op: 'editUnsupported', reason: 'targetGone', message: '原对话已不包含那条消息' }) })
    expect(useStore.getState().editReplay).toBeNull()
    expect(sends()).toEqual([])
    expect(useStore.getState().editViaV4).toBeNull()
    expect(useStore.getState().lastError).toBeTruthy()
  })

  it('editUnsupported reason=targetGone：回合中发起的编辑放弃且不记全局不可用', () => {
    useStore.setState({ editingMessageId: 'u2', streaming: true })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    act(() => { messageHandler?.({ op: 'editUnsupported', reason: 'targetGone' }) })
    expect(useStore.getState().editReplay).toBeNull()
    expect(useStore.getState().editViaV4).toBeNull()
    expect(sends()).toEqual([])
    expect(useStore.getState().lastError).toBeTruthy()
  })

  it('编辑后新回合 turn.started 即清 editReplay（编排终点提前）：回合运行期可立即再编辑', () => {
    // 用户三轮反馈三：editReplay 原本挂到 turnEnded，整个回合运行期 editOpen/startEdit
    // 全挡——表现为「编辑一次后实时会话中不允许再编辑」（服务端对连续编辑无限制，
    // diag-edit-double 实锤）
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（改）') })
    streamBatch([REWIND_EVENT])
    expect(useStore.getState().editReplay).toMatchObject({ rewound: true })
    streamBatch([
      { type: 'turn.started', sessionId: SID, turnId: 't_new', timestamp: 12, payload: { turnNumber: 3, input: '问题二（改）', messageId: 'u2n' } },
    ])
    // 编排终点提前：editReplay 已清，回合运行期（streaming）再编辑放行
    expect(useStore.getState().editReplay).toBeNull()
    useStore.setState({ streaming: true })
    act(() => { useStore.getState().startEdit() })
    expect(useStore.getState().editingMessageId).toBe('u2n')
    act(() => { useStore.getState().submitEdit('问题二（改2）') })
    // 回合中提交 → stop-first 两段式（不能直接编辑活回合）：先 stop
    expect(sentRequests.filter((r) => r.op === 'stop')).toHaveLength(1)
    expect(useStore.getState().editReplay).toMatchObject({ targetMsgId: 'u2n', via: 'v4', stopping: true })
    // 旧回合收尾帧到达 → 转第二段发第二个 editUserQuery（连续编辑全程无阻）
    streamBatch([
      { type: 'turn.completed', sessionId: SID, turnId: 't_new', timestamp: 20, payload: { response: 'x' } },
    ])
    expect(editOps()).toHaveLength(2)
    expect(editOps()[1]).toMatchObject({ messageId: 'u2n', newText: '问题二（改2）' })
  })
})

describe('legacy 通道（/rewind 回退，老 CLI）', () => {
  beforeEach(() => {
    useStore.setState({ editViaV4: false })
  })

  it('提交 → rewind 命令发出（无乐观消息）', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（修改）') })
    // rewind 命令发出
    expect(sends().map((r) => r.text)).toEqual(['/rewind conversation u2'])
    // hiddenCommand：不插乐观用户消息
    expect(idOf()).toEqual(['u1', 'a1', 'u2', 'a2'])
    // 进入编辑重放态
    expect(useStore.getState().editReplay).toEqual({ targetMsgId: 'u2', text: '问题二（修改）', rewound: false, via: 'legacy' })
    expect(useStore.getState().editingMessageId).toBeNull()
  })

  it('rewind.triggered → 内存截断 + kv 落记忆 + 快照落地后自动重发', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（修改）') })
    sentRequests.length = 0

    // rewind turn：started → triggered → completed
    streamBatch([
      { type: 'turn.started', sessionId: SID, turnId: 't_rw', timestamp: 10, payload: { turnNumber: 2, input: '/rewind conversation u2', messageId: 'u2' } },
    ])
    expect(useStore.getState().streaming).toBe(true)
    streamBatch([REWIND_EVENT])
    // 内存截断：目标轮（u2+a2）删除，流式空壳（turn.started 借 messageId=u2 建
    // assistant 空壳后随截断一并清除）
    expect(idOf()).toEqual(['u1', 'a1'])
    expect(useStore.getState().editReplay?.rewound).toBe(true)
    // kv 记忆落盘
    expect(window.localStorage.getItem('zcode.edit.rewind-cuts-v2')).toContain('"u2"')

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
    expect(sends().map((r) => r.text)).toEqual(['问题二（修改）'])
    expect(idOf().length).toBe(3) // u1 a1 + 重发的乐观新消息
    expect(idOf().slice(0, 2)).toEqual(['u1', 'a1'])
    expect(useStore.getState().editReplay).toBeNull()
  })

  it('rewind 未生效（无 rewind.triggered）→ 放弃重发 + 错误提示', () => {
    useStore.setState({ editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（修改）') })
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

  it('回合进行中不开放 legacy 编辑（rewind 与活动回合互斥）', () => {
    useStore.setState({ streaming: true, editingMessageId: 'u2' })
    act(() => { useStore.getState().submitEdit('问题二（修改）') })
    expect(sends()).toEqual([])
    expect(useStore.getState().editReplay).toBeNull()
    expect(useStore.getState().editingMessageId).toBe('u2')
  })
})

describe('编辑截断的显示对账', () => {
  it('重进会话（快照首拉）按 kv 记忆截断显示', () => {
    // 模拟此前编辑过 u2（kv 已有记忆），重进会话快照全量落地
    window.localStorage.setItem('zcode.edit.rewind-cuts-v2', JSON.stringify({ [SID]: ['u2'] }))
    act(() => {
      messageHandler?.({ op: 'messages', sessionId: SID, messages: twoTurns() })
    })
    expect(idOf()).toEqual(['u1', 'a1'])
  })

  it('多轮连续编辑的 kv 记忆顺序重放（编辑 u2 后又编辑新消息 u3）', () => {
    window.localStorage.setItem('zcode.edit.rewind-cuts-v2', JSON.stringify({ [SID]: ['u2', 'u3'] }))
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
