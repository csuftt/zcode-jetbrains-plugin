/**
 * 子代理弹窗头部 meta 信息测试（2026-09-02 需求：执行时刻 + 模型，对齐主界面）
 *
 * 数据源（对齐主界面 msg__footer：time + model + ⏱）：
 *   - 开始时刻：三源 startedAt 之最先非空 → clockTime（当天 HH:mm，跨天带日期）
 *   - 模型：权威转录最后一条 assistant 的 info.modelID（实际执行模型）；
 *     运行中 live 归约不产此字段 → 回退子代理定义的 model；定义缺省（跟随
 *     主会话）不猜当前值，宁缺勿错——结束后权威重拉自然补上
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
}))

import '@/i18n/config'
import { SubagentDetailDialog } from '@/components/SubagentDetailDialog'
import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

const CHILD_SID = 'sess_subagent_agent_meta1'

function msgs(modelID?: string): ZCodeMessage[] {
  return [
    {
      info: { id: 'm1', sessionID: CHILD_SID, role: 'user', time: { created: 1 } },
      parts: [{ type: 'text', text: '任务描述' }],
    },
    {
      info: { id: 'm2', sessionID: CHILD_SID, role: 'assistant', time: { created: 2 }, ...(modelID ? { modelID } : {}) },
      parts: [{ type: 'text', text: '结论' }],
    },
  ]
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

beforeEach(() => {
  useStore.setState({
    subagentDetail: 'call_meta',
    agents: [],
    subagentActivities: [],
    subagents: [],
    subagentDefs: null,
    childMessages: {},
    childLiveMessages: {},
    childMessagesLoading: false,
    childMessagesError: null,
    messages: [],
  })
})
afterEach(() => cleanup())

describe('子代理弹窗 meta：执行时刻与模型', () => {
  it('结束后：权威转录的 modelID + startedAt 时刻显示在头部', () => {
    const start = Date.now() - 60_000
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', startedAt: start, endedAt: start + 30_000 }],
      childMessages: { [CHILD_SID]: msgs('GLM-5.2') },
    })
    render(<SubagentDetailDialog />)
    expect(screen.getByText('GLM-5.2')).toBeTruthy()
    expect(screen.getByText(hhmm(start))).toBeTruthy()
  })

  it('多 turn 转录取末条 assistant 的模型（最后回合实际值）', () => {
    const start = Date.now() - 60_000
    const multi = [...msgs('GLM-5.2'), {
      info: { id: 'm3', sessionID: CHILD_SID, role: 'assistant', time: { created: 3 }, modelID: 'GLM-5.3' },
      parts: [{ type: 'text', text: '续轮结论' }],
    }]
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', startedAt: start, endedAt: start + 30_000 }],
      childMessages: { [CHILD_SID]: multi },
    })
    render(<SubagentDetailDialog />)
    expect(screen.getByText('GLM-5.3')).toBeTruthy()
  })

  it('运行中 live 无 modelID：回退子代理定义的 model', () => {
    const start = Date.now() - 5_000
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'running', description: 'd', startedAt: start, subagentType: 'coder' }],
      childLiveMessages: { [CHILD_SID]: msgs() },
      subagentDefs: [{ name: 'coder', description: '', tools: [], disallowedTools: [], injectAgentsMd: true, mcpServers: [], systemPrompt: '', model: 'GLM-5.3' }],
    })
    render(<SubagentDetailDialog />)
    expect(screen.getByText('GLM-5.3')).toBeTruthy()
    expect(screen.getByText(hhmm(start))).toBeTruthy()
  })

  it('运行中 live 无 modelID 且定义未指定模型：不显示模型（宁缺勿错）', () => {
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'running', description: 'd', startedAt: Date.now() - 5_000 }],
      childLiveMessages: { [CHILD_SID]: msgs() },
      subagentDefs: [{ name: 'explore', description: '', tools: [], disallowedTools: [], injectAgentsMd: true, mcpServers: [], systemPrompt: '' }],
    })
    render(<SubagentDetailDialog />)
    expect(screen.queryByText(/GLM/)).toBeNull()
  })

  it('无 startedAt 数据源：时刻不显示（与耗时同现同隐）', () => {
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd' }],
      childMessages: { [CHILD_SID]: msgs('GLM-5.2') },
    })
    render(<SubagentDetailDialog />)
    expect(screen.getByText('GLM-5.2')).toBeTruthy()
    // 无时刻无耗时：meta 区只有模型（无 HH:MM 形态项）
    expect(screen.queryByText(/^\d{2}:\d{2}$/)).toBeNull()
  })
})
