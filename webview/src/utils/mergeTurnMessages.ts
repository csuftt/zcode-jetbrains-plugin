/**
 * 重拉消息按轮聚合：同一轮 turn 的多条 assistant step 消息合并为一条。
 *
 * 服务端（session/messages）把一轮 turn 存为 N 条 assistant 消息——每个
 * step（一次模型调用）一条，各自 time.created/completed 只覆盖该 step 的
 * 几秒；而流式期间前端把整轮聚合为一条消息（created = turn.started 时间戳）。
 * 不合并的话，turn 结束重拉后每条消息的"已工作 X"都只有自己那 step 的耗时
 * （最后一条恰似"只取了思考过程的耗时"），与流式时整轮跳动的计时严重不符。
 *
 * 规则：
 *   - 相邻且 anchor.turnId 相同的 assistant 消息合并为一条
 *   - time 取整轮跨度（首条 created → 末条 completed），tokens/cost 累加，
 *     parts 依序拼接，其余 info 取首条（id/modelID 等展示字段不变）
 *   - 中间出现 user 消息或不同 turnId 即断组——AskUserQuestion 等场景 user
 *     回答会穿插，宁可漏合不可错合
 *   - 无 anchor.turnId 的消息（老数据/异常）原样保留
 */

import type { ZCodeMessage, TokenBreakdown } from '@/types/messages'

/** 读取消息归属的 turn id（assistant 消息携带 anchor.turnId，user/缺失返回 null） */
function turnIdOf(msg: ZCodeMessage): string | null {
  const tid = msg.info.anchor?.turnId
  return typeof tid === 'string' && tid ? tid : null
}

/** tokens 累加（任一侧缺失则保留另一侧；两侧都缺返回 undefined） */
function sumTokens(a?: TokenBreakdown, b?: TokenBreakdown): TokenBreakdown | undefined {
  if (!a) return b
  if (!b) return a
  return {
    total: a.total + b.total,
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache: a.cache || b.cache
      ? {
          read: (a.cache?.read ?? 0) + (b.cache?.read ?? 0),
          write: (a.cache?.write ?? 0) + (b.cache?.write ?? 0),
        }
      : undefined,
  }
}

/** 把同轮后一条 step 消息并入聚合消息（b 一定晚于 a） */
function mergeInto(a: ZCodeMessage, b: ZCodeMessage): ZCodeMessage {
  return {
    info: {
      ...a.info,
      time: {
        created: a.info.time.created,
        completed: b.info.time.completed ?? a.info.time.completed,
      },
      tokens: sumTokens(a.info.tokens, b.info.tokens),
      ...(a.info.cost != null || b.info.cost != null
        ? { cost: (a.info.cost ?? 0) + (b.info.cost ?? 0) }
        : {}),
    },
    parts: [...a.parts, ...b.parts],
  }
}

export function mergeTurnMessages(messages: ZCodeMessage[]): ZCodeMessage[] {
  const out: ZCodeMessage[] = []
  for (const msg of messages) {
    const last = out[out.length - 1]
    const turnId = turnIdOf(msg)
    if (
      turnId &&
      last &&
      msg.info.role === 'assistant' &&
      last.info.role === 'assistant' &&
      turnIdOf(last) === turnId
    ) {
      out[out.length - 1] = mergeInto(last, msg)
    } else {
      out.push(msg)
    }
  }
  return out
}
