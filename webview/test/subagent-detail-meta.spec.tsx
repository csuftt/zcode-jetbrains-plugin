/**
 * 子代理弹窗头部 meta 信息测试（2026-09-02 需求：执行时刻 + 模型，对齐主界面）
 *
 * 数据源（对齐主界面 msg__footer：time + model + ⏱）：
 *   - 开始时刻：三源 startedAt 之最先非空 → clockTime（当天 HH:mm，跨天带日期）
 *   - 模型：权威转录最后一条 assistant 的 info.modelID（实际执行模型）；
 *     运行中 live 归约不产此字段 → 回退内置子代理的模型覆盖（设置页写入的
 *     agents-state.json 条目）→ 再回退子代理定义的 model；定义缺省（跟随
 *     主会话）不猜当前值，宁缺勿错——结束后权威重拉自然补上
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('@/ipc/bridge', () => ({
  sendToJava: (req: unknown) => sendMock(req),
}))

import '@/i18n/config'
import { SubagentDetailDialog } from '@/components/SubagentDetailDialog'
import { SubagentReportDialog } from '@/components/SubagentReportDialog'
import { useStore } from '@/store/useStore'
import type { ZCodeMessage, ToolPart } from '@/types/messages'

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
  sendMock.mockClear()
  useStore.setState({
    subagentDetail: 'call_meta',
    agents: [],
    subagentActivities: [],
    subagents: [],
    subagentDefs: null,
    builtInSelections: {},
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

  it('运行中 live 无 modelID、定义未指定：回退内置子代理的模型覆盖（设置页写入的条目）', () => {
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'running', description: 'd', startedAt: Date.now() - 5_000, subagentType: 'general-purpose' }],
      childLiveMessages: { [CHILD_SID]: msgs() },
      subagentDefs: [],
      builtInSelections: { 'general-purpose': { providerId: 'p', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } } },
    })
    render(<SubagentDetailDialog />)
    expect(screen.getByText('GLM-5.3-Flash')).toBeTruthy()
  })

  it('转录里的实际模型优先于模型覆盖（覆盖事后被改，不改写已完成子代理的显示）', () => {
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', subagentType: 'general-purpose' }],
      childMessages: { [CHILD_SID]: msgs('GLM-5.2') },
      builtInSelections: { 'general-purpose': { providerId: 'p', modelId: 'GLM-5.3-Flash' } },
    })
    render(<SubagentDetailDialog />)
    expect(screen.getByText('GLM-5.2')).toBeTruthy()
    expect(screen.queryByText('GLM-5.3-Flash')).toBeNull()
  })

  it('打开弹窗即重拉子代理清单（内置覆盖只随这份清单下发）', () => {
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'running', description: 'd', startedAt: Date.now() - 5_000 }],
      childLiveMessages: { [CHILD_SID]: msgs() },
    })
    render(<SubagentDetailDialog />)
    expect(sendMock).toHaveBeenCalledWith({ op: 'listAgents' })
  })

  it('最终报告弹窗：转录未拉过时同样回退内置子代理的模型覆盖（两个窗口显示一致）', () => {
    useStore.setState({
      subagentReport: { callID: 'call_meta', title: '报告', markdown: '# done' },
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', subagentType: 'Explore' }],
      subagentDefs: [],
      builtInSelections: { Explore: { providerId: 'p', modelId: 'GLM-5.3-Flash' } },
    })
    render(<SubagentReportDialog />)
    expect(screen.getByText('GLM-5.3-Flash')).toBeTruthy()
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

  it('最终报告弹窗：头部显示时刻+模型+耗时（转录在场）', () => {
    const start = Date.now() - 60_000
    useStore.setState({
      subagentReport: { callID: 'call_meta', title: '报告', markdown: '# done' },
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', startedAt: start, endedAt: start + 30_000 }],
      childMessages: { [CHILD_SID]: msgs('GLM-5.3') },
    })
    render(<SubagentReportDialog />)
    expect(screen.getByText('GLM-5.3')).toBeTruthy()
    expect(screen.getByText(hhmm(start))).toBeTruthy()
    expect(screen.getByText(/秒$/)).toBeTruthy() // 耗时（formatToolDuration 产物，时刻是 HH:mm 不含"秒"）
  })

  it('最终报告弹窗：转录未拉过时模型回退子代理定义值', () => {
    useStore.setState({
      subagentReport: { callID: 'call_meta', title: '报告', markdown: '# done' },
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', subagentType: 'coder' }],
      childMessages: {},
      subagentDefs: [{ name: 'coder', description: '', tools: [], disallowedTools: [], injectAgentsMd: true, mcpServers: [], systemPrompt: '', model: 'GLM-5.2' }],
    })
    render(<SubagentReportDialog />)
    expect(screen.getByText('GLM-5.2')).toBeTruthy()
  })

  it('最终报告弹窗：转录缺失时自动静默补拉（底部栏直接开报告模型第一时间可显示）', async () => {
    useStore.setState({
      subagentReport: { callID: 'call_meta', title: '报告', markdown: '# done' },
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', startedAt: Date.now() - 30_000, endedAt: Date.now() }],
      childMessages: {},
    })
    render(<SubagentReportDialog />)
    // 已完成子会话的 resume 无害；silent 拉取补转录 → 模型随转录到达出现
    await vi.waitFor(() => {
      expect(sendMock.mock.calls.some((c) => (c[0] as { op: string }).op === 'subagentMessages')).toBe(true)
    })
  })
})

describe('子代理弹窗 meta：紧凑合并（防窄宽逐项折行）', () => {
  it('时刻+耗时合并一项：耗时走紧凑格式（无空格）', () => {
    const start = Date.now() - 264_000
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', startedAt: start, endedAt: start + 264_000 }],
      childMessages: { [CHILD_SID]: msgs('GLM-5.2') },
    })
    render(<SubagentDetailDialog />)
    expect(screen.getByText(hhmm(start))).toBeTruthy()
    expect(screen.getByText('4分24秒')).toBeTruthy()
    expect(screen.queryByText('4 分 24 秒')).toBeNull()
  })

  it('工具数为文字形态（{{count}} 个工具，图标版难理解已回退）', () => {
    const tool = (i: number): ToolPart => ({
      type: 'tool',
      callID: `call_tool_${i}`,
      tool: 'Read',
      state: { status: 'completed', input: {} },
    })
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', startedAt: Date.now() - 30_000, endedAt: Date.now() }],
      childMessages: { [CHILD_SID]: msgs('GLM-5.2') },
      subagentActivities: [{ key: 'call_meta', status: 'completed', tools: [tool(1), tool(2), tool(3)], lastUpdate: Date.now() }],
    })
    render(<SubagentDetailDialog />)
    expect(screen.getByText('3 个工具')).toBeTruthy()
  })

  it('重启/重开历史会话后流式聚合为空：工具数兜底数转录 tool parts', () => {
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', startedAt: Date.now() - 30_000, endedAt: Date.now() }],
      childMessages: { [CHILD_SID]: [
        ...msgs('GLM-5.2'),
        {
          info: { id: 'm3', sessionID: CHILD_SID, role: 'assistant', time: { created: 3 } },
          parts: [
            { type: 'tool', callID: 'c1', tool: 'Read', state: { status: 'completed', input: {} } } as ToolPart,
            { type: 'tool', callID: 'c2', tool: 'Edit', state: { status: 'completed', input: {} } } as ToolPart,
          ],
        },
      ] },
    })
    render(<SubagentDetailDialog />)
    expect(screen.getByText('2 个工具')).toBeTruthy()
  })

  it('模型挪行尾且带 title（窄宽截断后可悬停看全称）', () => {
    const start = Date.now() - 30_000
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', startedAt: start, endedAt: start + 30_000 }],
      childMessages: { [CHILD_SID]: msgs('GLM-5.2') },
    })
    render(<SubagentDetailDialog />)
    expect(screen.getByText('GLM-5.2').getAttribute('title')).toBe('GLM-5.2')
  })

  it('报告弹窗：时刻+耗时同样合并为紧凑格式', () => {
    const start = Date.now() - 264_000
    useStore.setState({
      subagentReport: { callID: 'call_meta', title: '报告', markdown: '# done' },
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', startedAt: start, endedAt: start + 264_000 }],
      childMessages: { [CHILD_SID]: msgs('GLM-5.3') },
    })
    render(<SubagentReportDialog />)
    expect(screen.getByText('4分24秒')).toBeTruthy()
  })

  it('布局分层：标题行=标题+类型徽标，状态徽标领起数据行（时刻·耗时合并其后）', () => {
    const start = Date.now() - 264_000
    useStore.setState({
      agents: [{ callID: 'call_meta', childSessionId: CHILD_SID, status: 'completed', description: 'd', subagentType: 'general-purpose', startedAt: start, endedAt: start + 264_000 }],
      childMessages: { [CHILD_SID]: [
        ...msgs('GLM-5.2'),
        {
          info: { id: 'm3', sessionID: CHILD_SID, role: 'assistant', time: { created: 3 } },
          parts: [{ type: 'tool', callID: 'c1', tool: 'Read', state: { status: 'completed', input: {} } } as ToolPart],
        },
      ] },
    })
    render(<SubagentDetailDialog />)
    const titlerow = document.querySelector('.subagent-detail-header__titlerow')
    expect(titlerow).toBeTruthy()
    expect(titlerow!.querySelector('.subagent-detail-badge.type')?.textContent).toBe('general-purpose')
    // 标题行只有类型徽标一种徽标（状态徽标下移数据行）
    expect(titlerow!.querySelectorAll('.subagent-detail-badge').length).toBe(1)
    const meta = document.querySelector('.subagent-detail-header__meta')
    // 状态徽标在数据行行首（第一子元素）
    expect((meta!.firstElementChild as HTMLElement).classList.contains('completed')).toBe(true)
    expect(meta!.textContent).toContain(hhmm(start))
    expect(meta!.textContent).toContain('4分24秒')
    expect(meta!.textContent).toContain('个工具')
  })
})
