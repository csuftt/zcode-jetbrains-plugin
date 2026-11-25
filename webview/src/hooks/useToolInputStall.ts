/**
 * 工具参数流停不下来的派生 hook（提示条渲染的唯一入口）
 *
 * 返回 null = 没有正在流式生成参数的工具调用，或者还不满 TOOL_INPUT_STALL_MS。
 * 计时由 useTick 每秒驱动；对 store 只订阅派生出的那一个小对象（useShallow：参数流期间
 * messages 每个 delta 批次都换引用，直接订阅会每批重渲染）。
 */

import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/store/useStore'
import { useTick } from '@/hooks/useTick'
import { TOOL_INPUT_STALL_MS, findStreamingToolInput } from '@/utils/toolInputStall'

export interface ToolInputStall {
  tool: string
  /** 参数流已持续的整秒数 */
  seconds: number
}

export function useToolInputStall(): ToolInputStall | null {
  const cur = useStore(
    useShallow((s) => (s.streaming ? findStreamingToolInput(s.messages, s.streamingMessageId) : null)),
  )
  const now = useTick(cur !== null)
  if (!cur) return null
  const elapsedMs = now - cur.startedAt
  if (elapsedMs < TOOL_INPUT_STALL_MS) return null
  return { tool: cur.tool, seconds: Math.floor(elapsedMs / 1000) }
}
