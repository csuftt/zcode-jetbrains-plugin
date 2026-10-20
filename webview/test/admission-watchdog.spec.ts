/**
 * 发送落位看门狗（缺陷FF）回归测试
 *
 * 复现场景（2026-10-19 真机实测，PyCharm/ZC GUI 0.4.0）：
 *   轮末 flush 的排队消息 send 写入 stdin、服务端已开始构建模型请求后 app-server
 *   整体僵死——ack 可能正常，但 turn.started 永不到达、无任何错误、session_input
 *   无落账，消息无痕丢失，UI 恒转圈直到重启 IDE。
 *
 * 看门狗链路（对应实现 armAdmission / hookAdmissionStreamEvent /
 * claimAdmissionsFromMessages / failAdmission / case 'error' sendSourced 快路）：
 *   1. sendMessage 乐观气泡后登记凭据（hiddenCommand 不登记）
 *   2. turn.started / turn.userInput / turn.steerQueued 同文本 → 认领撤哨
 *      （steerQueued 命中即 FD 防御接管，促发 op 必须在场）
 *   3. 同会话任何流事件 → 活性续期（防长插队轮误报）
 *   4. 30s 无落位 → 发普通 messages 探测：
 *      转录有同文本（时间窗内）→ 静默认领；无 → 撤气泡+退回队头+横幅；
 *      20s 探测无应答 → 同退回 + 「app-server 无响应」指引横幅
 *   5. error sourceOp=send → 秒级退回队列 + 跳过 flushQueue 续灌
 *   6. 切会话后收尾 → 静默丢弃（不往新会话队列插旧会话消息）
 *   7. 历史同文（时间窗外）不得误认领
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null
let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore, handleResponse, resetAdmissionWatchdog } from '@/store/useStore'
import i18n from '@/i18n/config'
import type { ZCodeMessage } from '@/types/messages'

const SID = 'sess_ff_1'
const TEXT = '会话记录那四个字切换后，往下移了几px'

function pushBatchEvent(type: string, payload: Record<string, unknown>): void {
  streamBatchHandler!(SID, [{ type, seq: 1, sessionId: SID, turnId: 'turn_ff', timestamp: Date.now(), payload }])
}

/** 服务端真身 user 消息（非 local 气泡） */
function serverUserMessage(text: string, created: number, id = 'srv_u_1'): ZCodeMessage {
  return {
    info: { role: 'user', id, sessionID: SID, time: { created } },
    parts: [{ type: 'text', text }],
  }
}

function resetStore(): void {
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [],
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    lastNotice: null,
    lastError: null,
    editReplay: null,
    sessions: [],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
}

/** 模拟一次真实发送（乐观气泡 + 落位凭据登记），返回后清空请求账本 */
function realSend(text = TEXT): void {
  useStore.getState().sendMessage(text)
  sentRequests.length = 0
}

function queuedTexts(): string[] {
  return useStore.getState().queuedMessages.map((m) => m.text)
}

function probeRequests(): Array<Record<string, unknown>> {
  return sentRequests.filter((r) => r.op === 'messages')
}

