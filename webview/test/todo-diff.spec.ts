/**
 * TodoWrite 任务列表 diff（todoDiff.ts）——工具卡友好渲染的数据源
 */

import { describe, it, expect } from 'vitest'
import type { ToolPart, ZCodeMessage } from '@/types/messages'
import { extractTodoItems, diffTodos, findPrevTodoWriteTodos } from '@/utils/todoDiff'

function todoPart(callID: string, todos: Array<{ content: string; status: string }>, status: ToolPart['state']['status'] = 'completed'): ToolPart {
  return {
    type: 'tool',
    callID,
    tool: 'TodoWrite',
    state: { status, input: { todos } },
  }
}

describe('extractTodoItems', () => {
  it('正常提取 + 异常条目丢弃', () => {
    const part = todoPart('c1', [
      { content: 'a', status: 'pending' },
      { content: '', status: 'pending' }, // 空 content 合法（保留——渲染空行无伤大雅但 diff 键稳定）
      { content: 42, status: 'x' } as never, // 形态异常丢弃
    ])
    expect(extractTodoItems(part)).toEqual([
      { content: 'a', status: 'pending' },
      { content: '', status: 'pending' },
    ])
  })

  it('无 todos（流式未解析/形态变化）→ 空数组', () => {
    expect(extractTodoItems({ ...todoPart('c1', []), state: { status: 'running', inputRaw: '{"todos":[' } })).toEqual([])
    expect(extractTodoItems({ ...todoPart('c1', []), state: { status: 'running' } })).toEqual([])
  })
})

describe('diffTodos', () => {
  const prev = [
    { content: '调研', status: 'completed' },
    { content: '实现', status: 'in_progress' },
    { content: '测试', status: 'pending' },
    { content: '部署', status: 'pending' },
  ]

  it('新增/状态变更/删除全量识别', () => {
    const next = [
      { content: '调研', status: 'completed' },     // 不变
      { content: '实现', status: 'completed' },     // 状态变更
      { content: '测试', status: 'in_progress' },   // 状态变更
      { content: '写文档', status: 'pending' },     // 新增
      // 部署被删除
    ]
    const d = diffTodos(prev, next)
    expect(d.total).toBe(4)
    expect(d.completedCount).toBe(2)
    expect(d.addedCount).toBe(1)
    expect(d.statusChangedCount).toBe(2)
    expect(d.removed.map((r) => r.content)).toEqual(['部署'])
    expect(d.entries.find((e) => e.content === '实现')).toEqual({
      content: '实现', status: 'completed', change: 'status', prevStatus: 'in_progress',
    })
    expect(d.entries.find((e) => e.content === '写文档')?.change).toBe('added')
    expect(d.entries.find((e) => e.content === '调研')).toEqual({
      content: '调研', status: 'completed', change: null,
    })
  })

  it('首次调用（prev=null）：全部 change=null，removed 空', () => {
    const d = diffTodos(null, prev)
    expect(d.addedCount).toBe(0)
    expect(d.statusChangedCount).toBe(0)
    expect(d.removed).toEqual([])
    expect(d.entries.every((e) => e.change === null)).toBe(true)
    expect(d.completedCount).toBe(1)
    expect(d.total).toBe(4)
  })

  it('content 改写 = 删除旧 + 新增新（无稳定 id，按内容匹配）', () => {
    const d = diffTodos(
      [{ content: '旧描述', status: 'in_progress' }],
      [{ content: '新描述', status: 'in_progress' }],
    )
    expect(d.addedCount).toBe(1)
    expect(d.removed.map((r) => r.content)).toEqual(['旧描述'])
  })

  it('重复 content 去重（防模型重复行渲染两条）', () => {
    const d = diffTodos(null, [
      { content: 'a', status: 'pending' },
      { content: 'a', status: 'pending' },
    ])
    expect(d.total).toBe(1)
  })

  it('清空列表（next 空）：全部进 removed', () => {
    const d = diffTodos(prev, [])
    expect(d.entries).toEqual([])
    expect(d.removed).toHaveLength(4)
    expect(d.total).toBe(0)
  })
})

describe('findPrevTodoWriteTodos', () => {
  function msg(id: string, parts: unknown[]): ZCodeMessage {
    return { info: { role: 'assistant', time: { created: 1 }, id, sessionID: 's' }, parts: parts as never }
  }

  it('跨消息按序回溯：找到 callID 之前最近一次 TodoWrite 的 todos', () => {
    const messages = [
      msg('m1', [todoPart('c1', [{ content: 'a', status: 'pending' }])]),
      msg('m2', [{ type: 'text', text: 'hi' }]),
      msg('m3', [todoPart('c2', [{ content: 'a', status: 'completed' }])]),
      msg('m4', [todoPart('c3', [{ content: 'b', status: 'pending' }])]),
    ]
    expect(findPrevTodoWriteTodos(messages, 'c3')).toEqual([{ content: 'a', status: 'completed' }])
  })

  it('首次调用（callID 是流中第一个 TodoWrite）→ null', () => {
    const messages = [msg('m1', [todoPart('c1', [{ content: 'a', status: 'pending' }])])]
    expect(findPrevTodoWriteTodos(messages, 'c1')).toBeNull()
  })

  it('callID 不在主流（子代理弹窗 parts）→ null（无标注安全降级）', () => {
    const messages = [msg('m1', [todoPart('c1', [{ content: 'a', status: 'pending' }])])]
    expect(findPrevTodoWriteTodos(messages, 'subagent_call')).toBeNull()
  })

  it('user 消息与非 TodoWrite 工具不打断扫描', () => {
    const messages = [
      msg('m0', [
        { type: 'tool', callID: 'x', tool: 'Bash', state: { status: 'completed', input: { command: 'ls' } } },
        todoPart('c1', [{ content: '前置任务', status: 'pending' }]),
      ]),
      { info: { role: 'user', time: { created: 1 }, id: 'u1', sessionID: 's' }, parts: [{ type: 'text', text: 'go' }] },
      msg('m2', [todoPart('c2', [{ content: 'z', status: 'pending' }])]),
    ]
    expect(findPrevTodoWriteTodos(messages, 'c2')).toEqual([{ content: '前置任务', status: 'pending' }])
  })
})
