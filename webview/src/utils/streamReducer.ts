/**
 * 流式事件 → 消息 parts 的归约器（纯函数）
 *
 * 把 session/event 转成对当前 assistant 消息的增量更新。
 * store 负责调用 applyStreamEvent 并 set 新 messages。
 *
 * 基于 2026-08-13 抓包确认的事件结构。
 */

import type { ZCodeMessage, MessagePart, StreamEvent, StreamEventPayload, ToolPart, SubagentActivity, ToolUpdatedPayload, TurnFailedPayload } from '@/types/messages'
import { isAgentNotification, parseNotificationText } from './parseNotification'

/**
 * 把一个流式事件应用到消息数组，返回新的消息数组（不可变更新）。
 *
 * @param messages 当前消息列表
 * @param event 流式事件
 * @param streamingMessageId 当前流式中的 assistant 消息 id（turn.started 时创建）
 * @returns { messages, streamingMessageId } 更新后的状态
 */
/** 归约结果附带的模式推断事件（缺陷E修复）：EnterPlanMode 成功 / ExitPlanMode 批准 */
export type ModeEvent = 'enter_plan' | 'exit_plan'

/** turn.failed 提取的展示用错误信息（message 为空 = 服务端未带详情，由 store 兜底文案） */
export interface TurnErrorInfo {
  message: string
  type?: string
  code?: string | number
}

/** turn.failed payload → 错误信息（payload.error 缺失时返回空 message） */
function extractTurnError(payload: StreamEventPayload): TurnErrorInfo {
  const p = (payload || {}) as Partial<TurnFailedPayload>
  const e = p.error
  return {
    message: typeof e?.message === 'string' ? e.message : '',
    ...(e?.type ? { type: e.type } : {}),
    ...(e?.code !== undefined ? { code: e.code } : {}),
  }
}

/** 是否配额类错误（token_quota_exceeded 等）：确定性失败，重试不会成功，配专门文案 */
export function looksLikeQuotaError(code?: string | number, message?: string): boolean {
  const c = code !== undefined ? String(code).toLowerCase() : ''
  const m = (message || '').toLowerCase()
  return c.includes('quota') || m.includes('quota_exceeded') || m.includes('token_quota')
}

export function applyStreamEvent(
  messages: ZCodeMessage[],
  event: StreamEvent,
  streamingMessageId: string | null,
): { messages: ZCodeMessage[]; streamingMessageId: string | null; turnEnded: boolean; modeEvent?: ModeEvent; turnError?: TurnErrorInfo } {
  const { type, payload } = event

  switch (type) {
    case 'turn.started':
      return handleTurnStarted(messages, event, payload)

    case 'turn.userInput': {
      // v4 快照回放的 user 消息（子会话 prompt）：live 流没有本地乐观添加路径，
      // 由快照映射层补发；幂等（messageId 命中即跳过，重订阅/重同步重放安全）
      const p = payload as { messageId?: string; text: string }
      const uid = p.messageId || `snapuser_${event.turnId || event.seq}`
      if (messages.some((m) => m.info.id === uid)) {
        return { messages, streamingMessageId, turnEnded: false }
      }
      return {
        messages: [...messages, {
          info: { role: 'user', time: { created: event.timestamp }, id: uid, sessionID: event.sessionId },
          parts: p.text ? [{ type: 'text', text: p.text }] : [],
        }],
        streamingMessageId,
        turnEnded: false,
      }
    }

    case 'model.streaming':
      return handleModelStreaming(messages, streamingMessageId, event.timestamp, payload)

    case 'tool.updated':
      return handleToolUpdated(messages, streamingMessageId, event.timestamp, payload)

    case 'turn.completed':
    case 'turn.failed': {
      // turn.failed 读取 payload.error 供 UI 展示（此前错误信息被整体丢弃，
      // 失败只表现为"转圈停了"）；turn.completed 无错误
      const turnError = type === 'turn.failed' ? extractTurnError(payload) : undefined
      // 兜底：turn 结束时把所有还在 pending/running 的工具标记为已完成。
      // 真实场景：ExitPlanMode/AskUserQuestion 等控制流工具不发 tool.updated(kind:result)，
      // 只发 batch（streamReducer 内处理）或 permission.resolved；若 batch 也丢失，
      // turn 结束时这些工具会永远停在 pending/running，表现为"工具卡住"。
      return {
        messages: finalizePendingTools(messages, event.timestamp),
        streamingMessageId,
        turnEnded: true,
        ...(turnError ? { turnError } : {}),
      }
    }

    default:
      // session.updated / session.titleUpdated / streamRecovery.updated 等暂不处理
      return { messages, streamingMessageId, turnEnded: false }
  }
}

