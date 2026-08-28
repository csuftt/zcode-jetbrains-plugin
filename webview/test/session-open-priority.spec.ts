/**
 * 打开会话的请求优先级编排回归测试（缺陷AB 优先级编排①②，2026-08-27）
 *
 * 现状问题（用户日志实测）：selectSession 并发发出 6 个请求全排进 app-server 的
 * 同一会话队列（subscribe 与 messages 还各自 resume 一次，坏会话 8.7s/次），
 * 忙窗口期间全体超时——P2 辅助数据（用量/子代理）失败还走 errorResponse 弹顶栏
 * 错误并复位 streaming，把故障感知放大三倍。
 *
 * 断言：
 *   1. selectSession 不再直发 getUsage/subagents（P2 让路）
 *   2. messages 首拉落地（P0 完成）后补发 getUsage/subagents
 *   3. 非首拉的重拉响应（loadingMessages=false）不重复补发
 *   4. usageError 静默：不写 lastError、不复位 streaming
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

import { useStore } from '@/store/useStore'

const SID = 'sess_prio_1'

beforeEach(() => {
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: null,
    currentWorkspacePath: 'G:\\mock',
    loadingMessages: false,
    streaming: false,
    lastError: null,
  })
})

function opsOf(op: string): Array<Record<string, unknown>> {
  return sentRequests.filter((r) => r.op === op)
}

describe('打开会话请求优先级编排（缺陷AB）', () => {
  it('selectSession 只直发 P0/P1（subscribe/messages/getSettings/setModel），不直发 P2', () => {
    useStore.getState().selectSession({
      sessionId: SID, title: 't', status: 'idle', mode: 'yolo',
      workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 1,
    })
    expect(opsOf('subscribe')).toHaveLength(1)
    expect(opsOf('messages')).toHaveLength(1)
    expect(opsOf('getSettings')).toHaveLength(1)
    expect(opsOf('getUsage')).toHaveLength(0)
    expect(opsOf('subagents')).toHaveLength(0)
  })

  it('messages 首拉落地后补发 P2（getUsage/subagents）', () => {
    useStore.getState().selectSession({
      sessionId: SID, title: 't', status: 'idle', mode: 'yolo',
      workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 1,
    })
    expect(useStore.getState().loadingMessages).toBe(true) // 首拉标志就位
    messageHandler!({ op: 'messages', sessionId: SID, messages: [] })
    expect(opsOf('getUsage')).toHaveLength(1)
    expect(opsOf('subagents')).toHaveLength(1)
  })

  it('非首拉的重拉响应不重复补发 P2', () => {
    useStore.setState({ currentSessionId: SID, loadingMessages: false }) // 非首拉（如回合结束重拉）
    messageHandler!({ op: 'messages', sessionId: SID, messages: [] })
    expect(opsOf('getUsage')).toHaveLength(0)
    expect(opsOf('subagents')).toHaveLength(0)
  })

  it('usageError 静默：不写 lastError、不复位 streaming', () => {
    useStore.setState({ currentSessionId: SID, streaming: true, lastError: null })
    messageHandler!({ op: 'usageError', sessionId: SID, message: '请求超时: session/read (10000ms)' })
    expect(useStore.getState().lastError).toBeNull()
    expect(useStore.getState().streaming).toBe(true)
  })
})
