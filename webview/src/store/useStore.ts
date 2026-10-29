/**
 * 全局状态（Zustand）
 *
 * 阶段 2.1-2.4 状态：
 *   - connectionStatus / projectPath
 *   - sessions / currentSessionId / messages
 *   - 流式：streaming（turn 是否进行中）、streamingMessageId、waitingSince
 *
 * 流式生命周期：
 *   sendMessage → subscribe（确保不丢事件）→ send → turn.started
 *   → model.streaming（累加 delta）→ tool.updated（更新状态）
 *   → turn.completed/failed → 重新拉 messages（确保数据一致）
 */

import { create } from 'zustand'
import { onMessage, onStreamEvent, onStreamBatch, sendToJava, initBridge, isInJcef, getWorkspacePath, getInitialSessionId, getTabWorkspacePath } from '@/ipc/bridge'
import { parseGoalCommand } from '@/utils/goalCommand'
import { extractTitleExcerpt } from '@/utils/titleExcerpt'
import type { JavaResponse, SessionInfo, OpenTabInfo, ZCodeMessage, StreamEvent, ModelOption, ModelManageProvider, ProviderSaveDraft, TodoItem, AgentItem, FileChangeItem, QuotaData, ModelUsageData, ToolUsageData, UsageRange, AppUsageData, AppUsageRange, ContextBreakdownItem, ContextSource, SessionDebugSummary, ThoughtLevelInfo, SubagentActivity, SubagentInfo, ToolUpdatedPayload, MemoryFileInfo, MemoryDirInfo, MemorySearchHitInfo, SkillInfo, McpServerInfo, McpToolsState, McpLogEntry, TrajectoryRecord, EnvStatus, BrowserClearedSite, BrowserDataOverview, AgentDef, AgentDefInput, ImageAttachmentInput, CurrentFileAttachmentInput, SendAttachmentInput, GoalState, AutoArchiveRecord, ToolPart, SlashCommand, MessagePart, TurnFileChangesMap, TurnFileChangeSummary } from '@/types/messages'
import { applyStreamEvent, isSubagentToolEvent, applySubagentToolEvent, markActivityOutcome, finalizeActivitiesFromNotifications, asSubagentLifecycle, asGoalTargetPayload, looksLikeQuotaError, asSteerDrainedInputs, appendSteerUserMessages } from '@/utils/streamReducer'
import type { TurnErrorInfo, SubagentLifecyclePayload } from '@/utils/streamReducer'
import { classifyQuotaError, bannerTriggerKey, providerLimitedMessage } from '@/utils/quotaWindows'
import type { QuotaBannerTrigger } from '@/utils/quotaWindows'
import { isDefaultSessionTitle } from '@/utils/format'
import { mergeSessionsIndex } from '@/utils/sessionIndexMerge'
import type { SessionIndexEntry } from '@/types/messages'
import i18n from '@/i18n/config'

/** 渠道/模型启停变更（modelToggled 应答与 onModelsChanged 广播同源）合并进管理页清单。
 *  change 含 modelId=模型级（改 models[].enabled），不含=渠道级（改 provider.enabled）。
 *  providers 未加载（null）时原样返回 null，不凭空初始化管理页列表。 */
export function applyModelToggleChanges(
  providers: ModelManageProvider[] | null,
  changes: { providerId: string; enabled: boolean; modelId?: string }[],
): ModelManageProvider[] | null {
  if (!providers) return null
  return providers.map((p) => {
    const provChange = changes.find((c) => c.providerId === p.providerId && c.modelId == null)
    const modelChanges = changes.filter((c) => c.providerId === p.providerId && c.modelId != null)
    if (!provChange && modelChanges.length === 0) return p
    const models = modelChanges.length
      ? p.models.map((m) => {
          const c = modelChanges.find((x) => x.modelId === m.modelId)
          return c ? { ...m, enabled: c.enabled } : m
        })
      : p.models
    return provChange ? { ...p, enabled: provChange.enabled, models } : { ...p, models }
  })
}

/** 前端诊断日志直落 idea.log（Java __jsLog 通道——console.warn 不被 JCEF 转发，
 *  2026-09-01 缺陷AO 追查踩坑：诊断必须走此通道才可见） */
function diagWarn(text: string): void {
  // 桥未就绪（启动早期注入竞态 / node 测试环境）不发：此时 sendToJava 落 mock
  // 兜底，__jsLog 无 mock 分支会弹"mock 不支持 op"错误
  const w = typeof window === 'undefined' ? undefined : window as unknown as Record<string, unknown>
  if (typeof w?.__ZCODE_CEF_QUERY__ !== 'function' && typeof w?.sendToJava !== 'function') return
  try { sendToJava({ op: '__jsLog', level: 'warn', text }) } catch { /* 诊断不设障 */ }
}

import { parseTodos, parseAgents, parseFileChanges, mergeAgentItems } from '@/utils/parseStatus'
import { parseBackgroundTaskWorks, parseDeliveredWorkStatuses } from '@/utils/backgroundTask'
import { isHiddenSyntheticMessage, isAgentNotification } from '@/utils/parseNotification'
import { mergeTurnMessages } from '@/utils/mergeTurnMessages'
import { getPersisted, setPersisted, removePersisted, entriesWithPrefix, isKvHydrated, KV_HYDRATED_EVENT } from '@/utils/persist'
import { QUOTA_BANNER_DISMISSALS_KEY, mergeLiveQuotaBannerDismissals, recordQuotaBannerDismissal } from '@/utils/quotaBannerDismissals'
import { readStatusPanelConfig, writeStatusPanelConfig } from '@/utils/statusPanelConfig'
import { addSteerMarkers, readSteerMarkers } from '@/utils/steerMarkers'
import { readEnhanceConfig } from '@/utils/enhanceConfig'
import { readCurrentFileConfig } from '@/utils/currentFileConfig'
import { readCuaInputButtonConfig, writeCuaInputButtonConfig } from '@/utils/cuaInputButtonConfig'
import { sameModel } from '@/utils/modelChoice'
import { extractBackgroundTaskIdFromContent } from '@/utils/backgroundTask'
import { fileContextPartFromAttachment } from '@/utils/fileContextParts'
import {
  buildEditRewindCommand,
  findEditableUserMessage,
  userEditText,
  userMessageImageParts,
  applyRewindCuts,
  loadRewindCuts,
  addRewindCut,
  stageRewindCut,
  commitStagedRewindCuts,
  asConversationRewind,
  type EditAttachmentInput,
} from '@/utils/editHistory'

export type ConnectionStatus = 'connecting' | 'connected' | 'mock' | 'error'

/** GLM 套餐 providerId（有 apiKey 可查额度；悬浮栏与额度定时轮询共用判定）*/
export const GLM_PLAN_PROVIDER = 'builtin:bigmodel-coding-plan'

/**
 * bigmodel 系渠道判定（额度查询的显示/拉取门）：
 * coding-plan 订阅与 API Key 自定义渠道（builtin:bigmodel）都查 bigmodel monitor——
 * 该 API 按 Key 所属账号返回套餐额度，同账号 API Key 查到的就是订阅套餐
 * （2026-09-15 用户实测，此前严格只认 coding-plan 导致 API Key 渠道悬浮框无额度）。
 * 第三方渠道（DeepSeek 等自定义 id）不命中，不查不显示——key 打不通 monitor 属预期。
 */
export function isBigmodelProvider(providerId?: string | null): boolean {
  return !!providerId && providerId.includes('bigmodel')
}

/** 子代理失败判定白名单（缺陷AO，2026-09-01）：仅这些 status 词判失败，
 *  未知词只当"未识别"跳过——此前"非成功白名单即失败"会把服务端新词误读成失败 */
const SUBAGENT_FAILURE_STATUSES = ['failed', 'error', 'interrupted', 'aborted', 'cancelled']

/** GLM 额度自动刷新间隔（ms）——悬浮栏/用量页「上次刷新」的更新节奏 */
const QUOTA_POLL_INTERVAL = 60_000

// ===== 流式静默对账看门狗（缺陷M，2026-08-19）=====
// CLI 升级/重启杀掉 app-server 后，会话经 resume 恢复的回合在服务端真实执行但
// 事件流零下发（background turn 不回发 session/event）——前端只认终止帧收尾，
// 无限转圈。看门狗在 streaming 且当前会话持续 STREAM_SILENCE_MS 无任何事件时，
// 每 STREAM_PROBE_INTERVAL_MS 静默拉一次 messages 快照（reconcile 标记，只读
// 判定不落地）：末尾已是完整 assistant 回复 → 回合已在服务端结束，收尾并落地
// 快照；快照连续 STREAM_DEAD_PROBES 轮毫无进展（尾部连 assistant 内容都没有）
// → 判定流丢失，收尾并提示。事件正常流动时阈值永不满足，探测是纯兜底。
const STREAM_SILENCE_MS = 60_000
const STREAM_PROBE_INTERVAL_MS = 10_000
// 判死轮数 4→8（2026-08-26 用户决策）：60s 探测启动不变，但死亡判定更谨慎——
// 无进展快照累计 8 轮（≈140s）才判死；服务端回合活跃（activeTurnId）随时清零。
// 对「服务端还活着只是慢」的合法静默更宽容，真断流发现延迟 ~100s → ~140s
const STREAM_DEAD_PROBES = 8
/** 最近一次当前会话流式活动（事件到达/消息发出）时刻——看门狗静默计时基准 */
let lastStreamActivityAt = 0
let streamWatchTimer: ReturnType<typeof setInterval> | null = null

// ===== v4 编辑 ack 兜底（正常路径由 rewind.triggered/turnEnded 收尾）=====
// op 应答本身无超时保证（JCEF 桥无超时回调），v4/command 双 CAS 尝试 + rowsRange
// 翻页最坏 ~50s+：90s 仍未见 rewind.triggered 确认（rewound=false）则按失败清理，
// 防「正在按编辑后的消息重新生成」指示器永久悬挂、队列 flush 被无限抑制
const EDIT_ACK_TIMEOUT_MS = 90_000
let editAckTimer: ReturnType<typeof setTimeout> | null = null

function cancelEditAckTimeout(): void {
  if (editAckTimer) {
    clearTimeout(editAckTimer)
    editAckTimer = null
  }
}

function armEditAckTimeout(): void {
  cancelEditAckTimeout()
  editAckTimer = setTimeout(() => {
    editAckTimer = null
    const replay = useStore.getState().editReplay
    if (replay?.via === 'v4' && !replay.rewound) {
      useStore.setState({
        editReplay: null,
        lastError: i18n.t('chat.edit.rewindFailed'),
      })
    }
  }, EDIT_ACK_TIMEOUT_MS)
}

/**
 * editRejected reason 码 → i18n key（2026-09-13 review：协议层不做 i18n，只发机器码，
 * 文案收口在五语言包；未知码/无码回退服务端 message 原文）。
 */
const EDIT_REJECT_REASON_KEYS: Record<string, string> = {
  missingParams: 'chat.edit.rejectMissingParams',
  attachmentResolveFailed: 'chat.edit.rejectAttachmentResolveFailed',
  notLatestUserMessage: 'chat.edit.rejectNotLatestUserMessage',
  commandFailed: 'chat.edit.rejectCommandFailed',
  internalError: 'chat.edit.rejectInternalError',
}

/** reason 码优先出五语文案，否则回退 message 原文，再兜底通用失败文案 */
function editRejectText(reason: unknown, message: string | undefined): string {
  const key = typeof reason === 'string' ? EDIT_REJECT_REASON_KEYS[reason] : undefined
  return (key ? i18n.t(key) : '') || message || i18n.t('chat.edit.rewindFailed')
}

/**
 * 编辑重发被服务端排队的防御（diag-edit-blocked 实锤）：回合「执行工具中」时
 * editUserQuery，服务端 abort 不生效 → 重发被 turn.steerQueued 静默排队且队列
 * 不自动排水——ack accepted 但编辑永不生效。stop-first 两段式编排下此事件仅在
 * 停止失败/竞态漏网时出现：明确失败并提示，防编辑指示器无限悬挂。
 * 匹配判据：payload.input 与编辑后文本一致（stop-first 后编辑文本只有本流程会发）。
 * @return true=命中编辑排队（调用方跳过后续处理）
 */
function handleEditSteerQueuedDefence(
  payload: unknown,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
): boolean {
  const p = payload as { input?: unknown }
  const replay = get().editReplay
  if (
    replay?.via === 'v4' &&
    typeof p.input === 'string' &&
    p.input.trim() !== '' &&
    p.input.trim() === replay.text.trim()
  ) {
    cancelEditAckTimeout()
    set({ editReplay: null, lastError: i18n.t('chat.edit.queuedNotApplied') })
    return true
  }
  return false
}

/* ============ 「已发出但被服务端排队」防御（缺陷FD） ============
 * legacy session/send 落在服务端"回合工作在途"窗口（stop 的异步拆卸里 / 取消通知
 * 批次起轮前）时会被 admitPrompt 静默降级为 delivery=queue：ack 正常、无任何错误，
 * 但消息不进转录、不开轮，且**不会自动排空**（回合取消时服务端置 queueAutoDrain=false，
 * 且队列排空是客户端职责——官方客户端用 v4 sendQueuedNow/setAutoDrain 促发）。
 * 服务端唯一信号 = turn.steerQueued 事件带 input 全文（deferred input 排队事件；
 * steer 自身的同名事件不带 input；编辑重发场景由 handleEditSteerQueuedDefence 先拦）。
 * 处置：调 Java promoteQueuedInput（v4 sendQueuedNow，官方客户端"立即发送"同款原语）
 * 把条目捞出立即执行；失败回退见 case 'promoteQueuedInput'。补插乐观气泡的原因：
 * 消息发出后 +300ms 的轮末快照会把它抹掉（服务端当时没有这条消息），不补插则促发
 * 成功后要等下一轮末重拉才可见（"实时流用户消息丢失"同族，见 editedUserBubble 注释）。
 */
interface RecentFlushedSend {
  sid: string
  text: string
  attachments?: SendAttachmentInput[]
  scheduledFireAt?: number
  at: number
}
const recentFlushedSends: RecentFlushedSend[] = []
const RECENT_FLUSH_TTL_MS = 60_000
const RECENT_FLUSH_MAX = 8
/** 促发在途记录（queueItemId → 上下文）：promoteQueuedInput 应答回来做兜底决策 */
const pendingQueuePromotions = new Map<
  string,
  { sid: string; text: string; attachments?: SendAttachmentInput[]; bubbleId: string }
>()
/** 已处置的 queueItemId（防事件重放二次促发；有界）*/
const handledQueueItems: string[] = []
const HANDLED_QUEUE_MAX = 20

/** 发送侧打点：doSend 真实发出时登记（供"被服务端排队"防御按文本认领）*/
function recordRecentFlushedSend(
  sid: string,
  text: string,
  attachments?: SendAttachmentInput[],
  scheduledFireAt?: number,
): void {
  recentFlushedSends.push({ sid, text, attachments, scheduledFireAt, at: Date.now() })
  if (recentFlushedSends.length > RECENT_FLUSH_MAX) {
    recentFlushedSends.splice(0, recentFlushedSends.length - RECENT_FLUSH_MAX)
  }
}

/** 乐观用户消息构造（sendMessage 与「已发出但被服务端排队」防御补插共用）：
 *  图片附件以 dataUrl 直渲（就地名接服务端 id 后 parts 不被帧覆盖），currentFile
 *  走轻量 file part（气泡 chip 回显「这条消息带了什么」） */
function optimisticUserMessage(
  sid: string,
  text: string,
  attachments?: SendAttachmentInput[],
  opts?: { id?: string; scheduledFireAt?: number },
): ZCodeMessage {
  return {
    info: {
      role: 'user',
      time: { created: Date.now() },
      id: opts?.id ?? `local_u_${Date.now()}`,
      sessionID: sid,
      ...(opts?.scheduledFireAt ? { scheduledFireAt: opts.scheduledFireAt } : {}),
    },
    parts: [
      ...(attachments ?? [])
        .filter((a): a is ImageAttachmentInput => a.kind === 'image')
        .map((a) => ({
          type: 'image' as const,
          mediaType: a.mimeType,
          dataUrl: `data:${a.mimeType};base64,${a.dataBase64}`,
          dataBase64: a.dataBase64,
          source: { kind: 'inline' as const, filename: a.filename },
        })),
      ...(attachments ?? [])
        .filter((a): a is CurrentFileAttachmentInput => a.kind === 'currentFile')
        .map(fileContextPartFromAttachment),
      { type: 'text', text },
    ],
  }
}

/**
 * 「已发出但被服务端排队」防御（缺陷FD，2026-10-19 真机实测定案）。
 * 命中时：登记促发在途、发出 promoteQueuedInput op，并返回"补插气泡"——
 * **调用方负责并入消息列表**（批处理路径必须进其 messages 本地累加器：直写
 * store 会被批末统一 set 覆盖；单推路径直接 set）。
 * 防重复：原乐观气泡若还没被轮末快照抹掉（currentMessages 里已有同文本 local_u_），
 * 复用其 id 且不重复补插（返回 true = 已处置无需插入）。
 * @return null=未命中（事件与本流程无关）；true=命中且气泡已在列表；ZCodeMessage=命中待插入
 */
function handleFlushedSendQueuedDefence(
  payload: unknown,
  sessionId: string,
  currentMessages: ZCodeMessage[],
): ZCodeMessage | true | null {
  const p = payload as {
    input?: unknown
    delivery?: unknown
    intent?: { queueItemId?: unknown }
    pendingInputId?: unknown
  } | null
  if (!p) return null
  const text = typeof p.input === 'string' ? p.input.trim() : ''
  if (!text) return null
  // 仅排队形态：guide 注入走 steerDrained 正常落位；delivery 缺省按排队处理
  if (typeof p.delivery === 'string' && p.delivery !== 'queue') return null
  const queueItemId = typeof p.intent?.queueItemId === 'string' && p.intent.queueItemId
    ? p.intent.queueItemId
    : typeof p.pendingInputId === 'string'
      ? p.pendingInputId
      : ''
  if (!queueItemId) return null
  if (handledQueueItems.includes(queueItemId)) return null // 事件重放：已处置过，静默忽略
  const now = Date.now()
  const idx = recentFlushedSends.findIndex(
    (r) => r.sid === sessionId && r.text.trim() === text && now - r.at < RECENT_FLUSH_TTL_MS,
  )
  if (idx < 0) return null
  const [rec] = recentFlushedSends.splice(idx, 1)
  handledQueueItems.push(queueItemId)
  if (handledQueueItems.length > HANDLED_QUEUE_MAX) handledQueueItems.shift()
  // 原乐观气泡健在（事件先于轮末快照到达）则复用，不重复补插
  const existing = currentMessages.find(
    (m) => m.info.role === 'user' && String(m.info.id).startsWith('local_u_') && userTextOf(m) === rec.text,
  )
  const bubbleId = existing ? String(existing.info.id) : `local_u_${Date.now()}`
  pendingQueuePromotions.set(queueItemId, {
    sid: sessionId,
    text: rec.text,
    attachments: rec.attachments,
    bubbleId,
  })
  diagWarn(`[store] 发送被服务端排队（繁忙窗口降级），尝试促发: ${queueItemId}`)
  sendToJava({ op: 'promoteQueuedInput', sessionId, queueItemId })
  if (existing) return true
  // 补插乐观气泡（可能已被轮末快照抹掉；服务端真身到达时按同文本自动顶替）
  return optimisticUserMessage(sessionId, rec.text, rec.attachments, {
    id: bubbleId,
    ...(rec.scheduledFireAt ? { scheduledFireAt: rec.scheduledFireAt } : {}),
  })
}

/* ============ 发送落位看门狗（缺陷FF，2026-10-20） ============
 * app-server 僵死形态（10-19 二例）：send 写入 stdin、服务端已开始构建模型请求
 * （providerRuntimeHeaders 触发）后进程整体挂死——ack 可能正常，但 turn.started
 * 永不到达、无任何错误，消息无痕丢失（session_input 无落账），UI 恒转圈直到重启。
 * 与 FD（delivery=queue 降级，有 steerQueued 事件可认领）互补，守的是「发出之后
 * 没有任何落位信号」的真空；send 显式报错（sourceOp=send，10s 请求超时/管道断）
 * 走秒级快路。落位信号：turn.started/turn.userInput 携带同文本、messages 应答中
 * 出现该文本（时间戳窗口防历史同文误认领）、turn.steerQueued 命中（移交 FD）。
 * 失败处置复用 FD removed=true 形态：撤乐观气泡 + 原文退回队列头（保真附件）+
 * 横幅；刻意不自动重发（与 FD 同裁定：防迟到重复，重发由用户一键触发）。
 * 防误报（集中声明，仿 probeTurnState 豁免清单）：同会话任何流事件到达即顺延
 * 截止（服务端活着不判死，长插队轮让位）、10min 硬帽、切会话失败静默丢弃
 * （FD 同裁定）、探测用普通 messages 拉取（不带 reconcile 标记，不与 M 看门狗
 * 的对账判决互扰）。
 */
interface PendingAdmission {
  sid: string
  text: string
  attachments?: SendAttachmentInput[]
  /** 乐观气泡 id（hiddenCommand 发送无气泡为 null） */
  bubbleId: string | null
  sentAt: number
  deadline: number
  /** 探测已发出（等 messages 应答或探测超时收尾） */
  probing: boolean
  probeDeadline: number
}
const pendingAdmissions = new Map<string, PendingAdmission>()
const ADMISSION_TIMEOUT_MS = 30_000
const ADMISSION_PROBE_TIMEOUT_MS = 20_000
const ADMISSION_HARD_CAP_MS = 600_000
const ADMISSION_TICK_MS = 5_000
const ADMISSION_MAX = 8
let admissionTicker: ReturnType<typeof setInterval> | null = null

function disarmAdmission(id: string): void {
  pendingAdmissions.delete(id)
}

/** 单例轮询哨：有在途凭据才跑，空了自停（编辑 ack 超时同款 module 级生命周期） */
function ensureAdmissionTicker(): void {
  if (admissionTicker) return
  admissionTicker = setInterval(() => {
    const now = Date.now()
    for (const [id, e] of Array.from(pendingAdmissions)) {
      if (!e.probing && now >= e.deadline) {
        startAdmissionProbe(e)
      } else if (e.probing && now >= e.probeDeadline) {
        failAdmission(id, 'unresponsive')
      }
    }
    if (pendingAdmissions.size === 0 && admissionTicker) {
      clearInterval(admissionTicker)
      admissionTicker = null
    }
  }, ADMISSION_TICK_MS)
}

function armAdmission(
  sid: string,
  text: string,
  attachments?: SendAttachmentInput[],
  bubbleId?: string,
): void {
  const t = text.trim()
  if (!t) return
  // 同会话同文本已有在途凭据：不重复登记（deadline 以先发为准）
  for (const e of pendingAdmissions.values()) {
    if (e.sid === sid && e.text === t) return
  }
  const id = `adm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  pendingAdmissions.set(id, {
    sid,
    text: t,
    ...(attachments?.length ? { attachments } : {}),
    bubbleId: bubbleId ?? null,
    sentAt: Date.now(),
    deadline: Date.now() + ADMISSION_TIMEOUT_MS,
    probing: false,
    probeDeadline: 0,
  })
  if (pendingAdmissions.size > ADMISSION_MAX) {
    // 有界（正常在途 ≤1~2 条）：最旧的直接撤哨让位
    const oldest = pendingAdmissions.keys().next().value
    if (oldest) disarmAdmission(oldest)
  }
  ensureAdmissionTicker()
}

/**
 * 失败收尾（notLanded=探测回来了但转录无此文本 / unresponsive=探测也超时 /
 * sendError=send 显式报错快路）：删凭据（防迟到 steerQueued 二次促发）+ 撤 FD
 * 打点（防退回队列后再被 FD 认领成双条）→ 切会话静默丢弃 → 撤气泡 + 队头重建 + 横幅。
 */
function failAdmission(id: string, kind: 'notLanded' | 'unresponsive' | 'sendError', detail?: string): void {
  const e = pendingAdmissions.get(id)
  if (!e) return
  pendingAdmissions.delete(id)
  const ridx = recentFlushedSends.findIndex((r) => r.sid === e.sid && r.text === e.text)
  if (ridx >= 0) recentFlushedSends.splice(ridx, 1)
  diagWarn(`[store] 发送落位看门狗收尾（${kind}）: ${e.text.slice(0, 60)}`)
  const st = useStore.getState()
  if (e.sid !== st.currentSessionId) return
  const requeued: QueuedMessage = {
    id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text: e.text,
    ...(e.attachments?.length ? { attachments: e.attachments } : {}),
    queuedAt: Date.now(),
  }
  useStore.setState({
    ...(e.bubbleId ? { messages: st.messages.filter((m) => m.info.id !== e.bubbleId) } : {}),
    queuedMessages: [requeued, ...st.queuedMessages],
    lastNotice:
      kind === 'unresponsive'
        ? i18n.t('input.queue.admissionServerUnresponsive')
        : kind === 'sendError'
          ? `${i18n.t('input.queue.sendFailedRequeued')}（${detail ?? ''}）`
          : i18n.t('input.queue.admissionTimeoutRequeued'),
  })
}

function startAdmissionProbe(e: PendingAdmission): void {
  e.probing = true
  e.probeDeadline = Date.now() + ADMISSION_PROBE_TIMEOUT_MS
  sendToJava({
    op: 'messages',
    sessionId: e.sid,
    workspacePath: useStore.getState().currentWorkspacePath,
  })
}

/**
 * 流事件预挂钩（批量/单推两路、会话过滤之前）：同文本落位认领 + 活性续期。
 * steerQueued 同文本命中也认领——FD 防御已接管促发，看门狗撤哨。
 */
function hookAdmissionStreamEvent(sessionId: string, event: StreamEvent): void {
  if (pendingAdmissions.size === 0) return
  let claimText = ''
  if (event.type === 'turn.started' || event.type === 'turn.userInput' || event.type === 'turn.steerQueued') {
    const p = event.payload as { input?: unknown; text?: unknown } | null
    claimText = typeof p?.input === 'string'
      ? p.input.trim()
      : typeof p?.text === 'string'
        ? p.text.trim()
        : ''
  }
  const now = Date.now()
  for (const [id, e] of Array.from(pendingAdmissions)) {
    if (e.sid !== sessionId) continue
    if (claimText && claimText === e.text) {
      disarmAdmission(id)
      continue
    }
    // 活性续期：同会话事件到达 = 服务端活着（落位可能排在别的轮后面），顺延截止；
    // 硬帽内才续（10min 仍无落位 = 深度异常，按期收尾）；探测中不顺延（等应答/超时）
    if (!e.probing && now - e.sentAt < ADMISSION_HARD_CAP_MS) {
      e.deadline = now + ADMISSION_TIMEOUT_MS
    }
  }
}

/** messages 应答扫描：非 local 气泡的 user 消息按「文本全等 + 创建时刻 ≥ 发出前 2s」
 *  认领（时间窗防历史同文如重复「继续」误认领）；探测中的凭据若未命中即收尾退回 */
function claimAdmissionsFromMessages(sessionId: string, messages: ZCodeMessage[]): void {
  if (pendingAdmissions.size === 0) return
  for (const [id, e] of Array.from(pendingAdmissions)) {
    if (e.sid !== sessionId) continue
    const landed = messages.some(
      (m) =>
        m.info.role === 'user' &&
        !String(m.info.id).startsWith('local_u_') &&
        userTextOf(m).trim() === e.text &&
        (m.info.time?.created ?? 0) >= e.sentAt - 2_000,
    )
    if (landed) {
      disarmAdmission(id)
    } else if (e.probing) {
      failAdmission(id, 'notLanded')
    }
  }
}

/** 测试隔离专用：清空落位凭据与轮询哨（账本/哨是模块级，页面生命周期语义） */
export function resetAdmissionWatchdog(): void {
  pendingAdmissions.clear()
  if (admissionTicker) {
    clearInterval(admissionTicker)
    admissionTicker = null
  }
}

/**
 * 编辑重放编排终点提前（2026-09-12 用户三轮反馈三）：editReplay 原本挂到编辑后
 * 新回合 turnEnded 才清，其间 editOpen/startEdit/submitEdit 三处守卫全挡——表现为
 * 「编辑一次后，实时会话中不允许再编辑」。turn.started（编辑重发的新回合）到达 =
 * rewind 已生效 + 服务端已用编辑文本重发，编排使命完成，此处提前退休：回合运行期
 * editReplay 为空 → 立即可再编辑（服务端对连续编辑无限制，diag-edit-double 实锤）。
 * 匹配条件保守：rewound（rewind.triggered 已消费——turn.started 可能先于截断事件
 * 到达，提前清会让气泡补插失去 editReplay 匹配）+ payload.input 与编辑文本一致
 * （确认是编辑重发回合而非巧合）；stopping（两段式第一段）不 retire。
 */
function retireEditReplayOnTurnStarted(
  payload: unknown,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
): void {
  const replay = get().editReplay
  if (!replay || replay.via !== 'v4' || !replay.rewound || replay.stopping) return
  const input = (payload as { input?: unknown } | undefined)?.input
  if (typeof input === 'string' && input.trim() === replay.text.trim()) {
    set({ editReplay: null })
  }
}

/**
 * 编辑重发截断后补插的用户气泡（v4 通道，2026-09-12 真机回归补）：
 * rewind.triggered 截断旧轮后，编辑后的新 user 消息在实时流里没有任何建立机制
 * （turn.started 只建 assistant 壳），要等轮末重拉才出现——表现为"实时流的用户
 * 消息丢失"。本地按 local_u_ 命名空间补插，turn.started 到达时文本与 payload.
 * input 一致 → 乐观改名机制自动对齐服务端 id（回合中编辑是就地改写语义，新消息
 * 复用同一 id；空闲编辑是新 id，同样命中）。附件渲染双形态：cache=FilePart url，
 * inline=ImagePart dataUrl。
 */
function editedUserBubble(
  replay: { text: string; attachments?: EditAttachmentInput[] },
  sid: string,
): ZCodeMessage {
  const imageParts = (replay.attachments ?? []).map((a): MessagePart =>
    a.source === 'cache'
      ? { type: 'file', mime: a.mime, url: a.url, filename: a.fileName }
      : {
          type: 'image',
          mediaType: a.mime,
          dataUrl: `data:${a.mime};base64,${a.dataBase64}`,
          dataBase64: a.dataBase64,
        },
  )
  return {
    info: { role: 'user', time: { created: Date.now() }, id: `local_u_${Date.now()}`, sessionID: sid },
    parts: [
      ...(replay.text ? [{ type: 'text', text: replay.text } as MessagePart] : []),
      ...imageParts,
    ],
  }
}

/**
 * rewind.triggered 共享核心（2026-09-13 review 收口：批量 handleStreamBatchDirect 与
 * 单推 handleStreamEvent 原各持一份近逐字拷贝，且气泡归属 sid 解析写法已漂移——
 * 两路径均有 sessionId===currentSessionId 守卫，统一由调用方传事件归属会话 id）。
 * 截断编辑目标轮到尾部 + 清理指向被删消息的流式壳；命中 editReplay 标记 rewound，
 * v4 通道补插编辑后用户气泡 + staged 判别落 kv（回合中编辑就地改写语义），否则/
 * legacy 走 addRewindCut 常规落记忆。纯计算 + kv 副作用，调用方按各自状态模型
 * 应用返回值（批量=局部变量批末一次 set，单推=立即 set）。
 */
function applyRewindTriggeredCore(
  messages: ZCodeMessage[],
  streamingMessageId: string | null,
  targetId: string,
  replay: StoreState['editReplay'],
  sid: string,
): { messages: ZCodeMessage[]; streamingMessageId: string | null; matched: boolean; viaV4: boolean } {
  let out = messages
  let outStreaming = streamingMessageId
  const tIdx = out.findIndex((m) => m.info.id === targetId && m.info.role === 'user')
  if (tIdx >= 0) {
    out = out.slice(0, tIdx)
    if (outStreaming && !out.some((m) => m.info.id === outStreaming)) outStreaming = null
  }
  if (replay?.targetMsgId === targetId) {
    if (replay.via === 'v4') {
      out = [...out, editedUserBubble(replay, sid)]
      stageRewindCut(sid, targetId, replay.text)
    } else {
      addRewindCut(sid, targetId)
    }
    return { messages: out, streamingMessageId: outStreaming, matched: true, viaV4: replay.via === 'v4' }
  }
  addRewindCut(sid, targetId)
  return { messages: out, streamingMessageId: outStreaming, matched: false, viaV4: false }
}

/**
 * turnEnded 编辑编排收尾（2026-09-13 review 收口：批量/单推两路径逐字拷贝）：
 * stopping=两段式第一段（stop 收尾）转第二段发编辑命令（服务端走空闲编辑路径，
 * ack 兜底定时器此刻才起算）；v4 非 stopping（编辑后新回合）回合结束即终点（含
 * 失败回合——编辑本身已生效）；legacy 通道 rewound 未确认或回合失败 → 截断未生效，
 * 放弃重发并提示。无 editReplay 时不做任何事。
 */
function finalizeEditReplayOnTurnEnd(
  turnError: TurnErrorInfo | undefined,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
): void {
  const replay = get().editReplay
  if (!replay) return
  if (replay.via === 'v4' && replay.stopping) {
    const sid = get().currentSessionId
    if (turnError || !sid) {
      set({ editReplay: null, ...(turnError ? {} : { lastError: i18n.t('chat.edit.rewindFailed') }) })
    } else {
      // 回合已死，发第二段（服务端走空闲编辑路径）；ack 兜底定时器此刻才起算
      set({ editReplay: { ...replay, stopping: false, ackPending: true } })
      armEditAckTimeout()
      sendToJava({
        op: 'editUserQuery',
        sessionId: sid,
        messageId: replay.targetMsgId,
        newText: replay.text,
        ...(replay.attachments ? { attachments: replay.attachments } : {}),
      })
    }
  } else if (replay.via === 'v4') {
    // 命令在途（ack 未回）：v2 旧回合停止的双终点（真实 + 遥测合成）中第二个
    // 终点落在此窗口——是旧回合余波而非「编辑后新回合已结束」，不能按 rewound
    // =false 误判失败（真机 23:02 实锤：139ms 窗口被击穿）。继续等 editAccepted
    // （v2 乐观截断）或 ack 超时兜底
    if (!replay.rewound && replay.ackPending) return
    cancelEditAckTimeout()
    set({
      editReplay: null,
      ...(!replay.rewound ? { lastError: i18n.t('chat.edit.rewindFailed') } : {}),
    })
  } else if (!replay.rewound || turnError) {
    set({
      editReplay: null,
      ...(turnError ? {} : { lastError: i18n.t('chat.edit.rewindFailed') }),
    })
  }
}

// ===== 切换模型后首回合零输出提示（2026-08-30 定时 flush 挂死事故）=====
// 定时消息 flush 携带切模型时 setModel+send 紧贴 turn.completed 背靠背发出，实测会把
// 该会话新模型的运行时状态在服务端写坏（随会话记录落盘，重启 IDEA 不愈）：此后该模型
// 每个回合 turn.started 后零输出零完成零报错，而 session.updated 心跳不断重置静默看门狗
// 计时、usage 轮询又确认回合活跃——既有看门狗对本故障结构性失明。此处只提示不判定：
// 切换落定后 20s 内开始的回合，60s 仍无任何模型输出事件则提示可停止重发/切回原模型。
// max 思考级别的合法静默思考可能误触（提示可关闭、无自动动作，代价可接受）
let lastModelSetAckAt = 0
let turnHasModelOutput = false
let stallHintTimer: ReturnType<typeof setTimeout> | null = null

function cancelSwitchStallHint(): void {
  if (stallHintTimer) {
    clearTimeout(stallHintTimer)
    stallHintTimer = null
  }
}

function armSwitchStallHint(
  sessionId: string,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
): void {
  cancelSwitchStallHint()
  if (Date.now() - lastModelSetAckAt > 20_000) return
  stallHintTimer = setTimeout(() => {
    stallHintTimer = null
    const st = get()
    if (st.currentSessionId !== sessionId) return
    if (!st.streaming || st.compacting) return
    if (turnHasModelOutput) return
    set({ lastNotice: i18n.t('app.modelSwitchStallHint') })
  }, 60_000)
}

/**
 * 等模型切换落定后再放行发送。定时 flush 携带切模型时 setModel+send 相距毫秒级、且紧贴
 * 上一回合 turn.completed，正好撞进服务端回合清算滞后窗口（Java applyPendingModelSwitch
 * 注释：事件已到、锁未放，偶发 -32603）——2026-08-30 实测会把该会话新模型运行时状态写坏
 * 并随会话落盘（此后该模型所有回合无声挂死）。等 modelSet ack 再缓冲 500ms，对齐手动
 * 「切换→发送」的天然健康间隔（实测 ~1.5s 间隔正常出流）。上限 6s：ack 迟迟不回也放行，
 * 不阻塞发送——放行后 send 自带目标 runtimeModel 保证本回合正确，回合结束 Java
 * applyPendingModelSwitch 补发才把模型真正落定持久化（send 携带只保单回合）；两者同目标
 * 幂等，modelSet ack 时 prev==to 不合成第二张切换卡，是设计内的双保险而非重复切换
 *（review Spec② 厘清：此处不能 cancelModelSwitch 撤补发——撤了模型只活在单回合）。
 * sessionId 给定时把该会话的挂起切换（modelPendingSwitch，回合中切换被 Java 挂起、
 * 回合结束才补发）一并纳入等待——否则挂起态在途标记已被 modelSetPending 清除，
 * 等待空转，send 抢在补发前发出（2026-09-14 排队消息按旧模型发出实测）。
 */
function waitForModelSwitchSettled(maxWaitMs = 6000, sessionId?: string): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      const st = useStore.getState()
      const pendingSwitch = sessionId != null && st.modelPendingSwitch?.sessionId === sessionId
      if ((isModelSwitchInFlight(st) || pendingSwitch) && Date.now() - start < maxWaitMs) {
        setTimeout(tick, 100)
        return
      }
      setTimeout(resolve, 500) // ack 只代表 RPC 回包，再给服务端状态收敛留一拍
    }
    tick()
  })
}

/** 润色/浏览器数据操作的兜底定时器句柄：回包或新请求发起时取消。
 *  不取消的话，残留定时器可在下一次同类请求的在途窗口内命中
 *  `get().xxx` 在途标志，误杀 loading 并注入上一次的错误文案 */
let enhanceTimer: number | undefined
/** 润色代际守卫（issue #22：润色中关弹窗即放弃本次）：发起时自增并记为活动代，
 *  关闭弹窗作废（置 null），Java 回包透传 seq，reducer 只认活动代——迟到的
 *  在途回包直接丢弃，不把已关的弹窗再顶出来，也不覆盖/误杀下一次润色 */
let enhanceSeqCounter = 0
let enhanceActiveSeq: number | null = null
const browserBusyTimers = new Map<string, number>()
function cancelEnhanceTimer(): void {
  if (enhanceTimer !== undefined) {
    clearTimeout(enhanceTimer)
    enhanceTimer = undefined
  }
}
function armBrowserBusyTimer(mode: string, onFire: () => void, ms = 30_000): void {
  cancelBrowserBusyTimer(mode)
  browserBusyTimers.set(mode, window.setTimeout(() => {
    browserBusyTimers.delete(mode)
    onFire()
  }, ms))
}
function cancelBrowserBusyTimer(mode: string): void {
  const t = browserBusyTimers.get(mode)
  if (t !== undefined) {
    clearTimeout(t)
    browserBusyTimers.delete(mode)
  }
}

/**
 * turnHeader entityId → 宿主 assistant 消息 id 换算。
 * 服务端 turnHeader 行的 entityId = productTurnId（常态=该轮 user 消息 id，product-projection
 * 3661 实证；也可能是轮 id 变体），不是 assistant 消息 id——逐条换算：
 * ① id 命中 assistant 消息 → 直接用（重扫路径 Java 侧已解析 assistantId）
 * ② id 命中 user 消息 → 取其后第一条 assistant（该轮回复）
 * ③ 都命中不了 → null（调用方决定挂起或丢弃）
 */
function resolveTurnFileHost(messages: ZCodeMessage[], messageId: string): string | null {
  const idx = messages.findIndex((m) => m.info.id === messageId)
  if (idx < 0) return null
  const hit = messages[idx]
  if (hit.info.role === 'assistant') return messageId
  for (let i = idx + 1; i < messages.length; i++) {
    if (messages[i].info.role === 'assistant') return messages[i].info.id
  }
  return null
}

/** 匹配失败的挂起队列（流式轮收尾时 user 消息还是乐观 id，等轮末权威重拉后重试） */
let pendingTurnFileEvents: StreamEvent[] = []

/** 更改条链路诊断：JCEF console 不转发，走 __jsLog 直落 idea.log（真机排障入口） */
function tfcLog(text: string): void {
  sendToJava({ op: '__jsLog', level: 'warn', text: `[tfc] ${text}` })
}

/**
 * 逐轮文件更改摘要落地（B2 回合产物）：turn.fileChanges 事件的幂等归并。
 * 事件源三路（标题订阅快照/增量、turnFileChangesSync 重扫），数据同源幂等——
 * 换算宿主 assistant 消息 id 后以它为键整体覆盖。
 *
 * 键漂移问题（真机实证「结束瞬间出现→被重拉顶掉」）：事件锚定到的是**当时列表**
 * 的 assistant 消息——流式期的壳 id 与轮末权威重拉后的真身 id 可能不同，整包替换
 * 后键失配即消失。entry 保留原始锚（_anchor=payload.messageId），快照落地时统一
 * 重锚定（remapTurnFileChangeKeys）。
 */
function applyTurnFileChanges(
  event: StreamEvent,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
  allowPending = true,
) {
  const p = event.payload as {
    messageId?: string
    rowId?: number
    fileChanges?: { additions?: number; deletions?: number; files?: number; state?: string }
    canRewindFiles?: boolean
  }
  const messageId = p.messageId
  const fc = p.fileChanges
  if (
    !messageId ||
    !fc ||
    typeof fc.additions !== 'number' ||
    typeof fc.deletions !== 'number' ||
    typeof fc.files !== 'number' ||
    typeof p.rowId !== 'number'
  ) {
    return
  }
  const host = resolveTurnFileHost(get().messages, messageId)
  if (!host) {
    // 宿主未落地（流式乐观 user id 未被服务端 id 替换/快照窗口外）：挂起等快照重试
    if (allowPending && pendingTurnFileEvents.length < 64) {
      pendingTurnFileEvents.push(event)
      tfcLog(`pending anchor=${messageId} (host not in messages, queued=${pendingTurnFileEvents.length})`)
    } else {
      tfcLog(`drop anchor=${messageId} (host not in messages, allowPending=${allowPending})`)
    }
    return
  }
  const entry: TurnFileChangeSummary = {
    rowId: p.rowId,
    additions: fc.additions,
    deletions: fc.deletions,
    files: fc.files,
    ...(fc.state === 'reverted' ? { state: 'reverted' as const } : fc.state === 'active' ? { state: 'active' as const } : {}),
    canRewind: p.canRewindFiles === true,
    _anchor: messageId,
  }
  set({ turnFileChanges: { ...get().turnFileChanges, [host]: entry } })
  tfcLog(`apply sid=${event.sessionId.slice(-8)} anchor=${messageId.slice(-12)} host=${host.slice(-12)} files=${fc.files} state=${fc.state ?? '-'}`)
}

/**
 * 键重锚定（applyMessagesSnapshot 落地后调用）：壳 id→真身 id 漂移自愈。遍历已有
 * map，用每条的 _anchor 在新列表重新解析宿主；解析不到（窗口外/会话已切）保留原键。
 */
function remapTurnFileChangeKeys(
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  const cur = get().turnFileChanges
  const keys = Object.keys(cur)
  if (keys.length === 0) return
  let next: TurnFileChangesMap | null = null
  for (const key of keys) {
    const entry = cur[key]
    if (!entry?._anchor) continue
    const host = resolveTurnFileHost(get().messages, entry._anchor)
    if (host && host !== key) {
      if (!next) next = { ...cur }
      delete next[key]
      next[host] = entry
      tfcLog(`remap ${key.slice(-12)} -> ${host.slice(-12)} (anchor=${entry._anchor.slice(-12)})`)
    }
  }
  if (next) set({ turnFileChanges: next })
}

/** 快照落地后 flush 挂起的更改事件（权威消息 id 已就位；仍匹配不上的丢弃——
 *  窗口外语义，下次重开会话由 turnFileChangesSync 重扫补齐）。跨会话事件丢弃：
 *  挂起期间用户可能已切走，宿主换算必须对当前会话的 messages 做 */
function flushPendingTurnFileChanges(
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  if (pendingTurnFileEvents.length === 0) return
  const queued = pendingTurnFileEvents
  pendingTurnFileEvents = []
  const sid = get().currentSessionId
  for (const ev of queued) {
    if (ev.sessionId !== sid) continue
    applyTurnFileChanges(ev, set, get, false)
  }
}

/**
 * 会话视图清空基底（切会话/清空待命/新建会话/删除当前会话/newSession 五处共用）：
 * 清掉绑定旧会话的消息、流式、队列与底部栏/子代理派生数据。
 * 各调用点的差异字段（loadingMessages/thoughtLevel/currentMode/弹窗关闭/compacting/
 * 模型切换在途标记等）由调用方 spread 覆盖或另行补充，语义注释留在差异现场。
 */
function sessionResetBase(): Partial<StoreState> {
  return {
    messages: [],
    streaming: false,
    streamingMessageId: null,
    waitingSince: null,
    queuedMessages: [],
    steerCancelRestore: null,
    goal: null,
    todos: [],
    agents: [],
    fileChanges: [],
    // 转录重建的后台任务（与 agents 同生命周期：切会话清空，等 messages 重解析；
    // 运行时投影在 backgroundWorksBySession 独立存，两者读取处合并）
    backgroundWorksFromTranscript: [],
    deliveredWorkStatuses: new Map(),
    // 逐轮更改条与弹窗绑定当前会话（重开由 turnFileChangesSync 重扫补齐）
    turnFileChanges: {},
    turnFileChangesDialogFor: null,
    turnFileChangesDialogPath: null,
    turnFileChangesDialogRewind: false,
    subagentActivities: [],
    subagents: [],
    subagentDetail: null,
    childMessages: {},
    childMessagesError: null,
    childSessionKeys: {},
    childSessionV4: {},
    childLiveMessages: {},
    childStreamingIds: {},
    // 编辑态与重放编排绑定当前会话，切会话作废
    editingMessageId: null,
    editReplay: null,
    editViaV4: null,
    // 计划审批两标记绑定会话（缺陷CG）：旧会话的弹窗应答与 agent 计划阶段不带到
    // 新会话——新会话若在 plan，历史回放的 enter_plan 推断会重新置位
    planApprovalAnswer: null,
    agentPlanActive: false,
  }
}
let reconcileProbeInFlight = false
let reconcileProbeSentAt = 0
let reconcileDeadCount = 0
let reconcileLastFingerprint = ''
/** 最近 usage 轮询确认的服务端活跃回合 id（null = 无活跃回合 / 旧 CLI 不上报）。
 *  后台任务等待、长工具执行等合法静默段，activeTurnId 持续有值（实测 sleep 90
 *  全程 activeTurnKind=regular）——看门狗据此区分"可预期等待"与"真流丢失"：
 *  快照无进展但服务端回合仍活跃 = 继续等待，不判死（见 classifyReconcileSnapshot） */
let serverActiveTurnId: string | null = null
/** 客户端最近处理过 turn.completed/failed 的回合 id：usage 响应的 activeTurnId
 *  与之相同 = 服务端清算滞后的「已完成那轮」读数，不得据此复活压缩指示器 */
let lastCompletedTurnId: string | null = null
/** locateSession 在途应答的解析器（单槽，见 locateSessionTab）*/
let pendingTabLocate: ((found: boolean) => void) | null = null
/** listOpenSessions 在途应答解析器（单槽瞬态查询，不入 store state）*/
let pendingOpenTabs: ((tabs: OpenTabInfo[]) => void) | null = null
/** goal set 乐观插入的用户消息（error 回执时回滚删除用；成功开轮后由全量
 *  重拉的服务端真身自然替换，槽位随下一次 set 覆盖） */
let optimisticGoalUserMsg: { sid: string; msgId: string } | null = null
/** 本轮压缩态是否被服务端 activeTurnKind 确认过（滞后读数不算）：只允许"确认过
 *  后的缺失"清除压缩指示器——旧版 zcode.cjs 不上报该字段，无条件清会把 /compact
 *  的指示器在首个轮询样本就抹掉（维持旧客户端"字段缺失不动作"语义） */
let compactingServerConfirmed = false

/* ============ 压缩回合结束后的延迟 flush（快照落地优先于排队消息抢跑） ============
 * 压缩摘要卡/时间线屏障只能靠回合结束后的重拉快照落地（压缩回合事件流全程静默、
 * 不建流式气泡）。若 turn 结束立即 flushQueue，排队消息抢先开启新 turn，重拉响应
 * 到达时 streaming=true 被 case 'messages' 丢弃（防断流/叠字的守卫不能放开）→
 * 摘要卡整个新回合期间缺失（2026-08-22 实测：/compact 期间排队一条消息，压缩
 * 结束消息立即发出，压缩结果显示丢失）。故压缩回合结束且队列非空时延迟 flush
 * 到快照落地之后；快照迟迟未回由兜底超时照常 flush（队列不卡死）。 */
let deferredCompactFlushSid: string | null = null
let deferredCompactFlushTimer: ReturnType<typeof setTimeout> | null = null
/** 压缩结束后重拉快照的请求发出时刻（0=不在途）：大历史会话快照端到端可远超
 *  兜底窗口（实测 727 条/7.7MB 耗 1.7s），兜底须在途续等而非抢跑 flush */
let compactSnapshotInFlightAt = 0
/** 压缩回合结束：登记延迟 flush（快照落地即触发；1.5s 兜底防快照丢失卡队列）。
 *  兜底触发时若快照仍在途（发出未回）则续等——快照到达走落地正路径 flush；
 *  仅在途超 5s（请求死亡）才硬 flush（2026-08-24 实测：大快照 1.7s 到达晚于
 *  1.5s 兜底，抢跑 flush 让 streaming 守卫丢弃快照、摘要卡整轮缺失） */
function scheduleDeferredCompactFlush(sessionId: string): void {
  deferredCompactFlushSid = sessionId
  if (deferredCompactFlushTimer) clearTimeout(deferredCompactFlushTimer)
  deferredCompactFlushTimer = setTimeout(() => {
    deferredCompactFlushTimer = null
    const sid = deferredCompactFlushSid
    if (sid === null) return
    if (compactSnapshotInFlightAt > 0 && Date.now() - compactSnapshotInFlightAt < 5000) {
      scheduleDeferredCompactFlush(sid) // 续等一轮（落地正路径到达会清掉本意图）
      return
    }
    deferredCompactFlushSid = null
    // 切会话后不代发（队列随会话切换处理，旧会话的延迟意图作废）
    if (sid === useStore.getState().currentSessionId) {
      useStore.getState().flushQueue()
    }
  }, 1500)
}
/** 快照落地后触发延迟 flush（sessionId 不匹配则作废该意图）*/
function tryRunDeferredCompactFlush(sessionId: string): void {
  if (!deferredCompactFlushSid || deferredCompactFlushSid !== sessionId) return
  if (deferredCompactFlushTimer) {
    clearTimeout(deferredCompactFlushTimer)
    deferredCompactFlushTimer = null
  }
  deferredCompactFlushSid = null
  useStore.getState().flushQueue()
}

/* ============ 后台任务结束/轮开始 → 转录通知拉取（缺陷CI） ============
 * 通知合成消息（task-notification / subagent-message）由 CLI 注入转录但不发
 * 流式事件，webview 只能靠全量快照获知；回合中快照又被流式守卫拦——卡片
 * 永远滞后到轮末重拉。两个实时触发源，共用同一防抖拉取：
 *   1. 任务结束信号（session.updated status≠running）：完成时刻即发（diag 实验实测
 *      t+28s 完成 vs t+55s 注入）——覆盖「无活跃回合时完成」的即时落地；
 *   2. turn.started：CLI 的转录注入轮界锁存（回合中完成的通知拖到轮界才进转录，
 *      随后唤醒的 wake 轮开始时注入必已落地）——wake 轮开始即拉，卡片在 wake 轮
 *      开场就出现，不必等它跑完。
 * 固定延迟不顺延（密集完成不饿死，在途拉取已覆盖先行完成）；延迟 600ms 给
 * 转录写入留窗口，也把一波触发合并成一次拉取。闲时快照直接落地、忙时走
 * 流式合并（只摘新增通知卡）。 */
let notificationPullTimer: ReturnType<typeof setTimeout> | null = null
function scheduleNotificationTranscriptPull(sessionId: string): void {
  if (sessionId !== useStore.getState().currentSessionId) return
  if (notificationPullTimer) return
  notificationPullTimer = setTimeout(() => {
    notificationPullTimer = null
    const st = useStore.getState()
    if (sessionId !== st.currentSessionId) return // 切会话后不代拉
    sendToJava({ op: 'messages', sessionId, workspacePath: st.currentWorkspacePath })
  }, 600)
}

/** 排队消息（对话进行中 Enter 入队，回合结束自动发送；text 为拼好技能/文件引用的最终文本）*/
export interface QueuedMessage {
  id: string
  text: string
  /** 附件（图片内联 / 当前文件上下文描述，随消息透传 session/send attachments）*/
  attachments?: SendAttachmentInput[]
  queuedAt: number
  /** 定时消息来源标记（fireAt 原值）：切会话丢弃队列时回退挂起而非静默丢 */
  scheduledFireAt?: number
  /** 定时消息的执行模型（随队列透传；可空=跟随会话当前模型）*/
  scheduledProviderId?: string
  scheduledModelId?: string
}

/** 定时消息（会话内指定时间执行的提示词；权威列表在 Java 侧，此处为镜像）*/
export interface ScheduledMessageItem {
  id: string
  sessionId: string
  workspacePath: string
  text: string
  /** 计划执行时间（epoch ms 绝对值）*/
  fireAt: number
  createdAt: number
  /** 切会话回退的挂起项：永不自动发，卡片呈「已过期」态等用户手动决定 */
  hold?: boolean
  /** 执行模型（可空=跟随会话当前模型；执行时清单里不存在则默认兜底）*/
  providerId?: string
  modelId?: string
}

/** 已发定时消息记录（真发后 Java 留存；服务端消息不带定时标记，渲染时按此匹配补徽标）*/
export interface ScheduledFiredRecord {
  sessionId: string
  text: string
  fireAt: number
  firedAt: number
}

/** 后台任务账本：key = 触发任务的 toolCallId（同一回合并发多个后台任务互不覆盖）。
 *  endedAt 有值 = 任务已完成（完成通知标记）：UI 保留「后台完成」标识与定格耗时；
 *  会话级清除点（切/删会话等）整本清空 */
type BackgroundTaskMap = Record<string, { id: string; startedAt: number; endedAt?: number }>

interface StoreState {
  // 连接
  connectionStatus: ConnectionStatus
  lastError: string | null
  projectPath: string

  /** 关联目录列表（多目录会话·变体A：project 级 kv 持久化，Java getLinkedWorkspaces 应答）*/
  linkedWorkspaces: string[]
  /** 激活目录（会话列表/新建会话落位的 workspace；空 = 未初始化，视同 projectPath）*/
  activeWorkspacePath: string
  /** 标签初始目录（多目录会话，Java 注入一次性值）：仅 boot 首拉列表使用（绑定会话
   *  恢复依赖），消费后即清——落位/chips 不随"标签打开了别的目录的旧会话"漂移 */
  bootWorkspace: string
  /** boot 首拉在途（多目录会话）：首拉响应处理完（恢复或未命中）即把列表作用域静默
   *  切回落位目录并重拉——chips 高亮（=落位）与列表一致（真机 2026-10-28：重启后
   *  高亮本项目但列表停在关联目录） */
  bootRestorePending: boolean
  /** 当前 sessions 列表所属目录（最近一次 loadSessions 请求的 workspace；跨目录切
   *  换后 staleLocal 补插与 boot 恢复都按它过滤，防旧目录条目残留/误恢复）*/
  sessionsWorkspace: string
  /** 会话列表加载中（切目录即置位+清空旧列表：用户拍板"切换应清空现有+加载动画"，
   *  旧目录列表残留展示比空白更误导）；响应到达或被乱序丢弃时清 */
  sessionsLoading: boolean

  /** 驻留水位提醒（缺陷BA）：Java 账本预计打开会话后越过服务端驻留阈值时由 subscribed 应答置位 */
  residentPoolNotice: string | null

  /** AI 标题重新生成进行中（会话 id；null=空闲。全局单飞，与 Java 侧 AtomicBoolean 对应）*/
  titleRegeneratingSessionId: string | null
  /** AI 标题重新生成的失败提示（App 通栏展示，自动消失）*/
  sessionTitleRegenError: string | null

  // 运行环境（node / zcode.cjs / 凭证三件套）
  /** null = 尚未检测完成（init 异步拉取）；allOk=false 时主界面显示环境提醒条 */
  envStatus: EnvStatus | null
  /** envSave 请求进行中（设置页环境 tab 保存按钮禁用/转圈）*/
  envSaving: boolean
  /** EnvBanner「去设置」的跳转意图：App 切 settings 视图同时置位，BasicSettingsView 消费后清除 */
  pendingSettingsSection: 'env' | 'agents' | 'models' | 'hooks' | null

  // 网络代理（与 ZCode 客户端共享 ~/.zcode/v2/setting.json，issue #12）
  /** null = 尚未拉取（进设置页环境 tab 时拉取）；restartPending=app-server 在跑、保存后需重启吃到新代理 */
  proxyConfig: { httpProxy: string; noProxy: string; caCertPath: string; restartPending: boolean } | null
  /** setProxyConfig 保存进行中（保存按钮转圈）*/
  proxySaving: boolean

  // 会话
  sessions: SessionInfo[]
  /** 本地乐观标题（sessionId → 临时标题）：首条消息发送即占位，服务端正式标题到达即清除。内存态，不持久化（不能盖手动重命名）*/
  provisionalTitles: Record<string, string>
  currentSessionId: string | null
  currentWorkspacePath: string
  /**
   * 放弃 boot 会话恢复：listSessions 的「恢复标签绑定会话」只允许在标签启动后自动生效
   * 一次。用户主动进入待命态（新建会话 / 删除当前会话）置 true——注入的初始会话 id
   * 运行期不更新（clearTabSession 只清 Java 侧 TabState），而待命态下 listSessions 会被
   * 任意会话回合 ended 的相位广播（300ms 防抖刷新，无 currentSessionId 守卫）、自动归档
   * 扫描完成等后台触发；不放弃就会把旧绑定会话无声 selectSession 回来：待命态打字一两
   * 分钟后跳回旧会话、输入框草稿随 scope 切换被带走（2026-10-13 真机反馈）。
   * 首帧快照缺绑定会话时不置位（慢快照容错，后续列表继续尝试恢复）。
   */
  skipInitialSessionRestore: boolean
  /** 建会话请求进行中（手动 + 或懒创建），期间防重入 */
  creatingSession: boolean
  /** 懒创建暂存的首条消息：无会话时发送 → 先建会话，createSession 响应后自动发出 */
  pendingFirstMessage: string | null
  /** 懒创建暂存的首条消息的附件（与 pendingFirstMessage 同生命周期）*/
  pendingFirstAttachments: SendAttachmentInput[] | null
  /** 懒创建暂存首条消息的定时标记（定时消息在待命态触发懒创建时随行，徽标穿透）*/
  pendingFirstScheduledFireAt: number | null
  /** 待命态定时任务暂存：创建确认时先把会话建好（真实 sid 归属，防空串态跨标签串显），建好自动落库 */
  pendingScheduleCreation: { text: string; fireAt: number; providerId?: string; modelId?: string; keepCurrent?: boolean } | null
  /** 待命态目标暂存：新标签无会话时 /goal set 先建会话（控制轮需要会话语境），建好自动下发 */
  pendingGoalCreation: { objective: string } | null
  /** 已归档会话（回收站视图，独立于 sessions；用户进入「已归档」tab 时拉取）*/
  archivedSessions: SessionInfo[]
  /** 已归档列表加载中（tab 切换/归档后刷新的 loading 态）*/
  archivedLoading: boolean

  // 消息
  messages: ZCodeMessage[]
  loadingMessages: boolean

  // 状态面板（对齐 cc-gui StatusPanel，从 messages 解析）
  todos: TodoItem[]
  agents: AgentItem[]
  fileChanges: FileChangeItem[]

  // 逐轮文件更改条（B2 回合产物：turnHeader.fileChanges 订阅直出，key=回复消息 id）
  turnFileChanges: TurnFileChangesMap
  /** 打开更改详情弹窗的轮（key 同上；null=关闭） */
  turnFileChangesDialogFor: string | null
  /** 弹窗初始定位的文件 path（文件行「审查」按钮用；null=默认首个） */
  turnFileChangesDialogPath: string | null
  /** 弹窗打开即进撤销模式（头部「撤销」按钮直达预览） */
  turnFileChangesDialogRewind: boolean

  // 子代理（流式实时聚合 + session/subagents RPC 权威列表 + 详情弹窗）
  /** 流式期间从 tool.updated(source=subagent) 实时聚合的活动（键 = Agent 工具 callID）*/
  subagentActivities: SubagentActivity[]
  /** session/subagents RPC 权威列表（running + ended）*/
  subagents: SubagentInfo[]
  /** 打开详情弹窗的子代理聚合键（= 父会话 Agent 工具 callID）*/
  subagentDetail: string | null
  /** 子代理报告弹窗（最终报告全文阅读，与详情弹窗互斥）*/
  subagentReport: { callID: string; title: string; markdown: string } | null
  /** 通用 Markdown 预览弹窗（工具卡输出全文阅读，如 Skill 加载的技能文档；与子代理弹窗互斥）*/
  markdownPreview: { title: string; meta?: string; markdown: string } | null
  /** 版本更新弹窗（What's New）开关：升级后首次打开自动弹 / 欢迎页角标 / 设置页手动打开 */
  changelogOpen: boolean
  /** 手机远程：配对弹窗开关（QR 展示 + 连接状态）*/
  remotePairingOpen: boolean
  /** 手机远程：relay 连接状态（'idle'=尚未查询过；广播/响应同构体 remoteState）*/
  remoteState: 'idle' | 'off' | 'connecting' | 'waiting' | 'paired' | 'error' | 'kicked'
  /** 手机远程：配对 QR URL（waiting 态携带，含敏感 passHash 仅弹窗内展示）*/
  remoteQrUrl: string | null
  /** 手机远程：宿主设备名（状态卡展示，如 "ZCode JetBrains (IntelliJ IDEA)"）*/
  remoteDeviceName: string | null
  /** 手机远程：错误信息（error/kicked 态）*/
  remoteError: string | null
  /** 子会话完整消息缓存（childSessionId → messages，详情弹窗"原始过程"）*/
  childMessages: Record<string, ZCodeMessage[]>
  childMessagesLoading: boolean
  childMessagesError: string | null
  /** 已注册子会话（childSessionId → 聚合键）：spawned 通知/转发事件/RPC 三处注册，*/
  /** 注册后其原生事件流被实时归约（不再被 currentSessionId 过滤丢弃）*/
  childSessionKeys: Record<string, string>
  /** 子会话 v4 实时通道是否可用（subscribeChild 应答的 v4 标志）：可用时弹窗不做
   *  3s 快照轮询（实时流在场，轮询只添乱且用户无法区分数据来源），不可用时保留轮询兜底 */
  childSessionV4: Record<string, boolean>
  /** 子会话实时归约消息（childSessionId → messages，运行中详情弹窗完整对话源）*/
  childLiveMessages: Record<string, ZCodeMessage[]>
  /** 子会话各自的流式消息 id（applyStreamEvent 的 streamingMessageId）*/
  childStreamingIds: Record<string, string | null>

  // 流式状态
  /** 当前 turn 是否进行中（发送后→turn.completed 前）*/
  streaming: boolean
  /** 流式中 assistant 消息的 id（turn.started 创建）*/
  streamingMessageId: string | null
  /** 开始等待的时间戳（WaitingIndicator 计时用）*/
  waitingSince: number | null
  /**
   * 上下文压缩回合进行中（/compact 或 autocompact）。摘要生成期间事件流
   * 完全静默（实测 63s+），此标志驱动压缩状态条、跳过空流式气泡与看门狗豁免。
   * 置位：send 识别 /compact（即时）或 usage 轮询带 activeTurnKind=compact
   * （权威，覆盖 autocompact）；清除：turn.completed/failed 或 usage 轮询转非 compact。
   */
  compacting: boolean
  /**
   * 后台任务运行中（体验增强，缺陷Y 配套）：Bash run_in_background 的工具
   * result 内容带任务 ID（"moved to the background with ID: xxx"），等待段
   * 事件流静默（progress 被 backgrounded 拦截）、快照不动——指示器明确告知
   * 用户在跑什么。key = 触发任务的 toolCallId（同一回合并发/连续多个后台任务
   * 各自独立记账、独立计时）。置位：工具 result 解析出 ID；清除：对应任务的
   * 完成通知（session.updated taskId/toolCallId + status 离开 running）/切会话。
   */
  backgroundTasks: BackgroundTaskMap
  /** 后台工作投影（H7 汇总入口）：v4 帧合成的服务端权威全量数组，按会话存。
   *  会话过滤前落账（非当前会话也更新，切回不丢）；全量替换语义；跨回合存活 */
  backgroundWorksBySession: Record<string, import('@/types/messages').BackgroundWorkSummary[]>
  /** 工作区钩子准入（v4 workspaceHookAdmission 投影，官方横幅数据源）：按会话存最新值，
   *  会话过滤前落账；null=已准入/无待审（收敛横幅）；跨回合存活 */
  workspaceHookAdmissionBySession: Record<string, import('@/types/messages').WorkspaceHookAdmission | null>
  /** 从转录重建的历史后台任务（refreshStatus 派生，与 agents 同生命周期）；
   *  IDE 重启后运行时投影消失，靠它让「后台工作」栏不空。读取处与投影合并（投影优先）*/
  backgroundWorksFromTranscript: import('@/types/messages').BackgroundWorkSummary[]
  /** 转录中已投递的后台任务终态（refreshStatus 派生，task-notification 的 task-id
   *  为投递证据）：CLI 投影在结果投递后不推收敛帧，条目会无限期停 resultPending，
   *  读取处 mergeBackgroundWorks 据此把 resultPending 本地升级为终态 */
  deliveredWorkStatuses: Map<string, 'ended' | 'failed'>
  /** 取消后台工作（bash/workflow；投影由 backgroundWorks 事件收敛，无乐观更新）*/
  cancelBackgroundWork: (sessionId: string, workId: string) => void
  /** 排队消息（streaming 中 Enter 入队，回合结束自动发队头）*/
  queuedMessages: QueuedMessage[]
  /**
   * 引导中（steer）的插队消息：v4 sendText requestedDelivery=guide 已受理、
   * 等待服务端注入运行中回合。置位：steerMessage 乐观置位；清除：steerDrained
   * （注入落位）/ turn.started（startNow 降级，气泡由 input 兜底）/ 回合结束
   * （未生效降级提示）。restore 记录乐观移除的队列条目及原下标——受理 ack 失败时
   * 由应答处理插回原位（失败回滚，防文本丢失），cancelSteer 成功时同源插回。
   * queueItemId = queue_<commandId>（commandId 前端生成，服务端确定性派生
   * f1()/Cse() 实锤），是撤销（deleteQueueItem）的句柄。
   * 带附件引导已砍（0.3.4 定案：guide+附件服务端必降级 queue 且不自动排空，
   * 促发链路不可靠——带图只保留立即发送与排队自动发出）。
   * 事件形状见 docs/internal/design-research/steer插队协议探针-2026-09-07.md
   */
  steerPending: {
    text: string
    at: number
    queueItemId?: string
    /** 撤回请求在途（chip 置取消中，防重复点击与落位竞态）*/
    cancelling?: boolean
    restore?: { item: QueuedMessage; index: number }
  } | null
  /**
   * 被引导注入的 user 消息 id（服务端真身 id，kv 持久化跨重拉/重启）——
   * 气泡渲染「⚡引导」徽标（对齐定时消息「定时执行」徽标语义）。
   * 写入：steerDrained 落位 / startNow 降级认领；读取：MessageBubble。
   */
  steeredMessageIds: string[]
  /**
   * 审批意见回显豁免（transient，不入 kv）：意见式拒绝后服务端把意见经 guide
   * 通道回显进当前回合，事件面与 steer 插队同形（turn.steerDrained）。不豁免会
   * 与缺陷Q拆分处本地插入叠加成双条、messageId 误进徽标账本标成「⚡引导」
   * （0.3.3 真机实测）。置位：insertFeedbackMessage；消费：steerDrained 命中
   * （窗口内 + 文本一致）跳过注入与徽标；懒过期。
   */
  planFeedbackEcho: { text: string; at: number } | null
  /**
   * 撤销引导的竞态观察记录（transient，缺陷BQ）：服务端 drainPendingInput 取出
   * 待注入条目时不同步设置 reservation（只查不设），取出后到 steerDrained 发出
   * 的窗口内 deleteQueueItem 会走 discardHeldPendingInputById 路径照样返回
   * removed=true——「撤销成功」与「注入发生」可并存。此处记录已按 removed=true
   * 回插队列的条目：随后的 steerDrained 命中同文本 = 注入实际发生，把刚回插的
   * 条目撤下（防回合结束 flushQueue 重复发送）；回合结束仍未命中 = 真撤销成功，
   * 条目留在队列正常排队。
   * 置位：cancelSteer 应答 removed=true 且有 restore；消费：steerDrained 命中；
   * 清理：回合结束 / 新引导置位 / 切换会话（sessionResetBase）。
   */
  steerCancelRestore: { itemId: string; text: string; at: number } | null
  /**
   * 目标模式状态（session/goal，2026-09 协议实测定案）：null=无目标。
   * 数据三路：messages 首拉（session.target）恢复 + goalManaged 响应 +
   * session.updated 目标 payload（action/target/previousTarget）实时推进。
   * 注意 status 是服务端 target 的四态（active/paused/budget_limited/complete）。
   */
  goal: GoalState | null
  /** 定时消息（全量镜像，UI 按 currentSessionId 过滤；权威列表在 Java 侧）*/
  scheduledMessages: ScheduledMessageItem[]
  /** 已发定时消息记录（Java 持久化镜像）：历史重拉/重启后按 sessionId+text 匹配补「定时执行」徽标 */
  firedHistory: ScheduledFiredRecord[]
  /** 已应用的最大 scheduledList 快照 ts（旧快照后到直接丢弃，防并发广播乱序把已移除项复活回镜像）*/
  lastScheduledListTs: number

  // 模型切换（config.json provider 注册表）
  models: ModelOption[]
  /** 当前会话选择的模型（显示值；会话级记忆见 zcode.modelMemory）*/
  currentModel: { modelId: string; providerId: string } | null
  /** 已下发过 setModel 的会话登记（sessionId → 下发时刻；避免 messages/models 刷新重复
   * 下发；Map 而非单槽——单槽在切走再切回时守卫失效，是缺陷BI跨会话重放的入口之一）。
   * 带 TTL：登记后 MODEL_APPLY_REGISTRATION_TTL_MS 内未收到 modelSet/modelSetFailed
   * （忙窗口重试耗尽、回执丢失）按过期放行，下一次触发重发——失败不永久锁死
   * （review Spec①：先登记后发送 + 守卫只进不出，超时后显示停在目标、永不重发）*/
  modelAppliedSessions: Map<string, number>
  /** setModel 回执已到（modelSet/modelSetPending）的会话集合（缺陷BO）：applyModelIfReady
   *  见之即跳过——登记 TTL 只该解锁「回执丢失」场景，无法区分时对已落定会话也放行，
   *  任何 models 刷新（设置页模型管理/provider 启停/重连）都会重放 setModel，回合中
   *  被 Java 挂起成幽灵「本轮结束后生效」横幅。modelSetFailed/用户 setModel 清除，
   *  失败与在途场景仍可由 TTL/重试链路兜住 */
  modelAckSessions: Set<string>
  /** 本 webview 内新建的会话集合：applyModelIfReady 对它们才回退全局默认模型
   * （新会话跟随上次选择的既有体验）；存量会话只重放会话级记忆（缺陷BI）*/
  createdSessionIds: Set<string>
  /** 已发过消息的会话（缺陷EF）：首条 send 恒带 runtimeModel 兜正服务端模型，自此
   * applyModelIfReady 的新建豁免（createdSessionIds）关闭——豁免若终身有效，之后任何
   * 清单刷新都会经豁免口补出同值 setModel，回合中被挂起成幽灵横幅（2026-09-30 实锤）*/
  modelSettledSessions: Set<string>
  /** 已选模型因清单变更失效被清除（防 inferCurrentModel 按模型名反查到别的 provider 复活；用户重选/切会话后复位）*/
  modelInvalidated: boolean

  // 运行时设置（session/read → settings：思考级别 + 权限模式）
  /** 思考级别（available 因模型而异，服务端权威）*/
  thoughtLevel: ThoughtLevelInfo | null
  /** 当前权限模式（build/edit/plan/yolo）*/
  currentMode: string | null
  /** 进入 plan 前的模式（缺陷E：ExitPlanMode 批准后即时恢复用，权威值由 state.updated/loadSettings 校正）*/
  prePlanMode: string | null
  /** 计划审批弹窗的用户应答（缺陷CG：v2 batch 对拒绝的 ExitPlanMode 也记 success，
   * errorCount=0，前端不能再用 !isError 当批准证据——exit_plan 推断只认弹窗的 approve
   * 应答；decline/feedback/无标记（超时/多标签/重载）一律安全侧留在 plan */
  planApprovalAnswer: 'approve' | 'decline' | 'feedback' | null
  /** agent 级计划阶段活跃（缺陷CG 真根因）：v2 把 agent plan 门控与 session 模式拆成
   * 两层——EnterPlanMode 批准只开 agent 门控，session 模式不变（日志零次
   * mode.current=plan）；拒绝后 agent 门控持续而回合边界 state.updated 推 session
   * 基础模式（yolo 等）。此标志活跃期间 applyStateUpdated 不翻转指示器（推送值记
   * prePlanMode），EnterPlanMode 批准置位、ExitPlanMode 批准/手动切档清除 */
  agentPlanActive: boolean
  /** 已为该会话下发过 setThoughtLevel（applyThoughtLevelIfReady 防重入）*/
  thoughtLevelAppliedForSession: string | null
  /** setModel 已发出、modelSet 未回的时间戳（期间到达的 settings 级别部分计算于旧模型，不可信；超时视为不在途）*/
  modelSwitchInFlightAt: number | null
  /** 回合中切换被 Java 挂起（缺陷AC延迟切换）：显示"本轮结束后生效"提示，补发 modelSet/modelSetFailed 清除 */
  modelPendingSwitch: { sessionId: string; modelId: string; providerId: string } | null
  /** 切换前模型（modelSetPending 回滚选中态用；modelSet/modelSetFailed 清除）*/
  modelSwitchPrevModel: { modelId: string; providerId: string } | null
  /** 合成 model_change 分隔卡暂存（按会话）：服务端 marker 下次 send 才落库，期间
   * 的重拉整包替换会顶掉合成卡，重拉落地时按此补挂；快照出现同目标 marker 即移除（防双条）。
   * 连续切换（消息流尾部仍是合成卡）折叠为一张：新卡顶旧卡、from 锚定链条起点，切回起点则隐藏 */
  syntheticModelChanges: Record<string, ZCodeMessage[]>
  /** 信息条（区别于 lastError 的非错误提示：延迟切模型等），modelSet/modelSetFailed/切会话清除 */
  lastNotice: string | null
  /** createSession 级别补发被推迟暂存的级别（等 modelSet 落定后按新模型下发，防 -32603 竞态）*/
  pendingThoughtLevel: string | null

  // 编辑历史消息（对齐官方 Edit History：仅最后一轮用户消息可编辑，改写重新生成）
  /** 行内编辑态锚定的消息 id（null=不在编辑态）；提交/取消/切会话清除 */
  editingMessageId: string | null
  /**
   * 编辑重放编排。via='v4'（diag-edit-v4 实测定案的主路径）：op:editUserQuery
   * 已发出，服务端自己 abort 旧回合 + rewind + 用新文本（+附件）重发——rewind.
   * triggered 确认截断（rewound），编辑后新 turn 结束即编排终点；via='legacy'
   * （老 CLI 回退）：/rewind 命令已发出，turn 结束重拉落地后由 case 'messages'
   * 自动重发 text。rewound=服务端 rewind.triggered 已确认。
   */
  editReplay: {
    targetMsgId: string
    text: string
    rewound: boolean
    via: 'v4' | 'legacy'
    attachments?: EditAttachmentInput[]
    /** 两段式回合中编辑（diag-edit-blocked 实锤）：true=stop 已发、等收尾帧后转第二段
     *  发 editUserQuery——服务端对「执行工具中」的回合 abort 不生效，直接编辑会被
     *  steerQueued 静默排队且队列不自动排水（accepted 却永不生效） */
    stopping?: boolean
    /** 编辑命令在途（已发、ack 未回）。v2 停止的旧回合有双终点（真实 + 遥测合成），
     *  第二个终点会落在 ack 前的窗口里——在途期间 turnEnded 不参与编排收尾，
     *  否则会按「新回合已结束且未确认」误判回退失败（缺陷CD 真机 23:02 实锤） */
    ackPending?: boolean
  } | null
  /**
   * 编辑走 v4 editUserQuery 通道（回合中编辑+带图编辑的前提）：
   * true/false/null=确认可用/确认不支持（老 CLI 无 v4 面，editUnsupported 回应）/
   * 未知（forkSupported=false 的老 CLI 直接按 false 处理）。会话属性，全局记忆。
   */
  editViaV4: boolean | null

  // 会话分叉（B2 一期：从任意历史消息派生平行会话，v4 forkAssistant 官方同款通道）
  /** fork 请求在途（按钮 loading + 防重复点击）；应答/失败复位 */
  forkBusy: boolean
  /** 分叉能力可用（老 CLI 无 v4 面时 Java 回 forkUnsupported 置 false，入口隐藏）*/
  forkSupported: boolean

  // 上下文用量（session/read → runtime.contextUsage）
  /** hitRate = null 表示本 turn 暂无缓存统计（新 turn 开始、首次模型调用完成前），显示"—"*/
  contextUsage: { used: number; size: number; hitRate: number | null } | null
  /** 上下文构成明细（session/read → runtime.breakdown）*/
  contextBreakdown: ContextBreakdownItem[] | null

  // 生成速度（session/debug → 官方开发者工具 TPS 面板数据源，服务端算好真值）
  /** 进程内存快照：agent 重启清零、只收 main_turn；WaitingIndicator 2s 轮询 + 圆环弹窗懒加载 */
  sessionDebug: SessionDebugSummary | null

  // 额度（glm plan usage API → 设置视图 + 圆环 popover 用）
  quota: QuotaData | null
  quotaLoading: boolean
  /** quota 上次成功拉取时间戳（圆环 popover 缓存 TTL 用）*/
  quotaFetchedAt: number
  /** monitor HTTP 实际取 key 的渠道（用量页提示数据口径；成功响应携带）*/
  usageProvider: { id: string; name: string; keyMasked?: string } | null

  // 记忆文件（设置视图「记忆」条目，Kotlin 端固定清单扫描）
  memoryFiles: MemoryFileInfo[] | null
  /** 记忆页浏览目录（多目录会话：''=本项目；切目录重拉清单）*/
  memoryWorkspace: string
  /** 自动记忆目录定位（null=未加载/无打开项目；排查「有记忆但读取不到」）*/
  memoryDir: MemoryDirInfo | null
  /** 自动记忆全文搜索：null=非搜索态；activeQuery 用于对齐丢弃乱序应答 */
  memorySearchResults: MemorySearchHitInfo[] | null
  memorySearchActiveQuery: string
  memorySearching: boolean
  memoryLoading: boolean
  /** 正在创建的记忆文件路径（条目按钮 loading 用）*/
  memoryCreatingPath: string | null
  memoryError: string | null
  /** 「工作区记忆」开关（null=未加载；与 ZCode 客户端共用 ~/.zcode/v2/setting.json）*/
  memoryEnabled: boolean | null
  cuaEnabled: boolean | null
  cuaToggling: boolean
  /** CUA 应用图标缓存：icon key → data URL（''=已请求但缺失，防重复拉取）*/
  cuaIcons: Record<string, string>
  /** 输入框「电脑操作」入口 chip 显隐（persist kv；上游还受 cuaEnabled 门控）*/
  cuaInputButton: boolean
  /** 开关切换请求在途（防重复点击）*/
  memoryToggling: boolean

  // 底部状态栏（任务/子代理/文件）折叠态：即时 UI 偏好不持久化（与 cc-gui 一致，重载回展开）
  statusPanelCollapsed: boolean

  // AskUserQuestion 应答时刻（callID → 用户在弹窗点确认/取消的本地时钟）：
  // 服务端落库该工具 end-start≈4ms（等待用户在 interaction 层），快照落地时
  // 用它补真实 end（preserveAskUserDurations）——batch 收尾被"重拉先落地+
  // 终态守卫跳过"时这是唯一可靠的时长来源
  askAnsweredAt: Record<string, number>

  // AskUserQuestion 提问时刻（callID → 弹窗打开的本地时钟，取自 askUser.askedAt）：
  // 时长修复的真实起点。本地流式 part 的 time.start 不可用——完成事件 kind=result
  // 的服务端权威 startedAt 会把它覆盖成应答后瞬时值（db 实测 start≈end 差 3ms）
  askAskedAt: Record<string, number>

  // 浏览器设置（设置视图「浏览器」条目；浏览器控制状态与 ZCode 客户端公用配置，只读）
  browserConfig: {
    browserControlEnabled: boolean
    pluginInstalled: boolean
  } | null
  /** 清理/概览请求在途（防重复点击；含失败回滚窗口）*/
  browserBusy: 'cache' | 'all' | 'overview' | null
  browserError: string | null
  /** 最近一次清理结果（toast 汇总展示用）*/
  browserCleared: { all: boolean; httpCache: boolean; cookies?: boolean; sites: BrowserClearedSite[] } | null
  /** 浏览器数据概览（清理条目旁「查看」按钮弹窗数据源；null=未加载）*/
  browserOverview: BrowserDataOverview | null
  // 技能清单（设置视图「技能」条目，SkillScanner 三来源扫描）
  skills: SkillInfo[] | null
  skillsLoading: boolean
  /** 技能页浏览目录（多目录会话：''=本项目；切目录重扫清单）*/
  skillsWorkspace: string
  /** 正在切换启用状态的技能路径（卡片开关 loading + 防重复点击）*/
  skillTogglingPath: string | null
  skillsError: string | null

  // 斜杠命令/技能名清单（Kotlin 磁盘扫描，kind 区分技能与命令）。
  // 消息气泡把 /name 引用 chip 化时按此清单精确匹配防误判
  slashCommands: SlashCommand[] | null
  /** listCommands 已发出标志（防重复请求；null 清单 + 未请求才发）*/
  slashCommandsRequested: boolean
  /** 确保斜杠命令清单已拉取（一次性，回包走 commands case）*/
  ensureSlashCommands: () => void

  // 提示词润色（InputBox 润色按钮 → generateText/CLI 通道 → 对比确认弹窗）
  enhancing: boolean
  /** 弹窗可见性（与结果数据解耦：润色中关弹窗不弃请求，再点按钮复用在途/既有结果）*/
  enhanceDialogOpen: boolean
  /** 润色结果弹窗数据（null = 无；error 非 null = 失败态；model = 实际润色模型）*/
  enhanceResult: { original: string; text?: string; error?: string; model?: string } | null

  // 子智能体定义清单（磁盘扫描 + 发送选择；数据与 ZCode 客户端共用 agents/*.md，
  // 与 129 行运行时 agents: AgentItem[] 不同名避免冲突）
  subagentDefs: AgentDef[] | null
  /** 输入框当前选中的子智能体（发送时消息前置 @<name>；null = 未选）*/
  selectedAgent: AgentDef | null
  /** 保存成功信号（写盘回包才置；AgentEditDialog 监听后关弹窗，覆盖 3s 超时提示）*/
  agentSavedSignal: { name: string; scope: string; at: number } | null

  // MCP 服务器清单（设置视图「MCP」条目 = 磁盘配置 + mcp/list 状态合并）
  mcpServers: McpServerInfo[] | null
  mcpLoading: boolean
  /** 检测连接（mode=connect 真实连接）进行中 */
  mcpChecking: boolean
  /** mcp/list RPC 失败提示（磁盘配置降级清单仍展示）*/
  mcpError: string | null
  // MCP 工具清单（McpToolsClient 直连服务器调 tools/list，按 serverName 存槽）
  mcpToolsByServer: Record<string, McpToolsState>
  // MCP 连接日志（CLI 落盘 mcp.* 事件，McpLogReader 读）
  mcpLogs: McpLogEntry[] | null
  // 模型调用轨迹（CLI 落盘 model-io，ModelIoTrajectoryReader 读；null=未加载）
  trajectory: { sessionId: string; records: TrajectoryRecord[]; sourceFiles: string[]; truncated: boolean; totalCount: number } | null
  trajectoryError: string | null

  // 模型管理清单（设置视图「模型」条目 = config.json provider→models 全量只读结构）
  modelProviders: ModelManageProvider[] | null
  modelManageLoading: boolean
  modelManageError: string | null
  /** 实际读取的 config.json 路径（随 dataBaseDir 重定向，展示/打开用）*/
  modelConfigPath: string | null
  /** v2 渠道体系（provider_config.json：自定义供应商，插件内可增删改；判代徽章与文案切换用）*/
  modelManageNewCli: boolean
  /** 可显示「重新执行内置渠道迁移」入口（v1 config.json 有渠道 + 当前无映射表内置渠道）*/
  modelRemigrateAvailable: boolean
  /** 重迁请求执行中（按钮 loading + 防重复点击）*/
  modelRemigrating: boolean
  /** 重迁结果弹窗（names=迁入渠道显示名；空=无可迁移；error=失败文案），null=关闭 */
  modelRemigrateResult: { names: string[]; error?: string } | null
  /** 正在切换启用状态的 providerId（开关 loading + 防重复点击）*/
  modelTogglingId: string | null
  /** 正在切换启用状态的「providerId|modelId」组合键（单模型开关 loading + 防重复点击）*/
  modelTogglingKey: string | null
  /** 渠道编辑弹窗保存中（防重复提交，保存按钮 loading）*/
  providerSaving: boolean
  /** 渠道排序写回中（拖拽落位 → providerOrder 保存期间禁再次拖拽）*/
  modelProvidersReordering: boolean
  /** 渠道增/改/删失败文案（弹窗内提示；成功时清除）*/
  providerSaveError: string | null
  /** 连通性测试进行中的「providerId|modelId」组合键（按钮 loading + 防重复）*/
  connectivityTestingId: string | null
  /** 连通性测试结果（「providerId|modelId」组合键 → 结果，模型行徽章；重测覆盖，未测无键）*/
  connectivityResults: Record<string, { ok: boolean; error?: string }>
  /** 会话待交互计数（审批/提问挂起；pendingInteractions 全量快照推送，红点角标）*/
  pendingInteractionCounts: Record<string, number>
  /** 置顶会话 id 集（tasks-index.sqlite pinned 位，Kotlin 广播全量快照 + 列表加载对账；
   * Java 库为权威源，前端不做乐观更新，sessionPinsChanged/pinnedSessions 同形覆盖）*/
  pinnedSessionIds: string[]
  /** 未读会话 id 集（tasks-index.sqlite unread_at 位：后台终态且无标签在看时 Java 置位、
   * 打开会话清位；sessionUnreads/sessionUnreadsChanged 同形覆盖，权威源同在库）*/
  unreadSessionIds: string[]
  /** 回合运行中的会话集合（sessionTurnPhase 相位广播维护；值=startedAt），
   * 防列表快照把远程驱动的运行中会话降级回已完成 */
  remoteRunningTurns: Record<string, number>
  mcpLogsLoading: boolean
  trajectoryLoading: boolean

  // 用量明细曲线（model-usage / tool-usage）
  modelUsage: ModelUsageData | null
  toolUsage: ToolUsageData | null
  usageRange: UsageRange
  customStart: string | null
  customEnd: string | null
  /** 用量查询局部错误（凭证/HTTP 失败，不污染全局 lastError）*/
  usageError: string | null

  // 会话额度横幅错误触发源（turn.failed / backendError 分类命中时写入；展示视图由
  // useQuotaBanner 与 quota 数据派生，见 utils/quotaWindows.ts）。null = 无触发
  quotaBannerError: import('@/utils/quotaWindows').QuotaBannerTrigger | null
  // 已关闭的横幅去重键。低额路（low: 前缀）落 persist kv 持久化：多标签独立 store，
  // 纯内存会让每个新会话重新点亮（关闭后须跨标签/跨重启静默，见
  // utils/quotaBannerDismissals.ts）；错误路（err:）是会话内瞬态，保持内存级
  quotaBannerDismissed: string[]

  // 应用用量（usage/stats：app-server 本地聚合，含第三方模型，无 apiKey 依赖）
  appUsage: AppUsageData | null
  appUsageRange: AppUsageRange
  /** 应用用量查询局部错误（app-server 不可达/协议错误）*/
  appUsageError: string | null

  // AskUserQuestion 弹窗（deadlineMs = Java 侧应答超时时刻，弹窗倒计时用；旧链路可缺省。
  // askedAt = 事件到达时刻：永远等待模式（无 deadlineMs）下 header 的「已等待」正计时起点）
  askUser: { requestId: string; toolName: string; questions: import('@/types/messages').AskUserQuestion[]; deadlineMs?: number; askedAt?: number } | null

  // AskUserQuestion 回看弹窗（消息流工具卡点击打开，只读回看问题/选项/已选答案；
  // 数据为打开瞬间从工具 part 提取的快照，recognized=false 时 raw 为原文回执兜底）
  askUserReview: {
    questions: import('@/types/messages').AskUserQuestion[]
    answers: Record<string, string>
    recognized: boolean
    raw: string
  } | null

  // ExitPlanMode 计划审批弹窗（服务端 interaction/requestUserInput，params = {input:{plan}}）
  // askedAt = 事件到达时刻：无超时等待（0.3.7 起）下 header 的「已等待」正计时起点
  exitPlanApproval: { requestId: string; plan: string; deadlineMs?: number; askedAt?: number } | null

  // 工具权限审批弹窗（服务端 interaction/requestPermission，「变更前询问」模式触发；
  // 应答走 askUserResponse 通道，answer = 选中项 optionId）
  permissionRequest: {
    requestId: string
    toolName: string
    reason: string
    options: import('@/types/messages').PermissionOption[]
    input?: unknown
    riskLevel?: string
    deadlineMs?: number
  } | null

  // 本会话存在挂起中的反向请求（Java 广播，多标签同会话时无弹窗的面板也置位）——
  // 流式看门狗豁免用：等待用户应答是合法静默，不应判 streamLost 提前收尾
  askUserPendingActive: boolean

  // 当前打开文件 ref（Kotlin→webview 推送：getCurrentFile 响应 / EditorContextTracker 200ms 防抖）
  // 形态：'@path' / '@path#L10' / '@path#L10-20' / null（无打开编辑器）
  // 当前只驱动 CurrentFileChip 显示，不参与发送
  currentFileRef: string | null
  // 文件上下文 chip 勾选态（2026-10-08 从 InputBox 局部 state 抬入：新建会话按设置
  // 初始化需要跨组件写入点）。发完即关：doSend 发送成功即置 false——勾选只管下一条
  // 消息；本身不持久化（消息级状态），「新会话自动点亮」偏好走 utils/currentFileConfig
  //（默认关）。应用点两处：resetToNewSession（新建会话按钮）+ listSessions boot 待命
  // 分支（新标签/绑定失效，用户实测拍板"新建标签页=新建会话"）；
  // 切会话/删当前会话/Java 自动 newSession/createSession 响应均不动它
  currentFileEnabled: boolean

  // actions
  init: () => void
  loadSessions: () => void
  /** 切换激活目录（历史页 chips）：清两列表 + 重拉（loadSessions/loadArchived 由视图按需）*/
  setActiveWorkspace: (path: string) => void
  /** projectPath 空串兜底：注入失败（重启初期 basePath 未就绪）时向 Java 拉生效路径 */
  ensureProjectPath: () => void
  /** 弹系统目录选择框添加关联目录（Java 应答带 added 时自动切过去）*/
  addLinkedWorkspace: () => void
  /** 移除关联目录（若移除的是激活目录自动回退本项目）*/
  removeLinkedWorkspace: (path: string) => void
  /** 拉取当前打开文件 ref（webview mount/重连时触发；Kotlin 同步回包，case 'currentFile' 落 state）*/
  requestCurrentFile: () => void
  /** 文件上下文 chip 勾选开关（用户点击 chip / doSend 发完即关 / resetToNewSession 按设置初始化）*/
  setCurrentFileEnabled: (enabled: boolean) => void
  selectSession: (session: SessionInfo) => void
  sendMessage: (text: string, attachments?: SendAttachmentInput[], opts?: { scheduledFireAt?: number; scheduledProviderId?: string; scheduledModelId?: string; hiddenCommand?: boolean }) => void
  /** 进入最后一条用户消息的编辑态（MessageBubble 行内编辑框） */
  startEdit: () => void
  /** 退出编辑态（不提交） */
  cancelEdit: () => void
  /**
   * 提交编辑（编辑重新生成）。v4 主路径（回合中也可用）：op:editUserQuery，
   * 服务端 abort+rewind+重发一气呵成；老 CLI 回退 legacy：/rewind 命令 + 快照
   * 落地后自动重发（editReplay 编排，见 case 'messages'）。images=编辑后的
   * 图片附件全量清单（保留+新增−删除），仅 v4 通道消费
   */
  submitEdit: (text: string, images?: EditAttachmentInput[]) => void
  /** 从历史消息分叉新会话（B2 一期）：session/fork 保留到该消息（含），应答后新标签打开 */
  forkFromMessage: (sessionId: string, messageId: string) => void
  createSession: () => void
  /** 待命态定时任务：先把会话建好再落库（归属唯一化），createSession 响应后自动 scheduledCreate */
  createSessionForSchedule: (text: string, fireAt: number, providerId?: string, modelId?: string, keepCurrent?: boolean) => void
  /** 「新建会话」按钮：重置为无会话待命态（延迟创建），首条消息触发建会话 */
  resetToNewSession: () => void
  deleteSession: (sessionId: string) => void
  /** 拉取已归档会话列表（回收站视图）*/
  loadArchivedSessions: () => void
  /** 归档会话（从历史列表移入回收站，可恢复）*/
  archiveSession: (sessionId: string) => void
  /** 置顶/取消置顶会话（写 tasks-index pinned 位，广播回调更新 pinnedSessionIds）*/
  toggleSessionPin: (sessionId: string, pinned: boolean) => void
  /** 恢复归档会话（从回收站移回历史列表）*/
  restoreSession: (sessionId: string) => void
  /** 删除归档会话（软删对齐 ZCode 客户端：数据保留，两端列表同步隐藏）*/
  deleteArchivedSession: (sessionId: string) => void
  /** ============ 自动归档（历史视图「自动归档」tab） ============ */
  /** 共享配置是否已水合（进 tab 时拉取）*/
  autoArchiveConfigLoaded: boolean
  /** 开关与保留天数（与 ZCode 客户端共享 ~/.zcode/v2/setting.json）*/
  autoArchiveEnabled: boolean
  autoArchiveDays: number
  /** 归档记录（仅 >0 轮次，新→旧）*/
  autoArchiveRecords: AutoArchiveRecord[]
  /** 手动立即扫描在途 */
  autoArchiveRunning: boolean
  /** 最近一轮手动扫描结果（null=未跑过；0=无符合条件）*/
  autoArchiveLastRunCount: number | null
  /** 最近一轮手动扫描被跳过（开关未启用——扫描不生效）*/
  autoArchiveLastRunSkipped: boolean
  /** 最近一次成功扫描时间（无论有无归档；null=从未，Kotlin 持久化）*/
  autoArchiveLastSweepAt: number | null
  /** 进自动归档 tab 拉取配置+记录 */
  loadAutoArchiveData: () => void
  /** 写共享配置（乐观更新，ack 校正）*/
  setAutoArchiveConfig: (enabled: boolean, olderThanDays: number) => void
  /** 手动立即扫描一轮 */
  runAutoArchiveNow: () => void
  /**
   * 历史列表打开会话前的定位查询：resolve true = Java 已激活该会话的宿主标签（跨标签跳转完成）；
   * false = 没有任何标签打开过它（调用方决定覆盖当前标签页还是新开）
   */
  locateSessionTab: (sessionId: string) => Promise<boolean>
  /** 当前各标签已绑定的会话快照（历史列表标注「已在会话N打开」用，瞬态查询不入 state）*/
  listOpenTabs: () => Promise<OpenTabInfo[]>
  /** 历史列表「新标签页打开」：走 Java gotoSession 统一路径（定位已确认无宿主 → 必然新建标签）。
   *  workspacePath（多目录会话）：会话所属目录随标签注入，新标签 boot 首拉按它过滤才能恢复 */
  openSessionNewTab: (sessionId: string, workspacePath?: string) => void
  stopStreaming: () => void
  /** 重命名会话（CLI 协议无 rename op，仅前端 persist 持久化）*/
  renameSession: (sessionId: string, title: string) => void
  /** AI 重新生成当前会话标题（构建全会话摘录·偏向最新轮次 → Java generateText + v4 renameSession；
   *  结果经 sessionTitleRegenerated 应答应用，失败置 sessionTitleRegenError）*/
  regenerateSessionTitle: (sessionId: string) => void
  /** 清除标题重生成失败提示（App 通栏自动消失/手动关闭）*/
  clearSessionTitleRegenError: () => void
  /** 拉取可切换的模型列表（config.json）*/
  loadModels: () => void
  /** 手动刷新模型清单（下拉刷新按钮）：置 modelsRefreshing，响应后复位 */
  refreshModels: () => void
  /** 模型清单手动刷新进行中（下拉刷新按钮转圈标记）*/
  modelsRefreshing: boolean
  /** 生效渠道实际计费 key 来源（custom/config/oauth；展示须与实际扣费一致） */
  billingKeySource: 'custom' | 'config' | 'oauth' | null
  /** 客户端选中团队套餐但未配覆盖 → 输入框黄色提醒（配好覆盖后刷新复位） */
  teamPlanNoOverride: boolean
  /** 切换当前会话模型（session/setModel）*/
  setModel: (modelId: string, providerId: string) => void
  /** 把 persist 记忆的模型下发给指定会话（models 列表已就绪时才生效）*/
  applyModelIfReady: (sessionId: string, newSession?: boolean) => void
  /** 拉取当前会话的运行时设置（mode + thoughtLevel）*/
  loadSettings: () => void
  /** 待命态（无会话）按当前模型恢复缓存的思考级别集（预选显示用；有会话时无操作）*/
  hydrateThoughtLevelStandby: () => void
  /** 切换思考级别（session/setThoughtLevel，persist 记忆）*/
  setThoughtLevel: (level: string) => void
  /** 切换权限模式（session/setMode，不记忆——模式是即时意图，避免 plan 粘性）*/
  setMode: (mode: string) => void
  /**
   * 目标模式管理（session/goal）：set/replace 带 objective，pause/resume/clear
   * 不带。服务端引擎自治（set/resume 自动开轮、每轮结束自动校验续跑），本操作
   * 只下发控制意图；实时状态由 session.updated 目标 payload 推送。
   */
  goalManage: (action: 'set' | 'replace' | 'pause' | 'resume' | 'clear' | 'show', objective?: string) => void
  /** 把 persist 记忆的思考级别下发给指定会话（available 就绪且值仍有效时才生效）*/
  applyThoughtLevelIfReady: (sessionId: string) => void
  /** 拉取当前会话的上下文用量 */
  loadUsage: () => void
  /** 拉取当前会话调试快照（生成速度真值；WaitingIndicator 流式轮询 + 圆环弹窗懒加载共用）*/
  loadSessionDebug: () => void
  /** 拉取额度（设置视图 + 圆环 popover 用）*/
  loadQuota: () => void
  /** 关闭当前额度横幅（记录去重键，同源触发不再展示）*/
  dismissQuotaBanner: (key: string) => void
  /** 清除额度横幅错误触发源（窗口恢复/新回合开始时由 useQuotaBanner 调用）*/
  clearQuotaBannerError: () => void
  /** 拉取记忆文件清单（设置视图「记忆」条目；带 path 切浏览目录，缺省延续当前作用域）*/
  loadMemoryFiles: (path?: string) => void
  /** 自动记忆全文搜索（调用方防抖；空 query 退出搜索态）*/
  searchMemoryFiles: (query: string) => void
  /** 创建缺失的记忆文件（写默认模板，Kotlin 侧自动用编辑器打开）*/
  createMemoryFile: (path: string) => void
  /** 切换「工作区记忆」开关（新会话生效）*/
  setMemoryEnabled: (enabled: boolean) => void
  loadCuaEnabled: () => void
  setCuaEnabled: (enabled: boolean) => void
  /** 按需拉取应用图标（key 已缓存/已判缺失时跳过；''哨兵防缺失重复请求）*/
  loadCuaIcon: (key: string) => void
  /** 切换输入框「电脑操作」入口 chip 显隐（persist kv 即时回存）*/
  setCuaInputButton: (enabled: boolean) => void
  /** 切换底部状态栏折叠态（输入框工具条按钮与状态栏本体共享）*/
  toggleStatusPanel: () => void
  /** 记录 AskUserQuestion 应答时刻（弹窗确认/取消时调用，补工具卡真实耗时）*/
  recordAskUserAnswered: () => void
  /** 拉取浏览器设置快照（设置视图「浏览器」条目）*/
  loadBrowserConfig: () => void
  /** 清除内置浏览器数据（cache=保留 Cookie 与本地站点数据；all=全清）*/
  clearBrowserData: (mode: 'cache' | 'all') => void
  /** 拉取浏览器数据概览（「查看」按钮弹窗）*/
  loadBrowserOverview: () => void
  /** 关闭浏览器设置的错误提示 */
  clearBrowserError: () => void
  /** 拉取技能清单（设置视图「技能」条目）*/
  loadSkills: (path?: string) => void
  /** 启用/禁用技能（写 config skill 节点，CLI 下次发现生效）*/
  toggleSkill: (path: string, enabled: boolean) => void

  // ============ 提示词润色 ============
  /** 触发润色（在途再点=复用开弹窗；同文已有结果再点=复用结果；否则发新请求）*/
  enhancePrompt: (text: string) => void
  /** 仅关弹窗（润色继续在途/结果保留，可再点按钮复现）*/
  closeEnhanceDialog: () => void
  /** 用户取消润色：通知后端中止在途请求并清场（与关弹窗不同，这是真终止）*/
  cancelEnhance: () => void
  /** 整体重置（使用润色回填后清场：关弹窗+弃结果+作废代际）*/
  clearEnhanceResult: () => void

  // ============ 子智能体 ============
  /** 拉取子智能体清单（AgentSelect 下拉 / @ 补全 / 设置页共用）*/
  loadAgents: () => void
  /** 选择/取消子智能体（选中后发送的消息前置 @<name> 触发主 Agent 调度）*/
  selectAgent: (agent: AgentDef | null) => void
  /** 保存子智能体（新建/更新/改名，写 <作用域>/agents/<name>.md）*/
  saveAgent: (scope: 'user' | 'project', agent: AgentDefInput, originalName?: string) => void
  /** 删除子智能体定义文件 */
  deleteAgent: (scope: 'user' | 'project', name: string) => void
  /** 拉取 MCP 服务器清单（mode=connect 时真实连接各服务器，慢）*/
  loadMcpServers: (mode?: 'status' | 'connect') => void
  /** 拉单台服务器的工具清单（有缓存且非 force 直接跳过；loading 中防重入）*/
  loadMcpServerTools: (name: string, force?: boolean) => void
  /** 拉取 MCP 连接日志（CLI 落盘 mcp.* 事件）*/
  loadMcpLogs: () => void
  /** 拉取会话的模型调用轨迹（CLI 落盘 model-io，直读文件非协议 RPC）*/
  loadTrajectory: (sessionId: string) => void
  /** 拉取模型管理清单（设置视图「模型」条目，config.json 只读结构）*/
  loadModelManage: () => void
  /** 设置/清除内置渠道的自定义 apiKey 覆盖（空串=清除），写 ~/.zcgui/config.json 并触发注册表推送 */
  setProviderKey: (providerId: string, apiKey: string) => void
  /** 切换 provider 启用/禁用（写 config.json enabled 字段，回包 modelToggled）*/
  toggleModelProvider: (providerId: string, enabled: boolean) => void
  /** 单模型启用/停用切换（个人渠道；账号渠道 Kotlin 侧拒绝）*/
  toggleModel: (providerId: string, modelId: string, enabled: boolean) => void
  /** 添加自定义模型渠道（写 config.json provider 注册表，UUID 作 providerId）*/
  addModelProvider: (draft: ProviderSaveDraft) => void
  /** 编辑自定义渠道（apiKey null=不变 空串=清除；models 整表替换），providerId 不变 */
  updateModelProvider: (providerId: string, draft: ProviderSaveDraft) => void
  /** 删除自定义渠道（含其全部模型）*/
  removeModelProvider: (providerId: string) => void
  /** 渠道排序（v2 专属 op）：providerIds = 拖拽后的完整顺序 */
  reorderModelProviders: (providerIds: string[]) => void
  /** 重新执行内置渠道迁移（清标记 + 立跑迁移），结果经 modelRemigrated 回包驱动弹窗 */
  remigrateBuiltins: () => void
  /** 关闭重迁结果弹窗 */
  dismissRemigrateResult: () => void
  /** 渠道连通性测试（provider/testModelConnectivity，服务端真发一次最小模型请求）*/
  testConnectivity: (providerId: string, modelId: string) => void
  /** 重跑最后一轮（v4/command retryTurn，服务端 rewind+重发原文）*/
  /** 重发最新一条用户消息（文本不变的编辑：复用 submitEdit 完整链路）*/
  resendLastUserMessage: () => void
  /** 队列条目上移/下移（自研本地队列纯前端重排，-1=上移 1=下移）*/
  moveQueuedMessage: (id: string, direction: -1 | 1) => void
  /** 设置用量明细时间范围并重拉 model/tool 曲线 */
  setUsageRange: (range: UsageRange) => void
  /** 设置自定义日期范围并重拉 */
  setUsageDates: (start: string, end: string) => void
  /** 按当前 usageRange 拉取 model-usage + tool-usage */
  loadUsageData: () => void
  /** 设置应用用量时间范围并重拉 usage/stats */
  setAppUsageRange: (range: AppUsageRange) => void
  /** 拉取应用用量（usage/stats，app-server 本地聚合）*/
  loadAppUsage: () => void
  /** 清除错误（错误栏关闭按钮）*/
  clearError: () => void
  clearNotice: () => void
  /** 清除驻留水位提醒（toast 自动消失/手动关闭）*/
  clearResidentPoolNotice: () => void
  /** 设置 EnvBanner「去设置」的跳转意图（BasicSettingsView 消费后清除）*/
  setPendingSettingsSection: (section: 'env' | 'agents' | 'models' | 'hooks' | null) => void
  /** 检测运行环境三件套（init 时 / 提醒条「重新检测」触发）*/
  checkEnv: () => void
  /**
   * 保存环境路径配置：undefined=不改该项，''=清除（回退自动探测）。
   * 后端验证（node spawn --version、cli 文件存在）失败不落盘，回 error（带 envStatus）。
   */
  saveEnvConfig: (nodePath?: string, cliPath?: string, cdpPortFile?: string) => void
  /** 拉取网络代理配置（设置页环境 tab 挂载时；与 ZCode 客户端同源 setting.json） */
  loadProxyConfig: () => void
  /**
   * 保存网络代理三字段（''=清除该项）。写共享 setting.json——ZCode 客户端重启后
   * 同样生效；插件侧 app-server 需重启吃到新 env（restartPending 响应驱动 UI 提示）。
   */
  saveProxyConfig: (httpProxy: string, noProxy: string, caCertPath: string) => void
  /** 重启 app-server（用户在保存代理后主动触发，接受打断进行中的回合） */
  restartAppServer: () => void
  /** 拉取当前会话的子代理列表（session/subagents RPC，权威状态）*/
  loadSubagents: () => void
  /** 打开子代理详情弹窗（key = Agent 工具 callID）*/
  openSubagentDetail: (key: string) => void
  /** 关闭子代理详情弹窗 */
  closeSubagentDetail: () => void
  /** 打开逐轮文件更改弹窗（key = 该轮 assistant 消息 id = turnHeader entityId）。
   *  opts.path=初始定位文件（文件行「审查」）；opts.rewind=打开即进撤销预览模式 */
  openTurnFileChanges: (messageId: string, opts?: { path?: string; rewind?: boolean }) => void
  /** 关闭逐轮文件更改弹窗 */
  closeTurnFileChanges: () => void
  /** 打开子代理报告弹窗（markdown = Agent 工具 part 的最终输出）*/
  openSubagentReport: (r: { callID: string; title: string; markdown: string }) => void
  /** 关闭子代理报告弹窗 */
  closeSubagentReport: () => void
  /** 打开通用 Markdown 预览弹窗（工具卡输出全文阅读）*/
  openMarkdownPreview: (p: { title: string; meta?: string; markdown: string }) => void
  /** 关闭通用 Markdown 预览弹窗 */
  closeMarkdownPreview: () => void
  /** 打开 AskUserQuestion 回看弹窗（工具卡点击，只读快照）*/
  openAskUserReview: (r: { questions: import('@/types/messages').AskUserQuestion[]; answers: Record<string, string>; recognized: boolean; raw: string }) => void
  /** 关闭 AskUserQuestion 回看弹窗 */
  closeAskUserReview: () => void
  /** 打开版本更新弹窗（What's New；已读标记写回由 App 关闭回调负责）*/
  openChangelog: () => void
  /** 关闭版本更新弹窗 */
  closeChangelog: () => void
  /** 打开手机远程配对弹窗（顺带触发连接与状态拉取）*/
  openRemotePairing: () => void
  /** 关闭手机远程配对弹窗（连接保持，后台仍可收推送）*/
  closeRemotePairing: () => void
  /** 拉取手机远程状态（op=remoteStatus）*/
  refreshRemoteState: () => void
  /** 强制重出码（op=remoteRefreshQr，新时间戳同配对）*/
  refreshRemoteQr: () => void
  /** 手机远程断开连接（op=remoteStop）*/
  stopRemote: () => void
  /** 手机远程解除配对（清除凭据，op=remoteUnpair）*/
  unpairRemote: () => void
  /**
   * 拉取子会话完整消息（详情弹窗"原始过程"）。
   * silent = true：弹窗运行中 3s 轮询用——不置 loading/error（避免空态文案与
   * 错误提示频闪）；轮询的按钮动画由弹窗侧每次触发时自行保证（triggerSpin）
   */
  loadChildMessages: (childSessionId: string, silent?: boolean) => void
  /** 删除一条排队消息 */
  removeQueuedMessage: (id: string) => void
  /** 立即发送排队消息：移到队头 + 中断当前回合（turn 结束事件到达后自动发出）*/
  sendQueuedNow: (id: string) => void
  /**
   * 引导式插队（steer）：把消息注入运行中的回合（v4 sendText
   * requestedDelivery=guide，2026-09-07 探针定案），不打断不排队。
   * 带附件引导已砍（0.3.4 定案：guide+附件服务端必降级 queue 且降级条目不自动
   * 排空，促发链路复杂且实测不可靠）。
   * 乐观置 steerPending（chip 反馈），气泡等 steerDrained/turn.started 落位
   * （注入消息 id 是服务端正式 id，与回合结束重拉天然对齐）。ack 的
   * result.delivery 是初始准入 coarse 值（实测 guide 也报 "queue"），不能据它
   * 判断降级；失败/降级由事件与回合结束兜底。返回 false=未受理（守卫拦截）。
   * restore：来自队列的条目及其原下标，受理 ack 失败时插回原位。
   */
  steerMessage: (text: string, restore?: { item: QueuedMessage; index: number }) => boolean
  /**
   * 引导队列中的消息（排队卡片「引导」按钮，2026-09-07 交互定案）：Enter 恒入队，
   * 用户看到卡片后显式选「引导」（注入当前回合）或「立即」（中断+发）。成功即
   * 从队列移除该条；失败（非流式/已有在途引导）保留队列条目并横幅提示；受理
   * 后 ack 失败（服务端拒收/Java 异常）由应答处理按 restore 插回原位。
   * 定时来源与带附件的条目由 UI 隐藏入口（0.3.4 定案砍带图引导）。
   */
  sendQueuedAsSteer: (id: string) => void
  /**
   * 撤回引导中的消息（引导 chip ✕，2026-09-08）：v4 deleteQueueItem 按 queueItemId
   * 撤销（pending steer 输入与服务端队列项同通道）。chip 置 cancelling 防重复点击；
   * 应答 removed=true 才清 chip 并按 restore 插回队列（不做乐观回插：撤回失败的
   * 真实原因是已注入落位，此时插回会造成气泡+队列条目并存）。removed=false 横幅
   * 提示已太迟，chip 交给 steerDrained 正常落位。
   */
  cancelSteer: () => void
  /** 回合结束（streaming→false）后自动发送队头 */
  flushQueue: () => void
  /** 立即执行定时消息：乐观移除卡片；本面板正看该会话则直接走受理路径发送，否则交 Java 分派（可能开标签/直发）*/
  sendScheduledNow: (id: string) => void
  /** 取消定时消息：乐观移除卡片 + Java 幂等移除 */
  cancelScheduled: (id: string) => void
  /** 重拉定时任务全量快照（广播无端到端确认，镜像靠重拉自愈：focus/切回前台/打开定时列表时调用）*/
  refreshScheduledList: () => void
  /** 切会话丢弃队列前的回退：定时来源的排队消息交还 Java 侧挂起（防静默丢失）*/
  requeueScheduledQueuesFor: (oldSessionId: string | null) => void
  /**
   * 计划审批「意见式继续规划」的反馈消息插入。意见应答（answer≠approve 反馈式拒绝）
   * 服务端回合不终止：反馈被合成 user 消息插入 transcript，AI 的后续输出仍在同一
   * turn 流式——反馈必须插在流式消息拆分处，直接 append 尾部会钉在流式尾部直到
   * 回合结束重拉才归位（缺陷Q，2026-08-24 实测）。
   */
  insertFeedbackMessage: (text: string) => void
}

/** 审批意见回显豁免窗口：意见应答到服务端 guide 回显（steerDrained）到达的合理时距上限 */
const PLAN_FEEDBACK_ECHO_MS = 15000
/** 撤销引导竞态观察窗口（缺陷BQ）：回插后等 steerDrained 迟到的上限。注入受理
 * 到落位正常秒级内；超窗未命中 = 撤销真成功，回合结束收口作废（双保险） */
const STEER_CANCEL_RESTORE_MS = 30000

let bridgeInitialized = false

export const useStore = create<StoreState>((set, get) => ({
  connectionStatus: 'connecting',
  lastError: null,
  residentPoolNotice: null,
  titleRegeneratingSessionId: null,
  sessionTitleRegenError: null,
  projectPath: '',
  linkedWorkspaces: [],
  activeWorkspacePath: '',
  bootWorkspace: '',
  bootRestorePending: false,
  sessionsWorkspace: '',
  sessionsLoading: false,
  envStatus: null,
  envSaving: false,
  pendingSettingsSection: null,
  proxyConfig: null,
  proxySaving: false,

  sessions: [],
  provisionalTitles: {},
  currentSessionId: null,
  currentWorkspacePath: '',
  skipInitialSessionRestore: false,
  creatingSession: false,
  pendingFirstMessage: null,
  pendingFirstAttachments: null,
  pendingFirstScheduledFireAt: null,
  pendingScheduleCreation: null,
  pendingGoalCreation: null,
  archivedSessions: [],
  archivedLoading: false,
  autoArchiveConfigLoaded: false,
  autoArchiveEnabled: false,
  autoArchiveDays: 7,
  autoArchiveRecords: [],
  autoArchiveRunning: false,
  autoArchiveLastRunCount: null,
  autoArchiveLastRunSkipped: false,
  autoArchiveLastSweepAt: null,

  messages: [],
  loadingMessages: false,

  todos: [],
  agents: [],
  fileChanges: [],

  turnFileChanges: {},
  turnFileChangesDialogFor: null,
  turnFileChangesDialogPath: null,
  turnFileChangesDialogRewind: false,

  subagentActivities: [],
  subagents: [],
  subagentDetail: null,
  subagentReport: null,
  markdownPreview: null,
  askUserReview: null,
  changelogOpen: false,
  remotePairingOpen: false,
  remoteState: 'idle',
  remoteQrUrl: null,
  remoteDeviceName: null,
  remoteError: null,
  childMessages: {},
  childMessagesLoading: false,
  childMessagesError: null,
  childSessionKeys: {},
  childSessionV4: {},
  childLiveMessages: {},
  childStreamingIds: {},

  streaming: false,
  streamingMessageId: null,
  waitingSince: null,
  compacting: false,
  backgroundTasks: {},
  queuedMessages: [],
  steerPending: null,
  steerCancelRestore: null,
  steeredMessageIds: readSteerMarkers(),
  planFeedbackEcho: null,
  goal: null,
  editingMessageId: null,
  editReplay: null,
  editViaV4: null,
  forkBusy: false,
  forkSupported: true,
  scheduledMessages: [],
  firedHistory: [],
  lastScheduledListTs: 0,
  askUser: null,
  exitPlanApproval: null,
  permissionRequest: null,
  askUserPendingActive: false,
  currentFileRef: null,
  currentFileEnabled: false,

  models: [],
  modelsRefreshing: false,
  billingKeySource: null,
  teamPlanNoOverride: false,
  currentModel: null,
  modelInvalidated: false,
  modelAppliedSessions: new Map<string, number>(),
  modelAckSessions: new Set<string>(),
  createdSessionIds: new Set<string>(),
  modelSettledSessions: new Set<string>(),
  thoughtLevel: null,
  currentMode: null,
  prePlanMode: null,
  planApprovalAnswer: null,
  agentPlanActive: false,
  thoughtLevelAppliedForSession: null,
  modelSwitchInFlightAt: null,
  modelPendingSwitch: null,
  modelSwitchPrevModel: null,
  syntheticModelChanges: {},
  lastNotice: null,
  pendingThoughtLevel: null,
  contextUsage: null,
  contextBreakdown: null,
  sessionDebug: null,
  quota: null,
  quotaLoading: false,
  quotaFetchedAt: 0,
  usageProvider: null,
  memoryFiles: null,
  memoryWorkspace: '',
  memoryDir: null,
  memorySearchResults: null,
  memorySearchActiveQuery: '',
  memorySearching: false,
  memoryLoading: false,
  memoryCreatingPath: null,
  memoryError: null,
  memoryEnabled: null,
  cuaEnabled: null,
  cuaToggling: false,
  cuaIcons: {},
  cuaInputButton: readCuaInputButtonConfig().showInInputBox,
  memoryToggling: false,
  statusPanelCollapsed: readStatusPanelConfig().collapsed,
  askAnsweredAt: {},
  askAskedAt: {},

  browserConfig: null,
  browserBusy: null,
  browserError: null,
  browserCleared: null,
  browserOverview: null,

  skills: null,
  enhancing: false,
  enhanceDialogOpen: false,
  enhanceResult: null,
  subagentDefs: null,
  selectedAgent: null,
  agentSavedSignal: null,
  skillsLoading: false,
  skillsWorkspace: '',
  skillTogglingPath: null,
  skillsError: null,
  slashCommands: null,
  slashCommandsRequested: false,

  mcpServers: null,
  mcpLoading: false,
  mcpChecking: false,
  mcpError: null,
  mcpToolsByServer: {},
  mcpLogs: null,
  mcpLogsLoading: false,
  trajectory: null,
  trajectoryError: null,
  trajectoryLoading: false,

  modelProviders: null,
  modelManageLoading: false,
  modelManageError: null,
  modelConfigPath: null,
  modelManageNewCli: false,
  modelRemigrateAvailable: false,
  modelRemigrating: false,
  modelRemigrateResult: null,
  modelTogglingId: null,
  modelTogglingKey: null,
  providerSaving: false,
  providerSaveError: null,
  connectivityTestingId: null,
  connectivityResults: {},
  pendingInteractionCounts: {},
  pinnedSessionIds: [],
  unreadSessionIds: [],
  backgroundWorksBySession: {},
  workspaceHookAdmissionBySession: {},
  backgroundWorksFromTranscript: [],
  deliveredWorkStatuses: new Map(),
  remoteRunningTurns: {},
  modelProvidersReordering: false,
  modelUsage: null,
  toolUsage: null,
  usageRange: '7d',
  customStart: null,
  customEnd: null,
  usageError: null,
  quotaBannerError: null,
  // 初值即并入持久静默键（dev/mock 的 localStorage 直读；JCEF 冷启动此处通常为空，
  // 由 KV 水合 reloadKvPrefs 与 storage 跨标签同步兜底）
  quotaBannerDismissed: mergeLiveQuotaBannerDismissals([]),
  appUsage: null,
  appUsageRange: '7d',
  appUsageError: null,

  init: () => {
    if (bridgeInitialized) return
    bridgeInitialized = true

    initBridge()
    onMessage((msg: JavaResponse) => handleResponse(msg, set, get))
    // 批量流式事件（Java 端 16ms 节流合并）：一次处理整批，只 set 一次
    onStreamBatch((sid: string, events: StreamEvent[]) => handleStreamBatch(sid, events, set, get))
    // 单事件兜底（mock 模式 + Java 端关键事件走 streamEvent 单推）
    onStreamEvent((sid: string, event: StreamEvent) => handleStreamEvent(sid, event, set, get))

    // IDE 广播：envSave 保存成功后多标签同步最新环境状态（Panel broadcastEnvStatus）
    // node 测试环境（vitest）无 window，跳过注册
    if (typeof window !== 'undefined') {
      // kv 偏好的迟水合校正（steer 标识 / 状态栏折叠态 / 输入框电脑操作按钮）：
      // store 模块创建先于 main.tsx 的 initPersist()，初值读到的可能是水合前的空
      // localStorage。⚠️ initPersist 在桥注入早已就绪（JCEF executeJavaScript 通常
      // 先于前端脚本）时会在 render 前同步完成水合并派发 KV_HYDRATED——此处补挂的
      // 事件监听永远等不到（App changelog 弹窗同坑，双信号修法参照）：先查
      // isKvHydrated() 直接重读，事件只兜异步到达分支。KV_DISABLED（dev/mock，
      // localStorage 即权威源）时模块初值本就正确，无需校正
      if (typeof window.addEventListener === 'function') {
        const reloadKvPrefs = () => set({
          steeredMessageIds: readSteerMarkers(),
          statusPanelCollapsed: readStatusPanelConfig().collapsed,
          cuaInputButton: readCuaInputButtonConfig().showInInputBox,
          quotaBannerDismissed: mergeLiveQuotaBannerDismissals(get().quotaBannerDismissed),
        })
        if (isKvHydrated()) {
          reloadKvPrefs()
        } else {
          window.addEventListener(KV_HYDRATED_EVENT, reloadKvPrefs, { once: true })
        }
        // 额度横幅跨标签静默：其他标签关闭低额提醒后 storage 事件实时并入本标签
        // （本标签写 localStorage 不触发 storage 事件，无回环；key=null 是 clear 广播，并入无害）
        window.addEventListener('storage', (e) => {
          if (e.key === QUOTA_BANNER_DISMISSALS_KEY || e.key === null) {
            set({ quotaBannerDismissed: mergeLiveQuotaBannerDismissals(get().quotaBannerDismissed) })
          }
        })
      }
      window.onEnvStatusChanged = (status: EnvStatus) => set({ envStatus: status })
      // IDE 广播：其他标签切换 provider 启用/禁用后多标签同步（Panel broadcastModelChanges）。
      // 与 modelToggled 应答同款合并，但不碰 modelTogglingId（由本标签自己的应答清除）；
      // modelProviders 未加载（null，未开过模型管理页）时不初始化列表、仍重拉下拉；
      // 幂等（发起标签应答后广播再达一次无害）
      window.onModelsChanged = (changes: { providerId: string; enabled: boolean; modelId?: string }[]) => {
        // 与 modelToggled 应答同款合并（含模型级 changes），但不碰本标签的 toggling 态
        const providers = applyModelToggleChanges(get().modelProviders, changes)
        if (providers) set({ modelProviders: providers })
        get().loadModels()
      }
      // IDE 广播：其他标签增/改/删渠道后多标签同步（Panel afterProviderStructureChange）。
      // 结构变更无法就地合并（新增/删除条目），统一全量重拉模型管理页
      window.onModelManageChanged = () => {
        get().loadModelManage()
      }
    }

    /**
     * 冷启动时 Kotlin 桥注入（onLoadStart/onLoadEnd → invokeLater → executeJavaScript）
     * 可能晚于 React useEffect → init() 的执行。若一次性判定 isInJcef() 会误判为 mock，
     * 后续 loadSessions/sendToJava 落入 mockRespond 返回假数据（手动刷新才恢复）。
     *
     * 判断逻辑：
     * - isInJcef() 首次即 true → 桥已就绪，直接拉数据（热启动/刷新场景）
     * - isInJcef() false 但运行在浏览器（window 存在）→ 可能是 JCEF 冷启动桥未注入，
     *   轮询 window.__ZCODE_CEF_QUERY__ 就绪后再拉（同 persist.ts initPersist 硬化模式）
     * - 测试环境（isInJcef 被 mock 为 false，jsdom 有 window 但无桥注入）→ 轮询超时后
     *   走 mock 兜底；fake timers 下 setTimeout 不自动推进，测试需手动控制（见各 spec beforeEach）
     */
    const ws = getWorkspacePath()
    set({ projectPath: ws })
    // 标签初始目录（多目录会话）：按标签类型分叉——
    //   会话标签（gotoSession「新标签页打开」/重启恢复，initialSessionId 非空）：
    //     只落 bootWorkspace 服务绑定会话恢复，落位恒本项目（用户定稿 2026-10-27），
    //     chips 高亮/新会话落位不随"打开了别的目录的旧会话"漂移；
    //   「新建会话」开的空标签（无绑定会话，用户点按钮即表达"在此目录新建"）：
    //     落位即标签目录——徽标/chips 高亮/列表作用域/createSession 全按它走
    //     （真机 2026-10-28：新标签没带工作区徽标），无恢复需求不进 boot 链
    const tabWs = getTabWorkspacePath()
    if (tabWs && tabWs !== ws) {
      if (getInitialSessionId()) set({ bootWorkspace: tabWs, bootRestorePending: true })
      else set({ activeWorkspacePath: tabWs })
    }

    // 桥就绪统一动作（热启动/冷启动轮询就绪/mock 态迟到恢复三处共用）：
    // 拉反向请求挂起状态 + 定时消息列表（页面刷新/重载会错过 Java 广播）+ 环境检查 +
    // 会话与模型列表 + 配额轮询
    const onBridgeReady = (how: string) => {
      set({ connectionStatus: 'connected' })
      console.log(`[store] 桥就绪（${how}），workspace=${ws || '(空)'}`)
      sendToJava({ op: 'askUserPendingState' })
      sendToJava({ op: 'scheduledList' })
      // 关联目录列表（多目录会话·变体A：历史页 chips 渲染）
      sendToJava({ op: 'getLinkedWorkspaces' })
      // 注入空串兜底（详见 ensureProjectPath 注释）
      get().ensureProjectPath()
      // 拉取当前打开文件 ref（Kotlin 同步回包，case 'currentFile' 落 state）；
      // 后续变化由 EditorContextTracker 200ms 防抖主动推送覆盖
      get().requestCurrentFile()
      get().checkEnv()
      get().loadSessions()
      get().loadModels()
      startQuotaPolling()
    }

    if (isInJcef()) {
      // 桥已就绪（热启动/刷新）：直接拉数据
      onBridgeReady('热启动')
      return
    }

    // 可能是 JCEF 冷启动（桥未注入完）或 dev/测试环境
    // 测试环境（vitest）无桥注入，跳过轮询直接走 mock（fake timers 不推进 setTimeout）
    if (import.meta.env?.VITEST) {
      set({ connectionStatus: 'mock' })
      console.log(`[store] 测试环境，连接=mock，workspace=${ws || '(空)'}`)
      get().checkEnv()
      get().loadSessions()
      get().loadModels()
      startQuotaPolling()
      return
    }

    // JCEF 冷启动：轮询 window.__ZCODE_CEF_QUERY__ 就绪后再拉数据
    // （同 persist.ts initPersist 硬化模式：桥注入可能晚于 React init 执行）
    let bridgeRetries = 0
    const waitForBridge = () => {
      if (typeof window !== 'undefined' && typeof window.__ZCODE_CEF_QUERY__ === 'function') {
        onBridgeReady(`轮询 ${bridgeRetries}×50ms`)
        return
      }
      if (++bridgeRetries <= 200) {
        setTimeout(waitForBridge, 50)
        return
      }
      // 超时先落 mock（200×50ms=10s：真机冷启动/重装后首开桥注入可能显著慢于 2s，
      // 放宽前超时误入 mock 态——假会话列表+「mock 不支持」横幅）。
      // 同时挂低频恢复轮询：桥迟到注入完成（IDE 卡顿场景）时自动从 mock 恢复 connected
      // 并重拉真数据，避免永远停在假列表。恢复动作幂等（loadSessions/loadModels 全量拉）
      set({ connectionStatus: 'mock' })
      console.log(`[store] 桥等待超时，回退 mock（低频恢复轮询已挂），workspace=${ws || '(空)'}`)
      get().checkEnv()
      get().loadSessions()
      get().loadModels()
      startQuotaPolling()
      const recoverTimer = setInterval(() => {
        if (isInJcef()) {
          clearInterval(recoverTimer)
          onBridgeReady('mock 态迟到恢复')
        }
      }, 2000)
    }
    waitForBridge()
  },

  loadSessions: () => {
    // 记录请求发出时刻：响应合并时比对 titleUpdatedAt，早于它的快照标题不采用（防回退守卫）
    listSessionsSentAt = Date.now()
    // 标签初始目录一次性消费（多目录会话）：仅 boot 首拉用它（绑定会话恢复依赖）。
    // 目录取值链：boot > 落位(activeWorkspacePath) > **延续当前列表作用域(sessionsWorkspace)**
    // > 本项目——第三级是 boot 消费后、用户尚未点过 chips 的窗口期：例行刷新（手动刷新/
    // 归档拉取）必须延续标签初始目录，否则列表会闪切回本项目（真机 2026-10-28 同根）
    const boot = get().bootWorkspace
    const ws = boot || get().activeWorkspacePath || get().sessionsWorkspace || get().projectPath
    if (boot) set({ bootWorkspace: '' })
    // sessionsWorkspace 随请求同步——响应侧 staleLocal 补插/boot 恢复按它过滤跨目录条目
    set({ sessionsWorkspace: ws })
    // 加载态兜底（切目录清空列表后 loading 永挂防线）：15s 无响应自动解除。
    // 正常路径由响应归约清除；乱序丢弃不清（新请求在途）
    if (get().sessionsLoading) {
      if (sessionsLoadingTimer) clearTimeout(sessionsLoadingTimer)
      sessionsLoadingTimer = setTimeout(() => {
        if (get().sessionsLoading) set({ sessionsLoading: false })
      }, 15_000)
    }
    sendToJava({ op: 'listSessions', workspacePath: ws })
    // 顺带对账置顶集（tasks-index 指纹缓存命中时零 node 进程；顺带吸收官方桌面端
    // 在库里的 pin 变化——广播只覆盖本进程写，跨进程写靠这条对账）
    sendToJava({ op: 'listPinnedSessions' })
    // 顺带对账未读集（同一条 tasks-index 读缓存；吸收官方桌面端/手机端置的未读位）
    sendToJava({ op: 'listUnreadSessions' })
  },

  setActiveWorkspace: (path) => {
    const target = path || get().projectPath
    // 幂等早退基准 = 当前列表实际作用域（sessionsWorkspace），不是落位 activeWorkspacePath：
    // boot 首拉窗口期（标签初始目录=关联目录、落位仍空=本项目）二者脱节——此时点"本项目"
    // 必须真正重拉把列表切回来（真机 bug 2026-10-28：高亮本项目但列表停在 suiteng）。
    // sessionsWorkspace 为空（未初始化）不参与比较（否则 fallback target 恒早退）
    const currentScope = get().sessionsWorkspace
    if (currentScope && normalizeWsPath(target) === normalizeWsPath(currentScope)) {
      // 列表已在该目录：仅对齐落位（boot 消费后 activeWorkspacePath 可能仍空）
      if (normalizeWsPath(get().activeWorkspacePath || get().projectPath) !== normalizeWsPath(target)) {
        console.log(`[store] 列表已在该目录，仅对齐落位: ${target}`)
        set({ activeWorkspacePath: target })
      }
      return
    }
    console.log(`[store] 切换激活目录: ${target}`)
    // 切换即清空+进加载态（用户定稿）：旧目录列表残留展示比空白更误导（用户实测
    // "一直显示其他目录的"）。归档缓存同步清（拉取式）；sessions 由响应全量替换，
    // 乱序晚到的旧响应按归约守卫丢弃（Kotlin 应答回显 workspacePath）
    set({
      activeWorkspacePath: target,
      sessions: [],
      archivedSessions: [],
      sessionsLoading: true,
    })
    get().loadSessions()
  },

  // projectPath 兜底拉取：__ZCODE_WORKSPACE__ 注入空串（IDE 重启初期面板先于 basePath
  // 就绪，Kotlin buildBridgeJs 注释同款场景）时 store 只在 init 读一次注入值、空串固化，
  // 徽标「本项目不显示」判等失真（真机 2026-10-29 双窗口重启实测：本项目会话恒显示
  // 目录徽标）。桥就绪后为空则拉一次，Java 按生效口径（basePath→user.dir）回
  ensureProjectPath: () => {
    if (get().projectPath) return
    sendToJava({ op: 'getProjectPath' })
  },

  addLinkedWorkspace: () => {
    sendToJava({ op: 'addLinkedWorkspace' })
  },

  removeLinkedWorkspace: (path) => {
    sendToJava({ op: 'removeLinkedWorkspace', path })
  },

  toggleSessionPin: (sessionId, pinned) => {
    // 无乐观更新：Java 写库（tasks-index UPSERT）后全标签广播真实集，广播即状态
    sendToJava({ op: 'setSessionPinned', sessionId, pinned })
  },

  cancelBackgroundWork: (sessionId, workId) => {
    // ACK 拒绝（not_found/not_running/cancel_not_supported）不抛错，投影不动即天然反馈；
    // 成功后条目转 cancelled/消失由 backgroundWorks 事件收敛，此处无乐观更新
    sendToJava({ op: 'cancelBackgroundWork', sessionId, workId })
  },

  requestCurrentFile: () => {
    // 拉取当前打开文件 ref（Kotlin 端 EditorContextTracker.snapshot() 同步回包）。
    // webview mount 时调一次，case 'currentFile' handler 落 state；
    // 之后由 EditorContextTracker 200ms 防抖主动推送。
    sendToJava({ op: 'getCurrentFile' })
  },

  setCurrentFileEnabled: (enabled) => {
    set({ currentFileEnabled: enabled })
  },

  selectSession: (session) => {
    // 历史列表点回当前会话 = 无操作（HistoryView 侧只负责切回 chat 视图）。
    // 不短路的话下方 set 会清空 messages/streaming 把进行中的实时流顶掉，
    // 且 streaming 被复位后重拉的 messages 响应不再被丢弃，全量替换会抹掉
    // 流式中的 assistant 消息（断流/叠字），重发 subscribe 还会打扰运行中的回合
    if (session.sessionId === get().currentSessionId) return
    // 切走前回退：队列里定时来源的消息交还 Java 挂起（不随队列丢弃，见 requeueScheduledQueuesFor）
    get().requeueScheduledQueuesFor(get().currentSessionId)
    // 服务端活跃信号绑定会话：切走后旧会话 usage 响应被丢弃，信号一并清空
    // （新会话的 loadUsage 会重新建立；防残留信号豁免新会话的判死判定）
    serverActiveTurnId = null
    cancelSwitchStallHint() // 挂死提示定时器绑定旧会话，一并撤销
    const workspacePath = session.workspacePath || get().projectPath
    set({
      currentSessionId: session.sessionId,
      currentWorkspacePath: workspacePath,
      modelInvalidated: false, // 切会话后按新会话消息推断模型是合理行为，解除失效锁定
      // 模型显示取该会话自己的记忆（缺陷BI：会话级记忆）；无记忆置空，等消息快照
      // inferCurrentModel 推断——不再沿用上一会话/全局记忆的显示（别的会话选过的
      // 模型不该出现在这里）；own 存在时紧随其后的 applyModelIfReady 会重放同值
      currentModel: readSessionModel(session.sessionId),
      modelPendingSwitch: null, // 旧会话的延迟切换提示不带到新会话（补发 modelSet 有 sessionId 守卫）
      modelSwitchPrevModel: null,
      lastNotice: null,
      ...sessionResetBase(),
      loadingMessages: true, // 切换后要拉取消息历史
      compacting: false,
      backgroundTasks: {},
      contextUsage: null, // 清空旧会话数据，等 getUsage 回来更新
      sessionDebug: null,
      contextBreakdown: null,
      thoughtLevel: null, // 清空旧会话设置，等 getSettings 回来更新（currentMode 由 messages 推断兜底）
      subagentReport: null,
      markdownPreview: null,
      askUserReview: null,
      // 模型切换在途标记与推迟的级别补发绑定旧会话流程，切会话作废
      modelSwitchInFlightAt: null,
      pendingThoughtLevel: null,
    })
    // 切换会话时订阅事件流（带 workspacePath，Java 端 subscribe 前要先 resume 激活会话）
    sendToJava({ op: 'subscribe', sessionId: session.sessionId, workspacePath })
    sendToJava({ op: 'messages', sessionId: session.sessionId, workspacePath })
    // 后台工作投影缓存对账（历史加载兜底）：重复 v4 subscribe 不重推快照（B2②坑），
    // 跨标签/重复打开时订阅帧缺席——Java 进程缓存是本进程最后已知投影
    sendToJava({ op: 'backgroundWorksList', sessionId: session.sessionId })
    // P2 让路（缺陷AB 优先级编排②）：用量/子代理不再与 P0 并发挤服务端会话队列，
    // 改由 messages 首拉落地后补发（见 case 'messages'）——忙窗口期间 P0 未成功
    // 则不补发，顶栏只剩一条"恢复中"提示
    // 拉取运行时设置（mode + 思考级别，级别列表随模型变化）
    get().loadSettings()
    // 会话切换后重放该会话自己的模型记忆——挂到 subscribed 回执后错峰下发（十五轮：
    // 大会话冷启动时 resume/messages 堵 app-server 单线程队列 10s+，即发 setModel 必然
    // 排队超时、还反过来挤压 subscribe 的超时窗；订阅回执=resume 已完成、队列已消化）。
    // 回执丢失（订阅失败）时由 12s 兜底定时器触发，不丢恢复
    scheduleModelApplyAfterSubscribe(session.sessionId)
  },

  sendMessage: (text, attachments?, opts?) => {
    if (!text.trim() && !attachments?.length) return
    const sid = get().currentSessionId
    // 懒创建：无会话（新标签 / 会话被删）时首条消息先触发建会话，createSession 响应后
    // 自动发出暂存消息。先置 streaming 让等待动画立即出现；等待期的后续消息因
    // streaming=true 走下方入队分支，回合结束后 flushQueue 兜底发出
    if (!sid && !get().creatingSession) {
      lastStreamActivityAt = Date.now() // 看门狗基准：等待从此刻起算
      set({
        streaming: true,
        streamingMessageId: null,
        waitingSince: Date.now(),
        lastError: null,
        pendingFirstMessage: text,
        pendingFirstAttachments: attachments ?? null,
        pendingFirstScheduledFireAt: opts?.scheduledFireAt ?? null,
      })
      // creatingSession 由 createSession 内部置位（其防重入守卫据此拦截重复请求）
      get().createSession()
      return
    }
    // 对话进行中：不丢弃，入队等待（回合结束自动发队头，对齐 cc-gui useMessageQueue）
    if (get().streaming) {
      set((s) => ({
        queuedMessages: [
          ...s.queuedMessages,
          {
            id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            text,
            ...(attachments?.length ? { attachments } : {}),
            queuedAt: Date.now(),
            ...(opts?.scheduledFireAt ? { scheduledFireAt: opts.scheduledFireAt } : {}),
            ...(opts?.scheduledModelId ? { scheduledProviderId: opts.scheduledProviderId, scheduledModelId: opts.scheduledModelId } : {}),
          },
        ],
      }))
      return
    }

    // 兜底：无会话且不在建会话流程（正常应已被懒创建/入队分支拦截）
    if (!sid) return

    lastStreamActivityAt = Date.now() // 看门狗基准：send 发出即开始静默计时
    // /compact 即时进入压缩态：摘要生成期间事件流完全静默（实测 63s+），
    // 不置位的话 UI 只有空气泡转圈、看门狗还会误判流丢失。
    // 权威校正走 usage 轮询的 activeTurnKind（覆盖 autocompact）
    const isCompactCmd = /^\/compact\b/.test(text.trim())
    if (isCompactCmd) compactingServerConfirmed = false // 新一轮压缩：服务端确认闩复位
    set({
      streaming: true,
      streamingMessageId: null,
      waitingSince: Date.now(),
      lastError: null,
      ...(isCompactCmd ? { compacting: true } : {}),
    })

    // 确保已订阅（规格书 §4：先 subscribe 再 send，否则丢事件）
    sendToJava({ op: 'subscribe', sessionId: sid, workspacePath: get().currentWorkspacePath })
    // 发送（附带 currentModel：-32031 恢复时用用户选择的 provider 而非默认 provider，
    // 避免重装后既有会话 resume 恢复时被静默切到个人套餐导致显示与实际不符）。
    // 定时消息指定了执行模型且清单里仍存在 → 覆盖；已下架（清单查不到）→ 默认兜底（currentModel）
    const cm = get().currentModel
    const schedModel = opts?.scheduledModelId
      ? get().models.find(
          (m) => m.modelId === opts.scheduledModelId &&
            (!opts.scheduledProviderId || m.providerId === opts.scheduledProviderId),
        )
      : undefined
    // 挂起切换目标（2026-09-14 实测：回合中切换被 Java 挂起后 modelSetPending 已把
    // currentModel 回滚到旧模型、清掉在途标记，目标只剩 modelPendingSwitch 持有——
    // 此刻回合结束 flush 排队消息若照旧取 currentModel 就按旧模型发出，Java 补发撞上
    // 新回合再次挂起，切换永远追着排队回合跑）。挂起目标仍在清单才用（下架回退 cm）
    const pend = get().modelPendingSwitch
    const pendingSwitchModel = pend?.sessionId === sid
      ? get().models.find((m) => sameModel(m, pend))
      : undefined
    const sendModel = schedModel
      ? { providerId: schedModel.providerId, modelId: schedModel.modelId }
      : pendingSwitchModel
        ? { providerId: pendingSwitchModel.providerId, modelId: pendingSwitchModel.modelId }
        : cm
    // 受理定时指定模型时同步切换会话模型（下拉跟随、后续手动消息沿用）：本回合正确性
    // 由 send 自带 runtimeModel 保证；setModel 在回合中会被 Java 挂起至回合结束补发
    // （延迟切模型机制），互不冲突
    // 等待判定必须在 setModel 之前：目标=当前显示模型时 setModel 走 no-op 分支会清掉
    // 在途标记（切回语义），但真实切换仍可能在途（ack 未回），send 不能贴上去。
    // 挂起切换同样算在途：必须等 Java 回合结束补发落定再发（send 紧贴补发会撞服务端
    // 回合清算滞后窗口，2026-08-30 实测写坏运行时状态），模型取值也依赖落定结果
    const curModel = get().currentModel
    const switchUnderway = isModelSwitchInFlight(get())
      || (!schedModel && pendingSwitchModel != null)
      || (schedModel != null && !sameModel(curModel, schedModel))
    if (schedModel) get().setModel(schedModel.modelId, schedModel.providerId)
    const wsPath = get().currentWorkspacePath
    const doSend = () => {
      // 放行时刻重算（仅挂起目标路径）：等待期间补发可能已落定——成功（modelSet ack
      // 清挂起，currentModel=目标）或失败（modelSetFailed 清挂起，currentModel=回滚后
      // 旧模型），以落定后的现值为准，别对已失败的目标开回合；仍未落定（6s 超时放行）
      // → send 自带目标 runtimeModel 顶上，回合正确性由 send 携带保证
      const finalModel = pendingSwitchModel
        ? (get().modelPendingSwitch?.sessionId === sid ? sendModel : (get().currentModel ?? sendModel))
        : sendModel
      sendToJava({
        op: 'send',
        sessionId: sid,
        text,
        workspacePath: wsPath,
        ...(finalModel ? { providerId: finalModel.providerId, modelId: finalModel.modelId } : {}),
        // 缺陷CX：UI 当前思考档随 send 喂给协议端缓存——懒创建首条消息路径（待命态
        // 预选档位直接发送）webview 从不下发 setThoughtLevel（防 -32603 赛跑的旧守卫），
        // 协议端缓存必 miss，send 只能带目录默认档 max，回合跑完 UI 即被顶回最高。
        // 档位随 send 的 modelSelection 一同到达，无「先到对旧模型非法」问题；UI 显示
        // 值本身由 settings 响应服务端校准，稳态 UI=服务端
        ...(finalModel && get().thoughtLevel?.enabled ? { thoughtLevel: get().thoughtLevel?.current } : {}),
        ...(attachments?.length ? { attachments } : {}),
      })
      // 「已发出但被服务端排队」防御打点（缺陷FD）：服务端在繁忙窗口把发送静默降级
      // 为 delivery=queue 时，flushQueue/入队链路无感知——此处登记供 turn.steerQueued
      // （带 input 全文）回认领并促发（见 handleFlushedSendQueuedDefence）
      recordRecentFlushedSend(sid, text, attachments, opts?.scheduledFireAt)
      // 首条 send 落地即关闭 applyModelIfReady 的新建豁免（缺陷EF）：send 恒带
      // runtimeModel 已兜正服务端模型，此后重放链对该会话只承担"真切换"职责
      set({ modelSettledSessions: new Set(get().modelSettledSessions).add(sid) })
      // 定时消息真发上报：Java 记入已发历史（持久化），历史重拉/重启后按 sessionId+text
      // 匹配补「定时执行」徽标——服务端消息本身不带任何定时标记
      if (opts?.scheduledFireAt != null) {
        sendToJava({ op: 'scheduledFired', sessionId: sid, text, fireAt: opts.scheduledFireAt })
      }
    }
    // 切换在途（定时 flush 的 setModel 刚发出 / 用户手动切换后立刻发送）时等落定再发：
    // setModel+send 背靠背且紧贴上一回合 turn.completed 会撞服务端回合清算滞后窗口，
    // 实测（2026-08-30）把该会话新模型运行时状态写坏并落盘——所有后续该模型回合无声挂死。
    // 乐观 UI（下方用户消息/标题占位）不等待，立即呈现
    if (switchUnderway) {
      void waitForModelSwitchSettled(6000, sid).then(doSend)
    } else {
      doSend()
    }

    // 本地把用户消息立即加入列表（不等 reload，体验更快）；
    // 图片附件同时以 image part 乐观展示（dataUrl 直接渲染）。
    // hiddenCommand（编辑重放的 /rewind 命令）：不插乐观消息——命令轮不进 UI
    //（快照侧服务端已剪除，diag-rewind-meta.py 实测），乐观标题同理不占位
    if (!opts?.hiddenCommand) {
      const userMsg = optimisticUserMessage(sid, text, attachments, {
        ...(opts?.scheduledFireAt ? { scheduledFireAt: opts.scheduledFireAt } : {}),
      })
      set((s) => ({ messages: [...s.messages, userMsg] }))
      // 发送落位凭据登记（缺陷FF）：hiddenCommand（编辑 /rewind 等内部编排）不挂哨
      armAdmission(sid, text, attachments, String(userMsg.info.id))

      // 乐观标题：新会话首条消息立即占位（CLI 要等首轮对话结束才生成正式标题，长任务期间
      // header/标签 tooltip 一直是「新会话」）。仅该会话首个临时标题生效（与 CLI 取首轮
      // 输入作标题一致）；正式标题由 session.titleUpdated 事件或 listSessions 刷新替换
      const curTitle = get().sessions.find((s) => s.sessionId === sid)?.title
      if (!get().provisionalTitles[sid] && isDefaultSessionTitle(curTitle, sid)) {
        const provisional = deriveProvisionalTitle(text)
        if (provisional) {
          set((s) => ({
            provisionalTitles: { ...s.provisionalTitles, [sid]: provisional },
            sessions: s.sessions.map((x) => (x.sessionId === sid ? { ...x, title: provisional } : x)),
          }))
        }
      }
    }
  },

  startEdit: () => {
    const st = get()
    // 回合中开放编辑的前提是 v4 通道可用（服务端 abort+重发，diag-edit-v4）；
    // legacy /rewind 与活动回合互斥，维持仅空闲态
    const v4Edit = st.editViaV4 !== false && st.forkSupported !== false
    const interactionPending = !!(st.askUser || st.exitPlanApproval || st.permissionRequest || st.askUserPendingActive)
    if (st.editingMessageId || st.editReplay || st.steerPending || interactionPending) return
    if (st.streaming && (!v4Edit || st.compacting)) return
    const target = findEditableUserMessage(st.messages, { allowImages: v4Edit })
    if (!target) return
    set({ editingMessageId: target.info.id })
  },

  cancelEdit: () => {
    if (get().editingMessageId) set({ editingMessageId: null })
  },

  /**
   * 从历史消息分叉新会话（B2 一期）：session/fork 保留到目标消息（含）。
   * 入口在 assistant 回复的 footer「已工作」行，target=该回复（保留到它为止，从这条
   * 回复之后岔出去试另一方案）。命名/打开编排见 case 'sessionForked'。
   * 守卫是消息级而非会话级（diag-fork29 实测定案）：回合进行中分叉已完成历史轮，
   * 服务端照常受理——canFork 不随活跃回合收回、CAS 用 revisionAtDecision 重试一次即过、
   * 新会话快照完整（历史两条原文保留+fork 来源合成消息，不含进行中轮）、原回合不受扰。
   * 只挡：目标消息本身在流式（中间态无意义，按钮层已按消息级 streaming 隐藏，双保险）
   * 与编辑重放期（rewind 截断历史中，分叉目标可能被截）。
   */
  forkFromMessage: (sessionId, messageId) => {
    const st = get()
    if (st.forkBusy) return
    if (st.editReplay || messageId === st.streamingMessageId) {
      set({ lastError: i18n.t('chat.fork.busy') })
      return
    }
    set({ forkBusy: true })
    sendToJava({ op: 'forkSession', sessionId, messageId })
  },

  /**
   * 提交编辑（编辑重新生成），双通道：
   * v4 主路径（diag-edit-v4 实测定案）——op:editUserQuery（Java → v4/command），
   *   服务端执行链自带「活动回合先 abort」+ rewind + 用新文本/附件重发，故
   *   **回合进行中也可编辑**（带图编辑同样走此通道，images 传全量附件清单）；
   *   ack 应答前 rewind.triggered/turn.started 可能已先到（探针实测乱序），
   *   乐观置 editReplay 让截断编排不等 ack。
   * legacy 回退（老 CLI 无 v4 面）——
   * 1. 守卫（回合进行中/排队非空/编辑目标已过期则放弃）
   * 2. 发 `/rewind conversation <msgId>`（hiddenCommand：不插乐观消息）——
   *    服务端截断模型上下文，rewind.triggered 事件到达时截断内存消息并落 kv 记忆
   * 3. rewind turn 完成 → 300ms 常规重拉 → case 'messages' 落地（applyRewindCuts
   *    应用 kv 记忆）→ 消费 editReplay 自动重发编辑文本
   * 编辑期间会话被外部推进（目标已非最新可编辑消息）则放弃。等待审批/提问/
   * 压缩中一律不编辑（abort 挂着反向请求的回合有弹窗残留风险）。
   */
  submitEdit: (text, images) => {
    const st = get()
    const trimmed = text.trim()
    const sid = st.currentSessionId
    const targetId = st.editingMessageId
    const v4Edit = st.editViaV4 !== false && st.forkSupported !== false
    const interactionPending = !!(st.askUser || st.exitPlanApproval || st.permissionRequest || st.askUserPendingActive)
    if (!sid || !targetId || st.editReplay || st.queuedMessages.length > 0 || st.steerPending) {
      return
    }
    if (st.streaming && (!v4Edit || interactionPending || st.compacting)) return
    if (!v4Edit && (!trimmed || interactionPending)) return
    // 编辑目标仍是最后一条可编辑消息（编辑期间会话被外部推进则放弃）
    const target = findEditableUserMessage(st.messages, { allowImages: v4Edit })
    if (!target || target.info.id !== targetId) {
      set({ editingMessageId: null, lastError: i18n.t('chat.edit.staleTarget') })
      return
    }
    if (v4Edit) {
      if (st.streaming) {
        // 两段式回合中编辑（diag-edit-blocked 实锤）：服务端对「执行工具中」的回合
        // abort 不生效——直接编辑会把新文本 steerQueued 静默排队且队列不自动排水
        // （ack accepted 但永不生效）。先主动 stop（v4 stop 40ms 真终止+真实收尾帧，
        // 不带 taskIds：编辑不该连带杀后台任务），turnEnded 收到收尾帧后转第二段
        // 发 editUserQuery（届时回合已死，服务端走空闲编辑路径）
        set({
          editingMessageId: null,
          editReplay: { targetMsgId: targetId, text: trimmed, rewound: false, via: 'v4', attachments: images, stopping: true },
        })
        sendToJava({ op: 'stop', sessionId: sid })
        return
      }
      set({
        editingMessageId: null,
        editReplay: { targetMsgId: targetId, text: trimmed, rewound: false, via: 'v4', attachments: images, ackPending: true },
      })
      armEditAckTimeout()
      sendToJava({
        op: 'editUserQuery',
        sessionId: sid,
        messageId: targetId,
        newText: trimmed,
        // images=[] 也必须透传：原消息带图、编辑时被删光 = 显式清空附件清单；
        // undefined 才是"不带字段"（服务端沿用原附件，仅限纯文本消息）
        ...(images ? { attachments: images } : {}),
      })
      return
    }
    set({ editingMessageId: null, editReplay: { targetMsgId: targetId, text: trimmed, rewound: false, via: 'legacy' } })
    get().sendMessage(buildEditRewindCommand(targetId), undefined, { hiddenCommand: true })
  },

  /**
   * 意见反馈插入（缺陷Q）：对齐服务端消息树序——当前流式 assistant 消息就此
   * 封段（保留已累积 parts，含 ExitPlanMode 卡），反馈插在其后，再新建空
   * assistant 消息接管后续 delta。流式期间即呈现 [旧输出, 反馈, 新输出]，
   * 回合结束重拉落地权威顺序时无位置跳动。旧消息里 ExitPlanMode 的拒绝
   * 收尾由 turn 结束的 finalizePendingTools 兜底（batch 按 streamingMessageId
   * 定位不回旧消息，不会卡转圈）。
   */
  insertFeedbackMessage: (text) => {
    const trimmed = text.trim()
    const sid = get().currentSessionId
    if (!sid || !trimmed) return
    // 置回显豁免：服务端会把意见经 guide 通道回显（steerDrained 同形事件），
    // 命中窗口的注入跳过，防与本地插入叠加双条 + 误标「⚡引导」（0.3.3 真机缺陷）
    const echo = { text: trimmed, at: Date.now() }
    const { messages, streamingMessageId } = get()
    const userMsg: ZCodeMessage = {
      info: {
        role: 'user',
        time: { created: Date.now() },
        id: `local_u_${Date.now()}`,
        sessionID: sid,
      },
      parts: [{ type: 'text', text: trimmed }],
    }
    // 兜底：无流式消息或指向非 assistant（意见应答时回合必在流式，防御性处理）→ 尾部追加
    const idx = streamingMessageId
      ? messages.findIndex((m) => m.info.id === streamingMessageId)
      : -1
    if (idx < 0 || messages[idx].info.role !== 'assistant') {
      set((s) => ({ messages: [...s.messages, userMsg], planFeedbackEcho: echo }))
      return
    }
    // 新流式消息用独立命名空间 id：不与协议 messageId 撞车（撞上会被 turn.started
    // 复用逻辑误判），回合结束重拉时随乐观消息一并被服务端权威数据替换
    const newStreamingId = `stream_local_${Date.now()}`
    const next: ZCodeMessage[] = [
      ...messages.slice(0, idx + 1),
      userMsg,
      {
        info: { role: 'assistant', time: { created: Date.now() }, id: newStreamingId, sessionID: sid },
        parts: [],
      },
      ...messages.slice(idx + 1),
    ]
    set({ messages: next, streamingMessageId: newStreamingId, planFeedbackEcho: echo })
  },

  createSession: () => {
    // 防重入：建会话请求进行中不重复发（懒创建 + 手动 + 按钮共用）
    if (get().creatingSession) return
    set({ creatingSession: true })
    // 待命态预选的思考档随创建落档（缺陷CX 闪最高治本）：否则 create 后的例行
    // loadSettings 读到服务端初始默认档 max（赶在首条消息写回之前），UI 闪「最高」
    // 再回预选档。预选值在 thoughtLevel.current（待命态 setThoughtLevel 乐观更新）
    const tl = get().thoughtLevel
    sendToJava({
      op: 'createSession',
      // 新会话落在激活目录（多目录会话·变体A：历史页 chips 切换；Java 侧归一原生分隔符）
      workspacePath: get().activeWorkspacePath || get().projectPath,
      ...(tl?.enabled && tl.current ? { thoughtLevel: tl.current } : {}),
    })
  },

  createSessionForSchedule: (text, fireAt, providerId?, modelId?, keepCurrent?) => {
    // 定时任务先建会话：空串 sessionId 的待命项在所有新标签都可见、无法区分归属，
    // 也没有可跳转的会话。建会话拿到真实 sid 后由 createSession 响应落库 scheduledCreate。
    // keepCurrent=当前标签已有会话（勾选「在新会话中执行」）：后台建会话不切换视图——
    // 切换会顶掉正在看的会话；新会话由到点分派时 openSessionTab 按需开标签承载。
    // 待命态（无会话可覆盖）维持切换为新会话宿主
    if (get().creatingSession) return
    set({
      pendingScheduleCreation: {
        text,
        fireAt,
        ...(providerId && modelId ? { providerId, modelId } : {}),
        ...(keepCurrent ? { keepCurrent: true } : {}),
      },
    })
    get().createSession()
  },

  resetToNewSession: () => {
    // 「新建会话」按钮延迟创建（对齐新标签）：不立即建会话，重置为无会话待命态，
    // 首条消息再触发懒建会话（见 sendMessage）。旧会话保留在历史列表可切回；
    // 旧会话的流式事件被 handleStreamBatch/Event 的 currentSessionId 过滤拦截，
    // 不会串扰待命态。clearTabSession 让 Java 侧同步清 TabState 绑定 + 标签 tooltip
    //（否则重启恢复会绑回旧会话）
    get().requeueScheduledQueuesFor(get().currentSessionId)
    set({
      currentSessionId: null,
      // 切换会话置位的首拉标志必须在此解除：首拉快照回来会被 case 'messages' 的
      // sessionId 守卫整包丢弃（currentSessionId 已是 null），applyMessagesSnapshot
      // 永不执行，「加载消息中」永久卡死（缺陷FH：加载中点 + 覆盖当前标签 → 标签假死）
      loadingMessages: false,
      // 用户主动进入待命态：放弃 boot 恢复，后续 listSessions 不得把旧绑定会话选回
      skipInitialSessionRestore: true,
      // 「新会话自动点亮文件上下文」偏好（默认关）应用点之一：新建会话按钮手势
      //（另一处 = listSessions boot 待命分支，新标签=新会话）。点亮也只影响首条
      // 消息（doSend 发完即关）。切会话/删当前会话/Java 自动 newSession 均不应用
      //——保守不点亮（utils/currentFileConfig.ts 头注释）
      currentFileEnabled: readCurrentFileConfig().autoOnNewSession,
      creatingSession: false,
      pendingFirstMessage: null,
      pendingFirstAttachments: null,
      pendingFirstScheduledFireAt: null,
      ...sessionResetBase(),
      compacting: false,
      backgroundTasks: {},
      contextUsage: null,
      sessionDebug: null,
      contextBreakdown: null,
      thoughtLevel: null,
      currentMode: null,
      subagentReport: null,
      markdownPreview: null,
      askUserReview: null,
      askUser: null, // 旧会话遗留的提问/审批弹窗随会话切换关闭
      exitPlanApproval: null,
      permissionRequest: null,
      askUserPendingActive: false,
    })
    // 待命态：恢复当前模型的缓存级别集（currentMode 不水合——模式是即时意图，预选重新开始）
    get().hydrateThoughtLevelStandby()
    sendToJava({ op: 'clearTabSession' })
  },

  deleteSession: (sessionId) => {
    sendToJava({ op: 'deleteSession', sessionId })
  },

  loadArchivedSessions: () => {
    set({ archivedLoading: true })
    sendToJava({ op: 'listArchivedSessions', workspacePath: get().activeWorkspacePath || get().projectPath })
  },

  archiveSession: (sessionId) => {
    sendToJava({ op: 'archiveSession', sessionId })
  },

  restoreSession: (sessionId) => {
    sendToJava({ op: 'restoreSession', sessionId })
  },

  deleteArchivedSession: (sessionId) => {
    sendToJava({ op: 'deleteArchivedSession', sessionId })
  },

  loadAutoArchiveData: () => {
    sendToJava({ op: 'getAutoArchiveConfig' })
    sendToJava({ op: 'getAutoArchiveRecords' })
  },

  setAutoArchiveConfig: (enabled, olderThanDays) => {
    // 乐观更新（写共享 setting.json 由 Kotlin 落盘，ack 校正）
    set({ autoArchiveEnabled: enabled, autoArchiveDays: olderThanDays })
    sendToJava({ op: 'setAutoArchiveConfig', enabled, olderThanDays })
  },

  runAutoArchiveNow: () => {
    // 开关未启用不发起扫描（面板按钮同步禁用；Kotlin 侧还有终门禁言）
    if (get().autoArchiveRunning || !get().autoArchiveEnabled) return
    set({ autoArchiveRunning: true, autoArchiveLastRunSkipped: false, autoArchiveLastRunCount: null })
    // 扫描跟随历史页浏览目录（多目录会话：切到关联目录=扫该目录的过期会话），缺省项目根
    sendToJava({ op: 'runAutoArchiveNow', workspacePath: get().activeWorkspacePath || get().projectPath })
  },

  locateSessionTab: (sessionId) =>
    new Promise<boolean>((resolve) => {
      // 单槽复用：上一笔在途请求按未找到放行（模态弹窗期间不会有并发定位，仅防极端连点挂死）
      pendingTabLocate?.(false)
      pendingTabLocate = resolve
      sendToJava({ op: 'locateSession', sessionId })
    }),

  listOpenTabs: () =>
    new Promise<OpenTabInfo[]>((resolve) => {
      pendingOpenTabs?.([])
      pendingOpenTabs = resolve
      sendToJava({ op: 'listOpenSessions' })
    }),

  openSessionNewTab: (sessionId, workspacePath) => {
    sendToJava({ op: 'gotoSession', sessionId, ...(workspacePath ? { workspacePath } : {}) })
  },

  stopStreaming: () => {
    const sid = get().currentSessionId
    if (!sid) return
    // 连带中止后台任务（对齐官方客户端 stop 行为）：账本里仍在跑的后台 bash 任务
    // （exec_ id，无 endedAt）随 stop 一并交给 Java 侧 cancelBackgroundTask；
    // 运行中子代理由 Java 侧经 session/subagents 权威枚举，不依赖前端账本
    const runningTaskIds = Object.values(get().backgroundTasks)
      .filter((t) => !t.endedAt)
      .map((t) => t.id)
    sendToJava({ op: 'stop', sessionId: sid, taskIds: runningTaskIds.length ? runningTaskIds : undefined })
  },

  removeQueuedMessage: (id) => {
    set((s) => ({ queuedMessages: s.queuedMessages.filter((m) => m.id !== id) }))
  },

  sendQueuedNow: (id) => {
    const q = get().queuedMessages
    const target = q.find((m) => m.id === id)
    if (!target) return
    if (get().streaming) {
      // 移到队头 + 中断当前回合；turn 结束事件到达后 flushQueue 自动发送它
      // （send 在 stop 之后立即发出，早于回合结束重拉的 messages 请求，重拉会包含该消息）
      set({ queuedMessages: [target, ...q.filter((m) => m.id !== id)] })
      get().stopStreaming()
    } else {
      set({ queuedMessages: q.filter((m) => m.id !== id) })
      // 立即发送保持定时语义（徽标+指定执行模型），否则 queued 的定时消息在这里会丢标记；
      // /goal 命令文本转 goalManage（普通 send 会把命令原文发给模型，goal 引擎不触发）
      if (!dispatchScheduledGoalText(target.text, target.scheduledFireAt, get)) {
        get().sendMessage(target.text, target.attachments, target.scheduledFireAt != null
          ? {
              scheduledFireAt: target.scheduledFireAt,
              ...(target.scheduledModelId ? { scheduledProviderId: target.scheduledProviderId, scheduledModelId: target.scheduledModelId } : {}),
            }
          : undefined)
      }
    }
  },

  /**
   * 引导式插队（steer）：见接口注释。这里只做受理与乐观置位；chip 的清除与
   * 气泡落位全部由事件驱动（turn.steerQueued/steerDrained，批量与单推两路都拦截）。
   * commandId 前端生成——queueItemId=queue_<commandId> 是服务端确定性派生
   * （zcode.cjs f1()/Cse() 实锤），撤销/促发都要用它，不等 ack 回填。
   */
  steerMessage: (text, restore?) => {
    const trimmed = text.trim()
    const sid = get().currentSessionId
    if (!sid || !get().streaming || get().steerPending || !trimmed) return false
    const commandId = `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    set({
      steerPending: {
        text: trimmed,
        at: Date.now(),
        queueItemId: `queue_${commandId}`,
        ...(restore ? { restore } : {}),
      },
      // 上一次撤销的观察记录作废（防同文本新引导落位被误判为竞态注入）
      steerCancelRestore: null,
    })
    sendToJava({
      op: 'steerMessage',
      sessionId: sid,
      text: trimmed,
      commandId,
    })
    return true
  },

  sendQueuedAsSteer: (id) => {
    const q = get().queuedMessages
    const index = q.findIndex((m) => m.id === id)
    if (index < 0) return
    const target = q[index]
    if (!get().steerMessage(target.text, { item: target, index })) {
      // 守卫拦截（极少见：回合恰好结束/已有在途引导）——保留队列条目 + 提示
      set({ lastError: i18n.t('input.steer.notAccepted') })
      return
    }
    set({ queuedMessages: q.filter((m) => m.id !== id) })
  },

  cancelSteer: () => {
    const pending = get().steerPending
    const sid = get().currentSessionId
    if (!pending?.queueItemId || pending.cancelling || !sid) return
    set({ steerPending: { ...pending, cancelling: true } })
    sendToJava({ op: 'cancelSteer', sessionId: sid, queueItemId: pending.queueItemId })
  },

  sendScheduledNow: (id) => {
    const item = get().scheduledMessages.find((m) => m.id === id)
    if (!item) return
    // 乐观移除：点击即消失，不等 Java 广播（多面板/多线程广播乱序曾致卡片残留）
    set({ scheduledMessages: get().scheduledMessages.filter((m) => m.id !== id) })
    if (item.sessionId && get().currentSessionId === item.sessionId) {
      // 本面板正看该会话：直接走受理路径发送（与到点受理同一段代码，sendMessage 内部
      // 含 scheduledFired 上报），并 ack 让 Java 移除待发项——不再发 scheduledSendNow
      // （那会再走一轮 Java 分派推送，本面板二次受理导致重复发送）；
      // /goal 命令文本空闲时先转 goalManage（流式中服务端会拒绝 goal 操作，
      // 改走 sendMessage 入队、回合结束 flushQueue 再拦截；fired 上报在
      // dispatchScheduledGoalText 内）
      if (!get().streaming && dispatchScheduledGoalText(item.text, item.fireAt, get)) {
        // 已按 goal 命令处理
      } else {
        get().sendMessage(item.text, undefined, {
          scheduledFireAt: item.fireAt,
          ...(item.modelId ? { scheduledProviderId: item.providerId, scheduledModelId: item.modelId } : {}),
        })
      }
      sendToJava({ op: 'scheduledDueAck', id: item.id })
    } else {
      // 会话在别的标签/未打开：交 Java 分派（findPanelForSession 推送或开标签/直发兜底）
      sendToJava({ op: 'scheduledSendNow', id: item.id })
    }
  },

  cancelScheduled: (id) => {
    // 乐观移除 + Java 幂等移除（不存在/已处理按成功应答）
    set({ scheduledMessages: get().scheduledMessages.filter((m) => m.id !== id) })
    sendToJava({ op: 'scheduledCancel', id })
  },

  refreshScheduledList: () => {
    // 广播无端到端确认（executeJavaScript succeeded ≠ JS 应用成功：后台唤起窗口、
    // 页面加载竞态、listener 空窗都会静默丢帧），非受理面板只靠广播同步——丢一条
    // remove 快照就永久残留「待执行」卡片、fired 历史缺记录（2026-08-30 实测）。
    // 应答与广播走同一 scheduledList 通道（ts 守卫保序），重拉即对账自愈
    sendToJava({ op: 'scheduledList' })
  },

  flushQueue: () => {
    if (get().streaming || get().queuedMessages.length === 0) return
    const [next, ...rest] = get().queuedMessages
    set({ queuedMessages: rest })
    // 定时来源的 /goal 命令文本转 goalManage（入队期间无法拦截，flush 是最后关口）
    if (!dispatchScheduledGoalText(next.text, next.scheduledFireAt, get)) {
      get().sendMessage(next.text, next.attachments, next.scheduledFireAt != null
        ? {
            scheduledFireAt: next.scheduledFireAt,
            ...(next.scheduledModelId ? { scheduledProviderId: next.scheduledProviderId, scheduledModelId: next.scheduledModelId } : {}),
          }
        : undefined)
    }
  },

  /**
   * 切会话丢弃队列前的回退：定时来源的排队消息交还 Java 侧挂起（hold=true 不自动发），
   * 用户切回该会话时卡片呈「已过期」态，手动决定立即执行/重新定时——
   * 否则定时消息会因随手切 tab 被队列丢弃语义无声吞掉
   */
  requeueScheduledQueuesFor: (oldSessionId) => {
    if (!oldSessionId) return
    const olds = get().queuedMessages.filter((m) => m.scheduledFireAt != null)
    if (olds.length === 0) return
    olds.forEach((m) => {
      sendToJava({
        op: 'scheduledRequeue',
        sessionId: oldSessionId,
        workspacePath: get().currentWorkspacePath,
        text: m.text,
        fireAt: m.scheduledFireAt!,
        ...(m.scheduledModelId ? { providerId: m.scheduledProviderId, modelId: m.scheduledModelId } : {}),
      })
    })
  },

  renameSession: (sessionId, title) => {
    // 持久化（persist 通道，listSessions 响应时合并回来）
    setPersisted(`zcode.sessionTitle.${sessionId}`, title)
    // 本地权威更新打点：后续早于此刻的 listSessions 快照不得回退此标题（防回退守卫）
    titleUpdatedAt[sessionId] = Date.now()
    set((s) => ({
      sessions: s.sessions.map((x) => (x.sessionId === sessionId ? { ...x, title } : x)),
    }))
  },

  clearSessionTitleRegenError: () => set({ sessionTitleRegenError: null }),

  regenerateSessionTitle: (sessionId) => {
    // 全局单飞（Java 侧 AtomicBoolean 同款）：进行中忽略重复点击
    if (get().titleRegeneratingSessionId) return
    const excerpt = extractTitleExcerpt(get().messages)
    if (!excerpt) {
      set({ sessionTitleRegenError: i18n.t('chat.header.regenNoContent') })
      return
    }
    set({ titleRegeneratingSessionId: sessionId, sessionTitleRegenError: null })
    // 附带 currentModel：generateText 跟随会话模型（会话能跑对话则模型必然已在
    // workspace 目录注册，直调即成功）；缺陷实锤——落 config 默认会选中会话没用过的
    // 渠道（如 builtin:bigmodel），app-server 重启后未注册即 -32603
    const cm = get().currentModel
    sendToJava({
      op: 'regenerateSessionTitle',
      sessionId,
      excerpt,
      ...(cm ? { providerId: cm.providerId, modelId: cm.modelId } : {}),
    })
  },

  loadModels: () => {
    sendToJava({ op: 'listModels' })
  },

  /**
   * 手动刷新模型清单（模型下拉的刷新按钮）：用户在 Zcode 客户端改了 config.json
   * 后无需切到设置页即可拉新。置 modelsRefreshing 转圈，case 'models' 响应复位
   * （Kotlin 各失败路径也回 models 响应，不会悬挂）。
   */
  refreshModels: () => {
    if (get().modelsRefreshing) return
    set({ modelsRefreshing: true })
    get().loadModels()
  },

  setModel: (modelId, providerId) => {
    const cur = get().currentModel
    // 目标=当前生效模型（含挂起回滚后的显示模型）：语义是取消延迟切换（用户反悔路径）
    // ——本地清挂起与提示、persist 归位生效模型，并通知 Java 撤掉补发目标（否则回合
    // 结束仍会把已放弃的目标模型真切上去）。空闲态点当前模型=纯 no-op，同样不发 setModel
    if (sameModel(cur, { modelId, providerId })) {
      const hadPending = !!get().modelPendingSwitch
      setPersisted('zcode.currentModel', JSON.stringify({ modelId, providerId }))
      // 会话级记忆同步归位（缺陷BI）：撤销后该会话的记忆应回到生效模型，
      // 否则重启恢复会重放已放弃的目标
      const cancelSid = get().currentSessionId
      if (cancelSid) rememberSessionModel(cancelSid, { modelId, providerId })
      set({
        modelInvalidated: false,
        modelSwitchInFlightAt: null,
        modelPendingSwitch: null,
        modelSwitchPrevModel: null,
        lastNotice: null,
      })
      const sid = get().currentSessionId
      if (hadPending && sid) sendToJava({ op: 'cancelModelSwitch', sessionId: sid })
      return
    }
    // 记忆当前选择：全局（新会话默认）+ 会话级（本会话切回/重启恢复时重放自己的选择，
    // 不再带入别的会话选过的模型——缺陷BI）；无会话（懒创建待命态）只写全局，
    // 会话建立后由 applyModelIfReady 真正下发（见 createSession 响应处理）
    setPersisted('zcode.currentModel', JSON.stringify({ modelId, providerId }))
    // 暂存翻转前模型：回合中切换会被 Java 挂起（modelSetPending），届时回滚选中态
    set({ currentModel: { modelId, providerId }, modelInvalidated: false, modelSwitchPrevModel: get().currentModel })
    // 待命态切模型：级别集随模型变化，按新模型重 hydrate（无缓存的模型 → 选择器隐藏）
    get().hydrateThoughtLevelStandby()
    const sid = get().currentSessionId
    if (!sid) return
    rememberSessionModel(sid, { modelId, providerId })
    // 标记切换在途：期间到达的 settings 级别部分计算于旧模型（modelSet 响应时清除）；
    // 同时清回执标记（缺陷BO）——新切换在途，若其回执丢失，TTL 过期后的追发不能被
    // 上一轮切换的旧 ack 拦截
    const ackNext = new Set(get().modelAckSessions)
    ackNext.delete(sid)
    set({ modelSwitchInFlightAt: Date.now(), modelAckSessions: ackNext })
    sendToJava({ op: 'setModel', sessionId: sid, modelId, providerId })
  },

  applyModelIfReady: (sessionId, newSession = false) => {
    // 回执已到（缺陷BO）：切换已落定（modelSet）或 Java 已接管补发（modelSetPending），
    // 重放纯属多余——回合中还会被挂起成幽灵"本轮结束后生效"横幅。send 恒带 runtimeModel
    // 兜正每回合，重放链路不承担已回执会话的模型一致性
    if (get().modelAckSessions.has(sessionId)) return
    // 同一会话只下发一次（登记守卫；单槽时代切走再切回守卫即失效，每次来回都重发，
    // 撞上在跑回合还会产生"本轮结束后生效"的无效挂起）。登记带 TTL：回执永久丢失
    //（忙窗口重试耗尽）时过期放行，下一次触发重发而非永久锁死（review Spec①）
    const registeredAt = get().modelAppliedSessions.get(sessionId)
    if (registeredAt != null && Date.now() - registeredAt < MODEL_APPLY_REGISTRATION_TTL_MS) return
    // 等待 models 列表就绪（迟到的 models 响应会再触发一次）
    const models = get().models
    if (models.length === 0) return
    // 会话级记忆优先（缺陷BI）：已有会话只重放它自己的选择，绝不带入别的会话选过的
    // 模型；仅新建会话（懒创建/显式 newSession）回退全局默认——保留"新会话跟随上次
    // 选择"的既有体验。存量会话无记忆则不重放：服务端本就持有其模型，显示由消息
    // 快照的 inferCurrentModel 推断（applyMessagesSnapshot）
    const own = readSessionModel(sessionId)
    let target: ModelChoice | null = own
    // 新建豁免（跟随上次全局默认 + 跳过同值守卫）只保留到首条 send 落地为止（缺陷EF）：
    // send 恒带 runtimeModel 已兜正服务端模型，豁免若随 createdSessionIds 终身有效，
    // 之后任何清单刷新（设置页模型管理联动 loadModels 等）都会经豁免口重放同值
    // setModel——回合中被 Java 挂起即幽灵横幅（2026-09-30 实锤：创建 3 分钟后触发）
    const firstApplyWindow =
      newSession || (get().createdSessionIds.has(sessionId) && !get().modelSettledSessions.has(sessionId))
    if (!target && firstApplyWindow) {
      try {
        const raw = getPersisted('zcode.currentModel')
        if (raw) target = JSON.parse(raw) as ModelChoice
      } catch { /* ignore */ }
    }
    if (!target) return
    // 重放目标=当前显示模型（缺陷CU，BO 盲区）：models 迟到就绪前本函数曾在 models 空
    // 分支静默 return，回执守卫 modelAckSessions 建立不起来；此后任何一次模型清单刷新
    //（设置页模型管理联动 loadModels 等）都会补出这笔迟到的首次下发——目标=当前在用
    // 模型，纯多余重放，回合中被 Java 挂起成幽灵「本轮结束后生效」横幅。选择器已显示
    // 同值即视为落定（send 恒带模型每回合兜正服务端漂移），登记 acked 挡住后续重放。
    // 首应用窗口（newSession/未发过消息的 createdSessionIds 会话）不适用——显示常被
    // 待命水合先写成同一全局默认，服务端新会话未必在用它，必须真切上去并重建 settings；
    // 窗口随首条 send 关闭（缺陷EF，见上方 firstApplyWindow）
    if (!firstApplyWindow && sameModel(target, get().currentModel)) {
      set({ modelAckSessions: new Set([...get().modelAckSessions, sessionId]) })
      return
    }
    // 记忆的模型已不在可选列表（典型：provider 被禁/体验套餐被过滤/配置已删）：
    // 兜底生效套餐（个人/团队，issue #8）首选、其次列表首个，并回写对应层记忆
    // （会话级→会话级、全局→全局）——否则会话静默跑在服务端默认模型上、选择器空占位
    const exists = models.some((m) => sameModel(m, target))
    if (!exists) {
      const fb = models.find((m) => m.plan === 'personal' || m.plan === 'team') ?? models[0]
      const fallback = { modelId: fb.modelId, providerId: fb.providerId }
      if (own) rememberSessionModel(sessionId, fallback)
      else setPersisted('zcode.currentModel', JSON.stringify(fallback))
      target = fallback
    }
    set({ currentModel: { modelId: target.modelId, providerId: target.providerId } })
    // 标记切换在途：期间到达的 settings 级别部分计算于旧模型（modelSet 响应时清除）
    set({
      modelAppliedSessions: new Map(get().modelAppliedSessions).set(sessionId, Date.now()),
      modelSwitchInFlightAt: Date.now(),
    })
    sendToJava({ op: 'setModel', sessionId, modelId: target.modelId, providerId: target.providerId })
  },

  loadSettings: () => {
    const sid = get().currentSessionId
    if (!sid) return
    sendToJava({ op: 'getSettings', sessionId: sid })
  },

  setThoughtLevel: (level) => {
    // 记忆选择（persist 通道），新会话/切模型后仍尝试恢复；无会话（待命态）也允许预选：
    // 级别集来自按模型缓存（hydrateThoughtLevelStandby 恢复），createSession 响应里
    // 先于首条消息补下发（applyModelIfReady 同款时序）
    setPersisted('zcode.thoughtLevel', level)
    // 乐观更新 current（thoughtLevelSet 响应 / settings 重拉时服务端校准）
    const info = get().thoughtLevel
    if (info) set({ thoughtLevel: { ...info, current: level } })
    const sid = get().currentSessionId
    if (!sid) return
    set({ thoughtLevelAppliedForSession: sid })
    sendToJava({ op: 'setThoughtLevel', sessionId: sid, thoughtLevel: level })
  },

  hydrateThoughtLevelStandby: () => {
    // 有会话时级别集以 settings 权威（loadSettings 会覆盖），无需水合
    if (get().currentSessionId) return
    const cached = readThoughtLevelCache(get().currentModel?.modelId)
    if (!cached) {
      // 该模型未用过/不支持思考：清掉旧模型的 info，选择器隐藏（首个会话的 settings 补缓存）
      if (get().thoughtLevel) set({ thoughtLevel: null })
      return
    }
    // 记忆级别对当前模型仍有效则作为 current 显示，否则显示 defaultLevel（标注「默认」）
    const saved = getPersisted('zcode.thoughtLevel')
    const current = saved && cached.available.some((a) => a.value === saved) ? saved : undefined
    set({ thoughtLevel: { ...cached, ...(current ? { current } : {}) } })
  },

  setMode: (mode) => {
    // 不做 localStorage 记忆：模式是"现在想怎么干活"的即时选择（新会话默认 yolo，避免 plan 粘性）
    // 手动切到 plan 记住前一模式（缺陷E：ExitPlanMode 批准后即时恢复）；切离 plan 清除
    // 无会话（待命态）也允许预选：只更新 currentMode（待命态无 settings/消息污染，值即预选意图），
    // 不发协议；createSession 响应里会先于首条消息补下发（预选 plan 则首问就按计划模式跑）
    const sid = get().currentSessionId
    const prev = get().currentMode
    set({
      currentMode: mode,
      // 手动切档=用户显式意图，agent 计划阶段判定终止（缺陷CG：此后 session 模式
      // 推送照旧同步指示器）
      agentPlanActive: false,
      prePlanMode: mode === 'plan'
        ? (prev && prev !== 'plan' ? prev : get().prePlanMode)
        : null,
    })
    if (!sid) return
    sendToJava({ op: 'setMode', sessionId: sid, mode })
  },

  goalManage: (action, objective) => {
    const sid = get().currentSessionId
    if (!sid) {
      // 待命态（新标签无会话）：设目标先建会话（同定时任务暂存模式，createSession
      // 响应后自动补发）；非 set 动作无会话语境，给用法提示
      if ((action === 'set' || action === 'replace') && objective?.trim()) {
        set({ pendingGoalCreation: { objective: objective.trim() } })
        get().createSession()
      } else {
        set({ lastError: i18n.t('chat.goal.usageHint') })
      }
      return
    }
    // 无参 /goal（show）：有目标卡就刷新校准；无目标给用法提示（卡不出现，
    // 需要一句可见反馈，复用 lastError 错误条）
    if (action === 'show' && !get().goal) {
      set({ lastError: i18n.t('chat.goal.usageHint') })
      return
    }
    // trim 与乐观卡一致（协议侧也 trim，但空参 Usage 提示由 UI 先拦）
    const trimmedObjective = objective?.trim()
    // 乐观更新（响应 goalManaged 权威落地；服务端拦截时 error 回执回滚）：
    // set/replace 立即出卡，pause/resume 即时翻转状态钮
    const prev = get().goal
    if ((action === 'set' || action === 'replace') && trimmedObjective) {
      // 乐观用户消息：set 落库的 user 消息只含目标文本（/goal 前缀服务端剥掉，
      // sqlite 实测 2026-09-03），事件流 turn.started 又只建 assistant 流式消息——
      // 不插则目标轮整段没有用户气泡，回合结束重拉才出现（0.3.2 真机反馈）。
      // goalRefresh 增量合并时 user 真身与流式 assistant 撞 turn.started 的
      // messageId 被滤掉，乐观版一直顶到回合结束全量重拉被真身替换
      // 乐观卡从零起：服务端按 target 独立记账（replace 换目标统计清零，
      // 曾继承旧目标耗时导致卡片不重置，0.3.2 真机反馈）
      const localId = `local_u_${Date.now()}`
      optimisticGoalUserMsg = { sid, msgId: localId }
      set((s) => ({
        goal: { targetId: '', objective: trimmedObjective, status: 'active', tokensUsed: 0, timeUsedSeconds: 0, iterationCount: 1, syncedAt: Date.now() },
        messages: [...s.messages, {
          info: { role: 'user', time: { created: Date.now() }, id: localId, sessionID: sid },
          parts: [{ type: 'text', text: trimmedObjective }],
        }],
      }))
    } else if (action === 'pause' && prev) {
      set({ goal: { ...prev, status: 'paused' } })
    } else if (action === 'resume' && prev) {
      set({ goal: { ...prev, status: 'active' } })
    } else if (action === 'clear') {
      set({ goal: null })
    }
    sendToJava({ op: 'goalManage', sessionId: sid, action, objective: trimmedObjective })
  },

  applyThoughtLevelIfReady: (sessionId) => {
    // 同一会话只下发一次（settings 可能在切会话/切模型后多次到达）
    if (get().thoughtLevelAppliedForSession === sessionId) return
    const saved = getPersisted('zcode.thoughtLevel')
    if (!saved) return
    // 等级别列表就绪，且记忆值仍有效（切模型后级别集会变，如 off/high/max ↔ enabled/off）
    const info = get().thoughtLevel
    if (!info || info.available.length === 0) return
    if (!info.available.some((a) => a.value === saved)) return
    set({ thoughtLevelAppliedForSession: sessionId })
    // 与当前一致则只标记不下发（服务端已生效）
    if (info.current === saved) return
    sendToJava({ op: 'setThoughtLevel', sessionId, thoughtLevel: saved })
  },

  loadUsage: () => {
    const sid = get().currentSessionId
    if (!sid) return
    sendToJava({ op: 'getUsage', sessionId: sid })
  },

  loadSessionDebug: () => {
    const sid = get().currentSessionId
    if (!sid) return
    sendToJava({ op: 'getSessionDebug', sessionId: sid })
  },

  loadQuota: () => {
    quotaRequestedAt = Date.now()
    set({ quotaLoading: true })
    sendToJava({ op: 'getQuota' })
  },

  dismissQuotaBanner: (key: string) => {
    const { quotaBannerDismissed } = get()
    // 去重键由组件层经 deriveQuotaBanner 得出后回传（store 只存，不重复派生）
    if (quotaBannerDismissed.includes(key)) return
    set({ quotaBannerDismissed: [...quotaBannerDismissed, key] })
    // 低额提醒路落盘：静默至窗口期轮转（key 内嵌重置时间），跨标签/跨重启生效
    if (key.startsWith('low:')) recordQuotaBannerDismissal(key)
  },

  clearQuotaBannerError: () => set({ quotaBannerError: null }),

  loadMemoryFiles: (path) => {
    // 浏览目录：显式传参=切换；无参=延续当前作用域（设置页切走再回重挂时不清选择）
    const ws = path ?? get().memoryWorkspace
    set({ memoryLoading: true, memoryError: null, memoryWorkspace: ws })
    sendToJava({ op: 'listMemoryFiles', workspacePath: ws || get().projectPath })
  },

  searchMemoryFiles: (query) => {
    const q = query.trim()
    if (!q) {
      // 空 query 直接退出搜索态，不发请求
      set({ memorySearchResults: null, memorySearchActiveQuery: '', memorySearching: false })
      return
    }
    set({ memorySearching: true, memorySearchActiveQuery: q })
    // 搜索跟随当前浏览目录（应答按 query 对齐丢弃；切目录由组件清空搜索态）
    sendToJava({ op: 'searchMemoryFiles', query: q, workspacePath: get().memoryWorkspace || get().projectPath })
  },

  createMemoryFile: (path) => {
    set({ memoryCreatingPath: path, memoryError: null })
    // Kotlin 白名单校验按目标目录（多目录会话：在浏览的关联目录建 AGENTS.md）
    sendToJava({ op: 'createMemoryFile', path, workspacePath: get().memoryWorkspace || get().projectPath })
  },

  setMemoryEnabled: (enabled) => {
    // 防重复点击：上一次切换还在途中就忽略
    if (get().memoryToggling) return
    set({ memoryToggling: true, memoryError: null })
    sendToJava({ op: 'setMemoryEnabled', enabled })
  },

  loadCuaEnabled: () => {
    sendToJava({ op: 'getCuaEnabled' })
  },

  setCuaEnabled: (enabled) => {
    if (get().cuaToggling) return
    set({ cuaToggling: true })
    sendToJava({ op: 'setCuaEnabled', enabled })
  },

  loadCuaIcon: (key) => {
    // ''哨兵=已请求但缺失（服务端无此文件），同样不再发
    if (get().cuaIcons[key] !== undefined) return
    set((s) => ({ cuaIcons: { ...s.cuaIcons, [key]: '' } }))
    sendToJava({ op: 'getCuaIcon', key })
  },

  setCuaInputButton: (enabled) => {
    set({ cuaInputButton: enabled })
    // persist kv 通道（同 statusPanelConfig）：localStorage 即时 + 去抖回存
    writeCuaInputButtonConfig({ showInInputBox: enabled })
  },

  toggleStatusPanel: () => {
    const collapsed = !get().statusPanelCollapsed
    set({ statusPanelCollapsed: collapsed })
    // 持久化（写 kv 通道：localStorage 即时 + 去抖回存 PropertiesComponent，
    // 新标签水合读最新值）
    writeStatusPanelConfig({ collapsed })
  },

  recordAskUserAnswered: () => {
    // 扫当前消息里仍在等待应答的 AskUserQuestion part（同会话同时至多一个挂起
    // 提问，防御性全记），callID → 应答时刻 + 提问时刻（弹窗 askedAt）。须在应答
    // sendToJava 之前调用——应答回执可能瞬间触发重拉，晚于重拉就找不到 pending
    // 态的 part 了。提问时刻取弹窗 askedAt：本地流式 part 的 time.start 会被完成
    // 事件（kind=result 服务端权威 startedAt）覆盖成应答后瞬时值，不可作起点
    const now = Date.now()
    const askedAt = get().askUser?.askedAt
    const hits: Record<string, number> = {}
    const starts: Record<string, number> = {}
    for (const m of get().messages) {
      for (const p of m.parts ?? []) {
        if (p.type !== 'tool') continue
        const tp = p as ToolPart
        if (tp.tool === 'AskUserQuestion' && (tp.state?.status === 'pending' || tp.state?.status === 'running')) {
          hits[tp.callID] = now
          if (askedAt) starts[tp.callID] = askedAt
        }
      }
    }
    if (Object.keys(hits).length > 0) {
      set({
        askAnsweredAt: { ...get().askAnsweredAt, ...hits },
        askAskedAt: { ...get().askAskedAt, ...starts },
      })
    }
  },

  loadBrowserConfig: () => {
    sendToJava({ op: 'browserConfig' })
  },

  clearBrowserData: (mode) => {
    if (get().browserBusy) return
    set({ browserBusy: mode, browserError: null, browserCleared: null })
    sendToJava({ op: 'clearBrowserData', mode })
    // 兜底：30s 无响应复位（CDP 通道异常/浏览器 tab 无响应时不永远转圈；正常完成后 busy 已复位）。
    // 定时器在回包时取消，防残留定时器误杀下一次操作
    armBrowserBusyTimer(mode, () => {
      if (get().browserBusy === mode) {
        set({ browserBusy: null, browserError: i18n.t('browser.data.timeout') })
      }
    })
  },

  loadBrowserOverview: () => {
    if (get().browserBusy === 'overview') return
    set({ browserBusy: 'overview', browserError: null })
    sendToJava({ op: 'browserDataOverview' })
    armBrowserBusyTimer('overview', () => {
      if (get().browserBusy === 'overview') {
        set({ browserBusy: null, browserError: i18n.t('browser.data.timeout') })
      }
    })
  },

  clearBrowserError: () => {
    set({ browserError: null })
  },

  loadSkills: (path) => {
    // 浏览目录：显式传参=切换；无参=延续当前作用域（同 loadMemoryFiles）
    const ws = path ?? get().skillsWorkspace
    set({ skillsLoading: true, skillsError: null, skillsWorkspace: ws })
    sendToJava({ op: 'listSkills', workspacePath: ws || get().projectPath })
  },

  // 确保斜杠命令清单已拉取（消息气泡 /name chip 化的数据源；一次性，回包走 commands case）
  ensureSlashCommands: () => {
    if (get().slashCommands !== null || get().slashCommandsRequested) return
    set({ slashCommandsRequested: true })
    sendToJava({ op: 'listCommands' })
  },

  // ============ 提示词润色 ============
  enhancePrompt: (text) => {
    if (!text.trim()) return
    // 润色在途中再点按钮：同文本=复用在途请求（重新打开弹窗看进度），不重发；
    // 改了文本=旧润色已过时，走下方新请求（latest-wins 顶掉旧代）。协议层
    // generateText/CLI 无法真正取消，同文重发只会白白多跑一趟（issue #22 交互反馈）
    const inflight = get().enhanceResult
    if (get().enhancing && inflight && inflight.original === text) {
      set({ enhanceDialogOpen: true })
      return
    }
    // 同文本已有完整结果（上次关了弹窗没用）：直接复用展示，不重烧一次模型
    if (inflight && !get().enhancing && !inflight.error && inflight.text && inflight.original === text) {
      set({ enhanceDialogOpen: true })
      return
    }
    // 模型优先级：设置→行为的润色专用模型 > 会话当前所选模型（专用模型失效由
    // 后端兜底回退默认 provider，结果回包 model 字段带实际用到的模型）
    const dedicated = readEnhanceConfig().enhanceModel
    const cm = dedicated ?? get().currentModel
    const seq = ++enhanceSeqCounter
    enhanceActiveSeq = seq
    set({ enhancing: true, enhanceDialogOpen: true, enhanceResult: { original: text, model: cm?.modelId } })
    sendToJava({
      op: 'enhancePrompt',
      seq,
      text,
      workspacePath: get().currentWorkspacePath ?? undefined,
      ...(cm ? { providerId: cm.providerId, modelId: cm.modelId } : {}),
    })
    // 兜底：3 分钟无响应复位（CLI 卡死/超时漏网时弹窗不永远转圈）；
    // 回包/新请求先取消旧定时器，防残留定时器误杀下一次润色
    cancelEnhanceTimer()
    enhanceTimer = window.setTimeout(() => {
      enhanceTimer = undefined
      if (get().enhancing) {
        set({
          enhancing: false,
          enhanceResult: { original: text, error: i18n.t('enhance.timeout') },
        })
      }
    }, 180_000)
  },

  closeEnhanceDialog: () => {
    // 仅藏弹窗：在途请求继续（结果落地进 enhanceResult，弹窗不自动复活），
    // 再点润色按钮可复现（在途=看进度；已有结果=直接展示）
    set({ enhanceDialogOpen: false })
  },

  cancelEnhance: () => {
    // 真终止：通知后端中止（generateText 协议取消/CLI 进程销毁）；作废代际让
    // 迟到的中止错误回包被守卫丢弃，本地即刻清场（再点同文=全新请求）
    if (enhanceActiveSeq !== null) {
      sendToJava({ op: 'cancelEnhancePrompt', seq: enhanceActiveSeq })
    }
    cancelEnhanceTimer()
    enhanceActiveSeq = null
    set({ enhancing: false, enhanceDialogOpen: false, enhanceResult: null })
  },

  clearEnhanceResult: () => {
    cancelEnhanceTimer()
    // 作废活动代：在途润色（协议层 generateText 无法中断，算完即弃）的迟到
    // 回包经 reducer 代际守卫丢弃
    enhanceActiveSeq = null
    set({ enhancing: false, enhanceDialogOpen: false, enhanceResult: null })
  },

  // ============ 子智能体 ============
  loadAgents: () => {
    sendToJava({ op: 'listAgents' })
  },

  selectAgent: (agent) => {
    set({ selectedAgent: agent })
  },

  saveAgent: (scope, agent, originalName) => {
    sendToJava({ op: 'saveAgent', scope, agent, originalName })
  },

  deleteAgent: (scope, name) => {
    sendToJava({ op: 'deleteAgent', scope, name })
  },

  toggleSkill: (path, enabled) => {
    // 防重复点击：上一次切换还在途中就忽略
    if (get().skillTogglingPath) return
    set({ skillTogglingPath: path, skillsError: null })
    // Kotlin 白名单校验按浏览目录（多目录会话：禁用关联目录的项目技能）
    sendToJava({ op: 'toggleSkill', path, enabled, workspacePath: get().skillsWorkspace || get().projectPath })
  },

  loadMcpServers: (mode = 'status') => {
    if (mode === 'connect') set({ mcpChecking: true, mcpError: null })
    else set({ mcpLoading: true, mcpError: null })
    sendToJava({ op: 'listMcpServers', mode })
  },

  loadMcpServerTools: (name, force = false) => {
    const cur = get().mcpToolsByServer[name]
    // 有结果且非 force 不重拉；loading 中防重入
    if (cur?.loading) return
    if (cur && !force && (cur.tools.length > 0 || cur.error)) return
    set((s) => ({
      mcpToolsByServer: { ...s.mcpToolsByServer, [name]: { tools: [], loading: true, fetchedAt: Date.now() } },
    }))
    sendToJava({ op: 'mcpServerTools', name, force })
  },

  loadMcpLogs: () => {
    set({ mcpLogsLoading: true })
    sendToJava({ op: 'getMcpLogs' })
  },

  loadTrajectory: (sessionId) => {
    set({ trajectoryLoading: true, trajectoryError: null, trajectory: null })
    sendToJava({ op: 'getModelTrajectory', sessionId })
  },

  loadModelManage: () => {
    set({ modelManageLoading: true, modelManageError: null })
    sendToJava({ op: 'modelManageList' })
  },

  testConnectivity: (providerId, modelId) => {
    if (get().connectivityTestingId) return
    set({ connectivityTestingId: `${providerId}|${modelId}` })
    sendToJava({ op: 'modelTestConnectivity', providerId, modelId })
  },

  /**
   * 重发最新一条用户消息（原样重新生成回复）：本质=文本不变的编辑——直接复用
   * submitEdit 完整链路（v4 editUserQuery 两段式/空闲编辑/legacy 回退/rewind-cuts
   * 持久裁剪全在其内），零新协议面。守卫与 startEdit 同款（编辑重放中/排队/引导/
   * 审批挂起不发起），文本与图片从原消息现提取（编辑器回填同款提取函数）。
   */
  resendLastUserMessage: () => {
    const st = get()
    const v4Edit = st.editViaV4 !== false && st.forkSupported !== false
    const interactionPending = !!(st.askUser || st.exitPlanApproval || st.permissionRequest || st.askUserPendingActive)
    if (st.editingMessageId || st.editReplay || st.queuedMessages.length > 0 || st.steerPending || interactionPending) return
    if (st.streaming && (!v4Edit || st.compacting)) return
    const target = findEditableUserMessage(st.messages, { allowImages: v4Edit })
    if (!target) return
    const text = userEditText(target)
    if (!text.trim()) return
    const parts = userMessageImageParts(target)
    const images: EditAttachmentInput[] | undefined = parts.length
      ? parts.map((p) =>
          p.type === 'file'
            ? { source: 'cache' as const, url: p.url!, mime: p.mime ?? 'image/png', fileName: p.filename ?? 'image.png' }
            : { source: 'inline' as const, dataBase64: p.dataBase64!, mime: p.mediaType ?? 'image/png', fileName: 'image.png' },
        )
      : undefined
    set({ editingMessageId: target.info.id })
    get().submitEdit(text, images)
  },

  moveQueuedMessage: (id, direction) => {
    set((s) => {
      const idx = s.queuedMessages.findIndex((m) => m.id === id)
      const to = idx + direction
      if (idx < 0 || to < 0 || to >= s.queuedMessages.length) return s
      const q = [...s.queuedMessages]
      const [item] = q.splice(idx, 1)
      q.splice(to, 0, item)
      return { queuedMessages: q }
    })
  },

  setProviderKey: (providerId: string, apiKey: string) => {
    sendToJava({ op: 'modelSetProviderKey', providerId, apiKey })
  },

  toggleModelProvider: (providerId, enabled) => {
    if (get().modelTogglingId) return
    set({ modelTogglingId: providerId, modelManageError: null })
    sendToJava({ op: 'modelToggleProvider', providerId, enabled })
  },

  /** 单模型启用/停用（NEW 代；modelToggleModel → modelToggled 回包清单飞态） */
  toggleModel: (providerId, modelId, enabled) => {
    if (get().modelTogglingKey) return
    set({ modelTogglingKey: `${providerId}|${modelId}`, modelManageError: null })
    sendToJava({ op: 'modelToggleModel', providerId, modelId, enabled })
  },

  addModelProvider: (draft) => {
    if (get().providerSaving) return
    set({ providerSaving: true, providerSaveError: null })
    sendToJava({ op: 'modelAddProvider', draft })
  },

  updateModelProvider: (providerId, draft) => {
    if (get().providerSaving) return
    set({ providerSaving: true, providerSaveError: null })
    sendToJava({ op: 'modelUpdateProvider', providerId, draft })
  },

  removeModelProvider: (providerId) => {
    if (get().providerSaving) return
    set({ providerSaving: true, providerSaveError: null })
    sendToJava({ op: 'modelRemoveProvider', providerId })
  },

  /** 渠道排序（v2）：拖拽落位后传完整顺序，写 providerOrder（客户端展示序同源） */
  reorderModelProviders: (providerIds) => {
    set({ modelProvidersReordering: true })
    sendToJava({ op: 'modelReorderProviders', providerIds })
  },

  remigrateBuiltins: () => {
    if (get().modelRemigrating) return
    set({ modelRemigrating: true, modelRemigrateResult: null })
    sendToJava({ op: 'modelRemigrateBuiltins' })
  },

  dismissRemigrateResult: () => set({ modelRemigrateResult: null }),

  setUsageRange: (range) => {
    set({ usageRange: range })
    get().loadUsageData()
  },

  setUsageDates: (start, end) => {
    set({ usageRange: 'custom', customStart: start, customEnd: end })
    get().loadUsageData()
  },

  loadUsageData: () => {
    const { usageRange, customStart, customEnd } = get()
    const { start, end } = rangeToTimes(usageRange, customStart, customEnd)
    set({ modelUsage: null, toolUsage: null, usageError: null })
    sendToJava({ op: 'getModelUsage', startTime: start, endTime: end })
    sendToJava({ op: 'getToolUsage', startTime: start, endTime: end })
  },

  setAppUsageRange: (range) => {
    set({ appUsageRange: range })
    get().loadAppUsage()
  },

  loadAppUsage: () => {
    set({ appUsage: null, appUsageError: null })
    sendToJava({ op: 'getAppUsage', range: get().appUsageRange })
  },

  clearError: () => set({ lastError: null }),

  clearResidentPoolNotice: () => set({ residentPoolNotice: null }),

  clearNotice: () => set({ lastNotice: null }),

  setPendingSettingsSection: (section) => set({ pendingSettingsSection: section }),

  checkEnv: () => {
    sendToJava({ op: 'checkEnv' })
  },

  saveEnvConfig: (nodePath?: string, cliPath?: string, cdpPortFile?: string) => {
    set({ envSaving: true })
    // undefined 字段 JSON.stringify 自动省略 = 后端"不改该项"约定；'' = 清除
    sendToJava({ op: 'envSave', nodePath, cliPath, cdpPortFile })
  },

  loadProxyConfig: () => {
    sendToJava({ op: 'getProxyConfig' })
  },

  saveProxyConfig: (httpProxy: string, noProxy: string, caCertPath: string) => {
    set({ proxySaving: true })
    sendToJava({ op: 'setProxyConfig', httpProxy, noProxy, caCertPath })
  },

  restartAppServer: () => {
    sendToJava({ op: 'restartAppServer' })
  },

  loadSubagents: () => {
    const sid = get().currentSessionId
    if (!sid) return
    sendToJava({ op: 'subagents', sessionId: sid })
  },

  openSubagentDetail: (key) => {
    // 互斥关掉报告/预览弹窗（见 openSubagentReport / openMarkdownPreview）
    set({ subagentDetail: key, subagentReport: null, markdownPreview: null })
    // 已结束且有 childSessionId 且未缓存 → 自动拉完整过程
    // （运行中不拉快照：运行期以实时流为主，避免 resume 干扰；stopped 后自动拉权威全量）
    const st = get()
    const item = st.agents.find((a) => a.callID === key)
    const info = st.subagents.find((s) => s.toolCallId === key)
    const csid = item?.childSessionId ?? info?.childSessionId
    const running = st.subagentActivities.find((a) => a.key === key)?.status === 'running'
      || info?.status === 'running'
    // 未注册的子会话（如历史会话恢复后直接从底部栏打开）：就地注册 + 订阅，
    // 否则其原生事件流进不了 childLiveMessages（handleStreamBatch 按注册表过滤）
    if (csid && !(csid in st.childSessionKeys)) {
      set({ childSessionKeys: { ...st.childSessionKeys, [csid]: key } })
      subscribeChildSession(csid)
    }
    if (csid && !st.childMessages[csid] && !running) {
      get().loadChildMessages(csid)
    }
  },

  closeSubagentDetail: () => set({ subagentDetail: null, childMessagesError: null }),

  openTurnFileChanges: (messageId, opts) => {
    // 与报告/预览弹窗互斥（同 openSubagentDetail 的互斥语义）
    set({
      turnFileChangesDialogFor: messageId,
      turnFileChangesDialogPath: opts?.path ?? null,
      turnFileChangesDialogRewind: opts?.rewind === true,
      subagentReport: null,
      markdownPreview: null,
    })
  },
  closeTurnFileChanges: () =>
    set({ turnFileChangesDialogFor: null, turnFileChangesDialogPath: null, turnFileChangesDialogRewind: false }),

  // 弹窗分层（2026-09-02 缺陷修复 + 用户定案细化）：
  // - 报告弹窗 = 详情弹窗的"互斥切换"（过程↔结论 头部按钮来回切——从详情开报告
  //   即关详情，从报告切过程同理，不叠两层）
  // - Markdown 预览（工具 📖：网页结果/Skill 文档）= 详情之上的"阅读层"叠加，
  //   关预览后详情仍在（用户实测要的保留场景）
  // - 阅读与预览两类互斥（同时只读一个）
  openSubagentReport: (r) => set({ subagentReport: r, subagentDetail: null, markdownPreview: null }),
  closeSubagentReport: () => set({ subagentReport: null }),
  openMarkdownPreview: (p) => set({ markdownPreview: p, subagentReport: null }),
  closeMarkdownPreview: () => set({ markdownPreview: null }),
  openAskUserReview: (r) => set({ askUserReview: r }),
  closeAskUserReview: () => set({ askUserReview: null }),

  openChangelog: () => set({ changelogOpen: true }),
  closeChangelog: () => set({ changelogOpen: false }),

  openRemotePairing: () => {
    set({ remotePairingOpen: true })
    // 幂等连接 + 拉状态（已在连接/已配对时后端直接回当前态）
    sendToJava({ op: 'remotePairStart' })
  },
  closeRemotePairing: () => set({ remotePairingOpen: false }),
  refreshRemoteState: () => sendToJava({ op: 'remoteStatus' }),
  // 强制重出码（弹窗「刷新二维码」）：remotePairStart 已连接时幂等返回旧码不会刷新
  refreshRemoteQr: () => sendToJava({ op: 'remoteRefreshQr' }),
  stopRemote: () => sendToJava({ op: 'remoteStop' }),
  unpairRemote: () => sendToJava({ op: 'remoteUnpair' }),

  loadChildMessages: (childSessionId, silent = false) => {
    if (silent) {
      // 静默轮询：标记本次请求，响应侧跳过 loading/error（见 case 'subagentMessages'）
      silentChildFetches.add(childSessionId)
    } else {
      set({ childMessagesLoading: true, childMessagesError: null })
    }
    sendToJava({
      op: 'subagentMessages',
      sessionId: childSessionId,
      workspacePath: get().currentWorkspacePath,
    })
  },
}))

let turnEndListRefreshTimer = 0
/** 相位 ended 后的列表对账重拉（防抖 300ms：同会话连续回合/批量广播只拉最后一次） */
function scheduleTurnEndListRefresh(get: () => StoreState) {
  window.clearTimeout(turnEndListRefreshTimer)
  turnEndListRefreshTimer = window.setTimeout(() => get().loadSessions(), 300)
}

/** 用量查询时间窗计算：start=当天 00:00:00，end=当天 23:59:59 */
function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}
function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function rangeToTimes(
  range: UsageRange,
  customStart?: string | null,
  customEnd?: string | null,
): { start: string; end: string } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = dateStr(today) + ' 23:59:59'
  if (range === 'custom' && customStart && customEnd) {
    return { start: customStart + ' 00:00:00', end: customEnd + ' 23:59:59' }
  }
  const days = range === 'today' ? 0 : range === '7d' ? 7 : 30
  const startDay = new Date(today)
  startDay.setDate(startDay.getDate() - days)
  return { start: dateStr(startDay) + ' 00:00:00', end }
}

// ============ 标题辅助 ============

// ===== 标题防回退守卫（2026-09-19）=====
/** 各会话标题最后一次本地权威更新时刻（titleUpdated 实时事件 / 手动改名）。
 *  listSessions 响应是"请求发出时刻"的服务端快照，AI 标题异步生成（约 10s，
 *  3.12.x 最长数分钟）窗口内发出的请求拉到旧值；快照晚到合并时按服务端值采用
 *  会把已显示的新标题顶回旧值（用户实测"生成的标题被顶掉回初始标题"）。
 *  此守卫：快照早于本地最后权威更新 → 该会话标题保留本地值。 */
const titleUpdatedAt: Record<string, number> = {}
let listSessionsSentAt = 0

/** 会话最后已知标题缓存（模块级，跨目录浏览不丢）：sessions 随激活目录全量替换后，
 *  当前打开的外目录会话不在列表里——header 标题 fallback 链的中层取这里（真机
 *  2026-10-27 实测丢标题闪回 sess_ 前缀）。手动改名（persist）仍优先于此缓存 */
const lastKnownTitles = new Map<string, string>()

/** 读会话最后已知标题（App header fallback 用；无记录 null）*/
export function peekSessionTitle(sessionId: string): string | null {
  return lastKnownTitles.get(sessionId) ?? null
}

/** 切目录加载态的 15s 兜底定时器（loadSessions 置位时挂，响应/超时双路解除）*/
let sessionsLoadingTimer: ReturnType<typeof setTimeout> | null = null

/** 目录路径归一比较键（多目录会话）：统一分隔符 + 去尾 + 大小写折叠（与 Java wsKey 同口径）*/
function normalizeWsPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}


/**
 * 服务端标题是否仍是占位（未生成正式标题）：
 * 空 / 会话 id 本身 / sess_ 前缀（CLI 新会话初始 title 即会话 id）。
 */
/** 从用户消息提炼临时标题：首个非空行，超 40 字符截断（与 CLI 首轮输入作标题的行为一致）*/
function deriveProvisionalTitle(text: string): string {
  const firstLine = text.trim().split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  if (!firstLine) return ''
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

/**
 * session.titleUpdated 通知：服务端生成了正式标题（payload = {title, source, previousTitle}）。
 * CLI 首轮对话期间/结束时才推——不等回合结束的 loadSessions 兜底，收到即更新列表
 * 并清除本地临时标题（长任务期间正式标题也能及时替换占位）。
 */
function applyTitleUpdated(
  sessionId: string,
  event: StreamEvent,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  const title = (event.payload as { title?: unknown }).title
  if (typeof title !== 'string' || !title.trim()) return
  const st = get()
  if (!st.sessions.some((s) => s.sessionId === sessionId)) return
  const nextProvisionals = { ...st.provisionalTitles }
  delete nextProvisionals[sessionId]
  // 本地权威更新打点：后续早于此刻的 listSessions 快照不得回退此标题（防回退守卫）
  titleUpdatedAt[sessionId] = Date.now()
  set({
    sessions: st.sessions.map((s) => (s.sessionId === sessionId ? { ...s, title: title.trim() } : s)),
    provisionalTitles: nextProvisionals,
  })
}

/**
 * 订阅子会话原生事件流（childLiveMessages 实时归约的前提）。
 * 服务端只向 session/subscribe 过的会话推送 session/event；子会话由 Agent 工具
 * 在服务端 spawn，本客户端从未订阅它——不补订的话 Java 端 pushStreamEvent 的
 * 白名单（subscribedSessions）会丢弃子会话全部原生事件（text_delta/turn 生命周期），
 * 弹窗实时只能看到父会话转发的工具级事件，点刷新拉快照才出完整对话。
 * Java 端幂等（subscribedSessions 去重），注册点多发无害。
 */
function subscribeChildSession(childSessionId: string): void {
  const st = useStore.getState()
  sendToJava({
    op: 'subscribeChild',
    sessionId: childSessionId,
    workspacePath: st.currentWorkspacePath || st.projectPath,
  })
}

/**
 * 子代理 stopped 终点退订（fire-and-forget，无需应答处理）：Java 侧收敛 v4 订阅、
 * V4FrameMapper 行表与探针计数。退订失败无害（连接级开销可忽略）；复活续跑场景
 * （stopped 后 lifecycle 再 started）经 subscribeChildSession 注册路径重新订阅。
 */
function unsubscribeChildSession(childSessionId: string): void {
  sendToJava({ op: 'unsubscribeChild', sessionId: childSessionId })
}

// ===== 子代理权威状态轮询（兜底：不依赖事件时序）=====
let subagentPollTimer: ReturnType<typeof setInterval> | null = null

/**
 * 有 running 活动期间每 3s 拉一次 session/subagents 权威列表。
 * 事件路径全部有时序竞态（2026-08-20 两轮实测）：lifecycle 事件 subscribe 流
 * 不下发；快子代理在 subscribeChild 建立前就跑完，子会话 turn.completed 被
 * 订阅过滤器丢弃；合成通知消息回合中途不可见。RPC 状态合并本就是最终权威
 * （case 'subagents'），轮询保证任何路径失联时底部栏最迟 3s 收口。
 * 无 running 活动自动停表（含测试环境的活动清空）。
 */
function ensureSubagentStatusPolling(): void {
  if (subagentPollTimer != null) return
  subagentPollTimer = setInterval(() => {
    const st = useStore.getState()
    if (!st.subagentActivities.some((a) => a.status === 'running')) {
      if (subagentPollTimer != null) {
        clearInterval(subagentPollTimer)
        subagentPollTimer = null
      }
      return
    }
    if (st.currentSessionId) st.loadSubagents()
  }, 3000)
}

/** 停止权威轮询（无 running 活动时轮询也会自停；此函数用于测试隔离与会话清理）*/
export function stopSubagentStatusPolling(): void {
  if (subagentPollTimer != null) {
    clearInterval(subagentPollTimer)
    subagentPollTimer = null
  }
}

/**
 * 子会话消息的静默拉取登记（sessionId 集合）：
 * 弹窗运行中 3s 轮询用 silent 模式拉快照，响应侧据此跳过 loading/error，
 * 避免刷新按钮频闪与偶发失败的错误提示。响应到达即消费（delete）。
 */
const silentChildFetches = new Set<string>()

// ===== 上下文构成持久化（历史会话恢复兜底）=====
// 构成明细（runtime.breakdown）只挂在 CLI 内存 eventStore 的 ModelComplete 事件上，
// 不随消息落盘——会话被 resume 到新进程（IDE 重启/标签重开/换标签）后 session/read
// 不再返回，悬浮栏「上下文构成」就丢了。这里在收到 breakdown 时按会话写 persist 通道，
// 恢复历史会话时若上下文用量 used 与缓存时一致（消息未变 → 构成未变）则兜底显示；
// 别处对话过 / compact 过的会话 used 必变，缓存自动失效。LRU 保留最近 30 个会话。
const CTX_BREAKDOWN_PREFIX = 'zcode.ctxBreakdown.'
const CTX_BREAKDOWN_MAX_SESSIONS = 30

function saveBreakdownCache(sessionId: string, breakdown: ContextBreakdownItem[], used: number): void {
  if (!sessionId) return
  try {
    const key = CTX_BREAKDOWN_PREFIX + sessionId
    const value = JSON.stringify({ breakdown, used, savedAt: Date.now() })
    // 流式期间 5s 轮询都会走这里：内容没变不重复写（也省掉 LRU 扫描）
    if (getPersisted(key) === value) return
    setPersisted(key, value)
    // LRU 淘汰：按 savedAt 只保留最近 N 个会话（损坏条目按最旧处理，顺带清理）
    const entries: { key: string; savedAt: number }[] = []
    for (const { key: k, value: v } of entriesWithPrefix(CTX_BREAKDOWN_PREFIX)) {
      if (k === key) continue
      let savedAt = 0
      try {
        const parsed = JSON.parse(v) as { savedAt?: number }
        if (typeof parsed.savedAt === 'number') savedAt = parsed.savedAt
      } catch { /* 损坏条目保持 savedAt=0，优先淘汰 */ }
      entries.push({ key: k, savedAt })
    }
    const overflow = entries.length + 1 - CTX_BREAKDOWN_MAX_SESSIONS
    if (overflow <= 0) return
    entries.sort((a, b) => a.savedAt - b.savedAt)
    for (const e of entries.slice(0, overflow)) removePersisted(e.key)
  } catch { /* 存储不可用/写满：放弃持久化，内存态不受影响 */ }
}

function loadBreakdownCache(sessionId: string, used: number): ContextBreakdownItem[] | null {
  if (!sessionId) return null
  try {
    const raw = getPersisted(CTX_BREAKDOWN_PREFIX + sessionId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { breakdown?: ContextBreakdownItem[]; used?: number }
    // used 不一致 = 缓存后会话变过（别处对话/compact），构成已过期，不采用
    if (!Array.isArray(parsed.breakdown) || parsed.used !== used) return null
    return parsed.breakdown
  } catch {
    return null
  }
}

// ============ 普通响应处理 ============

/**
 * 从消息流推断当前会话使用的模型（currentModel 为 null 时用）。
 * 兼容历史会话 / CLI 默认模型场景：取最后一条带 modelID 的消息。
 * assistant 用扁平 modelID/providerID；user 用嵌套 model.{modelID,providerID}。
 * providerID 缺失时从 models 列表反查（需 models 已加载）。
 */
function inferCurrentModel(messages: ZCodeMessage[], models: ModelOption[]): { modelId: string; providerId: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    // v1 大写 modelID/providerID、user 嵌套 model；v2 小写驼峰 modelId/providerId
    const modelId = info.modelID ?? info.modelId ?? info.model?.modelID
    if (modelId) {
      const providerId = info.providerID ?? info.providerId ?? info.model?.providerID ?? models.find((m) => m.modelId === modelId)?.providerId
      return providerId ? { modelId, providerId } : null
    }
  }
  return null
}

/** 从消息流推断当前权限模式（currentMode 为 null 时用，settings 拉取前的兜底显示）*/
function inferCurrentMode(messages: ZCodeMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const mode = messages[i].info.mode
    if (mode) return mode
  }
  return null
}

/* ============ 会话级模型记忆（缺陷BI：模型记忆全局单值跨会话污染） ============
 * zcode.currentModel 是全局单值（新会话的默认模型），历史行为把它当成所有会话的
 * 记忆在切会话/重启恢复时重放 → 别的会话选过的模型被自动切到当前会话（issue #9）。
 * 修复：每个会话的选择单独记忆（zcode.modelMemory，LRU≤50）；切回已有会话只重放
 * 它自己的选择，无记忆则不重放（显示由消息快照 inferCurrentModel 推断，服务端本就
 * 持有其模型）；仅新建会话回退全局默认（保留"新会话跟随上次选择"的既有体验）。 */
const MODEL_MEMORY_KEY = 'zcode.modelMemory'
const MODEL_MEMORY_MAX = 50

type ModelChoice = { modelId: string; providerId: string }
type ModelMemoryEntry = ModelChoice & { t: number }

function readModelMemory(): Record<string, ModelMemoryEntry> {
  try {
    const raw = getPersisted(MODEL_MEMORY_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, ModelMemoryEntry>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 读某会话自己的模型记忆（无 → null）*/
function readSessionModel(sessionId: string): ModelChoice | null {
  const e = readModelMemory()[sessionId]
  return e ? { modelId: e.modelId, providerId: e.providerId } : null
}

/** 写会话级记忆（带 LRU 截断，防 kv 无限增长；条目随会话选择覆盖更新）*/
function rememberSessionModel(sessionId: string, model: ModelChoice): void {
  const map = readModelMemory()
  map[sessionId] = { ...model, t: Date.now() }
  const keys = Object.keys(map)
  if (keys.length > MODEL_MEMORY_MAX) {
    keys.sort((a, b) => map[a].t - map[b].t)
    for (const k of keys.slice(0, keys.length - MODEL_MEMORY_MAX)) delete map[k]
  }
  setPersisted(MODEL_MEMORY_KEY, JSON.stringify(map))
}

function forgetSessionModel(sessionId: string): void {
  const map = readModelMemory()
  if (!(sessionId in map)) return
  delete map[sessionId]
  setPersisted(MODEL_MEMORY_KEY, JSON.stringify(map))
}

/* ============ 思考级别 info 按模型缓存 ============
 * settings（session/read）需要会话，待命态（新标签/新建会话，懒创建前）拿不到级别集。
 * settings 响应时按当前模型把 available/defaultLevel 落 persist，待命态恢复显示，
 * 让思考深度在无会话时也可预选（与模型预选对齐）。current 是会话态不入缓存。 */
const THOUGHT_LEVEL_CACHE_PREFIX = 'zcode.thoughtLevelInfo.'

/** 读某模型的缓存级别集（无缓存/模型不支持思考 → null）*/
function readThoughtLevelCache(modelId: string | null | undefined): ThoughtLevelInfo | null {
  if (!modelId) return null
  try {
    const raw = getPersisted(THOUGHT_LEVEL_CACHE_PREFIX + modelId)
    if (!raw) return null
    const info = JSON.parse(raw) as ThoughtLevelInfo
    return info?.enabled && info.available?.length ? info : null
  } catch {
    return null
  }
}

/** 写缓存（settings 响应时按当前模型记录）*/
function writeThoughtLevelCache(modelId: string | null | undefined, info: ThoughtLevelInfo): void {
  if (!modelId || !info?.enabled || !info.available?.length) return
  setPersisted(THOUGHT_LEVEL_CACHE_PREFIX + modelId, JSON.stringify({
    enabled: true,
    available: info.available,
    defaultLevel: info.defaultLevel,
  }))
}

// subscribed 后模型恢复错峰（十五轮）：sessionId → 兜底定时器。selectSession 不再
// 即发 setModel（大会话冷启动时堵队列必超时），改挂本表等 subscribed 回执消费；回执
// 丢失（订阅失败/事件被吞）由 12s 兜底触发——恢复不依赖单一事件，只延迟不缺席。
// 兜底取 12s：Java 侧 subscribe 忙窗口 10s 超时才乐观回 subscribed（review Spec①），
// 兜底必须晚于它，否则 28MB 冷启动场景 setModel 仍会抢在队列消化前下发
const MODEL_APPLY_FALLBACK_MS = 12_000
const pendingModelApplyAfterSubscribe = new Map<string, { timer: ReturnType<typeof setTimeout>; newSession: boolean }>()

/** 挂起模型记忆恢复：subscribed 回执或 12s 兜底（先到者）触发 applyModelIfReady。
 *  导出：spec 模拟懒创建链路时复用（setState 短路 createSession 的场景）*/
export function scheduleModelApplyAfterSubscribe(sessionId: string, newSession = false): void {
  cancelPendingModelApply(sessionId)
  const timer = setTimeout(() => {
    pendingModelApplyAfterSubscribe.delete(sessionId)
    const st = useStore.getState()
    if (st.currentSessionId === sessionId) st.applyModelIfReady(sessionId, newSession)
  }, MODEL_APPLY_FALLBACK_MS)
  pendingModelApplyAfterSubscribe.set(sessionId, { timer, newSession })
}

function cancelPendingModelApply(sessionId: string): void {
  const t = pendingModelApplyAfterSubscribe.get(sessionId)
  if (t) {
    clearTimeout(t.timer)
    pendingModelApplyAfterSubscribe.delete(sessionId)
  }
}

/** modelAppliedSessions 登记的有效期：正常路径 modelSet/modelSetFailed 数秒内必达，
 *  上限覆盖 Java 忙窗口重试两档（15s+30s）耗时——期内重发会与后台补订双发，过期才放行 */
const MODEL_APPLY_REGISTRATION_TTL_MS = 60_000

/** 模型切换是否在途（setModel 已发出、modelSet 未回；5s 未回视为切换失败已过期）*/
function isModelSwitchInFlight(state: { modelSwitchInFlightAt: number | null }): boolean {
  return state.modelSwitchInFlightAt != null && Date.now() - state.modelSwitchInFlightAt < 5000
}

/**
 * 从 messages 重新解析状态面板数据（todos/agents/fileChanges），返回 store patch。
 * agents 三源合并：parseAgents（兜底）+ 实时聚合活动 + session/subagents RPC（权威）。
 * backgroundWorksFromTranscript：从转录重建的历史后台任务（IDE 重启后运行时投影消失，
 * 子代理列表靠 parseAgents 同款思路从转录恢复——bash 后台化确认行判据单点在
 * utils/backgroundTask，重建条目 status='ended'（任务已随进程死亡的历史呈现）。
 */
function refreshStatus(
  messages: ZCodeMessage[],
  activities: SubagentActivity[] = [],
  rpc: SubagentInfo[] = [],
): Partial<StoreState> {
  return {
    todos: parseTodos(messages),
    agents: mergeAgentItems(parseAgents(messages), activities, rpc),
    fileChanges: parseFileChanges(messages),
    backgroundWorksFromTranscript: parseBackgroundTaskWorks(messages),
    deliveredWorkStatuses: parseDeliveredWorkStatuses(messages),
  }
}

/** 后端模型 API 错误（backendError 通道）→ 顶栏文案；配额类给"重试不会成功"的专门提示 */
function formatBackendError(statusCode: number | undefined, code: string | undefined, message: string): string {
  const trimmed = (message || '').slice(0, 300)
  if (looksLikeQuotaError(code, trimmed)) return i18n.t('app.backendQuotaError')
  return i18n.t('app.backendApiError', { statusCode: statusCode ?? '?', message: trimmed })
}

/** turn.failed 错误 → 顶栏文案（配额类归一成配额提示，无详情给兜底文案） */
function formatTurnError(err: TurnErrorInfo): string {
  if (looksLikeQuotaError(err.code, err.message)) return i18n.t('app.backendQuotaError')
  return err.message
    ? i18n.t('app.turnFailed', { message: err.message.slice(0, 300) })
    : i18n.t('app.turnFailedNoDetail')
}

/**
 * 错误 → 额度横幅触发源（会话额度横幅，见 utils/quotaWindows.ts）。
 * 仅 bigmodel 系渠道进横幅：第三方渠道的 429/quota 语义不可比，只走顶栏错误条。
 */
function quotaBannerTriggerFrom(
  providerId: string | null | undefined,
  code: string | number | undefined,
  message: string | undefined,
  statusCode?: number,
): QuotaBannerTrigger | null {
  if (!isBigmodelProvider(providerId)) return null
  const kind = classifyQuotaError(code, message, statusCode)
  if (!kind) return null
  return {
    kind,
    ...(kind === 'provider-limited' ? { message: providerLimitedMessage(message) ?? undefined } : {}),
    triggerKey: bannerTriggerKey(kind, code, message),
  }
}

/**
 * 定时文本的 /goal 拦截分派：命令文本转 goalManage 控制意图（与手动输入同一语义）。
 * 定时文本若走普通 sendMessage，命令原文会被当 user 消息发给模型——goal 引擎
 * （session/goal RPC）不触发、目标卡不出现（2026-09-04 用户反馈）。命中时补
 * scheduledFired 上报：sendMessage 真发点的上报不再经过，缺了则「已发历史」丢记录；
 * set 落库的 user 消息文本是 objective（服务端剥 /goal 前缀，sqlite 实测），上报
 * text 用 objective 才能与历史消息对上「定时执行」徽标（MessageBubble 按
 * sessionId+text 匹配 firedHistory），其余动作不落库 user 消息、用原文本仅作历史展示。
 * 返回 true = 已按 goal 命令处理，调用方跳过 sendMessage。
 */
function dispatchScheduledGoalText(
  text: string,
  fireAt: number | undefined,
  get: () => StoreState,
): boolean {
  const cmd = parseGoalCommand(text)
  if (!cmd) return false
  const sid = get().currentSessionId
  get().goalManage(cmd.action, cmd.objective)
  if (sid && fireAt != null) {
    sendToJava({
      op: 'scheduledFired',
      sessionId: sid,
      text: cmd.action === 'set' ? (cmd.objective ?? text) : text,
      fireAt,
    })
  }
  return true
}

/** 后端消息归约（导出供测试直接驱动分发链路；运行时由 bridge onMessage 挂接）*/
export function handleResponse(
  msg: JavaResponse,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  switch (msg.op) {
    case 'projectPath':
      // 启动兜底应答：写回注入失败的 projectPath（该字段仅 init 与此处两处写入）
      if (msg.workspacePath) set({ projectPath: msg.workspacePath })
      break
    case 'linkedWorkspaces': {
      // 关联目录全量快照（get/add/remove 三 op 共用应答）
      set({ linkedWorkspaces: msg.workspaces })
      // 添加即切换：用户点 ⊕ 选目录的目的就是去看它（取消选择时无 added 字段）
      if (msg.added) {
        get().setActiveWorkspace(msg.added)
      } else if (
        // 移除的是激活目录 → 回退本项目（关联目录列表已不含它）
        get().activeWorkspacePath &&
        normalizeWsPath(get().activeWorkspacePath) !== normalizeWsPath(get().projectPath) &&
        !msg.workspaces.some((w) => normalizeWsPath(w) === normalizeWsPath(get().activeWorkspacePath))
      ) {
        get().setActiveWorkspace(get().projectPath)
      }
      break
    }
    case 'listSessions': {
      // 乱序丢弃守卫（多目录快速连切）：响应带请求时的目录回显，与当前列表作用域
      // 不符 = 晚到的旧目录响应，直接丢（否则旧列表覆盖新目录——真机"一直显示其他
      // 目录的"。缺省回显（旧 Java 包）不丢弃，向后兼容）
      if (
        msg.workspacePath &&
        get().sessionsWorkspace &&
        normalizeWsPath(msg.workspacePath) !== normalizeWsPath(get().sessionsWorkspace)
      ) {
        console.log(`[store] 丢弃乱序 listSessions 响应: ${msg.workspacePath} (当前=${get().sessionsWorkspace})`)
        break
      }
      set({ sessionsLoading: false })
      // 标题合并优先级：手动重命名（persist）> 服务端正式标题（顺带清临时标题）
      // > 本地临时标题（乐观占位，见 sendMessage）> 上一帧完整标题（防服务端空值
      // 覆盖，见下）> 服务端占位（空/会话 id）
      // 子代理子会话过滤（sess_subagent_*）：session/list 的 DB 查询排除 subagent_child，
      // 但内存活跃会话补列不排——子代理回合结束后驻留 app-server 内存期间，每次列表
      // 请求都被补列进响应（IDEA 重启杀进程才消失）。Java 侧已过滤，这里兜底服务端
      // 直传；staleLocal 同样排除，防已混入的本地条目经补插机制在后续刷新中复活
      const prevProvisionals = get().provisionalTitles
      const prevSessions = get().sessions
      const nextProvisionals = { ...prevProvisionals }
      const merged = msg.sessions
        .filter((s) => !s.sessionId.startsWith('sess_subagent'))
        .map((s) => {
        const stored = getPersisted(`zcode.sessionTitle.${s.sessionId}`)
        if (stored) {
          delete nextProvisionals[s.sessionId]
          return { ...s, title: stored }
        }
        // 防回退守卫（2026-09-19）：快照早于本地最后权威标题更新（titleUpdated 实时
        // 事件/手动改名）时，本次拉到的服务端 title 是生成完成前的旧值——保留本地。
        // 不加此守卫，AI 标题会在生成后 ~10s 内被任何一次旧快照刷新顶回初始标题
        const lastTitleAt = titleUpdatedAt[s.sessionId]
        const prevForGuard = prevSessions.find((x) => x.sessionId === s.sessionId)
        if (
          listSessionsSentAt > 0 &&
          lastTitleAt &&
          lastTitleAt > listSessionsSentAt &&
          prevForGuard &&
          !isDefaultSessionTitle(prevForGuard.title, s.sessionId)
        ) {
          delete nextProvisionals[s.sessionId]
          return { ...s, title: prevForGuard.title }
        }
        if (!isDefaultSessionTitle(s.title, s.sessionId)) {
          delete nextProvisionals[s.sessionId]
          return s
        }
        const provisional = prevProvisionals[s.sessionId]
        if (provisional) return { ...s, title: provisional }
        // 服务端运行中会话内存序列化缺陷（缺陷X 残留，2026-08-25 PyCharm 实测）：
        // zcode.cjs session/list 对运行中的会话用内存对象补列（dee({app})），title
        // 恒空；0.16.5 创建的正斜杠行会话在主查询（反斜杠形态）缺失，alt 补查的
        // sqlite 完整行又被 sessionId 去重丢弃 → 响应里该会话 title 空 → header/
        // 历史列表回退会话 id 前缀，且随会话运行状态反复横跳。上一帧已有非占位
        // 标题时沿用（服务端权威值由 titleUpdated / 后续刷新校正，此处仅防空值覆盖）
        const prev = prevSessions.find((x) => x.sessionId === s.sessionId)
        if (prev && !isDefaultSessionTitle(prev.title, s.sessionId)) {
          return { ...s, title: prev.title }
        }
        return s
      })
      // 并发时序防御：listSessions 响应是"请求发出时刻"的服务端快照，可能早于本标签的
      // 乐观创建（init/早前发出的慢响应晚于 createSession 响应到达）——若直接全量替换，
      // 刚插入的新会话会被旧快照抹掉，header/历史列表退回会话 id 前缀。
      // 但保留必须限定在"乐观新建的几秒窗口"内：本地任意旧条目无限补插会把服务端刻意
      // 隐藏的会话复活（2026-09-08 实踩：自动归档 157 条后刷新，归档会话经 staleLocal
      // 全量复活，会话列表数字不减）。保留判据二选一：
      // - 本标签当前打开的会话（服务端快照缺它必是时序问题，不能从 header 抹掉）
      // - 最近 5 分钟内有活动（乐观新建/刚跑过回合的时序窗口足够覆盖；更久的缺失条目
      //   按服务端权威处理——归档/客户端删除/子会话泄漏过滤都靠这个口径生效）
      const serverIds = new Set(merged.map((s) => s.sessionId))
      const currentId = get().currentSessionId
      const RECENT_WINDOW_MS = 5 * 60_000
      // 列表作用域（多目录会话）：补插仅限当前列表所属目录的条目——切到关联目录后，
      // 本项目"当前打开/刚活跃"的会话不得经 staleLocal 残留进别的目录列表
      const scopeWs = get().sessionsWorkspace
      const inScope = (s: SessionInfo) =>
        !scopeWs || !s.workspacePath || normalizeWsPath(s.workspacePath) === normalizeWsPath(scopeWs)
      const staleLocal = get().sessions.filter(
        (s) =>
          inScope(s) &&
          !serverIds.has(s.sessionId) &&
          !s.sessionId.startsWith('sess_subagent') &&
          (s.sessionId === currentId || Date.now() - (s.updatedAt ?? 0) < RECENT_WINDOW_MS),
      )
      if (staleLocal.length) merged.push(...staleLocal)
      // 标题缓存喂入（跨目录浏览丢标题的兜底层，见 lastKnownTitles 注释）
      for (const s of merged) {
        if (s.title && !isDefaultSessionTitle(s.title, s.sessionId)) {
          lastKnownTitles.set(s.sessionId, s.title)
        }
      }
      // 时间倒序统一收口：服务端快照整体有序，但本地的补插项（staleLocal 追加在尾、
      // 乐观新建插在头）会破坏全局顺序 → 按更新时间倒序重排（稳定排序，同时间戳保持原序）
      merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      // 回合运行中的行强制 running：快照是「请求发出时刻」的服务端值，可能早于回合
      // 开始（或存量行本就回 idle）——直接透传会把运行中会话闪回已完成，相位广播为准
      const runningIds = Object.keys(get().remoteRunningTurns)
      set({
        sessions: runningIds.length
          ? merged.map((s) => (runningIds.includes(s.sessionId) ? { ...s, status: 'running' } : s))
          : merged,
        provisionalTitles: nextProvisionals,
      })

      // 会话恢复（仅多标签体系）：仅当标签有注入的初始会话（重启恢复）且会话仍存在时选中它。
      // 懒创建：新标签（无注入）/ 注入会话已删 → 保持无会话待命态，发首条消息时再建
      //（见 sendMessage），避免误点多开标签堆积空会话。注意：不走 localStorage（多标签
      // webview 同 origin 共享存储，lastSessionId 会互相覆盖导致新标签串到别的标签的会话）；
      // 恢复职责由 Java 侧 TabState 承担。
      // 多目录会话：boot 恢复的作用域基准 = 标签初始目录（__ZCODE_TAB_WORKSPACE__，缺省
      // 本项目）——标签绑定会话必属该目录；用户切到其他目录浏览后的例行刷新不得把绑定
      // 会话从别的目录列表里"恢复"出来（新标签打开关联目录会话按注入目录恢复，同依赖）
      const tabWs = getTabWorkspacePath() || get().projectPath
      const bootScopeOk = !scopeWs || normalizeWsPath(scopeWs) === normalizeWsPath(tabWs)
      if (get().currentSessionId === null && bootScopeOk) {
        const initialId = getInitialSessionId()
        const initial = initialId ? merged.find((s) => s.sessionId === initialId) : undefined
        if (initial) {
          // 门控：只服务 boot 自动恢复。用户主动进入待命态后（skipInitialSessionRestore）
          // 绑定会话仍在列表也不得选回——后台 listSessions 刷新无时序承诺
          if (!get().skipInitialSessionRestore) {
            console.log(`[store] 恢复标签绑定的会话: ${initialId}`)
            get().selectSession(initial)
          }
        } else {
          // 待命态 = 新会话（2026-10-08 用户实测拍板"新建标签页=新建会话"）：新标签
          // 无注入绑定 / 绑定会话已被删除均落这里——应用「新会话自动点亮」设置
          //（resetToNewSession 之外的第二应用点；懒标签激活后走同一 boot 路径一并覆盖）。
          // 只点不灭：配置关时不动，防抹掉 listSessions 往返窗口内用户的手动勾选
          if (readCurrentFileConfig().autoOnNewSession) get().setCurrentFileEnabled(true)
          if (initialId) console.log('[store] 标签绑定的会话已不存在，保持无会话待命态')
        }
      }

      // boot 恢复收尾（多目录会话，真机 2026-10-28）：boot 首拉（标签初始目录）响应已
      // 处理完（恢复或未命中），列表作用域静默切回落位目录并重拉——否则 chips 高亮
      // （=落位，本项目）与列表（=标签初始目录）脱节，用户看到"选中本项目但列表是
      // 别的目录的会话"。当前会话照常打开（消息已拉），暂不在本项目列表里（标题
      // fallback 链已兜）。切回动作再发一次 listSessions（~百毫秒；bootRestorePending
      // 此处已消费，不会循环）
      if (get().bootRestorePending) {
        const fallbackWs = get().activeWorkspacePath || get().projectPath
        set({ bootRestorePending: false })
        if (normalizeWsPath(scopeWs) !== normalizeWsPath(fallbackWs)) {
          console.log(`[store] boot 恢复完成，列表作用域切回落位目录: ${fallbackWs}`)
          set({ sessions: [], sessionsWorkspace: fallbackWs, sessionsLoading: true })
          get().loadSessions()
        }
      }
      break
    }

    case 'createSession': {
      // 点 + 新建 / 懒创建完成后切换到新会话（Java 返回 sessionId）。
      // 懒创建暂存的首条消息须在下方 set 清空前取出
      const sid = msg.sessionId
      const pendingFirst = get().pendingFirstMessage
      const pendingFirstAttachments = get().pendingFirstAttachments
      const pendingFirstFireAt = get().pendingFirstScheduledFireAt
      // 待命态定时任务暂存（createSessionForSchedule 置入）同样须在 set 清空前取出
      const pendingSchedule = get().pendingScheduleCreation
      // 待命态目标暂存（goalManage 无会话分支置入）同上
      const pendingGoal = get().pendingGoalCreation
      // 待命态预选值（currentMode/thoughtLevel 无会话时的本地记录），下方 set 复位前捕获
      const preselectedMode = get().currentMode
      const standbyThought = get().thoughtLevel
      // 后台建会话挂定时（勾选「在新会话中执行」且当前标签已有会话）：不切换当前视图——
      // 切换会顶掉正在看的会话；只落库任务，新会话到点分派时由 Java openSessionTab
      // 按需开标签承载（与后台补发同路径）。case 末尾的 loadSessions 会把新会话刷进列表
      if (sid && pendingSchedule?.keepCurrent) {
        set({ creatingSession: false, pendingScheduleCreation: null })
        sendToJava({
          op: 'scheduledCreate',
          sessionId: sid,
          // 与会话创建目录一致（多目录会话：新会话可能落在激活目录而非本项目）
          workspacePath: get().activeWorkspacePath || get().projectPath,
          text: pendingSchedule.text,
          fireAt: pendingSchedule.fireAt,
          ...(pendingSchedule.modelId ? { providerId: pendingSchedule.providerId, modelId: pendingSchedule.modelId } : {}),
        })
        get().loadSessions()
        break
      }
      if (sid) {
        // 会话落位目录 = 创建请求实际携带的 workspace（多目录会话：可能是激活的关联目录）
        const ws = get().activeWorkspacePath || get().projectPath
        set({
          currentSessionId: sid,
          currentWorkspacePath: ws,
          creatingSession: false,
          // 新会话无历史：解除可能在途的首拉标志（触发路径刁钻但补清无害，缺陷FH 同族）
          loadingMessages: false,
          pendingFirstMessage: null,
          pendingFirstAttachments: null,
          pendingFirstScheduledFireAt: null,
          pendingScheduleCreation: null,
          // pendingGoalCreation 不在此清：订阅回执（case 'subscribed'）消费（时序见下方
          // pendingGoal 兜底注释），set 会先于回执执行
          ...sessionResetBase(),
          compacting: false,
          backgroundTasks: {},
      contextUsage: null, // 清空旧会话数据，等 getUsage 回来更新
      sessionDebug: null,
      contextBreakdown: null,
      // 保留待命态的级别集（与当前模型同源缓存）与预选模式，避免选择器/按钮闪回默认；
          // 服务端权威值由下方 loadSettings → settings 响应校准
          thoughtLevel: standbyThought,
          currentMode: preselectedMode,
          // 上一次会话流程的切换在途标记/推迟级别不跨会话（本块先于 applyModelIfReady，
          // 其发送 setModel 时会重新置位）
          modelSwitchInFlightAt: null,
          pendingThoughtLevel: null,
          subagentReport: null,
          markdownPreview: null,
          askUserReview: null,
          // 新会话乐观插入列表（空标题占位）：listSessions 异步返回前 header/历史列表
          // 就能找到该会话——否则乐观标题（sendMessage 的 map）匹配不到，标题要等
          // 列表刷新才显示（期间 header 是会话 id 前缀）。服务端权威数据由下方
          // loadSessions 合并校正（listSessions 合并对空标题回落 provisionalTitles）
          sessions: [
            {
              sessionId: sid,
              title: '',
              status: 'running',
              mode: 'yolo',
              workspacePath: ws,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            ...get().sessions.filter((x) => x.sessionId !== sid),
          ],
        })
        // 订阅新会话（Java 端 handleSubscribe 内部会先 resume 激活）
        sendToJava({ op: 'subscribe', sessionId: sid, workspacePath: ws })
        // 待命态定时任务落库：会话已建好，任务绑定真实 sid（归属唯一化）
        if (pendingSchedule) {
          sendToJava({
            op: 'scheduledCreate',
            sessionId: sid,
            workspacePath: ws,
            text: pendingSchedule.text,
            fireAt: pendingSchedule.fireAt,
            ...(pendingSchedule.modelId ? { providerId: pendingSchedule.providerId, modelId: pendingSchedule.modelId } : {}),
          })
        }
        // 待命态目标补发：等 subscribe 回执（case 'subscribed'）再下发。Kotlin 侧
        // 各 op 在线程池并发执行（executeOnPooledThread），subscribe（resume+subscribe
        // 两个 RPC）慢于 goalManage 时，goal 控制轮的 turn.started 会在订阅白名单生效
        // 前到达而被 pushStreamEvent 丢弃，后续 delta 无流式消息可落 → 新会话实时流
        // 整段断流，直到回合结束重拉才渲染（0.3.2 真机实测根因）。兜底：回执 2.5s
        // 未到也发（订阅失败时事件本就收不到，goalManaged 回执仍能出目标卡）
        if (pendingGoal) {
          setTimeout(() => {
            const p = get().pendingGoalCreation
            if (p && get().currentSessionId === sid) {
              set({ pendingGoalCreation: null })
              get().goalManage('set', p.objective)
            }
          }, 2500)
        }
        // 新会话也按记忆模型下发 setModel（等 models 就绪，由 applyModelIfReady 内部判断）。
        // 登记为本 webview 新建会话：models 迟到时后续 models 响应的 applyModelIfReady
        // 仍按"新会话"回退全局默认（缺陷BI 后全局默认仅对新会话生效）
        set({ createdSessionIds: new Set([...get().createdSessionIds, sid]) })
        // 懒创建首条消息在途时跳过独立 setModel：它与首回合在服务端赛跑会撞 -32603
        // Unsupported（08-29 定时触发实测：新会话 runtime 未注册任何 provider），
        // 模型注册与回合执行改由首条 send 携带的 runtimeModel 承担（send 已带 currentModel），
        // 仅标记已应用防 messages/models 刷新时重发
        if (!pendingFirst) {
          // 新会话同样错峰（十五轮）：新建会话在服务端要 spawn runtime，setModel 即发
          // 与首回合在服务端赛跑（-32603 家族），挂 subscribed 回执后下发（newSession
          // 语义不变：models 迟到时仍按新会话回退全局默认）
          scheduleModelApplyAfterSubscribe(sid, true)
        } else {
          set({ modelAppliedSessions: new Map(get().modelAppliedSessions).set(sid, Date.now()) })
        }
        // 待命态预选的模式补下发——必须先于首条消息，预选 plan 时首问就按计划模式跑
        if (preselectedMode) get().setMode(preselectedMode)
        // 记忆的思考级别同样先于首条消息下发（否则首问跑在服务端默认级别上）；
        // 用待命态 info / 按模型缓存校验有效性，settings 到达后 applyThoughtLevelIfReady
        // 被 appliedForSession 标记拦下不重发；无效（无缓存/不在列表）则留给该校准路径兜底。
        // 懒创建首条消息在途时整块跳过：setThoughtLevel 若先于 send 到达服务端，会话还
        // 跑在默认模型上，级别可能对其非法（-32603，同 setModel 赛跑根因）；级别交给
        // 首回合后的权威 settings 校准（applyThoughtLevelIfReady 无 applied 门控挡路）
        if (!pendingFirst) {
          const savedLevel = getPersisted('zcode.thoughtLevel')
          const info = standbyThought ?? readThoughtLevelCache(get().currentModel?.modelId)
          if (savedLevel && info?.enabled && info.available.some((a) => a.value === savedLevel)) {
            set({ thoughtLevel: { ...info, current: savedLevel } })
            if (isModelSwitchInFlight(get())) {
              // 上方 applyModelIfReady 刚发出 setModel：级别须推迟到切换落定后、由权威
              // settings 响应校验再下发（modelSet 后 500ms 的 loadSettings 走 settings 处理器）。
              // 不能按本地缓存校验直发——切换前缓存可能已被污染（旧会话切换时写入），会放行
              // 对新模型非法的值（-32603，缺陷AA第二形态）；也不置 appliedForSession（留着给
              // 权威路径使用）。暂存标记让 settings 处理器届时重置门控重新校验
              set({ pendingThoughtLevel: savedLevel })
            } else {
              set({ thoughtLevelAppliedForSession: sid })
              sendToJava({ op: 'setThoughtLevel', sessionId: sid, thoughtLevel: savedLevel })
            }
          }
        }
        // 拉取上下文用量（圆环显示）
        get().loadUsage()
        // 拉取运行时设置（新会话默认模式 + 级别集）
        get().loadSettings()
        // 懒创建收尾：发出暂存的首条消息。须在 set 之后——set 复位了 streaming，
        // sendMessage 会重新置位并走完整的 subscribe+send+乐观消息流程
        if (pendingFirst) {
          get().sendMessage(
            pendingFirst,
            pendingFirstAttachments ?? undefined,
            pendingFirstFireAt != null ? { scheduledFireAt: pendingFirstFireAt } : undefined,
          )
        }
      } else {
        // 异常响应（无 sessionId）：复位标志与暂存，防卡死
        set({ creatingSession: false, pendingFirstMessage: null, pendingFirstAttachments: null, pendingFirstScheduledFireAt: null, pendingScheduleCreation: null, pendingGoalCreation: null })
      }
      get().loadSessions()
      break
    }

    case 'sessionDeleted': {
      // 从列表移除，如果删的是当前会话则清空
      const cur = get()
      const deletedCurrent = cur.currentSessionId === msg.sessionId
      set({
        sessions: cur.sessions.filter((x) => x.sessionId !== msg.sessionId),
        // Java 侧已同步丢弃该会话的待发定时消息，本地镜像过滤
        scheduledMessages: cur.scheduledMessages.filter((m) => m.sessionId !== msg.sessionId),
        ...(deletedCurrent
          ? {
              currentSessionId: null,
              // 进待命态必须解除首拉标志：在途快照将被 sessionId 守卫丢弃，
              // 不补清则「加载消息中」永久卡死（缺陷FH 同族）
              loadingMessages: false,
              // 用户主动删除：放弃 boot 恢复，防滞后/后台 listSessions 仍带该会话时被选回
              skipInitialSessionRestore: true,
              ...sessionResetBase(),
              compacting: false,
              backgroundTasks: {},
              contextUsage: null,
              sessionDebug: null,
              contextBreakdown: null,
              thoughtLevel: null,
              currentMode: null,
              modelSwitchInFlightAt: null,
              pendingThoughtLevel: null,
            }
            : {}),
      })
      // 删的是当前会话 → 进入待命态，恢复当前模型的缓存级别集供预选
      if (deletedCurrent) get().hydrateThoughtLevelStandby()
      break
    }

    case 'sessionArchived': {
      // 归档：从历史列表移除（不删数据，可恢复）。当前会话被归档不清空——
      // app-server 内存仍在跑，保留对话上下文，恢复后列表重新显示
      set({ sessions: get().sessions.filter((x) => x.sessionId !== msg.sessionId) })
      // 已归档列表已加载则刷新（让归档项出现）；未加载则下次进入 tab 时拉取
      if (get().archivedSessions.length > 0 || get().archivedLoading) {
        get().loadArchivedSessions()
      }
      break
    }

    case 'scheduledList': {
      // Java 侧权威列表全量镜像（跨标签广播/初始化水合共用），含已发记录（徽标匹配用）。
      // ts 单调守卫：scheduledFired 上报与 scheduledDueAck 在 Java 侧并发处理，两次广播的
      // 到达顺序不保证——旧快照（items 仍含已移除项）后到会把卡片复活回镜像（实测残留）
      const ts = (msg as { ts?: number }).ts ?? 0
      if (ts && ts < get().lastScheduledListTs) break
      set({
        lastScheduledListTs: ts,
        scheduledMessages: (msg.items ?? []) as ScheduledMessageItem[],
        firedHistory: (msg.fired ?? []) as ScheduledFiredRecord[],
      })
      break
    }

    case 'scheduledDue': {
      // 定时消息到点：走与手动发送同一段准入（sendMessage 内部分流——回合活跃入队尾，
      // 空闲直接发），发出后消息带「定时执行」徽标。sessionId 不匹配（路由到的标签已
      // 切走）不受理也不 ack → Java 侧 15s 超时降级直发。
      const { id, sessionId: dueSid, text, scheduledFireAt, providerId, modelId } = msg as {
        id: string
        sessionId?: string
        text: string
        scheduledFireAt?: number
        providerId?: string
        modelId?: string
      }
      if (dueSid && get().currentSessionId !== dueSid) break
      // /goal 命令文本转 goalManage（手动输入同语义；普通 send 命令原文进对话流，
      // goal 引擎不触发、目标卡不出现）。仅空闲时拦截：回合运行中服务端会拒绝
      // goal 操作（error 回执+乐观回滚），流式中改走 sendMessage 入队暂存，
      // 回合结束 flushQueue 再拦截（那里必非流式）
      if (!get().streaming && dispatchScheduledGoalText(text, scheduledFireAt, get)) {
        // 已按 goal 命令处理
      } else {
        get().sendMessage(text, undefined, scheduledFireAt != null
          ? {
              scheduledFireAt,
              ...(modelId ? { scheduledProviderId: providerId, scheduledModelId: modelId } : {}),
            }
          : undefined)
      }
      // 本地即时移除（权威列表由 Java ack 后广播）；handleResponse 的 set 无 updater 形态
      set({ scheduledMessages: get().scheduledMessages.filter((m) => m.id !== id) })
      sendToJava({ op: 'scheduledDueAck', id })
      break
    }

    case 'sessionRestored': {
      // 恢复：从已归档列表移除，刷新历史列表让会话重新出现
      set({ archivedSessions: get().archivedSessions.filter((x) => x.sessionId !== msg.sessionId) })
      get().loadSessions()
      break
    }

    case 'sessionArchiveDeleted': {
      // 删除归档会话（软删）：从已归档列表移除即可，会话不回正常列表
      set({ archivedSessions: get().archivedSessions.filter((x) => x.sessionId !== msg.sessionId) })
      break
    }

    case 'autoArchiveConfig': {
      // 共享配置水合（进自动归档 tab 拉取；Kotlin 读 ~/.zcode/v2/setting.json）
      set({ autoArchiveConfigLoaded: true, autoArchiveEnabled: msg.enabled, autoArchiveDays: msg.olderThanDays, autoArchiveLastSweepAt: msg.lastSweepAt || null })
      break
    }

    case 'autoArchiveConfigChanged': {
      // 写入 ack 校正（乐观更新的落地确认）
      set({ autoArchiveEnabled: msg.enabled, autoArchiveDays: msg.olderThanDays })
      break
    }

    case 'autoArchiveRecords': {
      set({ autoArchiveRecords: msg.records })
      break
    }

    case 'autoArchiveRan': {
      // 手动扫描完成：应答带全量记录；归档会话从正常列表消失 → 静默刷新列表。
      // skipped=disabled（Kotlin 终门禁言：开关未启用扫描没跑）只回传记录，不刷列表
      const skipped = msg.skipped === 'disabled'
      set({
        autoArchiveRecords: msg.records,
        autoArchiveRunning: false,
        autoArchiveLastRunCount: skipped ? null : msg.count,
        autoArchiveLastRunSkipped: skipped,
        // skipped 轮没扫过，最近扫描时间保持原值
        autoArchiveLastSweepAt: skipped ? get().autoArchiveLastSweepAt : msg.lastSweepAt || null,
      })
      if (!skipped) get().loadSessions()
      break
    }

    case 'sessionTabLocated': {
      // 历史列表定位应答：found=true 时 Java 已激活宿主标签（跨标签跳转完成），
      // 发起标签的 HistoryView 拿到 true 后只需切回聊天视图
      const resolve = pendingTabLocate
      pendingTabLocate = null
      resolve?.(msg.found)
      break
    }

    case 'openSessions': {
      // 历史列表已打开标签快照（纯展示/点击确认用，不入 state）
      const resolve = pendingOpenTabs
      pendingOpenTabs = null
      resolve?.(Array.isArray(msg.tabs) ? msg.tabs : [])
      break
    }

    case 'sessionForked': {
      // 分叉成功：①自动命名——与 ZCode 官方客户端同款「Fork of 原标题」前缀（fork25
      // sqlite 取证：服务端 fork 落库也自动命名同款），走 renameSession 的 persist 通道
      //（zcode.sessionTitle.<id>，listSessions 响应时合并、优先于服务端标题，跨重启
      // 保留；父标题缺失时只用 "Fork"）；
      // ②新标签打开分叉会话（gotoSession → Java openSessionTab 恢复编排，含 resume/
      // 订阅）；③loadSessions 把分叉条目刷进历史列表
      set({ forkBusy: false })
      if (msg.forkedSessionId) {
        const parentTitle = get()
          .sessions.find((s) => s.sessionId === (msg.parentSessionId ?? get().currentSessionId))
          ?.title?.trim()
        get().renameSession(msg.forkedSessionId, parentTitle ? `Fork of ${parentTitle}` : 'Fork')
        // fork 会话目录 = 发起标签的激活目录（多目录会话：v4 forkAssistant 轮级语义，父子同库行）
        get().openSessionNewTab(msg.forkedSessionId, get().activeWorkspacePath || get().projectPath)
        get().loadSessions()
      }
      break
    }

    case 'forkUnsupported': {
      // 老 CLI 无 v4 面（-32601）：隐藏分叉入口（用户决策：不做 legacy 回退——
      // legacy session/fork 带工作区文件恢复副作用，宁可没有）
      set({ forkBusy: false, forkSupported: false })
      break
    }

    case 'editAccepted': {
      // v4 编辑受理（diag-edit-v4 实测）：服务端已 abort 旧回合 + rewind + 用新
      // 文本/附件重发，v1 编排全由事件流驱动——rewind.triggered 截断（ack 应答
      // 可能晚于事件到达，不在此处理状态）、新 turn 流式、turnEnded 收尾。
      // v2（newCli）例外（diag-v2-edit-rewind 实测）：rewind.triggered 与新回合
      // turn.started 已整体撤出 legacy 流（回退编排在服务端 v4 帧内进行，插件临时
      // 订阅窗口外不可见），等事件确认必然误报「回退未生效」——ack disposition=
      // rewind 即「服务端确定截断重发」的权威确认，就地应用与 rewind.triggered
      // 同一截断核心（截断到目标轮 + 补插编辑气泡 + staged 落 kv）并标记 rewound；
      // 后续流式（归约器按协议 id 自建壳、local_u_ 气泡自动改名）与 turnEnded
      // 收尾链路零改动。blocked=服务端守卫拒绝（未执行），明确提示。
      const replay = get().editReplay
      if (msg.disposition === 'blocked') {
        cancelEditAckTimeout()
        if (replay?.via === 'v4' && !replay.rewound) {
          set({ editReplay: null, lastError: editRejectText(msg.reason, msg.message) })
        }
        break
      }
      if (msg.newCli === true && msg.disposition === 'rewind'
          && replay?.via === 'v4' && !replay.rewound && !replay.stopping) {
        cancelEditAckTimeout()
        const sid = get().currentSessionId
        if (sid) {
          const st = get()
          const r = applyRewindTriggeredCore(st.messages, st.streamingMessageId, replay.targetMsgId, replay, sid)
          set({
            messages: r.messages,
            streamingMessageId: r.streamingMessageId,
            ...(r.matched ? { editReplay: { ...replay, rewound: true, ackPending: false } } : {}),
          })
        }
      }
      break
    }

    case 'editUnsupported': {
      // 两种来源（2026-09-12 三轮反馈分流）：
      // - 老 CLI 无 v4 面（-32601，无 reason）：全局记不支持（会话属性）；空闲发起的
      //   编辑回退 legacy /rewind 编排（rewind 与活动回合互斥，回合中发起的只能
      //   放弃并提示）。
      // - reason=targetGone（行流里找不到目标行：会话级行流缺失/乐观 id 过期）：
      //   **不**记全局不可用（会话级瞬态，永久降级会误伤后续新会话）。纯文本目标
      //   （attachments 为空/未传）本次回退 legacy /rewind（legacy 不依赖行流）；
      //   带图目标不能回退——legacy 重发只有文本，图片会丢，明确提示。
      // editReplay 是乐观置位的，两种来源都要修正 via
      const replay = get().editReplay
      const targetGone = msg.reason === 'targetGone'
      const hasImages = (replay?.attachments?.length ?? 0) > 0
      if (targetGone && replay?.via === 'v4' && hasImages) {
        // 行流缺失 + 带图目标：legacy 回退必丢图，放弃并说明原因（五语文案优先，
        // message 原文=协议层中文仅兜底——2026-09-13 review i18n 收口）
        cancelEditAckTimeout()
        set({
          editReplay: null,
          lastError: i18n.t('chat.edit.unsupportedWithAttachments') || msg.message,
        })
        break
      }
      if (replay?.via === 'v4') {
        if (!get().streaming) {
          set({ editReplay: { ...replay, via: 'legacy' } })
          get().sendMessage(buildEditRewindCommand(replay.targetMsgId), undefined, { hiddenCommand: true })
        } else {
          set({ editReplay: null, lastError: i18n.t('chat.edit.unsupportedMidTurn') })
        }
      }
      if (!targetGone) set({ editViaV4: false })
      break
    }

    case 'editRejected': {
      // v4 编辑被拒（守卫不过/目标过期/附件解析失败等）：专用 op 不走全局 error
      // 复位（编辑可能发生在回合进行中，streaming 不能被误清）。ack 已明确拒绝 =
      // 未执行，若 rewind.triggered 已抢先到达（不可能——stale/redirect 在执行前
      // 拒绝）也只损失本地截断，重拉自愈。迟到编辑无主时静默吞掉。
      // 文案 reason 码优先（五语言包映射），message 原文仅作未知码回退
      cancelEditAckTimeout()
      const replay = get().editReplay
      if (replay?.via === 'v4' && !replay.rewound) {
        set({ editReplay: null, lastError: editRejectText(msg.reason, msg.message) })
      } else if (!replay) {
        set({ lastError: editRejectText(msg.reason, msg.message) })
      }
      break
    }

    case 'turnFileRewindApplied': {
      // 撤销受理（B2 回合产物）：乐观置 reverted + 收掉弹窗——服务端随后推的
      // turn.fileChanges（state=reverted）权威对齐（标题订阅增量/重扫同键幂等）
      const fcMap = get().turnFileChanges
      const fcEntry = fcMap[msg.messageId]
      const patch: Partial<StoreState> = {}
      if (fcEntry) {
        patch.turnFileChanges = { ...fcMap, [msg.messageId]: { ...fcEntry, state: 'reverted', canRewind: false } }
      }
      if (get().turnFileChangesDialogFor === msg.messageId) {
        patch.turnFileChangesDialogFor = null
      }
      if (Object.keys(patch).length > 0) set(patch)
      break
    }

    case 'steerMessage': {
      // 仅失败需要处理（成功由 turn.steerDrained 事件驱动）：清乐观 chip + 横幅
      // 提示 + 队列条目回滚（乐观移除发生在受理之前，失败必须物归原主——按
      // steerPending.restore 插回原位，越界钳到队尾）。仅 chip 仍在途时回滚：
      // 已被 steerDrained/claim 清除说明注入已发生，迟到失败 ack 再回滚会与
      // 注入气泡重复。两种失败形态：error=Java 侧异常（v4 面缺失/会话失效）；
      // accepted:false=服务端拒收（status≠accepted，无 error 字段）。
      // queueItemId 前端已乐观预置（queue_<commandId> 确定性派生），ack 不再回填
      let failure: string | null = null
      if (msg.accepted === false) {
        diagWarn('steer rejected: status≠accepted')
        failure = i18n.t('input.steer.notAccepted')
      } else if (msg.error) {
        diagWarn(`steer rejected: ${msg.error}`)
        failure = `${i18n.t('input.steer.failedPrefix')}${msg.error}`
      }
      if (failure) {
        const pending = get().steerPending
        const patch: { steerPending: null; lastError: string; queuedMessages?: QueuedMessage[] } = { steerPending: null, lastError: failure }
        if (pending?.restore) {
          const q = [...get().queuedMessages]
          q.splice(Math.min(pending.restore.index, q.length), 0, pending.restore.item)
          patch.queuedMessages = q
        }
        set(patch)
      }
      break
    }

    case 'cancelSteer': {
      // 撤回应答：removed=true → 清 chip + 按 restore 插回队列（非乐观——撤回
      // 失败的真实原因是已注入落位，那时隔着注入气泡插回队列条目是错的）。
      // removed=false = 已落位/已促发（queue.itemMissing）：chip 退出 cancelling
      // 态并横幅提示，落位交给在途的 steerDrained 正常收尾。
      // 竞态守卫（缺陷BQ）：服务端 drain 取出条目后到落位事件发出的窗口内，
      // 删除走 discardHeld 路径照样返回 removed=true，「撤销成功」与「注入发生」
      // 可并存——回插的同时留观察记录，steerDrained 命中同文本时把条目撤下
      const pending = get().steerPending
      if (!pending) break
      if (msg.removed) {
        const patch: Partial<StoreState> = {
          steerPending: null,
          ...(pending.restore
            ? { steerCancelRestore: { itemId: pending.restore.item.id, text: pending.text, at: Date.now() } }
            : {}),
        }
        if (pending.restore) {
          const q = [...get().queuedMessages]
          q.splice(Math.min(pending.restore.index, q.length), 0, pending.restore.item)
          patch.queuedMessages = q
        }
        set(patch)
      } else {
        diagWarn(`steer cancel missed: ${msg.error ?? 'item missing'}`)
        set({ steerPending: { ...pending, cancelling: false }, lastError: i18n.t('input.steer.cancelTooLate') })
      }
      break
    }

    case 'promoteQueuedInput': {
      // 「已发出但被服务端排队」防御的促发应答（缺陷FD）。ok=true：条目已被 runtime
      // 捞出执行（preempt 当前回合 + 以该输入开新轮），气泡等服务端真身同文本顶替，
      // 无需动作。ok=false 按 Java 侧兜底分类：
      //   removed=true  条目已取消 → 句柄回插本地队列队头（保住消息，下一轮末重发）、
      //                 撤下补插气泡（队列卡片接管表现）+ 横幅提示；
      //   removed=false 条目已不存在（已落位/他方促发中）→ 保留气泡等真身，仅提示；
      //   缺省          促发与删除都失败（条目可能残留）→ 提示可手动处置，刻意不自动
      //                 重发（残留条目日后若被排空会成迟到重复）
      const promo = pendingQueuePromotions.get(msg.queueItemId)
      if (!promo) break
      pendingQueuePromotions.delete(msg.queueItemId)
      if (msg.ok) break
      diagWarn(`promoteQueuedInput failed (removed=${msg.removed}): ${msg.error ?? ''}`)
      // 切会话后丢弃：本地队列随会话切换清空（sessionResetBase 语义），
      // 往新会话队列插旧会话消息会把消息发错会话
      if (promo.sid !== get().currentSessionId) break
      if (msg.removed === true) {
        const requeued: QueuedMessage = {
          id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          text: promo.text,
          ...(promo.attachments?.length ? { attachments: promo.attachments } : {}),
          queuedAt: Date.now(),
        }
        const st = get()
        set({
          messages: st.messages.filter((m) => m.info.id !== promo.bubbleId),
          queuedMessages: [requeued, ...st.queuedMessages],
          lastNotice: i18n.t('input.queue.promoteFailedRequeued'),
        })
      } else if (msg.removed === false) {
        set({ lastNotice: i18n.t('input.queue.promoteFailedServerSide') })
      } else {
        set({ lastNotice: i18n.t('input.queue.promoteFailedUnknown') })
      }
      break
    }

    case 'sessionStatsPatch': {
      // 会话统计增量（多目录会话·切目录慢修复）：列表响应不再等 stats（全库直读 3~4s），
      // 后台算完按 sessionId 合并；不在当前列表的条目自然跳过（跨目录切换后）。
      // 归档列表同款合并（归档 tab 的 stats 异步化，2026-10-28）
      const patch = new Map(msg.items.map((it) => [it.sessionId, it]))
      const mergeStats = <T extends { sessionId: string }>(list: T[]) =>
        list.map((s) => {
          const st = patch.get(s.sessionId)
          return st ? { ...s, messageCount: st.messageCount, sizeBytes: st.sizeBytes } : s
        })
      set({
        sessions: mergeStats(get().sessions) as SessionInfo[],
        archivedSessions: mergeStats(get().archivedSessions) as SessionInfo[],
      })
      break
    }

    case 'archivedSessions': {
      // 乱序丢弃守卫（同 listSessions）：晚到的旧目录归档响应不覆盖当前目录列表
      if (
        msg.workspacePath &&
        get().sessionsWorkspace &&
        normalizeWsPath(msg.workspacePath) !== normalizeWsPath(get().sessionsWorkspace)
      ) {
        break
      }
      // 标题合并（persist 手动重命名优先，同 listSessions 逻辑简化版）
      const merged = msg.sessions.map((s) => {
        const stored = getPersisted(`zcode.sessionTitle.${s.sessionId}`)
        return stored ? { ...s, title: stored } : s
      })
      set({ archivedSessions: merged, archivedLoading: false })
      break
    }

    case 'messages': {
      // 发送落位凭据扫描（缺陷FF）：任何 messages 应答先扫一遍（reconcile/常规/
      // 快照均权威）——落位即认领；探测中的凭据未命中即收尾退回（探测应答回来
      // 走的就是这里；20s 无应答由 ticker 按 unresponsive 收尾）
      claimAdmissionsFromMessages(msg.sessionId, msg.messages)
      // 对账探测响应（看门狗只读快照）：不直接落地，先判定回合是否已在服务端结束。
      // 误判风险低——能走到这里说明已静默 60s+：末尾若有完整 assistant 回复，要么
      // 回合真结束了，要么 send 从未被服务端受理（两种情况收尾都是正确行为）
      if (msg.reconcile) {
        reconcileProbeInFlight = false
        if (msg.sessionId === get().currentSessionId && get().streaming) {
          // serverActiveTurnId 由 5s usage 轮询维护：服务端回合活跃（后台任务等待/
          // 长工具执行）时豁免判死；真断流（app-server 死/回合结束）时信号消失
          const verdict = classifyReconcileSnapshot(msg.messages, serverActiveTurnId !== null)
          if (verdict !== 'progress') {
            cancelSwitchStallHint()
            set({ streaming: false, streamingMessageId: null, waitingSince: null, compacting: false, backgroundTasks: {} })
            if (verdict === 'dead') {
              console.warn('[store] 流式对账：长时间无事件且服务端无进展，判定流丢失并收尾')
              set({ lastError: i18n.t('app.streamLost') })
            } else {
              console.log('[store] 流式对账：服务端回合已完成，落地快照收尾')
            }
            applyMessagesSnapshot(msg, set, get)
            // 回合结束的常规善后（对齐 turnEnded 路径的轻量子集：标题刷新 + 队列）
            get().loadSessions()
            get().flushQueue()
          }
        }
        break
      }
      // 目标模式轮边界定向刷新（scheduleGoalRefresh 触发）：streaming 中不丢弃
      //（续轮窗口，常规重拉守卫会丢——校验分隔卡滞后的根因），增量合并；非
      // streaming 走权威全量落地（终态/cleared 后回合已静）
      if (msg.goalRefresh) {
        if (msg.sessionId === get().currentSessionId) {
          if (get().streaming) {
            mergeGoalRefreshSnapshot(msg, set, get)
          } else {
            applyMessagesSnapshot(msg, set, get)
          }
        }
        break
      }
      if (msg.sessionId === get().currentSessionId) {
        // 快照响应到达（无论落地还是被守卫丢弃）：压缩延迟 flush 的在途标记解除
        compactSnapshotInFlightAt = 0
        // 流式进行中到达的重拉响应 = 可能是过期快照：turn 结束触发的 300ms 延迟
        // 重拉，会落后于排队消息自动发出后已开启的新 turn（idea.log 2026-08-15 时序
        // 证据：completed → flushQueue 发送 → 新 turn.started → 旧重拉才 resume/返回）。
        // 全量替换会抹掉流式中的 assistant 消息（断流），且 turn.started 借用的
        // messageId 与重拉后服务端 user 消息撞车时，AI delta 会叠进用户气泡（叠字）
        // ——这些仍然不能整包落地。但通知合成消息（task-notification /
        // subagent-message）只随快照到达，整丢会让卡片滞后到轮末（缺陷CI）：改为
        // 只摘新增通知卡插到流式气泡之前，其余内容仍等轮末权威落地——过期快照
        // 的既有消息同 id 去重不插入，不会把历史改写冲进流式。
        // 豁免：loadingMessages=true（打开会话的首拉在途）时必须放行——重开运行中
        // 会话时相位投影先于首拉应答把 streaming 置 true，守卫若照丢首拉永不落地
        // （「加载消息中」卡到回合结束才被轮末重拉解围，2026-09-29 真机实锤）；
        // 首拉场景气泡区为空，没有流式内容可抹，落地无断流/叠字风险。
        if (get().streaming && !get().loadingMessages) {
          mergeNotificationsMidTurn(msg, set, get)
          break
        }
        // 打开会话的首拉标志（selectSession 置位、下方快照落地复位）：P2 补发依据
        const firstFetch = get().loadingMessages
        applyMessagesSnapshot(msg, set, get)
        // 编辑重放的正路径（仅 legacy 通道）：rewind turn 结束触发的重拉已落地
        // （applyRewindCuts 已截断），此刻 streaming=false，重发编辑文本开启新生成轮。
        // v4 通道的重发由服务端完成（editReplay 已在 turnEnded 清理），不能重发
        const replay = get().editReplay
        if (replay?.rewound && replay.via === 'legacy') {
          set({ editReplay: null })
          get().sendMessage(replay.text)
        }
        // P2 让路（缺陷AB 编排②）：首拉落地（P0 完成）后补发用量/子代理——不与
        // subscribe/messages 并发挤服务端会话队列；历史会话底部栏数据同样补齐
        if (firstFetch) {
          get().loadSubagents()
          get().loadUsage()
          // 逐轮更改条重扫（B2）不在此发：messages 与 subscribe 两 op 在 Java 线程池
          // 并发执行，此刻 subscribedSessions.add 可能未落位——重扫事件会被
          // pushStreamEvent 的多标签闸门静默丢弃（历史会话不显示的根因，2026-10-01
          // 实证：重扫 count=3 正常但界面无数据）。改由 case 'subscribed' 触发
        }
        // 压缩回合结束后延迟的队列 flush 在此触发：摘要卡已随快照落地，排队消息
        // 再发出的新 turn 不会丢它（scheduleDeferredCompactFlush 的正路径）
        tryRunDeferredCompactFlush(msg.sessionId)
      }
      break
    }

    case 'subagents': {
      // session/subagents RPC 权威列表：刷新 agents 合并结果；
      // 详情弹窗若开着且此前没有 childSessionId，现在补拉完整过程。
      // 失败不弹全局错误（底部栏还有解析兜底数据），静默保留旧值
      const st = get()
      if (msg.sessionId !== st.currentSessionId) break
      if (msg.error) break
      const items = [...msg.data.running, ...msg.data.ended.items]
      // RPC 报告已结束的子代理 → 活动同步收尾（底部栏 agents 由 merge 覆盖，
      // 活动本身也须收尾：否则权威轮询（见 ensureSubagentStatusPolling）
      // 因 running 活动常驻而永不停止，且 turnEnded 前三源状态不一致）
      let activities = st.subagentActivities
      for (const it of items) {
        const s = String(it.status ?? '').toLowerCase()
        if (!it.toolCallId || s === '' || s === 'running' || s === 'pending') continue
        // 失败判定白名单化（2026-09-01 缺陷AO 追查）：未知 status 词只当"未识别"跳过，
        // 不再有破坏性效果——此前"非成功白名单即失败"会把服务端新词（如 stopped/done）
        // 误读成失败并锁死活动（markActivityOutcome 只翻 running，error 定格）
        const failed = SUBAGENT_FAILURE_STATUSES.includes(s)
        if (failed) diagWarn(`[subagent-mark-failed] src=rpc key=${it.toolCallId} status=${s}`)
        activities = markActivityOutcome(activities, it.toolCallId, failed, Date.now())
      }
      set({
        subagents: items,
        ...(activities !== st.subagentActivities ? { subagentActivities: activities } : {}),
        agents: mergeAgentItems(parseAgents(st.messages), activities, items),
      })
      const detail = st.subagentDetail
      if (detail) {
        const info = items.find((s) => s.toolCallId === detail)
        if (info && !st.childMessages[info.childSessionId] && info.status !== 'running') {
          get().loadChildMessages(info.childSessionId)
        }
      }
      break
    }

    case 'subagentMessages': {
      // 子会话完整消息（详情弹窗"原始过程"）：失败就地提示，不污染全局错误栏。
      // silent（运行中 3s 轮询）不置 error——偶发失败下次轮询自然重试
      const silent = silentChildFetches.delete(msg.sessionId)
      if (msg.error) {
        set({
          childMessagesLoading: false,
          ...(silent ? {} : { childMessagesError: msg.error }),
        })
        break
      }
      const st = get()
      set({
        // 同轮 step 合并同主会话（子会话重拉同样按 step 拆分存储）
        childMessages: { ...st.childMessages, [msg.sessionId]: mergeTurnMessages(msg.messages) },
        childMessagesLoading: false,
        childMessagesError: null,
      })
      break
    }

    case 'sendAccepted':
      // 发送被接受，等待流式事件（turn.started 即将到来）
      // CLI fallback 模式（带 cliResponse）：直接重新拉消息，并串行发送队列下一条
      if ('cliResponse' in msg && msg.cliResponse) {
        set({ streaming: false, waitingSince: null, compacting: false, backgroundTasks: {} })
        const sid = get().currentSessionId
        if (sid) {
          setTimeout(() => {
            sendToJava({ op: 'messages', sessionId: sid, workspacePath: get().currentWorkspacePath })
          }, 1500)
        }
        get().flushQueue()
      }
      break

    case 'subscribed': {
      // 驻留水位提醒（缺陷BA）：Java 账本预计打开该会话后越过服务端驻留阈值。
      // 同水位 Java 侧只带一次标志，前端置位后由 toast 自动消失/手动关闭清除
      if (msg.residentPoolWarning && !get().residentPoolNotice) {
        set({ residentPoolNotice: i18n.t('app.residentPoolWarning') })
      }
      // 逐轮更改条重扫（B2）：订阅落定（Java subscribedSessions.add 已完成）后触发，
      // 重扫事件过 pushStreamEvent 闸门才有保障——messages 首拉触发会与 subscribe
      // 并发赛跑（2026-10-01 历史会话不显示的根因）。幂等：重扫数据同源覆盖
      if (msg.sessionId === get().currentSessionId) {
        sendToJava({ op: 'turnFileChangesSync', sessionId: msg.sessionId })
      }
      // 待命态目标补发（订阅已生效，goal 控制轮事件从第一条起可达——时序背景见
      // case 'createSession' 的 pendingGoal 注释；2.5s 兜底定时器与本处幂等竞速）
      const pendingGoal = get().pendingGoalCreation
      if (pendingGoal && msg.sessionId === get().currentSessionId) {
        set({ pendingGoalCreation: null })
        get().goalManage('set', pendingGoal.objective)
      }
      // selectSession 挂起的模型记忆恢复在此消费（订阅落定=resume 完成、服务端会话
      // 队列已消化，setModel 不再与 resume/messages 抢单线程——十五轮错峰）
      const pendingApply = pendingModelApplyAfterSubscribe.get(msg.sessionId)
      if (pendingApply) {
        cancelPendingModelApply(msg.sessionId)
        if (get().currentSessionId === msg.sessionId) get().applyModelIfReady(msg.sessionId, pendingApply.newSession)
      }
      break
    }
    case 'subscribedChild': // 子会话订阅 ack：记录 v4 通道可用性（弹窗据此停用快照轮询）
      if (typeof msg.v4 === 'boolean' && msg.sessionId) {
        set({ childSessionV4: { ...get().childSessionV4, [msg.sessionId]: msg.v4 } })
      }
      break

    case 'unsubscribedChild': // 终点退订 ack：清 v4 通道标志（防 stale 标志让三态守卫误判在场）
      if (msg.sessionId && msg.sessionId in get().childSessionV4) {
        const next = { ...get().childSessionV4 }
        delete next[msg.sessionId]
        set({ childSessionV4: next })
      }
      break

    case 'stopped':
      // 停止应答：立即复位等待态，不等终止帧（缺陷AD重审：V4 stop 流式期引擎不发
      // legacy 终止帧，面板合成帧/真实帧后到均幂等）。刻意不 flushQueue：停止意图=只收当前回合
      if (msg.sessionId === get().currentSessionId) {
        cancelSwitchStallHint()
        set({ streaming: false, streamingMessageId: null, waitingSince: null, compacting: false })
      }
      break

    case 'newSession':
      // Java 端自动新建会话（老会话模型不可用），切换到新会话
      console.log(`[store] 切换到新会话: ${msg.sessionId}`)
      // 队列中定时来源的消息回退挂起到旧会话（不随队列丢弃）
      get().requeueScheduledQueuesFor(get().currentSessionId)
      set({
        currentSessionId: msg.sessionId,
        ...sessionResetBase(), // 新会话无历史消息
        // Java 自动切换后同样解除可能在途的首拉标志（缺陷FH 同族）
        loadingMessages: false,
        thoughtLevel: null,
        currentMode: null,
        subagentReport: null,
        markdownPreview: null,
        askUserReview: null,
      })
      // 刷新会话列表（新会话会出现在列表里）
      get().loadSessions()
      // 拉取新会话运行时设置
      get().loadSettings()
      break

    case 'envStatus':
      // checkEnv 查询 / envSave 保存成功重检的返回
      set({ envStatus: msg.status, envSaving: false })
      break

    case 'proxyConfig':
      // getProxyConfig 查询返回（进设置页环境 tab 拉取）
      set({
        proxyConfig: {
          httpProxy: msg.httpProxy ?? '',
          noProxy: msg.noProxy ?? '',
          caCertPath: msg.caCertPath ?? '',
          restartPending: !!msg.restartPending,
        },
      })
      break

    case 'proxyConfigSaved': {
      // setProxyConfig 成功：更新回显 + 复位转圈；app-server 在跑则保留重启提示
      const saved = {
        httpProxy: msg.httpProxy ?? '',
        noProxy: msg.noProxy ?? '',
        caCertPath: msg.caCertPath ?? '',
        restartPending: !!msg.restartPending,
      }
      set({ proxyConfig: saved, proxySaving: false })
      break
    }

    case 'appServerRestarted':
      // restartAppServer 完成：下次请求懒重建（新 env 生效），重启提示解除
      if (get().proxyConfig) set({ proxyConfig: { ...get().proxyConfig!, restartPending: false } })
      break

    case 'error': {
      // 发送落位快路（缺陷FF）：sourceOp=send 的显式失败（10s 请求超时/管道断/
      // 恢复重试仍败）——对应凭据秒级收尾退回队列，不让乐观气泡悬死；sessionId
      // 由 Kotlin 携带（缺省回退当前会话最新一条在途凭据）
      const sendSourced = msg.sourceOp === 'send'
      if (sendSourced) {
        const errSid = msg.sessionId ?? get().currentSessionId
        let newestId: string | null = null
        for (const [id, e] of pendingAdmissions) {
          if (e.sid !== errSid) continue
          newestId = id // Map 迭代按插入序，最后一条即最新
        }
        if (newestId) failAdmission(newestId, 'sendError', msg.message)
      }
      // 建会话失败（Java 外层 catch 回 error）：复位懒创建标志与暂存消息（防卡死、防误重试）
      // -32004（Session is not active）追加人话提示：CLI 升级/重启后的新进程里会话
      // 未激活，此前用户只看到协议原文不知道该怎么办（2026-08-19 升级中断实测）
      // -32004 家族（缺陷BA）："Session is not active"（既有会话被 LRU 踢出驻留）与
      // "Session not found"（新建会话撞槽位满被整体挤出、尚不可 resume）同因不同文，
      // 按错误码/两种文案匹配，统一追加槽位指引
      // 模型切换来源的 -32004 不套槽位文案：Java 侧 handleSetModel 已带 resume 自愈，
      // 走到这里说明自愈后仍失败，多半是启动恢复竞态残留而非槽位满——引导重开会话后重切
      const modelSwitchInactive =
        /^Model switch failed:/.test(msg.message) && /-32004|Session is not active|Session not found/i.test(msg.message)
      const sessionInactive =
        !modelSwitchInactive && /-32004|Session is not active|Session not found/i.test(msg.message)
      // -32010（A prompt is already running）：服务端回合悬挂，Java 已自动 stop+重发，
      // 走到前端说明自愈失败——提示可操作文案；且跳过 flushQueue（服务端 prompt 状态
      // 未清前队列下一条大概率再撞，会连环报错，2026-08-20 实测）
      const promptRunning = /-32010|prompt is already running/i.test(msg.message)
      // 会话级请求超时（缺陷AB 忙窗口）：resume 恢复带中断回合的会话时，app-server 对
      // 该会话的既有请求全部排队约 1~2 分钟后自愈；Java 侧已对 subscribe/setModel/settings
      // 延迟自动重试。追加指引防用户"一看报错就重启"（重启重新 resume 重新进窗口，
      // 永远观察不到自愈——2026-08-27 用户 b5756ab4 四轮重启全超时、放置 100s 自愈实测）。
      // 方法白名单而非 session/* 通配：session/create 等新建/全库路径与忙窗口无关
      // （issue #11 崩溃循环场景的 create 超时被误套"请勿重启"指引，恰是反向指导）
      const resumeBusy = /请求超时: session\/(subscribe|setModel|read|messages|subagents) \(/.test(msg.message)
      // 浏览器数据操作在途时一并取消其兜底定时器，防后续误报超时
      if (get().browserBusy) Array.from(browserBusyTimers.keys()).forEach(cancelBrowserBusyTimer)
      set({
        // 人话指引放句首、协议原文挪进括号（缺陷BA）：错误条空间有限，指引垫在
        // 句尾会被截断——用户先看到"怎么办"，原文只作存证
        lastError: modelSwitchInactive
          ? `${i18n.t('app.modelSwitchInactiveHint')}（${msg.message}）`
          : sessionInactive
            ? `${i18n.t('app.sessionInactiveHint')}（${msg.message}）`
            : promptRunning
              ? `${i18n.t('app.promptRunningHint')}（${msg.message}）`
              : resumeBusy
                ? `${i18n.t('app.resumeBusyHint')}（${msg.message}）`
                : msg.message,
        // 环境前置检查失败（EnvCheckException/envSave 验证失败）：附带 envStatus 刷新提醒条
        ...(msg.envStatus ? { envStatus: msg.envStatus } : {}),
        envSaving: false,
        proxySaving: false,
        loadingMessages: false,
        streaming: false,
        waitingSince: null,
        compacting: false,
        backgroundTasks: {},
        memoryLoading: false,
        memoryCreatingPath: null,
        memoryToggling: false,
        skillsLoading: false,
        skillTogglingPath: null,
        mcpLoading: false,
        mcpChecking: false,
        mcpLogsLoading: false,
        trajectoryLoading: false,
        modelManageLoading: false,
        modelTogglingId: null,
        modelTogglingKey: null,
        forkBusy: false,
        // 浏览器设置请求失败（如插件未安装）：页面内联提示（browserBusy 在途时才归属该页）
        ...(get().browserBusy ? { browserBusy: null, browserError: msg.message } : {}),
        ...(get().creatingSession ? { creatingSession: false, pendingFirstMessage: null, pendingFirstAttachments: null, pendingFirstScheduledFireAt: null, pendingScheduleCreation: null, pendingGoalCreation: null } : {}),
      })
      console.error('[store] Java 错误:', msg.message)
      // 错误清 streaming 后继续发队列下一条（排队意图明确；持续失败时用户可删队列项）；
      // -32010 例外：悬挂回合未清，队列再发必再撞；send 来源同样例外（缺陷FF）——
      // app-server 僵死/断管时续灌只会把下一条也丢进死管道（10-19 实测 88 连发），
      // 失败条目已退回队列，由用户处置后重发
      if (!promptRunning && !sendSourced) get().flushQueue()
      break
    }

    case 'usageError': {
      // P2 用量查询失败静默（缺陷AB 编排②）：不写 lastError、不复位 streaming——
      // 用量有流式轮询/回合结束刷新自愈；Java 端已不再走 errorResponse
      console.warn('[store] usage query failed:', msg.message)
      break
    }

    case 'busyRetryRecovered': {
      // Java 忙窗口重试成功（缺陷AB）：顶栏还挂着忙窗口提示时清除（只清本类提示，
      // 其他错误不受影响；提示串里含 i18n key 的完整文案，按其子串识别）
      const hint = i18n.t('app.resumeBusyHint')
      if (get().lastError?.includes(hint)) set({ lastError: null })
      break
    }

    case 'backendError': {
      // app-server stderr 兜底通道：模型 API 错误（429 配额超限等）在 turn 终止帧之外
      // 到达（服务端按可重试分类持续退避，事件流上无迹象）——只提示，
      // 不复位 streaming（turn 可能仍在服务端重试，由终止帧收尾）
      set({ lastError: formatBackendError(msg.statusCode, msg.code, msg.message) })
      // 会话额度横幅：分类命中且当前模型属 bigmodel 系时同步点亮（展示视图由
      // useQuotaBanner 与额度数据派生；同源去重键防重复打扰）
      const banner = quotaBannerTriggerFrom(get().currentModel?.providerId, msg.code, msg.message, msg.statusCode)
      if (banner) set({ quotaBannerError: banner })
      break
    }

    case 'askUser':
      // AskUserQuestion 弹窗（服务器反向请求 interaction/requestUserInput）
      console.log('[store] 收到 askUser:', msg.toolName, msg.questions)
      set({ askUser: { requestId: msg.requestId, toolName: msg.toolName, questions: msg.questions, deadlineMs: msg.deadlineMs, askedAt: Date.now() }, askUserPendingActive: true })
      break

    case 'exitPlanApproval':
      // ExitPlanMode 计划审批面板：无超时等待（0.3.7 起），askedAt 供「已等待」正计时
      console.log('[store] 收到 exitPlanApproval，plan 长度:', msg.plan?.length ?? 0)
      set({ exitPlanApproval: { requestId: msg.requestId, plan: msg.plan || '', deadlineMs: msg.deadlineMs, askedAt: Date.now() }, askUserPendingActive: true })
      break

    case 'permissionRequest':
      // 工具权限审批弹窗（「变更前询问」模式）：用户选项 optionId 经 askUserResponse 回传
      console.log('[store] 收到 permissionRequest:', msg.toolName, 'options:', msg.options?.length)
      set({
        permissionRequest: {
          requestId: msg.requestId,
          toolName: msg.toolName,
          reason: msg.reason || '',
          options: msg.options || [],
          input: msg.input,
          riskLevel: msg.riskLevel,
          deadlineMs: msg.deadlineMs,
        },
        askUserPendingActive: true,
      })
      break

    case 'permissionRequestRefresh': {
      // 服务端同族重发换新 id 时保活弹窗：只更新当前权限弹窗的 requestId（点击应答
      // 永远命中服务端在等的 id），不重建弹窗不重置倒计时。非权限弹窗/无弹窗时忽略
      const cur = get().permissionRequest
      if (cur && cur.requestId !== msg.requestId) {
        set({ permissionRequest: { ...cur, requestId: msg.requestId } })
      }
      break
    }

    case 'askUserPending':
      // Java 广播的反向请求挂起标志（多标签同会话：无弹窗的面板靠它豁免看门狗）。
      // 只维护标志，不动弹窗状态（弹窗由 askUserAck / 组件 onClose 关闭）
      set({ askUserPendingActive: msg.active })
      break

    case 'askUserAck': {
      // Java 确认某请求已终结（用户已应答/超时 deny/回合终止废弃），关闭对应弹窗。
      // 必须按 requestId 精确匹配：服务端重发会在插件侧留下 staggered 的 5 分钟超时
      // 线程，旧线程超时的 ack 若无差别关窗，会把面板上其他请求仍挂着的弹窗顶掉
      // （2026-08-27 实测真凶）。无 requestId 的 ack（兼容旧格式）才全清
      const rid = msg.requestId
      const st = get()
      const nextAskUser = !rid || st.askUser?.requestId === rid ? null : st.askUser
      const nextPlan = !rid || st.exitPlanApproval?.requestId === rid ? null : st.exitPlanApproval
      const nextPerm = !rid || st.permissionRequest?.requestId === rid ? null : st.permissionRequest
      // 挂起标志仅在没有任何弹窗残留时才复位（看门狗豁免语义，多弹窗并存防提前清零）
      set({
        askUser: nextAskUser,
        exitPlanApproval: nextPlan,
        permissionRequest: nextPerm,
        askUserPendingActive: nextAskUser || nextPlan || nextPerm ? st.askUserPendingActive : false,
      })
      break
    }

    case 'remoteState':
      // 手机远程状态（连接中/等待扫码/已配对/异常；广播与响应同构体）
      set({
        remoteState: msg.state,
        remoteQrUrl: msg.qrUrl ?? null,
        remoteDeviceName: msg.deviceName ?? null,
        remoteError: msg.error ?? null,
      })
      break

    case 'ideTheme':
    case 'files':
      break

    case 'models':
      // modelsRefreshing 与 models 同帧复位（手动刷新的转圈标记，见 refreshModels）
      set({
        models: msg.models,
        modelsRefreshing: false,
        billingKeySource: msg.billingKeySource ?? null,
        teamPlanNoOverride: msg.teamPlanNoOverride ?? false,
      })
      // 模型清单变更后（设置页禁用 provider / Zcode 侧增删模型），已选模型若已不在
      // 列表 → 取消选择，下拉回占位提示让用户重新选；persist 记忆一并清除（防下次水合复活）。
      // modelInvalidated 同时置位：挡住下方 inferCurrentModel——它按消息 footer 的模型名
      // 反查第一个同 modelId 的 provider，会把"体验套餐 GLM-5.3"复活成"个人套餐 GLM-5.3"
      {
        const cur = get().currentModel
        if (cur && !msg.models.some((m) => sameModel(m, cur))) {
          // 全局默认若同样指向失效模型 → 兜底回写而非删除：删除会让待命态（新建标签）
          // 失去默认、选择器空占位（真机二轮反馈根因——invalidation 清空显示后恢复块
          // 无全局可恢复）；列表为空才回退删除。待命态显示由紧随的恢复块用回写值填回
          let savedG: { modelId: string; providerId: string } | null = null
          try {
            const raw = getPersisted('zcode.currentModel')
            if (raw) savedG = JSON.parse(raw)
          } catch { /* ignore */ }
          const globalInvalid = !savedG
            || !msg.models.some((m) => sameModel(m, savedG))
          if (globalInvalid) {
            const gfb = msg.models.find((m) => m.plan === 'personal' || m.plan === 'team') ?? msg.models[0]
            if (gfb) setPersisted('zcode.currentModel', JSON.stringify({ modelId: gfb.modelId, providerId: gfb.providerId }))
            else removePersisted('zcode.currentModel')
          }
          // 当前会话的会话级记忆一并清除（缺陷BI 后重启恢复按它重放，失效模型不能复活）
          if (get().currentSessionId) forgetSessionModel(get().currentSessionId!)
          // 兜底选中而非清空等重选：assistant 消息 info 的 providerID/modelID 是服务端
          // 权威（Zcode 侧禁用 qwen 后服务端回退 GLM，新一轮回复的 info 即真实在用
          // 模型）——推断得出且仍在列表则直接选上（下拉有勾选），推不出才保持空占位。
          // persist 不写回：兜底是运行态显示，用户主动选择才记忆。
          const inferred = inferCurrentModel(get().messages, msg.models)
          // 同名跨渠道迁移：推断的 provider 已不在列表（客户端切换 API Key 渠道 ↔
          // 订阅套餐，模型名相同）时，按 modelId 迁移到新渠道的同名模型落位，随后的
          // setModel 落定让 settings 链路重建思考深度——否则下拉空占位、思考深度
          // 消失，须手动重选（0.2.6 渠道切换实测反馈）
          const hit = inferred
            ? msg.models.find((m) => sameModel(m, inferred)) ?? msg.models.find((m) => m.modelId === inferred.modelId)
            : undefined
          const valid = hit ? { modelId: hit.modelId, providerId: hit.providerId } : null
          // 思考深度联动失效：级别集按模型而异（off/high/max ↔ enabled/off），旧模型的
          // info 残留会让选择器在兜底模型上展示/下发非法级别（-32603）。清掉后待命态走
          // 下方 hydrateThoughtLevelStandby、有会话由 setModel 切换落定后的 settings
          // 权威重建。zcode.thoughtLevel 记忆值保留（applyThoughtLevelIfReady 有"不在
          // available 不下发"守卫，切回支持的模型可恢复）
          set({ currentModel: valid, modelInvalidated: true, thoughtLevel: null, thoughtLevelAppliedForSession: null })
          // 有会话时补齐显式切换（同用户手动重选的完整链路）：服务端会话的 settings
          // （含思考级别集）仍计算于旧模型——Zcode 侧禁用只回退运行时模型、配置未切，
          // 此时补拉 settings 会把旧模型档位（如 qwen 的思考/不思考）写进显示并污染
          // 按模型缓存（实测踩坑）。必须下发 setModel：modelSet 落定后 500ms 的
          // loadSettings 才返回新模型的权威级别集
          const sid = get().currentSessionId
          if (valid && sid) {
            set({ modelSwitchInFlightAt: Date.now() })
            sendToJava({
              op: 'setModel',
              sessionId: sid,
              modelId: valid.modelId,
              providerId: valid.providerId,
            })
          }
        }
      }
      // 恢复记忆的模型选择。仅待命态与新建会话用全局默认做显示——存量会话切入时
      // currentModel 为空（无会话级记忆，等消息推断），拿全局默认显示会把别的会话
      // 选过的模型顶进当前会话（缺陷BI 显示面）。
      // 全局默认缺失（失效清除回写失败/全新安装）或已不在清单（provider 被禁/配置已删）：
      // 兜底生效套餐首选、其次列表首个并回写——待命态选择器不空占位（"新建标签模型
      // 是空的需手动选"反馈，与 applyModelIfReady 新会话兜底同语义；失效清除把待命态
      // 显示清空的场景也由此填回）
      try {
        const saved = getPersisted('zcode.currentModel')
        const curSid = get().currentSessionId
        const mayUseGlobal = !curSid || get().createdSessionIds.has(curSid)
        if (get().currentModel === null && mayUseGlobal) {
          const parsed = saved ? (JSON.parse(saved) as { modelId: string; providerId: string }) : null
          const hit = parsed
            ? msg.models.find((m) => sameModel(m, parsed))
            : undefined
          if (parsed && hit) {
            set({ currentModel: parsed })
          } else {
            const fb = hit ?? msg.models.find((m) => m.plan === 'personal' || m.plan === 'team') ?? msg.models[0]
            if (fb) {
              const fallback = { modelId: fb.modelId, providerId: fb.providerId }
              setPersisted('zcode.currentModel', JSON.stringify(fallback))
              set({ currentModel: fallback })
            }
          }
        }
      } catch { /* ignore */ }
      // persist 无记忆时，从已有消息推断（models 刚加载，messages 推断可能因缺 providerId 失败）；
      // 失效清除过的选择不再推断（等用户重选）
      if (!get().modelInvalidated && !get().currentModel) {
        const inferred = inferCurrentModel(get().messages, msg.models)
        if (inferred) set({ currentModel: inferred })
      }
      // models 就绪后，若当前会话还没下发过 setModel → 真正下发（修复"选 deepseek 实际 GLM5"）。
      // 已挂 subscribed 错峰的会话不在此直发（挂起表消费时统一走，防回执前双发）
      {
        const sid = get().currentSessionId
        if (sid && !pendingModelApplyAfterSubscribe.has(sid)) get().applyModelIfReady(sid)
      }
      // 待命态：currentModel 刚水合，按它恢复缓存的级别集（ThoughtLevelSelect 预选显示）
      get().hydrateThoughtLevelStandby()
      break

    case 'modelSet': {
      // 切换落定即回执（缺陷BO）：此后 applyModelIfReady 不再重放该会话。须在下方
      // 会话守卫之前——其他会话的落定同样要记，守卫只管显示面
      if (msg.sessionId) {
        const ackNext = new Set(get().modelAckSessions)
        ackNext.add(msg.sessionId)
        set({ modelAckSessions: ackNext })
      }
      // 延迟切换的补发可能晚到数分钟（挂起期间用户已切走会话）：目标会话不是当前
      // 会话时丢弃，避免旧会话的模型翻转污染当前会话显示与级别缓存
      if (msg.sessionId && msg.sessionId !== get().currentSessionId) break
      lastModelSetAckAt = Date.now() // 切换后首回合零输出提示的时间基准
      // 切换前模型（合成 model_change 分隔卡用，须在下方 set 覆盖 currentModel 前捕获；
      // 即时路径=setModel 下发时暂存的 prev，延迟路径=modelSetPending 回滚后的现值）
      const prevModelForMarker = get().modelSwitchPrevModel ?? get().currentModel
      // 合成卡构造（三处共用：折叠换卡/普通插卡/流式窗口插卡）。from 形状对齐
      // timeline part 的 fromModel（字段全可选：anchor 来自旧卡 part，modelId 可能缺）
      const sidForCard = msg.sessionId ?? get().currentSessionId ?? ''
      const makeSwitchCard = (
        from: { modelID?: string; modelId?: string; label?: string; providerID?: string } | null,
        to: { modelId: string; providerId: string },
      ): ZCodeMessage => ({
        info: {
          role: 'assistant',
          id: `synthetic-model-change-${Date.now()}`,
          sessionID: sidForCard,
          time: { created: Date.now() },
        },
        parts: [{
          type: 'timeline',
          timelineType: 'model_change',
          ...(from
            ? { fromModel: { modelID: from.modelID, modelId: from.modelId, label: from.label ?? from.modelId ?? from.modelID, providerID: from.providerID } }
            : {}),
          toModel: { modelId: to.modelId, label: to.modelId, providerID: to.providerId },
        }],
      })
      set({
        currentModel: { modelId: msg.modelId, providerId: msg.providerId },
        modelInvalidated: false,
        modelSwitchInFlightAt: null, // 切换已落定，新到达的 settings 可信
        modelPendingSwitch: null, // 延迟切换落定（缺陷AC），清提示与回滚暂存
        modelSwitchPrevModel: null,
        lastNotice: null,
        // 模型切换分隔卡（2026-09-02 实测：服务端 marker 在下一次 send 才落库、
        // 不走流式事件推送）——切换成功瞬间本地合成一条即时反馈；插入点=消息流
        // 尾部，与服务端将来落库位置一致（切换后第一条新消息之前）。延迟切换路径
        // 合成卡插入后紧跟回合结束重拉，而快照里还没有 marker——整包替换会顶掉
        // 合成卡，靠 syntheticModelChanges 暂存在重拉落地时补挂（applyMessagesSnapshot）
        // 流式中到达的延迟补发：尾部是本轮乐观 user 消息（排队 flush / 用户连发场景，
        // sendMessage 的乐观转圈在补发 RPC 往返期间就置了 streaming，2026-09-14 排队
        // 消息实测主路径）→ 插到它前面，与服务端落库位置（本轮新消息之前）一致；
        // 其余流式形态（流式壳已建，补发晚于 turn.started）维持跳过——插入位置无法
        // 对齐，服务端真身由回合结束重拉显示。
        // 连续切换折叠：消息流末尾仍是未被服务端真身接管的合成卡（两次切换之间
        // 没发过消息）→ 本次切换顶掉旧卡、from 锚定链条起点模型；切回起点
        // （净变化为零）→ 卡整体隐藏
        ...(get().streaming
          ? (() => {
              const sid = sidForCard
              const msgs = get().messages
              const last = msgs[msgs.length - 1]
              if (!last || last.info.role !== 'user' || !String(last.info.id ?? '').startsWith('local_u_')) return {}
              // 净零（初始注册/切回现值）不插卡，判定同非流式路径
              if (!prevModelForMarker || sameModel(prevModelForMarker, msg)) return {}
              const card = makeSwitchCard(
                { modelId: prevModelForMarker.modelId, providerID: prevModelForMarker.providerId },
                { modelId: msg.modelId, providerId: msg.providerId },
              )
              return {
                messages: [...msgs.slice(0, -1), card, last],
                syntheticModelChanges: {
                  ...get().syntheticModelChanges,
                  [sid]: [...(get().syntheticModelChanges[sid] ?? []), card],
                },
              }
            })()
          : (() => {
              const sid = msg.sessionId ?? get().currentSessionId ?? ''
              const pending = get().syntheticModelChanges[sid] ?? []
              const msgs = get().messages
              const lastId = msgs.length ? String(msgs[msgs.length - 1].info.id ?? '') : ''
              const lastCardIdx = lastId.startsWith('synthetic-model-change-')
                ? pending.findIndex((c) => String(c.info.id ?? '') === lastId)
                : -1
              if (lastCardIdx >= 0) {
                const anchor = pending[lastCardIdx].parts.find((p) => p.type === 'timeline')?.fromModel
                const rest = pending.filter((_, i) => i !== lastCardIdx)
                // 净零判定含供应商维度：同名模型跨供应商切回（A@p1 → A@p2 → A@p1 中
                // 的最后一步）才是真回起点；同名不同供应商（A@p1 → A@p2）是真切换不折叠
                if (anchor && sameModel(anchor, msg)) {
                  return {
                    messages: msgs.slice(0, -1),
                    syntheticModelChanges: { ...get().syntheticModelChanges, [sid]: rest },
                  }
                }
                const card = makeSwitchCard(anchor ?? null, { modelId: msg.modelId, providerId: msg.providerId })
                return {
                  messages: [...msgs.slice(0, -1), card],
                  syntheticModelChanges: { ...get().syntheticModelChanges, [sid]: [...rest, card] },
                }
              }
              // 初始注册不合成：插件建会话/切会话时 applyModelIfReady 自动下发的
              // setModel（currentModel 已先被置为目标 → prev==to，如 A→A）与服务端
              // 落库的无 fromModel marker 同源，都非真实切换，无信息量不插卡。
              // 判定含供应商维度：同名模型不同供应商（如内置套餐 → 自定义渠道同名
              // 模型）是真实切换，须插卡
              if (!prevModelForMarker || sameModel(prevModelForMarker, msg)) return {}
              const card = makeSwitchCard(
                { modelId: prevModelForMarker.modelId, providerID: prevModelForMarker.providerId },
                { modelId: msg.modelId, providerId: msg.providerId },
              )
              return {
                messages: [...msgs, card],
                syntheticModelChanges: {
                  ...get().syntheticModelChanges,
                  [sid]: [...pending, card],
                },
              }
            })()),
      })
      // 切换模型后立即刷新用量，圆环 size 随新模型窗口更新（不用等下次对话结束）
      setTimeout(() => get().loadUsage(), 500)
      // 级别集随模型变化（off/high/max ↔ enabled/off），重拉 settings（current 由服务端校准）；
      // 该响应还会消费下方暂存的级别（权威校验，见 case 'settings'）
      setTimeout(() => get().loadSettings(), 500)
      break
    }

    case 'modelSetPending': {
      // 挂起也是回执（缺陷BO）：Java 已接管回合结束补发，applyModelIfReady 重放属
      // 重复（回合中还会再挂起一次产生幽灵横幅）。须在会话守卫之前记，理由同 modelSet
      if (msg.sessionId) {
        const ackNext = new Set(get().modelAckSessions)
        ackNext.add(msg.sessionId)
        set({ modelAckSessions: ackNext })
      }
      // 会话守卫（缺陷BI）：别的会话的挂起不应污染当前会话——挂起回执本应只达发起
      // 会话（多标签各自处理），但单标签切会话的竞态窗口/广播场景下可能迟到串台
      if (msg.sessionId && msg.sessionId !== get().currentSessionId) break
      // 回合中切换被 Java 挂起（缺陷AC）：回滚选中态到切换前模型（口径统一——显示的
      // 就是服务端实际在用的模型），挂起目标驱动提示条；persist 记忆保持目标值
      // （新会话/重开时按目标模型应用）。在途标记清除：服务端仍在旧模型上，期间到达
      // 的 settings 计算于旧模型＝显示模型，级别反而可信
      const prev = get().modelSwitchPrevModel
      set({
        currentModel: prev ?? get().currentModel,
        modelSwitchInFlightAt: null,
        modelPendingSwitch: { sessionId: msg.sessionId, modelId: msg.modelId, providerId: msg.providerId },
        lastNotice: i18n.t('app.modelSwitchDeferred', { model: msg.modelId }),
      })
      break
    }

    case 'modelSetFailed': {
      // 失败解锁（review Spec①）：applyModelIfReady 下发前登记防重发，失败不解除会让
      // 该会话的重发路径在本 webview 生命周期内永久锁死。显式移除后，下一次触发
      // （models 刷新/订阅回执/切回会话）自然重试；确定性失败（如 captchaGated）也只在
      // 用户动作再触发时重试一次，不形成循环
      if (msg.sessionId && get().modelAppliedSessions.has(msg.sessionId)) {
        const nextApplied = new Map(get().modelAppliedSessions)
        nextApplied.delete(msg.sessionId)
        set({ modelAppliedSessions: nextApplied })
      }
      // 回执标记同步清除（缺陷BO）：失败目标不能被 ack 拦住后续重试（与上方登记
      // 解锁同语义；不依赖 has 守卫——用户 setModel 直发路径失败时无登记但有 ack）
      if (msg.sessionId) {
        const ackNext = new Set(get().modelAckSessions)
        ackNext.delete(msg.sessionId)
        set({ modelAckSessions: ackNext })
      }
      // 会话级记忆修复——在下方显示守卫之前（code-review Spec#1）：延迟补发失败可
      // 晚到数分钟、用户多已切走，守卫 break 会连记忆修复一起跳过 → 失败目标留存
      // zcode.modelMemory，重启恢复照旧重放毒目标。仅当记忆仍指向失败目标才修复
      //（期间用户已改选别的模型则不动，防误删新记忆）；回滚依据 prev 与
      // modelPendingSwitch 同生命周期（切会话同清），只有挂起/当前会话仍属目标时
      // prev 才可信（防别的会话新切换的 prev 串写）；迟到场景 prev 已清 → 删除该
      // 会话记忆（无记忆 = 重启不重放，显示由消息快照推断恢复——宁缺毋错）
      const prev = get().modelSwitchPrevModel
      const mem = msg.sessionId ? readSessionModel(msg.sessionId) : null
      if (mem && msg.modelId && sameModel(mem, msg)) {
        const prevOwned = !!prev
          && (get().modelPendingSwitch?.sessionId === msg.sessionId || get().currentSessionId === msg.sessionId)
        if (prevOwned) rememberSessionModel(msg.sessionId, prev!)
        else forgetSessionModel(msg.sessionId)
      }
      // 显示/报错会话守卫（缺陷BI）：别的会话的切换失败不落到当前会话
      if (msg.sessionId && msg.sessionId !== get().currentSessionId) break
      // 挂起的切换回合结束后补发仍失败（真不支持/会话已死等）：清提示并走通用错误展示
      if (get().modelPendingSwitch?.sessionId === msg.sessionId) {
        set({ modelPendingSwitch: null, modelSwitchPrevModel: null, lastNotice: null })
      }
      // 即时切换失败路径回滚选中态（此前停在目标模型上，勾选与实际不符）；延迟路径
      // modelSetPending 已回滚，prev 与 currentModel 相同，再回滚是无操作。
      // captchaGated（体验套餐 zcode-plan 网关渠道被 Java 入口拦截）映射本地化文案
      set({
        modelSwitchInFlightAt: null,
        modelSwitchPrevModel: null,
        ...(prev ? { currentModel: prev } : {}),
        lastError: msg.reason === 'captchaGated' ? i18n.t('app.modelCaptchaGated') : msg.message,
      })
      break
    }

    case 'modelSwitchCancelled':
      // 取消回执（本地已先行清理）：兜底再清一次挂起与提示
      if (get().modelPendingSwitch?.sessionId === msg.sessionId) {
        set({ modelPendingSwitch: null, modelSwitchPrevModel: null, lastNotice: null })
      }
      break

    case 'settings': {
      // 过期的 settings 响应（切会话竞态）直接丢弃
      if (msg.sessionId !== get().currentSessionId) break
      // 缺陷CG 三轮：轮末「兜底重拉设置」的响应在此同步 mode——v2 两层分立下它带
      // session 层模式（yolo 等）而非 agent 门控态，裸拒绝后轮末兜底会据此切走
      // 指示器（与 applyStateUpdated 同款 hold：agent 计划阶段活跃期间推送值记
      // prePlanMode、保持显示 plan；v1 推 plan / 批准后 / 手动切档后照旧同步）
      const incomingMode = msg.mode?.current ?? null
      const holdForPlan = get().agentPlanActive && incomingMode != null && incomingMode !== 'plan'
      // 模型切换在途：本响应计算于旧模型，级别部分不可信——写入会把旧级别集污染进
      // 新模型的缓存、applyThoughtLevelIfReady 会发出对新模型非法的级别（-32603）。
      // mode 与模型无关照常同步；级别真相由 modelSet 后延迟 500ms 的 loadSettings 提供
      if (isModelSwitchInFlight(get())) {
        if (holdForPlan) set({ prePlanMode: incomingMode })
        else set({ currentMode: incomingMode })
        break
      }
      if (holdForPlan) {
        set({ thoughtLevel: msg.thoughtLevel, prePlanMode: incomingMode })
      } else {
        set({
          currentMode: incomingMode,
          thoughtLevel: msg.thoughtLevel,
        })
      }
      // 按当前模型缓存级别集（待命态/懒创建首问前的显示与校验用）
      writeThoughtLevelCache(get().currentModel?.modelId, msg.thoughtLevel)
      // 竞态推迟过的级别：本响应是切换落定后的权威级别集（也顺带治愈切换前被旧响应
      // 污染的按模型缓存），重置 applied 门控重新走权威校验——合法才下发，非法静默
      // 跳过（如 qwen 上选的 enabled 切回 GLM；竞态修复前的污染缓存曾放行非法值致 -32603）
      if (get().pendingThoughtLevel) {
        set({ pendingThoughtLevel: null, thoughtLevelAppliedForSession: null })
      }
      // 设置就绪：把记忆的思考级别下发给该会话（available 已知，仿 applyModelIfReady 门控）
      get().applyThoughtLevelIfReady(msg.sessionId)
      break
    }

    case 'thoughtLevelSet': {
      // 服务端校准 current（与本地乐观更新可能一致）
      const info = get().thoughtLevel
      if (info) set({ thoughtLevel: { ...info, current: msg.thoughtLevel } })
      break
    }

    case 'modeSet':
      set({ currentMode: msg.mode })
      break

    case 'goalManaged': {
      // 目标操作权威回执：target/goalStats 落地；服务端拦截（plan 模式/回合
      // 运行中）时 error 回执提示并拉 show 校准回滚乐观更新。切会话后的迟到响应丢弃
      const sid = get().currentSessionId
      if (msg.sessionId && sid && msg.sessionId !== sid) break
      if (msg.error) {
        // 乐观用户消息随目标卡一并回滚（服务端拒绝时目标轮不开，乐观消息永远不会
        // 被服务端真身替换，不删会一直挂着）
        if (optimisticGoalUserMsg && optimisticGoalUserMsg.sid === (msg.sessionId ?? sid)) {
          const doomed = optimisticGoalUserMsg.msgId
          optimisticGoalUserMsg = null
          set({ messages: get().messages.filter((m) => m.info.id !== doomed) })
        }
        set({ lastError: msg.error })
        sendToJava({ op: 'goalManage', sessionId: msg.sessionId ?? sid, action: 'show' })
        break
      }
      optimisticGoalUserMsg = null
      const next = toGoalState(msg.target, msg.goalStats, get().goal)
      set({ goal: next })
      break
    }

    case 'usage': {
      // 流式轮询期间切会话：旧会话的迟到响应直接丢弃，避免污染新会话圆环
      if (msg.sessionId && msg.sessionId !== get().currentSessionId) break
      // 压缩态权威同步（session/read → runtime.activeTurnKind，5s 轮询通道）：
      // 覆盖 autocompact（send 未识别）与异常残留
      if (msg.activeTurnKind === undefined) {
        // 字段缺失 = 服务端已无活动回合（滞后窗口里字段是"仍在"而非缺失，实测
        // eventSeq=816 落后时 activeTurnKind 仍报 compact）。仅当本轮压缩曾被
        // 服务端确认过才清除——防 turn.completed 丢失后 compacting 卡 true、看门狗
        // 被豁免的永久转圈盲区；未确认过（旧 CLI 不上报字段）维持不动作
        if (get().compacting && compactingServerConfirmed) set({ compacting: false })
        compactingServerConfirmed = false
        serverActiveTurnId = null
      } else {
        const compacting = msg.activeTurnKind === 'compact'
        // 滞后读数复活防护：服务端 runtime 清算异步于 turn.completed 下发（实测
        // eventSeq 816<820，滞后 ~1.3s），回合结束重拉批的 getUsage 可能仍报
        // 「已完成那轮」的 activeTurnKind=compact——按 activeTurnId 与客户端最近
        // 完成的 turnId 比对识别，滞后读数不复活指示器。否则 compacting 永久卡
        // true 并连锁毒化下一回合（turn.started 被压缩守卫吞掉、delta 无处落地
        // → 只转圈，2026-08-24 缺陷）。真实的新压缩回合（autocompact 紧接上一
        // 回合结束）带新 turnId，不受影响
        const staleCompact = compacting && msg.activeTurnId != null && msg.activeTurnId === lastCompletedTurnId
        compactingServerConfirmed = compacting && !staleCompact
        if (!staleCompact && get().compacting !== compacting) {
          set({ compacting })
        }
        // 服务端活跃信号（看门狗用）：同一滞后校验对任意 activeTurnId 生效——
        // 回合结束清算滞后的读数不算活跃（否则真断流收尾被豁免成永久转圈）
        const staleTurnId = msg.activeTurnId != null && msg.activeTurnId === lastCompletedTurnId
        serverActiveTurnId = staleTurnId ? null : (msg.activeTurnId ?? null)
      }
      if (msg.breakdown) {
        // 构成明细来自 session/read 的 runtime.breakdown（turn 后 CLI 构建）：
        // 落一份 persist 缓存，历史会话恢复后服务端拿不到时兜底（见 loadBreakdownCache）
        saveBreakdownCache(msg.sessionId ?? '', msg.breakdown, msg.used)
        set({
          contextUsage: { used: msg.used, size: msg.size, hitRate: msg.hitRate ?? null },
          contextBreakdown: msg.breakdown,
        })
      } else {
        // 服务端无构成：breakdown 只挂在 CLI 内存 eventStore 的 ModelComplete 事件上，
        // 不随消息落盘，会话 resume 到新进程（IDE 重启/标签重开）后即缺失。
        // 当前无数据时用缓存兜底——used 与缓存时一致（消息未变 → 构成未变）才可信
        const cached = get().contextBreakdown ? null : loadBreakdownCache(msg.sessionId ?? '', msg.used)
        set({
          // hitRate 字段缺失 = 本 turn 暂无统计（不落 0，悬浮栏显示"—"）
          contextUsage: { used: msg.used, size: msg.size, hitRate: msg.hitRate ?? null },
          ...(cached ? { contextBreakdown: cached } : {}),
        })
      }
      break
    }

    case 'sessionDebug': {
      // 流式轮询期间切会话：旧会话的迟到响应直接丢弃（同 usage）
      if (msg.sessionId && msg.sessionId !== get().currentSessionId) break
      set({ sessionDebug: { rounds: msg.rounds ?? [], cache: msg.cache ?? null } })
      break
    }

    case 'sessionDebugError': {
      // P2 静默降级（同 usageError）：会话未 active / agent 刚重启（快照进程内存清零）
      // 是常态而非故障，保留旧读数，仅记日志
      console.warn('[store] session debug query failed:', msg.message)
      break
    }

    case 'quota':
      if (msg.error) {
        // 失败也记录刷新时间：否则 quotaFetchedAt 永远为 0，悬浮框/设置页的「上次刷新」永不显示，
        // 用户只看到错误文案，无法判断是否刚尝试过拉取
        set({ quota: null, quotaLoading: false, usageError: msg.error, quotaFetchedAt: Date.now() })
      } else {
        set({
          quota: msg.data ?? null,
          quotaLoading: false,
          usageError: null,
          quotaFetchedAt: Date.now(),
          ...(msg.providerId && {
            usageProvider: {
              id: msg.providerId,
              name: msg.providerName ?? msg.providerId,
              ...(msg.providerKeyMasked && { keyMasked: msg.providerKeyMasked }),
            },
          }),
        })
      }
      break

    case 'appUsage':
      if (msg.error) {
        set({ appUsage: null, appUsageError: msg.error })
      } else {
        set({ appUsage: msg.data ?? null, appUsageError: null })
      }
      break

    case 'memoryFiles': {
      // 乱序丢弃守卫（同 listSessions）：切目录后晚到的旧目录清单不覆盖当前浏览
      if (
        msg.workspacePath &&
        normalizeWsPath(msg.workspacePath) !== normalizeWsPath(get().memoryWorkspace || get().projectPath)
      ) {
        break
      }
      set({ memoryFiles: msg.files, memoryDir: msg.memoryDir ?? null, memoryEnabled: msg.memoryEnabled, memoryLoading: false, memoryError: null })
      break
    }

    case 'memorySearchResults':
      // 对齐丢弃乱序应答：只接受与当前发起 query 一致的响应
      if (msg.query === get().memorySearchActiveQuery) {
        set({ memorySearchResults: msg.results, memorySearching: false })
      }
      break

    case 'cuaEnabled':
      set({ cuaEnabled: msg.enabled })
      break

    case 'cuaEnabledChanged':
      set({ cuaEnabled: msg.enabled, cuaToggling: false })
      break

    case 'cuaIcon':
      // data 缺省=文件缺失：保留 '' 哨兵，后续 loadCuaIcon 不再重复请求
      if (msg.data) {
        set({ cuaIcons: { ...get().cuaIcons, [msg.key]: `data:image/png;base64,${msg.data}` } })
      }
      break

    case 'memoryEnabledChanged':
      // setMemoryEnabled 后端写 setting.json 成功才回包；开关对新建会话生效
      set({ memoryEnabled: msg.enabled, memoryToggling: false, memoryError: null })
      break

    case 'memoryFileCreated':
      // 创建成功后重拉清单刷新存在状态（Kotlin 侧已自动用编辑器打开）
      set({ memoryCreatingPath: null })
      get().loadMemoryFiles()
      break

    case 'browserConfig':
      set({ browserConfig: {
        browserControlEnabled: msg.browserControlEnabled,
        pluginInstalled: msg.pluginInstalled,
      } })
      break

    case 'browserDataCleared':
      // 回包取消兜底定时器（busy 守卫保证同时只有一个在途操作，全清即可）
      Array.from(browserBusyTimers.keys()).forEach(cancelBrowserBusyTimer)
      set({
        browserBusy: null,
        browserCleared: { all: msg.all, httpCache: msg.httpCache, cookies: msg.cookies, sites: msg.sites },
        browserError: msg.ok ? null : 'clear failed',
      })
      break

    case 'browserDataOverview': {
      const { op: _overviewOp, ...overviewData } = msg
      Array.from(browserBusyTimers.keys()).forEach(cancelBrowserBusyTimer)
      set({ browserBusy: null, browserOverview: overviewData })
      break
    }

    case 'skills':
      // 乱序丢弃守卫：切目录后晚到的旧目录扫描不覆盖当前浏览
      if (
        msg.workspacePath &&
        normalizeWsPath(msg.workspacePath) !== normalizeWsPath(get().skillsWorkspace || get().projectPath)
      ) {
        break
      }
      set({ skills: msg.skills, skillsLoading: false, skillsError: null })
      break

    case 'commands':
      // 斜杠命令/技能清单（InputBox 下拉与消息气泡 /name chip 化共用数据源）
      set({ slashCommands: msg.commands, slashCommandsRequested: false })
      break

    case 'skillToggled':
      // toggleSkill 后端写 config 成功才回包；清单在则本地翻转（避免整页重扫闪烁）
      {
        const skills = get().skills
        set({
          ...(skills
            ? { skills: skills.map((s) => (s.path === msg.path ? { ...s, enabled: msg.enabled } : s)) }
            : null),
          skillTogglingPath: null,
        })
      }
      break

    case 'enhancePromptResult':
      // 润色回包（含失败态）：关闭 loading，弹窗按 error 有无渲染错误/结果；
      // 回包不带 model（CLI 降级通道）时保留发起时的占位模型。
      // 代际守卫须先于取消兜底定时器：迟到回包（弹窗已关/已被新请求取代）直接
      // 丢弃——既不弹窗也不覆盖新请求状态，更不能误杀新请求的超时兜底
      if (msg.seq !== enhanceActiveSeq) break
      cancelEnhanceTimer()
      set({
        enhancing: false,
        enhanceResult: {
          // 错误回包（异常/busy）不带 original，保留弹窗当前原文而非落空串
          original: msg.original ?? get().enhanceResult?.original ?? '',
          model: msg.model ?? get().enhanceResult?.model,
          ...(msg.error
            ? { error: msg.error }
            : { text: msg.text }),
        },
      })
      break

    case 'sessionTitleRegenerated':
      // AI 标题回包：成功经 renameSession 应用（本地状态 + persist 持久化，与手动改名
      // 同通道；服务端 v4 renameSession 已由 Java 落库）；失败置通栏提示
      if (msg.error) {
        set({ titleRegeneratingSessionId: null, sessionTitleRegenError: msg.error })
      } else {
        if (msg.title) get().renameSession(msg.sessionId, msg.title)
        set({ titleRegeneratingSessionId: null })
      }
      break

    case 'agents':
      set({ subagentDefs: msg.agents })
      break

    case 'agentSaved':
      // 写盘成功才回包：置保存完成信号（AgentEditDialog 监听后关弹窗）+ 重扫清单
      set({ agentSavedSignal: { name: msg.name, scope: msg.scope, at: Date.now() } })
      get().loadAgents()
      break

    case 'agentDeleted': {
      // 清单同步 + 若删除的是当前选中项则取消选择
      get().loadAgents()
      const sel = get().selectedAgent
      if (sel && sel.name === msg.name) set({ selectedAgent: null })
      break
    }

    case 'mcpServers':
      set({
        mcpServers: msg.servers,
        mcpLoading: false,
        mcpChecking: false,
        mcpError: msg.rpcError ?? null,
      })
      // 检测连接完成后自动刷新日志：connect 的连接过程刚落盘，日志面板立刻可见结果
      if (msg.mode === 'connect') get().loadMcpLogs()
      // 连接成功的服务器自动拉工具清单（用户诉求：连上就能看到有哪些工具；
      // 每台一个独立 op 后台直连，互不阻塞；已有缓存的不重拉）
      msg.servers.forEach((s) => {
        if (s.status === 'connected' && s.enabled && s.scope !== 'runtime') get().loadMcpServerTools(s.name)
      })
      break

    case 'modelSetProviderKey':
      // 自定义 key 写入成功（~/.zcgui/config.json + 注册表推送已触发）：重拉管理页刷新徽章
      if (msg.ok) get().loadModelManage()
      break

    case 'modelManage':
      set({
        modelProviders: msg.providers,
        modelManageLoading: false,
        modelManageError: msg.error ?? null,
        modelConfigPath: msg.configPath ?? null,
        modelManageNewCli: msg.newCli === true,
        modelRemigrateAvailable: msg.remigrate === true,
      })
      // 设置页模型清单到达 → 输入框下拉同步（用户诉求：管理页刷新/切换后下拉跟着变，
      // 不再只在启动时拉一次）。走 listModels 保持口径与 case 'models' 既有逻辑复用
      get().loadModels()
      break

    case 'modelConnectivityResult': {
      // 连通性测试回包：结果按「providerId|modelId」组合键存徽章（重测覆盖；切页不丢，
      // 重拉 modelManage 保留；渠道禁用后模型行不渲染，结果自然不可见）
      const results = { ...get().connectivityResults }
      if (get().connectivityTestingId === `${msg.providerId}|${msg.modelId}`) {
        results[`${msg.providerId}|${msg.modelId}`] = { ok: msg.ok, error: msg.error }
        set({ connectivityResults: results, connectivityTestingId: null })
      }
      break
    }

    case 'pendingInteractions':
      // 待交互计数全量快照（协议客户端反向请求计数，Kotlin 广播）：直接覆盖
      set({ pendingInteractionCounts: msg.counts ?? {} })
      break

    case 'pinnedSessions':
    case 'sessionPinsChanged':
      // 置顶集全量快照（op=listPinnedSessions 应答 / setSessionPinned 写库后全标签广播）：
      // 直接覆盖（数组新引用触发订阅方重算；排序在 HistoryView 渲染层做）
      set({ pinnedSessionIds: Array.isArray(msg.pinned) ? msg.pinned : [] })
      break

    case 'sessionUnreads':
    case 'sessionUnreadsChanged':
      // 未读集全量快照（op=listUnreadSessions 应答 / 相位迁移标未读与打开清除后广播）：
      // 直接覆盖（Java 库为权威源，前端不做乐观更新）
      set({ unreadSessionIds: Array.isArray(msg.unread) ? msg.unread : [] })
      break

    case 'backgroundWorksList':
      // 后台工作投影缓存应答（打开会话时的对账拉取）：与实时帧同源同形（Java 缓存=
      // 最后一次帧值），全量替换、后到者胜，竞态无害
      if (msg.sessionId && Array.isArray(msg.works)) {
        set({
          backgroundWorksBySession: {
            ...get().backgroundWorksBySession,
            [msg.sessionId]: msg.works,
          },
        })
      }
      break

    case 'sessionTurnPhase': {
      // 回合相位广播（Kotlin 全局事件监听，含手机远程驱动的会话）：列表行实时翻转
      // 运行中/复位——远程会话在 IDE 无本地 streaming 状态，此前列表只能停在旧快照
      // 值（运行中却显示已完成）。running 记入集合防后续旧快照降级；ended 复位并
      // 防抖重拉对账真实状态与 updatedAt 排序（重拉时集合已删该行，快照值正常落地）
      const phaseSid = msg.sessionId as string
      if (phaseSid && !phaseSid.startsWith('sess_subagent')) {
        const running = msg.phase === 'running'
        const remoteRunningTurns = { ...get().remoteRunningTurns }
        if (running) remoteRunningTurns[phaseSid] = Date.now()
        else delete remoteRunningTurns[phaseSid]
        // 运行相位投影到流式标志（Kotlin 订阅完成补推，重开会话/切回会话）：
        // 新 webview 没经历过该会话的 turn.started（快照回放有意不置流式=状态
        // 重建非实时相位），实时流接上了但按钮停在发送态。仅当前会话且未在
        // 流式中补置；streaming 翻 true 时订阅器自动重置看门狗基准
        const projectStreaming = running && phaseSid === get().currentSessionId && !get().streaming
        set({
          remoteRunningTurns,
          ...(projectStreaming ? { streaming: true } : {}),
          sessions: get().sessions.map((s) =>
            s.sessionId === phaseSid ? { ...s, status: running ? 'running' : 'idle' } : s,
          ),
        })
        if (!running) scheduleTurnEndListRefresh(get)
      }
      break
    }

    case 'sessionIndexUpdate': {
      // 会话列表活性订阅（sessions-index v4 topic，Kotlin 过滤软删/子会话后推送）：
      // 官方桌面端/手机 H5 驱动的会话此前在本进程零事件流、列表只能停在旧快照
      // （跨进程改动须重启 agent runtime 才可见）——索引推送补齐这个面。合并是
      // 叠加语义（session/list 快照仍是权威底座），纯函数见 utils/sessionIndexMerge
      const merged = mergeSessionsIndex({
        prev: get().sessions,
        entries: (msg.sessions ?? []) as SessionIndexEntry[],
        removed: (msg.removed ?? []) as string[],
        currentId: get().currentSessionId,
      })
      if (merged !== get().sessions) {
        // 回合运行中的行强制 running（与 listSessions 收口同法）：remoteRunningTurns
        // 是本进程事件流的投影，相位可能晚于索引帧到达
        const runningIds = Object.keys(get().remoteRunningTurns)
        set({
          sessions: runningIds.length
            ? merged.map((s) => (runningIds.includes(s.sessionId) ? { ...s, status: 'running' } : s))
            : merged,
        })
      }
      break
    }

    case 'modelRemigrated':
      // 重迁回包：结果进弹窗（names=迁入渠道名，空=无可迁移）；成功顺手全量重拉
      //（modelManage 应答自带 loadModels 联动，输入框下拉同步刷新）
      set({ modelRemigrating: false })
      if (msg.ok) {
        set({ modelRemigrateResult: { names: msg.migrated ?? [] } })
        get().loadModelManage()
      } else {
        set({ modelRemigrateResult: { names: [], error: msg.error ?? '迁移失败' } })
      }
      break

    case 'modelToggled': {
      // 渠道/模型启用禁用写回成功（changes 元素含 modelId 时为模型级）：本地更新 + 重拉下拉
      const providers = applyModelToggleChanges(get().modelProviders, msg.changes ?? [])
      set({ modelProviders: providers, modelTogglingId: null, modelTogglingKey: null })
      get().loadModels()
      break
    }

    case 'modelProviderSaved': {
      // 自定义渠道增/改/删回包：失败文案留在弹窗内（providerSaveError），成功清态并
      // 全量重拉（modelManage 应答自带 loadModels 联动，输入框下拉同步刷新）
      if (!msg.ok) {
        set({ providerSaving: false, providerSaveError: msg.error ?? '保存失败' })
        break
      }
      set({ providerSaving: false, providerSaveError: null })
      get().loadModelManage()
      break
    }

    case 'modelProvidersReordered':
      // 排序写回成功（providerOrder 落盘）：本地按新序重排 + 重拉刷新（带 loadModels 联动）
      set({ modelProvidersReordering: false })
      get().loadModelManage()
      break

    case 'mcpServerTools': {
      const prevTools = get().mcpToolsByServer
      set({
        mcpToolsByServer: {
          ...prevTools,
          [msg.name]: {
            tools: msg.tools ?? [],
            loading: false,
            error: msg.error,
            fetchedAt: Date.now(),
          },
        },
      })
      break
    }

    case 'mcpLogs':
      set({ mcpLogs: msg.logs, mcpLogsLoading: false })
      break

    case 'modelTrajectoryResult':
      // 过期回包丢弃（面板已切会话/重发新请求）：只认最新一次请求的 sessionId
      if (msg.error) {
        set({
          trajectoryError: msg.error,
          trajectoryLoading: false,
          trajectory: get().trajectory?.sessionId === msg.sessionId ? get().trajectory : null,
        })
      } else {
        set({
          trajectory: {
            sessionId: msg.sessionId,
            records: msg.records ?? [],
            sourceFiles: msg.sourceFiles ?? [],
            truncated: !!msg.truncated,
            totalCount: msg.totalCount ?? 0,
          },
          trajectoryError: null,
          trajectoryLoading: false,
        })
      }
      break

    case 'modelUsage':
      if (msg.error) {
        set({ modelUsage: null, usageError: msg.error })
      } else {
        set({
          modelUsage: msg.data ?? null,
          ...(msg.providerId && {
            usageProvider: {
              id: msg.providerId,
              name: msg.providerName ?? msg.providerId,
              ...(msg.providerKeyMasked && { keyMasked: msg.providerKeyMasked }),
            },
          }),
        })
      }
      break

    case 'toolUsage':
      if (msg.error) {
        set({ toolUsage: null, usageError: msg.error })
      } else {
        set({
          toolUsage: msg.data ?? null,
          ...(msg.providerId && {
            usageProvider: {
              id: msg.providerId,
              name: msg.providerName ?? msg.providerId,
              ...(msg.providerKeyMasked && { keyMasked: msg.providerKeyMasked }),
            },
          }),
        })
      }
      break

    case 'currentFile':
      // Kotlin→webview 单向推送：getCurrentFile 拉取响应 / EditorContextTracker 200ms 防抖推送
      // ref 形态：'@path' / '@path#L10' / '@path#L10-20' / null（无打开编辑器）
      // 不做严格格式校验（chip 内对 null/脏值有兜底展示），让推送值原样落 state
      set({ currentFileRef: msg.ref ?? null })
      break
  }
}

// ============ 流式事件处理 ============

/**
 * state.updated 通知：模式/思考级别/模型的服务端权威变化（含 ZCode 自动进出计划模式、
 * 外部客户端修改）。payload = {reason:"mode_changed"|..., patch:{mode, thoughtLevel, ...}}。
 * 自己 setMode/setThoughtLevel 后也会收到（幂等校准）。
 */
function applyStateUpdated(
  event: StreamEvent,
  set: (partial: Partial<StoreState>) => void,
) {
  const payload = event.payload as {
    reason?: string
    patch?: {
      mode?: { current?: string }
      thoughtLevel?: ThoughtLevelInfo
      model?: { current?: { providerId?: string; modelId?: string } }
    }
  }
  const patch = payload.patch
  if (patch) {
    const p: Partial<StoreState> = {}
    if (patch.mode?.current) {
      // 缺陷CG 真根因：v2 的 agent 级 plan 门控与 session 级模式两层分立——拒绝后
      // agent 仍在 plan（工具面只读），而回合边界权威推送带的是 session 基础模式
      // （如 yolo）。agent 计划阶段活跃期间不得让 session 模式翻转指示器：推送值
      // 记入 prePlanMode（ExitPlanMode 批准后恢复用），保持显示 plan；批准（弹窗/
      // 推断清 agentPlanActive）或用户手动切档后照旧同步
      if (useStore.getState().agentPlanActive && patch.mode.current !== 'plan') {
        p.prePlanMode = patch.mode.current
      } else {
        p.currentMode = patch.mode.current
        // 权威值切离 plan：清除 prePlanMode 记忆（避免下次 ExitPlanMode 恢复到过期值）
        if (patch.mode.current !== 'plan') p.prePlanMode = null
      }
    }
    if (patch.thoughtLevel) p.thoughtLevel = patch.thoughtLevel
    // v2 会话实际模型缓存（缺陷BW）：v2 的 session/messages assistant info 不带
    // modelID/providerID（v1 带，直连实测），回合 footer 无从显示——state 推送的
    // model.current 是权威源（含 reasoningLevel，展示取 providerId/modelId），按
    // 会话缓存供快照落地时回填。模型可能不含 providerId（纯 modelId 形态），逐字段取
    const cur = patch.model?.current
    if (cur?.modelId) {
      const sid = useStore.getState().currentSessionId
      if (sid) {
        sessionRuntimeModels = { ...sessionRuntimeModels, [sid]: { modelId: cur.modelId, providerId: cur.providerId ?? '' } }
      }
    }
    if (Object.keys(p).length > 0) set(p)
  }
  console.log(`[store] state.updated(${payload.reason ?? '?'}): 模式/级别已按服务端同步`)
}

/** 每会话最近已知实际模型（v2：session/messages 不带 modelID 时的 footer 回填源）*/
let sessionRuntimeModels: Record<string, { modelId: string; providerId: string }> = {}

/**
 * 缺陷E修复：回合中的模式推断。
 * 服务端只在回合边界（prompt_completed）推带 mode 的 state.updated，回合中途
 * EnterPlanMode 成功 / ExitPlanMode 批准时刻均无推送——由 reducer 从工具事件推断
 * modeEvent，这里即时应用到指示器，不等回合结束：
 *   enter_plan：记住进 plan 前的模式，立即显示 plan
 *   exit_plan ：恢复记忆的模式（无记忆则 yolo），保持显示到回合结束——不立即回读
 *   settings 校正：服务端 state 层 mode 在回合边界（prompt_completed）才更新，批准
 *   瞬间回读到的仍是 plan，会把推断值覆盖回去（缺陷E修复的回归，已移除回读）
 */
function applyModeEventToPatch(
  modeEvent: 'enter_plan' | 'exit_plan',
  patch: Partial<StoreState>,
  get: () => StoreState,
) {
  if (modeEvent === 'enter_plan') {
    const cur = get().currentMode
    if (cur && cur !== 'plan') patch.prePlanMode = cur
    patch.currentMode = 'plan'
    patch.planApprovalAnswer = null
    // agent 计划阶段开启（缺陷CG）：后续 session 模式推送改记 prePlanMode
    patch.agentPlanActive = true
  } else {
    // 幂等保护：批准瞬间的乐观恢复（PlanApprovalDialog）或权威 state.updated 已把
    // 模式切离 plan 时跳过——迟到的 batch 推断不得因 prePlanMode 记忆缺失把
    // 已恢复的模式覆盖成兜底值 yolo
    const cur = get().currentMode
    if (cur && cur !== 'plan') return
    // 缺陷CG守卫：v2 服务端把拒绝的 ExitPlanMode 也记 success（batch errorCount=0），
    // !isError 不再是批准证据——只有弹窗明确回过 approve 才允许推断离 plan。
    // 拒绝/意见式/无标记（超时、多标签无弹窗、重载）安全侧留在 plan，等回合边界
    // 权威 state.updated 校正；标记消费即清，防陈旧 approve 污染后续推断
    if (get().planApprovalAnswer !== 'approve') return
    patch.planApprovalAnswer = null
    patch.agentPlanActive = false
    patch.currentMode = get().prePlanMode ?? 'yolo'
    patch.prePlanMode = null
  }
}

/**
 * session.updated 的事件权威上下文窗口（对齐官方 v4 投影 touchedByEvent）：
 * model_selected 切模即时带 contextWindow（payload 无 querySource），主回合
 * model_complete 逐回合带（querySource=main_turn），值=注册表
 * model.properties.contextWindow（composeEffective 真值，用户自定义 256k 在此），
 * 与 handleGetUsage 的 Kotlin 侧合成同源同值。legacy session/read 的 size 被服务端
 * 投影初值锁死 200k，消费此事件让「切模后、首次 usage 轮询前」圆环分母也即时正确。
 * 仅在已有用量读数时就地替换分母（新会话保持空环占位契约，loadUsage 会带 Kotlin
 * 合成值）；used/hitRate 保持 session/read 读数；同值不 set。
 * 非主回合 querySource（session_title 等）不带可信窗口，忽略。
 */
function applyContextWindowEvent(
  event: StreamEvent,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
): void {
  if (event.type !== 'session.updated') return
  const p = event.payload as { querySource?: unknown; contextWindow?: unknown }
  if (p.querySource !== undefined && p.querySource !== 'main_turn') return
  const sid = event.sessionId
  if (sid && get().currentSessionId && sid !== get().currentSessionId) return
  const raw = p.contextWindow
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return
  const window = Math.floor(raw)
  const prev = get().contextUsage
  if (!prev || prev.size === window) return
  set({ contextUsage: { used: prev.used, size: window, hitRate: prev.hitRate } })
}

/** NEW 代（v2 zcode.cjs）session/read 认可的 7 种构成分类（model_complete 投影实证）*/
const CONTEXT_BREAKDOWN_SOURCES: ReadonlySet<ContextSource> = new Set<ContextSource>([
  'system_prompt',
  'meta_user_context',
  'skills',
  'tool_prompt',
  'system_tool_schemas',
  'mcp_tool_schemas',
  'messages',
])

/**
 * session.updated 的上下文构成通道（NEW 代唯一活通道）：主回合 model_complete
 * 投影（legacy 事件面 type=session.updated，querySource=main_turn，cjs 侧硬条件）
 * 携带 contextUsageBreakdown [{source, chars}]。NEW 代 runtime 装配要求事件
 * contextWindow === runtime.size 才把 breakdown 并进 session/read，而 runtime 模板
 * 默认 200000 与模型真值恒不等（缺陷BX 同因），故 session/read 永远拿不到，
 * 只能在事件流这里消费。不随消息落盘：resume 到新进程后丢失，由 saveBreakdownCache
 * 持久化 + usage 响应的 loadBreakdownCache 兜底（used 取 usage.totalTokens，与
 * session/read 的 contextUsage.used 同口径）。
 * 非法 source/chars 逐项过滤；非主回合、非当前会话、空数组一律忽略。
 */
function applyContextBreakdownEvent(
  event: StreamEvent,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
): void {
  if (event.type !== 'session.updated') return
  const p = event.payload as { querySource?: unknown; contextUsageBreakdown?: unknown }
  if (p.querySource !== 'main_turn') return
  const sid = event.sessionId
  if (sid && get().currentSessionId && sid !== get().currentSessionId) return
  const raw = p.contextUsageBreakdown
  if (!Array.isArray(raw) || raw.length === 0) return
  const items: ContextBreakdownItem[] = []
  for (const el of raw) {
    const source = (el as { source?: unknown })?.source
    const chars = (el as { chars?: unknown })?.chars
    if (typeof source !== 'string' || !CONTEXT_BREAKDOWN_SOURCES.has(source as ContextSource)) continue
    if (typeof chars !== 'number' || !Number.isFinite(chars) || chars < 0) continue
    items.push({ source: source as ContextSource, chars })
  }
  if (items.length === 0) return
  const used = (p as { usage?: { totalTokens?: unknown } }).usage
  const usedTokens = typeof used?.totalTokens === 'number' ? used.totalTokens : get().contextUsage?.used ?? 0
  saveBreakdownCache(sid ?? '', items, usedTokens)
  // 同值不 set：事件重放（v4 快照回放等）避免无谓引用变化
  const prev = get().contextBreakdown
  const same = prev !== null
    && prev.length === items.length
    && prev.every((it, i) => it.source === items[i].source && it.chars === items[i].chars)
  if (!same) set({ contextBreakdown: items })
}

/**
 * 批量处理流式事件（Java 端 16ms 节流合并的一批）。
 * 逐个归约但只 set 一次，避免每个 delta 都触发 React 重渲染。
 */
/**
 * 处理 subagent.lifecycle 通知（父会话流里的 session.updated）：
 * - spawned/stopped 都注册 childSessionId → 聚合键（parentToolCallId 优先），
 *   注册后子会话原生事件流即可实时归约（见 handleChildStreamBatch）
 * - stopped：若详情弹窗正开着且属于该子会话 → 拉权威全量替换实时流
 */
function applySubagentLifecycle(
  lc: SubagentLifecyclePayload,
  timestamp: number,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  const key = lc.parentToolCallId || lc.agentId
  if (key && get().childSessionKeys[lc.childSessionId] !== key) {
    const st = get()
    set({ childSessionKeys: { ...st.childSessionKeys, [lc.childSessionId]: key } })
    // 注册即订阅其原生事件流（不订则事件到不了前端，实时归约无从谈起）
    subscribeChildSession(lc.childSessionId)
    console.log(`[store] 子会话已注册: ${lc.childSessionId} → ${key} (${lc.phase})`)
  }
  if (lc.phase === 'stopped') {
    const st = get()
    // stopped 是子代理的真实终点：即时收尾底部栏活动 + 权威刷新列表。
    // 后台代理的 Agent 工具启动即返回（result 早于活动创建，markActivityOutcome
    // 当时无对象可标记），不在这里收尾会卡 running 直到主回合 turnEnded
    const failStatus = (lc.status ?? '').toLowerCase()
    const failed = SUBAGENT_FAILURE_STATUSES.includes(failStatus)
    if (failed) diagWarn(`[subagent-mark-failed] src=lifecycle key=${key} status=${failStatus}`)
    if (key) {
      const activities = markActivityOutcome(st.subagentActivities, key, failed, timestamp)
      set({ subagentActivities: activities, ...refreshStatus(st.messages, activities, st.subagents) })
    }
    get().loadSubagents()
    if (st.subagentDetail && st.childSessionKeys[lc.childSessionId] === st.subagentDetail) {
      st.loadChildMessages(lc.childSessionId)
    }
    // 终点退订（spec 二.4）：stopped 后 v4 订阅/行表/探针计数随 Java 侧收敛。
    // 放在 loadChildMessages 之后——权威转录先落，退订只断增量帧不影响读取
    unsubscribeChildSession(lc.childSessionId)
  }
}

/**
 * 子会话原生事件流归约（批）：turn.started/text_delta/tool.updated 等 → 完整对话。
 * 复用 applyStreamEvent（纯函数，与会话无关）；跳过 state.updated（子会话的
 * 模式/级别变化不套用到主界面）。turn 结束不重拉——由 stopped → 权威全量替换。
 */
function handleChildStreamBatch(
  sessionId: string,
  events: StreamEvent[],
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  if (events.length === 0) return
  let messages = get().childLiveMessages[sessionId] ?? []
  let streamingId = get().childStreamingIds[sessionId] ?? null
  let childTurnEnded = false
  let childTurnFailed = false
  // 批内 turn 生命周期归并（2026-08-31 实测"会话没完成被判失败"根因修复）：
  // 子代理多 turn 续跑（前 turn 失败重试/自动续轮）时，turn1 终态与 turn2.started
  // 可能同批到达——最终态以批内最后一个生命周期事件为准，turn2 已开则不收尾
  let lastLifecycle: 'started' | 'ended' | null = null
  let sawTurnStarted = false
  for (const event of events) {
    // v4 快照回放前的重置标记：清空 live 归约状态再重建（重订阅/online 重同步
    // 场景防内容重复追加；applyStreamEvent 不认识它，在此拦截）
    if (event.type === 'stream.snapshotReset') {
      messages = []
      streamingId = null
      continue
    }
    if (event.type === 'state.updated') continue
    if (event.type === 'turn.started') {
      lastLifecycle = 'started'
      sawTurnStarted = true
    }
    // 防御：子会话原生流不应出现转发标记，出现则跳过（转发事件走父会话流）
    if (event.type === 'tool.updated' && isSubagentToolEvent(event.payload)) continue
    const r = applyStreamEvent(messages, event, streamingId)
    messages = r.messages
    streamingId = r.streamingMessageId
    if (r.turnEnded) {
      childTurnEnded = true
      lastLifecycle = 'ended'
      if (r.turnError) childTurnFailed = true
    }
  }
  const st = get()
  let activities = st.subagentActivities
  // 跨批恢复：turn 终态收尾后子代理又续跑新 turn（重试/续轮）——恢复 running，
  // 防误终态被 mergeAgentItems 防降级锁死（RPC running 盖不回本地终态）
  const key = st.childSessionKeys[sessionId]
  if (sawTurnStarted && key) {
    const restored = activities.map((a) => a.key === key && a.status !== 'running'
      ? { ...a, status: 'running' as const, endedAt: undefined, lastUpdate: Date.now() }
      : a)
    if (restored !== activities) activities = restored
  }
  set({
    childLiveMessages: { ...st.childLiveMessages, [sessionId]: messages },
    childStreamingIds: { ...st.childStreamingIds, [sessionId]: streamingId },
    ...(activities !== st.subagentActivities
      ? { subagentActivities: activities, ...refreshStatus(st.messages, activities, st.subagents) }
      : {}),
  })
  // 子会话 turn 结束 = 子代理跑完：后台代理唯一实时可用的终点信号
  //（session/subscribe 流不带 subagent.lifecycle，合成通知消息只在重拉时可见），
  // 即时收尾父会话活动 + 权威刷新。批内最后生命周期事件是新 turn.started
  //（多 turn 续轮：终态后又开了新回合）时跳过收尾——子代理整体仍在跑
  if (childTurnEnded && lastLifecycle !== 'started' && key) {
    const ts = events[events.length - 1]?.timestamp ?? Date.now()
    if (childTurnFailed) {
      const lastTs = events[events.length - 1]?.timestamp
      diagWarn(`[subagent-mark-failed] src=child-turn key=${key} childSid=${sessionId} lastEventTs=${lastTs}`)
    }
    const closed = markActivityOutcome(activities, key, childTurnFailed, ts)
    set({ subagentActivities: closed, ...refreshStatus(st.messages, closed, st.subagents) })
    get().loadSubagents()
  }
}

function handleStreamBatch(
  sessionId: string,
  events: StreamEvent[],
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  // ===== 工具输入大块 delta 的流式回放 =====
  // 真实行为（2026-08-22 [tis] 诊断实测）：GLM 走 openai-compatible 的 tool call
  // 在 zcode.cjs 侧被 normalization 聚合，tool_input_delta 以 1~2 个大块在一个
  // 16ms batch 内到达（tool_call 转正紧随同秒）——自然流式窗口不存在，UI 无法
  // 展示累计。这里把超阈值的大 delta 切片成原子事件队列，按 ~16ms/片回放
  // （约 1 秒播完），后续事件（tool_call/tool.updated 等）排队保序——下游
  // reducer/组件零改动，事件流被"重新流式化"。小 delta（真实逐块流式）直通。
  const atoms = sliceBigStreamDeltas(events)
  if (atoms || (replayQueues.get(sessionId)?.length ?? 0) > 0) {
    enqueueReplay(sessionId, atoms ?? events, set, get)
    return
  }
  handleStreamBatchDirect(sessionId, events, set, get)
}

/** 回放队列与节拍器（模块级：跨批次保序）。按会话隔离——泵与队列都绑定各自的
 *  sessionId，防 A 会话回放窗口（~1s）内到达的 B 会话事件被挤进同一队列、
 *  按 A 的 sessionId 错误分发（多标签/子会话并行流式实测可撞） */
const replayQueues = new Map<string, StreamEvent[]>()
const replayTimers = new Map<string, number>()

/** 入队回放（切片原子或原样事件），该会话无运行中的泵则启动 */
function enqueueReplay(
  sessionId: string,
  events: StreamEvent[],
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
): void {
  const queue = replayQueues.get(sessionId)
  if (queue) queue.push(...events)
  else replayQueues.set(sessionId, [...events])
  if (!replayTimers.has(sessionId)) startReplayPump(sessionId, set, get)
}
/** 触发切片的 delta 阈值（字符）；低于此视为自然流式直通 */
const REPLAY_DELTA_THRESHOLD = 400
const REPLAY_FRAME_MS = 16
const REPLAY_TARGET_SLICES = 55

/** 批内含超阈值大块 delta 时，把大 delta 展开成切片原子序列（按 kind 分阈值）：
 *  - tool_input_delta >400 字符：GLM openai-compatible 聚合大块（原有场景）
 *  - text_delta/reasoning_delta >32 字符：v4 增量帧的 row.delta append 块
 *    （2026-08-31 抓包：中位 7 字、最大 87 字），主会话 legacy 流是小 delta 不受影响，
 *    子会话 v4 流的大块一次到达即"跳字"，切片后与主界面打字机体感一致 */
const TEXT_REPLAY_THRESHOLD = 32
const TEXT_SLICE_CHARS = 8

function replayThresholdFor(kind: unknown): number | null {
  if (kind === 'tool_input_delta') return REPLAY_DELTA_THRESHOLD
  if (kind === 'text_delta' || kind === 'reasoning_delta') return TEXT_REPLAY_THRESHOLD
  return null
}

function sliceBigStreamDeltas(events: StreamEvent[]): StreamEvent[] | null {
  const hasBig = events.some((e) => {
    if (e.type !== 'model.streaming') return false
    // 快照回放（v4 订阅/重同步的全量文本）不是流式，不切片——切片会让几十行的
    // 历史回放拖成数秒打字机，快照要求"到场即完整"
    if (e.deliveryKind === 'snapshot') return false
    const p = e.payload as Record<string, unknown>
    const th = replayThresholdFor(p.kind)
    return th != null && typeof p.delta === 'string' && p.delta.length > th
  })
  if (!hasBig) return null
  const atoms: StreamEvent[] = []
  for (const e of events) {
    const p = e.payload as Record<string, unknown>
    const th = replayThresholdFor(p.kind)
    const isToolInput = p.kind === 'tool_input_delta'
    if (e.type === 'model.streaming' && e.deliveryKind !== 'snapshot' && th != null
      && typeof p.delta === 'string' && p.delta.length > th) {
      // 两者都封顶 55 片：tool_input 按 96 字/片；text/reasoning 按 8 字/片微步进
      // （87 字块 ~11 片 ≈ 176ms 播完，兼顾逐字体感与更低的 DOM 替换频率）——
      // text 不封顶时一次数 KB 的大块会展开成数百片，拖出数秒打字机滞后
      const perSlice = isToolInput ? 96 : TEXT_SLICE_CHARS
      const slices = Math.min(REPLAY_TARGET_SLICES, Math.max(2, Math.ceil(p.delta.length / perSlice)))
      const size = Math.ceil(p.delta.length / slices)
      for (let i = 0; i * size < p.delta.length; i++) {
        atoms.push({
          ...e,
          payload: { ...p, delta: p.delta.slice(i * size, (i + 1) * size) },
        } as StreamEvent)
      }
    } else {
      atoms.push(e)
    }
  }
  return atoms
}

/** 每拍派发一个原子事件，队列空则停表并清掉本会话的队列/定时器。
 *  ⚠️ 单事件处理异常必须吞掉续泵：pump 回调若异常中断，timer 链断而
 *  replayTimers 残留键 → enqueueReplay 的 has 判定永不重启 → 该会话全部
 *  后续事件永久积压（2026-08-31 用户实测：工具停在 loading，手动刷新才渲染）*/
function startReplayPump(
  sessionId: string,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
): void {
  const pump = () => {
    const queue = replayQueues.get(sessionId)
    // 追帧：积压越长每拍播放越多（>100 片起每 100 片加一拍速），长报告切片
    // 不至于拖出数秒滞后；正常小队列仍是 16ms/片的匀速打字机
    const burst = queue ? Math.max(1, Math.floor(queue.length / 100)) : 1
    for (let i = 0; i < burst; i++) {
      let next: StreamEvent | undefined
      try {
        next = queue?.shift()
        if (next) handleStreamBatchDirect(sessionId, [next], set, get)
      } catch (err) {
        console.error('[stream-replay] event dispatch failed (dropped, pump continues):', next?.type, err)
      }
    }
    const alive = replayQueues.get(sessionId)
    if (alive && alive.length > 0) {
      replayTimers.set(sessionId, window.setTimeout(pump, REPLAY_FRAME_MS))
    } else {
      replayQueues.delete(sessionId)
      replayTimers.delete(sessionId)
    }
  }
  replayTimers.set(sessionId, window.setTimeout(pump, REPLAY_FRAME_MS))
}

/** 从工具 result 内容解析后台任务 ID（Bash run_in_background / 手动后台化）。
 *  判据单点定义在 utils/backgroundTask（缺陷Z 教训：判据注释勿逐字引用官方句子，
 *  否则 grep 源码输出会构成自指假阳性）。此处仅做 kind 过滤与字段取值。 */
function extractBackgroundTaskId(p: ToolUpdatedPayload): string | null {
  if (p.kind !== 'result') return null
  const content = typeof p.result?.content === 'string' ? p.result.content : ''
  return extractBackgroundTaskIdFromContent(content)
}

function handleStreamBatchDirect(
  sessionId: string,
  events: StreamEvent[],
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  // 标题更新通知：在会话过滤前处理（切走的会话也能更新列表标题），不走消息归约
  for (const event of events) {
    if (event.type === 'session.titleUpdated') applyTitleUpdated(sessionId, event, set, get)
  }
  // 后台工作投影（H7）：同样在会话过滤前落账——非当前会话的启停也要记录，
  // 切回该会话时 badge/面板才有数据（订阅常驻、快照只在订阅时推一次）
  for (const event of events) {
    if (event.type === 'backgroundWorks') {
      const works = (event.payload as { works?: import('@/types/messages').BackgroundWorkSummary[] }).works
      if (Array.isArray(works)) {
        set({
          backgroundWorksBySession: { ...get().backgroundWorksBySession, [sessionId]: works },
        })
      }
    }
  }
  // 钩子准入：会话过滤前落账（非当前会话的准入也要记），全量替换语义——
  // null 即已准入/无待审，横幅直接收敛
  for (const event of events) {
    if (event.type === 'workspaceHookAdmission') {
      const admission = (event.payload as { admission?: import('@/types/messages').WorkspaceHookAdmission | null }).admission ?? null
      set({
        workspaceHookAdmissionBySession: { ...get().workspaceHookAdmissionBySession, [sessionId]: admission },
      })
    }
  }
  // 发送落位看门狗预处理（缺陷FF）：同批量路径——会话过滤前认领/续期
  //（切走的会话事件仍驱动凭据认领，回来时不误判）
  for (const event of events) hookAdmissionStreamEvent(sessionId, event)
  if (sessionId !== get().currentSessionId) {
    // 已注册子会话的原生事件流 → 实时归约成完整对话（运行中详情弹窗数据源，
    // 含 AI 文本增量；Java 全局监听器本就把所有会话事件推到了前端）
    if (sessionId in get().childSessionKeys) {
      handleChildStreamBatch(sessionId, events, set, get)
    }
    return
  }
  if (events.length === 0) return

  // 逐轮文件更改摘要（B2 回合产物）：幂等更新逐轮更改条（同事件重复到达安全）
  for (const event of events) {
    if (event.type === 'turn.fileChanges') applyTurnFileChanges(event, set, get)
  }

  // 看门狗心跳：当前会话有任何事件到达 = 回合活着（静默对账不会触发）
  lastStreamActivityAt = Date.now()

  // 通知卡实时落地（缺陷CI）：同单推路径——轮开始即调度转录拉取
  //（wake 轮开始时轮界注入的通知已落地，卡片随合并腿在 wake 轮开场出现）
  for (const event of events) {
    if (event.type === 'turn.started') scheduleNotificationTranscriptPull(sessionId)
  }

  let messages = get().messages
  let streamingMessageId = get().streamingMessageId
  let activities = get().subagentActivities
  let turnStarted = false
  let turnEnded = false
  let modeEvent: 'enter_plan' | 'exit_plan' | undefined
  let turnError: TurnErrorInfo | undefined
  let bgTasks: BackgroundTaskMap | null = null
  let bgDirty = false // 本批内后台任务有增删（有变更才 patch，保持引用稳定防多余重渲染）
  // steer 引导插队 chip 的批内过渡值（有变更才进 patch，保持引用稳定）
  let steerPending = get().steerPending
  // 审批意见回显豁免标志的批内过渡值（steerDrained 命中时清，批末进 patch）
  let planFeedbackEcho = get().planFeedbackEcho
  // 撤销引导竞态观察记录的批内过渡值（缺陷BQ，steerDrained 命中时清）
  let steerCancelRestore = get().steerCancelRestore
  // steerDrained 命中竞态时撤下回插条目的结果（null = 本批未命中）
  let queuedAfterSteerCancel: QueuedMessage[] | null = null
  // 竞态命中 = 取消未生效（消息已注入），批末横幅告知
  let steerCancelTooLate = false
  // 本批落位的注入消息 id（徽标标记，批末统一持久化 + 进 patch）
  const steerNewIds: string[] = []
  const childKeyPatch: Record<string, string> = {}

  for (const event of events) {
    // 状态变化通知（不走消息归约，直接同步 settings）
    if (event.type === 'state.updated') {
      applyStateUpdated(event, set)
      continue
    }
    // 子代理生命周期通知（session.updated / kind=subagent.lifecycle）：
    // spawned 携带 childSessionId → 注册子会话；stopped → 收尾活动 + 拉权威全量
    if (event.type === 'session.updated') {
      // 事件权威上下文窗口（切模/主回合），先于其他形态判定；不拦截后续识别
      applyContextWindowEvent(event, set, get)
      // NEW 代构成明细唯一活通道（主回合 model_complete 投影），同先消费不拦截
      applyContextBreakdownEvent(event, set, get)
      const lc = asSubagentLifecycle(event.payload)
      if (lc) {
        applySubagentLifecycle(lc, event.timestamp, set, get)
        continue
      }
      // 目标模式 payload（action/target/previousTarget）：目标状态实时推进——
      // set/run_started/status_updated/cleared 等全部走此通道（diag-goal.py 实测）
      const gp = asGoalTargetPayload(event.payload)
      if (gp) {
        applyGoalTargetPayload(gp, event.sessionId, set, get)
        continue
      }
      // 后台任务完成通知（zcode.cjs 任务生命周期推送，实测字段：taskId/toolCallId/
      // toolName/taskKind/status=running|completed|failed...）：toolCallId 精确匹配
      // 指示器（通知带 toolCallId，兜底 taskId 反查），状态离开 running → 标记
      // endedAt（不删除——UI 保留「后台完成」标识与定格耗时；会话级清除点清整本）。
      // turn.completed 不再清：后台化确认后回合可能立即结束（行为B），任务仍在后台
      // 跑——完成通知才是权威收尾信号
      const tp = event.payload as { taskId?: string; toolCallId?: string; status?: string }
      if (tp.status && tp.status !== 'running') {
        const curTasks: BackgroundTaskMap = bgTasks ?? get().backgroundTasks
        const key = tp.toolCallId && tp.toolCallId in curTasks
          ? tp.toolCallId
          : tp.taskId
            ? Object.keys(curTasks).find((k) => curTasks[k].id === tp.taskId)
            : undefined
        if (key) {
          bgTasks = { ...curTasks, [key]: { ...curTasks[key], endedAt: Date.now() } }
          bgDirty = true
        }
        // 通知卡实时落地（缺陷CI）：状态迁移 = 通知合成消息已注入转录，调度转录
        // 重拉。taskId/toolCallId 双可选校验拦掉会话级 status 帧（无任务字段不拉）
        if (tp.taskId || tp.toolCallId) scheduleNotificationTranscriptPull(event.sessionId)
      }
    }
    // 子代理转发工具事件（source=subagent）：不进主聊天 parts（防刷屏），
    // 聚合到 subagentActivities 供底部子代理栏与详情弹窗使用
    if (event.type === 'tool.updated' && isSubagentToolEvent(event.payload)) {
      activities = applySubagentToolEvent(activities, event.payload, event.timestamp)
      ensureSubagentStatusPolling() // running 活动期间启动权威轮询兜底
      // 兜底注册子会话（spawned 通知缺失时，转发事件自带的归属字段也能建立映射）
      const fp = event.payload as ToolUpdatedPayload
      if (fp.childSessionId && fp.parentToolCallId
        && !(fp.childSessionId in get().childSessionKeys) && !(fp.childSessionId in childKeyPatch)) {
        childKeyPatch[fp.childSessionId] = fp.parentToolCallId
        // 同 spawned 注册：补订子会话原生事件流
        subscribeChildSession(fp.childSessionId)
      }
      continue
    }
    // 父会话 Agent 工具本身收尾 → 对应子代理活动即时标记完成/失败
    if (event.type === 'tool.updated') {
      const p = event.payload as ToolUpdatedPayload
      if (p.kind === 'result' && p.toolCallId && activities.some((a) => a.key === p.toolCallId)) {
        activities = markActivityOutcome(activities, p.toolCallId, p.result?.success === false, event.timestamp)
      }
      // 后台任务识别（体验增强，缺陷Y 配套）：Bash run_in_background 的工具 result
      // 内容带官方后台化确认（Command 动作前缀 + exec_ UUID 任务 ID，判据见
      // extractBackgroundTaskId，注释不再逐字引用官方句子以免 grep 自指误报）。
      // 此后回合挂起等 <task-notification>，事件流静默——指示器让等待可见。
      // 同一回合并发/连续多个后台任务各自独立记账（key = toolCallId，互不覆盖）
      const bgId = extractBackgroundTaskId(p)
      if (bgId && p.toolCallId) {
        const curTasks: BackgroundTaskMap = bgTasks ?? get().backgroundTasks
        bgTasks = { ...curTasks, [p.toolCallId]: { id: bgId, startedAt: Date.now() } }
        bgDirty = true
      }
    }
    if (event.type === 'model.streaming' || event.type === 'tool.updated') turnHasModelOutput = true
    if (event.type === 'turn.started') {
      turnStarted = true
      turnHasModelOutput = false
      armSwitchStallHint(sessionId, set, get)
      // 编辑重放编排终点提前（回合运行期放开再编辑，见函数注释）
      retireEditReplayOnTurnStarted(event.payload, set, get)
    }
    // 编辑重发被服务端排队防御（steerQueued 携带 input 与编辑文本一致即命中；
    // steer 自身的 steerQueued 只有 queueLength 不带 input，不受影响）
    if (event.type === 'turn.steerQueued' && handleEditSteerQueuedDefence(event.payload, set, get)) {
      continue
    }
    // 「已发出但被服务端排队」防御（缺陷FD）：繁忙窗口降级为 delivery=queue 的发送
    // 按 input 全文回认领并促发（见函数注释；编辑防御在前，两者不冲突）。
    // 气泡并入本批累加器（messages 批末统一 set，直写 store 会被覆盖）
    if (event.type === 'turn.steerQueued') {
      const rescued = handleFlushedSendQueuedDefence(event.payload, sessionId, messages)
      if (rescued) {
        if (rescued !== true) messages = [...messages, rescued]
        continue
      }
    }
    // 编辑重放的 rewind 生效确认（同单推路径）：截断本批局部 messages（编辑目标
    // 轮到尾部，含 turn.started 建的流式空壳）+ kv 落记忆，不走消息归约。
    // 截断不再要求 editReplay 匹配：v4 editUserQuery 的 ack 应答与事件乱序（探针
    // 实测 rewind.triggered 可先于 accepted 到达，乐观 editReplay 通常已就位），
    // 且 ack 丢失/应答超时的场合事件也是截断生效的权威信号——凡会话级 rewind
    // 都截断显示并落 kv 记忆，与模型上下文保持一致。
    // v4 编辑匹配时（2026-09-12 真机回归补）：①截断后立即补插编辑后的用户气泡
    // （本地 local_u_ 命名空间，turn.started 文本一致时自动改名成服务端 id），
    // 否则实时流里新 user 消息要等轮末重拉才出现；②kv cut 走 staged 判别提交
    // （回合中编辑是就地改写语义，无判别落 kv 会在重放时删光新轮=空白主屏）
    if (event.type === 'rewind.triggered') {
      const targetId = asConversationRewind(event.payload)
      if (targetId) {
        // 截断核心见 applyRewindTriggeredCore（同单推路径共享收口）；命中 editReplay
        // 的 rewound 标记批内立即 set——同批后续事件可能读 get().editReplay
        const replay = get().editReplay
        const r = applyRewindTriggeredCore(messages, streamingMessageId, targetId, replay, sessionId)
        messages = r.messages
        streamingMessageId = r.streamingMessageId
        if (r.matched && replay) {
          set({ editReplay: { ...replay, rewound: true } })
        }
      }
      continue
    }
    // steer 引导式插队（2026-09-07 探针定案）：注入气泡落位，不进消息归约
    // （归约器只认消息型事件）；批内改局部变量，下方 patch 一次性合并。
    // turn.steerQueued 仅携带 queueLength（UI 不消费）走默认忽略
    if (event.type === 'turn.steerDrained') {
      // 服务端结构（diag-steer3 权威取证）：注入 u2 落在前后两段 assistant 之间，
      // 同一回合被拆成两条 assistant 消息（post-steer 输出进全新 assistant 消息，
      // 有独立 messageId），落位瞬间到回合结束此序不变。实时态镜像该结构：
      // ① u2 追加尾部（当前流式壳 = pre-steer 内容之后）；② streamingMessageId
      // 置空——旧壳就地封口成普通 assistant 消息，下一条产出型 delta 走归约器
      // 补壳分支按协议 assistantMessageId 自建新壳（真身 id，轮末重拉天然对账）
      const drained = asSteerDrainedInputs(event.payload)
      const entries = drained.length > 0
        ? drained
        : steerPending
          ? [{ messageId: `steer_${steerPending.at}`, text: steerPending.text }]
          : []
      // 审批意见回显豁免：意见式拒绝的服务端注入走 guide 通道，事件面与 steer
      // 插队同形。窗口内且文本一致 = 审批回显而非用户插队：跳过注入与徽标
      // （意见气泡由 insertFeedbackMessage 本地条在拆分处呈现，无徽标），流式壳
      // 不动（后续 delta 继续进本地壳，轮末重拉权威对账）。文本不一致 = 真
      // steer 并发，按正常落位处理
      const echo = planFeedbackEcho
      if (entries.length > 0 && echo && Date.now() - echo.at < PLAN_FEEDBACK_ECHO_MS
        && entries.every((e) => e.text.trim() === echo.text)) {
        planFeedbackEcho = null
        steerPending = null
        continue
      }
      const known = new Set(messages.map((m) => m.info.id))
      for (const e of entries) if (!known.has(e.messageId)) steerNewIds.push(e.messageId)
      messages = appendSteerUserMessages(messages, entries, sessionId, event.timestamp)
      streamingMessageId = null
      steerPending = null
      // 撤销竞态守卫（缺陷BQ）：removed=true 回插的条目在注入实际发生时撤下，
      // 防回合结束 flushQueue 把同一条再发一遍（气泡落位不受影响，上面已追加）。
      // 命中即"用户刚点过取消但消息已注入"——横幅如实告知取消未生效，防误以为
      // 撤销成功（服务端 drain 取出后取消窗口即关闭，此场景实测远多于真撤销）
      const cancelled = steerCancelRestore
      if (cancelled && Date.now() - cancelled.at < STEER_CANCEL_RESTORE_MS
        && entries.some((e) => e.text.trim() === cancelled.text)) {
        queuedAfterSteerCancel = get().queuedMessages.filter((m) => m.id !== cancelled.itemId)
        steerCancelRestore = null
        steerCancelTooLate = true
      }
      continue
    }
    if (event.type === 'turn.started' && steerPending) {
      // guide 降级 startNow（无 steerDrained 直接开新轮）：input 与插队文本一致
      // 才认领（防把 goal 自动续轮等无关 turn 误认领）；气泡 id 优先 payload.
      // messageId（服务端正式 user 消息 id），handleTurnStarted 对已存在同 id
      // user 气泡有独立命名空间处理，不会把 delta 串进气泡
      const p = event.payload as { input?: unknown; messageId?: unknown }
      if (typeof p.input === 'string' && p.input.trim() === steerPending.text) {
        const id = typeof p.messageId === 'string' && p.messageId ? p.messageId : `steer_${steerPending.at}`
        messages = appendSteerUserMessages(messages, [{ messageId: id, text: p.input }], sessionId, event.timestamp)
        steerNewIds.push(id)
        steerPending = null
      }
    }
    // 压缩回合不建流式 assistant 消息（同单推路径：零 delta 空气泡，CompactingIndicator 表达）；
    // goal 校验轮同款（verifying 窗口内服务端起 completion verifier 回合，~10s 零
    // delta——建了就是空气泡+工作中 footer，校验完消失 = 间歇闪屏，0.3.2 真机反馈；
    // 校验态由 GoalCard"校验中"行表达）
    if (event.type !== 'turn.started' || (!get().compacting && !get().goal?.verifying)) {
      const result = applyStreamEvent(messages, event, streamingMessageId)
      messages = result.messages
      streamingMessageId = result.streamingMessageId
      if (result.turnEnded) {
        turnEnded = true
        if (event.turnId) lastCompletedTurnId = event.turnId
      }
      if (result.modeEvent) modeEvent = result.modeEvent
      if (result.turnError) turnError = result.turnError
    }
  }

  // 一次性 set（整批只触发一次重渲染）
  const patch: Partial<StoreState> = {
    messages,
    streamingMessageId,
    subagentActivities: activities,
    ...refreshStatus(messages, activities, get().subagents),
  }
  if (Object.keys(childKeyPatch).length > 0) {
    patch.childSessionKeys = { ...get().childSessionKeys, ...childKeyPatch }
  }
  if (turnStarted) patch.streaming = true, patch.waitingSince = null
  // 新回合开跑 = 瞬态额度问题（并发/限频/服务商边界）已被服务端放行，撤下横幅触发源；
  // 耗尽类保留——窗口恢复由 useQuotaBanner 依据额度数据判定（额度未恢复时新回合仍会失败）
  if (turnStarted && get().quotaBannerError && get().quotaBannerError!.kind !== 'window-exhausted') {
    patch.quotaBannerError = null
  }
  // 同批 completed+started（服务端自动续轮）时保留 reducer 返回的新 streamingMessageId，
  // 不能按"turn 结束"清空——清了后续 delta 全部丢失（实时断流）
  if (turnEnded && !turnStarted) {
    cancelSwitchStallHint()
    patch.streaming = false
    patch.streamingMessageId = null
    patch.waitingSince = null
    patch.compacting = false
    // 后台任务指示器不在回合结束清除（后台化确认后回合可能立即结束，
    // 任务仍在后台跑——由任务完成通知清除，见 bgCompleted 分支）
    // 失败回合展示错误详情（同批 failed+started 的自动续轮不打扰）
    if (turnError) {
      patch.lastError = formatTurnError(turnError)
      // 会话额度横幅触发源：与顶栏错误条并行点亮（耗尽类附窗口信息由视图层派生）
      const banner = quotaBannerTriggerFrom(get().currentModel?.providerId, turnError.code, turnError.message)
      if (banner) patch.quotaBannerError = banner
    }
    // steer 插队 chip 活到回合结束：未落位（guide 降级队列被弃/命令失败等，罕见
    // 路径——实测 guide 命中时 steerDrained 早于 completed 到达），清 chip 并横幅
    // 提示可重发。带附件引导已砍（0.3.4 定案），不再有回合末促发分支。
    // cancelling 在途（撤回应答未回）不碰：不促发、不清 chip、不横幅——撤回
    // 应答 removed=true 要按 restore 回插队列，这里清了 pending 回插就落空（条目
    // 两头消失），去留完全交给撤回应答
    if (steerPending) {
      if (steerPending.cancelling) {
        // 留给 cancelSteer 应答收尾
      } else {
        steerPending = null
        if (!turnError) patch.lastError = i18n.t('input.steer.notDelivered')
      }
    }
    // 撤销竞态观察收口（缺陷BQ）：回合结束仍无 steerDrained = 撤销真成功，
    // 条目留在队列正常 flush，观察记录作废
    steerCancelRestore = null
  }
  // steer chip 批内有变更才进 patch（引用稳定防多余重渲染）
  if (steerPending !== get().steerPending) patch.steerPending = steerPending
  // 审批意见回显豁免标志批内被消费 → 清空进 patch
  if (planFeedbackEcho !== get().planFeedbackEcho) patch.planFeedbackEcho = planFeedbackEcho
  // 撤销竞态观察记录批内有变更 → 进 patch；命中时一并撤下回插条目
  if (steerCancelRestore !== get().steerCancelRestore) patch.steerCancelRestore = steerCancelRestore
  if (queuedAfterSteerCancel) patch.queuedMessages = queuedAfterSteerCancel
  if (steerCancelTooLate) patch.lastNotice = i18n.t('input.steer.cancelTooLate')
  // 本批落位的注入消息：kv 持久化 + 进 patch（气泡「⚡引导」徽标，MessageBubble 读）
  if (steerNewIds.length > 0) {
    addSteerMarkers(steerNewIds)
    patch.steeredMessageIds = [...get().steeredMessageIds, ...steerNewIds]
  }
  // 后台任务指示器（多任务并发，key = toolCallId）：本批有增删才 patch
  if (bgDirty && bgTasks) patch.backgroundTasks = bgTasks
  if (modeEvent) applyModeEventToPatch(modeEvent, patch, get)
  // set 前捕获（patch 已把 compacting 清 false）：压缩回合结束的判定依据
  const wasCompacting = get().compacting
  set(patch)
  // exit_plan 不立即回读 settings：批准瞬间服务端 state 层仍是 plan，回读会把上面的
  // 推断值覆盖回去。推断值保持显示到回合结束，由下方 turnEnded 路径
  //（state.updated 即时推送 + loadSettings）校正

  if (turnEnded) {
    console.log(`[store] turn 结束（批量），重新拉取消息确保一致`)
    // 编辑编排收尾（收口见 finalizeEditReplayOnTurnEnd，同单推路径）：v4 通道重发由
    // 服务端完成，编辑后新 turn 结束即终点（含失败回合——编辑本身已生效）；stopping=
    // 两段式第一段（stop 收尾）转第二段发编辑；legacy 通道 rewound 未确认或回合失败
    // → 放弃重发并提示
    finalizeEditReplayOnTurnEnd(turnError, set, get)
    // 本批未同时开启新 turn 时自动发送队列下一条（同批 completed+started 说明服务端已自动续轮）
    if (!turnStarted) {
      // 压缩回合结束：摘要卡只经下方重拉快照落地，队列非空时延迟到快照落地后再
      // flush——立即发会让新 turn 抢先置 streaming，快照被丢弃、摘要卡整轮缺失
      if (get().editReplay) {
        // 编辑重放等快照落地后由 case 'messages' 消费重发（同压缩延迟 flush 思路）
      } else if (wasCompacting && get().queuedMessages.length > 0) {
        scheduleDeferredCompactFlush(sessionId)
      } else {
        get().flushQueue()
      }
    }
    setTimeout(() => {
      // 压缩延迟 flush 场景：标记快照在途（兜底触发时据此续等，防抢跑）
      if (deferredCompactFlushSid === sessionId) compactSnapshotInFlightAt = Date.now()
      sendToJava({ op: 'messages', sessionId, workspacePath: get().currentWorkspacePath })
      // 刷新会话列表：CLI 会根据对话内容更新标题（sess_xxx → 用户问题）
      get().loadSessions()
      // 刷新子代理权威列表（running/ended + summary，底部栏与详情弹窗用）
      get().loadSubagents()
      // 刷新上下文用量（圆环更新）
      get().loadUsage()
      // 兜底重拉设置（ZCode 自动进出计划模式若伴随 turn 结束也能对齐）
      get().loadSettings()
      // 标题生成兜底重拉（2026-09-19）：服务端 AI 标题在回合结束后异步生成（3.14.0
      // 实测约 10s，3.12.x 最长数分钟），上面 300ms 的 loadSessions 跑在生成完成之前，
      // 实时 titleUpdated 通道若静默失效，首条输入派生的临时标题将停留到下次手动刷新。
      // 两次延迟重拉覆盖生成窗口；listSessions 合并幂等，实时通道正常时只是重刷同值
      setTimeout(() => get().loadSessions(), 15_000)
      setTimeout(() => get().loadSessions(), 60_000)
    }, 300)
  }
}

function handleStreamEvent(
  sessionId: string,
  event: StreamEvent,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  // 标题更新通知：在会话过滤前处理，切走的会话也能更新列表里的标题
  if (event.type === 'session.titleUpdated') {
    applyTitleUpdated(sessionId, event, set, get)
    return
  }

  // 发送落位看门狗（缺陷FF）：会话过滤前认领/续期（同批量路径）
  hookAdmissionStreamEvent(sessionId, event)

  // 非当前会话：已注册子会话的原生事件流 → 实时归约（同批量路径）
  if (sessionId !== get().currentSessionId) {
    if (sessionId in get().childSessionKeys) {
      handleChildStreamBatch(sessionId, [event], set, get)
    }
    return
  }

  // 看门狗心跳：当前会话有任何事件到达 = 回合活着（静默对账不会触发）
  lastStreamActivityAt = Date.now()

  // 逐轮文件更改摘要（B2）：同批量路径
  if (event.type === 'turn.fileChanges') {
    applyTurnFileChanges(event, set, get)
    return
  }

  // 通知卡实时落地（缺陷CI）：轮开始 = CLI 轮界注入的通知合成消息已落地的可靠
  // 信号（实验实证：任务结束事件在完成时刻发，注入拖到轮界——完成时刻拉转录
  // 必空；wake 轮开始时转录必有）。同任务结束信号共用防抖拉取
  if (event.type === 'turn.started') scheduleNotificationTranscriptPull(sessionId)

  // ===== 工具输入大块 delta 的流式回放（同批量路径；mock/关键事件走单推）=====
  const atoms = sliceBigStreamDeltas([event])
  if (atoms || (replayQueues.get(sessionId)?.length ?? 0) > 0) {
    enqueueReplay(sessionId, atoms ?? [event], set, get)
    return
  }

  // 状态变化通知（panel 单推，低频即时）：模式/级别跟随服务端
  if (event.type === 'state.updated') {
    applyStateUpdated(event, set)
    return
  }

  // 编辑重发被服务端排队防御（同批量路径；steer 自身的 steerQueued 只有
  // queueLength 不带 input，不受影响）
  if (event.type === 'turn.steerQueued' && handleEditSteerQueuedDefence(event.payload, set, get)) {
    return
  }
  // 「已发出但被服务端排队」防御（同批量路径，缺陷FD）：补插气泡直写 store
  //（单推路径无批末统一 set，不会覆盖）
  if (event.type === 'turn.steerQueued') {
    const rescued = handleFlushedSendQueuedDefence(event.payload, sessionId, get().messages)
    if (rescued) {
      if (rescued !== true) set({ messages: [...get().messages, rescued] })
      return
    }
  }

  // 编辑重放的 rewind 生效确认（diag-edit-rewind.py 实测时序：turn.started →
  // rewind.triggered → turn.completed）：服务端已截断模型上下文，此处同步截断
  // 内存消息（删除编辑目标轮到尾部——编辑守卫保证目标轮之后只有本命令轮），
  // 并把 targetId 落 kv 截断记忆（快照不反映截断，重拉时按轮删除重放）。
  // 截断不再要求 editReplay 匹配（同批量路径：v4 通道 ack 与事件乱序，事件是
  // 截断生效的权威信号；手动 /rewind 命令的显示截断同样由此对账）。
  // v4 编辑匹配时同批量路径：补插编辑后用户气泡 + staged 判别落 kv
  if (event.type === 'rewind.triggered') {
    const targetId = asConversationRewind(event.payload)
    if (targetId) {
      // 截断核心见 applyRewindTriggeredCore（同批量路径共享收口）：截断+流式壳清理+
      // v4 补插气泡/staged 落 kv 或 legacy addRewindCut，kv 副作用在核心内完成
      const st = get()
      const r = applyRewindTriggeredCore(st.messages, st.streamingMessageId, targetId, st.editReplay, sessionId)
      set({
        messages: r.messages,
        streamingMessageId: r.streamingMessageId,
        ...(r.matched && st.editReplay ? { editReplay: { ...st.editReplay, rewound: true } } : {}),
      })
    }
    return
  }

  // steer 引导式插队（同批量路径）：注入气泡落位，不进消息归约；
  // turn.steerQueued 仅携带 queueLength（UI 不消费）走默认忽略
  if (event.type === 'turn.steerDrained') {
    // 服务端结构镜像（同批量路径，diag-steer3 定案）：u2 追加尾部 + 流式壳封口，
    // 后续 delta 按协议 assistantMessageId 自建新壳；落位 id 进徽标账本
    const drained = asSteerDrainedInputs(event.payload)
    const pending = get().steerPending
    const entries = drained.length > 0
      ? drained
      : pending
        ? [{ messageId: `steer_${pending.at}`, text: pending.text }]
        : []
    // 审批意见回显豁免（同批量路径）：窗口内且文本一致 = 审批回显而非用户插队，
    // 跳过注入与徽标；流式壳不动，后续 delta 继续进缺陷Q本地壳
    const echo = get().planFeedbackEcho
    if (entries.length > 0 && echo && Date.now() - echo.at < PLAN_FEEDBACK_ECHO_MS
      && entries.every((e) => e.text.trim() === echo.text)) {
      set({ planFeedbackEcho: null, steerPending: null })
      return
    }
    const known = new Set(get().messages.map((m) => m.info.id))
    const newIds = entries.filter((e) => !known.has(e.messageId)).map((e) => e.messageId)
    // 撤销竞态守卫（缺陷BQ，同批量路径）：removed=true 回插的条目在注入实际
    // 发生时撤下，防回合结束 flushQueue 把同一条再发一遍
    const cancelled = get().steerCancelRestore
    const cancelHit = !!cancelled && Date.now() - cancelled.at < STEER_CANCEL_RESTORE_MS
      && entries.some((e) => e.text.trim() === cancelled.text)
    const queuedAfterCancel = cancelled && cancelHit
      ? get().queuedMessages.filter((m) => m.id !== cancelled.itemId)
      : null
    if (newIds.length > 0) {
      addSteerMarkers(newIds)
      set({
        steerPending: null,
        streamingMessageId: null,
        steeredMessageIds: [...get().steeredMessageIds, ...newIds],
        messages: appendSteerUserMessages(get().messages, entries, event.sessionId, event.timestamp),
        ...(queuedAfterCancel ? { queuedMessages: queuedAfterCancel, steerCancelRestore: null, lastNotice: i18n.t('input.steer.cancelTooLate') } : {}),
      })
    } else {
      set({
        steerPending: null,
        streamingMessageId: null,
        messages: appendSteerUserMessages(get().messages, entries, event.sessionId, event.timestamp),
        ...(queuedAfterCancel ? { queuedMessages: queuedAfterCancel, steerCancelRestore: null, lastNotice: i18n.t('input.steer.cancelTooLate') } : {}),
      })
    }
    return
  }
  if (event.type === 'turn.started' && get().steerPending) {
    // guide 降级 startNow：input 与插队文本一致才认领（同批量路径）
    const pending = get().steerPending
    const p = event.payload as { input?: unknown; messageId?: unknown }
    if (pending && typeof p.input === 'string' && p.input.trim() === pending.text) {
      const id = typeof p.messageId === 'string' && p.messageId ? p.messageId : `steer_${pending.at}`
      addSteerMarkers([id])
      set({
        steerPending: null,
        steeredMessageIds: [...get().steeredMessageIds, id],
        messages: appendSteerUserMessages(get().messages, [{ messageId: id, text: p.input }], event.sessionId, event.timestamp),
      })
    }
  }

  // 子代理生命周期通知（spawned/stopped）：注册子会话，stop 时收尾活动 + 拉权威
  if (event.type === 'session.updated') {
    // 事件权威上下文窗口（切模/主回合），同批量路径
    applyContextWindowEvent(event, set, get)
    // NEW 代构成明细事件通道，同批量路径
    applyContextBreakdownEvent(event, set, get)
    const lc = asSubagentLifecycle(event.payload)
    if (lc) {
      applySubagentLifecycle(lc, event.timestamp, set, get)
      return
    }
    // 目标模式 payload（同批量路径）
    const gp = asGoalTargetPayload(event.payload)
    if (gp) {
      applyGoalTargetPayload(gp, event.sessionId, set, get)
      return
    }
    // 后台任务完成通知（同批量路径）：toolCallId 精确匹配（兜底 taskId 反查）+
    // 状态离开 running → 标记 endedAt（不删除，UI 保留「后台完成」标识与定格耗时）。
    // 回合结束不再清（后台化确认后回合可能立即结束，任务仍在后台跑）
    const tp = event.payload as { taskId?: string; toolCallId?: string; status?: string }
    if (tp.status && tp.status !== 'running') {
      const curTasks: BackgroundTaskMap = get().backgroundTasks
      const key = tp.toolCallId && tp.toolCallId in curTasks
        ? tp.toolCallId
        : tp.taskId
          ? Object.keys(curTasks).find((k) => curTasks[k].id === tp.taskId)
          : undefined
      if (key) {
        set({ backgroundTasks: { ...curTasks, [key]: { ...curTasks[key], endedAt: Date.now() } } })
      }
      // 通知卡实时落地（缺陷CI）：同批量路径，状态迁移即调度转录重拉
      if (tp.taskId || tp.toolCallId) scheduleNotificationTranscriptPull(event.sessionId)
    }
  }

  // 子代理转发工具事件分流（同批量路径）：聚合不进主聊天
  if (event.type === 'tool.updated' && isSubagentToolEvent(event.payload)) {
    const st = get()
    const activities = applySubagentToolEvent(st.subagentActivities, event.payload, event.timestamp)
    ensureSubagentStatusPolling() // running 活动期间启动权威轮询兜底
    // 兜底注册子会话（同批量路径）
    const fp = event.payload as ToolUpdatedPayload
    const keyPatch = (fp.childSessionId && fp.parentToolCallId && !(fp.childSessionId in st.childSessionKeys))
      ? { [fp.childSessionId]: fp.parentToolCallId }
      : {}
    if (Object.keys(keyPatch).length > 0) subscribeChildSession(fp.childSessionId!)
    set({
      subagentActivities: activities,
      ...refreshStatus(st.messages, activities, st.subagents),
      ...(Object.keys(keyPatch).length > 0
        ? { childSessionKeys: { ...st.childSessionKeys, ...keyPatch } }
        : {}),
    })
    return
  }

  // 父会话 Agent 工具本身收尾 → 对应子代理活动即时标记
  if (event.type === 'tool.updated') {
    const p = event.payload as ToolUpdatedPayload
    if (p.kind === 'result' && p.toolCallId
      && get().subagentActivities.some((a) => a.key === p.toolCallId)) {
      const st = get()
      if (p.result?.success === false) {
        diagWarn(`[subagent-mark-failed] src=agent-result key=${p.toolCallId}`)
      }
      const activities = markActivityOutcome(st.subagentActivities, p.toolCallId, p.result?.success === false, event.timestamp)
      set({ subagentActivities: activities, ...refreshStatus(st.messages, activities, st.subagents) })
    }
    // 后台任务识别（同批量路径）：单推防御（正常链路 tool.updated 走批量，
    // 但未来若 Java 端把工具事件改单推，指示器不能丢）
    const bgId = extractBackgroundTaskId(p)
    if (bgId && p.toolCallId) {
      set({ backgroundTasks: { ...get().backgroundTasks, [p.toolCallId]: { id: bgId, startedAt: Date.now() } } })
    }
  }

  // 压缩回合不进消息归约：turn.started 建的流式 assistant 消息在摘要生成期间
  // 零 delta（实测 63s+ 事件真空），建了就是空气泡；压缩态由 CompactingIndicator
  // 表达，回合结束重拉落地摘要卡/分隔卡
  if (event.type === 'turn.started' && get().compacting) {
    set({ streaming: true, waitingSince: null })
    return
  }

  // goal 校验轮同款守卫：run_finished（verifying=true）到下一 run_started 之间，
  // 服务端起 completion verifier 回合（实测 ~10s，落库纯 timeline 消息）——流式
  // 零 delta，turn.started 建的乐观空壳会渲染成空气泡+工作中 footer，校验完
  // 随全量落地消失，每轮一次的出现/消失即"间歇闪屏"（0.3.2 真机反馈）。校验
  // 态由 GoalCard 的"校验中"行表达，此处只置流式标志不建消息
  if (event.type === 'turn.started' && get().goal?.verifying) {
    set({ streaming: true, waitingSince: null })
    return
  }

  if (event.type === 'model.streaming' || event.type === 'tool.updated') turnHasModelOutput = true
  if (event.type === 'turn.started') {
    turnHasModelOutput = false
    armSwitchStallHint(sessionId, set, get)
    // 编辑重放编排终点提前（同批量路径，回合运行期放开再编辑）
    retireEditReplayOnTurnStarted(event.payload, set, get)
  }

  const { messages, streamingMessageId, turnEnded, modeEvent, turnError } = applyStreamEvent(
    get().messages,
    event,
    get().streamingMessageId,
  )
  if (turnEnded && event.turnId) lastCompletedTurnId = event.turnId

  // turn.started：进入流式，清除 waiting（开始有内容了）
  if (event.type === 'turn.started') {
    set({ streaming: true, waitingSince: null })
    // 瞬态额度横幅随新回合撤下（同批量路径；耗尽类保留，由额度数据判定恢复）
    if (get().quotaBannerError && get().quotaBannerError!.kind !== 'window-exhausted') {
      set({ quotaBannerError: null })
    }
  }

  const st = get()
  const patch: Partial<StoreState> = {
    messages,
    streamingMessageId,
    ...refreshStatus(messages, st.subagentActivities, st.subagents),
  }
  if (modeEvent) applyModeEventToPatch(modeEvent, patch, get)
  set(patch)
  // exit_plan 不立即回读 settings（同批量路径：批准瞬间 state 层仍是旧值，回读=回滚）

  // turn 结束：重新拉完整消息确保数据一致，清除流式状态，自动发送队列下一条
  if (turnEnded) {
    cancelSwitchStallHint()
    const wasCompacting = get().compacting
    // 编辑重放的 rewind turn 结束收尾（收口见 finalizeEditReplayOnTurnEnd，同批量路径）：
    // stopping 转第二段发编辑；v4 编辑后新回合结束即终点；legacy rewound 未确认或
    // 回合失败 → 放弃重发并提示（模型上下文未变，原消息原样保留，用户可重试编辑）
    finalizeEditReplayOnTurnEnd(turnError, set, get)
    // steer 插队 chip 活到回合结束：未落位（同批量路径），清 chip + 提示可重发。
    // 带附件引导已砍（0.3.4 定案），无回合末促发分支。
    // cancelling 在途不碰（同批量路径：撤回应答要按 restore 回插，先清 pending
    // 会让回插落空）
    const steerDropped = get().steerPending
    // 失败回合同时点亮额度横幅触发源（同批量路径；与顶栏错误条并行）
    const bannerTrigger = turnError
      ? quotaBannerTriggerFrom(get().currentModel?.providerId, turnError.code, turnError.message)
      : null
    const steerEndPatch: Partial<StoreState> = turnError
      ? { lastError: formatTurnError(turnError), ...(bannerTrigger ? { quotaBannerError: bannerTrigger } : {}), steerPending: steerDropped?.cancelling ? steerDropped : null }
      : steerDropped
        ? steerDropped.cancelling
          ? { steerPending: steerDropped }
          : { steerPending: null, lastError: i18n.t('input.steer.notDelivered') }
        : {}
    set({
      streaming: false,
      streamingMessageId: null,
      waitingSince: null,
      compacting: false,
      // 撤销竞态观察收口（缺陷BQ，同批量路径）：回合结束仍无 steerDrained
      // = 撤销真成功，条目留在队列正常 flush，观察记录作废
      steerCancelRestore: null,
      // 后台任务指示器不在回合结束清除（同批量路径：由任务完成通知清除）
      // 失败回合展示错误详情（此前 payload.error 被丢弃，失败只表现为"转圈停了"）
      ...steerEndPatch,
    })
    console.log(`[store] turn ${event.type}，重新拉取消息确保一致`)
    // 压缩回合结束：摘要卡只经下方重拉快照落地，队列非空时延迟到快照落地后再
    // flush——立即发会让新 turn 抢先置 streaming，快照被丢弃、摘要卡整轮缺失
    //（同批量路径 scheduleDeferredCompactFlush，2026-08-22 /compact 排队实测）
    if (get().editReplay) {
      // 编辑重放等快照落地后由 case 'messages' 消费重发（同压缩延迟 flush 思路：
      // 立即 flush 会让排队消息抢先开新 turn，重拉快照被 streaming 守卫丢弃）
    } else if (wasCompacting && get().queuedMessages.length > 0) {
      scheduleDeferredCompactFlush(sessionId)
    } else {
      get().flushQueue()
    }
    setTimeout(() => {
      // 压缩延迟 flush 场景：标记快照在途（兜底触发时据此续等，防抢跑）
      if (deferredCompactFlushSid === sessionId) compactSnapshotInFlightAt = Date.now()
      sendToJava({
        op: 'messages',
        sessionId,
        workspacePath: get().currentWorkspacePath,
      })
      // 刷新会话列表：CLI 会根据对话内容更新标题
      get().loadSessions()
      // 刷新子代理权威列表
      get().loadSubagents()
      // 兜底重拉设置（模式/思考级别对齐服务端）
      get().loadSettings()
      // 刷新上下文用量（圆环更新，对齐批量路径）
      get().loadUsage()
    }, 300)
  }
}

// ===== 流式期间轮询上下文用量（圆环实时刷新）=====
// 机制：contextUsage 唯一来源是 session/read RPC，服务端在读时从最新 assistant 消息的
// tokens 实时计算（zcode.cjs ida/LRe/dda），流式期间没有推送事件——不轮询的话圆环
// 只在回合结束后才更新一次。streaming 翻转时启停：true → 每 5s loadUsage（幂等读，
// Kotlin 端走线程池，不阻塞 EDT/reader；响应带 sessionId 防切会话竞态）。
let usagePollTimer: ReturnType<typeof setInterval> | null = null

useStore.subscribe((s, prev) => {
  if (s.streaming === prev.streaming) return
  if (s.streaming) {
    if (!usagePollTimer) {
      // 立即采样一次（短回合 <5s 也能刷一次圆环），此后每 5s
      useStore.getState().loadUsage()
      usagePollTimer = setInterval(() => {
        const st = useStore.getState()
        if (!st.streaming) {
          if (usagePollTimer) clearInterval(usagePollTimer)
          usagePollTimer = null
        } else {
          st.loadUsage()
        }
      }, 5000)
    }
  } else if (usagePollTimer) {
    clearInterval(usagePollTimer)
    usagePollTimer = null
  }
})

// ===== 流式静默对账看门狗（缺陷M，2026-08-19；常量与状态见文件顶部）=====
// 时序证据（idea.log + cli jsonl）：CLI 桌面端自动更新 taskkill 掉 app-server，
// 插件自动重启新进程后，resume 恢复的回合以 background turn 方式在服务端真实
// 执行完毕（工具调用/commit 全部落地），但 session/event 零下发——前端只认
// 终止帧收尾，转圈永不停；用户手动 stop 也因回合已结束而空转。看门狗用
// messages 快照对账兜底这条"服务端跑完、前端不知道"的断链。

/**
 * 剔除消息流顶部的 model_change marker（2026-09-03 db.sqlite 实测）：置顶 marker =
 * 插件建会话后 applyModelIfReady 自动 setModel 注册持久模型的固有落库（服务端记
 * 「会话默认模型→注册模型」），不是用户切换——新 CLI 近期版本还带 fromModel
 * （连 from==to 都记），「无 fromModel」判据失效，改按位置判定：真实切换必然
 * 发生在首条消息之后，顶部的连续 marker 整段剔除不渲染
 */
function stripLeadingModelChangeMarkers(messages: ZCodeMessage[]): ZCodeMessage[] {
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    const parts = m.parts ?? []
    const isMarker =
      m.info.role === 'assistant' &&
      parts.length > 0 &&
      parts.every((p) => p.type === 'timeline') &&
      parts.some((p) => p.type === 'timeline' && p.timelineType === 'model_change')
    if (!isMarker) break
    i++
  }
  return i > 0 ? messages.slice(i) : messages
}

/**
 * 归一目标状态（服务端 target + goalStats → GoalState）：goalStats 无
 * objective/status，目标文本与状态只来自 target；两源任一缺失时取另一源，
 * 全空返回 null（无目标）。
 */
function toGoalState(
  target: unknown,
  goalStats: unknown,
  prev?: GoalState | null,
): GoalState | null {
  const t = (target ?? null) as Record<string, unknown> | null
  const s = (goalStats ?? null) as Record<string, unknown> | null
  if (!t && !s) return null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const newTargetId = typeof t?.targetID === 'string' ? t.targetID : typeof t?.targetId === 'string' ? t.targetId : null
  // 目标切换（replace 新 target）：服务端按 target 独立记账（sqlite 实测
  // session_target 每行独立 tokens_used/time_used_seconds），新目标统计从零起
  // ——统计 0/摘要缺失是真实值，不能回退 prev 旧目标的值（|| 链曾把权威 0 吞成
  // 旧值，replace 后卡片耗时永远不重置，0.3.2 真机反馈）。乐观占位 targetId=''
  // 不算切换（统计本就从零）
  const switched = prev != null && newTargetId != null && prev.targetId !== '' && prev.targetId !== newTargetId
  const fallback = switched ? null : prev ?? null
  const objective = typeof t?.objective === 'string' ? t.objective : fallback?.objective ?? ''
  if (!objective && !t) return prev ?? null
  return {
    targetId: newTargetId ?? fallback?.targetId ?? '',
    objective,
    summaryTitle: (t?.summaryTitle as string | null | undefined) ?? fallback?.summaryTitle ?? null,
    status: typeof t?.status === 'string' ? t.status : fallback?.status ?? 'active',
    tokensUsed: num(t?.tokensUsed) || num(s?.tokensUsed) || (fallback?.tokensUsed ?? 0),
    timeUsedSeconds: num(t?.timeUsedSeconds) || num(s?.timeUsedSeconds) || (fallback?.timeUsedSeconds ?? 0),
    tokenBudget: (typeof t?.tokenBudget === 'number' ? t.tokenBudget : null) ?? fallback?.tokenBudget ?? null,
    iterationCount: num(s?.iterationCount) || num(t?.iterationCount) || (fallback?.iterationCount ?? 1),
    toolCallCount: num(s?.toolCallCount) || fallback?.toolCallCount,
    // 走秒基准：本地从该时刻起在服务端值上递增显示（事件间隔内可见流逝）
    syncedAt: Date.now(),
  }
}

/**
 * 目标模式 payload 落地（session.updated 实时推进，批量/单推两路共用）：
 * 用 target 全量覆盖 + goalStats 缺省时的统计保持。usage_accounted（token
 * 计账）等仅统计变化的事件也走全量（payload.target 本是完整对象）。
 * 非当前会话的事件忽略（多标签隔离与现有事件门禁一致）。
 *
 * 轮边界联动（0.3.2 实测修复）：run_finished → 卡片转"校验中"（verifying）；
 * run_started / cleared / 终态 complete → 定向重拉 messages（goalRefresh）——
 * 常规 turnEnded 重拉会撞续轮 streaming 守卫被丢，校验分隔卡（timeline part，
 * 仅落库不进事件流）会滞后到 goal 全部结束才可见。
 */
function applyGoalTargetPayload(
  gp: { action: string; target: Record<string, unknown> | null },
  sessionId: string,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  const st = get()
  if (sessionId && sessionId !== st.currentSessionId) return
  const next = toGoalState(gp.target, undefined, st.goal)
  if (next) {
    // 校验窗口：run_finished（一轮跑完）→ 下一轮 run_started / 终态清除
    next.verifying = gp.action === 'run_finished' && next.status !== 'complete' ? true : undefined
    set({ goal: next })
  } else {
    set({ goal: null })
  }
  if (gp.action === 'run_started' || gp.action === 'cleared' || next?.status === 'complete') {
    scheduleGoalRefresh(sessionId)
  }
}

/**
 * 目标模式轮边界定向重拉（防抖合并）：延迟 800ms 等校验 part 落库稳定。
 * 与常规 turnEnded 重拉的区别：goalRefresh 标记让 case 'messages' 在 streaming
 * 中不丢弃，改走增量合并（新消息插到流式消息前，不顶掉流式内容）。
 */
let goalRefreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleGoalRefresh(sessionId: string) {
  if (goalRefreshTimer) clearTimeout(goalRefreshTimer)
  goalRefreshTimer = setTimeout(() => {
    goalRefreshTimer = null
    const st = useStore.getState()
    if (st.currentSessionId !== sessionId) return
    sendToJava({ op: 'messages', sessionId, workspacePath: st.currentWorkspacePath, goalRefresh: true })
  }, 800)
}

/** goal 校验消息判据（timeline goal_verification part，两阶段落库的唯一消息形态） */
function isGoalVerifyMessage(m: ZCodeMessage): boolean {
  return (m.parts ?? []).some(
    (p) => p.type === 'timeline' && (p as { timelineType?: string }).timelineType === 'goal_verification',
  )
}

/** 校验消息的 verification 内容（两阶段落库回填前为空，内容比较判据） */
function goalVerificationOf(m: ZCodeMessage): unknown {
  const p = (m.parts ?? []).find(
    (x) => x.type === 'timeline' && (x as { timelineType?: string }).timelineType === 'goal_verification',
  )
  return (p as { verification?: unknown }).verification ?? null
}

/** user 消息纯文本（goal 乐观消息与服务端真身的同文本判据） */
function userTextOf(m: ZCodeMessage): string {
  return (m.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('')
}

/**
 * goalRefresh 快照的增量合并（streaming 中的专用路径）：只取前端还没有的消息
 * （上一轮的校验分隔卡/控制消息），插到流式消息之前——全量替换会抹掉流式内容
 * （同 case 'messages' streaming 守卫的断流/叠字风险），追加到末尾则时间倒挂。
 */
function mergeGoalRefreshSnapshot(
  msg: { messages: ZCodeMessage[]; goalTarget?: unknown; goalStats?: unknown },
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  const st = get()
  // 同 id 的本地空壳（goal 记账/校验轮 turn.started 建立的乐观 assistant，零
  // delta 残留，id 与落库真身相同）用 incoming 权威版替换——真身带 timeline
  // part 走分隔卡渲染；旧逻辑按 id 一律滤掉真身，空壳顶位渲染成
  // "已工作 0 秒 / 0 in 0 out" 的 footer 气泡（0.3.2 真机反馈）
  const replaceableIds = new Set<string>()
  // 校验消息两阶段落库（sqlite 实测：工作轮结束即建占位、verification 空，
  // 校验完成 ~7-20s 后才回填）——回填版须覆盖本地 pending 空形态（否则校验卡
  // 滞后到下一轮轮末重拉，缺陷AY）。但必须**原位覆盖**且仅内容变化时替换：
  // 挪到 incoming 统一插入位（流式消息前）会把已就位的校验卡每轮拔起、
  // 全部堆叠到最新轮次处（缺陷AY 修复回归，0.3.2 真机第二轮实测）
  const backfillById = new Map<string, ZCodeMessage>()
  const incoming = mergeTurnMessages(
    stripLeadingModelChangeMarkers(
      preserveAskUserDurations(msg.messages, st.messages, st.askAnsweredAt, st.askAskedAt).filter((m) => !isHiddenSyntheticMessage(m.info)),
    ),
  ).filter((m) => {
    const hit = st.messages.find((x) => x.info.id === m.info.id)
    if (!hit) return true
    if (hit.info.role === 'assistant' && (hit.parts ?? []).length === 0) {
      replaceableIds.add(m.info.id)
      return true
    }
    if (isGoalVerifyMessage(hit) && isGoalVerifyMessage(m)) {
      if (JSON.stringify(goalVerificationOf(hit)) !== JSON.stringify(goalVerificationOf(m))) {
        backfillById.set(m.info.id, m)
      }
      return false
    }
    return false
  })
  // goal set 乐观用户消息（local_u_）与服务端真身同文本双条防护：常规路径 user
  // 真身与流式 assistant 撞 turn.started 的 messageId 被上方 id 集合滤掉（无害，
  // 乐观版顶着），此兜底覆盖 turn.started 未带 messageId（fallback id 不撞）的场景
  const incomingUserTexts = new Set(
    incoming.filter((m) => m.info.role === 'user').map(userTextOf),
  )
  let base = replaceableIds.size > 0
    ? st.messages.filter((x) => !replaceableIds.has(x.info.id))
    : st.messages
  // 校验回填原位覆盖（位置不动、只换内容——插入式替换会造成历史校验卡堆叠）
  if (backfillById.size > 0) {
    base = base.map((x) => backfillById.get(x.info.id) ?? x)
  }
  if (incomingUserTexts.size > 0) {
    const deduped = base.filter(
      (m) => !(m.info.role === 'user' && m.info.id.startsWith('local_u_') && incomingUserTexts.has(userTextOf(m))),
    )
    if (deduped.length !== base.length) base = deduped
  }
  const patch: Partial<StoreState> = {}
  if (incoming.length > 0) {
    const idx = base.findIndex((m) => m.info.id === st.streamingMessageId)
    patch.messages = idx >= 0
      ? [...base.slice(0, idx), ...incoming, ...base.slice(idx)]
      : [...base, ...incoming]
  } else if (base !== st.messages) {
    patch.messages = base
  }
  // goal 统计校准（token/轮次随轮边界刷新；verifying 由事件流维护——目标仍
  // active 且此前校验中则保持，同 applyMessagesSnapshot 的快照保持规则）
  if ('goalTarget' in msg || 'goalStats' in msg) {
    const next = toGoalState(msg.goalTarget, msg.goalStats, st.goal)
    if (next && st.goal?.verifying && next.status === 'active') next.verifying = true
    patch.goal = next
  }
  if (Object.keys(patch).length > 0) set(patch)
}

/**
 * AskUserQuestion 时长保护（工具卡恒 0.0 秒的修复）：服务端快照/落库里该工具的
 * state.time 是"应答后瞬时口径"——db.sqlite 实测（diag session/messages 直连核对）
 * end-start≈3ms 且 **start≈end**（服务端在用户应答后才写 time，start 并非提问时刻），
 * 真实等待窗口只在 part 行 time_created→time_updated，但协议不透出。可用来源：
 * 弹窗打开时刻（askAskedAt，recordAskUserAnswered 随应答时刻一并记录）与应答时刻
 * （askAnsweredAt），两者同为客户端时钟才可相减。本地流式 part 的 time.start 已被
 * 完成事件覆盖（kind=result 的服务端权威 startedAt=应答后瞬时值），只能兜底。
 * 快照落地（权威整包重拉与 messages 增量合并共用）按 callID 修复；历史会话首拉
 * 无本地记录，维持服务端口径（真实时长协议不可得，属预期）。
 */
export function preserveAskUserDurations(
  incoming: ZCodeMessage[],
  local: ZCodeMessage[],
  answeredAt: Record<string, number> = {},
  askedAtMap: Record<string, number> = {},
): ZCodeMessage[] {
  if (incoming.length === 0) return incoming
  // 来源1：本地实时 batch 收尾写入的真实时长（start=提问、end=应答后收尾到达）；
  // 来源2 的起点优先取 askAskedAt（弹窗时刻），本地流式起点仅兜底
  const localTimes = new Map<string, { start: number; end: number }>()
  const localStarts = new Map<string, number>()
  for (const m of local) {
    for (const p of m.parts ?? []) {
      if (p.type !== 'tool') continue
      const tp = p as ToolPart
      if (tp.tool !== 'AskUserQuestion') continue
      const t = tp.state?.time
      if (!t?.start) continue
      localStarts.set(tp.callID, t.start)
      if (t.end && t.end - t.start > 1000) localTimes.set(tp.callID, { start: t.start, end: t.end })
    }
  }
  // 来源2：弹窗应答时刻 + 弹窗打开时刻。batch 可能被"重拉先落地 + 已有终态不覆盖
  // 守卫"跳过，本地 end 不可用；快照与本地流式 part 的 start 都可能是应答后口径
  // （result 分支 startedAt 权威覆盖），真实提问起点以 askAskedAt 为准
  const hasAnswer = Object.keys(answeredAt).length > 0
  const hasAsked = Object.keys(askedAtMap).length > 0
  if (localTimes.size === 0 && localStarts.size === 0 && !hasAnswer && !hasAsked) return incoming
  return incoming.map((m) => {
    if (!(m.parts ?? []).some((p) => p.type === 'tool' && (p as ToolPart).tool === 'AskUserQuestion')) return m
    return {
      ...m,
      parts: m.parts!.map((p) => {
        if (p.type !== 'tool') return p
        const tp = p as ToolPart
        if (tp.tool !== 'AskUserQuestion') return p
        const t = tp.state?.time
        if (!t?.start) return p
        const lt = localTimes.get(tp.callID)
        if (lt) {
          if (t.end && t.end - t.start >= lt.end - lt.start) return p
          return { ...tp, state: { ...tp.state, time: { start: lt.start, end: lt.end } } } as ToolPart
        }
        const ans = answeredAt[tp.callID]
        const realStart = askedAtMap[tp.callID] ?? localStarts.get(tp.callID)
        if (ans && realStart && ans > realStart && (!t.end || t.end - t.start < 1000)) {
          return { ...tp, state: { ...tp.state, time: { start: realStart, end: ans } } } as ToolPart
        }
        return p
      }),
    }
  })
}

/** messages 响应的权威落地（常规重拉与对账收尾共用） */
/**
 * 流式中快照到达的通知卡摘取合并（缺陷CI）：只取「本地还没有 + 通知白名单
 * （isAgentNotification）」的合成消息，插到流式气泡之前；其余快照内容一律不
 * 落地（防断流/叠字，见 case 'messages' 守卫注释）。通知是唯一在回合中「服务端
 * 已落库、本地时间线却无从得知」的消息族（CLI 注入转录不发流式事件），按白
 * 名单摘取不会把过期快照的历史改写冲进流式。顺手跑通知收尾（幂等，仅 running
 * 可翻转），底部栏与子代理活动卡随通知及时落定，不等轮末。
 *
 * wake 轮 id 撞车特例（2026-09-20 真机 12:53 实锤）：turn.started 会借用「触发
 * 本轮的那条用户消息」的 id 给本地流式气泡（叠字守卫注释的同款机制），而 wake
 * 轮的触发消息恰是 task-notification 本身——流式气泡顶着通知真身 id，按 id 去
 * 重会把通知拦掉（卡片只能等轮末全量替换）。故撞 id 的通知以 local_n_ 前缀
 * 副本插入，真身 id 登记防重；权威快照落地（全量替换）时清空，真身回归接管。
 */
let midTurnInsertedNotifIds = new Set<string>()
function mergeNotificationsMidTurn(
  msg: { messages: ZCodeMessage[] },
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
): void {
  const st = get()
  const knownIds = new Set(st.messages.map((m) => m.info.id))
  // 撞 id 放行：wake 轮流式气泡占用通知真身 id（id 已在 knownIds），不能在
  // 此处拦掉——它是转 local_n_ 副本的唯一来源
  const incoming = msg.messages.filter(
    (m) => !midTurnInsertedNotifIds.has(m.info.id)
      && isAgentNotification(m.info)
      && (!knownIds.has(m.info.id) || m.info.id === st.streamingMessageId),
  )
  if (incoming.length === 0) return
  const snapshot = msg.messages
  // 仅撞 id 的通知转 local_n_ 副本（真身 id 被流式气泡占用）；其余真身直插，
  // 后续快照按 knownIds 自然去重
  const insertables = incoming.map((m) => {
    if (m.info.id === st.streamingMessageId) {
      midTurnInsertedNotifIds.add(m.info.id)
      return { info: { ...m.info, id: `local_n_${m.info.id}` }, parts: m.parts }
    }
    return m
  })
  // 插入点按快照自身时序（缺陷EG）：转录里的位置是权威——从通知在快照中的位
  // 置向前找最近一个已在实时时间线的前驱，插到它之后。回合中途到达 → 前驱是
  // 流式气泡本体（插其后，时序正确，不再顶到整条在途回合上方）；wake 轮场景 →
  // 前驱是被切断的前段消息（即流式气泡之前，CI 原语义）。快照里找不到任何前驱
  // 时退回旧口径（流式气泡之前/追加尾部）
  const streamIdx = st.streamingMessageId
    ? st.messages.findIndex((m) => m.info.id === st.streamingMessageId)
    : -1
  let live = [...st.messages]
  for (const item of insertables) {
    const baseId = item.info.id.startsWith('local_n_') ? item.info.id.slice(8) : item.info.id
    const sIdx = snapshot.findIndex((m) => m.info.id === baseId)
    let at = -1
    if (sIdx > 0) {
      for (let j = sIdx - 1; j >= 0 && at < 0; j--) {
        const li = live.findIndex((m) => m.info.id === snapshot[j].info.id)
        if (li >= 0) at = li + 1
      }
    }
    if (at < 0) at = streamIdx >= 0 ? streamIdx : live.length
    live.splice(at, 0, item)
  }
  const patch: Partial<StoreState> = {
    messages: live
  }
  const activities = finalizeActivitiesFromNotifications(st.subagentActivities, incoming, Date.now())
  if (activities !== st.subagentActivities) patch.subagentActivities = activities
  set(patch)
}

/**
 * 孤儿 running 子代理纠偏（重开恒「运行中」）：回合被强杀/中断时服务端只给
 * turnHeader 写 completedInterrupted 终态，回合内 Agent 工具 part 在转录里
 * 永远停在 running（无 output、time.end 缺失）。非流式落地时改写为 interrupted
 * ——session/subagents 只枚举子代理会话，孤儿 part 没有可匹配的权威条目
 * （diag-subagent-ghost-running.py 实测：RPC running=0/ended=6 全 success，
 * 转录却遗留 11 个 running part），不纠偏则子代理卡/底部栏重开后恒转圈。
 * 流式中的 running 是真实的，不动——重开运行中会话的首拉在途时 streaming
 * 已由 EA 相位投影先置位，不会误伤真在跑的子代理。仅限子代理族工具：
 * Bash 等的 running 有轮末权威快照终态，不受强杀影响，不碰。
 */
function markInterruptedAgentParts(messages: ZCodeMessage[]): void {
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type !== 'tool') continue
      if (part.tool !== 'Agent' && part.tool !== 'Task' && part.tool !== 'subagent') continue
      if (part.state?.status === 'running' || part.state?.status === 'pending') {
        part.state = { ...part.state, status: 'interrupted' }
      }
    }
  }
}

function applyMessagesSnapshot(
  msg: { messages: ZCodeMessage[]; goalTarget?: unknown; goalStats?: unknown },
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  // 全量替换落地 = 真身消息接管时间线，流式期插入的本地通知副本（local_n_）与
  // 防重登记一并作废（缺陷CI，见 mergeNotificationsMidTurn）
  midTurnInsertedNotifIds.clear()
  const st = get()
  // 过滤 model-only 合成消息（todo_reminder 等，2026-08-15 误渲染成
  // "子代理完成"卡片的根源）——只影响展示，下方派生计算仍用原始全量。
  // 同轮 turn 的多条 assistant step 合并为一条（耗时/token 取整轮），
  // 否则重拉后"已工作"塌缩成最后一个 step 的耗时。
  // 编辑截断记忆重放（快照不反映 rewind——diag-rewind-meta.py 实测服务端
  // Rbt 过滤链缺 createdMessageID，目标轮原样返回；按 kv 记录轮删除还原）。
  // v4 通道的 cut 先经 staged 判别提交（2026-09-12 真机实锤：回合中编辑是就地
  // 改写语义、快照自行截断且新消息复用同 id——无判别落 kv 会把新轮删光=空白主屏）
  const sid = get().currentSessionId
  if (sid) commitStagedRewindCuts(sid, msg.messages)
  // 孤儿 running 子代理纠偏：必须先于 refreshStatus/parseAgents 派生（否则
  // agents 账本照旧解析出 running），msg.messages 为 RPC 新反序列化对象，可原地改
  if (!get().streaming) markInterruptedAgentParts(msg.messages)
  // v2 模型名回填（缺陷BW）：v2 assistant info 的 modelId/providerId 若连这个都没有
  //（老包 v2 会话，字段重命名前落库），用 state.updated 缓存的会话实际模型补末条连续
  // 缺失的 assistant 消息（任一形态有值都不动——db 字段重命名后快照自带）
  const rtModel = sid ? sessionRuntimeModels[sid] : undefined
  if (rtModel) {
    for (let i = msg.messages.length - 1; i >= 0; i--) {
      const m = msg.messages[i]
      if (m.info.role !== 'assistant') break
      if (m.info.modelID || m.info.modelId) break
      msg.messages[i] = { ...m, info: { ...m.info, modelID: rtModel.modelId, providerID: rtModel.providerId || m.info.providerID } }
    }
  }
  const visibleMessages = applyRewindCuts(
    mergeTurnMessages(
      stripLeadingModelChangeMarkers(
        preserveAskUserDurations(msg.messages, st.messages, st.askAnsweredAt, st.askAskedAt).filter((m) => !isHiddenSyntheticMessage(m.info)),
      ),
    ),
    sid ? loadRewindCuts(sid) : [],
  )
  // 通知扫描：转录里出现 task-notification 而活动还停在 running（子会话流与
  // 生命周期钩子都错过的场合，如重启恢复）→ 自愈收尾并拉权威列表补齐
  const activities = finalizeActivitiesFromNotifications(st.subagentActivities, msg.messages, Date.now())
  const patch: Partial<StoreState> = {
    messages: visibleMessages,
    loadingMessages: false,
    ...refreshStatus(msg.messages, activities, st.subagents),
  }
  // 目标模式状态随快照恢复（Kotlin 端 session/read → session.target+goalStats；
  // 对账探测响应不带 goal 字段，保持现值）
  if ('goalTarget' in msg || 'goalStats' in msg) {
    const next = toGoalState(msg.goalTarget, msg.goalStats, st.goal)
    // 快照不含"校验中"信号（事件流独有）：目标仍 active 且此前校验中 → 保持显示
    //（run_started 事件显式清除；回合结束 300ms 常规重拉曾把 verifying 冲掉，
    // 轮间隙 30s+ 的"校验中"指示因此闪失——0.3.2 真机实测）
    if (next && st.goal?.verifying && next.status === 'active') next.verifying = true
    patch.goal = next
  }
  // currentModel 为 null 时从消息推断（兼容历史会话 / CLI 默认模型，解除空会话发送限制）
  if (!get().currentModel) {
    const inferred = inferCurrentModel(msg.messages, get().models)
    if (inferred) patch.currentModel = inferred
  }
  // currentMode 为 null 时从消息推断（settings 拉取前的兜底显示）
  if (!get().currentMode) {
    const mode = inferCurrentMode(msg.messages)
    if (mode) patch.currentMode = mode
  }
  if (activities !== st.subagentActivities) patch.subagentActivities = activities
  // 合成 model_change 分隔卡的存活接管：延迟切换（缺陷AC）在回合结束后补发落地，
  // 合成卡插入后紧跟回合结束重拉——快照里还没有 marker（服务端下次 send 才落库），
  // 整包替换会顶掉合成卡。此处补挂暂存中快照未见真身的合成卡；快照出现同目标
  // 模型的 marker 即认为服务端真身已落库，从暂存移除（防双条，由真身接管显示）
  const pendingSynthetic = st.syntheticModelChanges[get().currentSessionId ?? '']
  if (pendingSynthetic?.length) {
    // 匹配扫描用 strip 后的数组：顶部注册 marker（被剔除不显示）不参与真身判定，
    // 否则会把「切回注册模型」的延迟合成卡误摘（真身 marker 尚未落库，卡就丢了）
    const serverMarkerTos = new Set(
      visibleMessages.flatMap((m) =>
        (m.parts ?? []).flatMap((p) =>
          p.type === 'timeline' && p.timelineType === 'model_change'
            ? [p.toModel?.modelId ?? p.toModel?.modelID].filter((v): v is string => !!v)
            : [],
        ),
      ),
    )
    const keep = pendingSynthetic.filter(
      (c) => !c.parts.some((p) => p.type === 'timeline' && serverMarkerTos.has(p.toModel?.modelId ?? '')),
    )
    if (keep.length !== pendingSynthetic.length) {
      patch.syntheticModelChanges = {
        ...st.syntheticModelChanges,
        [get().currentSessionId ?? '']: keep,
      }
    }
    if (keep.length > 0) patch.messages = [...(patch.messages as ZCodeMessage[]), ...keep]
  }
  set(patch)
  if (activities !== st.subagentActivities) get().loadSubagents()
  // 权威消息 id 已就位：①flush 挂起的逐轮更改事件（流式轮收尾时乐观 id 匹配不上的那批）
  // ②已有条目键重锚定（流式壳 id→真身 id 漂移自愈，防「结束瞬间出现→被重拉顶掉」）
  flushPendingTurnFileChanges(set, get)
  remapTurnFileChangeKeys(set, get)
}

/** 消息是否带非空正文（判定"末尾是完整 assistant 回复"用）*/
function hasVisibleText(m: ZCodeMessage): boolean {
  return (m.parts ?? []).some((p) => {
    if (p.type !== 'text') return false
    const text = (p as { text?: string }).text
    return typeof text === 'string' && text.trim().length > 0
  })
}

/** 快照指纹（长度 + 末条消息标识）：两次探测之间服务端是否有任何进展 */
function fingerprintMessages(raw: ZCodeMessage[]): string {
  const visible = raw.filter((m) => !isHiddenSyntheticMessage(m.info))
  if (visible.length === 0) return 'empty'
  const last = visible[visible.length - 1]
  return `${visible.length}:${last.info.id ?? ''}:${last.info.time?.created ?? ''}`
}

/**
 * 判定对账快照（内部维护连续无进展计数，仅在 streaming 期间调用）：
 * - ended：末尾是带正文的 assistant 回复 → 回合已在服务端完成
 * - dead：快照连续 STREAM_DEAD_PROBES 轮无变化且始终没有 assistant 产出 → 疑似流丢失
 * - progress：其他（工具步骤推进 / 静默长任务 / 服务端回合活跃）→ 继续等待，不打扰
 *
 * serverActive：usage 轮询（5s）确认服务端回合仍活跃（activeTurnId 有值且非滞后）。
 * 后台任务等待/长命令执行期间事件流静默、快照不动是常态（progress 事件被
 * backgrounded 拦截、工具未完成无新消息），若没有这个信号会被误判流丢失提前
 * 收尾（2026-08-25 实测：run_in_background 等待段 60s+ 静默，服务端 turn 仍挂起）。
 */
function classifyReconcileSnapshot(raw: ZCodeMessage[], serverActive: boolean): 'ended' | 'dead' | 'progress' {
  const fp = fingerprintMessages(raw)
  if (fp !== reconcileLastFingerprint) {
    reconcileLastFingerprint = fp
    reconcileDeadCount = 0
  }
  const visible = raw.filter((m) => !isHiddenSyntheticMessage(m.info))
  const last = visible[visible.length - 1]
  if (last && last.info.role === 'assistant' && hasVisibleText(last)) {
    // 服务端回合仍活跃时不判结束：流式消息已有正文 + 前台子代理/长工具执行中是
    // 合法静默（末条 assistant 带文本是常态而非回合终点）。此处提前收尾会清掉
    // streamingMessageId，子代理完成后的续写 delta 全被丢弃——主界面实时流丢失、
    // 回合结束权威重拉才一次性渲染（2026-08-31 实测）。回合真结束的权威判定 =
    // turn.completed 事件 / activeTurnId 消失，看门狗只兜真断流
    if (!serverActive) return 'ended'
    reconcileDeadCount = 0
    return 'progress'
  }
  // 服务端回合仍活跃 = 合法等待，清零无进展计数（真断流时回合结束 activeTurnId
  // 消失、快照出现完整回复或计数累计，两条路径都照常收尾）
  if (serverActive) {
    reconcileDeadCount = 0
    return 'progress'
  }
  reconcileDeadCount += 1
  return reconcileDeadCount >= STREAM_DEAD_PROBES ? 'dead' : 'progress'
}

function probeTurnState(): void {
  const st = useStore.getState()
  if (!st.streaming || !st.currentSessionId) return
  // mock/dev 数据源不会复现"服务端跑完但零事件"，不探测
  if (st.connectionStatus !== 'connected') return
  // 反向请求弹窗（AskUser / 计划审批）挂起期间豁免：等待用户应答是合法静默
  // （Java 侧最长 5 分钟），不应判流丢失提前收尾——否则审批超时路径被 60s 看门狗
  // 截胡（2026-08-20 实测缺陷P1）。askUserPendingActive 覆盖多标签同会话：
  // 弹窗只路由到一个标签，其余标签靠 Java 广播的标志豁免（缺陷P1+）
  if (st.askUser || st.exitPlanApproval || st.permissionRequest || st.askUserPendingActive) return
  // 压缩回合豁免：摘要生成期间事件流静默是常态（实测 63s+，大上下文更久），
  // 对账快照末尾无进展会被误判流丢失提前收尾
  if (st.compacting) return
  // 上一发探测仍在途（30s 未回视为丢失，放行重探）
  if (reconcileProbeInFlight && Date.now() - reconcileProbeSentAt < 30_000) return
  if (Date.now() - lastStreamActivityAt < STREAM_SILENCE_MS) return
  reconcileProbeInFlight = true
  reconcileProbeSentAt = Date.now()
  sendToJava({ op: 'messages', sessionId: st.currentSessionId, workspacePath: st.currentWorkspacePath, reconcile: true })
}

useStore.subscribe((s, prev) => {
  if (s.streaming === prev.streaming) return
  if (s.streaming) {
    lastStreamActivityAt = Date.now()
    reconcileDeadCount = 0
    reconcileLastFingerprint = ''
    if (!streamWatchTimer) {
      streamWatchTimer = setInterval(() => {
        if (!useStore.getState().streaming) {
          if (streamWatchTimer) clearInterval(streamWatchTimer)
          streamWatchTimer = null
          reconcileProbeInFlight = false
          return
        }
        probeTurnState()
      }, STREAM_PROBE_INTERVAL_MS)
    }
  } else if (streamWatchTimer) {
    clearInterval(streamWatchTimer)
    streamWatchTimer = null
    reconcileProbeInFlight = false
  }
})

// ===== GLM 额度定时刷新（每 1 分钟）=====
// 此前额度是纯懒加载（hover 悬浮栏 5min TTL / 打开用量页 / 手动点刷新），与对话
// 活动完全解耦，鼠标停在悬浮栏上时「上次刷新」纹丝不动。改为常驻 60s 轮询：
// 当前模型属于 GLM 套餐才拉（其他 provider 无 apiKey，拉了也只报错）；失败同样
// 更新 quotaFetchedAt（case 'quota'），时间戳始终反映最近一次尝试。首轮可能在
// currentModel 就绪前跳过，首屏显示仍由悬浮栏 hover 的懒加载兜底（quota 为空即拉）。
let quotaPollTimer: ReturnType<typeof setInterval> | null = null

// ===== 在途判定有界化（缺陷FM，2026-10-28）=====
// quotaLoading 只有 case 'quota' 应答到达才复位，此前轮询/懒加载守卫直接读它：
// 一次应答丢失（系统待机打断在途请求 / CEF 查询丢弃，真机实证卡死 4h52m）即永久
// 卡 true，轮询从此每分钟静默跳过。改为「quotaLoading 且发起未超 QUOTA_INFLIGHT_
// TIMEOUT_MS」才算在途，超时视为应答丢失放行重发——额度查询是幂等读，迟到应答
// 覆盖无竞态危害（后到的回包本就整包落地）。quotaRequestedAt 由 loadQuota 更新。
const QUOTA_INFLIGHT_TIMEOUT_MS = 90_000
let quotaRequestedAt = 0
/** 卡死告警每次卡死期只发一条（应答恢复到达、quotaLoading 观察为 false 时复位） */
let quotaInFlightWarned = false

/** getQuota 是否真在途：quotaLoading 且距发起未超时。悬浮栏 hover 懒加载同用此判定 */
export function isQuotaInFlight(): boolean {
  const st = useStore.getState()
  if (!st.quotaLoading) {
    quotaInFlightWarned = false
    return false
  }
  if (Date.now() - quotaRequestedAt < QUOTA_INFLIGHT_TIMEOUT_MS) return true
  if (!quotaInFlightWarned) {
    quotaInFlightWarned = true
    console.warn(`[store] getQuota 发起后 ${QUOTA_INFLIGHT_TIMEOUT_MS / 1000}s 无应答（疑似丢失），放行重发`)
  }
  return false
}

function startQuotaPolling(): void {
  if (quotaPollTimer) return
  quotaPollTimer = setInterval(() => {
    const st = useStore.getState()
    if (!isBigmodelProvider(st.currentModel?.providerId)) return
    if (isQuotaInFlight()) return // 上一次还在途（HTTP 最长 ~35s；超 90s 视为应答丢失放行重发）
    st.loadQuota()
  }, QUOTA_POLL_INTERVAL)
}
