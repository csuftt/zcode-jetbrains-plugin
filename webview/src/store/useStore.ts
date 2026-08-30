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
import { onMessage, onStreamEvent, onStreamBatch, sendToJava, initBridge, isInJcef, getWorkspacePath, getInitialSessionId } from '@/ipc/bridge'
import type { JavaResponse, SessionInfo, ZCodeMessage, StreamEvent, ModelOption, ModelManageProvider, TodoItem, AgentItem, FileChangeItem, QuotaData, ModelUsageData, ToolUsageData, UsageRange, AppUsageData, AppUsageRange, ContextBreakdownItem, ThoughtLevelInfo, SubagentActivity, SubagentInfo, ToolUpdatedPayload, MemoryFileInfo, SkillInfo, McpServerInfo, McpToolsState, McpLogEntry, EnvStatus, BrowserClearedSite, BrowserDataOverview, AgentDef, AgentDefInput, ImageAttachmentInput } from '@/types/messages'
import { applyStreamEvent, isSubagentToolEvent, applySubagentToolEvent, markActivityOutcome, finalizeActivitiesFromNotifications, asSubagentLifecycle, looksLikeQuotaError } from '@/utils/streamReducer'
import type { TurnErrorInfo, SubagentLifecyclePayload } from '@/utils/streamReducer'
import i18n from '@/i18n/config'
import { parseTodos, parseAgents, parseFileChanges, mergeAgentItems } from '@/utils/parseStatus'
import { isHiddenSyntheticMessage } from '@/utils/parseNotification'
import { mergeTurnMessages } from '@/utils/mergeTurnMessages'
import { getPersisted, setPersisted, removePersisted, entriesWithPrefix } from '@/utils/persist'
import { readEnhanceConfig } from '@/utils/enhanceConfig'
import { extractBackgroundTaskIdFromContent } from '@/utils/backgroundTask'

export type ConnectionStatus = 'connecting' | 'connected' | 'mock' | 'error'

/** GLM 套餐 providerId（有 apiKey 可查额度；悬浮栏与额度定时轮询共用判定）*/
export const GLM_PLAN_PROVIDER = 'builtin:bigmodel-coding-plan'

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

/** 润色/浏览器数据操作的兜底定时器句柄：回包或新请求发起时取消。
 *  不取消的话，残留定时器可在下一次同类请求的在途窗口内命中
 *  `get().xxx` 在途标志，误杀 loading 并注入上一次的错误文案 */
