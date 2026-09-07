/**
 * steer 引导失败回滚回归测试（code-review 定案：乐观移除发生在受理之前，
 * ack 失败必须把队列条目插回原位，防文本丢失）
 *
 * 断言链路：
 *   1. sendQueuedAsSteer 受理成功 → 卡片移除 + steerPending.restore 记录来源（item+原下标）
 *   2. ack accepted:false（服务端拒收）→ 条目插回原位 + chip 清除 + 横幅
 *   3. ack error（Java 侧异常）→ 同样回滚
 *   4. chip 已被落位清除后迟到的失败 ack → 不回滚（防与注入气泡重复）
 *   5. 守卫拦截（非流式）→ 条目从未移除
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore, handleResponse } from '@/store/useStore'

const SID = 'sess_steer_1'

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
    queuedMessages: [queuedItem('q1', '第一条'), queuedItem('q2', '引导我'), queuedItem('q3', '第三条')],
  })
}

describe('引导失败回滚队列条目', () => {
  beforeEach(() => {
    sentRequests.length = 0
    resetWithQueue()
  })

  it('受理成功：卡片移除 + steerPending.restore 记录 item 与原下标', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q3'])
    const sp = useStore.getState().steerPending
    expect(sp?.text).toBe('引导我')
    expect(sp?.restore?.index).toBe(1)
    expect(sp?.restore?.item.id).toBe('q2')
    expect(sentRequests.map((r) => r.op)).toContain('steerMessage')
  })

  it('ack accepted:false：条目插回原位 + chip 清除 + 横幅', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    handleResponse({ op: 'steerMessage', sessionId: SID, accepted: false }, useStore.setState, useStore.getState)
    const q = useStore.getState().queuedMessages
    expect(q.map((m) => m.id)).toEqual(['q1', 'q2', 'q3'])
    expect(q[1].text).toBe('引导我')
    expect(useStore.getState().steerPending).toBeNull()
    expect(useStore.getState().lastError).toBeTruthy()
  })

  it('ack error（Java 异常形态）：同样回滚', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    handleResponse({ op: 'steerMessage', sessionId: SID, error: 'v4 unavailable' }, useStore.setState, useStore.getState)
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q2', 'q3'])
    expect(useStore.getState().lastError).toContain('v4 unavailable')
    expect(useStore.getState().steerPending).toBeNull()
  })

  it('chip 已被落位清除后迟到的失败 ack：不回滚（防与注入气泡重复）', () => {
    useStore.getState().sendQueuedAsSteer('q2')
    useStore.setState({ steerPending: null }) // steerDrained 已落位
    handleResponse({ op: 'steerMessage', sessionId: SID, accepted: false }, useStore.setState, useStore.getState)
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q1', 'q3'])
  })

  it('守卫拦截（非流式）：条目从未移除，不发生乐观置位', () => {
    useStore.setState({ streaming: false, queuedMessages: [queuedItem('q2', '引导我')] })
    useStore.getState().sendQueuedAsSteer('q2')
    expect(useStore.getState().queuedMessages.map((m) => m.id)).toEqual(['q2'])
    expect(useStore.getState().steerPending).toBeNull()
    expect(sentRequests).toHaveLength(0)
  })
})