// ============ turn.started：创建新的 assistant 消息 ============

function handleTurnStarted(
  messages: ZCodeMessage[],
  event: StreamEvent,
  payload: StreamEvent['payload'],
): { messages: ZCodeMessage[]; streamingMessageId: string | null; turnEnded: boolean } {
  const p = payload as { messageId?: string; input?: string }
  const msgId = p.messageId || `stream_${event.turnId || event.seq}`

  // 避免重复创建（turn.started 可能重发）；命中 user 消息不算重发——
  // 协议的 messageId 是触发 turn 的 user 消息 id，与重拉后的服务端 user 消息
  // 同 id，直接复用会让后续 delta 叠进用户气泡（排队消息过期重拉竞态），
  // 换独立命名空间 id 新建流式消息
  const hit = messages.find((m) => m.info.id === msgId)
  if (hit) {
    if (hit.info.role === 'assistant') {
      return { messages, streamingMessageId: msgId, turnEnded: false }
    }
    return {
      messages: [...messages, createAssistantMessage(event, `stream_${msgId}`)],
      streamingMessageId: `stream_${msgId}`,
      turnEnded: false,
    }
  }

  return {
    messages: [...messages, createAssistantMessage(event, msgId)],
    streamingMessageId: msgId,
    turnEnded: false,
  }
}

function createAssistantMessage(event: StreamEvent, id: string): ZCodeMessage {
  return {
    info: {
      role: 'assistant',
      time: { created: event.timestamp },
      id,
      sessionID: event.sessionId,
    },
    parts: [],
  }
}

// ============ model.streaming：累加 text_delta / reasoning_delta / 工具输入流 ============

/**
 * 思考耗时的收尾点：非思考内容（正文/工具输入/工具调度）出现时，
 * 最后一个未收尾的 reasoning part 在此结束——补上 time.end。
 * 只看末位 part：更早的 reasoning 早在它后续内容到达时就已收尾。
 */
function closeOpenReasoning(parts: MessagePart[], timestamp: number): void {
  const last = parts[parts.length - 1]
  if (last && last.type === 'reasoning' && last.time?.start && !last.time.end) {
    parts[parts.length - 1] = { ...last, time: { start: last.time.start, end: timestamp } }
  }
}

