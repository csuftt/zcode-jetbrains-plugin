/**
 * 回合壳幂等 + 终态补 completed 回归测试
 *
 * 复现缺陷（2026-10-15 真机截图）：
 *   会话出现两条"⏱ 工作中 36 秒"且秒数恒同，关闭重开才恢复。根因三层：
 *   ① v4 行流每个 step 边界的 turnHeader upsert 都重投影 turn.started，messageId
 *      依赖帧内 entityId 在场——迟到订阅自愈壳（v4-late-<turnId>）、快照兜底壳
 *      （v4-snap-<turnId>）与后续真实 entityId 互相不命中，handleTurnStarted 只按
 *      messageId 判重 → 同回合叠出第二个空壳（created 同帧 sentAt，两行秒数恒同）；
 *   ② turn.completed 只置 turnEnded 不写壳的 completed，权威值只能靠轮末重拉，
 *      而自动续轮场景重拉响应撞上下轮 streaming 守卫被拦 → 悬空壳恒缺 completed；
 *   ③ MessageFooter 的 streaming prop 是链级/全局标志，悬空壳也被点亮"工作中"。
 *
 * 断言：
 *   1. 同 turnId 的二次 turn.started（messageId 不同族）复用首壳不新建
 *   2. 不同 turnId 正常各建一壳（连续轮不受影响）
 *   3. turn.completed / turn.failed 给本 turn 壳补 completed（帧时间戳）
 *   4. 已有 completed 不覆盖（重放安全）；缺 turnId 时按 streamingMessageId 兜底
 *   5. 乱序（新壳先建、旧轮终态后到）按 turnId 精确落账，不误写新壳
 */

import { describe, it, expect } from 'vitest'
import { applyStreamEvent } from '@/utils/streamReducer'
import type { StreamEvent, ZCodeMessage } from '@/types/messages'

const SID = 'sess_dedupe'

function mk(
  type: string,
  turnId: string,
  timestamp: number,
  payload: Record<string, unknown> = {},
): StreamEvent {
  return { type, seq: 1, sessionId: SID, turnId, timestamp, payload } as StreamEvent
}

function assistantShell(
  id: string,
  turnId: string,
  created: number,
  completed?: number,
): ZCodeMessage {
  return {
    info: {
      role: 'assistant',
      time: completed ? { created, completed } : { created },
      id,
      sessionID: SID,
      turnId,
    },
    parts: [],
  }
}

describe('handleTurnStarted：同 turn 幂等判重', () => {
  it('messageId 不同族的二次 turn.started（v4-late 合成壳 vs 真实 entityId）复用首壳', () => {
    // 首壳：迟到订阅自愈合成（V4FrameMapper 头插 v4-late-<turnId>）
    const r1 = applyStreamEvent([], mk('turn.started', 'turn_9', 1000, { messageId: 'v4-late-turn_9' }), null)
    expect(r1.messages).toHaveLength(1)
    expect(r1.messages[0].info.id).toBe('v4-late-turn_9')
    // 二次：turnHeader upsert 投影真实 entityId（upsert 帧与首帧相隔多个 step）
    const r2 = applyStreamEvent(r1.messages, mk('turn.started', 'turn_9', 360_000, { messageId: 'msg_entity_1' }), r1.streamingMessageId)
    expect(r2.messages).toHaveLength(1) // 关键：不叠第二个空壳
    expect(r2.messages[0].info.id).toBe('v4-late-turn_9')
    expect(r2.streamingMessageId).toBe('v4-late-turn_9')
  })

  it('快照兜底壳（v4-snap-）与后续真实 started 同样只保一壳', () => {
    const r1 = applyStreamEvent([], mk('turn.started', 'turn_8', 1000, { messageId: 'v4-snap-turn_8' }), null)
    const r2 = applyStreamEvent(r1.messages, mk('turn.started', 'turn_8', 2000, { messageId: 'msg_entity_2' }), r1.streamingMessageId)
    expect(r2.messages).toHaveLength(1)
  })

  it('缺 entityId 的 upsert（退化 stream_<turnId>）不叠壳', () => {
    const r1 = applyStreamEvent([], mk('turn.started', 'turn_7', 1000, { messageId: 'msg_entity_3' }), null)
    const r2 = applyStreamEvent(r1.messages, mk('turn.started', 'turn_7', 5000, {}), r1.streamingMessageId)
    expect(r2.messages).toHaveLength(1)
    expect(r2.messages[0].info.id).toBe('msg_entity_3')
  })

  it('不同 turnId 正常各建一壳（连续轮不受影响）', () => {
    const r1 = applyStreamEvent([], mk('turn.started', 'turn_a', 1000, { messageId: 'msg_a' }), null)
    const done = applyStreamEvent(r1.messages, mk('turn.completed', 'turn_a', 2000), r1.streamingMessageId)
    const r2 = applyStreamEvent(done.messages, mk('turn.started', 'turn_b', 3000, { messageId: 'msg_b' }), null)
    expect(r2.messages).toHaveLength(2)
    expect(r2.streamingMessageId).toBe('msg_b')
  })

  it('messageId 命中 user 消息建的 stream_ 壳同样挂 turnId、重复投递复用', () => {
    const userMsg: ZCodeMessage = {
      info: { role: 'user', time: { created: 500 }, id: 'msg_u1', sessionID: SID },
      parts: [{ type: 'text', text: 'hi' }],
    }
    const r1 = applyStreamEvent([userMsg], mk('turn.started', 'turn_c', 1000, { messageId: 'msg_u1' }), null)
    expect(r1.messages).toHaveLength(2)
    expect(r1.messages[1].info.id).toBe('stream_msg_u1')
    expect(r1.messages[1].info.turnId).toBe('turn_c')
    const r2 = applyStreamEvent(r1.messages, mk('turn.started', 'turn_c', 4000, {}), r1.streamingMessageId)
    expect(r2.messages).toHaveLength(2)
    expect(r2.streamingMessageId).toBe('stream_msg_u1')
  })

  it('主通道：step 边界同 messageId 重投影（永远先命中 user 消息）不叠壳', () => {
    // turn.started 首投：乐观气泡已改名 msg_u2 → 命中 user → 建 stream_msg_u2 壳
    const userMsg: ZCodeMessage = {
      info: { role: 'user', time: { created: 500 }, id: 'msg_u2', sessionID: SID },
      parts: [{ type: 'text', text: '查一下' }],
    }
    const r1 = applyStreamEvent([userMsg], mk('turn.started', 'turn_d', 1000, { messageId: 'msg_u2' }), null)
    expect(r1.messages).toHaveLength(2)
    // step 边界 turnHeader upsert 重投影，messageId 仍是 user 消息 id——
    // 判重若放在 user 命中分支之后就永远到不了，每次都新建一条同 id 壳
    const r2 = applyStreamEvent(r1.messages, mk('turn.started', 'turn_d', 4000, { messageId: 'msg_u2' }), r1.streamingMessageId)
    expect(r2.messages).toHaveLength(2) // 关键：仍是 user + 一条壳
    expect(r2.streamingMessageId).toBe('stream_msg_u2')
  })
})