let enhanceTimer: number | undefined
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
    todos: [],
    agents: [],
    fileChanges: [],
    subagentActivities: [],
    subagents: [],
    subagentDetail: null,
    childMessages: {},
    childMessagesError: null,
    childSessionKeys: {},
    childLiveMessages: {},
    childStreamingIds: {},
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
/** 压缩回合结束：登记延迟 flush（快照落地即触发；1.5s 兜底防快照丢失卡队列）*/
function scheduleDeferredCompactFlush(sessionId: string): void {
  deferredCompactFlushSid = sessionId
  if (deferredCompactFlushTimer) clearTimeout(deferredCompactFlushTimer)
  deferredCompactFlushTimer = setTimeout(() => {
    deferredCompactFlushTimer = null
    const sid = deferredCompactFlushSid
    deferredCompactFlushSid = null
    // 切会话后不代发（队列随会话切换处理，旧会话的延迟意图作废）
    if (sid && sid === useStore.getState().currentSessionId) {
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

/** 排队消息（对话进行中 Enter 入队，回合结束自动发送；text 为拼好技能/文件引用的最终文本）*/
export interface QueuedMessage {
  id: string
  text: string
  /** 图片附件（随消息透传 session/send attachments）*/
  attachments?: ImageAttachmentInput[]
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

  // 运行环境（node / zcode.cjs / 凭证三件套）
  /** null = 尚未检测完成（init 异步拉取）；allOk=false 时主界面显示环境提醒条 */
  envStatus: EnvStatus | null
  /** envSave 请求进行中（设置页环境 tab 保存按钮禁用/转圈）*/
  envSaving: boolean
  /** EnvBanner「去设置」的跳转意图：App 切 settings 视图同时置位，BasicSettingsView 消费后清除 */
  pendingSettingsSection: 'env' | 'agents' | null

  // 会话
  sessions: SessionInfo[]
  /** 本地乐观标题（sessionId → 临时标题）：首条消息发送即占位，服务端正式标题到达即清除。内存态，不持久化（不能盖手动重命名）*/
  provisionalTitles: Record<string, string>
  currentSessionId: string | null
  currentWorkspacePath: string
  /** 建会话请求进行中（手动 + 或懒创建），期间防重入 */
  creatingSession: boolean
  /** 懒创建暂存的首条消息：无会话时发送 → 先建会话，createSession 响应后自动发出 */
  pendingFirstMessage: string | null
  /** 懒创建暂存的首条消息的图片附件（与 pendingFirstMessage 同生命周期）*/
  pendingFirstAttachments: ImageAttachmentInput[] | null
  /** 懒创建暂存首条消息的定时标记（定时消息在待命态触发懒创建时随行，徽标穿透）*/
  pendingFirstScheduledFireAt: number | null
  /** 待命态定时任务暂存：创建确认时先把会话建好（真实 sid 归属，防空串态跨标签串显），建好自动落库 */
  pendingScheduleCreation: { text: string; fireAt: number; providerId?: string; modelId?: string; keepCurrent?: boolean } | null
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
  /** 子会话完整消息缓存（childSessionId → messages，详情弹窗"原始过程"）*/
  childMessages: Record<string, ZCodeMessage[]>
  childMessagesLoading: boolean
  childMessagesError: string | null
  /** 已注册子会话（childSessionId → 聚合键）：spawned 通知/转发事件/RPC 三处注册，*/
  /** 注册后其原生事件流被实时归约（不再被 currentSessionId 过滤丢弃）*/
  childSessionKeys: Record<string, string>
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
  /** 排队消息（streaming 中 Enter 入队，回合结束自动发队头）*/
  queuedMessages: QueuedMessage[]
  /** 定时消息（全量镜像，UI 按 currentSessionId 过滤；权威列表在 Java 侧）*/
  scheduledMessages: ScheduledMessageItem[]
  /** 已发定时消息记录（Java 持久化镜像）：历史重拉/重启后按 sessionId+text 匹配补「定时执行」徽标 */
  firedHistory: ScheduledFiredRecord[]
  /** 已应用的最大 scheduledList 快照 ts（旧快照后到直接丢弃，防并发广播乱序把已移除项复活回镜像）*/
  lastScheduledListTs: number

  // 模型切换（config.json provider 注册表）
  models: ModelOption[]
  /** 当前会话选择的模型（persist 记忆）*/
  currentModel: { modelId: string; providerId: string } | null
  /** 已为该会话下发过 setModel（避免每次 messages 刷新重复下发）*/
  modelAppliedForSession: string | null
  /** 已选模型因清单变更失效被清除（防 inferCurrentModel 按模型名反查到别的 provider 复活；用户重选/切会话后复位）*/
  modelInvalidated: boolean

  // 运行时设置（session/read → settings：思考级别 + 权限模式）
  /** 思考级别（available 因模型而异，服务端权威）*/
  thoughtLevel: ThoughtLevelInfo | null
  /** 当前权限模式（build/edit/plan/yolo）*/
  currentMode: string | null
  /** 进入 plan 前的模式（缺陷E：ExitPlanMode 批准后即时恢复用，权威值由 state.updated/loadSettings 校正）*/
  prePlanMode: string | null
  /** 已为该会话下发过 setThoughtLevel（applyThoughtLevelIfReady 防重入）*/
  thoughtLevelAppliedForSession: string | null
  /** setModel 已发出、modelSet 未回的时间戳（期间到达的 settings 级别部分计算于旧模型，不可信；超时视为不在途）*/
  modelSwitchInFlightAt: number | null
  /** 回合中切换被 Java 挂起（缺陷AC延迟切换）：显示"本轮结束后生效"提示，补发 modelSet/modelSetFailed 清除 */
  modelPendingSwitch: { sessionId: string; modelId: string; providerId: string } | null
  /** 切换前模型（modelSetPending 回滚选中态用；modelSet/modelSetFailed 清除）*/
  modelSwitchPrevModel: { modelId: string; providerId: string } | null
  /** 信息条（区别于 lastError 的非错误提示：延迟切模型等），modelSet/modelSetFailed/切会话清除 */
  lastNotice: string | null
  /** createSession 级别补发被推迟暂存的级别（等 modelSet 落定后按新模型下发，防 -32603 竞态）*/
  pendingThoughtLevel: string | null

  // 上下文用量（session/read → runtime.contextUsage）
  /** hitRate = null 表示本 turn 暂无缓存统计（新 turn 开始、首次模型调用完成前），显示"—"*/
  contextUsage: { used: number; size: number; hitRate: number | null } | null
  /** 上下文构成明细（session/read → runtime.breakdown）*/
  contextBreakdown: ContextBreakdownItem[] | null

  // 额度（glm plan usage API → 设置视图 + 圆环 popover 用）
  quota: QuotaData | null
  quotaLoading: boolean
  /** quota 上次成功拉取时间戳（圆环 popover 缓存 TTL 用）*/
  quotaFetchedAt: number
  /** monitor HTTP 实际取 key 的渠道（用量页提示数据口径；成功响应携带）*/
  usageProvider: { id: string; name: string } | null

  // 记忆文件（设置视图「记忆」条目，Kotlin 端固定清单扫描）
  memoryFiles: MemoryFileInfo[] | null
  memoryLoading: boolean
  /** 正在创建的记忆文件路径（条目按钮 loading 用）*/
  memoryCreatingPath: string | null
  memoryError: string | null
  /** 「工作区记忆」开关（null=未加载；与 ZCode 客户端共用 ~/.zcode/v2/setting.json）*/
  memoryEnabled: boolean | null
  /** 开关切换请求在途（防重复点击）*/
  memoryToggling: boolean

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
  /** 正在切换启用状态的技能路径（卡片开关 loading + 防重复点击）*/
  skillTogglingPath: string | null
  skillsError: string | null

  // 提示词润色（InputBox 润色按钮 → generateText/CLI 通道 → 对比确认弹窗）
  enhancing: boolean
  /** 润色结果弹窗数据（null = 关闭；error 非 null = 失败态；model = 实际润色模型）*/
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

  // 模型管理清单（设置视图「模型」条目 = config.json provider→models 全量只读结构）
  modelProviders: ModelManageProvider[] | null
  modelManageLoading: boolean
  modelManageError: string | null
  /** 实际读取的 config.json 路径（随 dataBaseDir 重定向，展示/打开用）*/
  modelConfigPath: string | null
  /** 正在切换启用状态的 providerId（开关 loading + 防重复点击）*/
  modelTogglingId: string | null
  mcpLogsLoading: boolean

  // 用量明细曲线（model-usage / tool-usage）
  modelUsage: ModelUsageData | null
  toolUsage: ToolUsageData | null
  usageRange: UsageRange
  customStart: string | null
  customEnd: string | null
  /** 用量查询局部错误（凭证/HTTP 失败，不污染全局 lastError）*/
  usageError: string | null

  // 应用用量（usage/stats：app-server 本地聚合，含第三方模型，无 apiKey 依赖）
  appUsage: AppUsageData | null
  appUsageRange: AppUsageRange
  /** 应用用量查询局部错误（app-server 不可达/协议错误）*/
  appUsageError: string | null

  // AskUserQuestion 弹窗（deadlineMs = Java 侧应答超时时刻，弹窗倒计时用；旧链路可缺省）
  askUser: { requestId: string; toolName: string; questions: import('@/types/messages').AskUserQuestion[]; deadlineMs?: number } | null

  // ExitPlanMode 计划审批弹窗（服务端 interaction/requestUserInput，params = {input:{plan}}）
  exitPlanApproval: { requestId: string; plan: string; deadlineMs?: number } | null

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

  // actions
  init: () => void
  loadSessions: () => void
  selectSession: (session: SessionInfo) => void
  sendMessage: (text: string, attachments?: ImageAttachmentInput[], opts?: { scheduledFireAt?: number; scheduledProviderId?: string; scheduledModelId?: string }) => void
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
  /** 恢复归档会话（从回收站移回历史列表）*/
  restoreSession: (sessionId: string) => void
  /**
   * 历史列表打开会话前的定位查询：resolve true = Java 已激活该会话的宿主标签（跨标签跳转完成）；
   * false = 没有任何标签打开过它（调用方决定覆盖当前标签页还是新开）
   */
  locateSessionTab: (sessionId: string) => Promise<boolean>
  /** 历史列表「新标签页打开」：走 Java gotoSession 统一路径（定位已确认无宿主 → 必然新建标签）*/
  openSessionNewTab: (sessionId: string) => void
  stopStreaming: () => void
  /** 重命名会话（CLI 协议无 rename op，仅前端 persist 持久化）*/
  renameSession: (sessionId: string, title: string) => void
  /** 拉取可切换的模型列表（config.json）*/
  loadModels: () => void
  /** 手动刷新模型清单（下拉刷新按钮）：置 modelsRefreshing，响应后复位 */
  refreshModels: () => void
  /** 模型清单手动刷新进行中（下拉刷新按钮转圈标记）*/
  modelsRefreshing: boolean
  /** 切换当前会话模型（session/setModel）*/
  setModel: (modelId: string, providerId: string) => void
  /** 把 persist 记忆的模型下发给指定会话（models 列表已就绪时才生效）*/
  applyModelIfReady: (sessionId: string) => void
  /** 拉取当前会话的运行时设置（mode + thoughtLevel）*/
  loadSettings: () => void
  /** 待命态（无会话）按当前模型恢复缓存的思考级别集（预选显示用；有会话时无操作）*/
  hydrateThoughtLevelStandby: () => void
  /** 切换思考级别（session/setThoughtLevel，persist 记忆）*/
  setThoughtLevel: (level: string) => void
  /** 切换权限模式（session/setMode，不记忆——模式是即时意图，避免 plan 粘性）*/
  setMode: (mode: string) => void
  /** 把 persist 记忆的思考级别下发给指定会话（available 就绪且值仍有效时才生效）*/
  applyThoughtLevelIfReady: (sessionId: string) => void
  /** 拉取当前会话的上下文用量 */
  loadUsage: () => void
  /** 拉取额度（设置视图 + 圆环 popover 用）*/
  loadQuota: () => void
  /** 拉取记忆文件清单（设置视图「记忆」条目）*/
  loadMemoryFiles: () => void
  /** 创建缺失的记忆文件（写默认模板，Kotlin 侧自动用编辑器打开）*/
  createMemoryFile: (path: string) => void
  /** 切换「工作区记忆」开关（新会话生效）*/
  setMemoryEnabled: (enabled: boolean) => void
  /** 拉取浏览器设置快照（设置视图「浏览器」条目）*/
  loadBrowserConfig: () => void
  /** 清除内置浏览器数据（cache=保留 Cookie 与本地站点数据；all=全清）*/
  clearBrowserData: (mode: 'cache' | 'all') => void
  /** 拉取浏览器数据概览（「查看」按钮弹窗）*/
  loadBrowserOverview: () => void
  /** 关闭浏览器设置的错误提示 */
  clearBrowserError: () => void
  /** 拉取技能清单（设置视图「技能」条目）*/
  loadSkills: () => void
  /** 启用/禁用技能（写 config skill 节点，CLI 下次发现生效）*/
  toggleSkill: (path: string, enabled: boolean) => void

  // ============ 提示词润色 ============
  /** 触发润色（一次性 CLI headless 调用；结果经 enhancePromptResult 回填弹窗）*/
  enhancePrompt: (text: string) => void
  /** 关闭润色弹窗（保留原始或使用增强后的清理动作）*/
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
  /** 拉取模型管理清单（设置视图「模型」条目，config.json 只读结构）*/
  loadModelManage: () => void
  /** 切换 provider 启用/禁用（写 config.json enabled 字段，回包 modelToggled）*/
  toggleModelProvider: (providerId: string, enabled: boolean) => void
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
  /** 设置 EnvBanner「去设置」的跳转意图（BasicSettingsView 消费后清除）*/
  setPendingSettingsSection: (section: 'env' | 'agents' | null) => void
  /** 检测运行环境三件套（init 时 / 提醒条「重新检测」触发）*/
  checkEnv: () => void
  /**
   * 保存环境路径配置：undefined=不改该项，''=清除（回退自动探测）。
   * 后端验证（node spawn --version、cli 文件存在）失败不落盘，回 error（带 envStatus）。
   */
  saveEnvConfig: (nodePath?: string, cliPath?: string) => void
  /** 拉取当前会话的子代理列表（session/subagents RPC，权威状态）*/
  loadSubagents: () => void
  /** 打开子代理详情弹窗（key = Agent 工具 callID）*/
  openSubagentDetail: (key: string) => void
  /** 关闭子代理详情弹窗 */
  closeSubagentDetail: () => void
  /** 打开子代理报告弹窗（markdown = Agent 工具 part 的最终输出）*/
  openSubagentReport: (r: { callID: string; title: string; markdown: string }) => void
  /** 关闭子代理报告弹窗 */
  closeSubagentReport: () => void
  /** 打开通用 Markdown 预览弹窗（工具卡输出全文阅读）*/
  openMarkdownPreview: (p: { title: string; meta?: string; markdown: string }) => void
  /** 关闭通用 Markdown 预览弹窗 */
  closeMarkdownPreview: () => void
  /** 打开版本更新弹窗（What's New；已读标记写回由 App 关闭回调负责）*/
  openChangelog: () => void
  /** 关闭版本更新弹窗 */
  closeChangelog: () => void
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

let bridgeInitialized = false

export const useStore = create<StoreState>((set, get) => ({
  connectionStatus: 'connecting',
  lastError: null,
  projectPath: '',
  envStatus: null,
  envSaving: false,
  pendingSettingsSection: null,

  sessions: [],
  provisionalTitles: {},
  currentSessionId: null,
  currentWorkspacePath: '',
  creatingSession: false,
  pendingFirstMessage: null,
  pendingFirstAttachments: null,
  pendingFirstScheduledFireAt: null,
  pendingScheduleCreation: null,
  archivedSessions: [],
  archivedLoading: false,

  messages: [],
  loadingMessages: false,

  todos: [],
  agents: [],
  fileChanges: [],

  subagentActivities: [],
  subagents: [],
  subagentDetail: null,
  subagentReport: null,
  markdownPreview: null,
  changelogOpen: false,
  childMessages: {},
  childMessagesLoading: false,
  childMessagesError: null,
  childSessionKeys: {},
  childLiveMessages: {},
  childStreamingIds: {},

  streaming: false,
  streamingMessageId: null,
  waitingSince: null,
  compacting: false,
  backgroundTasks: {},
  queuedMessages: [],
  scheduledMessages: [],
  firedHistory: [],
  lastScheduledListTs: 0,
  askUser: null,
  exitPlanApproval: null,
  permissionRequest: null,
  askUserPendingActive: false,

  models: [],
  modelsRefreshing: false,
  currentModel: null,
  modelInvalidated: false,
  modelAppliedForSession: null,
  thoughtLevel: null,
  currentMode: null,
  prePlanMode: null,
  thoughtLevelAppliedForSession: null,
  modelSwitchInFlightAt: null,
  modelPendingSwitch: null,
  modelSwitchPrevModel: null,
  lastNotice: null,
  pendingThoughtLevel: null,
  contextUsage: null,
  contextBreakdown: null,
  quota: null,
  quotaLoading: false,
  quotaFetchedAt: 0,
  usageProvider: null,
  memoryFiles: null,
  memoryLoading: false,
  memoryCreatingPath: null,
  memoryError: null,
  memoryEnabled: null,
  memoryToggling: false,

  browserConfig: null,
  browserBusy: null,
  browserError: null,
  browserCleared: null,
  browserOverview: null,

  skills: null,
  enhancing: false,
  enhanceResult: null,
  subagentDefs: null,
  selectedAgent: null,
  agentSavedSignal: null,
  skillsLoading: false,
  skillTogglingPath: null,
  skillsError: null,

  mcpServers: null,
  mcpLoading: false,
  mcpChecking: false,
  mcpError: null,
  mcpToolsByServer: {},
  mcpLogs: null,
  mcpLogsLoading: false,

  modelProviders: null,
  modelManageLoading: false,
  modelManageError: null,
  modelConfigPath: null,
  modelTogglingId: null,
  modelUsage: null,
  toolUsage: null,
  usageRange: '7d',
  customStart: null,
  customEnd: null,
  usageError: null,
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
      window.onEnvStatusChanged = (status: EnvStatus) => set({ envStatus: status })
      // IDE 广播：其他标签切换 provider 启用/禁用后多标签同步（Panel broadcastModelChanges）。
      // 与 modelToggled 应答同款合并，但不碰 modelTogglingId（由本标签自己的应答清除）；
      // modelProviders 未加载（null，未开过模型管理页）时不初始化列表、仍重拉下拉；
      // 幂等（发起标签应答后广播再达一次无害）
      window.onModelsChanged = (changes: { providerId: string; enabled: boolean }[]) => {
        const byId = new Map(changes.map((c) => [c.providerId, c.enabled]))
        const providers = get().modelProviders?.map((p) =>
          byId.has(p.providerId) ? { ...p, enabled: byId.get(p.providerId)! } : p,
        )
        if (providers) set({ modelProviders: providers })
        get().loadModels()
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

    if (isInJcef()) {
      // 桥已就绪（热启动/刷新）：直接拉数据
      set({ connectionStatus: 'connected' })
      console.log(`[store] 桥已就绪，workspace=${ws || '(空)'}`)
      // 拉取反向请求挂起状态：页面刷新/重载会错过 Java 的 askUserPending 广播，
      // 看门狗豁免标志（askUserPendingActive）需重新同步
      sendToJava({ op: 'askUserPendingState' })
      // 定时消息列表水合（页面刷新/重载会错过 Java 广播）
      sendToJava({ op: 'scheduledList' })
      get().checkEnv()
      get().loadSessions()
      get().loadModels()
      startQuotaPolling()
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
        set({ connectionStatus: 'connected' })
        console.log(`[store] 桥就绪（轮询 ${bridgeRetries}×50ms），workspace=${ws || '(空)'}`)
        // 冷启动就绪同样拉取挂起状态（广播可能在桥注入前已错过）
        sendToJava({ op: 'askUserPendingState' })
        // 定时消息列表水合（同上）
        sendToJava({ op: 'scheduledList' })
        get().checkEnv()
        get().loadSessions()
        get().loadModels()
        startQuotaPolling()
        return
      }
      if (++bridgeRetries <= 40) {
        setTimeout(waitForBridge, 50)
        return
      }
      // 超时：dev 环境或桥注入异常，走 mock
      set({ connectionStatus: 'mock' })
      console.log(`[store] 桥等待超时，回退 mock，workspace=${ws || '(空)'}`)
      get().checkEnv()
      get().loadSessions()
      get().loadModels()
      startQuotaPolling()
    }
    waitForBridge()
  },

  loadSessions: () => {
    sendToJava({ op: 'listSessions', workspacePath: get().projectPath })
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
    const workspacePath = session.workspacePath || get().projectPath
    set({
      currentSessionId: session.sessionId,
      currentWorkspacePath: workspacePath,
      modelInvalidated: false, // 切会话后按新会话消息推断模型是合理行为，解除失效锁定
      modelPendingSwitch: null, // 旧会话的延迟切换提示不带到新会话（补发 modelSet 有 sessionId 守卫）
      modelSwitchPrevModel: null,
      lastNotice: null,
      ...sessionResetBase(),
      loadingMessages: true, // 切换后要拉取消息历史
      compacting: false,
      backgroundTasks: {},
      contextUsage: null, // 清空旧会话数据，等 getUsage 回来更新
      contextBreakdown: null,
      thoughtLevel: null, // 清空旧会话设置，等 getSettings 回来更新（currentMode 由 messages 推断兜底）
      subagentReport: null,
      markdownPreview: null,
      // 模型切换在途标记与推迟的级别补发绑定旧会话流程，切会话作废
      modelSwitchInFlightAt: null,
      pendingThoughtLevel: null,
    })
    // 切换会话时订阅事件流（带 workspacePath，Java 端 subscribe 前要先 resume 激活会话）
    sendToJava({ op: 'subscribe', sessionId: session.sessionId, workspacePath })
    sendToJava({ op: 'messages', sessionId: session.sessionId, workspacePath })
    // P2 让路（缺陷AB 优先级编排②）：用量/子代理不再与 P0 并发挤服务端会话队列，
    // 改由 messages 首拉落地后补发（见 case 'messages'）——忙窗口期间 P0 未成功
    // 则不补发，顶栏只剩一条"恢复中"提示
    // 拉取运行时设置（mode + 思考级别，级别列表随模型变化）
    get().loadSettings()
    // 会话切换后，把 persist 记忆的模型真正下发 setModel（见 models 响应里的 applyModelIfReady）
    get().applyModelIfReady(session.sessionId)
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
    const sendModel = schedModel
      ? { providerId: schedModel.providerId, modelId: schedModel.modelId }
      : cm
    // 受理定时指定模型时同步切换会话模型（下拉跟随、后续手动消息沿用）：本回合正确性
    // 由 send 自带 runtimeModel 保证；setModel 在回合中会被 Java 挂起至回合结束补发
    // （延迟切模型机制），互不冲突
    if (schedModel) get().setModel(schedModel.modelId, schedModel.providerId)
    sendToJava({
      op: 'send',
      sessionId: sid,
      text,
      workspacePath: get().currentWorkspacePath,
      ...(sendModel ? { providerId: sendModel.providerId, modelId: sendModel.modelId } : {}),
      ...(attachments?.length ? { attachments } : {}),
    })
    // 定时消息真发上报：Java 记入已发历史（持久化），历史重拉/重启后按 sessionId+text
    // 匹配补「定时执行」徽标——服务端消息本身不带任何定时标记
    if (opts?.scheduledFireAt != null) {
      sendToJava({ op: 'scheduledFired', sessionId: sid, text, fireAt: opts.scheduledFireAt })
    }

    // 本地把用户消息立即加入列表（不等 reload，体验更快）；
    // 图片附件同时以 image part 乐观展示（dataUrl 直连渲染）
    const userMsg: ZCodeMessage = {
      info: {
        role: 'user',
        time: { created: Date.now() },
        id: `local_u_${Date.now()}`,
        sessionID: sid,
        // 定时消息徽标（定时 HH:mm 执行）；历史重拉为服务端权威数据，不带此标记（预期）
        ...(opts?.scheduledFireAt ? { scheduledFireAt: opts.scheduledFireAt } : {}),
      },
      parts: [
        ...(attachments ?? []).map((a) => ({
          type: 'image' as const,
          mediaType: a.mimeType,
          dataUrl: `data:${a.mimeType};base64,${a.dataBase64}`,
          dataBase64: a.dataBase64,
          source: { kind: 'inline' as const, filename: a.filename },
        })),
        { type: 'text', text },
      ],
    }
    set((s) => ({ messages: [...s.messages, userMsg] }))

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
      set((s) => ({ messages: [...s.messages, userMsg] }))
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
    set({ messages: next, streamingMessageId: newStreamingId })
  },

  createSession: () => {
    // 防重入：建会话请求进行中不重复发（懒创建 + 手动 + 按钮共用）
    if (get().creatingSession) return
    set({ creatingSession: true })
    sendToJava({ op: 'createSession', workspacePath: get().projectPath })
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
      creatingSession: false,
      pendingFirstMessage: null,
      pendingFirstAttachments: null,
      pendingFirstScheduledFireAt: null,
      ...sessionResetBase(),
      compacting: false,
      backgroundTasks: {},
      contextUsage: null,
      contextBreakdown: null,
      thoughtLevel: null,
      currentMode: null,
      subagentReport: null,
      markdownPreview: null,
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
    sendToJava({ op: 'listArchivedSessions', workspacePath: get().projectPath })
  },

  archiveSession: (sessionId) => {
    sendToJava({ op: 'archiveSession', sessionId })
  },

  restoreSession: (sessionId) => {
    sendToJava({ op: 'restoreSession', sessionId })
  },

  locateSessionTab: (sessionId) =>
    new Promise<boolean>((resolve) => {
      // 单槽复用：上一笔在途请求按未找到放行（模态弹窗期间不会有并发定位，仅防极端连点挂死）
      pendingTabLocate?.(false)
      pendingTabLocate = resolve
      sendToJava({ op: 'locateSession', sessionId })
    }),

  openSessionNewTab: (sessionId) => {
    sendToJava({ op: 'gotoSession', sessionId })
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
      // 立即发送保持定时语义（徽标+指定执行模型），否则 queued 的定时消息在这里会丢标记
      get().sendMessage(target.text, target.attachments, target.scheduledFireAt != null
        ? {
            scheduledFireAt: target.scheduledFireAt,
            ...(target.scheduledModelId ? { scheduledProviderId: target.scheduledProviderId, scheduledModelId: target.scheduledModelId } : {}),
          }
        : undefined)
    }
  },

  sendScheduledNow: (id) => {
    const item = get().scheduledMessages.find((m) => m.id === id)
    if (!item) return
    // 乐观移除：点击即消失，不等 Java 广播（多面板/多线程广播乱序曾致卡片残留）
    set({ scheduledMessages: get().scheduledMessages.filter((m) => m.id !== id) })
    if (item.sessionId && get().currentSessionId === item.sessionId) {
      // 本面板正看该会话：直接走受理路径发送（与到点受理同一段代码，sendMessage 内部
      // 含 scheduledFired 上报），并 ack 让 Java 移除待发项——不再发 scheduledSendNow
      // （那会再走一轮 Java 分派推送，本面板二次受理导致重复发送）
      get().sendMessage(item.text, undefined, {
        scheduledFireAt: item.fireAt,
        ...(item.modelId ? { scheduledProviderId: item.providerId, scheduledModelId: item.modelId } : {}),
      })
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
    get().sendMessage(next.text, next.attachments, next.scheduledFireAt != null
      ? {
          scheduledFireAt: next.scheduledFireAt,
          ...(next.scheduledModelId ? { scheduledProviderId: next.scheduledProviderId, scheduledModelId: next.scheduledModelId } : {}),
        }
      : undefined)
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
    set((s) => ({
      sessions: s.sessions.map((x) => (x.sessionId === sessionId ? { ...x, title } : x)),
    }))
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
    if (cur && cur.modelId === modelId && cur.providerId === providerId) {
      const hadPending = !!get().modelPendingSwitch
      setPersisted('zcode.currentModel', JSON.stringify({ modelId, providerId }))
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
    // 记忆当前选择（persist 通道），切换会话后仍显示；无会话（懒创建待命态）也先记忆，
    // 会话建立后由 applyModelIfReady 真正下发（见 createSession 响应处理）
    setPersisted('zcode.currentModel', JSON.stringify({ modelId, providerId }))
    // 暂存翻转前模型：回合中切换会被 Java 挂起（modelSetPending），届时回滚选中态
    set({ currentModel: { modelId, providerId }, modelInvalidated: false, modelSwitchPrevModel: get().currentModel })
    // 待命态切模型：级别集随模型变化，按新模型重 hydrate（无缓存的模型 → 选择器隐藏）
    get().hydrateThoughtLevelStandby()
    const sid = get().currentSessionId
    if (!sid) return
    // 标记切换在途：期间到达的 settings 级别部分计算于旧模型（modelSet 响应时清除）
    set({ modelSwitchInFlightAt: Date.now() })
    sendToJava({ op: 'setModel', sessionId: sid, modelId, providerId })
  },

  applyModelIfReady: (sessionId) => {
    // 同一会话只下发一次（避免 messages 刷新重复触发）
    if (get().modelAppliedForSession === sessionId) return
    let saved: { modelId: string; providerId: string } | null = null
    try {
      const raw = getPersisted('zcode.currentModel')
      if (raw) saved = JSON.parse(raw)
    } catch { /* ignore */ }
    if (!saved) return
    // 等待 models 列表就绪，且记忆的模型仍在列表里（避免下发无效模型）
    const models = get().models
    if (models.length === 0) return
    const exists = models.some((m) => m.modelId === saved!.modelId && m.providerId === saved!.providerId)
    if (!exists) {
      // 记忆的模型已不在可选列表（典型：体验套餐 captcha 门控渠道被后端过滤，或配置已删）：
      // 兜底个人套餐首选、其次列表首个，并回写记忆——否则会话静默跑在服务端默认模型上、
      // 选择器空占位（2026-08-28 体验套餐过滤定案）
      const fb = models.find((m) => m.plan === 'personal') ?? models[0]
      const fallback = { modelId: fb.modelId, providerId: fb.providerId }
      setPersisted('zcode.currentModel', JSON.stringify(fallback))
      set({ currentModel: fallback, modelAppliedForSession: sessionId, modelSwitchInFlightAt: Date.now() })
      sendToJava({ op: 'setModel', sessionId, modelId: fallback.modelId, providerId: fallback.providerId })
      return
    }
    set({ currentModel: saved, modelAppliedForSession: sessionId })
    // 标记切换在途：期间到达的 settings 级别部分计算于旧模型（modelSet 响应时清除）
    set({ modelSwitchInFlightAt: Date.now() })
    sendToJava({ op: 'setModel', sessionId, modelId: saved.modelId, providerId: saved.providerId })
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
      prePlanMode: mode === 'plan'
        ? (prev && prev !== 'plan' ? prev : get().prePlanMode)
        : null,
    })
    if (!sid) return
    sendToJava({ op: 'setMode', sessionId: sid, mode })
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

  loadQuota: () => {
    set({ quotaLoading: true })
    sendToJava({ op: 'getQuota' })
  },

  loadMemoryFiles: () => {
    set({ memoryLoading: true, memoryError: null })
    sendToJava({ op: 'listMemoryFiles' })
  },

  createMemoryFile: (path) => {
    set({ memoryCreatingPath: path, memoryError: null })
    sendToJava({ op: 'createMemoryFile', path })
  },

  setMemoryEnabled: (enabled) => {
    // 防重复点击：上一次切换还在途中就忽略
    if (get().memoryToggling) return
    set({ memoryToggling: true, memoryError: null })
    sendToJava({ op: 'setMemoryEnabled', enabled })
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

  loadSkills: () => {
    set({ skillsLoading: true, skillsError: null })
    sendToJava({ op: 'listSkills' })
  },

  // ============ 提示词润色 ============
  enhancePrompt: (text) => {
    if (!text.trim() || get().enhancing) return
    // 模型优先级：设置→行为的润色专用模型 > 会话当前所选模型（专用模型失效由
    // 后端兜底回退默认 provider，结果回包 model 字段带实际用到的模型）
    const dedicated = readEnhanceConfig().enhanceModel
    const cm = dedicated ?? get().currentModel
    set({ enhancing: true, enhanceResult: { original: text, model: cm?.modelId } })
    sendToJava({
      op: 'enhancePrompt',
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

  clearEnhanceResult: () => {
    cancelEnhanceTimer()
    set({ enhancing: false, enhanceResult: null })
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
    sendToJava({ op: 'toggleSkill', path, enabled })
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

  loadModelManage: () => {
    set({ modelManageLoading: true, modelManageError: null })
    sendToJava({ op: 'modelManageList' })
  },

  toggleModelProvider: (providerId, enabled) => {
    if (get().modelTogglingId) return
    set({ modelTogglingId: providerId, modelManageError: null })
    sendToJava({ op: 'modelToggleProvider', providerId, enabled })
  },

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

  clearNotice: () => set({ lastNotice: null }),

  setPendingSettingsSection: (section) => set({ pendingSettingsSection: section }),

  checkEnv: () => {
    sendToJava({ op: 'checkEnv' })
  },

  saveEnvConfig: (nodePath?: string, cliPath?: string) => {
    set({ envSaving: true })
    // undefined 字段 JSON.stringify 自动省略 = 后端"不改该项"约定
    sendToJava({ op: 'envSave', nodePath, cliPath })
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
  // 三类弹窗互斥：报告 → 过程（openSubagentDetail）→ 报告 可来回切换，Escape 只关一个
  openSubagentReport: (r) => set({ subagentReport: r, subagentDetail: null, markdownPreview: null }),
  closeSubagentReport: () => set({ subagentReport: null }),
  // 通用 Markdown 预览与子代理弹窗同层互斥：叠着开两个 overlay，点哪关哪会很怪
  openMarkdownPreview: (p) => set({ markdownPreview: p, subagentDetail: null, subagentReport: null }),
  closeMarkdownPreview: () => set({ markdownPreview: null }),

  openChangelog: () => set({ changelogOpen: true }),
  closeChangelog: () => set({ changelogOpen: false }),

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

/**
 * 服务端标题是否仍是占位（未生成正式标题）：
 * 空 / 会话 id 本身 / sess_ 前缀（CLI 新会话初始 title 即会话 id）。
 */
function isDefaultSessionTitle(title: string | undefined, sessionId: string): boolean {
  const t = title?.trim()
  if (!t) return true
  return t === sessionId || t.startsWith('sess_')
}

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
    const modelId = info.modelID ?? info.model?.modelID
    if (modelId) {
      const providerId = info.providerID ?? info.model?.providerID ?? models.find((m) => m.modelId === modelId)?.providerId
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

/** 模型切换是否在途（setModel 已发出、modelSet 未回；5s 未回视为切换失败已过期）*/
function isModelSwitchInFlight(state: { modelSwitchInFlightAt: number | null }): boolean {
  return state.modelSwitchInFlightAt != null && Date.now() - state.modelSwitchInFlightAt < 5000
}

/**
 * 从 messages 重新解析状态面板数据（todos/agents/fileChanges），返回 store patch。
 * agents 三源合并：parseAgents（兜底）+ 实时聚合活动 + session/subagents RPC（权威）。
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

/** 后端消息归约（导出供测试直接驱动分发链路；运行时由 bridge onMessage 挂接）*/
export function handleResponse(
  msg: JavaResponse,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  switch (msg.op) {
    case 'listSessions': {
      // 标题合并优先级：手动重命名（persist）> 服务端正式标题（顺带清临时标题）
      // > 本地临时标题（乐观占位，见 sendMessage）> 上一帧完整标题（防服务端空值
      // 覆盖，见下）> 服务端占位（空/会话 id）
      const prevProvisionals = get().provisionalTitles
      const prevSessions = get().sessions
      const nextProvisionals = { ...prevProvisionals }
      const merged = msg.sessions.map((s) => {
        const stored = getPersisted(`zcode.sessionTitle.${s.sessionId}`)
        if (stored) {
          delete nextProvisionals[s.sessionId]
          return { ...s, title: stored }
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
      // 刚插入的新会话会被旧快照抹掉，header/历史列表退回会话 id 前缀。本地已有但快照
      // 缺失的会话保留（服务端权威数据由后续刷新校正；已删会话已被 sessionDeleted 过滤，
      // 不会在这里复活）
      const serverIds = new Set(merged.map((s) => s.sessionId))
      const staleLocal = get().sessions.filter((s) => !serverIds.has(s.sessionId))
      if (staleLocal.length) merged.push(...staleLocal)
      // 时间倒序统一收口：服务端快照整体有序，但本地的补插项（staleLocal 追加在尾、
      // 乐观新建插在头）会破坏全局顺序 → 按更新时间倒序重排（稳定排序，同时间戳保持原序）
      merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      set({ sessions: merged, provisionalTitles: nextProvisionals })

      // 会话恢复（仅多标签体系）：仅当标签有注入的初始会话（重启恢复）且会话仍存在时选中它。
      // 懒创建：新标签（无注入）/ 注入会话已删 → 保持无会话待命态，发首条消息时再建
      //（见 sendMessage），避免误点多开标签堆积空会话。注意：不走 localStorage（多标签
      // webview 同 origin 共享存储，lastSessionId 会互相覆盖导致新标签串到别的标签的会话）；
      // 恢复职责由 Java 侧 TabState 承担
      if (get().currentSessionId === null) {
        const initialId = getInitialSessionId()
        if (initialId) {
          const initial = merged.find((s) => s.sessionId === initialId)
          if (initial) {
            console.log(`[store] 恢复标签绑定的会话: ${initialId}`)
            get().selectSession(initial)
          } else {
            // 绑定的会话已被删除 → 待命态（TabState 的 sessionId 由后续懒建会话的 subscribe 更新）
            console.log('[store] 标签绑定的会话已不存在，保持无会话待命态')
          }
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
          workspacePath: get().projectPath,
          text: pendingSchedule.text,
          fireAt: pendingSchedule.fireAt,
          ...(pendingSchedule.modelId ? { providerId: pendingSchedule.providerId, modelId: pendingSchedule.modelId } : {}),
        })
        get().loadSessions()
        break
      }
      if (sid) {
        const ws = get().projectPath
        set({
          currentSessionId: sid,
          currentWorkspacePath: ws,
          creatingSession: false,
          pendingFirstMessage: null,
          pendingFirstAttachments: null,
          pendingFirstScheduledFireAt: null,
          pendingScheduleCreation: null,
          ...sessionResetBase(),
          compacting: false,
          backgroundTasks: {},
          contextUsage: null, // 清空旧会话数据，等 getUsage 回来更新
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
        // 新会话也按记忆模型下发 setModel（等 models 就绪，由 applyModelIfReady 内部判断）。
        // 懒创建首条消息在途时跳过独立 setModel：它与首回合在服务端赛跑会撞 -32603
        // Unsupported（08-29 定时触发实测：新会话 runtime 未注册任何 provider），
        // 模型注册与回合执行改由首条 send 携带的 runtimeModel 承担（send 已带 currentModel），
        // 仅标记已应用防 messages/models 刷新时重发
        if (!pendingFirst) {
          get().applyModelIfReady(sid)
        } else {
          set({ modelAppliedForSession: sid })
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
        set({ creatingSession: false, pendingFirstMessage: null, pendingFirstAttachments: null, pendingFirstScheduledFireAt: null, pendingScheduleCreation: null })
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
              ...sessionResetBase(),
              compacting: false,
              backgroundTasks: {},
              contextUsage: null,
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
      // 切走）不受理也不 ack → Java 侧 15s 超时降级直发
      const { id, sessionId: dueSid, text, scheduledFireAt, providerId, modelId } = msg as {
        id: string
        sessionId?: string
        text: string
        scheduledFireAt?: number
        providerId?: string
        modelId?: string
      }
      if (dueSid && get().currentSessionId !== dueSid) break
      get().sendMessage(text, undefined, scheduledFireAt != null
        ? {
            scheduledFireAt,
            ...(modelId ? { scheduledProviderId: providerId, scheduledModelId: modelId } : {}),
          }
        : undefined)
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

    case 'sessionTabLocated': {
      // 历史列表定位应答：found=true 时 Java 已激活宿主标签（跨标签跳转完成），
      // 发起标签的 HistoryView 拿到 true 后只需切回聊天视图
      const resolve = pendingTabLocate
      pendingTabLocate = null
      resolve?.(msg.found)
      break
    }

    case 'archivedSessions': {
      // 标题合并（persist 手动重命名优先，同 listSessions 逻辑简化版）
      const merged = msg.sessions.map((s) => {
        const stored = getPersisted(`zcode.sessionTitle.${s.sessionId}`)
        return stored ? { ...s, title: stored } : s
      })
      set({ archivedSessions: merged, archivedLoading: false })
      break
    }

    case 'messages': {
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
      if (msg.sessionId === get().currentSessionId) {
        // 流式进行中到达的重拉响应 = 过期快照：turn 结束触发的 300ms 延迟重拉，
        // 会落后于排队消息自动发出后已开启的新 turn（idea.log 2026-08-15 时序证据：
        // completed → flushQueue 发送 → 新 turn.started → 旧重拉才 resume/返回）。
        // 此时全量替换会抹掉流式中的 assistant 消息（断流），且 turn.started 借用的
        // messageId 与重拉后服务端 user 消息撞车时，AI delta 会叠进用户气泡（叠字）。
        // 丢弃——本轮 turn 结束还会再拉一次权威数据落地。
        if (get().streaming) break
        // 打开会话的首拉标志（selectSession 置位、下方快照落地复位）：P2 补发依据
        const firstFetch = get().loadingMessages
        applyMessagesSnapshot(msg, set, get)
        // P2 让路（缺陷AB 编排②）：首拉落地（P0 完成）后补发用量/子代理——不与
        // subscribe/messages 并发挤服务端会话队列；历史会话底部栏数据同样补齐
        if (firstFetch) {
          get().loadSubagents()
          get().loadUsage()
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
        const failed = !['completed', 'succeeded', 'success'].includes(s)
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

    case 'subscribed':
    case 'subscribedChild': // 子会话订阅 ack（事件流随 subscribeChild op 建立后自然到达）
      break

    case 'stopped':
      // 停止应答：立即复位等待态，不等终止帧（缺陷AD重审：V4 stop 流式期引擎不发
      // legacy 终止帧，面板合成帧/真实帧后到均幂等）。刻意不 flushQueue：停止意图=只收当前回合
      if (msg.sessionId === get().currentSessionId) {
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
        thoughtLevel: null,
        currentMode: null,
        subagentReport: null,
        markdownPreview: null,
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

    case 'error': {
      // 建会话失败（Java 外层 catch 回 error）：复位懒创建标志与暂存消息（防卡死、防误重试）
      // -32004（Session is not active）追加人话提示：CLI 升级/重启后的新进程里会话
      // 未激活，此前用户只看到协议原文不知道该怎么办（2026-08-19 升级中断实测）
      const sessionInactive = /Session is not active/i.test(msg.message)
      // -32010（A prompt is already running）：服务端回合悬挂，Java 已自动 stop+重发，
      // 走到前端说明自愈失败——提示可操作文案；且跳过 flushQueue（服务端 prompt 状态
      // 未清前队列下一条大概率再撞，会连环报错，2026-08-20 实测）
      const promptRunning = /-32010|prompt is already running/i.test(msg.message)
      // 会话级请求超时（缺陷AB 忙窗口）：resume 恢复带中断回合的会话时，app-server 对
      // 该会话的请求全部排队约 1~2 分钟后自愈；Java 侧已对 subscribe/setModel/settings
      // 延迟自动重试。追加指引防用户"一看报错就重启"（重启重新 resume 重新进窗口，
      // 永远观察不到自愈——2026-08-27 用户 b5756ab4 四轮重启全超时、放置 100s 自愈实测）
      const resumeBusy = /请求超时: session\//.test(msg.message)
      // 浏览器数据操作在途时一并取消其兜底定时器，防后续误报超时
      if (get().browserBusy) Array.from(browserBusyTimers.keys()).forEach(cancelBrowserBusyTimer)
      set({
        lastError: sessionInactive
          ? `${msg.message}；${i18n.t('app.sessionInactiveHint')}`
          : promptRunning
            ? `${msg.message}；${i18n.t('app.promptRunningHint')}`
            : resumeBusy
              ? `${msg.message}；${i18n.t('app.resumeBusyHint')}`
              : msg.message,
        // 环境前置检查失败（EnvCheckException/envSave 验证失败）：附带 envStatus 刷新提醒条
        ...(msg.envStatus ? { envStatus: msg.envStatus } : {}),
        envSaving: false,
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
        modelManageLoading: false,
        modelTogglingId: null,
        // 浏览器设置请求失败（如插件未安装）：页面内联提示（browserBusy 在途时才归属该页）
        ...(get().browserBusy ? { browserBusy: null, browserError: msg.message } : {}),
        ...(get().creatingSession ? { creatingSession: false, pendingFirstMessage: null, pendingFirstAttachments: null, pendingFirstScheduledFireAt: null, pendingScheduleCreation: null } : {}),
      })
      console.error('[store] Java 错误:', msg.message)
      // 错误清 streaming 后继续发队列下一条（排队意图明确；持续失败时用户可删队列项）；
      // -32010 例外：悬挂回合未清，队列再发必再撞
      if (!promptRunning) get().flushQueue()
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
      break
    }

    case 'askUser':
      // AskUserQuestion 弹窗（服务器反向请求 interaction/requestUserInput）
      console.log('[store] 收到 askUser:', msg.toolName, msg.questions)
      set({ askUser: { requestId: msg.requestId, toolName: msg.toolName, questions: msg.questions, deadlineMs: msg.deadlineMs }, askUserPendingActive: true })
      break

    case 'exitPlanApproval':
      // ExitPlanMode 计划审批弹窗：渲染 plan markdown，用户批准/拒绝
      console.log('[store] 收到 exitPlanApproval，plan 长度:', msg.plan?.length ?? 0)
      set({ exitPlanApproval: { requestId: msg.requestId, plan: msg.plan || '', deadlineMs: msg.deadlineMs }, askUserPendingActive: true })
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

    case 'ideTheme':
    case 'files':
      break

    case 'models':
      // modelsRefreshing 与 models 同帧复位（手动刷新的转圈标记，见 refreshModels）
      set({ models: msg.models, modelsRefreshing: false })
      // 模型清单变更后（设置页禁用 provider / Zcode 侧增删模型），已选模型若已不在
      // 列表 → 取消选择，下拉回占位提示让用户重新选；persist 记忆一并清除（防下次水合复活）。
      // modelInvalidated 同时置位：挡住下方 inferCurrentModel——它按消息 footer 的模型名
      // 反查第一个同 modelId 的 provider，会把"体验套餐 GLM-5.3"复活成"个人套餐 GLM-5.3"
      {
        const cur = get().currentModel
        if (cur && !msg.models.some((m) => m.modelId === cur.modelId && m.providerId === cur.providerId)) {
          removePersisted('zcode.currentModel')
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
            ? msg.models.find(
                (m) => m.modelId === inferred.modelId && m.providerId === inferred.providerId,
              ) ?? msg.models.find((m) => m.modelId === inferred.modelId)
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
      // 恢复记忆的模型选择（如仍在列表里）
      try {
        const saved = getPersisted('zcode.currentModel')
        if (saved && get().currentModel === null) {
          const parsed = JSON.parse(saved) as { modelId: string; providerId: string }
          if (msg.models.some((m) => m.modelId === parsed.modelId && m.providerId === parsed.providerId)) {
            set({ currentModel: parsed })
          }
        }
      } catch { /* ignore */ }
      // persist 无记忆时，从已有消息推断（models 刚加载，messages 推断可能因缺 providerId 失败）；
      // 失效清除过的选择不再推断（等用户重选）
      if (!get().modelInvalidated && !get().currentModel) {
        const inferred = inferCurrentModel(get().messages, msg.models)
        if (inferred) set({ currentModel: inferred })
      }
      // models 就绪后，若当前会话还没下发过 setModel → 真正下发（修复"选 deepseek 实际 GLM5"）
      {
        const sid = get().currentSessionId
        if (sid) get().applyModelIfReady(sid)
      }
      // 待命态：currentModel 刚水合，按它恢复缓存的级别集（ThoughtLevelSelect 预选显示）
      get().hydrateThoughtLevelStandby()
      break

    case 'modelSet': {
      // 延迟切换的补发可能晚到数分钟（挂起期间用户已切走会话）：目标会话不是当前
      // 会话时丢弃，避免旧会话的模型翻转污染当前会话显示与级别缓存
      if (msg.sessionId && msg.sessionId !== get().currentSessionId) break
      set({
        currentModel: { modelId: msg.modelId, providerId: msg.providerId },
        modelInvalidated: false,
        modelSwitchInFlightAt: null, // 切换已落定，新到达的 settings 可信
        modelPendingSwitch: null, // 延迟切换落定（缺陷AC），清提示与回滚暂存
        modelSwitchPrevModel: null,
        lastNotice: null,
      })
      // 切换模型后立即刷新用量，圆环 size 随新模型窗口更新（不用等下次对话结束）
      setTimeout(() => get().loadUsage(), 500)
      // 级别集随模型变化（off/high/max ↔ enabled/off），重拉 settings（current 由服务端校准）；
      // 该响应还会消费下方暂存的级别（权威校验，见 case 'settings'）
      setTimeout(() => get().loadSettings(), 500)
      break
    }

    case 'modelSetPending': {
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
      // 挂起的切换回合结束后补发仍失败（真不支持/会话已死等）：清提示并走通用错误展示
      if (get().modelPendingSwitch?.sessionId === msg.sessionId) {
        set({ modelPendingSwitch: null, modelSwitchPrevModel: null, lastNotice: null })
      }
      // 即时切换失败路径回滚选中态（此前停在目标模型上，勾选与实际不符）；延迟路径
      // modelSetPending 已回滚，prev 与 currentModel 相同，再回滚是无操作。
      // captchaGated（体验套餐 zcode-plan 网关渠道被 Java 入口拦截）映射本地化文案
      const prev = get().modelSwitchPrevModel
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
      // 模型切换在途：本响应计算于旧模型，级别部分不可信——写入会把旧级别集污染进
      // 新模型的缓存、applyThoughtLevelIfReady 会发出对新模型非法的级别（-32603）。
      // mode 与模型无关照常同步；级别真相由 modelSet 后延迟 500ms 的 loadSettings 提供
      if (isModelSwitchInFlight(get())) {
        set({ currentMode: msg.mode?.current ?? null })
        break
      }
      set({
        currentMode: msg.mode?.current ?? null,
        thoughtLevel: msg.thoughtLevel,
      })
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
            usageProvider: { id: msg.providerId, name: msg.providerName ?? msg.providerId },
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

    case 'memoryFiles':
      set({ memoryFiles: msg.files, memoryEnabled: msg.memoryEnabled, memoryLoading: false, memoryError: null })
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
      set({ skills: msg.skills, skillsLoading: false, skillsError: null })
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
      // 回包不带 model（CLI 降级通道）时保留发起时的占位模型；取消兜底定时器
      cancelEnhanceTimer()
      set({
        enhancing: false,
        enhanceResult: {
          original: msg.original ?? '',
          model: msg.model ?? get().enhanceResult?.model,
          ...(msg.error
            ? { error: msg.error }
            : { text: msg.text }),
        },
      })
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

    case 'modelManage':
      set({
        modelProviders: msg.providers,
        modelManageLoading: false,
        modelManageError: msg.error ?? null,
        modelConfigPath: msg.configPath ?? null,
      })
      // 设置页模型清单到达 → 输入框下拉同步（用户诉求：管理页刷新/切换后下拉跟着变，
      // 不再只在启动时拉一次）。走 listModels 保持口径与 case 'models' 既有逻辑复用
      get().loadModels()
      break

    case 'modelToggled': {
      // provider 启用/禁用写回成功（changes 含互斥联动项）：本地更新 + 重拉下拉
      const byId = new Map(msg.changes.map((c) => [c.providerId, c.enabled]))
      const providers = get().modelProviders?.map((p) =>
        byId.has(p.providerId) ? { ...p, enabled: byId.get(p.providerId)! } : p,
      )
      set({ modelProviders: providers ?? null, modelTogglingId: null })
      get().loadModels()
      break
    }

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

    case 'modelUsage':
      if (msg.error) {
        set({ modelUsage: null, usageError: msg.error })
      } else {
        set({
          modelUsage: msg.data ?? null,
          ...(msg.providerId && {
            usageProvider: { id: msg.providerId, name: msg.providerName ?? msg.providerId },
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
            usageProvider: { id: msg.providerId, name: msg.providerName ?? msg.providerId },
          }),
        })
      }
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
    patch?: { mode?: { current?: string }; thoughtLevel?: ThoughtLevelInfo }
  }
  const patch = payload.patch
  if (patch) {
    const p: Partial<StoreState> = {}
    if (patch.mode?.current) {
      p.currentMode = patch.mode.current
      // 权威值切离 plan：清除 prePlanMode 记忆（避免下次 ExitPlanMode 恢复到过期值）
      if (patch.mode.current !== 'plan') p.prePlanMode = null
    }
    if (patch.thoughtLevel) p.thoughtLevel = patch.thoughtLevel
    if (Object.keys(p).length > 0) set(p)
  }
  console.log(`[store] state.updated(${payload.reason ?? '?'}): 模式/级别已按服务端同步`)
}

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
  } else {
    // 幂等保护：批准瞬间的乐观恢复（PlanApprovalDialog）或权威 state.updated 已把
    // 模式切离 plan 时跳过——迟到的 batch 推断不得因 prePlanMode 记忆缺失把
    // 已恢复的模式覆盖成兜底值 yolo
    const cur = get().currentMode
    if (cur && cur !== 'plan') return
    patch.currentMode = get().prePlanMode ?? 'yolo'
    patch.prePlanMode = null
  }
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
    const failed = ['failed', 'error', 'interrupted', 'aborted', 'cancelled'].includes(failStatus)
    if (key) {
      const activities = markActivityOutcome(st.subagentActivities, key, failed, timestamp)
      set({ subagentActivities: activities, ...refreshStatus(st.messages, activities, st.subagents) })
    }
    get().loadSubagents()
    if (st.subagentDetail && st.childSessionKeys[lc.childSessionId] === st.subagentDetail) {
      st.loadChildMessages(lc.childSessionId)
    }
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
  for (const event of events) {
    if (event.type === 'state.updated') continue
    // 防御：子会话原生流不应出现转发标记，出现则跳过（转发事件走父会话流）
    if (event.type === 'tool.updated' && isSubagentToolEvent(event.payload)) continue
    const r = applyStreamEvent(messages, event, streamingId)
    messages = r.messages
    streamingId = r.streamingMessageId
    if (r.turnEnded) {
      childTurnEnded = true
      if (r.turnError) childTurnFailed = true
    }
  }
  const st = get()
  set({
    childLiveMessages: { ...st.childLiveMessages, [sessionId]: messages },
    childStreamingIds: { ...st.childStreamingIds, [sessionId]: streamingId },
  })
  // 子会话 turn 结束 = 子代理跑完：后台代理唯一实时可用的终点信号
  //（session/subscribe 流不带 subagent.lifecycle，合成通知消息只在重拉时可见），
  // 即时收尾父会话活动 + 权威刷新。子会话多 turn 自动续轮时会提前收尾一次，
  // RPC 刷新返回 running 会把状态盖回来，可自愈。
  if (childTurnEnded) {
    const key = st.childSessionKeys[sessionId]
    if (key) {
      const ts = events[events.length - 1]?.timestamp ?? Date.now()
      const activities = markActivityOutcome(st.subagentActivities, key, childTurnFailed, ts)
      set({ subagentActivities: activities, ...refreshStatus(st.messages, activities, st.subagents) })
      get().loadSubagents()
    }
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
  const atoms = sliceBigToolInputDeltas(events)
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

/** 批内含超阈值 tool_input_delta 时，把大 delta 展开成切片原子序列 */
function sliceBigToolInputDeltas(events: StreamEvent[]): StreamEvent[] | null {
  const hasBig = events.some((e) => {
    if (e.type !== 'model.streaming') return false
    const p = e.payload as Record<string, unknown>
    return p.kind === 'tool_input_delta' && typeof p.delta === 'string' && p.delta.length > REPLAY_DELTA_THRESHOLD
  })
  if (!hasBig) return null
  const atoms: StreamEvent[] = []
  for (const e of events) {
    const p = e.payload as Record<string, unknown>
    if (e.type === 'model.streaming' && p.kind === 'tool_input_delta'
      && typeof p.delta === 'string' && p.delta.length > REPLAY_DELTA_THRESHOLD) {
      const slices = Math.min(REPLAY_TARGET_SLICES, Math.max(2, Math.ceil(p.delta.length / 96)))
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

/** 每拍派发一个原子事件，队列空则停表并清掉本会话的队列/定时器 */
function startReplayPump(
  sessionId: string,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
): void {
  const pump = () => {
    const queue = replayQueues.get(sessionId)
    const next = queue?.shift()
    if (next) handleStreamBatchDirect(sessionId, [next], set, get)
    if (queue && queue.length > 0) {
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
  if (sessionId !== get().currentSessionId) {
    // 已注册子会话的原生事件流 → 实时归约成完整对话（运行中详情弹窗数据源，
    // 含 AI 文本增量；Java 全局监听器本就把所有会话事件推到了前端）
    if (sessionId in get().childSessionKeys) {
      handleChildStreamBatch(sessionId, events, set, get)
    }
    return
  }
  if (events.length === 0) return

  // 看门狗心跳：当前会话有任何事件到达 = 回合活着（静默对账不会触发）
  lastStreamActivityAt = Date.now()

  let messages = get().messages
  let streamingMessageId = get().streamingMessageId
  let activities = get().subagentActivities
  let turnStarted = false
  let turnEnded = false
  let modeEvent: 'enter_plan' | 'exit_plan' | undefined
  let turnError: TurnErrorInfo | undefined
  let bgTasks: BackgroundTaskMap | null = null
  let bgDirty = false // 本批内后台任务有增删（有变更才 patch，保持引用稳定防多余重渲染）
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
      const lc = asSubagentLifecycle(event.payload)
      if (lc) {
        applySubagentLifecycle(lc, event.timestamp, set, get)
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
    if (event.type === 'turn.started') turnStarted = true
    // 压缩回合不建流式 assistant 消息（同单推路径：零 delta 空气泡，CompactingIndicator 表达）
    if (event.type !== 'turn.started' || !get().compacting) {
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
  // 同批 completed+started（服务端自动续轮）时保留 reducer 返回的新 streamingMessageId，
  // 不能按"turn 结束"清空——清了后续 delta 全部丢失（实时断流）
  if (turnEnded && !turnStarted) {
    patch.streaming = false
    patch.streamingMessageId = null
    patch.waitingSince = null
    patch.compacting = false
    // 后台任务指示器不在回合结束清除（后台化确认后回合可能立即结束，
    // 任务仍在后台跑——由任务完成通知清除，见 bgCompleted 分支）
    // 失败回合展示错误详情（同批 failed+started 的自动续轮不打扰）
    if (turnError) patch.lastError = formatTurnError(turnError)
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
    // 本批未同时开启新 turn 时自动发送队列下一条（同批 completed+started 说明服务端已自动续轮）
    if (!turnStarted) {
      // 压缩回合结束：摘要卡只经下方重拉快照落地，队列非空时延迟到快照落地后再
      // flush——立即发会让新 turn 抢先置 streaming，快照被丢弃、摘要卡整轮缺失
      if (wasCompacting && get().queuedMessages.length > 0) {
        scheduleDeferredCompactFlush(sessionId)
      } else {
        get().flushQueue()
      }
    }
    setTimeout(() => {
      sendToJava({ op: 'messages', sessionId, workspacePath: get().currentWorkspacePath })
      // 刷新会话列表：CLI 会根据对话内容更新标题（sess_xxx → 用户问题）
      get().loadSessions()
      // 刷新子代理权威列表（running/ended + summary，底部栏与详情弹窗用）
      get().loadSubagents()
      // 刷新上下文用量（圆环更新）
      get().loadUsage()
      // 兜底重拉设置（ZCode 自动进出计划模式若伴随 turn 结束也能对齐）
      get().loadSettings()
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

  // 非当前会话：已注册子会话的原生事件流 → 实时归约（同批量路径）
  if (sessionId !== get().currentSessionId) {
    if (sessionId in get().childSessionKeys) {
      handleChildStreamBatch(sessionId, [event], set, get)
    }
    return
  }

  // 看门狗心跳：当前会话有任何事件到达 = 回合活着（静默对账不会触发）
  lastStreamActivityAt = Date.now()

  // ===== 工具输入大块 delta 的流式回放（同批量路径；mock/关键事件走单推）=====
  const atoms = sliceBigToolInputDeltas([event])
  if (atoms || (replayQueues.get(sessionId)?.length ?? 0) > 0) {
    enqueueReplay(sessionId, atoms ?? [event], set, get)
    return
  }

  // 状态变化通知（panel 单推，低频即时）：模式/级别跟随服务端
  if (event.type === 'state.updated') {
    applyStateUpdated(event, set)
    return
  }

  // 子代理生命周期通知（spawned/stopped）：注册子会话，stop 时收尾活动 + 拉权威
  if (event.type === 'session.updated') {
    const lc = asSubagentLifecycle(event.payload)
    if (lc) {
      applySubagentLifecycle(lc, event.timestamp, set, get)
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

  const { messages, streamingMessageId, turnEnded, modeEvent, turnError } = applyStreamEvent(
    get().messages,
    event,
    get().streamingMessageId,
  )
  if (turnEnded && event.turnId) lastCompletedTurnId = event.turnId

  // turn.started：进入流式，清除 waiting（开始有内容了）
  if (event.type === 'turn.started') {
    set({ streaming: true, waitingSince: null })
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
    const wasCompacting = get().compacting
    set({
      streaming: false,
      streamingMessageId: null,
      waitingSince: null,
      compacting: false,
      // 后台任务指示器不在回合结束清除（同批量路径：由任务完成通知清除）
      // 失败回合展示错误详情（此前 payload.error 被丢弃，失败只表现为"转圈停了"）
      ...(turnError ? { lastError: formatTurnError(turnError) } : {}),
    })
    console.log(`[store] turn ${event.type}，重新拉取消息确保一致`)
    // 压缩回合结束：摘要卡只经下方重拉快照落地，队列非空时延迟到快照落地后再
    // flush——立即发会让新 turn 抢先置 streaming，快照被丢弃、摘要卡整轮缺失
    //（同批量路径 scheduleDeferredCompactFlush，2026-08-22 /compact 排队实测）
    if (wasCompacting && get().queuedMessages.length > 0) {
      scheduleDeferredCompactFlush(sessionId)
    } else {
      get().flushQueue()
    }
    setTimeout(() => {
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

/** messages 响应的权威落地（常规重拉与对账收尾共用） */
function applyMessagesSnapshot(
  msg: { messages: ZCodeMessage[] },
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  const st = get()
  // 过滤 model-only 合成消息（todo_reminder 等，2026-08-15 误渲染成
  // "子代理完成"卡片的根源）——只影响展示，下方派生计算仍用原始全量。
  // 同轮 turn 的多条 assistant step 合并为一条（耗时/token 取整轮），
  // 否则重拉后"已工作"塌缩成最后一个 step 的耗时
  const visibleMessages = mergeTurnMessages(
    msg.messages.filter((m) => !isHiddenSyntheticMessage(m.info)),
  )
  // 通知扫描：转录里出现 task-notification 而活动还停在 running（子会话流与
  // 生命周期钩子都错过的场合，如重启恢复）→ 自愈收尾并拉权威列表补齐
  const activities = finalizeActivitiesFromNotifications(st.subagentActivities, msg.messages, Date.now())
  const patch: Partial<StoreState> = {
    messages: visibleMessages,
    loadingMessages: false,
    ...refreshStatus(msg.messages, activities, st.subagents),
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
  set(patch)
  if (activities !== st.subagentActivities) get().loadSubagents()
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
  if (last && last.info.role === 'assistant' && hasVisibleText(last)) return 'ended'
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

function startQuotaPolling(): void {
  if (quotaPollTimer) return
  quotaPollTimer = setInterval(() => {
    const st = useStore.getState()
    if (st.currentModel?.providerId !== GLM_PLAN_PROVIDER) return
    if (st.quotaLoading) return // 上一次还在途（HTTP 最长 ~35s），跳过本轮
    st.loadQuota()
  }, QUOTA_POLL_INTERVAL)
}
