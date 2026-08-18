/**
 * ZCode 消息 TypeScript 类型定义
 *
 * ⚠️ 本文件基于 2026-08-13 抓包实测（scripts/capture-tool-use.json 等），
 * 不是推测。详见 docs/计划与里程碑/UI重构规划.md 第十一节。
 *
 * 关键修正点（与 cc-gui / 早期推测不同）：
 * - 工具调用 part.type 是 "tool"（不是 "tool_use"），input/output 在 state 子对象
 * - 思考 part.type 是 "reasoning"（不是 "thinking"）
 * - 不存在独立 tool_result part，结果在 tool.state.output
 * - user 消息 info.model 是嵌套对象，assistant 是扁平字段 modelID/providerID
 */

// ============ 消息 part 类型 ============

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart

export interface TextPart {
  type: 'text'
  text: string
  id?: string
  sessionID?: string
  messageID?: string
  /** 合成标记：子agent/任务回调等系统注入的 text part（非真实发言）*/
  synthetic?: boolean
  metadata?: Record<string, unknown>
}

/** 思考过程（抓包确认：type 是 "reasoning"，不是 "thinking"） */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
  metadata?: { anthropic?: { signature?: string } }
  time?: { start: number; end?: number }
  id?: string
  sessionID?: string
  messageID?: string
}

/** 工具调用（抓包确认：type 是 "tool"，input/output 都在 state 里） */
export interface ToolPart {
  type: 'tool'
  callID: string
  tool: string // "Read" | "Edit" | "Bash" | "Agent" | ...
  state: ToolState
  id?: string
  sessionID?: string
  messageID?: string
}

export interface ToolState {
  status: 'pending' | 'running' | 'completed' | 'error'
  input?: Record<string, unknown>
  /** 流式期间累积的原始工具输入 JSON 片段（tool_input_delta，未完整无法解析时展示原文）*/
  inputRaw?: string
  output?: string
  title?: string
  error?: { message: string; code?: string }
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
}

export interface StepStartPart {
  type: 'step-start'
  id?: string
  sessionID?: string
  messageID?: string
}

export interface StepFinishPart {
  type: 'step-finish'
  reason: 'tool-calls' | 'stop' | 'max-tokens' | 'error' | string
  cost: number
  tokens: TokenBreakdown
  id?: string
}

// ============ 消息 ============

export interface ZCodeMessage {
  info: MessageInfo
  parts: MessagePart[]
}

export interface MessageInfo {
  role: 'user' | 'assistant'
  time: { created: number; completed?: number }
  agent?: string
  // user 消息用嵌套 model
  model?: { providerID: string; modelID: string }
  // assistant 消息用扁平字段
  modelID?: string
  providerID?: string
  mode?: string // build | edit | plan | yolo
  tokens?: TokenBreakdown
  cost?: number
  finish?: string
  parentID?: string
  id: string
  sessionID: string
  semantics?: Record<string, unknown>
  /** 合成消息标记：子agent/任务回调、compact 摘要等系统注入消息（非真实用户发言）*/
  synthetic?: boolean
  /** 消息来源：background_task / subagent_message 等 */
  source?: string
  /** 可见性：model-only 等（服务端建议 UI 不直接展示原始内容）*/
  visibility?: string
  /** 来源元信息：originMeta{backgroundSource,title,workId} / subagentMessage{agentId,agentType,...} */
  metadata?: Record<string, unknown>
  anchor?: Record<string, unknown>
  path?: { cwd?: string; root?: string }
}

export interface TokenBreakdown {
  total: number
  input: number
  output: number
  reasoning: number
  cache?: { read: number; write: number }
}

// ============ 会话 ============

export interface SessionInfo {
  sessionId: string
  title: string
  status: string
  mode: string
  // Java 端返回扁平字段（拍平了协议的 workspace 嵌套对象）
  workspacePath: string
  workspaceKey?: string
  createdAt: number
  updatedAt: number
  /** 消息数（Java 直读 db.sqlite 统计；统计失败时字段缺省）*/
  messageCount?: number
  /** 内容大小（message+part 字节和；统计失败时字段缺省）*/
  sizeBytes?: number
}

