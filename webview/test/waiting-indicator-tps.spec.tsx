/**
 * 生成速率状态行（WaitingIndicator）估算保持行为（缺陷FE，2026-10-19）。
 *
 * 场景：长思考请求（真值 8s 新鲜期必然过期，只能走估算）+ 渠道流停顿
 * （千帆缓冲批送达/限流，实测单次 5~10s）。修复前：停顿恢复后的估算窗口
 * 饥饿期（~1.5s）estRaw 为 null → estHold 立即清屏 → 数字闪没。
 * 修复后：饥饿期保留最近估算值；新鲜真值/估算落地按渲染优先级接管；
 * 组件卸载（回合结束）状态自然复位。
 *
 * 驱动方式：fake timers（含 Date）+ 直接推进模块级采样
 * （noteStreamChars / modelStreamActivity.lastAt），每个用例独立时间轴
 * （+1h）靠 5s 窗口惰性剔除隔离上一用例残留样本。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { WaitingIndicator } from '@/components/WaitingIndicator'
import { modelStreamActivity, noteStreamChars } from '@/utils/streamReducer'
import type { SessionDebugRound } from '@/types/messages'

let clock = 2_000_000_000_000

/** 以 ~19 事件/s × 47 字符（实测千帆节奏）流 ms 毫秒；每事件刷新流式活跃时间 */
function stream(ms: number): void {
  const steps = Math.floor(ms / 53)
  for (let i = 0; i < steps; i++) {
    act(() => { vi.advanceTimersByTime(53) })
    noteStreamChars(47, Date.now())
    modelStreamActivity.lastAt = Date.now()
  }
}

function advance(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

function estimateEl(): Element | null {
  return document.querySelector('.waiting__rate--estimate')
}

function rateEl(): Element | null {
  return document.querySelector('.waiting__rate')
}

function round(partial: Partial<SessionDebugRound>): SessionDebugRound {
  return {
    requestIndex: 1,
    requestId: 'r1',
    recordedAt: Date.now(),
    usage: { outputTokens: 500 },
    hitRate: null,
    generationDurationMs: 2000,
    tokensPerSecond: 300,
    ...partial,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime((clock += 3_600_000))
  useStore.setState({ messages: [], streamingMessageId: null, sessionDebug: null, currentSessionId: null })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('估算保持（缺陷FE：速率不再闪没）', () => {
  it('停顿 ≥5s 后与恢复后的饥饿期（~1.5s）均不清屏，新鲜估算落地后接管', () => {
    render(<WaitingIndicator />)
    stream(3000)
    advance(600)
    expect(estimateEl()).not.toBeNull() // 健康流：估算显示

    advance(7000) // 停顿 7s：窗口清空 + streamActive 翻 false，真值恒 null（无 rounds）
    expect(estimateEl()).not.toBeNull() // 修复点：保留最近估算（修复前此处清空）

    stream(1200) // 恢复 1.2s：活跃跨度 <1.5s，estRaw 仍 null
    expect(estimateEl()).not.toBeNull() // 修复点：饥饿期不清屏

    stream(1000) // 跨度攒满 1.5s+：新鲜估算接管
    advance(600)
    const el = estimateEl()
    expect(el).not.toBeNull()
    expect(el!.textContent).toMatch(/tok\/s/)
  })

  it('回合起步（无样本无真值）行为不变：不显示速率', () => {
    render(<WaitingIndicator />)
    advance(600)
    expect(rateEl()).toBeNull()
  })

  it('新鲜真值优先于估算；真值过期且回到流式后交还估算（~ 样式）', () => {
    render(<WaitingIndicator />)
    stream(2000)
    advance(600)
    expect(estimateEl()).not.toBeNull()

    // 有效真值落账（recordedAt=now）：生成期真值新鲜 → 优先显示（非估算样式）
    act(() => {
      useStore.setState({ sessionDebug: { rounds: [round({ tokensPerSecond: 385.9 })], cache: null } })
    })
    advance(600)
    const real = rateEl()
    expect(real).not.toBeNull()
    expect(real!.className).not.toContain('--estimate')
    expect(real!.textContent).toContain('385.9')

    // 真值过期（>8s）且回到流式：估算接管（est 样式回归）
    advance(9000)
    stream(2500)
    advance(600)
    const est = rateEl()
    expect(est).not.toBeNull()
    expect(est!.className).toContain('--estimate')
  })
})