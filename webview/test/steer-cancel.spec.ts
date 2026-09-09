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