// ============ IPC 请求 / 响应（JS ↔ Java）============

/** 外观配置（IDE 侧 PropertiesComponent 权威源；'' = 恢复主题默认/跟随 IDE）*/
export interface AppearanceConfig {
  fontScale: number
  themePref: '' | 'light' | 'dark'
  chatBg: string
  chatBar: string
  userMsg: string
}

export type JavaRequest =
  | { op: 'listSessions'; workspacePath?: string }
  | { op: 'createSession'; workspacePath?: string }
  /** 前端进入无会话待命态（「新建会话」延迟创建）→ Java 清 TabState 绑定与标签 tooltip */
  | { op: 'clearTabSession' }
  | { op: 'deleteSession'; sessionId: string }
  | { op: 'messages'; sessionId: string; workspacePath?: string }
  | { op: 'subagents'; sessionId: string }
  | { op: 'subagentMessages'; sessionId: string; workspacePath?: string }
  | { op: 'send'; sessionId: string; text: string; workspacePath?: string }
  | { op: 'subscribe'; sessionId: string; workspacePath?: string }
  /** 订阅子代理会话事件流（实时归约前提；不改当前会话/标签状态，见 Java handleSubscribeChild）*/
  | { op: 'subscribeChild'; sessionId: string; workspacePath?: string }
  | { op: 'stop'; sessionId: string }
  | { op: 'getIdeTheme' }
  | { op: 'listFiles'; query: string }
  | { op: 'listCommands'; query?: string }
  | { op: 'listModels' }
  /** 设置页「模型管理」只读清单（不去重/不滤 disabled，带 configPath）*/
  | { op: 'modelManageList' }
  | { op: 'setModel'; sessionId: string; modelId: string; providerId: string }
  | { op: 'getSettings'; sessionId: string }
  | { op: 'setThoughtLevel'; sessionId: string; thoughtLevel: string }
  | { op: 'setMode'; sessionId: string; mode: string }
  | { op: 'pickFiles' }
  | { op: 'getUsage'; sessionId: string }
  | { op: 'getQuota' }
  | { op: 'getModelUsage'; startTime: string; endTime: string }
  | { op: 'getToolUsage'; startTime: string; endTime: string }
  | { op: 'openFile'; filePath: string; line?: number }
  | { op: 'showDiff'; filePath: string; oldContent: string; newContent: string; title?: string }
  | { op: 'refreshFile'; filePath: string }
  | { op: 'listMemoryFiles' }
  | { op: 'createMemoryFile'; path: string }
  | { op: 'listSkills' }
  | { op: 'toggleSkill'; path: string; enabled: boolean }
  /** mode：status=状态快照（默认）| connect=真实连接（慢）*/
  | { op: 'listMcpServers'; mode?: 'status' | 'connect' }
  /** 单台服务器工具清单（force=true 前端绕过缓存强制重拉）*/
  | { op: 'mcpServerTools'; name: string; force?: boolean }
  /** MCP 连接日志（CLI 落盘的 mcp.* 事件，今天+昨天文件尾部）*/
  | { op: 'getMcpLogs' }
  | { op: 'askUserResponse'; requestId: string; action: 'accept' | 'decline'; answer?: string }
  | { op: 'createTab' }
  /** 会话内嵌浏览器开关（展示/收起右侧分栏，聊天区宽度恒定）*/
  | { op: 'toggleBrowserPane' }
  | { op: 'setTabTitle'; title: string; sessionId?: string }
  /** 外观配置全量回存 IDE（权威源，重启经 __ZCODE_APPEARANCE__ 注入回前端）*/
  | { op: 'appearanceSave'; config: AppearanceConfig }
  /** 通用 kv 增量回存 IDE（entries=改动 key 的 upsert，deletes=要删的 key；权威源重启经 __ZCODE_KVSTORE__ 注入）*/
  | { op: 'kvSave'; entries: Record<string, string>; deletes?: string[] }
  /** 拉取权威 kv（注入未达时的兜底通道：executeJavaScript 时序不稳 → 走消息通道必然可达）*/
  | { op: 'kvLoad' }
  /** 环境三件套检测（node/zcode.cjs/凭证），启动时与主界面「重新检测」触发 */
  | { op: 'checkEnv' }
  /** 保存环境路径配置：字段缺席=不改该项，空串=清除（回退自动探测）；后端验证通过才落盘 */
  | { op: 'envSave'; nodePath?: string; cliPath?: string }

