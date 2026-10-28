/**
 * 引导受理/回合末兜底/引导撤回回归测试（0.3.4 带图引导砍除后口径）：
 * - steer 仅纯文本：带附件条目 UI 无引导入口（0.3.4 定案——guide+附件服务端必降级
 *   queue 且降级条目不自动排空，促发链路实测不可靠，已整体移除）
 * - 引导 chip ✕ 撤回走 v4 deleteQueueItem（queueItemId=queue_<commandId>）
 *
 * 断言链路：
 *   1. 受理：op 带 commandId（无 attachments 字段），steerPending 预置
 *      queueItemId（queue_<commandId>）+ restore
 *   2. 回合结束 chip 仍在（纯文本引导未落位）→ 清 chip + 未落位横幅；
 *      不发 promoteQueuedInput（带图促发链路砍除回归点）
 *   3. cancelSteer 应答 removed=true → 清 chip + 条目按 restore 插回原位
 *   4. cancelSteer 应答 removed=false（已落位）→ chip 保留退出 cancelling + 横幅
 *   5. cancelling 在途重复点 ✕ 不重发 op；回合末不促发不清 chip
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null
let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore, handleResponse } from '@/store/useStore'

const SID = 'sess_steer_cancel_1'

function queuedItem(id: string, text: string) {
  return { id, text, queuedAt: 0 }
}

function resetWithQueue(): void {
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    streaming: true,
    streamingMessageId: 'stream_x',
    steerPending: null,
    lastError: null,
    messages: [],
    queuedMessages: [
      queuedItem('q1', '纯文本一条'),
      queuedItem('q2', '引导我'),
      queuedItem('q3', '第三条'),
    ],
  })
}

describe('引导受理与回合末兜底（纯文本口径）', () => {
  beforeEach(() => {
    sentRequests.length = 0
    resetWithQueue()
    void useStore.getState().init() // 注册 onStreamBatch/onMessage 处理链
  })

  it('受理成功：op 带 commandId 无 attachments，steerPending 预置 queueItemId 与 restore', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    const req = sentRequests.find((r) => r.op === 'steerMessage') as Record<string, unknown> | undefined
    expect(req).toBeTruthy()
    const commandId = req!.commandId as string
    expect(commandId).toMatch(/^steer-/)
    expect('attachments' in req!).toBe(false) // 带图引导砍除：受理不再携带附件
    const sp = useStore.getState().steerPending
    expect(sp?.queueItemId).toBe(`queue_${commandId}`)
    expect(sp?.restore?.item.id).toBe('q2')
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q3'])
  })

  it('回合结束 chip 仍在：清 chip + 未落位横幅，不发 promoteQueuedInput（促发链路砍除回归点）', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    // 清空其余排队项：隔离回合末 flushQueue 的自动发送（q1 会被正常发走，干扰断言）
    useStore.setState({ queuedMessages: [] })
    streamBatchHandler!(SID, [{ type: 'turn.completed', seq: 1, sessionId: SID, timestamp: Date.now(), turnId: 'turn_1', payload: {} }])
    expect(sentRequests.some((r) => r.op === 'promoteQueuedInput')).toBe(false)
    expect(useStore.getState().steerPending).toBeNull()
    expect(useStore.getState().lastError).toContain('未生效')
  })
})

describe('引导撤回（chip ✕ → v4 deleteQueueItem）', () => {
  beforeEach(() => {
    sentRequests.length = 0
    resetWithQueue()
    void useStore.getState().init()
  })

  it('撤回成功：清 chip + 条目按 restore 插回原位（附件完整保留）', () => {
    useStore.getState().sendQueuedAsSteer('q2') // 队列变 [q1,q3]，原下标 1
    const qid = useStore.getState().steerPending?.queueItemId
    expect(qid).toMatch(/^queue_steer-/)
    useStore.getState().cancelSteer()
    // cancelling 态 + 发出 op
    expect(useStore.getState().steerPending?.cancelling).toBe(true)
    const cancel = sentRequests.find((r) => r.op === 'cancelSteer')
    expect(cancel?.queueItemId).toBe(qid)
    handleResponse({ op: 'cancelSteer', sessionId: SID, queueItemId: qid!, removed: true }, useStore.setState, useStore.getState)
    expect(useStore.getState().steerPending).toBeNull()
    // 回插原位：[q1, 引导我→q2, q3]…… q2 原下标 1
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q2', 'q3'])
  })

  it('撤回太迟（已注入落位 removed=false）：chip 保留退出 cancelling + 横幅提示', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    useStore.getState().cancelSteer()
    handleResponse({ op: 'cancelSteer', sessionId: SID, queueItemId: 'queue_steer-1', removed: false }, useStore.setState, useStore.getState)
    const sp = useStore.getState().steerPending
    expect(sp).not.toBeNull()
    expect(sp?.cancelling).toBe(false)
    expect(useStore.getState().lastError).toContain('无法撤回')
    // 队列不回插（防与注入气泡并存）
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q3'])
  })

  it('cancelling 在途时重复点 ✕ 不重发 op', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    useStore.getState().cancelSteer()
    sentRequests.length = 0
    useStore.getState().cancelSteer()
    expect(sentRequests.filter((r) => r.op === 'cancelSteer')).toHaveLength(0)
  })

  it('cancelling 在途时回合结束：不促发不清 chip（回插要等撤回应答，先清会两头落空）', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    useStore.getState().cancelSteer()
    sentRequests.length = 0
    // 清空其余排队项：隔离回合末 flushQueue 的自动发送（q1 会被正常发走，干扰回插断言）
    useStore.setState({ queuedMessages: [] })
    streamBatchHandler!(SID, [{ type: 'turn.completed', seq: 3, sessionId: SID, timestamp: Date.now(), turnId: 'turn_3', payload: {} }])
    expect(sentRequests.some((r) => r.op === 'promoteQueuedInput')).toBe(false)
    const sp = useStore.getState().steerPending
    expect(sp?.cancelling).toBe(true) // chip 原样保留，撤回应答负责收尾
    expect(useStore.getState().lastError).toBeNull()
    // 撤回成功应答到达：按 restore 回插（越界钳到队尾）
    handleResponse({ op: 'cancelSteer', sessionId: SID, queueItemId: 'queue_steer-x', removed: true }, useStore.setState, useStore.getState)
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q2'])
  })
})

// 消化 unused 变量（与 steer-rollback.spec 同款 mock 形态，handler 供扩展用）
void messageHandler

// ============ 撤销竞态守卫（缺陷BQ，2026-09-15 用户实测）============
// 服务端 drainPendingInput 取出待注入条目时只查 reservation 不设置——取出后到
// steerDrained 发出的窗口内 deleteQueueItem 走 discardHeldPendingInputById 照样
// 返回 removed=true，「撤销成功」与「注入发生」并存 → removed=true 回插队列 +
// 注入照常落位 → 回合结束 flushQueue 把回插条目再发一遍 = 同一条消息发两条。
// 守卫：removed=true 回插时留观察记录，steerDrained 命中同文本即撤下回插条目。
describe('撤销竞态守卫（缺陷BQ：removed=true 回插后 steerDrained 迟到）', () => {
  beforeEach(() => {
    sentRequests.length = 0
    resetWithQueue()
    void useStore.getState().init()
  })

  it('批量路径：撤回成功回插后 steerDrained 命中同文本 → 回插条目撤下 + 气泡落位', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    const qid = useStore.getState().steerPending?.queueItemId
    handleResponse({ op: 'cancelSteer', sessionId: SID, queueItemId: qid!, removed: true }, useStore.setState, useStore.getState)
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q2', 'q3']) // 已回插
    expect(useStore.getState().steerCancelRestore?.itemId).toBe('q2') // 观察记录在
    streamBatchHandler!(SID, [{
      type: 'turn.steerDrained', seq: 1, sessionId: SID, timestamp: Date.now(),
      payload: { pendingInputIds: [qid], injectedMessageIds: ['msg_u2'], drainedInputs: [{ pendingInputId: qid, messageId: 'msg_u2', text: '引导我' }] },
    }])
    // 注入实际发生：回插条目撤下（防回合结束 flush 重复发送）+ 观察记录清
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q3'])
    expect(useStore.getState().steerCancelRestore).toBeNull()
    // 横幅如实告知取消未生效（消息已注入，防误以为撤销成功）；走 notice
    // 中性通道（琥珀 info 条）不走红色 error 条——这是告知不是错误
    expect(useStore.getState().lastNotice).toContain('无法撤回')
    // 气泡照常落位（撤销竞态不影响注入渲染）
    const bubble = useStore.getState().messages.find((m) => m.info.id === 'msg_u2')
    expect(bubble?.parts[0]).toMatchObject({ type: 'text', text: '引导我' })
  })

  it('单推路径：撤回成功回插后 steerDrained 迟到 → 同样撤下回插条目', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    const qid = useStore.getState().steerPending?.queueItemId
    handleResponse({ op: 'cancelSteer', sessionId: SID, queueItemId: qid!, removed: true }, useStore.setState, useStore.getState)
    expect(useStore.getState().steerCancelRestore?.itemId).toBe('q2')
    streamEventHandler!(SID, {
      type: 'turn.steerDrained', seq: 2, sessionId: SID, timestamp: Date.now(),
      payload: { pendingInputIds: [qid], injectedMessageIds: ['msg_u3'], drainedInputs: [{ pendingInputId: qid, messageId: 'msg_u3', text: '引导我' }] },
    })
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q3'])
    expect(useStore.getState().steerCancelRestore).toBeNull()
    expect(useStore.getState().lastNotice).toContain('无法撤回')
    expect(useStore.getState().messages.some((m) => m.info.id === 'msg_u3')).toBe(true)
  })

  it('撤回真成功：回合结束仍无 steerDrained → 条目保留 + 观察记录收口作废', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    const qid = useStore.getState().steerPending?.queueItemId
    handleResponse({ op: 'cancelSteer', sessionId: SID, queueItemId: qid!, removed: true }, useStore.setState, useStore.getState)
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q2', 'q3'])
    // 清空其余排队项：隔离其余条目干扰（q1/q3 会先被 flush 发走）
    useStore.setState({ queuedMessages: [queuedItem('q2', '引导我')] })
    streamBatchHandler!(SID, [{ type: 'turn.completed', seq: 3, sessionId: SID, timestamp: Date.now(), turnId: 'turn_9', payload: {} }])
    // 撤销真成功：条目按排队语义在回合结束时 flush 发出（撤回引导=回到正常排队），
    // 观察记录作废
    expect(useStore.getState().queuedMessages).toEqual([])
    expect(useStore.getState().steerCancelRestore).toBeNull()
    const sent = sentRequests.find((r) => r.op === 'send') as Record<string, unknown> | undefined
    expect((sent?.text as string | undefined)?.trim()).toBe('引导我')
  })

  it('新引导置位清观察记录（防同文本新引导落位被误撤）', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    const qid = useStore.getState().steerPending?.queueItemId
    handleResponse({ op: 'cancelSteer', sessionId: SID, queueItemId: qid!, removed: true }, useStore.setState, useStore.getState)
    expect(useStore.getState().steerCancelRestore).not.toBeNull()
    // 再次引导（同文本条目已回插，重新出队）
    useStore.getState().sendQueuedAsSteer('q2')
    expect(useStore.getState().steerCancelRestore).toBeNull() // 旧观察记录作废
  })
})
