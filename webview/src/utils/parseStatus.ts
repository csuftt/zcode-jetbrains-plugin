/**
 * 状态面板数据解析（对齐 cc-gui StatusPanel）
 *
 * 数据源是消息历史里的工具调用 part（实测结构，见 docs/计划与里程碑/UI重构规划.md 第十一节）：
 * - 任务：tool === "TodoWrite" → state.input.todos: [{content, status, priority}]
 *   —— 取最后一次调用（TodoWrite 每次调用都全量覆盖 todo 列表）
 * - Agent：tool === "Agent" | "Task" → state.input.description + state.status，
 *   —— 按 callID 去重，后面的状态覆盖前面的
 * - 文件改动：tool === "Edit" | "Write" | "MultiEdit" → 按文件路径聚合，
 *   —— old/new 行数差估算增删（ZCode 无 git 状态，统一 M）
 *
 * 纯函数、幂等，每次 messages 变化（全量拉取 / 流式增量）后重新解析。
 */

import i18n from '@/i18n/config'
import type { AgentItem, FileChangeItem, FileEditContent, SubagentActivity, SubagentInfo, TodoItem, ZCodeMessage } from '@/types/messages'

/** 工具 part 的 input 字段名兼容（实测 Edit 用 file_path，Write 用 path）*/
function getFilePath(input?: Record<string, unknown>): string {
  if (!input) return ''
  const v = input.file_path ?? input.path ?? input.filePath ?? input.filename
  return typeof v === 'string' ? v : ''
}

/** 取输入里的正文内容（new_string / content）*/
function getNewContent(input?: Record<string, unknown>): string {
  if (!input) return ''
  const v = input.new_string ?? input.newString ?? input.content ?? input.body
  return typeof v === 'string' ? v : ''
}

function getOldContent(input?: Record<string, unknown>): string {
  if (!input) return ''
  const v = input.old_string ?? input.oldString ?? input.previous
  return typeof v === 'string' ? v : ''
}

/** 文本行数（空串计 0 行，结尾换行符不算多一行，中间空行保留）*/
function lineCount(s: string): number {
  if (!s) return 0
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/** 从消息列表解析任务（最后一次 TodoWrite 的 todos）*/
export function parseTodos(messages: ZCodeMessage[]): TodoItem[] {
  let todos: TodoItem[] = []
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== 'tool' || part.tool !== 'TodoWrite') continue
      const input = part.state?.input
      if (!input || !Array.isArray(input.todos)) continue
      // TodoWrite 每次调用都是全量列表 → 直接覆盖
      todos = (input.todos as Record<string, unknown>[]).map((t) => ({
        content: String(t.content ?? ''),
        status: String(t.status ?? 'pending'),
        ...(t.priority ? { priority: String(t.priority) } : {}),
      }))
    }
  }
  return todos
}

/** 从消息列表解析子 agent（Agent/Task 工具调用，按 callID 去重取最新）*/
export function parseAgents(messages: ZCodeMessage[]): AgentItem[] {
  const byCall: Map<string, AgentItem> = new Map()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue
      if (part.tool !== 'Agent' && part.tool !== 'Task' && part.tool !== 'subagent') continue
      const input = part.state?.input ?? {}
      // description 为空也要展示（流式早期 input 还没解析完），回退 prompt → 占位
      const description = String(input.description ?? input.prompt ?? '').slice(0, 200)
        || i18n.t('utils.subagentTask')
      // 起止时间与工具命令卡同源（state.time），子代理耗时以此为准——
      // session/subagents RPC 的起止由服务端多级兜底链拼装，完成后可能相等/倒挂
      const time = part.state?.time
      const item: AgentItem = {
        description,
        status: String(part.state?.status ?? 'pending'),
        ...(typeof input.subagent_type === 'string' && input.subagent_type
          ? { subagentType: input.subagent_type }
          : {}),
        callID: part.callID,
        ...(time?.start ? { startedAt: time.start } : {}),
        ...(time?.end ? { endedAt: time.end } : {}),
      }
      byCall.set(part.callID, item) // 后出现的状态覆盖（流式时 pending → running → completed）
    }
  }
  return [...byCall.values()]
}

