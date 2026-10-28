/**
 * 压缩指示器滞后读数复活缺陷回归测试（2026-08-24 缺陷，idea.log 21:41 窗口实测）
 *
 * 缺陷链（复现证据）：
 *   1. /compact 回合 turn.completed（seq=820）到达 → 前端清 compacting 并发出重拉批
 *   2. 重拉批的 getUsage 在 ~300ms 后返回，服务端 runtime 清算滞后（读到 eventSeq=816
 *      < 820，activeTurnId/activeTurnKind 仍报「已完成那轮」）→ 旧逻辑把 compacting
 *      复活成 true
 *   3. 后续 usage 响应字段缺失（回合真结束）→ 旧逻辑"缺失不动作" → compacting 永久
 *      卡 true（指示器不消失）
 *   4. 连锁毒化：用户新发消息，turn.started 命中压缩守卫被吞 → 不建流式消息 →
 *      delta 无处落地 → 一直转圈，重开会话（快照重拉）才见回复
 *
 * 修复：
 *   - usage 带 activeTurnId：与客户端最近完成的 turnId 相同 = 滞后读数，不复活
 *   - 「确认过后的缺失」自愈清除（未确认过 = 旧 CLI 不上报字段，维持不动作）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { useStore, stopSubagentStatusPolling } from '@/store/useStore'

const SID = 'sess_stale_1'

function pushTurnEvent(type: string, turnId: string): void {
  streamEventHandler!(SID, {
    type, seq: 100, sessionId: SID, turnId, timestamp: Date.now(), payload: {},
  })
}

function pushUsage(activeTurnKind?: string, activeTurnId?: string): void {
  messageHandler!({ op: 'usage', sessionId: SID, used: 1, size: 2, ...(activeTurnKind !== undefined ? { activeTurnKind } : {}), ...(activeTurnId !== undefined ? { activeTurnId } : {}) })
}

beforeEach(() => {
  vi.useFakeTimers()
  stopSubagentStatusPolling()
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
    compacting: false,
    queuedMessages: [],
    subagentActivities: [],
    subagents: [],
    childSessionKeys: {},
    sessions: [{ sessionId: SID, title: 'stale-test', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('滞后读数不复活压缩指示器（核心缺陷）', () => {
  it('turn.completed 后到达的同 turnId compact 读数被识别为滞后，不复活', () => {
    // 压缩回合运行中
    useStore.setState({ compacting: true, streaming: true, streamingMessageId: null })
    // 压缩回合完成（携带 turnId）
    pushTurnEvent('turn.completed', 'turn_done_1')
    expect(useStore.getState().compacting).toBe(false)
    expect(useStore.getState().streaming).toBe(false)

    // 重拉批的 getUsage 返回滞后读数：activeTurnId 仍是已完成那轮
    pushUsage('compact', 'turn_done_1')
    expect(useStore.getState().compacting).toBe(false)

    // 服务端清算完成后的正常读数（字段缺失）：维持 false
    pushUsage()
    expect(useStore.getState().compacting).toBe(false)
  })

  it('滞后读数卡死态的连锁毒化解除：下一回合 turn.started 正常建流式消息', () => {
    // 旧缺陷态：compacting 卡 true（若复活防护失效）
    useStore.setState({ compacting: true, streaming: true, streamingMessageId: null, messages: [] })
    pushTurnEvent('turn.completed', 'turn_x')
    pushUsage('compact', 'turn_x') // 滞后读数被拦 → compacting 已是 false
    expect(useStore.getState().compacting).toBe(false)

    // 用户新消息的回合正常创建流式 assistant 消息（不被压缩守卫吞掉）
    pushTurnEvent('turn.started', 'turn_next')
    const st = useStore.getState()
    expect(st.streaming).toBe(true)
    expect(st.messages).toHaveLength(1)
    expect(st.streamingMessageId).toBe('stream_turn_next')
  })
})

describe('真实压缩回合不受影响', () => {
  it('新 turnId 的 compact 读数（autocompact 紧接上回合结束）正常置位', () => {
    // 上一普通回合结束
    pushTurnEvent('turn.completed', 'turn_prev')
    // 服务端已开启新的压缩回合（新 turnId）→ 读数有效
    pushUsage('compact', 'turn_compact_new')
    expect(useStore.getState().compacting).toBe(true)

    // 无 activeTurnId 的读数（旧 Java/字段缺失兼容）：无法判滞后，按原逻辑置位
    pushUsage('compact')
    expect(useStore.getState().compacting).toBe(true)

    // kind 切回普通 → 清除
    pushUsage('chat', 'turn_chat')
    expect(useStore.getState().compacting).toBe(false)
  })

  it('send /compact 手动路径：即时置位，首个缺失样本不清（未确认不动作）', () => {
    useStore.getState().sendMessage('/compact')
    expect(useStore.getState().compacting).toBe(true)
    // 旧版 zcode.cjs 不上报字段：send 置位后到达的缺失读数不误清
    pushUsage()
    expect(useStore.getState().compacting).toBe(true)
  })
})

describe('确认过后的缺失自愈（turn.completed 丢失盲区）', () => {
  it('真 compact 读数确认过 → 缺失读数清除卡死的 compacting', () => {
    // autocompact：轮询发现真实压缩回合（新 turnId，确认）
    pushUsage('compact', 'turn_real')
    expect(useStore.getState().compacting).toBe(true)
    // 压缩实际结束但 turn.completed 丢失：服务端字段消失 → 自愈清除
    pushUsage()
    expect(useStore.getState().compacting).toBe(false)
  })

  it('滞后读数不算确认：拦下后紧接着的缺失不会反向清掉手动压缩', () => {
    useStore.setState({ compacting: true, streaming: true })
    pushTurnEvent('turn.completed', 'turn_c')
    // 滞后读数（被拦，未确认）
    pushUsage('compact', 'turn_c')
    expect(useStore.getState().compacting).toBe(false)
    // 缺失：无确认 → 不动作（compacting 本就 false，断言不被误翻转即可）
    pushUsage()
    expect(useStore.getState().compacting).toBe(false)
  })
})
