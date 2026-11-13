/**
 * 冷启动窗口 -32004 文案区分回归测试（2026-11-13 PyCharm 案例定性）
 *
 * 场景：重启 IDE 后启动恢复重会话（775 条消息），服务端冷启动载入约 100s；
 * getSettings 撞 -32004 → resume 自愈 → resume/read 接连超时 → 自愈失败出口把
 * 外层 -32004 原样抛前端，被一刀切套上「会话槽位已满：重启 IDE 释放槽位」——
 * 而新进程槽位是空的（账本水位 0），指引自相矛盾。
 *
 * Java 侧修复：getSettings 自愈失败时按驻留账本水位下发结构化 reason=coldBoot
 * （水位 < 16 → 服务端不可能因占满拒绝会话）。前端按 reason 优先走冷启动文案，
 * 无 reason 的 -32004 仍走旧槽位文案（回归保护）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let messageHandler: ((msg: unknown) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
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

describe('冷启动窗口文案区分（reason=coldBoot）', () => {
  it('reason=coldBoot 的 -32004 走冷启动载入文案，不提槽位/重启 IDE', () => {
    messageHandler!({
      op: 'error',
      reason: 'coldBoot',
      message: '读取设置失败: [-32004] Session is not active: sess_f210e9fc-42af-456f-8cc4-c0e7b7a956fd',
    })
    const err = useStore.getState().lastError || ''
    expect(err).toContain('冷启动')
    expect(err).not.toContain('槽位')
    // 断言误导指引的核心词「释放槽位」而非「重启 IDE」——新文案句尾的
    // 「无需再重启 IDE」是否定语境，合法出现
    expect(err).not.toContain('释放槽位')
    expect(err).not.toContain('槽位已满')
    // 协议原文仍保留在括号里作存证
    expect(err).toContain('Session is not active')
  })

  it('reason=coldBoot 优先于文本正则（超时原文同样走冷启动文案）', () => {
    // 防御性用例：若出口改为透传 e2 超时原文，结构化判据仍应压制 resumeBusy 正则
    messageHandler!({
      op: 'error',
      reason: 'coldBoot',
      message: '读取设置失败: 请求超时: session/read (10000ms)',
    })
    const err = useStore.getState().lastError || ''
    expect(err).toContain('冷启动')
    expect(err).not.toContain('槽位')
  })

  it('无 reason 的 -32004 仍走槽位已满文案（回归保护）', () => {
    for (const msg of [
      '订阅失败: [-32004] Session is not active: sess_x',
      '加载消息失败: [-32004] Session is not active: sess_x',
    ]) {
      useStore.setState({ lastError: null })
      messageHandler!({ op: 'error', message: msg })
      expect(useStore.getState().lastError).toContain('槽位已满')
    }
  })
})
