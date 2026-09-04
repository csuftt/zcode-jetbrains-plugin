/**
 * 编辑历史消息（对齐官方客户端 Edit History：zcode.z.ai/cn/docs/edit-history）
 *
 * 官方语义：只允许编辑【最后一轮】用户消息，改写后重新生成回复。
 * 协议实现（diag-edit-rewind.py / diag-rewind-meta.py 实测）：
 *   - 发送 `/rewind conversation <msgId>`（走 session/send 文本命令）——服务端
 *     把模型上下文截断到该消息之前（kept = 该消息之前的全部轮次）并落
 *     revert 元数据；rewind 自身作为一个 turn（turn.started → rewind.triggered
 *     → turn.completed，耗时百毫秒级）。
 *   - 重发编辑后的文本即完成「编辑重新生成」。
 *   - ⚠️ legacy 快照（session/messages）【不反映】截断：服务端 Rbt 过滤链要求
 *     revert.createdMessageID，而当前 CLI 的 rewind 实现不写该字段——目标轮
 *     在快照里原样保留（官方客户端走 v4 投影按 rewind.triggered 删行，不受
 *     影响）。前端必须自维护截断记忆：流式 rewind.triggered 事件实时截断内存
 *     消息 + persist kv 持久化各会话的已编辑轮，快照重拉时按「轮删除」规则
 *     重放（见 applyRewindCuts）。
 */

import type { ZCodeMessage } from '@/types/messages'
import { isAgentNotification, isCompactSummaryMessage } from './parseNotification'
import { getPersisted, setPersisted } from './persist'

/** 构造编辑用的 rewind 命令文本 */
export function buildEditRewindCommand(msgId: string): string {
  return `/rewind conversation ${msgId}`
}

/** 是否本插件编辑流程发出的 rewind 命令（乐观消息防御性识别；快照中命令轮已被服务端剪除）*/
export function isEditRewindCommand(text: string): boolean {
  return /^\/rewind\s+conversation\s+\S+/.test(text.trim())
}

/** rewind.triggered 事件 payload（实测形态：rewindId/scope/strategy/targetMessageId/branchCutAfterMessageId/branchGeneration/reason）*/
export interface RewindTriggeredPayload {
  rewindId?: string
  scope?: string
  strategy?: string
  targetMessageId?: string
  branchCutAfterMessageId?: string
  [key: string]: unknown
}

/** 是成功的会话级 rewind 事件则返回 targetMessageId，否则 null（workspace-only / 失败回退不截断转录）*/
export function asConversationRewind(payload: unknown): string | null {
  const p = payload as Partial<RewindTriggeredPayload>
  if (
    p &&
    typeof p.targetMessageId === 'string' &&
    (p.scope === 'conversation' || p.scope === 'both') &&
    p.strategy === 'active_chain'
  ) {
    return p.targetMessageId
  }
  return null
}

// ============ 截断记忆（persist kv） ============

/** kv key：sessionId → 已编辑轮的 targetMessageId 列表（按时间序追加）*/
const CUTS_KEY = 'zcode.edit.rewind-cuts'

type RewindCutsMap = Record<string, string[]>

function readCutsMap(): RewindCutsMap {
  const raw = getPersisted(CUTS_KEY)
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw) as RewindCutsMap
    if (obj && typeof obj === 'object') return obj
  } catch {
    /* 损坏按空处理 */
  }
  return {}
}

/** 读取会话的已编辑轮列表（空数组 = 无编辑史）*/
export function loadRewindCuts(sessionId: string): string[] {
  const cuts = readCutsMap()[sessionId]
  return Array.isArray(cuts) ? cuts.filter((x) => typeof x === 'string') : []
}

/** 追加一条编辑记录（rewind.triggered 确认成功后调用）*/
export function addRewindCut(sessionId: string, targetMsgId: string): void {
  const map = readCutsMap()
  const cuts = map[sessionId] ?? []
  if (!cuts.includes(targetMsgId)) cuts.push(targetMsgId)
  map[sessionId] = cuts
  setPersisted(CUTS_KEY, JSON.stringify(map))
}

/**
 * 对消息列表重放编辑截断（轮删除规则）：
 * 每个 cut = 删除 target 用户消息所在轮——从该消息起到下一条用户消息前的全部
 * （该轮的 assistant 回复一并删除），之后的轮次（编辑后新发的消息）保留。
 * cut 顺序应用即可还原多次编辑；targetId 找不到（已被更早 cut 覆盖 / 服务端
 * 未来版本自行截断了快照）时该 cut 无害跳过。
 */
export function applyRewindCuts(messages: ZCodeMessage[], cuts: string[]): ZCodeMessage[] {
  if (cuts.length === 0 || messages.length === 0) return messages
  let out = messages
  for (const targetId of cuts) {
    const tIdx = out.findIndex((m) => m.info.id === targetId && m.info.role === 'user')
    if (tIdx < 0) continue
    // 轮终点：其后第一条用户消息（真实用户消息——合成通知/摘要卡不算轮界）
    let end = out.length
    for (let i = tIdx + 1; i < out.length; i++) {
      const m = out[i]
      if (m.info.role === 'user' && !isAgentNotification(m.info) && !isCompactSummaryMessage(m.info)) {
        end = i
        break
      }
    }
    out = [...out.slice(0, tIdx), ...out.slice(end)]
  }
  return out
}

// ============ 可编辑判定 ============

/** 用户消息的可编辑附件检查：带图片/文件附件的消息不支持编辑（附件无法经 rewind 保留重发）*/
function hasEditableUnsupportedParts(m: ZCodeMessage): boolean {
  return (m.parts ?? []).some((p) => p.type === 'image' || p.type === 'file')
}

function userEditText(m: ZCodeMessage): string {
  return (m.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('\n')
}

/**
 * 找【最后一条】可编辑的真实用户消息（官方 Edit History 语义：仅最后一轮可编辑）。
 * 排除：子代理/任务回调通知卡、compact 摘要卡、乐观消息（local_u_，无服务端 id
 * 无法作为 rewind 目标）、带图片/文件附件（一期限制）、空文本、rewind 命令自身。
 * 消息列表应传 ChatView 渲染用的（已滤合成/已应用编辑截断）列表。
 */
export function findEditableUserMessage(messages: ZCodeMessage[]): ZCodeMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.info.role !== 'user') continue
    if (isAgentNotification(m.info) || isCompactSummaryMessage(m.info)) continue
    if (m.info.id.startsWith('local_u_')) continue
    if (hasEditableUnsupportedParts(m)) continue
    const text = userEditText(m)
    if (!text.trim() || isEditRewindCommand(text)) continue
    return m
  }
  return null
}
