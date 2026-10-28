/**
 * 额度窗口识别与会话额度横幅回归测试
 *
 * 覆盖：
 *   1. 窗口挑选（官方 (type,unit,number) 口径 + number 缺省降级 + CREDIT_LIMIT 等价）
 *   2. 剩余口径（percentage=已用占比 → 剩余=100-已用）与格式化
 *   3. 错误分类（并发 3008-3010 / 耗尽 token_quota / 服务商 1308-1321 / 限频 429 / 不命中）
 *   4. deriveQuotaBanner 派生（错误优先、窗口期签名、低额提醒顺延、关闭去重）
 *   5. store 挂钩：backendError/turn.failed 点亮触发源、turn.started 撤瞬态、窗口恢复清除
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  findWindowLimit,
  remainingPercent,
  formatRemainPct,
  quotaWindowRows,
  pickExhaustedWindows,
  pickLowWindows,
  classifyQuotaError,
  providerLimitedMessage,
  deriveQuotaBanner,
  bannerTriggerKey,
} from '@/utils/quotaWindows'
import type { QuotaLimit } from '@/types/messages'

const limit = (p: Partial<QuotaLimit>): QuotaLimit => p

describe('窗口挑选 findWindowLimit', () => {
  const limits: QuotaLimit[] = [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 86 },
    { type: 'TOKENS_LIMIT', unit: 6, percentage: 64 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 40 },
  ]

  it('官方 (type,unit,number) 全条件命中', () => {
    expect(findWindowLimit(limits, '5h')?.percentage).toBe(86)
    expect(findWindowLimit(limits, 'weekly')?.percentage).toBe(64)
    expect(findWindowLimit(limits, 'tool')?.percentage).toBe(40)
  })

  it('number 缺省时降级按 unit 匹配（部分套餐响应不带 number）', () => {
    const noNumber: QuotaLimit[] = [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 50 },
      { type: 'TIME_LIMIT', unit: 5, percentage: 10 },
    ]
    expect(findWindowLimit(noNumber, '5h')?.percentage).toBe(50)
    expect(findWindowLimit(noNumber, 'tool')?.percentage).toBe(10)
  })

  it('zai 团队后端 CREDIT_LIMIT 与 TOKENS_LIMIT 等价', () => {
    const zaiTeam: QuotaLimit[] = [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 30 }]
    expect(findWindowLimit(zaiTeam, '5h')?.percentage).toBe(30)
  })

  it('无命中返回 null，不猜窗口', () => {
    expect(findWindowLimit([{ type: 'TOKENS_LIMIT', unit: 9, percentage: 1 }], '5h')).toBeNull()
    expect(findWindowLimit(undefined, '5h')).toBeNull()
  })
})

describe('剩余口径与格式化', () => {
  it('remainingPercent：percentage 为已用占比，展示取反并夹紧', () => {
    expect(remainingPercent({ type: 'TOKENS_LIMIT', percentage: 86 })).toBe(14)
    expect(remainingPercent({ type: 'TOKENS_LIMIT', percentage: 100 })).toBe(0)
    expect(remainingPercent({ type: 'TOKENS_LIMIT', percentage: -5 })).toBe(100)
    expect(remainingPercent({ type: 'TOKENS_LIMIT' })).toBeNull()
    expect(remainingPercent(null)).toBeNull()
  })

  it('formatRemainPct：≥10 取整、<10 一位小数（官方口径）', () => {
    expect(formatRemainPct(66.4)).toBe('66%')
    expect(formatRemainPct(9.44)).toBe('9.4%')
    expect(formatRemainPct(0)).toBe('0%')
  })
})

describe('quotaWindowRows 窗口卡行', () => {
  it('三标准窗在前，未命中形状落 other 兜底', () => {
    const rows = quotaWindowRows([
      { type: 'TOKENS_LIMIT', unit: 9, percentage: 5 },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 86 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 40 },
    ])
    expect(rows.map((r) => r.key)).toEqual(['5h', 'tool', 'other'])
  })

  it('全部形状不认识时逐行 other 兜底（不空窗）', () => {
    const rows = quotaWindowRows([{ type: 'WEIRD', percentage: 1 }])
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('other')
  })
})

describe('耗尽/低额窗口', () => {
  it('pickExhaustedWindows：已用 ≥ 99.5 判耗尽', () => {
    expect(pickExhaustedWindows([
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 100 },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 99.4 },
    ])).toEqual(['5h'])
    expect(pickExhaustedWindows([{ type: 'TOKENS_LIMIT', unit: 3, number: 5 }])).toEqual([])
  })

  it('pickLowWindows：0 < 剩余 ≤ 10 按剩余升序', () => {
    const low = pickLowWindows([
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 95, nextResetTime: 200 },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 92, nextResetTime: 100 },
    ])
    expect(low.map((w) => w.key)).toEqual(['weekly', '5h'])
    expect(low[0].remainPct).toBe(5)
  })
})

describe('错误分类 classifyQuotaError', () => {
  it('并发码 3008/3009/3010 直判；包装码 + 并发文案兜底', () => {
    expect(classifyQuotaError('3010', '')).toBe('concurrent-limit')
    expect(classifyQuotaError('unknown_error', 'model concurrency limit exceeded')).toBe('concurrent-limit')
  })

  it('额度耗尽：quota 系 code / quota_exceeded / exceed 系文案', () => {
    expect(classifyQuotaError('token_quota_exceeded', '')).toBe('window-exhausted')
    expect(classifyQuotaError('1005', 'exceed quota limit')).toBe('window-exhausted')
    expect(classifyQuotaError('PROVIDER_BUSINESS_ERROR', 'Quota limit exceeded for this plan')).toBe('window-exhausted')
  })

  it('服务商边界 1308-1321', () => {
    expect(classifyQuotaError('1313', '')).toBe('provider-limited')
    expect(classifyQuotaError('1312', '')).toBeNull() // 1312 不在官方集合
  })

  it('限频：裸 429 / 3002 / rate limit 文案；耗尽签名优先于 429', () => {
    expect(classifyQuotaError('token_quota_exceeded', '', 429)).toBe('window-exhausted')
    expect(classifyQuotaError(undefined, 'some error', 429)).toBe('rate-limited')
    expect(classifyQuotaError('3002', '')).toBe('rate-limited')
    expect(classifyQuotaError(undefined, 'rate limit exceeded, retry later')).toBe('rate-limited')
  })

  it('普通错误不命中', () => {
    expect(classifyQuotaError('internal_error', 'boom', 500)).toBeNull()
    expect(classifyQuotaError(undefined, undefined, undefined)).toBeNull()
  })
})

describe('providerLimitedMessage 括号提取', () => {
  it('≥3 段方括号取第 2 段，否则原文', () => {
    expect(providerLimitedMessage('[2026-10-01][额度不足，请升级套餐][req-1]')).toBe('额度不足，请升级套餐')
    expect(providerLimitedMessage('plain message')).toBe('plain message')
    expect(providerLimitedMessage('  ')).toBeNull()
  })
})

describe('deriveQuotaBanner 派生', () => {
  const exhaustedLimits: QuotaLimit[] = [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 100, nextResetTime: 3000 },
  ]

  it('耗尽错误合并窗口点名与最早重置时间；键附窗口期签名', () => {
    const trigger = { kind: 'window-exhausted' as const, triggerKey: bannerTriggerKey('window-exhausted', 'token_quota_exceeded', 'x') }
    const view = deriveQuotaBanner({ limits: exhaustedLimits, error: trigger, dismissed: [] })
    expect(view?.kind).toBe('window-exhausted')
    expect(view?.windowKeys).toEqual(['5h'])
    expect(view?.resetTime).toBe(3000)
    expect(view?.triggerKey.endsWith('|w:5h:3000')).toBe(true)
  })

  it('同一错误指纹同窗口期去重；下个重置周期（resetTime 变化）重新提醒', () => {
    const trigger = { kind: 'window-exhausted' as const, triggerKey: 'err:k' }
    const first = deriveQuotaBanner({ limits: exhaustedLimits, error: trigger, dismissed: [] })!
    expect(deriveQuotaBanner({ limits: exhaustedLimits, error: trigger, dismissed: [first.triggerKey] })).toBeNull()
    const nextPeriod: QuotaLimit[] = [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 100, nextResetTime: 9999 }]
    const again = deriveQuotaBanner({ limits: nextPeriod, error: trigger, dismissed: [first.triggerKey] })
    expect(again?.triggerKey).not.toBe(first.triggerKey)
  })

  it('额度数据不可用（null/无窗口）时耗尽仍展示（通用文案路径）', () => {
    const trigger = { kind: 'window-exhausted' as const, triggerKey: 'err:k' }
    expect(deriveQuotaBanner({ limits: null, error: trigger, dismissed: [] })?.kind).toBe('window-exhausted')
  })

  it('无错误时低额窗口派生提醒；已关闭顺延下一窗口', () => {
    const lowLimits: QuotaLimit[] = [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 95, nextResetTime: 100 },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 93, nextResetTime: 200 },
    ]
    const view = deriveQuotaBanner({ limits: lowLimits, error: null, dismissed: [] })
    expect(view?.kind).toBe('window-low')
    expect(view?.windowKeys).toEqual(['5h'])
    expect(view?.remainPct).toBe(5)
    const key = view!.triggerKey
    const second = deriveQuotaBanner({ limits: lowLimits, error: null, dismissed: [key] })
    expect(second?.windowKeys).toEqual(['weekly'])
  })

  it('错误触发优先于低额提醒（官方优先级）', () => {
    const lowLimits: QuotaLimit[] = [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 95 }]
    const view = deriveQuotaBanner({
      limits: lowLimits,
      error: { kind: 'concurrent-limit', triggerKey: 'err:c' },
      dismissed: [],
    })
    expect(view?.kind).toBe('concurrent-limit')
  })

  it('无错误且无低额窗口 → null', () => {
    expect(deriveQuotaBanner({ limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 50 }], error: null, dismissed: [] })).toBeNull()
    expect(deriveQuotaBanner({ limits: null, error: null, dismissed: [] })).toBeNull()
  })
})

// ===== store 挂钩点集成（mock 桥接层，同 turn-error.spec 手法）=====

let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
let messageHandler: ((msg: unknown) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import { useStore } from '@/store/useStore'

const SID = 'sess_quota_1'

function pushEvent(type: string, payload: Record<string, unknown>): void {
  streamEventHandler!(SID, { type, seq: 100, sessionId: SID, turnId: 'turn_q', timestamp: Date.now(), payload })
}

beforeEach(() => {
  vi.useFakeTimers()
  useStore.getState().init()
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [],
    streaming: false,
    streamingMessageId: null,
    lastError: null,
    quotaBannerError: null,
    quotaBannerDismissed: [],
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' },
  })
})

describe('store：额度横幅挂钩', () => {
  it('backendError 命中分类点亮触发源（bigmodel 渠道）', () => {
    messageHandler!({ op: 'backendError', statusCode: 429, code: 'token_quota_exceeded', message: 'x' })
    expect(useStore.getState().quotaBannerError?.kind).toBe('window-exhausted')
  })

  it('第三方渠道不点亮（只走顶栏错误条）', () => {
    useStore.setState({ currentModel: { modelId: 'deepseek-v4', providerId: 'custom:deepseek' } })
    messageHandler!({ op: 'backendError', statusCode: 429, code: 'token_quota_exceeded', message: 'x' })
    expect(useStore.getState().quotaBannerError).toBeNull()
  })

  it('turn.failed 同样点亮；新回合开始撤下瞬态（并发），耗尽保留', () => {
    useStore.setState({ streaming: true, streamingMessageId: 'm1' })
    pushEvent('turn.failed', { error: { type: 'api_error', code: '3010', message: 'concurrency limit' } })
    expect(useStore.getState().quotaBannerError?.kind).toBe('concurrent-limit')
    pushEvent('turn.started', { turnNumber: 2, messageId: 'm2' })
    expect(useStore.getState().quotaBannerError).toBeNull()

    useStore.setState({ streaming: true, streamingMessageId: 'm3', quotaBannerError: null })
    pushEvent('turn.failed', { error: { type: 'api_error', code: 'token_quota_exceeded', message: 'x' } })
    expect(useStore.getState().quotaBannerError?.kind).toBe('window-exhausted')
    pushEvent('turn.started', { turnNumber: 3, messageId: 'm4' })
    expect(useStore.getState().quotaBannerError?.kind).toBe('window-exhausted')
  })

  it('dismissQuotaBanner 记录去重键', () => {
    useStore.getState().dismissQuotaBanner('low:5h:100')
    expect(useStore.getState().quotaBannerDismissed).toContain('low:5h:100')
  })
})