/** 可切换的模型选项（来自 ~/.zcode/v2/config.json 的 provider 注册表）*/
export interface ModelOption {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  /** 上下文窗口大小（config.json limit.context），如 GLM-5.2=1000000 / GLM-5-Turbo=204800 */
  contextWindow?: number
  /** 最大输出 token（config.json limit.output）*/
  maxOutput?: number
}

/** 模型管理条目（config.json provider.models 节点，设置页只读展示）*/
export interface ModelManageModel {
  modelId: string
  modelName: string
  contextWindow?: number
  maxOutput?: number
}

/** 模型管理 provider 分组（与聊天 listModels 的差异：不去重、含 disabled、保留无 baseURL 项）*/
export interface ModelManageProvider {
  providerId: string
  providerName: string
  baseURL?: string
  enabled: boolean
  models: ModelManageModel[]
}

/**
 * 思考级别信息（session/read → settings.thoughtLevel）
 *
 * available 因模型而异（GLM-5.2=off/high/max、GLM-4.x/qwen=enabled/off、kimi=low/high/max），
 * 是级别选择器的权威数据源，不能前端硬编码。
 */
export interface ThoughtLevelInfo {
  available: { label: string; value: string }[]
  /** 当前生效级别（未设置时缺省 = 跟随 defaultLevel）*/
  current?: string
  /** 模型默认级别 */
  defaultLevel?: string
  /** 模型是否支持思考级别切换 */
  enabled: boolean
}

/** 权限模式选项（固定 4 项，与 ZCode 客户端 UI 一致；协议还有 auto 但不可经切换路径设置）*/
export interface ModeOption {
  value: 'build' | 'edit' | 'plan' | 'yolo'
  label: string
  /** 英文原名 + 描述（title 提示用）*/
  title: string
}

/**
 * 上下文构成分类（model_complete 事件 payload.contextUsageBreakdown）。
 * 抓包确认 7 种 source，按 chars 占比换算百分比。
 */
export type ContextSource =
  | 'system_prompt'
  | 'meta_user_context'
  | 'skills'
  | 'tool_prompt'
  | 'system_tool_schemas'
  | 'mcp_tool_schemas'
  | 'messages'

export interface ContextBreakdownItem {
  source: ContextSource
  chars: number
}

/** 斜杠命令项（输入框 / 快捷选择，Kotlin 端磁盘扫描）*/
export interface SlashCommand {
  /** 命令名（不含斜杠），如 code-review、review:code */
  name: string
  description?: string
  /** 类型：skill=技能（SKILL.md），command=命令（.md）*/
  kind: 'skill' | 'command'
  /** 来源：user / workspace / plugin */
  source?: string
}

/**
 * 记忆文件项（设置页「记忆」条目，Kotlin 端清单扫描 + 自动记忆目录扫描）
 * 指令记忆缺失项也返回（exists=false），前端提供「创建」入口。
 */
export interface MemoryFileInfo {
  /** 文件名：AGENTS.md / MEMORY.md / 事实.md */
  name: string
  /** global=全局（~/.zcode） / project=项目（项目根或自动记忆目录）*/
  scope: 'global' | 'project'
  /** instructions=指令记忆（缺失可创建）/ auto=ZCode 自动提取的事实记忆（只读）*/
  kind: 'instructions' | 'auto'
  /** 绝对路径 */
  path: string
  /** 是否已存在 */
  exists: boolean
  /** 文件大小（exists 时）*/
  sizeBytes?: number
  /** 最后修改时间戳（exists 时）*/
  lastModified?: number
  /** 展示说明 */
  description?: string
}

/**
 * 技能条目（设置页「技能」数据源 SkillScanner，对齐 zcode skills list 语义）
 * junction 挂载的同一技能已在后端按真实路径去重。
 */
