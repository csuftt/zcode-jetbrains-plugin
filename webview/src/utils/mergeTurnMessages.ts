/**
 * 重拉消息按轮聚合：同一轮 turn 的多条 assistant step 消息合并为一条。
 *
 * 服务端（session/messages）把一轮 turn 存为 N 条 assistant 消息——每个
 * step（一次模型调用）一条，各自 time.created/completed 只覆盖该 step 的
 * 几秒；而流式期间前端把整轮聚合为一条消息（created = turn.started 时间戳）。
 * 不合并的话，turn 结束重拉后每条消息的"已工作 X"都只有自己那 step 的耗时
 * （最后一条恰似"只取了思考过程的耗时"），与流式时整轮跳动的计时严重不符。
 *
 * 分组键（2026-11-11 缺陷HC 定案）：
 *   - anchor.turnId：3.18.0 db 存储形态带 anchor；但 session/messages RPC 应答
 *     **不带 anchor**（diag-turn-merge-anchor.py 实测 72/72 全缺）——只认它时
 *     重拉落地全部不合并，整轮拆成多条小消息渲染：无 text 结论的纯工具 step
 *     行满足不了折叠判定（collapsible 要求消息里有 text 结论），完成轮折叠栏
 *     零散、前面过程全部外露。
 *   - 兜底 parent 键（parentMessageId=3.18.0 RPC 形态 / parentID=旧名）：同轮
 *     全部 step 行的 parent 严格指向触发 user 消息（同会话相邻两轮各 19/18 条
 *     实测轮内一致）。仅对带 step-start part 的"step 行"生效——老 CLI 一轮一条
 *     assistant 无此 part，不需要合并也不能合并（防形态混杂时相邻两轮误并）。
 *   - 中间出现可见 user 消息即断组——AskUserQuestion 等场景 user 回答会穿插，
 *     宁可漏合不可错合（synthetic 提醒行在 merge 之前已被 model-only 过滤掉）
 *
 * 合并规则：
 *   - 相邻且组键相同的 assistant 消息合并为一条
 *   - time 取整轮跨度（首条 created → 末条 completed），tokens/cost 累加，
 *     parts 依序拼接，其余 info 取首条（id 取轮内第一段——与 legacy 视图
 *     「整轮合并、messageId 取第一段」约定一致；fork 的轮级换算在 Kotlin
 *     forkAssistantViaV4 按 entityId→turnId 重选带 canFork 的行，不依赖首段 id）
 *   - 合并槽位的 parts 统一剥掉 step-start/step-finish 壳 part——纯协议执行
 *     痕迹无渲染价值，留着还会稀释折叠判定（壳不算可见过程）
 *   - 无组键的消息（老数据/异常/单 step 轮）原样保留
 */

import type { ZCodeMessage, TokenBreakdown } from '@/types/messages'

/** 读取消息的合并组键（null=不参与合并；anchor 优先，parent 键仅限 step 行）*/
function mergeKeyOf(msg: ZCodeMessage): string | null {
  const tid = msg.info.anchor?.turnId
  if (typeof tid === 'string' && tid) return 't:' + tid
  if (msg.info.role !== 'assistant') return null
  const hasStepMark = msg.parts.some((p) => p.type === 'step-start')
  if (!hasStepMark) return null
  const parent = msg.info.parentMessageId ?? msg.info.parentID
  return typeof parent === 'string' && parent ? 'p:' + parent : null
}

/** 剥掉协议执行痕迹 part（step-start/step-finish）：仅合并产物调用 */
function stripStepMarks(parts: ZCodeMessage['parts']): ZCodeMessage['parts'] {
  return parts.filter((p) => p.type !== 'step-start' && p.type !== 'step-finish')
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
  // 发生过并入的 out 槽位：出口统一剥壳（未合并的单 step 行保留原样）
  const mergedSlots = new Set<number>()
  for (const msg of messages) {
    const key = mergeKeyOf(msg)
    const last = out[out.length - 1]
    if (
      key &&
      last &&
      msg.info.role === 'assistant' &&
      last.info.role === 'assistant' &&
      mergeKeyOf(last) === key
    ) {
      out[out.length - 1] = mergeInto(last, msg)
      mergedSlots.add(out.length - 1)
    } else {
      out.push(msg)
    }
  }
  return out.map((m, i) => (mergedSlots.has(i) ? { ...m, parts: stripStepMarks(m.parts) } : m))
}
