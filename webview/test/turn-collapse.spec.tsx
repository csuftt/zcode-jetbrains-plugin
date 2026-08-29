/**
 * 完成轮折叠回归测试（MessageBubble AssistantBubble + TurnProcessBar，2026-08-29）
 *
 * 行为（对齐官方客户端）：
 *   - 非流式的完整轮默认折叠：只渲染最终结论（最后一个 text part），执行过程不进 DOM
 *   - 折叠栏在结论上方（用户消息之后）：「执行过程 · 思考 N 次 · N 个工具 · 耗时」概览条，
 *     点击展开/收起；展开后折叠栏仍在顶部，随时可收起
 *   - searchActive（搜索面板打开）→ 强制展开，保 TreeWalker 扫到/定位到过程文本
 *   - 不折叠情形：流式中 / 无 text 结论（纯工具轮）/ 结论后有可见 part（被停止回合以 tool 收尾）
 *   - step-start/step-finish 边界标记不构成过程内容
 *
 * 工具卡过程存在性以 .tool-card DOM 计数判定（ToolCallCard 渲染的是
 * 工具名+摘要，不透出 state.title 原文，文本断言会误伤）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
}))

import '@/i18n/config'
import { MessageBubble } from '@/components/MessageBubble'
import type { ZCodeMessage, MessagePart, ToolPart } from '@/types/messages'

function toolPart(callID: string, tool = 'Read'): ToolPart {
  return {
    type: 'tool',
    callID,
    tool,
    state: {
      status: 'completed',
      title: `工具卡片${callID}`,
      input: { filePath: `f-${callID}.ts` },
      output: `工具输出内容${callID}`,
    },
  }
}

function assistantMsg(parts: MessagePart[], completed = true): ZCodeMessage {
  const created = 1787283860314
  return {
    info: {
      id: 'm_a1',
      sessionID: 's1',
      role: 'assistant',
      // 流式中的真实消息无 completed（turn 未结束）
      time: completed ? { created, completed: created + 633_000 } : { created },
    },
    parts,
  }
}

const CONCLUSION = '最终结论：任务已完成'
const MID_TEXT = '中间过程解说文本'

function processBar(): HTMLElement {
  return document.querySelector('.msg__process-bar') as HTMLElement
}

describe('完成轮折叠', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = () => {}
  })
  afterEach(cleanup)

  /** 当前渲染树里的工具卡数量（0 = 过程未进 DOM）*/
  function toolCardCount(): number {
    return document.querySelectorAll('.msg--assistant .tool-card').length
  }

  it('完成轮默认折叠：折叠栏在结论上方，概览含工具数与耗时', () => {
    render(<MessageBubble message={assistantMsg([toolPart('t1'), { type: 'text', text: CONCLUSION }])} />)
    const bar = processBar()
    expect(bar).toBeTruthy()
    // 折叠态 chevron-right
    expect(bar.querySelector('.codicon-chevron-right')).toBeTruthy()
    // 概览：1 个工具 + 10 分 33 秒（completed - created）
    expect(bar.textContent).toContain('1 个工具')
    expect(bar.textContent).toContain('10')
    // 折叠栏在结论文本之前（用户消息后 → 结论前，官方位置）
    expect(document.querySelector('.msg__content')!.textContent!.indexOf('执行过程'))
      .toBeLessThan(document.querySelector('.msg__content')!.textContent!.indexOf(CONCLUSION))
    expect(screen.getByText(CONCLUSION)).toBeTruthy()
    expect(toolCardCount()).toBe(0)
  })

  it('点击折叠栏展开过程，再点收起；展开后折叠栏仍在顶部', () => {
    render(<MessageBubble message={assistantMsg([toolPart('t1'), { type: 'text', text: CONCLUSION }])} />)
    fireEvent.click(processBar())
    expect(toolCardCount()).toBeGreaterThan(0)
    // 展开态 chevron-down + 折叠栏仍存在（顶部收起入口）
    expect(processBar().querySelector('.codicon-chevron-down')).toBeTruthy()
    fireEvent.click(processBar())
    expect(toolCardCount()).toBe(0)
    // 结论始终在 DOM
    expect(screen.getByText(CONCLUSION)).toBeTruthy()
  })

  it('概览计数：思考与工具分别统计', () => {
    render(<MessageBubble message={assistantMsg([
      { type: 'reasoning', text: '想一想' },
      toolPart('t1'),
      toolPart('t2', 'Bash'),
      { type: 'text', text: CONCLUSION },
    ])} />)
    const bar = processBar()
    expect(bar.textContent).toContain('思考 1 次')
    expect(bar.textContent).toContain('2 个工具')
  })

  it('searchActive 强制展开：过程进 DOM，保搜索 TreeWalker 可扫', () => {
    render(<MessageBubble message={assistantMsg([toolPart('t1'), { type: 'text', text: CONCLUSION }])} searchActive />)
    expect(toolCardCount()).toBeGreaterThan(0)
    expect(screen.getByText(CONCLUSION)).toBeTruthy()
  })

  it('流式消息不折叠：无折叠栏、全渲染（显示工作中）', () => {
    render(<MessageBubble message={assistantMsg([toolPart('t1'), { type: 'text', text: CONCLUSION }], false)} streaming />)
    expect(processBar()).toBeNull()
    expect(toolCardCount()).toBeGreaterThan(0)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(/工作中/)).toBeTruthy()
  })

  it('纯工具无结论（text 缺失）：不折叠、无折叠栏', () => {
    render(<MessageBubble message={assistantMsg([toolPart('t1')])} />)
    expect(toolCardCount()).toBeGreaterThan(0)
    expect(processBar()).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('被停止的回合以 tool 收尾（结论后有可见 part）：不折叠', () => {
    render(<MessageBubble message={assistantMsg([{ type: 'text', text: CONCLUSION }, toolPart('t1')])} />)
    expect(toolCardCount()).toBeGreaterThan(0)
    expect(screen.getByText(CONCLUSION)).toBeTruthy()
    expect(processBar()).toBeNull()
  })

  it('step 边界标记不构成过程内容：标记夹结论 = 无过程可折叠', () => {
    render(<MessageBubble message={assistantMsg([
      { type: 'step-start' },
      { type: 'text', text: CONCLUSION },
      { type: 'step-finish', reason: 'stop', cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0 } },
    ])} />)
    expect(screen.getByText(CONCLUSION)).toBeTruthy()
    expect(processBar()).toBeNull()
  })

  it('多段过程折叠后只留最后结论：中间 text 不进 DOM，展开后全部可见', () => {
    render(<MessageBubble message={assistantMsg([
      { type: 'step-start' },
      toolPart('t1'),
      { type: 'text', text: MID_TEXT },
      { type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0 } },
      toolPart('t2', 'Bash'),
      { type: 'text', text: CONCLUSION },
    ])} />)
    expect(screen.getByText(CONCLUSION)).toBeTruthy()
    expect(screen.queryByText(MID_TEXT)).toBeNull()
    expect(toolCardCount()).toBe(0)
    fireEvent.click(processBar())
    expect(screen.getByText(MID_TEXT)).toBeTruthy()
    expect(toolCardCount()).toBe(2)
  })
})
