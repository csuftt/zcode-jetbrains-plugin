/**
 * goal 运行中间歇闪屏复现/回归测试（0.3.2 真机反馈）
 *
 * 手法：MutationObserver 盯消息容器，跑 goal 多轮流式序列（流式批次 →
 * goalRefresh 增量合并 → 下一轮 → 再合并），统计消息根节点（.msg）的
 * remove/add。锁定：稳态消息 DOM 不被移除重挂（重挂=视觉闪烁）；只有
 * 新增内容产生 add。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

let messageHandler: ((msg: unknown) => void) | null = null
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { ChatView } from '@/components/ChatView'

// jsdom 无 IntersectionObserver（MessageAnchorRail 用）：桩掉，闪屏观察不关心轨道高亮
class IOStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
;(globalThis as Record<string, unknown>).IntersectionObserver = IOStub
;(globalThis as Record<string, unknown>).ResizeObserver = IOStub

const SID = 'sess_flash'

const hist = (n: number): never[] =>
  Array.from({ length: n }, (_, i) => ({
    info: { role: i % 2 ? 'assistant' : 'user', time: { created: 1000 + i }, id: `h${i}`, sessionID: SID, ...(i % 2 ? { modelID: 'GLM-5.3', tokens: { input: 10, output: 10 } } : {}) },
    parts: i % 2 ? [{ type: 'text', text: `回答 ${i} `.repeat(80) }] : [{ type: 'text', text: `问题 ${i}` }],
  })) as never[]

beforeEach(() => {
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    currentSessionId: SID,
    goal: { targetId: 't1', objective: '目标', status: 'active', tokensUsed: 1, timeUsedSeconds: 1, iterationCount: 1, syncedAt: Date.now() },
    streaming: false,
    streamingMessageId: null,
    messages: hist(8),
    queuedMessages: [],
    compacting: false,
  })
})
afterEach(cleanup)

/** 推一个流式批次（直通小 delta，不触发回放切片）*/
function streamBatch(events: unknown[]) {
  act(() => {
    streamBatchHandler?.(SID, events)
  })
}

describe('goal 运行闪屏回归', () => {
  it('流式批次 + goalRefresh 增量合并期间，已有消息 DOM 不被移除重挂', () => {
    const { container } = render(<ChatView messages={useStore.getState().messages} loading={false} waiting streamingMessageId={null} compacting={false} searchOpen={false} />)
    // 直接用订阅 store 的渲染方式（同 App）：每批重渲染由 store 订阅驱动
    cleanup()
    const sub = render(
      <StoreBoundChatView />,
    )
    const shell = sub.container.querySelector('.messages-shell') as HTMLElement
    expect(shell).not.toBeNull()
    const before = shell.querySelectorAll('.msg').length
    expect(before).toBeGreaterThanOrEqual(8)

    const removedMsgs: Element[] = []
    const addedMsgs: Element[] = []
    const obs = new MutationObserver((muts) => {
      for (const mu of muts) {
        mu.removedNodes.forEach((n) => {
          if ((n as Element).className && String((n as Element).className).includes('msg')) removedMsgs.push(n as Element)
        })
        mu.addedNodes.forEach((n) => {
          if ((n as Element).className && String((n as Element).className).includes('msg')) addedMsgs.push(n as Element)
        })
      }
    })
    obs.observe(shell, { childList: true, subtree: true })

    // 第 1 轮流式：turn.started + 50 个小批次
    streamBatch([{ type: 'turn.started', turnId: 'turn1', payload: { messageId: 'a_turn1' } }])
    for (let i = 0; i < 50; i++) {
      streamBatch([{ type: 'model.streaming', turnId: 'turn1', payload: { type: 'text_delta', messageId: 'a_turn1', delta: '内容增长'.repeat(3) } }])
    }
    // 轮边界：goalRefresh 增量合并（插上轮真身 + 校验分隔卡到流式消息前）
    act(() => {
      messageHandler?.({
        op: 'messages', sessionId: SID, goalRefresh: true,
        messages: [
          ...hist(8).map((m, i) => (i === 7 ? m : m)),
          {
            info: { role: 'user', time: { created: 2000 }, id: 'u_goal', sessionID: SID },
            parts: [{ type: 'text', text: '目标' }],
          },
          {
            info: { role: 'assistant', time: { created: 2001, completed: 2002 }, id: 'msg_part_t1', sessionID: SID, modelID: 'GLM-5.3', tokens: { input: 0, output: 0 } },
            parts: [{ type: 'timeline', timelineType: 'goal_verification', goalIteration: 1, verification: { passed: false, reason: '未达标', nextAction: '继续' } }],
          },
        ],
        goalTarget: { targetID: 't1', objective: '目标', status: 'active', tokensUsed: 100, timeUsedSeconds: 60, iterationCount: 2 },
      })
    })
    // 第 2 轮流式继续
    streamBatch([{ type: 'turn.started', turnId: 'turn2', payload: { messageId: 'a_turn2' } }])
    for (let i = 0; i < 50; i++) {
      streamBatch([{ type: 'model.streaming', turnId: 'turn2', payload: { type: 'text_delta', messageId: 'a_turn2', delta: '第二轮内容'.repeat(3) } }])
    }

    obs.disconnect()
    // 断言：已有消息不移除（重挂=闪屏）；新增只允许 goalRefresh 带来的 2 条
    expect(removedMsgs).toHaveLength(0)
    expect(addedMsgs.length).toBeLessThanOrEqual(2)
  })

  it('校验轮（verifying 窗口）turn.started 不建乐观空壳（防空气泡出现/消失闪烁）', () => {
    // run_finished 后 goal.verifying=true：服务端校验回合（~10s 零 delta）的
    // turn.started 只置流式标志，不建消息——建了就是空气泡+工作中 footer，
    // 校验完随落地消失（间歇闪屏，0.3.2 真机反馈）
    useStore.setState({
      goal: { targetId: 't1', objective: '目标', status: 'active', tokensUsed: 1, timeUsedSeconds: 1, iterationCount: 1, verifying: true, syncedAt: Date.now() } as never,
      streaming: false,
      streamingMessageId: null,
    })
    streamBatch([{ type: 'turn.started', turnId: 'verify_t1', payload: { messageId: 'verify_shell_id' } }])
    expect(useStore.getState().messages.find((m) => m.info.id === 'verify_shell_id')).toBeUndefined()
    expect(useStore.getState().streaming).toBe(true)

    // 下一工作轮（run_started 清 verifying）：turn.started 正常建流式消息
    useStore.setState({
      goal: { targetId: 't1', objective: '目标', status: 'active', tokensUsed: 1, timeUsedSeconds: 1, iterationCount: 2, syncedAt: Date.now() } as never,
    })
    streamBatch([{ type: 'turn.started', turnId: 'work_t2', payload: { messageId: 'work_msg_id' } }])
    expect(useStore.getState().messages.find((m) => m.info.id === 'work_msg_id')).not.toBeUndefined()
  })
})

/** 订阅 store 的 ChatView（同 App.tsx 的渲染方式）*/
function StoreBoundChatView() {
  const messages = useStore((s) => s.messages)
  const streamingMessageId = useStore((s) => s.streamingMessageId)
  const streaming = useStore((s) => s.streaming)
  return (
    <ChatView
      messages={messages}
      loading={false}
      waiting={streaming}
      streamingMessageId={streamingMessageId}
      compacting={false}
      searchOpen={false}
    />
  )
}
