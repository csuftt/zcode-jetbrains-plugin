/**
 * 额度趋势派生回归测试
 *
 * 覆盖：
 *   1. provider 分段（凭证回退到别家 key 时两段不能接成一条曲线）
 *   2. 窗口挑选（周额度优先，回退 5h/唯一 Tokens）
 *   3. 每日消耗摊分（同天/跨夜/长时间空档/重置不计负）
 *   4. 汇总指标（当前已用/区间消耗/日均/覆盖天数）
 *   5. 「每 1% ≈ 多少 Token」（覆盖比例校正、日/小时粒度、阈值）
 */

import { describe, it, expect } from 'vitest'
import {
  dailyStats,
  dateRangeKeys,
  downsample,
  extractWindow,
  latestProviderSegment,
  localDateKey,
  pickWindow,
  summarize,
  tokenPerPercent,
} from '@/utils/quotaHistory'
import type { QuotaHistorySample, ModelUsageData } from '@/types/messages'

/** 本地时间构造（测试不依赖运行时时区）*/
const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

const sample = (
  ts: number,
  weekly: number,
  providerId = 'builtin:bigmodel-coding-plan',
): QuotaHistorySample => ({
  ts,
  providerId,
  limits: [
    { type: 'TOKENS_LIMIT', unit: 3, percentage: 20, nextResetTime: ts + 3600_000 },
    { type: 'TOKENS_LIMIT', unit: 6, percentage: weekly, nextResetTime: ts + 5 * 86400_000 },
    { type: 'TIME_LIMIT', unit: 5, percentage: 40 },
  ],
})

describe('provider 分段 latestProviderSegment', () => {
  it('只保留末尾连续同 provider 的一段', () => {
    const samples = [
      sample(at(2026, 11, 10, 10), 30, 'builtin:other'),
      sample(at(2026, 11, 10, 11), 40),
      sample(at(2026, 11, 10, 12), 42),
    ]
    const seg = latestProviderSegment(samples)
    expect(seg).toHaveLength(2)
    expect(seg[1].limits[1].percentage).toBe(42)
  })

  it('空输入返回空数组', () => {
    expect(latestProviderSegment([])).toEqual([])
  })
})

describe('窗口挑选 pickWindow', () => {
  it('周额度（unit=6）优先', () => {
    expect(pickWindow([sample(at(2026, 11, 10, 10), 42)])).toEqual({ type: 'TOKENS_LIMIT', unit: 6 })
  })

  it('无周额度回退 5 小时窗口', () => {
    const s: QuotaHistorySample = {
      ts: at(2026, 11, 10, 10),
      providerId: 'p',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 55 },
        { type: 'TIME_LIMIT', unit: 5, percentage: 10 },
      ],
    }
    expect(pickWindow([s])).toEqual({ type: 'TOKENS_LIMIT', unit: 3 })
  })

  it('只有未知 Tokens 窗口时取第一个；没有 Tokens 窗口返回 null', () => {
    const unknown: QuotaHistorySample = {
      ts: 1,
      providerId: 'p',
      limits: [{ type: 'TOKENS_LIMIT', unit: 9, percentage: 5 }],
    }
    expect(pickWindow([unknown])).toEqual({ type: 'TOKENS_LIMIT', unit: 9 })
    expect(pickWindow([{ ts: 1, providerId: 'p', limits: [{ type: 'TIME_LIMIT', unit: 5, percentage: 5 }] }])).toBeNull()
    expect(pickWindow([])).toBeNull()
  })
})

describe('曲线点 extractWindow', () => {
  it('按 type+unit 抽点并夹到 0..100', () => {
    const samples = [
      sample(at(2026, 11, 10, 10), 30),
      sample(at(2026, 11, 10, 11), 120),
      { ts: at(2026, 11, 10, 12), providerId: 'p', limits: [{ type: 'TOKENS_LIMIT', unit: 6, percentage: -3 }] },
    ]
    const points = extractWindow(samples, { type: 'TOKENS_LIMIT', unit: 6 })
    expect(points.map((p) => p.pct)).toEqual([30, 100, 0])
    expect(points[0].resetAt).toBeTypeOf('number')
  })
})

describe('降采样 downsample', () => {
  it('同一时间桶只留最后一个点', () => {
    const pts = [0, 5, 10, 25, 40].map((m) => ({ ts: m * 60_000, pct: m }))
    const out = downsample(pts, 15 * 60_000)
    expect(out.map((p) => p.pct)).toEqual([10, 25, 40])
  })
})

