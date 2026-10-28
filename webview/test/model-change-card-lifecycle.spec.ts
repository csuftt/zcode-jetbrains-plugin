/**
 * 延迟切换合成卡生命周期复现测试（2026-09-14 用户实测现象排查）：
 * 「对话过程中切换模型，对话完成后，主界面的切换文案会被实时流刷掉，
 *   排队消息也会顶掉切换文案，回合结束后会正常渲染出来」
 *
 * 完整时序复现（真实事件顺序）：
 *   1. 回合 N 流式中用户切模型 → modelSetPending（挂起）
 *   2. turn.completed → streaming=false → flushQueue 自动发出排队消息
 *      （sendMessage 乐观插入用户消息 → waitForModelSwitchSettled 等 modelSet）
 *   3. modelSet（延迟补发落定）→ 合成卡插入【观察点1】
 *   4. 500ms 后 send 发出 → turn.started → 新回合 streaming=true
 *   5. 过期快照重拉响应到达（streaming 中）→ 被守卫丢弃，卡应保留【观察点2】
 *   6. 新回合结束 → 重拉快照（marker 已随 send 落库）→ 真身接管、合成卡摘除【观察点3】
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

const SID = 'sess_card_1'
const GLM = { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' }
const FLASH = { modelId: 'GLM-5.3-Flash', providerId: 'builtin:bigmodel-coding-plan' }

function pushEvent(type: string, payload: Record<string, unknown> = {}, turnId = 'turn_n'): void {
  streamEventHandler!(SID, {
    type, seq: 100, sessionId: SID, turnId, timestamp: Date.now(), payload,
  })
}

function pushResponse(msg: Record<string, unknown>): void {
  messageHandler!(msg)
}

/** 轮 N 的 assistant 消息（带 turnId 锚，模拟已完成回合） */
function assistantMsg(id: string, turnId: string): ZCodeMessage {
  return {
    info: { role: 'assistant', id, sessionID: SID, time: { created: 1, completed: 2 }, anchor: { turnId } },
    parts: [{ type: 'text', text: `回复-${id}` }],
  }
}

function syntheticCards(): ZCodeMessage[] {
  return useStore.getState().messages.filter((m) => String(m.info.id ?? '').startsWith('synthetic-model-change-'))
}

