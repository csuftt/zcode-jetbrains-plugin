/**
 * 孤儿 running 子代理纠偏回归测试（重开恒「运行中」，2026-09-30）
 *
 * 复现缺陷（diag-subagent-ghost-running.py / diag-subagent-ghost-part-status.py
 * 真机会话实测）：子代理运行中重启 IDEA → app-server 被连带杀死，服务端只给
 * turnHeader 写 completedInterrupted 终态，回合内 Agent 工具 part 在转录里永远
 * 停在 running（无 output、time.end 缺失）。session/subagents 只枚举子代理会话，
 * 孤儿 part 没有可匹配的权威条目（实测 RPC running=0 / ended=6 全 success vs
 * 转录遗留 11 个 running part）→ 重开会话 parseAgents 解析出 running，子代理卡/
 * 底部栏恒转圈。
 *
 * 断言：
 *   1. 非流式历史落地（重开已停会话）：Agent part running/pending → interrupted，
 *      completed 不动，非子代理工具（Bash）的 running 不动
 *   2. agents 账本同步（parseAgents 消费纠偏后消息），底部栏不再显示运行中
 *   3. RPC 权威条目（success → completed）覆盖链路不受影响，孤儿无条目保持 interrupted
 *   4. streaming 中（重开运行中会话的首拉在途，EA 相位投影先置位）：running 是
 *      真实的，不纠偏
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock 桥接层：捕获 sendToJava，手动注入事件/响应 ----
let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
let messageHandler: ((msg: unknown) => void) | null = null
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import { useStore, stopSubagentStatusPolling } from '@/store/useStore'
import type { ZCodeMessage, ToolPart } from '@/types/messages'

const SID = 'sess_ghost_subagent'

/** 构造 Agent/Task 工具 part（孤儿 running：无 output、time.end 缺失）*/
function agentPart(callID: string, status: ToolPart['state']['status']): ToolPart {
  return {
    type: 'tool',
    callID,
    tool: 'Agent',
    state: {
      status,
      input: { description: `分析${callID}族记忆`, prompt: 'read files' },
      ...(status === 'completed'
        ? { output: '# 报告', time: { start: 1, end: 2 } }
        : { time: { start: 1 } }),
    },
  }
}

function bashPart(callID: string, status: ToolPart['state']['status']): ToolPart {
  return { type: 'tool', callID, tool: 'Bash', state: { status, input: { command: 'echo hi' }, time: { start: 1 } } }
}

/** 一条 assistant 消息携带三个子代理 part + 一个 Bash part（中断回合的真实形态）*/
function historyMessages(): ZCodeMessage[] {
  return [
    {
      info: { id: 'm_u1', sessionID: SID, role: 'user', time: { created: 1 } },
      parts: [{ type: 'text', text: '帮我规整记忆文件' }],
    },
    {
      info: { id: 'm_a1', sessionID: SID, role: 'assistant', time: { created: 2 } },
      parts: [
        agentPart('call_ghost_1', 'running'),
        agentPart('call_ghost_2', 'pending'),
        agentPart('call_done_1', 'completed'),
        bashPart('call_bash_1', 'running'),
      ],
    },
  ]
}

beforeEach(() => {
  vi.useFakeTimers()
  stopSubagentStatusPolling()
  sentRequests.length = 0
  useStore.getState().init()
  sentRequests.length = 0
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: SID,
    currentWorkspacePath: 'G:\\mock',
    messages: [],
    streaming: false,
    loadingMessages: true, // 打开会话的首拉在途
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    subagentActivities: [],
    subagents: [],
    childSessionKeys: {},
    sessions: [{ sessionId: SID, title: 'ghost-subagent', status: 'idle', mode: 'yolo', workspacePath: 'G:\\mock', workspaceKey: 'G:\\mock', createdAt: 1, updatedAt: 1 }],
    provisionalTitles: {},
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin' },
  })
})

describe('孤儿 running 子代理纠偏（非流式历史落地）', () => {
  it('重开已停会话：Agent running/pending → interrupted；completed/Bash 不动', () => {
    messageHandler!({ op: 'messages', sessionId: SID, messages: historyMessages() })

    const st = useStore.getState()
    const parts = st.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool')) as ToolPart[]
    const byCall = new Map(parts.map((p) => [p.callID, p]))
    expect(byCall.get('call_ghost_1')?.state.status).toBe('interrupted')
    expect(byCall.get('call_ghost_2')?.state.status).toBe('interrupted')
    expect(byCall.get('call_done_1')?.state.status).toBe('completed')
    expect(byCall.get('call_bash_1')?.state.status).toBe('running')
  })

  it('agents 账本同步纠偏（底部栏/卡片 subStatus 源头不再恒 running）', () => {
    messageHandler!({ op: 'messages', sessionId: SID, messages: historyMessages() })

    const agents = useStore.getState().agents
    expect(agents.find((a) => a.callID === 'call_ghost_1')?.status).toBe('interrupted')
    expect(agents.find((a) => a.callID === 'call_ghost_2')?.status).toBe('interrupted')
    expect(agents.find((a) => a.callID === 'call_done_1')?.status).toBe('completed')
    expect(agents.some((a) => a.status === 'running')).toBe(false)
  })

  it('RPC 权威条目覆盖链路不受影响：success → completed，孤儿无条目保持 interrupted', () => {
    messageHandler!({ op: 'messages', sessionId: SID, messages: historyMessages() })
    // session/subagents 权威列表：只收录真实完成的子代理会话（孤儿不在其中）
    messageHandler!({
      op: 'subagents',
      sessionId: SID,
      data: {
        revision: 1,
        childSessionIds: ['sess_subagent_agent_done'],
        running: [],
        ended: {
          total: 1,
          items: [{
            toolCallId: 'call_done_1',
            childSessionId: 'sess_subagent_agent_done',
            status: 'success',
            title: '分析done族记忆',
            summary: '全部文件读完',
          }],
        },
      },
    })

    const agents = useStore.getState().agents
    expect(agents.find((a) => a.callID === 'call_done_1')?.status).toBe('completed')
    expect(agents.find((a) => a.callID === 'call_done_1')?.childSessionId).toBe('sess_subagent_agent_done')
    expect(agents.find((a) => a.callID === 'call_ghost_1')?.status).toBe('interrupted')
    expect(agents.find((a) => a.callID === 'call_ghost_2')?.status).toBe('interrupted')
  })
})

describe('streaming 中不纠偏（重开运行中会话的首拉在途）', () => {
  it('EA 相位投影先置位 streaming：running 是真实的，落地后保持 running', () => {
    useStore.setState({ streaming: true, loadingMessages: true })
    messageHandler!({ op: 'messages', sessionId: SID, messages: historyMessages() })

    const st = useStore.getState()
    const parts = st.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool')) as ToolPart[]
    expect(parts.find((p) => p.callID === 'call_ghost_1')?.state.status).toBe('running')
    expect(st.agents.find((a) => a.callID === 'call_ghost_1')?.status).toBe('running')
  })
})