describe('发送落位看门狗（缺陷FF）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetAdmissionWatchdog()
    sentRequests.length = 0
    resetStore()
    void useStore.getState().init()
    sentRequests.length = 0
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('turn.started 携带同文本即认领，不再探测退回', () => {
    realSend()
    pushBatchEvent('turn.started', { input: TEXT, messageId: 'srv_u_1' })
    // 全窗口推进（30s 截止 + 20s 探测超时 + tick 步长）：若凭据未认领，此时早已
    // 失败退回——不看探测计数（turn.started 同时触发缺陷CI 的通知卡转录拉取，
    // 与看门狗探测同形，无法区分）
    vi.advanceTimersByTime(120_000)
    expect(queuedTexts()).toEqual([])
    expect(useStore.getState().lastNotice).toBeNull()
  })

  it('turn.steerQueued 同文本命中即撤哨，FD 促发接管', () => {
    realSend()
    pushBatchEvent('turn.steerQueued', {
      input: TEXT,
      delivery: 'queue',
      pendingInputId: 'queue_ff_probe_1',
      queueLength: 1,
    })
    // FD 防御接管：促发 op 必须在场
    expect(sentRequests.some((r) => r.op === 'promoteQueuedInput')).toBe(true)
    vi.advanceTimersByTime(70_000)
    expect(queuedTexts()).toEqual([])
    expect(probeRequests()).toEqual([])
  })

  it('到期探测：转录已落位（时间窗内）→ 静默认领', () => {
    realSend()
    vi.advanceTimersByTime(35_000)
    expect(probeRequests().length).toBe(1)
    handleResponse(
      { op: 'messages', sessionId: SID, messages: [serverUserMessage(TEXT, Date.now() - 1_000)] },
      useStore.setState, useStore.getState,
    )
    expect(queuedTexts()).toEqual([])
    expect(useStore.getState().lastNotice).toBeNull()
  })

  it('到期探测：转录无此文本 → 撤气泡+退回队头+横幅', () => {
    realSend()
    // 乐观气泡在场（模拟未被轮末快照抹掉）
    expect(useStore.getState().messages.some((m) => String(m.info.id).startsWith('local_u_'))).toBe(true)
    vi.advanceTimersByTime(35_000)
    handleResponse(
      { op: 'messages', sessionId: SID, messages: [serverUserMessage('历史同文但时间窗外', Date.now() - 120_000, 'srv_old')] },
      useStore.setState, useStore.getState,
    )
    expect(queuedTexts()).toEqual([TEXT])
    expect(useStore.getState().messages.some((m) => userText(m) === TEXT)).toBe(false)
    expect(useStore.getState().lastNotice).toBe(i18n.t('input.queue.admissionTimeoutRequeued'))
  })

  it('历史同文不得误认领：时间窗外的同文本不算落位', () => {
    realSend()
    vi.advanceTimersByTime(35_000)
    handleResponse(
      {
        op: 'messages',
        sessionId: SID,
        // 同文本但创建时刻早于发出（重复发「继续」场景）
        messages: [serverUserMessage(TEXT, Date.now() - 120_000, 'srv_old')],
      },
      useStore.setState, useStore.getState,
    )
    expect(queuedTexts()).toEqual([TEXT])
  })

  it('探测 20s 无应答 → 退回队头 + app-server 无响应指引', () => {
    realSend()
    vi.advanceTimersByTime(35_000) // 30s 截止 → 探测发出
    expect(probeRequests().length).toBe(1)
    vi.advanceTimersByTime(25_000) // 探测超时（不回 messages 应答）
    expect(queuedTexts()).toEqual([TEXT])
    expect(useStore.getState().lastNotice).toBe(i18n.t('input.queue.admissionServerUnresponsive'))
  })

  it('error sourceOp=send → 秒级退回队列，且不续灌队列下一条', () => {
    // 预置一条更早的排队消息：error 后 flushQueue 被跳过，它不得被发出
    useStore.setState({
      queuedMessages: [{
        id: 'queue_pre_1', text: '下一条排队消息', queuedAt: Date.now(),
      }],
    })
    realSend()
    handleResponse(
      { op: 'error', sourceOp: 'send', sessionId: SID, message: '发送失败: 请求超时: session/send (10000ms)' },
      useStore.setState, useStore.getState,
    )
    expect(queuedTexts()).toEqual([TEXT, '下一条排队消息'])
    expect(useStore.getState().messages.some((m) => userText(m) === TEXT)).toBe(false)
    expect(useStore.getState().lastNotice).toContain(i18n.t('input.queue.sendFailedRequeued'))
    // 不续灌：没有任何新的 send 发出（sentRequests 在 realSend 后已清空）
    expect(sentRequests.some((r) => r.op === 'send')).toBe(false)
  })

  it('切会话后收尾 → 静默丢弃，不往新会话队列插旧会话消息', () => {
    realSend()
    useStore.setState({ currentSessionId: 'sess_ff_other' })
    vi.advanceTimersByTime(35_000)
    expect(probeRequests().length).toBe(1) // 探测照发（凭据 sid 在）
    vi.advanceTimersByTime(25_000)
    expect(queuedTexts()).toEqual([])
    expect(useStore.getState().lastNotice).toBeNull()
  })

  it('活性续期：同会话事件顺延截止，不误报', () => {
    realSend()
    vi.advanceTimersByTime(25_000) // 未到 30s 截止
    pushBatchEvent('model.streaming', { kind: 'text_delta', delta: 'x' }) // 活性续期 +30s
    vi.advanceTimersByTime(20_000) // 45s：无续期时本应已探测，续期后截止=55s
    expect(probeRequests()).toEqual([])
    vi.advanceTimersByTime(15_000) // 60s：过 55s 截止 → 探测才发出
    expect(probeRequests().length).toBe(1)
    expect(queuedTexts()).toEqual([])
  })
})

function userText(m: ZCodeMessage): string {
  return (m.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('')
}
