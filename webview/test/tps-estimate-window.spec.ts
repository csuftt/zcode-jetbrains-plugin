/**
 * 生成速率估算窗口的特征化测试（真机排查"速率时不时消失"配套）。
 *
 * 背景（2026-10-19 千帆 deepseek-v4.1-flash 实测）：
 * - webview 侧 noteStreamChars 的采样密度 = v4 wire 的 row.delta op 速率
 *   （实测 ~13~20 事件/s、~47 字符/事件；Java 16ms 批处理不合并事件）；
 * - streamCharsPerSec 的可用性由两个隐藏门槛决定：5s 窗口内空样本、span<1.5s，
 *   另有 push 时 120 样本硬上限（事件速率 >~24/s 起 5s 窗口装不下、>~80/s 时
 *   窗口内最老样本不足 1.5s → 估算恒不可用）；
 * - 实时流出现 ≥5s 停顿后（渠道限流/拥塞），恢复后约 1.5s 内估算不可用 → 函数层面返回
 *   null（缺陷FE 修复后组件层在饥饿期保留最近估算值不闪没，见 waiting-indicator-tps.spec.tsx；
 *   本文件锁的是窗口函数的边界行为，防后续调整无声回退）。
 */
import { describe, expect, it } from 'vitest'
import { noteStreamChars, streamCharsPerSec } from '@/utils/streamReducer'
import { lastTpsRound } from '@/utils/tps'
import type { SessionDebugRound } from '@/types/messages'

/** 推进一个足够大的 now 让 5s 窗口惰性清空（模块级采样数组无公开 reset） */
let clock = 1_000_000
function useClock(): { t: () => number; advance: (ms: number) => void } {
  const base = (clock += 3_600_000) // 每个用例独立时间轴，天然隔离上一用例残留样本
  let cur = base
  return {
    t: () => cur,
    advance: (ms: number) => {
      cur += ms
    },
  }
}

/** 以 ratePerSec 事件速率、每事件 chars 字符推进 ms 毫秒（尽量贴近真实节奏：每 op 独立时间戳） */
function stream(t: () => number, advance: (ms: number) => void, ms: number, ratePerSec: number, chars: number): void {
  const step = 1000 / ratePerSec
  let elapsed = 0
  while (elapsed < ms) {
    advance(step)
    elapsed += step
    noteStreamChars(chars, t())
  }
}

function round(partial: Partial<SessionDebugRound> & { requestId: string }): SessionDebugRound {
  return {
    requestIndex: 1,
    recordedAt: Date.now(),
    usage: { outputTokens: 500 },
    hitRate: null,
    generationDurationMs: 2000,
    tokensPerSecond: 300,
    ...partial,
  }
}

describe('streamCharsPerSec 估算窗口行为', () => {
  it('连续流 ~19 事件/s（实测千帆节奏）：1.5s 后估算可用且稳定', () => {
    const { t, advance } = useClock()
    stream(t, advance, 3000, 19, 47)
    // 3s 连续流：窗口有样本、span≥1.5s → 可用
    const cps = streamCharsPerSec(t())
    expect(cps).not.toBeNull()
    // ≈ 19×47 = 893 chars/s，允许调度抖动
    expect(cps!).toBeGreaterThan(500)
    expect(cps!).toBeLessThan(1400)
  })

  it('流起步 1.5s 内估算不可用（span 门槛）', () => {
    const { t, advance } = useClock()
    stream(t, advance, 1000, 19, 47) // 只流 1s
    expect(streamCharsPerSec(t())).toBeNull()
  })

  it('≥5s 停顿后恢复：函数层面前 1.5s 估算不可用（组件层由"估算保持"兜底显示，见 WaitingIndicator）', () => {
    const { t, advance } = useClock()
    stream(t, advance, 4000, 19, 47)   // 先流 4s（窗口满载）
    expect(streamCharsPerSec(t())).not.toBeNull()

    advance(6000)                       // 停顿 6s：窗口样本全部超 5s
    expect(streamCharsPerSec(t())).toBeNull()

    stream(t, advance, 1400, 19, 47)    // 恢复后 1.4s：活跃跨度<1.5s
    expect(streamCharsPerSec(t())).toBeNull()

    stream(t, advance, 600, 19, 47)     // 恢复后 2.0s：跨度≥1.5s
    expect(streamCharsPerSec(t())).not.toBeNull()
  })

  it('停顿但窗口未清空（<5s）：估值保持满速率不衰减（缺陷FE，跨度按样本首尾计）', () => {
    const { t, advance } = useClock()
    stream(t, advance, 4000, 19, 47)   // [0,4s] 流速 ≈ 893 chars/s
    advance(3000)                       // 停顿 3s：样本仍在 5s 窗口内
    const cps = streamCharsPerSec(t())
    expect(cps).not.toBeNull()
    // 旧口径（wall 跨度）会把 2s 的字符摊到 5s 上跌到 ~360；新口径保持原速率
    expect(cps!).toBeGreaterThan(700)
    expect(cps!).toBeLessThan(1100)
  })

  it('120 样本硬上限：事件速率 >~80/s 时窗口内最老样本不足 1.5s，估算恒不可用（当前渠道速率下不触发）', () => {
    const { t, advance } = useClock()
    // 100 事件/s × 47 字符：120 样本只覆盖 1.2s < 1.5s
    stream(t, advance, 4000, 100, 47)
    expect(streamCharsPerSec(t())).toBeNull()
  })

  it('事件速率 60/s（120 样本覆盖 2s）：估算仍可用——上限只在高速率下咬人', () => {
    const { t, advance } = useClock()
    stream(t, advance, 4000, 60, 47)
    expect(streamCharsPerSec(t())).not.toBeNull()
  })
})

describe('lastTpsRound 样本过滤（千帆快速工具轮残样实测）', () => {
  it('genMs<300 / tps>1000 的样本被跳过，回退到最近的有效真值', () => {
    const rounds = [
      round({ requestId: 'r1', tokensPerSecond: 260.8, generationDurationMs: 125083 }),
      round({ requestId: 'r2', tokensPerSecond: 340.8, generationDurationMs: 628 }),
      round({ requestId: 'r3', tokensPerSecond: 616.2, generationDurationMs: 99 }),   // 实测残样：窗口<300ms
      round({ requestId: 'r4', tokensPerSecond: 7625, generationDurationMs: 8 }),     // 实测残样：7625 tok/s
    ]
    const last = lastTpsRound(rounds)
    expect(last?.requestId).toBe('r2')
  })

  it('全是残样时返回 null（真值缺位 → 显示只能靠估算）', () => {
    const rounds = [
      round({ requestId: 'r1', tokensPerSecond: 7625, generationDurationMs: 8 }),
      round({ requestId: 'r2', tokensPerSecond: null, generationDurationMs: 1200 }),
    ]
    expect(lastTpsRound(rounds)).toBeNull()
  })
})