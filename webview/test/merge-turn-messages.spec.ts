import { describe, expect, it } from 'vitest'
import { mergeTurnMessages } from '@/utils/mergeTurnMessages'
import type { ZCodeMessage } from '@/types/messages'

/** 旧形态 assistant 行（anchor.turnId 可用时走 t: 键）*/
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

/** 3.18.0 step 行形态：session/messages RPC 应答不带 anchor，靠 parentMessageId 分组 */
function stepRow(id: string, parent: string | null, created: number, completed?: number, extra: Partial<ZCodeMessage['info']> = {}): ZCodeMessage {
  return {
    info: {
      role: 'assistant',
      id,
      sessionID: 's1',
      parentMessageId: parent ?? undefined,
      time: { created, ...(completed != null ? { completed } : {}) },
      ...extra,
    } as ZCodeMessage['info'],
    parts: [
      { type: 'step-start' } as any,
      { type: 'text', text: id } as any,
      { type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: {} } as any,
    ],
  }
}

function user(id: string, created: number): ZCodeMessage {
  return { info: { role: 'user', id, sessionID: 's1', time: { created } }, parts: [] }
}

describe('mergeTurnMessages', () => {
  it('同轮多条 assistant step（anchor.turnId）合并为一条，耗时取整轮跨度', () => {
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

  // ---- 缺陷HC（2026-11-11）：session/messages 应答不带 anchor.turnId，parent 键兜底 ----

  it('3.18.0 step 行（无 anchor，同 parentMessageId）合并为一条并剥掉 step-start/finish 壳', () => {
    const P = 'msg_user_1'
    const out = mergeTurnMessages([
      user('u1', 0),
      stepRow('s1', P, 1_000, 4_000, { tokens: { total: 10, input: 8, output: 2, reasoning: 1 } }),
      stepRow('s2', P, 4_000, 9_000, { tokens: { total: 20, input: 16, output: 4, reasoning: 2 } }),
      stepRow('s3', P, 9_000, 15_000),
    ])
    expect(out).toHaveLength(2) // user + 合并后的整轮
    const turn = out[1]
    expect(turn.info.id).toBe('s1') // id 取轮内第一段（legacy 约定）
    expect(turn.info.time.created).toBe(1_000)
    expect(turn.info.time.completed).toBe(15_000) // 整轮跨度而非末 step
    expect(turn.info.tokens).toEqual({ total: 30, input: 24, output: 6, reasoning: 3 })
    // 壳 part 全部剥净（含首条的 step-start），只留内容 part
    expect(turn.parts.map((p: any) => p.type)).toEqual(['text', 'text', 'text'])
    expect(turn.parts.map((p: any) => p.text)).toEqual(['s1', 's2', 's3'])
  })

  it('parent 相同但不带 step-start（老形态单条 assistant）不合并', () => {
    const out = mergeTurnMessages([
      asst('a1', null, 0, 1_000, { parentID: 'msg_user_1' }),
      asst('a2', null, 1_000, 2_000, { parentID: 'msg_user_1' }),
    ])
    expect(out).toHaveLength(2)
  })

  it('相邻两轮 parent 不同（step 行）不合并', () => {
    const out = mergeTurnMessages([
      user('u1', 0),
      stepRow('s1', 'msg_user_1', 1_000, 2_000),
      user('u2', 2_500),
      stepRow('s2', 'msg_user_2', 3_000, 4_000),
    ])
    expect(out.map((m) => m.info.id)).toEqual(['u1', 's1', 'u2', 's2'])
  })

  it('parentID 旧名兜底同样命中分组', () => {
    const row = (id: string, created: number, completed?: number): ZCodeMessage => ({
      info: {
        role: 'assistant',
        id,
        sessionID: 's1',
        parentID: 'msg_user_1',
        time: { created, ...(completed != null ? { completed } : {}) },
      } as ZCodeMessage['info'],
      parts: [{ type: 'step-start' } as any, { type: 'tool', tool: 'Bash' } as any],
    })
    const out = mergeTurnMessages([user('u1', 0), row('s1', 1_000, 2_000), row('s2', 2_000, 3_000)])
    expect(out).toHaveLength(2)
    // 纯工具 step 合并后剥壳只剩 tool part——具备折叠判定素材
    expect(out[1].parts.map((p: any) => p.type)).toEqual(['tool', 'tool'])
  })

  it('user 回答穿插 step 行（AskUserQuestion 续轮）按相邻断组，不跨 user 合并', () => {
    const P = 'msg_user_1'
    const out = mergeTurnMessages([
      stepRow('s1', P, 0, 1_000),
      user('ua', 1_500),
      stepRow('s2', P, 2_000, 3_000),
    ])
    expect(out.map((m) => m.info.id)).toEqual(['s1', 'ua', 's2'])
  })

  it('单条 step 轮（无同组相邻）原样保留不剥壳', () => {
    const out = mergeTurnMessages([user('u1', 0), stepRow('s1', 'msg_user_1', 1_000, 2_000)])
    expect(out).toHaveLength(2)
    expect(out[1].parts.some((p: any) => p.type === 'step-start')).toBe(true)
  })
})
