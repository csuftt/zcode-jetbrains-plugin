/**
 * 忙窗口错误提示与恢复清除的回归测试（缺陷AB，2026-08-27 用户日志实测）
 *
 * 场景：resume 恢复带中断回合的会话（如模型 API 不可达留下未完成回合）时，
 * app-server 对该会话的请求进入约 1~2 分钟忙窗口——subscribe/setModel/read
 * 集中超时后自愈。Java 侧失败后延迟自动重试，前端只负责：
 *   1. 会话级请求超时错误追加"恢复中"指引（防用户一看报错就重启，
 *      重启重新 resume 重新进窗口，永远观察不到自愈）
 *   2. busyRetryRecovered 到达时清除该类提示（Java 重试成功的信号）
 *   3. 其他错误不受影响（不追加 / 不被误清）
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
  // init 注册 onMessage（messageHandler 赋值）并走 VITEST mock 分支拉数据
  useStore.getState().init()
  useStore.setState({ lastError: null, connectionStatus: 'mock' })
})

describe('忙窗口错误提示（缺陷AB）', () => {
  it('session 级请求超时错误追加恢复中指引（含勿重启引导）', () => {
    messageHandler!({ op: 'error', message: '订阅失败: 请求超时: session/subscribe (10000ms)' })
    const err = useStore.getState().lastError || ''
    expect(err).toContain('请求超时: session/subscribe')
    expect(err).toContain('自动重试')
    expect(err).toContain('请勿重启')
  })

  it('settings / setModel / messages / subagents 的超时同样命中', () => {
    for (const msg of [
      '读取设置失败: 请求超时: session/read (10000ms)',
      'Model switch failed: 请求超时: session/setModel (6000ms)',
      '处理失败: 请求超时: session/messages (15000ms)',
      'subagents query failed: 请求超时: session/subagents (10000ms)',
    ]) {
      useStore.setState({ lastError: null })
      messageHandler!({ op: 'error', message: msg })
      expect(useStore.getState().lastError).toContain('自动重试')
    }
  })

  it('非超时错误不追加恢复中指引', () => {
    messageHandler!({ op: 'error', message: '其他错误: something broke' })
    expect(useStore.getState().lastError).toBe('其他错误: something broke')
  })

  it('busyRetryRecovered 清除忙窗口提示', () => {
    messageHandler!({ op: 'error', message: '读取设置失败: 请求超时: session/read (10000ms)' })
    expect(useStore.getState().lastError).toBeTruthy()
    messageHandler!({ op: 'busyRetryRecovered' })
    expect(useStore.getState().lastError).toBeNull()
  })

  it('busyRetryRecovered 不误清无关错误', () => {
    messageHandler!({ op: 'error', message: '其他错误: something broke' })
    messageHandler!({ op: 'busyRetryRecovered' })
    expect(useStore.getState().lastError).toBe('其他错误: something broke')
  })
})
