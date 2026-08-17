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
import type { JavaResponse, SessionInfo, ZCodeMessage, StreamEvent, ModelOption, TodoItem, AgentItem, FileChangeItem, QuotaData, ModelUsageData, ToolUsageData, UsageRange, ContextBreakdownItem, ThoughtLevelInfo, SubagentActivity, SubagentInfo, ToolUpdatedPayload, MemoryFileInfo, SkillInfo, McpServerInfo, McpToolsState, McpLogEntry, EnvStatus } from '@/types/messages'
import { applyStreamEvent, isSubagentToolEvent, applySubagentToolEvent, markActivityOutcome, asSubagentLifecycle } from '@/utils/streamReducer'
import type { SubagentLifecyclePayload } from '@/utils/streamReducer'
import { parseTodos, parseAgents, parseFileChanges, mergeAgentItems } from '@/utils/parseStatus'
import { isHiddenSyntheticMessage } from '@/utils/parseNotification'
import { mergeTurnMessages } from '@/utils/mergeTurnMessages'
import { getPersisted, setPersisted, removePersisted, entriesWithPrefix } from '@/utils/persist'

export type ConnectionStatus = 'connecting' | 'connected' | 'mock' | 'error'

/** GLM 套餐 providerId（有 apiKey 可查额度；悬浮栏与额度定时轮询共用判定）*/
export const GLM_PLAN_PROVIDER = 'builtin:bigmodel-coding-plan'

/** GLM 额度自动刷新间隔（ms）——悬浮栏/用量页「上次刷新」的更新节奏 */
const QUOTA_POLL_INTERVAL = 60_000