export interface SkillInfo {
  name: string
  description?: string
  /** frontmatter when_to_use：自动触发时机 */
  whenToUse?: string
  /** SKILL.md 绝对路径（编辑器打开锚点 / config 禁用条目 key）*/
  path: string
  directory: string
  /** user=全局 | project=项目 | plugin=插件贡献 */
  scope: 'user' | 'project' | 'plugin'
  /** zcode | agents | plugin（scope 内的根目录来源）*/
  source: string
  /** 插件技能的插件名（路径推断，识别失败缺省）*/
  pluginName?: string
  /** false=config skill 节点显式禁用（enable:false）*/
  enabled: boolean
}

/**
 * MCP 服务器条目（设置页「MCP」数据源 = 磁盘配置 McpConfigReader + RPC mcp/list 状态合并）
 * status 为空 = RPC 未返回（失败降级），前端显示「未知」态。
 */
export interface McpServerInfo {
  name: string
  /** user=全局 config | project=项目配置 | plugin=插件 .mcp.json | runtime=仅 RPC 可见（临时注入）*/
  scope: 'user' | 'project' | 'plugin' | 'host' | 'runtime'
  /** stdio | http | sse */
  transport: string
  command?: string
  args?: string[]
  url?: string
  /** env 变量名（值不透出）*/
  envKeys?: string[]
  /** config enabled 字段（false 时 RPC 状态为 disabled）*/
  enabled: boolean
  /** 来源配置文件路径（「打开配置文件」用；runtime 条目为空串）*/
  configPath: string
  pluginName?: string
  /** connecting | connected | disabled | disconnected | failed | untrusted（null=未知）*/
  status?: string
  toolCount?: number
  /** 连接失败/异常信息 */
  statusError?: string
  updatedAt?: string
}

/**
 * MCP 工具条目（McpToolsClient 直连服务器调 tools/list 的结果；
 * 协议 mcp/list 无工具明细，只有 toolCount）
 */
export interface McpToolInfo {
  name: string
  /** 工具描述（Kotlin 端已截 400 字符，tooltip 用）*/
  description?: string
}

/** 单台服务器的工具列表加载状态（store 按 serverName 存槽）*/
export interface McpToolsState {
  tools: McpToolInfo[]
  loading: boolean
  error?: string
  fetchedAt: number
}

/**
 * MCP 连接日志条目（ZCode CLI 落盘的 mcp.* 事件，McpLogReader 解析）
 * timestamp 为 UTC ISO8601（前端 new Date() 转本地时区展示）。
 */
export interface McpLogEntry {
  timestamp: string
  /** info | warn | error */
  level: string
  /** 原始事件名（前端按事件染色，如 mcp.server.connected 绿）*/
  event: string
  /** 服务器名（startup 类事件为空串）*/
  serverName: string
  /** 人读中文摘要（后端已从 context 拼好）*/
  message: string
  durationMs?: number
}

// ============ 运行环境状态（Kotlin ZCodeEnvChecker 契约，camelCase 对齐）============

export interface EnvNodeStatus {
  /** 用户是否配置过路径（配置无效不回退自动探测，直接报错）*/
  configured: boolean
  /** 实际生效路径（配置值或 PATH 探测值）*/
  path?: string
  found: boolean
  /** 形如 "v20.11.1" */
  version?: string
  versionTooLow: boolean
  minVersion: number
  error?: string
}

export interface EnvCliStatus {
  configured: boolean
  path?: string
  found: boolean
  error?: string
}

export interface EnvCredentialStatus {
  ok: boolean
  /** 生效 provider 的首个 model（展示用）*/
  model?: string
  error?: string
  /** 实际读取的 config.json 路径（随 dataBaseDir 重定向）*/
  path?: string
}

export interface EnvStatus {
  node: EnvNodeStatus
  cli: EnvCliStatus
  credentials: EnvCredentialStatus
  allOk: boolean
}