function handleModelStreaming(
  messages: ZCodeMessage[],
  streamingMessageId: string | null,
  timestamp: number,
  payload: StreamEvent['payload'],
): { messages: ZCodeMessage[]; streamingMessageId: string | null; turnEnded: boolean; modeEvent?: ModeEvent } {
  if (!streamingMessageId) {
    // 还没收到 turn.started（异常），创建一个临时消息
    return { messages, streamingMessageId, turnEnded: false }
  }

  const p = payload as { kind: string; delta?: string }
  const kind = p.kind
  const delta = p.delta || ''

  // 工具输入流式（zcode 协议：tool_input_start → tool_input_delta → tool_input_end / tool_call）：
  // 模型生成工具参数时实时下发，回合中即可展示"在运行什么命令/读写什么文件"（缺陷F）
  if (kind === 'tool_input_start' || kind === 'tool_input_delta' ||
      kind === 'tool_input_end' || kind === 'tool_call') {
    return handleToolInputStreaming(messages, streamingMessageId, timestamp, payload)
  }

  const idx = messages.findIndex((m) => m.info.id === streamingMessageId)
  // role 防护：流式目标必须是 assistant 消息（user 气泡把 text part 直接拼接显示，
  // 一旦叠入 AI delta 即"用户消息里长出 AI 回复"），异常定位宁可丢 delta 也不写错
  if (idx < 0 || messages[idx].info.role !== 'assistant') {
    return { messages, streamingMessageId, turnEnded: false }
  }

  const msg = messages[idx]
  const parts = [...msg.parts]
  const lastPart = parts[parts.length - 1]

  if (kind === 'text_delta') {
    if (lastPart && lastPart.type === 'text') {
      // 累加到最后一个 text part
      parts[parts.length - 1] = { ...lastPart, text: lastPart.text + delta }
    } else {
      // 新建 text part（正文出现 = 前一段思考结束，收尾思考计时）
      closeOpenReasoning(parts, timestamp)
      parts.push({ type: 'text', text: delta })
    }
  } else if (kind === 'reasoning_delta') {
    if (lastPart && lastPart.type === 'reasoning') {
      parts[parts.length - 1] = { ...lastPart, text: lastPart.text + delta }
    } else {
      // 新建 reasoning part，记下思考开始时刻（耗时统计用）
      parts.push({ type: 'reasoning', text: delta, time: { start: timestamp } })
    }
  } else {
    return { messages, streamingMessageId, turnEnded: false }
  }

  const newMessages = [...messages]
  newMessages[idx] = { ...msg, parts }
  return { messages: newMessages, streamingMessageId, turnEnded: false }
}

// ============ model.streaming 的工具输入流：tool_input_start/delta/end + tool_call ============
// zcode 协议（zcode.cjs qto schema）：模型生成工具参数时按 kind 流式下发，
// 主会话工具的 scheduled 事件省略 input（inputOmitted/inputRef:"model_stream"），
// 这里的流才是回合中工具输入的唯一实时来源（缺陷F）。

function handleToolInputStreaming(
  messages: ZCodeMessage[],
  streamingMessageId: string | null,
  timestamp: number,
  payload: StreamEvent['payload'],
): { messages: ZCodeMessage[]; streamingMessageId: string | null; turnEnded: false } {
  const p = payload as {
    kind: string
    toolCallId?: string
    toolName?: string
    delta?: string
    input?: unknown
    toolCall?: { id?: string; name?: string; input?: unknown }
  }
  // 兼容嵌套 toolCall 形状（内部流结构转 session 事件可能保留嵌套）
  const callId = p.toolCallId || p.toolCall?.id
  if (!callId) return { messages, streamingMessageId, turnEnded: false }

  const idx = messages.findIndex((m) => m.info.id === streamingMessageId)
  // role 防护：同 handleModelStreaming，流式目标必须是 assistant 消息
  if (idx < 0 || messages[idx].info.role !== 'assistant') {
    return { messages, streamingMessageId, turnEnded: false }
  }

  const msg = messages[idx]
  const parts = [...msg.parts]
  const tIdx = parts.findIndex(
    (part): part is ToolPart => part.type === 'tool' && part.callID === callId,
  )
  if (p.kind === 'tool_input_start') {
    if (tIdx >= 0) return { messages, streamingMessageId, turnEnded: false } // 已存在（scheduled 先到）
    // 工具输入出现 = 前一段思考结束，收尾思考计时
    closeOpenReasoning(parts, timestamp)
    parts.push({
      type: 'tool',
      callID: callId,
      tool: p.toolName || 'unknown',
      state: { status: 'pending', title: p.toolName, inputRaw: '' },
    })
  } else if (p.kind === 'tool_input_delta') {
    if (tIdx < 0) return { messages, streamingMessageId, turnEnded: false }
    const tool = parts[tIdx] as ToolPart
    parts[tIdx] = {
      ...tool,
      state: { ...tool.state, inputRaw: (tool.state.inputRaw || '') + (p.delta || '') },
    }
  } else if (p.kind === 'tool_call') {
    // 完整工具调用：input 已齐，转正为解析后的对象，清掉原始累积
    const rawInput = p.input ?? p.toolCall?.input
    const input = rawInput && typeof rawInput === 'object'
      ? (rawInput as Record<string, unknown>)
      : undefined
    if (tIdx >= 0) {
      const tool = parts[tIdx] as ToolPart
      parts[tIdx] = {
        ...tool,
        state: { ...tool.state, ...(input ? { input } : {}), inputRaw: undefined },
      }
    } else {
      closeOpenReasoning(parts, timestamp)
      parts.push({
        type: 'tool',
        callID: callId,
        tool: p.toolName || p.toolCall?.name || 'unknown',
        state: { status: 'pending', ...(input ? { input } : {}) },
      })
    }
  }
  // tool_input_end：无内容，忽略

  const newMessages = [...messages]
  newMessages[idx] = { ...msg, parts }
  return { messages: newMessages, streamingMessageId, turnEnded: false }
}

