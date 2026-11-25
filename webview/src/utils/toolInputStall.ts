/**
 * 工具参数流「停不下来」的判定
 *
 * 模型生成工具参数（model.streaming 的 tool_input_* 流）偶尔会陷入循环：推理和正文都正常
 * 结束，参数却一直往外吐、tool_call 永远不来——CLI 发不出工具调用，界面上只是转圈
 * （2026-11-25 GLM-5.3-Flash 实测四次：54~306 秒、8253~34389 段 delta；同日 209 个正常请求
 * 参数流最多 3286 段、整次最长 120 秒且含推理）。这里只认时间：同一个工具调用的参数连续
 * 生成满 TOOL_INPUT_STALL_MS 就提示，停不停由用户决定，不自动停止。
 */
import type { ZCodeMessage } from '@/types/messages'

export const TOOL_INPUT_STALL_MS = 60_000

export interface StreamingToolInput {
  callID: string
  /** 卡片上显示的工具名 */
  tool: string
  /** 参数流起点：tool_input_start 的到达时刻（tool_call 到达后才被服务端 startedAt 覆盖） */
  startedAt: number
}

/**
 * 正在流式生成参数的那个工具调用（inputRaw 还在累积的工具 part；同一时刻只会有一个）。
 * 没有则 null；part 没有起点时间就无从计时，同样返回 null（宁可不提示）。
 */
export function findStreamingToolInput(
  messages: ZCodeMessage[],
  streamingMessageId: string | null,
): StreamingToolInput | null {
  if (!streamingMessageId) return null
  const msg = messages.find((m) => m.info.id === streamingMessageId)
  if (!msg) return null
  for (let i = msg.parts.length - 1; i >= 0; i--) {
    const part = msg.parts[i]
    if (part.type !== 'tool' || part.state.inputRaw === undefined) continue
    const startedAt = part.state.time?.start
    if (typeof startedAt !== 'number') return null
    return { callID: part.callID, tool: part.state.title || part.tool, startedAt }
  }
  return null
}