describe('turn 终态：本地补 completed', () => {
  it('turn.completed 按壳的 turnId 补帧时间戳', () => {
    const shell = assistantShell('msg_a', 'turn_x', 1000)
    const r = applyStreamEvent([shell], mk('turn.completed', 'turn_x', 9500), 'msg_a')
    expect(r.messages[0].info.time.completed).toBe(9500)
  })

  it('turn.failed 同样补（失败回合不再恒亮"工作中"）', () => {
    const shell = assistantShell('msg_a', 'turn_x', 1000)
    const r = applyStreamEvent([shell], mk('turn.failed', 'turn_x', 8000, { error: { message: 'boom' } }), 'msg_a')
    expect(r.messages[0].info.time.completed).toBe(8000)
  })

  it('已有 completed 不覆盖（重放安全）', () => {
    const shell = assistantShell('msg_a', 'turn_x', 1000, 5000)
    const r = applyStreamEvent([shell], mk('turn.completed', 'turn_x', 9500), 'msg_a')
    expect(r.messages[0].info.time.completed).toBe(5000)
  })

  it('缺 turnId 的 legacy 流按 streamingMessageId 兜底', () => {
    const shell = assistantShell('legacy_msg', 'turn_old', 1000)
    shell.info.turnId = undefined
    const ev = { type: 'turn.completed', seq: 1, sessionId: SID, turnId: null, timestamp: 7000, payload: {} } as StreamEvent
    const r = applyStreamEvent([shell], ev, 'legacy_msg')
    expect(r.messages[0].info.time.completed).toBe(7000)
  })

  it('乱序（新壳先建、旧轮终态后到）按 turnId 精确落账不误写新壳', () => {
    const oldShell = assistantShell('v4-late-turn_x', 'turn_x', 1000)
    const r1 = applyStreamEvent([oldShell], mk('turn.started', 'turn_y', 5000, { messageId: 'msg_y' }), 'v4-late-turn_x')
    expect(r1.streamingMessageId).toBe('msg_y') // 新壳已接管流式
    const r2 = applyStreamEvent(r1.messages, mk('turn.completed', 'turn_x', 6000), r1.streamingMessageId)
    const old = r2.messages.find((m) => m.info.id === 'v4-late-turn_x')!
    const fresh = r2.messages.find((m) => m.info.id === 'msg_y')!
    expect(old.info.time.completed).toBe(6000)
    expect(fresh.info.time.completed).toBeUndefined()
  })
})