// ============ tool.updated：更新工具调用状态 ============

function handleToolUpdated(
  messages: ZCodeMessage[],
  streamingMessageId: string | null,
  timestamp: number,
  payload: StreamEvent['payload'],
): { messages: ZCodeMessage[]; streamingMessageId: string | null; turnEnded: boolean; modeEvent?: ModeEvent } {
  // 子代理转发事件不进主聊天（归属 subagentActivities，见文件末尾分流区）
  if (isSubagentToolEvent(payload)) {
    return { messages, streamingMessageId, turnEnded: false }
  }
  const p = payload as {
    kind: string
    toolCallId?: string
    toolCallIds?: string[]
    toolName?: string
    result?: { success?: boolean; content?: string; error?: string }
    startedAt?: number
    successCount?: number
    errorCount?: number
    input?: Record<string, unknown>
  }

  // batch：批量结果汇总，payload 用 toolCallIds（复数）且没有单数 toolCallId，
  // 必须在下面 callId 早退之前处理，否则永远到不了。
  // ExitPlanMode/AskUserQuestion 等控制流工具不发 kind:result，只发 batch 收尾。
  if (p.kind === 'batch') {
    const toolCallIds = p.toolCallIds || []
    if (toolCallIds.length === 0) return { messages, streamingMessageId, turnEnded: false }
    const idx = streamingMessageId
      ? messages.findIndex((m) => m.info.id === streamingMessageId)
      : findLastAssistantIdx(messages)
    // role 防护：同上，streamingMessageId 定位到的必须是 assistant 消息
    if (idx < 0 || messages[idx].info.role !== 'assistant') {
      return { messages, streamingMessageId, turnEnded: false }
    }

    const msg = messages[idx]
    const parts = [...msg.parts]
    const errorCount = p.errorCount ?? 0
    // 后 errorCount 个标记为 error，其余 completed
    const errorIds = new Set(toolCallIds.slice(Math.max(0, toolCallIds.length - errorCount)))
    // 缺陷E推断：ExitPlanMode 成功收尾 = 计划已批准，模式离开 plan（服务端此时刻不推 mode）
    let modeEvent: ModeEvent | undefined
    for (const tcid of toolCallIds) {
      const tIdx = parts.findIndex(
        (part): part is ToolPart => part.type === 'tool' && part.callID === tcid,
      )
      if (tIdx < 0) continue
      const tool = parts[tIdx] as ToolPart
      // 已经有终态（completed/error）的不覆盖
      if (tool.state.status === 'completed' || tool.state.status === 'error') continue
      const isError = errorIds.has(tcid)
      const prevTime = tool.state.time
      parts[tIdx] = {
        ...tool,
        state: {
          ...tool.state,
          status: isError ? 'error' : 'completed',
          time: { start: prevTime?.start ?? Date.now(), end: Date.now() },
        },
      }
      if (!isError && tool.tool === 'ExitPlanMode') modeEvent = 'exit_plan'
    }
    const newMessages = [...messages]
    newMessages[idx] = { ...msg, parts }
    return { messages: newMessages, streamingMessageId, turnEnded: false, modeEvent }
  }

  const callId = p.toolCallId
  if (!callId) return { messages, streamingMessageId, turnEnded: false }

  // 找当前流式消息（或最后一个 assistant 消息）
  const targetId = streamingMessageId
  const idx = targetId
    ? messages.findIndex((m) => m.info.id === targetId)
    : findLastAssistantIdx(messages)
  // role 防护：streamingMessageId 定位到的必须是 assistant 消息（同 handleModelStreaming）
  if (idx < 0 || messages[idx].info.role !== 'assistant') {
    return { messages, streamingMessageId, turnEnded: false }
  }

  const msg = messages[idx]
  const parts = [...msg.parts]
  const existingToolIdx = parts.findIndex(
    (part): part is ToolPart => part.type === 'tool' && part.callID === callId,
  )

  if (p.kind === 'scheduled' || p.kind === 'started') {
    // 新工具调用或状态更新
    const status = p.kind === 'started' ? 'running' : 'pending'
    if (existingToolIdx >= 0) {
      const existing = parts[existingToolIdx] as ToolPart
      parts[existingToolIdx] = {
        ...existing,
        // input 流期间可能只有 toolCallId（tool_input_start 无 toolName），补齐名字
        tool: (existing.tool === 'unknown' && p.toolName) ? p.toolName : existing.tool,
        state: {
          ...existing.state,
          status,
          // 子代理工具的 scheduled 内联携带完整 input（主会话工具 inputOmitted 走 model 流）
          ...(p.input ? { input: p.input } : {}),
        },
      }
    } else {
      // 工具调度出现 = 前一段思考结束，收尾思考计时
      closeOpenReasoning(parts, timestamp)
      const newTool: ToolPart = {
        type: 'tool',
        callID: callId,
        tool: p.toolName || 'unknown',
        state: {
          status,
          title: p.toolName,
          ...(p.input ? { input: p.input } : {}),
          ...(p.startedAt ? { time: { start: p.startedAt } } : {}),
        },
      }
      parts.push(newTool)
    }
  } else if (p.kind === 'result') {
    // 工具完成，带输出
    if (existingToolIdx >= 0) {
      const tool = parts[existingToolIdx] as ToolPart
      const output = p.result?.content || ''
      const isError = p.result?.success === false
      const prevTime = tool.state.time
      parts[existingToolIdx] = {
        ...tool,
        state: {
          ...tool.state,
          status: isError ? 'error' : 'completed',
          output,
          ...(p.result?.error ? { error: { message: p.result.error } } : {}),
          time: { start: prevTime?.start ?? Date.now(), end: Date.now() },
        },
      }
      // 缺陷E推断：EnterPlanMode 成功 = 会话已进入 plan 模式（服务端此时刻不推 mode）
      if (!isError && tool.tool === 'EnterPlanMode') {
        const newMessages = [...messages]
        newMessages[idx] = { ...msg, parts }
        return { messages: newMessages, streamingMessageId, turnEnded: false, modeEvent: 'enter_plan' }
      }
    }
  }
  // progress / error kind 暂不细处理

  const newMessages = [...messages]
  newMessages[idx] = { ...msg, parts }
  return { messages: newMessages, streamingMessageId, turnEnded: false }
}