/** 排队消息（对话进行中 Enter 入队，回合结束自动发送；text 为拼好技能/文件引用的最终文本）*/
export interface QueuedMessage {
  id: string
  text: string
  queuedAt: number
}

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
  pendingSettingsSection: 'env' | null

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
  /** 排队消息（streaming 中 Enter 入队，回合结束自动发队头）*/
  queuedMessages: QueuedMessage[]

  // 模型切换（config.json provider 注册表）
  models: ModelOption[]
  /** 当前会话选择的模型（persist 记忆）*/
  currentModel: { modelId: string; providerId: string } | null
  /** 已为该会话下发过 setModel（避免每次 messages 刷新重复下发）*/
  modelAppliedForSession: string | null

  // 运行时设置（session/read → settings：思考级别 + 权限模式）
  /** 思考级别（available 因模型而异，服务端权威）*/
  thoughtLevel: ThoughtLevelInfo | null
  /** 当前权限模式（build/edit/plan/yolo）*/
  currentMode: string | null
  /** 进入 plan 前的模式（缺陷E：ExitPlanMode 批准后即时恢复用，权威值由 state.updated/loadSettings 校正）*/
  prePlanMode: string | null
  /** 已为该会话下发过 setThoughtLevel（applyThoughtLevelIfReady 防重入）*/
  thoughtLevelAppliedForSession: string | null

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

  // 记忆文件（设置视图「记忆」条目，Kotlin 端固定清单扫描）
  memoryFiles: MemoryFileInfo[] | null
  memoryLoading: boolean
  /** 正在创建的记忆文件路径（条目按钮 loading 用）*/
  memoryCreatingPath: string | null
  memoryError: string | null

  // 技能清单（设置视图「技能」条目，SkillScanner 三来源扫描）
  skills: SkillInfo[] | null
  skillsLoading: boolean
  /** 正在切换启用状态的技能路径（卡片开关 loading + 防重复点击）*/
  skillTogglingPath: string | null
  skillsError: string | null

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
  mcpLogsLoading: boolean

  // 用量明细曲线（model-usage / tool-usage）
  modelUsage: ModelUsageData | null
  toolUsage: ToolUsageData | null
  usageRange: UsageRange
  customStart: string | null
  customEnd: string | null
  /** 用量查询局部错误（凭证/HTTP 失败，不污染全局 lastError）*/
  usageError: string | null

  // AskUserQuestion 弹窗
  askUser: { requestId: string; toolName: string; questions: import('@/types/messages').AskUserQuestion[] } | null

  // ExitPlanMode 计划审批弹窗（服务端 interaction/requestUserInput，params = {input:{plan}}）
  exitPlanApproval: { requestId: string; plan: string } | null

  // actions
  init: () => void
  loadSessions: () => void
  selectSession: (session: SessionInfo) => void
  sendMessage: (text: string) => void
  createSession: () => void
  /** 「新建会话」按钮：重置为无会话待命态（延迟创建），首条消息触发建会话 */
  resetToNewSession: () => void
  deleteSession: (sessionId: string) => void
  stopStreaming: () => void
  /** 重命名会话（CLI 协议无 rename op，仅前端 persist 持久化）*/
  renameSession: (sessionId: string, title: string) => void
  /** 拉取可切换的模型列表（config.json）*/
  loadModels: () => void
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
  /** 拉取技能清单（设置视图「技能」条目）*/
  loadSkills: () => void
  /** 启用/禁用技能（写 config skill 节点，CLI 下次发现生效）*/
  toggleSkill: (path: string, enabled: boolean) => void
  /** 拉取 MCP 服务器清单（mode=connect 时真实连接各服务器，慢）*/
  loadMcpServers: (mode?: 'status' | 'connect') => void
  /** 拉单台服务器的工具清单（有缓存且非 force 直接跳过；loading 中防重入）*/
  loadMcpServerTools: (name: string, force?: boolean) => void
  /** 拉取 MCP 连接日志（CLI 落盘 mcp.* 事件）*/
  loadMcpLogs: () => void
  /** 设置用量明细时间范围并重拉 model/tool 曲线 */
  setUsageRange: (range: UsageRange) => void
  /** 设置自定义日期范围并重拉 */
  setUsageDates: (start: string, end: string) => void
  /** 按当前 usageRange 拉取 model-usage + tool-usage */
  loadUsageData: () => void
  /** 清除错误（错误栏关闭按钮）*/
  clearError: () => void
  /** 设置 EnvBanner「去设置」的跳转意图（BasicSettingsView 消费后清除）*/
  setPendingSettingsSection: (section: 'env' | null) => void
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
  childMessages: {},
  childMessagesLoading: false,
  childMessagesError: null,
  childSessionKeys: {},
  childLiveMessages: {},
  childStreamingIds: {},

  streaming: false,
  streamingMessageId: null,
  waitingSince: null,
  queuedMessages: [],
  askUser: null,
  exitPlanApproval: null,

  models: [],
  currentModel: null,
  modelAppliedForSession: null,
  thoughtLevel: null,
  currentMode: null,
  prePlanMode: null,
  thoughtLevelAppliedForSession: null,
  contextUsage: null,
  contextBreakdown: null,
  quota: null,
  quotaLoading: false,
  quotaFetchedAt: 0,
  memoryFiles: null,
  memoryLoading: false,
  memoryCreatingPath: null,
  memoryError: null,

  skills: null,
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
  modelUsage: null,
  toolUsage: null,
  usageRange: '7d',
  customStart: null,
  customEnd: null,
  usageError: null,

  init: () => {
    if (bridgeInitialized) return
    bridgeInitialized = true

    initBridge()
    onMessage((msg: JavaResponse) => handleResponse(msg, set, get))
    // 批量流式事件（Java 端 16ms 节流合并）：一次处理整批，只 set 一次
    onStreamBatch((sid: string, events: StreamEvent[]) => handleStreamBatch(sid, events, set, get))
    // 单事件兜底（mock 模式 + Java 端关键事件走 streamEvent 单推）
    onStreamEvent((sid: string, event: StreamEvent) => handleStreamEvent(sid, event, set, get))

    const inJcef = isInJcef()
    const ws = getWorkspacePath()
    set({ connectionStatus: inJcef ? 'connected' : 'mock', projectPath: ws })
    console.log(`[store] 初始化完成，连接=${inJcef ? 'JCEF' : 'mock'}，workspace=${ws || '(空)'}`)

    // IDE 广播：envSave 保存成功后多标签同步最新环境状态（Panel broadcastEnvStatus）
    window.onEnvStatusChanged = (status: EnvStatus) => set({ envStatus: status })

    get().checkEnv()
    get().loadSessions()
    get().loadModels()
    // GLM 额度 60s 定时刷新（悬浮栏/用量页「上次刷新」的更新源，见 startQuotaPolling）
    startQuotaPolling()
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
    const workspacePath = session.workspacePath || get().projectPath
    set({
      currentSessionId: session.sessionId,
      currentWorkspacePath: workspacePath,
      messages: [],
      loadingMessages: true,
      streaming: false,
      streamingMessageId: null,
      waitingSince: null,
      queuedMessages: [], // 队列绑定会话上下文，切会话丢弃
      contextUsage: null, // 清空旧会话数据，等 getUsage 回来更新
      contextBreakdown: null,
      thoughtLevel: null, // 清空旧会话设置，等 getSettings 回来更新（currentMode 由 messages 推断兜底）
      todos: [], // 派生状态同步清零，消除 messages 响应回来前的底部栏串扰空窗
      agents: [],
      fileChanges: [],
      subagentActivities: [], // 子代理数据绑定会话，切会话清空重拉
      subagents: [],
      subagentDetail: null,
      subagentReport: null,
      markdownPreview: null,
      childMessages: {},
      childMessagesError: null,
      childSessionKeys: {}, // 子会话注册与实时归约数据同样绑定会话
      childLiveMessages: {},
      childStreamingIds: {},
    })
    // 切换会话时订阅事件流（带 workspacePath，Java 端 subscribe 前要先 resume 激活会话）
    sendToJava({ op: 'subscribe', sessionId: session.sessionId, workspacePath })
    sendToJava({ op: 'messages', sessionId: session.sessionId, workspacePath })
    // 拉取该会话的子代理列表（历史会话也能在底部栏查看已完成子代理）
    get().loadSubagents()
    // 切会话后拉取上下文用量（圆环显示）
    get().loadUsage()
    // 拉取运行时设置（mode + 思考级别，级别列表随模型变化）
    get().loadSettings()
    // 会话切换后，把 persist 记忆的模型真正下发 setModel（见 models 响应里的 applyModelIfReady）
    get().applyModelIfReady(session.sessionId)
  },

  sendMessage: (text) => {
    if (!text.trim()) return
    const sid = get().currentSessionId
    // 懒创建：无会话（新标签 / 会话被删）时首条消息先触发建会话，createSession 响应后
    // 自动发出暂存消息。先置 streaming 让等待动画立即出现；等待期的后续消息因
    // streaming=true 走下方入队分支，回合结束后 flushQueue 兜底发出
    if (!sid && !get().creatingSession) {
      set({
        streaming: true,
        streamingMessageId: null,
        waitingSince: Date.now(),
        lastError: null,
        pendingFirstMessage: text,
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
            queuedAt: Date.now(),
          },
        ],
      }))
      return
    }

    // 兜底：无会话且不在建会话流程（正常应已被懒创建/入队分支拦截）
    if (!sid) return

    set({
      streaming: true,
      streamingMessageId: null,
      waitingSince: Date.now(),
      lastError: null,
    })

    // 确保已订阅（规格书 §4：先 subscribe 再 send，否则丢事件）
    sendToJava({ op: 'subscribe', sessionId: sid, workspacePath: get().currentWorkspacePath })
    // 发送
    sendToJava({
      op: 'send',
      sessionId: sid,
      text,
      workspacePath: get().currentWorkspacePath,
    })

    // 本地把用户消息立即加入列表（不等 reload，体验更快）
    const userMsg: ZCodeMessage = {
      info: {
        role: 'user',
        time: { created: Date.now() },
        id: `local_u_${Date.now()}`,
        sessionID: sid,
      },
      parts: [{ type: 'text', text }],
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

  createSession: () => {
    // 防重入：建会话请求进行中不重复发（懒创建 + 手动 + 按钮共用）
    if (get().creatingSession) return
    set({ creatingSession: true })
    sendToJava({ op: 'createSession', workspacePath: get().projectPath })
  },

  resetToNewSession: () => {
    // 「新建会话」按钮延迟创建（对齐新标签）：不立即建会话，重置为无会话待命态，
    // 首条消息再触发懒建会话（见 sendMessage）。旧会话保留在历史列表可切回；
    // 旧会话的流式事件被 handleStreamBatch/Event 的 currentSessionId 过滤拦截，
    // 不会串扰待命态。clearTabSession 让 Java 侧同步清 TabState 绑定 + 标签 tooltip
    //（否则重启恢复会绑回旧会话）
    set({
      currentSessionId: null,
      creatingSession: false,
      pendingFirstMessage: null,
      messages: [],
      loadingMessages: false,
      streaming: false,
      streamingMessageId: null,
      waitingSince: null,
      queuedMessages: [], // 队列绑定旧会话上下文，丢弃
      contextUsage: null,
      contextBreakdown: null,
      thoughtLevel: null,
      currentMode: null,
      todos: [],
      agents: [],
      fileChanges: [],
      subagentActivities: [],
      subagents: [],
      subagentDetail: null,
      subagentReport: null,
      markdownPreview: null,
      childMessages: {},
      childMessagesError: null,
      childSessionKeys: {},
      childLiveMessages: {},
      childStreamingIds: {},
      askUser: null, // 旧会话遗留的提问/审批弹窗随会话切换关闭
      exitPlanApproval: null,
    })
    // 待命态：恢复当前模型的缓存级别集（currentMode 不水合——模式是即时意图，预选重新开始）
    get().hydrateThoughtLevelStandby()
    sendToJava({ op: 'clearTabSession' })
  },

  deleteSession: (sessionId) => {
    sendToJava({ op: 'deleteSession', sessionId })
  },

  stopStreaming: () => {
    const sid = get().currentSessionId
    if (!sid) return
    sendToJava({ op: 'stop', sessionId: sid })
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
      get().sendMessage(target.text)
    }
  },

  flushQueue: () => {
    if (get().streaming || get().queuedMessages.length === 0) return
    const [next, ...rest] = get().queuedMessages
    set({ queuedMessages: rest })
    get().sendMessage(next.text)
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

  setModel: (modelId, providerId) => {
    // 记忆当前选择（persist 通道），切换会话后仍显示；无会话（懒创建待命态）也先记忆，
    // 会话建立后由 applyModelIfReady 真正下发（见 createSession 响应处理）
    setPersisted('zcode.currentModel', JSON.stringify({ modelId, providerId }))
    set({ currentModel: { modelId, providerId } })
    // 待命态切模型：级别集随模型变化，按新模型重 hydrate（无缓存的模型 → 选择器隐藏）
    get().hydrateThoughtLevelStandby()
    const sid = get().currentSessionId
    if (!sid) return
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
    if (!exists) return
    set({ currentModel: saved, modelAppliedForSession: sessionId })
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

  loadSkills: () => {
    set({ skillsLoading: true, skillsError: null })
    sendToJava({ op: 'listSkills' })
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

  clearError: () => set({ lastError: null }),

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

function handleResponse(
  msg: JavaResponse,
  set: (partial: Partial<StoreState>) => void,
  get: () => StoreState,
) {
  switch (msg.op) {
    case 'listSessions': {
      // 标题合并优先级：手动重命名（persist）> 服务端正式标题（顺带清临时标题）
      // > 本地临时标题（乐观占位，见 sendMessage）> 服务端占位（空/会话 id）
      const prevProvisionals = get().provisionalTitles
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
        return provisional ? { ...s, title: provisional } : s
      })
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
      // 待命态预选值（currentMode/thoughtLevel 无会话时的本地记录），下方 set 复位前捕获
      const preselectedMode = get().currentMode
      const standbyThought = get().thoughtLevel
      if (sid) {
        const ws = get().projectPath
        set({
          currentSessionId: sid,
          currentWorkspacePath: ws,
          creatingSession: false,
          pendingFirstMessage: null,
          messages: [],
          loadingMessages: false,
          streaming: false,
          streamingMessageId: null,
          waitingSince: null,
          queuedMessages: [], // 队列绑定旧会话上下文，新建会话丢弃
          contextUsage: null, // 清空旧会话数据，等 getUsage 回来更新
          contextBreakdown: null,
          // 保留待命态的级别集（与当前模型同源缓存）与预选模式，避免选择器/按钮闪回默认；
          // 服务端权威值由下方 loadSettings → settings 响应校准
          thoughtLevel: standbyThought,
          currentMode: preselectedMode,
          todos: [], // 派生状态同步清零：新会话不发 messages 请求，不重算会一直残留旧会话底部栏数据
          agents: [],
          fileChanges: [],
          subagentActivities: [], // 新会话无子代理
          subagents: [],
          subagentDetail: null,
          subagentReport: null,
          markdownPreview: null,
          childMessages: {},
          childMessagesError: null,
          childSessionKeys: {},
          childLiveMessages: {},
          childStreamingIds: {},
        })
        // 订阅新会话（Java 端 handleSubscribe 内部会先 resume 激活）
        sendToJava({ op: 'subscribe', sessionId: sid, workspacePath: ws })
        // 新会话也按记忆模型下发 setModel（等 models 就绪，由 applyModelIfReady 内部判断）
        get().applyModelIfReady(sid)
        // 待命态预选的模式补下发——必须先于首条消息，预选 plan 时首问就按计划模式跑
        if (preselectedMode) get().setMode(preselectedMode)
        // 记忆的思考级别同样先于首条消息下发（否则首问跑在服务端默认级别上）；
        // 用待命态 info / 按模型缓存校验有效性，settings 到达后 applyThoughtLevelIfReady
        // 被 appliedForSession 标记拦下不重发；无效（无缓存/不在列表）则留给该校准路径兜底
        const savedLevel = getPersisted('zcode.thoughtLevel')
        const info = standbyThought ?? readThoughtLevelCache(get().currentModel?.modelId)
        if (savedLevel && info?.enabled && info.available.some((a) => a.value === savedLevel)) {
          set({ thoughtLevelAppliedForSession: sid, thoughtLevel: { ...info, current: savedLevel } })
          sendToJava({ op: 'setThoughtLevel', sessionId: sid, thoughtLevel: savedLevel })
        }
        // 拉取上下文用量（圆环显示）
        get().loadUsage()
        // 拉取运行时设置（新会话默认模式 + 级别集）
        get().loadSettings()
        // 懒创建收尾：发出暂存的首条消息。须在 set 之后——set 复位了 streaming，
        // sendMessage 会重新置位并走完整的 subscribe+send+乐观消息流程
        if (pendingFirst) get().sendMessage(pendingFirst)
      } else {
        // 异常响应（无 sessionId）：复位标志与暂存，防卡死
        set({ creatingSession: false, pendingFirstMessage: null })
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
        ...(deletedCurrent
          ? {
            currentSessionId: null, messages: [], streaming: false, streamingMessageId: null, waitingSince: null,
            queuedMessages: [],
            contextUsage: null, contextBreakdown: null, thoughtLevel: null, currentMode: null,
            todos: [], agents: [], fileChanges: [], // 底部栏派生状态随会话删除清零
            subagentActivities: [], subagents: [], subagentDetail: null, childMessages: {},
            childMessagesError: null,
            childSessionKeys: {}, childLiveMessages: {}, childStreamingIds: {},
          }
          : {}),
      })
      // 删的是当前会话 → 进入待命态，恢复当前模型的缓存级别集供预选
      if (deletedCurrent) get().hydrateThoughtLevelStandby()
      break
    }

    case 'messages':
      if (msg.sessionId === get().currentSessionId) {
        // 流式进行中到达的重拉响应 = 过期快照：turn 结束触发的 300ms 延迟重拉，
        // 会落后于排队消息自动发出后已开启的新 turn（idea.log 2026-08-15 时序证据：
        // completed → flushQueue 发送 → 新 turn.started → 旧重拉才 resume/返回）。
        // 此时全量替换会抹掉流式中的 assistant 消息（断流），且 turn.started 借用的
        // messageId 与重拉后服务端 user 消息撞车时，AI delta 会叠进用户气泡（叠字）。
        // 丢弃——本轮 turn 结束还会再拉一次权威数据落地。
        if (get().streaming) break
        const st = get()
        // 过滤 model-only 合成消息（todo_reminder 等，2026-08-15 误渲染成
        // "子代理完成"卡片的根源）——只影响展示，下方派生计算仍用原始全量。
        // 同轮 turn 的多条 assistant step 合并为一条（耗时/token 取整轮），
        // 否则重拉后"已工作"塌缩成最后一个 step 的耗时
        const visibleMessages = mergeTurnMessages(
          msg.messages.filter((m) => !isHiddenSyntheticMessage(m.info)),
        )
        const patch: Partial<StoreState> = {
          messages: visibleMessages,
          loadingMessages: false,
          ...refreshStatus(msg.messages, st.subagentActivities, st.subagents),
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
        set(patch)
      }
      break

    case 'subagents': {
      // session/subagents RPC 权威列表：刷新 agents 合并结果；
      // 详情弹窗若开着且此前没有 childSessionId，现在补拉完整过程。
      // 失败不弹全局错误（底部栏还有解析兜底数据），静默保留旧值
      const st = get()
      if (msg.sessionId !== st.currentSessionId) break
      if (msg.error) break
      const items = [...msg.data.running, ...msg.data.ended.items]
      set({
        subagents: items,
        agents: mergeAgentItems(parseAgents(st.messages), st.subagentActivities, items),
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
        set({ streaming: false, waitingSince: null })
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
    case 'stopped':
      break

    case 'newSession':
      // Java 端自动新建会话（老会话模型不可用），切换到新会话
      console.log(`[store] 切换到新会话: ${msg.sessionId}`)
      set({
        currentSessionId: msg.sessionId,
        messages: [], // 新会话无历史消息
        streaming: false,
        streamingMessageId: null,
        waitingSince: null,
        thoughtLevel: null,
        currentMode: null,
        queuedMessages: [], // 队列绑定旧会话上下文，丢弃
        todos: [], // 底部栏派生状态随会话切换清零
        agents: [],
        fileChanges: [],
        subagentActivities: [], // 子代理数据绑定旧会话，丢弃
        subagents: [],
        subagentDetail: null,
        subagentReport: null,
        markdownPreview: null,
        childMessages: {},
        childMessagesError: null,
        childSessionKeys: {},
        childLiveMessages: {},
        childStreamingIds: {},
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

    case 'error':
      // 建会话失败（Java 外层 catch 回 error）：复位懒创建标志与暂存消息（防卡死、防误重试）
      set({
        lastError: msg.message,
        // 环境前置检查失败（EnvCheckException/envSave 验证失败）：附带 envStatus 刷新提醒条
        ...(msg.envStatus ? { envStatus: msg.envStatus } : {}),
        envSaving: false,
        loadingMessages: false,
        streaming: false,
        waitingSince: null,
        memoryLoading: false,
        memoryCreatingPath: null,
        skillsLoading: false,
        skillTogglingPath: null,
        mcpLoading: false,
        mcpChecking: false,
        mcpLogsLoading: false,
        ...(get().creatingSession ? { creatingSession: false, pendingFirstMessage: null } : {}),
      })
      console.error('[store] Java 错误:', msg.message)
      // 错误清 streaming 后继续发队列下一条（排队意图明确；持续失败时用户可删队列项）
      get().flushQueue()
      break

    case 'askUser':
      // AskUserQuestion 弹窗（服务器反向请求 interaction/requestUserInput）
      console.log('[store] 收到 askUser:', msg.toolName, msg.questions)
      set({ askUser: { requestId: msg.requestId, toolName: msg.toolName, questions: msg.questions } })
      break

    case 'exitPlanApproval':
      // ExitPlanMode 计划审批弹窗：渲染 plan markdown，用户批准/拒绝
      console.log('[store] 收到 exitPlanApproval，plan 长度:', msg.plan?.length ?? 0)
      set({ exitPlanApproval: { requestId: msg.requestId, plan: msg.plan || '' } })
      break

    case 'askUserAck':
      // Java 确认已收到用户选择，关闭弹窗
      set({ askUser: null, exitPlanApproval: null })
      break

    case 'ideTheme':
    case 'files':
      break

    case 'models':
      set({ models: msg.models })
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
      // persist 无记忆时，从已有消息推断（models 刚加载，messages 推断可能因缺 providerId 失败）
      if (!get().currentModel) {
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

    case 'modelSet':
      set({ currentModel: { modelId: msg.modelId, providerId: msg.providerId } })
      // 切换模型后立即刷新用量，圆环 size 随新模型窗口更新（不用等下次对话结束）
      setTimeout(() => get().loadUsage(), 500)
      // 级别集随模型变化（off/high/max ↔ enabled/off），重拉 settings（current 由服务端校准）
      setTimeout(() => get().loadSettings(), 500)
      break

    case 'settings': {
      // 过期的 settings 响应（切会话竞态）直接丢弃
      if (msg.sessionId !== get().currentSessionId) break
      set({
        currentMode: msg.mode?.current ?? null,
        thoughtLevel: msg.thoughtLevel,
      })
      // 按当前模型缓存级别集（待命态/懒创建首问前的显示与校验用）
      writeThoughtLevelCache(get().currentModel?.modelId, msg.thoughtLevel)
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
        set({ quota: msg.data ?? null, quotaLoading: false, usageError: null, quotaFetchedAt: Date.now() })
      }
      break

    case 'memoryFiles':
      set({ memoryFiles: msg.files, memoryLoading: false, memoryError: null })
      break

    case 'memoryFileCreated':
      // 创建成功后重拉清单刷新存在状态（Kotlin 侧已自动用编辑器打开）
      set({ memoryCreatingPath: null })
      get().loadMemoryFiles()
      break

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
        set({ modelUsage: msg.data ?? null })
      }
      break

    case 'toolUsage':
      if (msg.error) {
        set({ toolUsage: null, usageError: msg.error })
      } else {
        set({ toolUsage: msg.data ?? null })
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
  for (const event of events) {
    if (event.type === 'state.updated') continue
    // 防御：子会话原生流不应出现转发标记，出现则跳过（转发事件走父会话流）
    if (event.type === 'tool.updated' && isSubagentToolEvent(event.payload)) continue
    const r = applyStreamEvent(messages, event, streamingId)
    messages = r.messages
    streamingId = r.streamingMessageId
  }
  const st = get()
  set({
    childLiveMessages: { ...st.childLiveMessages, [sessionId]: messages },
    childStreamingIds: { ...st.childStreamingIds, [sessionId]: streamingId },
  })
}

function handleStreamBatch(
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

  let messages = get().messages
  let streamingMessageId = get().streamingMessageId
  let activities = get().subagentActivities
  let turnStarted = false
  let turnEnded = false
  let modeEvent: 'enter_plan' | 'exit_plan' | undefined
  const childKeyPatch: Record<string, string> = {}

  for (const event of events) {
    // 状态变化通知（不走消息归约，直接同步 settings）
    if (event.type === 'state.updated') {
      applyStateUpdated(event, set)
      continue
    }
    // 子代理生命周期通知（session.updated / kind=subagent.lifecycle）：
    // spawned 携带 childSessionId → 注册子会话；stopped → 详情弹窗开着则拉权威全量
    if (event.type === 'session.updated') {
      const lc = asSubagentLifecycle(event.payload)
      if (lc) {
        applySubagentLifecycle(lc, set, get)
        continue
      }
    }
    // 子代理转发工具事件（source=subagent）：不进主聊天 parts（防刷屏），
    // 聚合到 subagentActivities 供底部子代理栏与详情弹窗使用
    if (event.type === 'tool.updated' && isSubagentToolEvent(event.payload)) {
      activities = applySubagentToolEvent(activities, event.payload, event.timestamp)
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
    }
    if (event.type === 'turn.started') turnStarted = true
    const result = applyStreamEvent(messages, event, streamingMessageId)
    messages = result.messages
    streamingMessageId = result.streamingMessageId
    if (result.turnEnded) turnEnded = true
    if (result.modeEvent) modeEvent = result.modeEvent
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
  }
  if (modeEvent) applyModeEventToPatch(modeEvent, patch, get)
  set(patch)
  // exit_plan 不立即回读 settings：批准瞬间服务端 state 层仍是 plan，回读会把上面的
  // 推断值覆盖回去。推断值保持显示到回合结束，由下方 turnEnded 路径
  // （state.updated 即时推送 + loadSettings）校正

  if (turnEnded) {
    console.log(`[store] turn 结束（批量），重新拉取消息确保一致`)
    // 本批未同时开启新 turn 时自动发送队列下一条（同批 completed+started 说明服务端已自动续轮）
    if (!turnStarted) get().flushQueue()
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

  // 状态变化通知（panel 单推，低频即时）：模式/级别跟随服务端
  if (event.type === 'state.updated') {
    applyStateUpdated(event, set)
    return
  }

  // 子代理生命周期通知（spawned/stopped）：注册子会话，stop 时按需拉权威
  if (event.type === 'session.updated') {
    const lc = asSubagentLifecycle(event.payload)
    if (lc) {
      applySubagentLifecycle(lc, set, get)
      return
    }
  }

  // 子代理转发工具事件分流（同批量路径）：聚合不进主聊天
  if (event.type === 'tool.updated' && isSubagentToolEvent(event.payload)) {
    const st = get()
    const activities = applySubagentToolEvent(st.subagentActivities, event.payload, event.timestamp)
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
  }

  const { messages, streamingMessageId, turnEnded, modeEvent } = applyStreamEvent(
    get().messages,
    event,
    get().streamingMessageId,
  )

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
    set({ streaming: false, streamingMessageId: null, waitingSince: null })
    console.log(`[store] turn ${event.type}，重新拉取消息确保一致`)
    get().flushQueue()
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