describe('每日消耗 dailyStats', () => {
  it('同一区间按时间比例摊到每天，跨夜各算一半', () => {
    const points = [
      { ts: at(2026, 11, 10, 23), pct: 10 },
      { ts: at(2026, 11, 11, 1), pct: 14 },
    ]
    const daily = dailyStats(points)
    const byDate = Object.fromEntries(daily.map((d) => [d.date, d.pct]))
    expect(byDate['2026-11-10']).toBeCloseTo(2, 6)
    expect(byDate['2026-11-11']).toBeCloseTo(2, 6)
  })

  it('长时间空档的增量按天摊平，不会全砸在恢复采样那天', () => {
    const points = [
      { ts: at(2026, 11, 10, 12), pct: 10 },
      { ts: at(2026, 11, 12, 12), pct: 16 },
    ]
    const byDate = Object.fromEntries(dailyStats(points).map((d) => [d.date, d.pct]))
    expect(byDate['2026-11-10']).toBeCloseTo(1.5, 6)
    expect(byDate['2026-11-11']).toBeCloseTo(3, 6)
    expect(byDate['2026-11-12']).toBeCloseTo(1.5, 6)
  })

  it('重置（负差值）不计消耗，只记覆盖时间', () => {
    const points = [
      { ts: at(2026, 11, 10, 10), pct: 80 },
      { ts: at(2026, 11, 10, 11), pct: 3 },
      { ts: at(2026, 11, 10, 12), pct: 9 },
    ]
    const daily = dailyStats(points)
    expect(daily).toHaveLength(1)
    expect(daily[0].pct).toBeCloseTo(6, 6)
    expect(daily[0].coveredMs).toBe(2 * 3600_000)
  })

  it('单区间增量超过 100 按 100 封顶（脏数据防御）', () => {
    const points = [
      { ts: at(2026, 11, 10, 10), pct: 0 },
      { ts: at(2026, 11, 10, 11), pct: 400 },
    ]
    expect(dailyStats(points)[0].pct).toBeCloseTo(100, 6)
  })
})

describe('汇总 summarize', () => {
  it('当前已用取最后一点，区间消耗按天累加，日均按覆盖天数', () => {
    const points = [
      { ts: at(2026, 11, 10, 10), pct: 10 },
      { ts: at(2026, 11, 10, 12), pct: 16 },
      { ts: at(2026, 11, 11, 12), pct: 22 },
    ]
    const daily = dailyStats(points)
    const s = summarize(points, daily)
    expect(s.currentPct).toBe(22)
    expect(s.consumedPct).toBeCloseTo(12, 6)
    expect(s.coveredDays).toBe(2)
    expect(s.avgDailyPct).toBeCloseTo(6, 6)
  })

  it('无点：当前/日均 null', () => {
    expect(summarize([], [])).toEqual({
      currentPct: null,
      consumedPct: 0,
      avgDailyPct: null,
      coveredDays: 0,
    })
  })
})

describe('每 1% ≈ 多少 Token tokenPerPercent', () => {
  const day = 86400_000
  const usage = (over: Partial<ModelUsageData> = {}): ModelUsageData => ({
    granularity: 'daily',
    x_time: ['2026-11-10', '2026-11-11'],
    modelDataList: [
      { modelName: 'glm-5', tokensUsage: [600_000, 200_000] },
      { modelName: 'glm-4.6', tokensUsage: [400_000, 0] },
    ],
    ...over,
  })

  it('全天覆盖：Σtoken / Σ百分比', () => {
    const daily = [
      { date: '2026-11-10', pct: 10, coveredMs: day },
      { date: '2026-11-11', pct: 5, coveredMs: day },
    ]
    const r = tokenPerPercent(daily, usage(), at(2026, 11, 12, 9))
    expect(r).not.toBeNull()
    expect(r!.tokensPerPct).toBeCloseTo(1_200_000 / 15, 6)
    expect(r!.days).toBe(2)
  })

  it('历史天采样只覆盖一半：token 按一半折算', () => {
    const daily = [{ date: '2026-11-10', pct: 10, coveredMs: day / 2 }]
    const r = tokenPerPercent(daily, usage(), at(2026, 11, 11, 12))
    expect(r!.tokensPerPct).toBeCloseTo(1_000_000 / 2 / 10, 6)
  })

  it('当天只流逝一半：按已流逝时长折算（不按 24h 低估）', () => {
    // 正午查：coveredMs=12h、当天已流逝 12h → 覆盖 100%，token 不打折
    const daily = [{ date: '2026-11-10', pct: 5, coveredMs: 12 * 3600_000 }]
    const r = tokenPerPercent(daily, usage(), at(2026, 11, 10, 12))
    expect(r!.tokensPerPct).toBeCloseTo(1_000_000 / 5, 6)
  })

  it('总消耗不足 1% 时不给结果（舍入误差放大）', () => {
    const daily = [{ date: '2026-11-10', pct: 0.4, coveredMs: day }]
    expect(tokenPerPercent(daily, usage(), at(2026, 11, 11, 12))).toBeNull()
  })

  it('小时粒度按日期聚合', () => {
    const hourly: ModelUsageData = {
      granularity: 'hourly',
      x_time: ['2026-11-10 00:00', '2026-11-10 01:00'],
      modelDataList: [{ modelName: 'glm-5', tokensUsage: [300_000, 700_000] }],
    }
    const daily = [{ date: '2026-11-10', pct: 10, coveredMs: day }]
    const r = tokenPerPercent(daily, hourly, at(2026, 11, 11, 12))
    expect(r!.tokensPerPct).toBeCloseTo(100_000, 6)
  })

  it('无模型曲线/无消耗返回 null', () => {
    expect(tokenPerPercent([], null)).toBeNull()
    expect(tokenPerPercent([{ date: '2026-11-10', pct: 0, coveredMs: day }], usage(), at(2026, 11, 11, 12))).toBeNull()
  })
})

describe('日期工具', () => {
  it('localDateKey 用本地时区', () => {
    expect(localDateKey(at(2026, 11, 10, 23, 59))).toBe('2026-11-10')
  })

  it('dateRangeKeys 含今天、升序', () => {
    const keys = dateRangeKeys(3, at(2026, 11, 12, 8))
    expect(keys).toEqual(['2026-11-10', '2026-11-11', '2026-11-12'])
  })
})