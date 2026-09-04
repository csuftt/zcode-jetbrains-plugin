/**
 * TodoWrite 任务列表 diff（工具卡友好渲染数据源）
 *
 * TodoWrite 每次调用都是全量覆盖（parseTodos 同语义），单看一次调用只知道终态；
 * 与上一次调用对比才能看出「哪些任务新增了、状态变更了、删除了」。
 *
 * 匹配键=content 全等：任务无稳定 id，status 是唯一可变字段；content 变了按
 * 删除+新增呈现（模型改写任务描述的语义就是换任务）。
 */

import type { ToolPart, TodoItem, ZCodeMessage } from '@/types/messages'

export interface TodoDiffEntry {
  content: string
  status: string
  /** 相对上一次快照：added=新增，status=状态变更（prevStatus 持旧值），null=未变化 */
  change: 'added' | 'status' | null
  prevStatus?: string
}

export interface TodoDiffResult {
  entries: TodoDiffEntry[]
  /** 上次有、本次没有（已删除） */
  removed: TodoItem[]
  addedCount: number
  statusChangedCount: number
  completedCount: number
  total: number
}

/** 从 TodoWrite part 提取 todos（容错：字段缺失/形态异常的条目丢弃）*/
export function extractTodoItems(part: ToolPart): TodoItem[] {
  const todos = part.state?.input?.todos
  if (!Array.isArray(todos)) return []
  return todos.filter(
    (x): x is TodoItem =>
      !!x && typeof (x as TodoItem).content === 'string' && typeof (x as TodoItem).status === 'string',
  )
}

/** 全量列表 vs 上次快照的增量标注；prev=null（首次调用，无对比基准）时不带
 * 任何增量标注——首次列表本来就是新的，全标「新增」只有噪音 */
export function diffTodos(prev: TodoItem[] | null, next: TodoItem[]): TodoDiffResult {
  const entries: TodoDiffEntry[] = []
  if (prev == null) {
    let completed = 0
    const seen = new Set<string>()
    for (const t of next) {
      if (seen.has(t.content)) continue
      seen.add(t.content)
      entries.push({ content: t.content, status: t.status, change: null })
      if (t.status === 'completed') completed++
    }
    return { entries, removed: [], addedCount: 0, statusChangedCount: 0, completedCount: completed, total: entries.length }
  }
  const prevMap = new Map<string, string>()
  for (const t of prev) prevMap.set(t.content, t.status)
  let added = 0
  let statusChanged = 0
  let completed = 0
  const seen = new Set<string>()
  for (const t of next) {
    if (seen.has(t.content)) continue
    seen.add(t.content)
    const prevStatus = prevMap.get(t.content)
    let change: 'added' | 'status' | null = null
    if (prevStatus === undefined) {
      change = 'added'
      added++
    } else if (prevStatus !== t.status) {
      change = 'status'
      statusChanged++
    }
    if (t.status === 'completed') completed++
    entries.push({ content: t.content, status: t.status, change, ...(change === 'status' ? { prevStatus } : {}) })
  }
  const nextSet = new Set(next.map((t) => t.content))
  const removed = prev.filter((t) => !nextSet.has(t.content))
  return { entries, removed, addedCount: added, statusChangedCount: statusChanged, completedCount: completed, total: entries.length }
}

/**
 * 主消息流里找指定 callID 之前最近一次 TodoWrite 的 todos（跨消息按序扫描）。
 * 返回 null = 无对比基准：callID 不在流中（子代理弹窗等独立 parts 来源）或
 * 本调用是会话内第一次 TodoWrite——渲染纯当前列表，不带增量标注。
 */
export function findPrevTodoWriteTodos(messages: ZCodeMessage[], callID: string): TodoItem[] | null {
  let prev: TodoItem[] | null = null
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== 'tool' || p.tool !== 'TodoWrite') continue
      if (p.callID === callID) return prev
      prev = extractTodoItems(p)
    }
  }
  return null
}