export type JavaResponse =
  | { op: 'listSessions'; sessions: SessionInfo[] }  | { op: 'createSession'; sessionId: string }
  | { op: 'tabSessionCleared' }
  | { op: 'sessionDeleted'; sessionId: string }
  | { op: 'messages'; sessionId: string; messages: ZCodeMessage[] }
  | { op: 'subagents'; sessionId: string; data: SubagentsResult; error?: string }
  | { op: 'subagentMessages'; sessionId: string; messages: ZCodeMessage[]; error?: string }
  | { op: 'sendAccepted'; sessionId: string; accepted: string; cliResponse?: unknown }
  | { op: 'subscribed'; sessionId: string; alreadySubscribed?: boolean }
  | { op: 'subscribedChild'; sessionId: string }
  | { op: 'stopped'; sessionId: string }
  | { op: 'streamEvent'; sessionId: string; event: StreamEvent }
  | { op: 'streamBatch'; sessionId: string; events: StreamEvent[] }
  | { op: 'newSession'; oldSessionId: string; sessionId: string }
  | { op: 'askUser'; requestId: string; toolName: string; questions: AskUserQuestion[] }
  | { op: 'exitPlanApproval'; requestId: string; plan: string }
  | { op: 'askUserAck' }
  | { op: 'tabCreating' }
  | { op: 'browserPaneToggled'; visible: boolean }
  | { op: 'tabTitleSet' }
  | { op: 'appearanceSave' }
  | { op: 'kvSave' }
  /** 权威 kv 下发（kvLoad 的响应；注入兜底通道）*/
  | { op: 'kvLoaded'; kv: Record<string, string> }
  /** 环境状态（checkEnv 查询 / envSave 保存成功后的重检结果 / IDE 广播同构体）*/
  | { op: 'envStatus'; status: EnvStatus }
  | { op: 'ideTheme'; isDark: boolean }
  | { op: 'files'; files: string[] }
  | { op: 'commands'; commands: SlashCommand[] }
  | { op: 'filesToInput'; refs: string[] }
  | { op: 'models'; models: ModelOption[] }
  | { op: 'modelManage'; configPath?: string; providers: ModelManageProvider[]; error?: string }
  | { op: 'modelSet'; sessionId: string; modelId: string; providerId: string }
  | { op: 'settings'; sessionId: string; mode: { current?: string }; thoughtLevel: ThoughtLevelInfo }
  | { op: 'thoughtLevelSet'; sessionId: string; thoughtLevel: string }
  | { op: 'modeSet'; sessionId: string; mode: string }
  // hitRate 缺省 = 服务端暂无统计（新 turn 首次模型调用完成前聚合器为空），
  // Kotlin 端对 JSON null 不输出该字段——前端据此显示"—"，而非误导性的 0%
  | { op: 'usage'; sessionId?: string; used: number; size: number; hitRate?: number; breakdown?: ContextBreakdownItem[] }
  | { op: 'quota'; data?: QuotaData | null; error?: string }
  | { op: 'modelUsage'; data?: ModelUsageData | null; error?: string }
  | { op: 'toolUsage'; data?: ToolUsageData | null; error?: string }
  | { op: 'fileOpened' }
  | { op: 'diffShown' }
  | { op: 'fileRefreshed' }
  | { op: 'memoryFiles'; files: MemoryFileInfo[] }
  | { op: 'memoryFileCreated'; path: string }
  | { op: 'skills'; skills: SkillInfo[] }
  | { op: 'skillToggled'; path: string; enabled: boolean }
  /** rpcError 存在 = mcp/list RPC 失败，servers 为磁盘配置降级清单 */
  | { op: 'mcpServers'; mode: string; servers: McpServerInfo[]; rpcError?: string }
  /** 单台服务器的工具清单（McpToolsClient 直连结果；失败只有 error）*/
  | { op: 'mcpServerTools'; name: string; tools?: McpToolInfo[]; toolCount?: number; error?: string }
  /** MCP 连接日志条目（McpLogReader 读 CLI jsonl，中文摘要已拼好）*/
  | { op: 'mcpLogs'; logs: McpLogEntry[] }
  /** envStatus 存在 = 环境前置检查失败（EnvCheckException），前端据此刷新环境提醒条 */
  | { op: 'error'; message: string; envStatus?: EnvStatus }
  /** app-server stderr 解析出的后端模型 API 错误（APICallError 兜底通道）：
   *  429 配额超限等被服务端按可重试分类退避重试，turn 终止帧迟迟不发时的第一现场 */
  | { op: 'backendError'; statusCode?: number; code?: string; message: string }

