/**
 * goal 记账/校验轮空壳消息修复测试（0.3.2 真机反馈）
 *
 * 背景（sqlite + 日志定性）：goal set 后服务端自动开 controlOnly 记账轮（assistant
 * 仅 1 个 model_change timeline part、tokens 全 0）与校验轮（goal_verification
 * timeline part）；turn.started 建立的乐观流式 assistant（parts=[]）与落库真身
 * 同 id。goalRefresh 增量合并按 id 一律滤掉真身 → 乐观空壳顶位残留，渲染成
 * "已工作 0 秒 / GLM-5.3 / 0 in 0 out" 的 footer 气泡。
 *
 * 锁定两层修复：
 * 1. mergeGoalRefreshSnapshot：同 id 的本地空壳（assistant + parts 空）被 incoming
 *    真身替换（带 timeline part 走分隔卡渲染）；非空同 id 消息仍滤掉（原语义）
 * 2. MessageBubble 渲染兜底：非流式空 parts 的 assistant 不渲染；流式中保留
 *    （"思考中"占位）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore } from '@/store/useStore'
import { MessageBubble } from '@/components/MessageBubble'

const SID = 'sess_g'

beforeEach(() => {
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    currentSessionId: SID,
    goal: null,
    streaming: false,
    streamingMessageId: null,
    messages: [],
    queuedMessages: [],
  })
})
afterEach(cleanup)

/** turn.started 乐观空壳（goal 记账/校验轮形态）：id 与落库真身相同 */
const optimisticShell = (id: string): never => ({
  info: { role: 'assistant', time: { created: 1788485922734 }, id, sessionID: SID },
  parts: [],
}) as never

/** 落库真身：纯 timeline part 的 assistant（model_change marker 形态） */
const timelineReal = (id: string): never => ({
  info: {
    role: 'assistant', time: { created: 1788485922734, completed: 1788485922734 },
    id, sessionID: SID, modelID: 'GLM-5.3',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [{
    type: 'timeline',
    timelineType: 'model_change',
    fromModel: { modelId: 'GLM-5.2' },
    toModel: { modelId: 'GLM-5.3' },
  }],
}) as never

describe('goal 空壳消息修复', () => {
  it('goalRefresh 增量合并：同 id 空壳被真身替换（不再滤掉顶位残留）', () => {
    useStore.setState({
      streaming: true,
      streamingMessageId: 'm_work',
      messages: [
        { info: { role: 'user', id: 'u1', time: { created: 1 } }, parts: [{ type: 'text', text: '目标' }] } as never,
        optimisticShell('msg_part_x'),
        { info: { role: 'assistant', id: 'm_work', time: { created: 2 } }, parts: [{ type: 'text', text: '干活' }] } as never,
      ],
    })
    messageHandler?.({
      op: 'messages',
      sessionId: SID,
      goalRefresh: true,
      messages: [
        { info: { role: 'user', id: 'u1', time: { created: 1 } }, parts: [{ type: 'text', text: '目标' }] },
        timelineReal('msg_part_x'),
        { info: { role: 'assistant', id: 'm_work', time: { created: 2 } }, parts: [{ type: 'text', text: '干活' }] },
      ],
      goalTarget: { targetID: 't1', objective: '目标', status: 'active', tokensUsed: 1, timeUsedSeconds: 1 },
    })
    const msgs = useStore.getState().messages
    // 空壳（parts 空）消失，真身（带 timeline part）接管同 id 位置
    const hit = msgs.find((m) => m.info.id === 'msg_part_x')
    expect(hit?.parts.some((p) => p.type === 'timeline')).toBe(true)
    expect(msgs.filter((m) => m.info.id === 'msg_part_x')).toHaveLength(1)
  })

  it('非空同 id 消息仍被滤掉（原去重语义不变）', () => {
    useStore.setState({
      streaming: true,
      streamingMessageId: 'm_work',
      messages: [
        { info: { role: 'assistant', id: 'a1', time: { created: 1 } }, parts: [{ type: 'text', text: '已有内容' }] } as never,
      ],
    })
    messageHandler?.({
      op: 'messages',
      sessionId: SID,
      goalRefresh: true,
      messages: [
        { info: { role: 'assistant', id: 'a1', time: { created: 1 }, tokens: { input: 1, output: 1 } }, parts: [{ type: 'text', text: '服务端版' }] },
      ],
    })
    const msgs = useStore.getState().messages
    expect(msgs.filter((m) => m.info.id === 'a1')).toHaveLength(1)
    // 本地版被滤（incoming 不覆盖），无替换发生
    expect(msgs[0].parts[0].type === 'text').toBe(true)
  })

  it('渲染兜底：非流式空 parts assistant 不渲染（无 footer 空壳）', () => {
    const { container } = render(
      <MessageBubble message={optimisticShell('shell_1')} />,
    )
    expect(container.childElementCount).toBe(0)
  })

  it('渲染兜底：流式中的空 assistant 保留（思考中占位）', () => {
    const { container } = render(
      <MessageBubble message={optimisticShell('shell_2')} streaming />,
    )
    expect(container.childElementCount).toBeGreaterThan(0)
  })

  it('渲染兜底：纯 timeline 真身走分隔卡（不受空壳判据影响）', () => {
    const { container } = render(
      <MessageBubble message={timelineReal('msg_part_y')} />,
    )
    expect(container.querySelector('.tl-sep')).not.toBeNull()
    expect(container.querySelector('.msg__footer')).toBeNull()
  })
})