/**
 * Agent 工具 part 的最终报告输出（子代理报告弹窗 / 底部栏点击分流共用）。
 * 取该 callID 最后一次出现的 output 快照（重试/多帧时以最终态为准），无则空串。
 */
export function getAgentToolOutput(messages: ZCodeMessage[], callID: string): string {
  let output = ''
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === 'tool' && part.callID === callID && part.state.output) output = part.state.output
    }
  }
  return output
}

/**
 * 有效耗时对：起止齐且 end > start 才可用。
 * RPC 的 startedAt/endedAt 实测完成后可能返回相等/倒挂的一对（兜底链取自不同
 * 层级），直接作差会被钳成 0 —— 子代理耗时显示 "0s" 的根源。
 */
export function validSpan(s?: number, e?: number): { startedAt: number; endedAt: number } | undefined {
  return s && e && e > s ? { startedAt: s, endedAt: e } : undefined
}

/**
 * 合并三个子代理数据源成 StatusPanel 列表（按 callID/toolCallId/parentToolCallId 关联）：
 * 1. parseAgents（消息历史，兜底——覆盖 RPC/流式都还没看到的早期阶段；起止时间
 *    取 Agent part 的 state.time，与工具命令卡同源，是耗时的首选来源）
 * 2. subagentActivities（流式实时累积，运行中最准；本地计时兜底 part.time 缺失）
 * 3. subagents RPC（权威——turn 结束/会话加载后，含 summary/childSessionId；
 *    起止时间可能相等/倒挂，仅在本地无有效耗时对时采纳，见 validSpan）
 */