// ============ 流式事件（session/event 透传）============
// 基于抓包确认（scripts/capture-tool-use.json 的事件汇总）

export interface StreamEvent {
  type: string
  seq: number
  sessionId: string
  turnId?: string | null
  timestamp: number
  payload: StreamEventPayload
}

export type StreamEventPayload =
  | { kind: 'text_delta'; delta: string; assistantMessageId?: string; done?: boolean }
  | { kind: 'reasoning_delta'; delta: string; assistantMessageId?: string; done?: boolean }
  | ToolUpdatedPayload
  | TurnStartedPayload
  | TurnCompletedPayload
  | TurnFailedPayload
  | Record<string, unknown> // 兜底（session.updated 等暂不处理的）

/**
 * tool.updated 的各 kind（抓包确认：scheduled → started → result → batch）
 *
 * 子代理归属字段（2026-08-14 zcode.cjs 源码确认，ETn 转发函数）：
 * 子代理内部工具事件用父会话 sessionId 转发（进度透传），payload 额外携带
 * source:"subagent" + agentId/childSessionId/parentToolCallId 等归属字段，
 * toolCallId 是重映射后的父可见 id（真实子会话 id 在 childToolCallId）。
 */
export interface ToolUpdatedPayload {
  kind: 'scheduled' | 'started' | 'progress' | 'result' | 'error' | 'batch'
  toolCallId?: string
  toolName?: string
  result?: { success?: boolean; content?: string; error?: string }
  toolCallIds?: string[]
  successCount?: number
  errorCount?: number
  startedAt?: number
  // scheduled 阶段的调度信息
  schedule?: { parallelGroups?: string[][]; executionOrder?: string[] }
  // ---- 子代理转发事件专属（source==='subagent'）----
  source?: 'subagent'
  /** 父会话 Agent 工具调用的 callID（关联主聊天 Agent 卡）*/
  parentToolCallId?: string
  agentId?: string
  agentType?: string
  /** 子会话 id（拉取原始过程的钥匙）*/
  childSessionId?: string
  /** 子会话内真实的 toolCallId */
  childToolCallId?: string
  /** 子代理任务描述（Agent 工具 input.description）*/
  description?: string
  /** 后台子代理标记（run_in_background）*/
  background?: boolean
  [key: string]: unknown
}

export interface TurnStartedPayload {
  turnNumber?: number
  input?: string
  messageId?: string
  [key: string]: unknown
}