beforeEach(() => {
  vi.useFakeTimers()
  storage.clear()
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [assistantMsg('a_turn_n', 'turn_n')],
    streaming: true,
    streamingMessageId: 'stream_x',
    waitingSince: null,
    compacting: false,
    // 排队消息一条（回合 N 中用户 Enter 入队）
    queuedMessages: [{ text: '排队的问题' } as never],
    subagentActivities: [],
    subagents: [],
    childSessionKeys: {},
    sessions: [{ sessionId: SID, title: 't', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    provisionalTitles: {},
    currentModel: { ...GLM },
    models: [
      { ...GLM, label: 'GLM-5.3' },
      { ...FLASH, label: 'GLM-5.3-Flash' },
    ],
    modelAppliedSessions: new Map(),
    modelAckSessions: new Set(),
    modelSwitchInFlightAt: null,
    modelPendingSwitch: null,
    modelSwitchPrevModel: null,
    syntheticModelChanges: {},
    lastNotice: null,
    lastError: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('延迟切换合成卡生命周期（排队消息场景）', () => {
  it('回合结束 flush → modelSet 插卡 → 新回合过期快照不顶卡 → 真身接管', async () => {
    // 1. 回合 N 中切模型 → setModel 请求发出
    useStore.getState().setModel(FLASH.modelId, FLASH.providerId)
    expect(sentRequests.filter((r) => r.op === 'setModel').length).toBe(1)

    // 2. Java 挂起回执：回滚选中态 + 挂起标记
    pushResponse({ op: 'modelSetPending', sessionId: SID, ...FLASH })
    let st = useStore.getState()
    expect(st.modelPendingSwitch?.modelId).toBe(FLASH.modelId)
    expect(st.currentModel).toEqual(GLM) // 回滚显示
    expect(st.streaming).toBe(true) // 回合仍在跑

    // 3. 回合 N 结束：streaming=false → flushQueue 自动发出排队消息
    //    （sendMessage 乐观插入用户消息 + 乐观转圈 streaming=true，
    //     waitForModelSwitchSettled 等 modelSet 期间 UI 已呈流式态）
    pushEvent('turn.completed', {}, 'turn_n')
    st = useStore.getState()
    expect(st.queuedMessages).toEqual([]) // 已出队
    // 乐观用户消息已插入 + sendMessage 乐观转圈（补发 RPC 往返期间 streaming=true）
    expect(st.messages.some((m) => m.info.role === 'user' && String(m.info.id).startsWith('local_u_'))).toBe(true)
    expect(st.streaming).toBe(true)
    // send 还没发出（等 modelSet + 500ms）
    expect(sentRequests.filter((r) => r.op === 'send').length).toBe(0)

    // 4. modelSet（延迟补发落定）到达【观察点1】：streaming=true（sendMessage 乐观
    //    转圈）但本轮乐观 user 消息是消息流尾部——卡应插到它前面（与落库位置一致）
    pushResponse({ op: 'modelSet', sessionId: SID, ...FLASH })
    st = useStore.getState()
    const cards1 = syntheticCards()
    expect(cards1.length).toBe(1) // 卡必须插上（修复前：streaming 守卫整段跳过）
    expect(st.syntheticModelChanges[SID]?.length).toBe(1)
    expect(st.currentModel).toEqual(FLASH)
    // 卡紧贴在本轮乐观用户消息之前（=服务端 marker 落库位置：切换后第一条新消息之前）
    const lastIdx = st.messages.length - 1
    expect(String(st.messages[lastIdx].info.id).startsWith('local_u_')).toBe(true)
    expect(String(st.messages[lastIdx - 1].info.id).startsWith('synthetic-model-change-')).toBe(true)

    // 5. waitForModelSwitchSettled：modelSet 已清挂起 → 100ms tick + 500ms 缓冲后 send
    await vi.advanceTimersByTimeAsync(700)
    expect(sentRequests.filter((r) => r.op === 'send').length).toBe(1)

    // 6. 新回合 N+1 开始
    pushEvent('turn.started', { messageId: 'u_n1', input: '排队的问题' }, 'turn_n1')
    st = useStore.getState()
    expect(st.streaming).toBe(true)
    expect(syntheticCards().length).toBe(1) // 卡仍在

    // 7. N+1 流式期间过期快照到达（无 marker——marker 随 send 落库，但这条是
    //    turn.completed 触发的 300ms 延迟重拉，晚于新回合开跑）【观察点2】
    pushResponse({
      op: 'messages',
      sessionId: SID,
      workspacePath: 'G:\\mock',
      messages: [
        assistantMsg('a_turn_n', 'turn_n'),
        { info: { role: 'user', id: 'u_n1', sessionID: SID, time: { created: 10 } }, parts: [{ type: 'text', text: '排队的问题' }] },
      ],
    })
    st = useStore.getState()
    expect(st.streaming).toBe(true) // 快照被守卫丢弃
    expect(syntheticCards().length).toBe(1) // 卡应保留（被丢弃=不被整包替换）
    expect(st.messages.length).toBeGreaterThan(2) // 流式壳等本地状态未被动

    // 8. N+1 结束 → 300ms 后重拉
    pushEvent('turn.completed', {}, 'turn_n1')
    expect(useStore.getState().streaming).toBe(false)
    vi.advanceTimersByTime(300)
    expect(sentRequests.some((r) => r.op === 'messages')).toBe(true)

    // 9. 权威快照（marker 已落库）【观察点3】：真身接管，合成卡摘除
    pushResponse({
      op: 'messages',
      sessionId: SID,
      workspacePath: 'G:\\mock',
      messages: [
        assistantMsg('a_turn_n', 'turn_n'),
        { // 服务端真身 marker（切换在下一条 user 消息前）
          info: { role: 'assistant', id: 'mk_1', sessionID: SID, time: { created: 11 } },
          parts: [{ type: 'timeline', timelineType: 'model_change', fromModel: { modelId: GLM.modelId, providerID: GLM.providerId }, toModel: { modelId: FLASH.modelId, providerID: FLASH.providerId } }],
        },
        { info: { role: 'user', id: 'u_n1', sessionID: SID, time: { created: 12 } }, parts: [{ type: 'text', text: '排队的问题' }] },
        assistantMsg('a_turn_n1', 'turn_n1'),
      ],
    })
    st = useStore.getState()
    expect(syntheticCards().length).toBe(0) // 合成卡摘除
    expect(st.syntheticModelChanges[SID] ?? []).toEqual([])
    // 真身 marker 在（渲染显示面）
    const markerVisible = st.messages.some((m) =>
      (m.parts ?? []).some((p) => p.type === 'timeline' && p.timelineType === 'model_change'),
    )
    expect(markerVisible).toBe(true)
  })

  it('无排队消息：回合结束 modelSet 插卡 → 下一次 send 前后卡保持 → 真身接管', () => {
    // 初始无排队消息
    useStore.setState({ queuedMessages: [] })

    useStore.getState().setModel(FLASH.modelId, FLASH.providerId)
    pushResponse({ op: 'modelSetPending', sessionId: SID, ...FLASH })

    // 回合结束（无排队消息 → 不 flush）
    pushEvent('turn.completed', {}, 'turn_n')
    expect(useStore.getState().streaming).toBe(false)
    expect(sentRequests.filter((r) => r.op === 'send').length).toBe(0)

    // modelSet 到达 → 插卡
    pushResponse({ op: 'modelSet', sessionId: SID, ...FLASH })
    expect(syntheticCards().length).toBe(1)

    // 回合结束触发的 300ms 重拉（快照无 marker——marker 未落库）→ 接管补挂
    vi.advanceTimersByTime(300)
    expect(sentRequests.some((r) => r.op === 'messages')).toBe(true)
    pushResponse({
      op: 'messages',
      sessionId: SID,
      workspacePath: 'G:\\mock',
      messages: [assistantMsg('a_turn_n', 'turn_n')], // 快照无 marker
    })
    expect(syntheticCards().length).toBe(1) // 接管补挂，卡保持

    // 用户手动发消息 → send 落库 marker → 本回合结束重拉后真身接管
    useStore.getState().sendMessage('下一个问题')
    pushEvent('turn.started', { messageId: 'u_n2', input: '下一个问题' }, 'turn_n2')
    expect(useStore.getState().streaming).toBe(true)
    expect(syntheticCards().length).toBe(1)

    pushEvent('turn.completed', {}, 'turn_n2')
    vi.advanceTimersByTime(300)
    pushResponse({
      op: 'messages',
      sessionId: SID,
      workspacePath: 'G:\\mock',
      messages: [
        assistantMsg('a_turn_n', 'turn_n'),
        { // N+2 的 send 落库的 marker
          info: { role: 'assistant', id: 'mk_2', sessionID: SID, time: { created: 20 } },
          parts: [{ type: 'timeline', timelineType: 'model_change', fromModel: { modelId: GLM.modelId, providerID: GLM.providerId }, toModel: { modelId: FLASH.modelId, providerID: FLASH.providerId } }],
        },
        { info: { role: 'user', id: 'u_n2', sessionID: SID, time: { created: 21 } }, parts: [{ type: 'text', text: '下一个问题' }] },
        assistantMsg('a_turn_n2', 'turn_n2'),
      ],
    })
    expect(syntheticCards().length).toBe(0)
    const markerVisible = useStore.getState().messages.some((m) =>
      (m.parts ?? []).some((p) => p.type === 'timeline' && p.timelineType === 'model_change'),
    )
    expect(markerVisible).toBe(true)
  })
})
