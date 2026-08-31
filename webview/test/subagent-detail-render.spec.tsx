/**
 * 子代理详情弹窗渲染管线对齐主界面回归测试（2026-08-31 方案 B）
 *
 * 改造：弹窗内容区复用主聊天共享渲染管线（PartUnits.renderPartUnits）——
 * 此前弹窗的 UnitRenderer 只认 tool/toolGroup，reasoning 与图片 part 直接丢渲染
 * （子代理思考过程在弹窗里不可见）。
 *
 * 断言：
 *   1. reasoning part → ThinkingBlock 可折叠思考（有思考文案与耗时行）
 *   2. 连续 Bash → BashCommandGroupCard 组卡；连续 Read → FileToolGroupCard 组卡
 *      （聚组双路径：组卡与单卡都在弹窗内渲染）
 *   3. 完成轮不折叠（弹窗保持完整过程展开：末条 assistant 报告折叠为入口行是
 *      既有产品行为，过程部分不折叠）
 *   4. text 正文 MarkdownBlock 正常渲染
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
}))

import '@/i18n/config'
import { SubagentDetailDialog } from '@/components/SubagentDetailDialog'
import { useStore } from '@/store/useStore'
import type { ZCodeMessage } from '@/types/messages'

const CHILD_SID = 'sess_subagent_agent_test'

const RUNNING_MSGS: ZCodeMessage[] = [
  {
    info: { id: 'm1', sessionID: CHILD_SID, role: 'user', time: { created: 1788148526000 } },
    parts: [{ type: 'text', text: '读取 sample.txt 并转告' }],
  },
  {
    info: { id: 'm2', sessionID: CHILD_SID, role: 'assistant', time: { created: 1788148526100 } },
    parts: [
      { type: 'reasoning', text: '需要先读文件再总结', time: { start: 1788148526100, end: 1788148526900 } },
      { type: 'tool', callID: 'c1', tool: 'Bash', state: { status: 'completed', output: 'ok1', time: { start: 1, end: 2 } } },
      { type: 'tool', callID: 'c2', tool: 'Bash', state: { status: 'completed', output: 'ok2', time: { start: 1, end: 2 } } },
      { type: 'tool', callID: 'c3', tool: 'Read', state: { status: 'completed', output: '内容', time: { start: 1, end: 2 } } },
      { type: 'tool', callID: 'c4', tool: 'Read', state: { status: 'completed', output: '内容2', time: { start: 1, end: 2 } } },
      { type: 'text', text: '文件内容是 **hello**' },
    ],
  },
]

beforeEach(() => {
  useStore.setState({
    subagentDetail: 'call_x1',
    agents: [{ callID: 'call_x1', childSessionId: CHILD_SID, status: 'running', description: '测试任务' }],
    subagentActivities: [],
    subagents: [],
    childMessages: {},
    childLiveMessages: { [CHILD_SID]: RUNNING_MSGS },
    childMessagesLoading: false,
    childMessagesError: null,
    messages: [],
  })
})
afterEach(() => cleanup())

describe('子代理弹窗渲染对齐主界面', () => {
  it('reasoning part 渲染为可折叠思考块（此前直接丢失），点击展开可见正文', () => {
    const { container } = render(<SubagentDetailDialog />)
    const block = container.querySelector('.thinking-block')
    expect(block).toBeTruthy()
    // 默认折叠（正文后有 text，自动收起）：body 不进 DOM
    expect(container.querySelector('.thinking-block__body')).toBeNull()
    fireEvent.click(block!.querySelector('.thinking-block__header')!)
    expect(screen.getByText(/需要先读文件再总结/)).toBeTruthy()
  })

  it('连续同类工具合并组卡（bash 组 + read 组）', () => {
    const { container } = render(<SubagentDetailDialog />)
    expect(container.querySelectorAll('.bash-group').length).toBe(1)
    expect(container.querySelectorAll('.file-group').length).toBe(1)
    // 无散装单卡（聚组双路径：全部走组卡）
    expect(container.querySelectorAll('.tool-card').length).toBe(0)
  })

  it('text 正文走 Markdown 渲染（strong 生效）', () => {
    const { container } = render(<SubagentDetailDialog />)
    expect(container.querySelector('.markdown-body strong')).toBeTruthy()
  })

  it('运行中不折叠过程：思考块与工具组卡同时在场', () => {
    const { container } = render(<SubagentDetailDialog />)
    expect(container.querySelectorAll('.thinking-block').length).toBe(1)
    expect(container.querySelectorAll('.bash-group').length).toBe(1)
    // 正文在场（Markdown strong 渲染成功）
    expect(container.querySelector('.markdown-body strong')?.textContent).toBe('hello')
  })
})