export interface TurnCompletedPayload {
  response?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface TurnFailedPayload {
  error: { type?: string; code?: string | number; message: string; detail?: string }
  turnPhase?: string
}

// ============ AskUserQuestion（用户交互弹窗）============
// 抓包确认：interaction/requestUserInput 反向请求的 questions 结构

export interface AskUserQuestion {
  question: string
  header?: string
  options: AskUserOption[]
  multiSelect?: boolean
}

export interface AskUserOption {
  optionId?: string
  label: string
  description?: string
}

// ============ 状态面板（对齐 cc-gui StatusPanel）============
// 数据源：从消息历史解析（见 utils/parseStatus.ts）
// - 任务：最后一次 TodoWrite 工具调用的 input.todos
// - Agent：Agent/Task 工具调用（description + 状态）
// - 文件改动：Edit/Write/MultiEdit 工具调用按文件路径聚合

export interface TodoItem {
  content: string
  status: 'completed' | 'in_progress' | 'pending' | string
  priority?: string
}

export interface AgentItem {
  /** 工具描述（子 agent 任务说明）*/
  description: string
  status: 'pending' | 'running' | 'completed' | 'error' | string
  subagentType?: string
  callID: string
  /** 子会话 id（RPC 或流式事件可得；有它才能查看原始过程）*/
  childSessionId?: string
  /** 任务摘要（已结束时 RPC 返回）*/
  summary?: string
  startedAt?: number
  endedAt?: number
  /** 是否后台子代理（run_in_background）：part.time 只是调度往返，耗时另有取舍（见 mergeAgentItems）*/
  background?: boolean
}

// ============ 子代理（流式聚合 + session/subagents RPC）============
// 两个数据源：
// - SubagentActivity：流式期间从 tool.updated(source=subagent) 事件实时累积（前端自有）
// - SubagentInfo：session/subagents RPC 的权威列表（turn 结束/会话加载时刷新）

/**
 * 流式期间按 parentToolCallId 聚合的子代理活动。
 * tools 复用 ToolPart 形状，ToolCallCard 可直接渲染。
 */
export interface SubagentActivity {
  /** 聚合键 = 父会话 Agent 工具调用的 callID（parentToolCallId）*/
  key: string
  agentId?: string
  agentType?: string
  description?: string
  childSessionId?: string
  /** 是否后台子代理（run_in_background）*/
  background?: boolean
  status: 'running' | 'completed' | 'failed'
  tools: ToolPart[]
  /** 最近一次事件时间戳（排序/展示用）*/
  lastUpdate: number
  /** 首个事件时间戳（子代理启动近似时刻，本地计时起点）*/
  startedAt?: number
  /** 收尾事件时间戳（父 Agent 工具 result 时刻，本地计时终点）*/
  endedAt?: number
}

/** session/subagents RPC 返回的子代理条目（running + ended.items 同构）*/
export interface SubagentInfo {
  childSessionId: string
  agentId?: string
  /** 父会话 Agent 工具调用的 callID（关联主聊天 Agent 卡）*/
  toolCallId: string
  subagentType?: string
  title?: string
  status: string
  summary?: string
  startedAt?: number
  endedAt?: number
}

/** session/subagents RPC 完整返回 */
export interface SubagentsResult {
  revision: number
  childSessionIds: string[]
  running: SubagentInfo[]
  ended: { total: number; items: SubagentInfo[]; nextCursor?: string }
}

export interface FileChangeItem {
  filePath: string
  /** 纯文件名（展示用）*/
  fileName: string
  additions: number
  deletions: number
  /** 该文件每次编辑的替换内容（弹前后对比用；Write 为整文件新增，oldContent 为空）*/
  edits?: FileEditContent[]
}

/** 单次编辑的替换片段（Edit 的 old/new_string；Write 只有 newContent）*/
export interface FileEditContent {
  oldContent: string
  newContent: string
}

// ============ 额度数据（glm plan usage API）============
// 来源：{baseDomain}/api/monitor/usage/quota/limit → data.limits[]
// type: TOKENS_LIMIT(token额度) | TIME_LIMIT(次数额度)
// unit: 3=每5小时, 6=每周, 5=MCP每月

export interface QuotaLimit {
  type?: string
  unit?: number
  percentage?: number
  currentValue?: number
  usage?: number
  nextResetTime?: number
}

/** 额度聚合（quota/limit → data）*/
export interface QuotaData {
  limits: QuotaLimit[]
  level?: string
}

/** 时间范围（用量明细 tab + 自定义日期）*/
export type UsageRange = 'today' | '7d' | '30d' | 'custom'

/** 模型用量曲线数据（model-usage → data）
 *  注：granularity / x_time 是 data 顶层字段（全模型共用 X 轴），服务端按时间窗回传，客户端不发 */
export interface ModelUsageData {
  granularity?: string // 'hourly' | 'daily'
  x_time?: string[]
  totalUsage?: { totalModelCallCount?: number; totalTokensUsage?: number }
  modelSummaryList?: { modelName?: string; totalTokens?: number }[]
  modelDataList?: { modelName?: string; totalTokens?: number; tokensUsage?: number[] }[]
}

/** 工具用量曲线数据（tool-usage → data）。字段名与 model 不同：totalUsageCount/usageCount */
export interface ToolUsageData {
  granularity?: string
  x_time?: string[]
  toolSummaryList?: { toolName?: string; toolNameI18n?: string; toolCode?: string; totalUsageCount?: number }[]
  toolDataList?: {
    toolName?: string
    toolNameI18n?: string
    toolCode?: string
    totalUsageCount?: number
    usageCount?: number[]
  }[]
}