function findLastAssistantIdx(messages: ZCodeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === 'assistant') return i
  }
  return -1
}

// ============ 子代理工具事件分流（刷屏修复核心）============
// zcode.cjs ETn：子代理内部工具事件用父会话 sessionId 转发（进度透传），
// payload 带 source:"subagent" + parentToolCallId/childSessionId 等归属字段。
// 这些事件不进主聊天消息 parts（否则每个 Read/Bash 都变工具卡刷屏，
// turn 结束重拉后又消失——持久化归属子会话），改为按 parentToolCallId
// 聚合到独立的 subagentActivities，供底部子代理栏与详情弹窗使用。

/** 判断 tool.updated payload 是否子代理转发事件（source 标记，childSessionId 兜底）*/
export function isSubagentToolEvent(payload: StreamEventPayload): boolean {
  const p = payload as ToolUpdatedPayload
  return p.source === 'subagent' || !!p.childSessionId
}

/**
 * session.updated(subagent.lifecycle)：子代理 spawn/stop 时推给父会话的通知
 * （zcode.cjs 事件类型映射 default → "session.updated"）。spawned 在子会话
 * 第一个事件前到达且携带 childSessionId —— 前端据此注册子会话，后续其原生
 * 事件流（含 AI 文本增量）即可实时归约成完整对话，无需 resume。
 */