export function mergeAgentItems(
  parsed: AgentItem[],
  activities: SubagentActivity[],
  rpc: SubagentInfo[],
): AgentItem[] {
  const byCall = new Map<string, AgentItem>()
  // 兜底先入（会被后两个源覆盖）
  for (const p of parsed) byCall.set(p.callID, p)
  // 流式活动：状态与 childSessionId 更及时；本地计时（startedAt/endedAt）作
  // 消息 part.time 缺失时的耗时兜底
  for (const a of activities) {
    const prev = byCall.get(a.key)
    const status = a.status === 'running' ? 'running'
      : a.status === 'failed' ? 'error' : 'completed'
    // 后台子代理：Agent 工具立即返回（part.time 只是调度往返），本地收尾时间
    // 也会被提前触发——起点只认流式首事件，终点留给 RPC 的后台任务 completedAt
    const bg = a.background || prev?.background
    const span = bg ? undefined
      : validSpan(prev?.startedAt, prev?.endedAt) ?? validSpan(a.startedAt, a.endedAt)
    const startedAt = span?.startedAt
      ?? (bg ? a.startedAt ?? prev?.startedAt : prev?.startedAt ?? a.startedAt)
    const endedAt = bg ? undefined : span?.endedAt ?? prev?.endedAt
    byCall.set(a.key, {
      description: a.description || prev?.description || i18n.t('utils.subagentTask'),
      status,
      ...(a.agentType || prev?.subagentType ? { subagentType: a.agentType || prev?.subagentType } : {}),
      ...(a.childSessionId || prev?.childSessionId
        ? { childSessionId: a.childSessionId || prev?.childSessionId }
        : {}),
      ...(bg ? { background: true } : {}),
      ...(prev?.summary ? { summary: prev.summary } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      callID: a.key,
    })
  }
  // RPC 权威值最后覆盖（status/summary/childSessionId）；起止时间例外——
  // 前台本地（part.time / 流式计时）已有有效耗时对时不采纳 RPC 的（可能相等/倒挂）；
  // 后台则相反：RPC 的后台任务 completedAt 是唯一可靠终点
  for (const r of rpc) {
    const prev = byCall.get(r.toolCallId)
    const rpcStatus = normalizeRpcStatus(r.status, prev?.status)
    // 防降级：RPC 是快照（轮询/回合结束拉取），可能落后于本地事件收尾——
    // 本地已终态时，过期的 running/pending 不得把 completed/error 盖回去。
    //（2026-08-20 前台代理实测：28s 轮询取到 running、29.65s 事件收尾、
    //  31s 轮询自停不再刷新 → 缓存 running 永久覆盖 completed，卡到回合结束）
    const prevTerminal = prev?.status === 'completed' || prev?.status === 'error'
    const effectiveStatus = prevTerminal && (rpcStatus === 'running' || rpcStatus === 'pending')
      ? prev!.status
      : rpcStatus
    const bg = prev?.background
    const span = bg
      ? validSpan(r.startedAt, r.endedAt)
      : validSpan(prev?.startedAt, prev?.endedAt) ?? validSpan(r.startedAt, r.endedAt)
    const startedAt = span?.startedAt ?? prev?.startedAt ?? r.startedAt
    const endedAt = span?.endedAt ?? prev?.endedAt
    byCall.set(r.toolCallId, {
      description: r.title || prev?.description || i18n.t('utils.subagentTask'),
      status: effectiveStatus,
      ...(r.subagentType || prev?.subagentType
        ? { subagentType: r.subagentType || prev?.subagentType }
        : {}),
      childSessionId: r.childSessionId,
      ...(bg ? { background: true } : {}),
      ...(r.summary ? { summary: r.summary } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      callID: r.toolCallId,
    })
  }
  return [...byCall.values()
  ].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

/** RPC 的 status 字符串 → StatusPanel 状态（running/completed/failed/interrupted…）*/
function normalizeRpcStatus(rpcStatus: string, prev?: string): string {
  const s = rpcStatus.toLowerCase()
  if (s === 'running' || s === 'pending') return s === 'pending' ? 'pending' : 'running'
  if (s === 'completed' || s === 'succeeded' || s === 'success') return 'completed'
  if (s === 'failed' || s === 'error' || s === 'interrupted' || s === 'aborted' || s === 'cancelled') return 'error'
  return prev ?? 'pending'
}

/**
 * 从消息列表解析文件改动（Edit/Write/MultiEdit 按路径聚合增删行数）。
 * 同时保留每次编辑的 old/new 内容（edits，底部文件栏弹前后对比用）。
 */
export function parseFileChanges(messages: ZCodeMessage[]): FileChangeItem[] {
  const byPath: Map<string, FileChangeItem> = new Map()

  const add = (path: string, additions: number, deletions: number, edit?: FileEditContent) => {
    const key = path.replace(/\\/g, '/') // 统一分隔符避免同一文件重复统计
    const cur = byPath.get(key)
    if (cur) {
      cur.additions += additions
      cur.deletions += deletions
      if (edit && cur.edits) cur.edits.push(edit)
    } else {
      const parts = key.split('/')
      byPath.set(key, {
        filePath: key,
        fileName: parts[parts.length - 1] || key,
        additions,
        deletions,
        edits: edit ? [edit] : [],
      })
    }
  }

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue
      const tool = part.tool
      if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') continue
      const input = part.state?.input
      const path = getFilePath(input)
      if (!path) continue

      if (tool === 'Write') {
        // Write = 整文件写入 → 全部算新增（oldContent 为空，diff 显示为全新文件）
        const content = getNewContent(input)
        add(path, lineCount(content), 0, { oldContent: '', newContent: content })
      } else if (tool === 'MultiEdit') {
        // MultiEdit = edits 数组，逐项按 Edit 口径统计与收集
        const edits = input?.edits
        if (Array.isArray(edits)) {
          for (const e of edits) {
            if (!e || typeof e !== 'object') continue
            const rec = e as Record<string, unknown>
            const oldC = getOldContent(rec)
            const newC = getNewContent(rec)
            const diff = lineCount(newC) - lineCount(oldC)
            add(path, Math.max(0, diff), Math.max(0, -diff), { oldContent: oldC, newContent: newC })
          }
        }
      } else {
        // Edit = 替换 → 行数差
        const oldC = getOldContent(input)
        const newC = getNewContent(input)
        const diff = lineCount(newC) - lineCount(oldC)
        add(path, Math.max(0, diff), Math.max(0, -diff), { oldContent: oldC, newContent: newC })
      }
    }
  }
  return [...byPath.values()]
}
