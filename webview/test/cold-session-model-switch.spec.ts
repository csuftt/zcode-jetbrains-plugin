/**
 * 模型切换撞冷会话（-32004）的文案区分回归测试（2026-09-07 启动假警报定性）
 *
 * 场景：启动恢复上次会话时 applyModelIfReady 的 setModel 与 subscribe 的 resume
 * 并发赛跑（各 op 线程池并发），setModel 抢跑即撞 -32004。Java 侧已带 resume 自愈，
 * 走到前端 error 的自愈失败残留此前被一刀切拼上"槽位已满"——启动时槽位是空的，
 * "重启 IDE"引导完全无效（假警报）。前端按 "Model switch failed:" 前缀区分：
 *   1. 模型切换来源的 -32004 → modelSwitchInactiveHint（重开会话后重切）
 *   2. 会话激活链路（resume/messages）的 -32004 → 仍走 sessionInactiveHint 槽位文案
 *   3. 模型切换的超时错误不受影响 → 仍走 resumeBusyHint（缺陷AB 语义）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import { useStore } from '@/store/useStore'

beforeEach(() => {
  useStore.getState().init()
  useStore.setState({ lastError: null, connectionStatus: 'mock' })
})

describe('模型切换冷会话文案区分', () => {
  it('Model switch failed 的 -32004 走切换专属提示，不提槽位/重启', () => {
    messageHandler!({
      op: 'error',
      message: 'Model switch failed: [-32004] Session is not active: sess_ae357c3d-31e9-40b0-a111-710ed090b5d5',
    })
    const err = useStore.getState().lastError || ''
    expect(err).toContain('会话尚未激活')
    expect(err).not.toContain('槽位')
    expect(err).not.toContain('重启 IDE')
  })

  it('会话激活链路的 -32004 仍走槽位已满提示（回归保护）', () => {
    for (const msg of [
      '订阅失败: [-32004] Session is not active: sess_x',
      '加载消息失败: [-32004] Session is not active: sess_x',
      'createSession 失败: Session not found',
    ]) {
      useStore.setState({ lastError: null })
      messageHandler!({ op: 'error', message: msg })
      expect(useStore.getState().lastError).toContain('槽位已满')
    }
  })

  it('模型切换的超时错误仍走恢复中指引（优先级不回退）', () => {
    messageHandler!({ op: 'error', message: 'Model switch failed: 请求超时: session/setModel (6000ms)' })
    const err = useStore.getState().lastError || ''
    expect(err).toContain('自动重试')
    expect(err).not.toContain('会话尚未激活')
  })
})