export interface SubagentLifecyclePayload {
  kind: 'subagent.lifecycle'
  phase: 'spawned' | 'stopped'
  agentId: string
  agentType?: string
  childSessionId: string
  parentToolCallId?: string
  background?: boolean
  status?: string
}

/** 是 subagent.lifecycle 则返回结构化 payload，否则 null */
export function asSubagentLifecycle(payload: StreamEventPayload): SubagentLifecyclePayload | null {
  const p = payload as Partial<SubagentLifecyclePayload>
  if (p && p.kind === 'subagent.lifecycle'
    && typeof p.childSessionId === 'string' && typeof p.agentId === 'string') {
    return p as SubagentLifecyclePayload
  }
  return null
}

/**
 * 把一个子代理 tool.updated 事件累积到 activities（纯函数，不可变更新）。
 * scheduled/started → 建/更新 ToolPart（子代理事件内联完整 input，无 inputOmitted）；
 * result/error → 收尾；任何 kind 都顺带补齐归属元信息与聚合状态。
 */
export function applySubagentToolEvent(
  activities: SubagentActivity[],
  payload: StreamEventPayload,
  timestamp: number,
): SubagentActivity[] {
  // input 显式收窄（索引签名兜底会把 p.input 收成 {}，无法赋给 ToolState.input）
  const p = payload as ToolUpdatedPayload & { input?: Record<string, unknown> }
  const key = p.parentToolCallId || p.agentId || ''
  const callId = p.toolCallId
  if (!key || !callId) return activities

  const idx = activities.findIndex((a) => a.key === key)
  const cur: SubagentActivity = idx >= 0
    ? activities[idx]
    : { key, status: 'running', tools: [], lastUpdate: timestamp, startedAt: timestamp }

  // 补齐归属元信息（任意事件都可能首次携带）
  const merged: SubagentActivity = {
    ...cur,
    ...(p.agentId && !cur.agentId ? { agentId: p.agentId } : {}),
    ...(p.agentType && !cur.agentType ? { agentType: p.agentType } : {}),
    ...(p.description && !cur.description ? { description: p.description } : {}),
    ...(p.childSessionId && !cur.childSessionId ? { childSessionId: p.childSessionId } : {}),
    ...(p.background && !cur.background ? { background: true } : {}),
    lastUpdate: timestamp,
  }

  const tools = [...merged.tools]
  const tIdx = tools.findIndex((t) => t.callID === callId)

  if (p.kind === 'scheduled' || p.kind === 'started') {
    const status = p.kind === 'started' ? 'running' : 'pending'
    if (tIdx >= 0) {
      tools[tIdx] = {
        ...tools[tIdx],
        state: { ...tools[tIdx].state, status, ...(p.input ? { input: p.input } : {}) },
      }
    } else {
      tools.push({
        type: 'tool',
        callID: callId,
        tool: p.toolName || 'unknown',
        state: {
          status,
          title: p.toolName,
          ...(p.input ? { input: p.input } : {}),
          ...(p.startedAt ? { time: { start: p.startedAt } } : {}),
        },
      })
    }
  } else if (p.kind === 'result' || p.kind === 'error') {
    const isError = p.kind === 'error' || p.result?.success === false
    if (tIdx >= 0) {
      const prevTime = tools[tIdx].state.time
      tools[tIdx] = {
        ...tools[tIdx],
        state: {
          ...tools[tIdx].state,
          status: isError ? 'error' : 'completed',
          ...(p.result?.content ? { output: p.result.content } : {}),
          ...(p.result?.error ? { error: { message: p.result.error } } : {}),
          time: { start: prevTime?.start ?? timestamp, end: timestamp },
        },
      }
    }
  }
  // progress：无新信息，忽略

  const next: SubagentActivity = { ...merged, tools }
  if (idx >= 0) {
    const copy = [...activities]
    copy[idx] = next
    return copy
  }
  return [...activities, next]
}

