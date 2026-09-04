/**
 * TodoWrite 任务列表工具卡友好渲染：
 *   - 头部进度徽标（已完成/总数）+ 增量摘要（+新增 ~变更 −删除），收起即可感知
 *   - 展开区：全量列表 + 每项增量标注（新增/状态迁移），已移除任务单列一节
 *   - 上次快照按 callID 在主消息流回溯；子代理场景（不在主流）无标注安全降级
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  openExternalUrl: () => {},
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { ToolCallCard } from '@/components/ToolCallCard'
import type { ToolPart, ZCodeMessage } from '@/types/messages'

function todoPart(callID: string, todos: Array<{ content: string; status: string }>): ToolPart {
  return { type: 'tool', callID, tool: 'TodoWrite', state: { status: 'completed', input: { todos } } }
}

function assistantMsg(id: string, parts: unknown[]): ZCodeMessage {
  return { info: { role: 'assistant', time: { created: 1 }, id, sessionID: 's' }, parts: parts as never }
}

function expandCard(container: HTMLElement): void {
  fireEvent.click(container.querySelector('.tool-card__header')!)
}

beforeEach(() => {
  useStore.setState({ messages: [], backgroundTasks: {} })
})

afterEach(() => cleanup())

describe('ToolCallCard TodoWrite 友好渲染', () => {
  it('首次调用（无上次快照）：进度徽标可见、列表无增量标注', () => {
    useStore.setState({
      messages: [assistantMsg('m1', [todoPart('c1', [
        { content: '调研协议', status: 'completed' },
        { content: '实现渲染', status: 'in_progress' },
        { content: '写测试', status: 'pending' },
      ])])],
    })
    const { container } = render(<ToolCallCard part={todoPart('c1', [
      { content: '调研协议', status: 'completed' },
      { content: '实现渲染', status: 'in_progress' },
      { content: '写测试', status: 'pending' },
    ])} />)
    expect(screen.getByText('1/3')).toBeTruthy()
    // 无变更摘要（首次列表本来就是新的）
    expect(container.querySelector('.tool-card__todo-delta')).toBeNull()

    expandCard(container)
    expect(screen.getByText('调研协议')).toBeTruthy()
    expect(screen.getByText('实现渲染')).toBeTruthy()
    expect(screen.queryByText('新增')).toBeNull()
    expect(container.querySelector('.todo-removed')).toBeNull()
  })

  it('第二次调用：增量摘要 + 展开区标注（新增/状态迁移/已移除）', () => {
    const prev = [
      { content: '调研协议', status: 'pending' },
      { content: '实现渲染', status: 'in_progress' },
      { content: '部署上线', status: 'pending' },
    ]
    const next = [
      { content: '调研协议', status: 'completed' },
      { content: '实现渲染', status: 'completed' },
      { content: '写测试', status: 'pending' },
      // 部署上线 被删除
    ]
    useStore.setState({
      messages: [assistantMsg('m1', [todoPart('c1', prev)]), assistantMsg('m2', [todoPart('c2', next)])],
    })
    const { container } = render(<ToolCallCard part={todoPart('c2', next)} />)

    // 头部：进度 2/3 + 增量摘要（+1 新增、~2 状态变更、−1 删除）
    expect(screen.getByText('2/3')).toBeTruthy()
    expect(container.querySelector('.todo-delta__add')?.textContent).toBe('+1')
    expect(container.querySelector('.todo-delta__chg')?.textContent).toBe('~2')
    expect(container.querySelector('.todo-delta__del')?.textContent).toBe('−1')

    expandCard(container)
    // 新增项标签
    expect(screen.getByText('新增')).toBeTruthy()
    // 状态迁移标签（调研协议：待办 → 已完成）
    expect(screen.getByText('待办 → 已完成')).toBeTruthy()
    // 已移除区：标题 + 删除线任务
    expect(screen.getByText('已移除 1 项')).toBeTruthy()
    expect(screen.getByText('部署上线')).toBeTruthy()
    expect(container.querySelectorAll('.todo-item--removed')).toHaveLength(1)
  })

  it('callID 不在主消息流（子代理弹窗 parts）：安全降级为纯列表（无标注无移除区）', () => {
    useStore.setState({
      messages: [assistantMsg('m1', [todoPart('main_c1', [{ content: '主会话任务', status: 'pending' }])])],
    })
    const sub = [
      { content: '子代理任务A', status: 'completed' },
      { content: '子代理任务B', status: 'pending' },
    ]
    const { container } = render(<ToolCallCard part={todoPart('subagent_call', sub)} />)
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(container.querySelector('.tool-card__todo-delta')).toBeNull()
    expandCard(container)
    expect(screen.getByText('子代理任务A')).toBeTruthy()
    expect(screen.queryByText('新增')).toBeNull()
    expect(container.querySelector('.todo-removed')).toBeNull()
  })

  it('非 TodoWrite 工具卡不受影响（无进度徽标）', () => {
    const bashPart: ToolPart = {
      type: 'tool',
      callID: 'c_bash',
      tool: 'Bash',
      state: { status: 'completed', input: { command: 'ls' }, output: '' },
    }
    const { container } = render(<ToolCallCard part={bashPart} />)
    expect(container.querySelector('.tool-card__todo-progress')).toBeNull()
  })
})
