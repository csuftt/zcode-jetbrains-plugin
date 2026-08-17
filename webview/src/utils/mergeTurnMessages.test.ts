import { describe, expect, it } from 'vitest'
import { mergeTurnMessages } from './mergeTurnMessages'
import type { ZCodeMessage } from '@/types/messages'

function asst(id: string, turnId: string | null, created: number, completed?: number, extra: Partial<ZCodeMessage['info']> = {}): ZCodeMessage {
  return {
    info: {
      role: 'assistant',
      id,
      sessionID: 's1',
      time: { created, ...(completed != null ? { completed } : {}) },
      ...(turnId ? { anchor: { turnId } } : {}),
      ...extra,
    },
    parts: [{ type: 'text', text: id }],
  }
}

function user(id: string, created: number): ZCodeMessage {
  return { info: { role: 'user', id, sessionID: 's1', time: { created } }, parts: [] }
}

describe('mergeTurnMessages', () => {
  it('同轮多条 assistant step 合并为一条，耗时取整轮跨度', () => {
    const T = 'turn_1'
    const out = mergeTurnMessages([
      user('u1', 0),
      asst('a1', T, 1_000, 4_000, { tokens: { total: 10, input: 8, output: 2, reasoning: 1 } }),
      asst('a2', T, 4_000, 9_000, { tokens: { total: 20, input: 16, output: 4, reasoning: 2 } }),
      asst('a3', T, 9_000, 30_000, { cost: 0.5 }),
    ])
    expect(out).toHaveLength(2)
    const turn = out[1]
    // 整轮跨度 1s → 30s，而非最后一个 step 的 21s
    expect(turn.info.time.created).toBe(1_000)
    expect(turn.info.time.completed).toBe(30_000)
    expect(turn.info.id).toBe('a1')
    // parts 依序拼接
    expect(turn.parts.map((p: any) => p.text)).toEqual(['a1', 'a2', 'a3'])
    // tokens 累加
    expect(turn.info.tokens).toEqual({ total: 30, input: 24, output: 6, reasoning: 3 })
    expect(turn.info.cost).toBe(0.5)
  })

  it('不同轮、user 穿插、无 turnId 均不合并', () => {
    const out = mergeTurnMessages([
      asst('a1', 'turn_1', 0, 1_000),
      asst('a2', 'turn_2', 1_000, 2_000),
      asst('a3', null, 2_000, 3_000),
      asst('a4', null, 3_000, 4_000),
      user('u1', 5_000),
      asst('a5', 'turn_3', 5_000, 6_000),
    ])
    expect(out.map((m) => m.info.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'u1', 'a5'])
  })

  it('user 回答穿插同轮（AskUserQuestion 续轮）时按相邻断组，不跨 user 合并', () => {
    const T = 'turn_1'
    const out = mergeTurnMessages([
      asst('a1', T, 0, 1_000),
      user('u1', 1_500),
      asst('a2', T, 2_000, 3_000),
    ])
    expect(out).toHaveLength(3)
    expect(out[0].info.time.completed).toBe(1_000)
  })

  it('末条 step 缺 completed 时保留前一条的 completed', () => {
    const T = 'turn_1'
    const out = mergeTurnMessages([
      asst('a1', T, 0, 5_000),
      asst('a2', T, 5_000),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].info.time.completed).toBe(5_000)
  })

  it('非相邻的同轮消息（异常乱序）不合并', () => {
    const out = mergeTurnMessages([
      asst('a1', 'turn_1', 0, 1_000),
      asst('a2', 'turn_2', 1_000, 2_000),
      asst('a3', 'turn_1', 2_000, 3_000),
    ])
    expect(out).toHaveLength(3)
  })
})