/**
 * 父会话 Agent 工具本身的 result 事件（非 source=subagent）到达时，
 * 对应子代理活动即时收尾——比 session/subagents RPC 刷新更早反映完成状态。
 */
export function markActivityOutcome(
  activities: SubagentActivity[],
  key: string,
  failed: boolean,
  timestamp: number,
): SubagentActivity[] {
  return activities.map((a) => a.key === key && a.status === 'running'
    ? { ...a, status: failed ? 'failed' : 'completed', lastUpdate: timestamp, endedAt: timestamp }
    : a)
}

/**
 * 合成 task-notification 消息 → 收尾对应子代理活动（幂等，仅 running 可翻转）。
 * session/subscribe 事件流实测不带 subagent.lifecycle（2026-08-20 idea.log/zcode.cjs
 * 取证），后台子代理完成在转录里的唯一痕迹是这条通知消息（tool-use-id = 父会话
 * Agent 工具 callID = 活动 key）；子会话流与生命周期钩子都错过的场合（如重启
 * 恢复出 running 活动），消息重拉时在此自愈。后台 Bash 任务的 tool-use-id 不在
 * activities 里，markActivityOutcome 天然不命中，无副作用。
 */
export function finalizeActivitiesFromNotifications(
  activities: SubagentActivity[],
  messages: ZCodeMessage[],
  timestamp: number,
): SubagentActivity[] {
  if (!activities.some((a) => a.status === 'running')) return activities
  let next = activities
  for (const msg of messages) {
    if (msg.info?.role !== 'user' || !isAgentNotification(msg.info)) continue
    const textPart = msg.parts.find((p) => p.type === 'text') as { text?: string } | undefined
    const text = typeof textPart?.text === 'string' ? textPart.text : ''
    if (!text) continue
    const parsed = parseNotificationText(text)
    if (parsed.kind !== 'task' || !parsed.toolUseId) continue
    const failed = parsed.status !== undefined
      && !['completed', 'succeeded', 'success'].includes(parsed.status)
    next = markActivityOutcome(next, parsed.toolUseId, failed, timestamp)
  }
  return next
}

/**
 * turn 结束兜底：把所有还在 pending/running 的 tool part 标记为 completed。
 *
 * 某些控制流工具（ExitPlanMode、AskUserQuestion 等）在异常路径下可能既不发
 * tool.updated(kind:result) 也不发 kind:batch，导致工具永远停在 pending/running。
 * turn 结束是确定性的收尾点——此时未完成的工具必然已经结束（只是事件丢了）。
 */
function finalizePendingTools(messages: ZCodeMessage[], timestamp: number): ZCodeMessage[] {
  let changed = false
  const newMessages = messages.map((msg) => {
    if (msg.info.role !== 'assistant') return msg
    let partsChanged = false
    const parts = msg.parts.map((part) => {
      if (part.type === 'tool') {
        const st = part.state.status
        if (st !== 'pending' && st !== 'running') return part
        partsChanged = true
        const prevTime = part.state.time
        return {
          ...part,
          state: {
            ...part.state,
            status: 'completed' as const,
            time: { start: prevTime?.start ?? Date.now(), end: timestamp },
          },
        }
      }
      // turn 结束 = 思考必然已结束（即使收尾事件丢失），补上思考计时终点
      if (part.type === 'reasoning' && part.time?.start && !part.time.end) {
        partsChanged = true
        return { ...part, time: { start: part.time.start, end: timestamp } }
      }
      return part
    })
    if (!partsChanged) return msg
    changed = true
    return { ...msg, parts }
  })
  return changed ? newMessages : messages
}
