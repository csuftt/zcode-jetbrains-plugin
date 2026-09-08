/**
 * 带图排队消息引导 + 引导撤回回归测试（2026-09-08 三缺陷修复）：
 * 带图条目此前无引导入口（v4 附件形状未验证），编辑回填丢图，引导中无法撤回。
 *
 * 协议定案（zcode.cjs 源码核验）：
 *   - v4 sendText 原生支持 attachments（ref 形态），guide+附件服务端必降级为
 *     queue（runtime.steerTurn 只收纯文本），降级条目不自动排空（促发是客户端职责）
 *   - queueItemId = queue_<commandId>（f1()/Cse() 确定性派生），撤销走 v4
 *     deleteQueueItem、促发走 v4 sendQueuedNow
 *
 * 断言链路：
 *   1. 带图条目受理：op 带 commandId+attachments；steerPending 预置
 *      queueItemId（queue_<commandId>）+ attachments + restore
 *   2. cancelSteer 应答 removed=true → chip 清除 + 条目按 restore 插回原位
 *   3. cancelSteer 应答 removed=false（已落位）→ chip 保留退出 cancelling + 横幅
 *   4. 带图引导回合结束（批量通道 turn.completed）→ 发出 promoteQueuedInput，
 *      chip 保留等认领（对比：纯文本引导同路径清 chip + 未落位横幅）
 *   5. 促发后新回合 turn.started input 认领 → chip 清除 + 气泡落位进徽标账本
 *   6. 促发应答 ok=false（条目已不在）→ chip 清除兜底
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

const SID = 'sess_steer_img_1'

const IMG = {
  kind: 'image' as const,
  filename: 'pasted-image-1.png',
  mimeType: 'image/png',
  sizeBytes: 1024,
  dataBase64: 'aVZCT1J3MEtHZ29EPS0=',
}

function queuedItem(id: string, text: string, attachments?: typeof IMG) {
  return { id, text, queuedAt: 0, ...(attachments ? { attachments: [attachments] } : {}) }
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
      queuedItem('q2', '看这张图', IMG),
      queuedItem('q3', '第三条'),
    ],
  })
}

describe('带图排队消息引导（降级促发语义）', () => {
  beforeEach(() => {
    sentRequests.length = 0
    resetWithQueue()
    void useStore.getState().init() // 注册 onStreamBatch/onMessage 处理链
  })

  it('受理成功：op 带 commandId+attachments，steerPending 预置 queueItemId 与附件', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    const req = sentRequests.find((r) => r.op === 'steerMessage') as Record<string, unknown> | undefined
    expect(req).toBeTruthy()
    const commandId = req!.commandId as string
    expect(commandId).toMatch(/^steer-/)
    expect(req!.attachments).toEqual([IMG])
    const sp = useStore.getState().steerPending
    expect(sp?.queueItemId).toBe(`queue_${commandId}`)
    expect(sp?.attachments).toEqual([IMG])
    expect(sp?.restore?.item.id).toBe('q2')
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q3'])
  })

  it('回合结束促发：带图引导发 promoteQueuedInput 且 chip 保留；纯文本引导清 chip + 未落位横幅', () => {
    // 带图引导在途
    useStore.getState().sendQueuedAsSteer('q2')
    const pending = useStore.getState().steerPending
    streamBatchHandler!(SID, [{ type: 'turn.completed', seq: 1, sessionId: SID, timestamp: Date.now(), turnId: 'turn_1', payload: {} }])
    const promote = sentRequests.find((r) => r.op === 'promoteQueuedInput')
    expect(promote).toBeTruthy()
    expect(promote!.queueItemId).toBe(pending?.queueItemId)
    expect(useStore.getState().steerPending?.queueItemId).toBe(pending?.queueItemId) // chip 保留等认领

    // 对照组：纯文本引导在途 → 回合结束清 chip + 未落位横幅（原行为不回归）。
    // 队列清空隔离 flushQueue→sendMessage 的 lastError 清除（既有交互顺序：
    // 未落位横幅会被紧随的队列冲刷覆盖，与本次改动无关）
    sentRequests.length = 0
    useStore.setState({
      streaming: true,
      steerPending: { text: '纯文本引导', at: Date.now(), queueItemId: 'queue_steer-txt' },
      queuedMessages: [],
    })
    streamBatchHandler!(SID, [{ type: 'turn.completed', seq: 2, sessionId: SID, timestamp: Date.now(), turnId: 'turn_2', payload: {} }])
    expect(sentRequests.some((r) => r.op === 'promoteQueuedInput')).toBe(false)
    expect(useStore.getState().steerPending).toBeNull()
    expect(useStore.getState().lastError).toContain('未生效')
  })

  it('促发后新回合 turn.started input 认领：chip 清除 + 气泡落位进徽标账本', () => {
    useStore.setState({
      streaming: true,
      steerPending: { text: '看这张图', at: 1000, queueItemId: 'queue_steer-x', attachments: [IMG] },
    })
    streamBatchHandler!(SID, [
      { type: 'turn.started', seq: 10, sessionId: SID, timestamp: Date.now(), turnId: 'turn_9', payload: { turnNumber: 2, input: '看这张图', messageId: 'msg_srv_img1' } },
    ])
    const st = useStore.getState()
    expect(st.steerPending).toBeNull()
    expect(st.steeredMessageIds).toContain('msg_srv_img1')
    expect(st.messages.some((m) => m.info.id === 'msg_srv_img1')).toBe(true)
  })

  it('促发应答 ok=false（条目已不在）：chip 清除兜底', () => {
    useStore.setState({
      steerPending: { text: '看这张图', at: 1000, queueItemId: 'queue_steer-x', attachments: [IMG] },
    })
    handleResponse({ op: 'promoteQueuedInput', sessionId: SID, queueItemId: 'queue_steer-x', ok: false }, useStore.setState, useStore.getState)
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

  it('撤回成功：清 chip + 条目按 restore 插回原位', () => {
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
    expect(useStore.getState().queuedMessages[1].attachments).toEqual([IMG]) // 附件完整保留
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
