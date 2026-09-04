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
  | ImagePart
  | FilePart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | TimelinePart
  | CompactionPart

/**
 * 图片 part：服务端把用户消息附件转成的读回形态（zcode.cjs 实测），
 * dataUrl 为完整 "data:<mimeType>;base64,..."；本地乐观消息用
 * dataBase64 + mediaType 构造同构对象（见 useStore.sendMessage）。
 */
export interface ImagePart {
  type: 'image'
  mediaType?: string
  /** 完整 data URL（服务端回流）；乐观消息亦用此形态渲染 */
  dataUrl?: string
  /** 乐观消息携带的裸 base64（无 dataUrl 时前端拼 data URL 渲染）*/
  dataBase64?: string
  source?: {
    id?: string
    kind?: 'inline' | 'local_file'
    mimeType?: string
    placeholder?: string
    path?: string
    filename?: string
    metadata?: Record<string, unknown>
  }
  id?: string
  sessionID?: string
  messageID?: string
}

/**
 * 文件 part（2026-08-26 RPC 实测）：用户图片附件在 session/messages 读回时的
 * 真实形态（type 是 "file" 不是 "image"）。url 原始为 zcode-artifact:// 私有协议，
 * Java 端 ImageArtifactMapper 已换成内置 server 的 http URL（换不动时保持原样，
 * 前端 src 解析失败不渲染——fail-soft）。mime 为 image/* 时按图片渲染。
 */
export interface FilePart {
  type: 'file'
  mime?: string
  /** zcode-artifact://（Java 未转换）或 http://127.0.0.1:<port>/zcode-image/...（已转换）*/
  url?: string
  filename?: string
  metadata?: Record<string, unknown>
  id?: string
  sessionID?: string
  messageID?: string
}

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
  /** 失败详情双形态：历史读回（session/messages）为纯字符串；流式 tool.updated(kind=error) 为 {message, code} */
  error?: string | { message: string; code?: string }
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

/**
 * 时间线分隔符 part（2026-08-21 RPC 实测，/compact 排查）：
 * marker 消息（role=assistant）的核心 part，官方语义 display:"separator"。
 * timelineType 已见 context_compaction（上下文压缩）、model_change（模型切换）
 * 与 goal_verification（目标校验，2026-09 diag-goal3.py 实测）。
 */
export interface TimelinePart {
  type: 'timeline'
  timelineType?: string
  display?: string
  status?: string
  /** context_compaction：压缩前后 token（truePost 为模型真实上下文）*/
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  truePostCompactTokenCount?: number
  /** model_change：切换前后模型（服务端实测字段为 modelId 小写 d，modelID 为老类型定义笔误保留兼容）*/
  fromModel?: { modelID?: string; modelId?: string; label?: string; variant?: string }
  toModel?: { modelID?: string; modelId?: string; label?: string; variant?: string }
  /** goal_verification：目标校验（消息 id 形如 msg_goal_verify_<targetId>_<iteration>）*/
  targetId?: string
  verificationId?: string
  goalIteration?: number
  verification?: { passed: boolean; reason?: string; nextAction?: string | null }
  anchorMessageId?: string
  anchorTurnId?: string
  time?: { start: number; end?: number }
  [key: string]: unknown
}

/**
 * 压缩元数据 part：挂在 marker 消息（过程指标）与摘要消息（compactBoundary
 * 完整对象）上，与 TimelinePart 信息互补。
 */
export interface CompactionPart {
  type: 'compaction'
  auto?: boolean
  trigger?: string
  /** 摘要消息上的完整边界对象（被摘要消息数等）*/
  compactBoundary?: {
    summarizedMessageCount?: number
    keptMessageCount?: number
    summarySource?: string
    [key: string]: unknown
  }
  [key: string]: unknown
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
  /** 定时消息标记（fireAt）：定时到点发出的乐观 user 消息携带（历史重拉不带，预期）*/
  scheduledFireAt?: number
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
  /**
   * /compact 压缩摘要消息（role=user）的顶层字段（2026-08-21 RPC 实测）：
   * {title:"Compact summary", body:"摘要全文"}。消息级无 synthetic 标记（仅
   * part 级有），不能靠 isHiddenSyntheticMessage 过滤，须专门识别渲染。
   */
  summary?: { title?: string; body?: string }
}

// ============ 目标模式（session/goal，2026-09 实测） ============

/**
 * 目标模式状态（服务端 target 对象 + goalStats 轮次统计的合并视图）。
 * target 实测字段：objective/summaryTitle/status/tokensUsed/timeUsedSeconds/
 * tokenBudget（nullable）；goalStats 补充 iterationCount/toolCallCount。
 * status 为服务端四态；v4 快照还有更细的 verifying/notSatisfied 中间态，
 * legacy 消息流只见四态 + goal_verification 分隔卡（校验过程以卡片呈现）。
 */
export interface GoalState {
  targetId: string
  objective: string
  summaryTitle?: string | null
  status: 'active' | 'paused' | 'budget_limited' | 'complete' | string
  tokensUsed: number
  timeUsedSeconds: number
  tokenBudget?: number | null
  iterationCount: number
  toolCallCount?: number
  /** 轮末校验进行中（run_finished → 下一轮 run_started 之间）：卡片显示"校验中" */
  verifying?: boolean
  /** 服务端统计值落地时刻（本地走秒基准；active 时 timeUsedSeconds + 流逝秒递增显示）*/
  syncedAt?: number
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
  /** 归档标记时间戳（毫秒，取 ZCode 客户端任务索引 updated_at）；缺省 = 未归档（仅已归档列表的项带此字段）*/
  archivedAt?: number
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

/** askUserResponse 请求（AskUserDialog 提交用；accept 时 answer/answers 二选一）*/
export type AskUserResponseMsg =
  | { op: 'askUserResponse'; requestId: string; action: 'decline' }
  | {
      op: 'askUserResponse'
      requestId: string
      action: 'accept'
      answer?: string | string[]
      answers?: Record<string, string | string[]>
    }

/**
 * interaction/requestPermission 的选项（zcode.cjs t5() 生成，服务端实发形态）。
 * response 为应答体（decision/permissionUpdates 等），Java 侧按 optionId 回填，
 * 前端渲染只需 kind/name/description
 */
export interface PermissionOption {
  kind: 'allow_once' | 'allow_always' | 'deny' | string
  name: string
  optionId: string
  description?: string
  response?: unknown
}

/** 输入框图片附件（发给 zcode.cjs session/send 的协议形态，2026-08-26 源码确认）*/
export interface ImageAttachmentInput {
  kind: 'image'
  /** 文件名（服务端缺省 "attachment"）*/
  filename: string
  /** MIME，如 image/png */
  mimeType: string
  /** base64 解码后的真实字节数 */
  sizeBytes: number
  /** 纯 base64（不含 data URL 前缀），与 localPath 二选一 */
  dataBase64: string
}

export type JavaRequest =  | { op: 'askUserPendingState' }
  /** 前端诊断日志直落 idea.log（Java handleJsMessage 的 [webview-console] 通道） */
  | { op: '__jsLog'; level: string; text: string }
  | { op: 'listSessions'; workspacePath?: string }
  | { op: 'createSession'; workspacePath?: string }
  /** 前端进入无会话待命态（「新建会话」延迟创建）→ Java 清 TabState 绑定与标签 tooltip */
  | { op: 'clearTabSession' }
  | { op: 'deleteSession'; sessionId: string }
  /** 归档会话（标记 time_archived，不删数据，可恢复）*/
  | { op: 'archiveSession'; sessionId: string }
  /** 恢复归档会话（置 time_archived = NULL）*/
  | { op: 'restoreSession'; sessionId: string }
  /** 拉取已归档会话列表 */
  | { op: 'listArchivedSessions'; workspacePath?: string }
  /** reconcile=true：流式静默对账探测（看门狗只读快照，响应带 reconcile 标记） */
  | { op: 'messages'; sessionId: string; workspacePath?: string; reconcile?: boolean; goalRefresh?: boolean }
  | { op: 'subagents'; sessionId: string }
  | { op: 'subagentMessages'; sessionId: string; workspacePath?: string }
  | { op: 'send'; sessionId: string; text: string; workspacePath?: string; providerId?: string; modelId?: string; attachments?: ImageAttachmentInput[] }
  /** 剪贴板兜底：JCEF 偶发不把图片暴露给 clipboardData（CC-GUI 用 IDE action 兜底，
   *  我们用按需桥更轻）——Java 读 AWT 剪贴板 DataFlavor.imageFlavor → PNG base64 返回 */
  | { op: 'getClipboardImage' }
  | { op: 'subscribe'; sessionId: string; workspacePath?: string }
  /** 订阅子代理会话事件流（实时归约前提；不改当前会话/标签状态，见 Java handleSubscribeChild）*/
  | { op: 'subscribeChild'; sessionId: string; workspacePath?: string }
  /** 子代理 stopped 终点退订：收敛 v4 订阅/行表/探针计数（best-effort，失败无害）*/
  | { op: 'unsubscribeChild'; sessionId: string }
  | { op: 'stop'; sessionId: string; /** 连带中止的后台任务 id（exec_ bash 任务，账本仍在跑的）；子代理由 Java 侧权威枚举 */ taskIds?: string[] }
  | { op: 'getIdeTheme' }
  | { op: 'listFiles'; query: string }
  | { op: 'listCommands'; query?: string }
  | { op: 'listModels' }
  /** 设置页「模型管理」清单（apiKey 缺失的无效 provider 已过滤，带 configPath）*/
  | { op: 'modelManageList' }
  /** 切换 provider 启用/禁用（Kotlin 备份+原子写回 config.json 的 enabled 字段）*/
  | { op: 'modelToggleProvider'; providerId: string; enabled: boolean }
  | { op: 'setModel'; sessionId: string; modelId: string; providerId: string }
  /** 撤销回合中挂起的延迟切换（用户在等待期重新选回生效模型）*/
  | { op: 'cancelModelSwitch'; sessionId: string }
  | { op: 'getSettings'; sessionId: string }
  | { op: 'setThoughtLevel'; sessionId: string; thoughtLevel: string }
  | { op: 'setMode'; sessionId: string; mode: string }
  /** 目标模式管理（session/goal 封装）：set/replace 带 objective，其余动作不带 */
  | { op: 'goalManage'; sessionId: string; action: 'set' | 'replace' | 'pause' | 'resume' | 'clear' | 'show'; objective?: string }
  | { op: 'pickFiles' }
  | { op: 'getUsage'; sessionId: string }
  | { op: 'getQuota' }
  | { op: 'getAppUsage'; range: AppUsageRange }
  | { op: 'getModelUsage'; startTime: string; endTime: string }
  | { op: 'getToolUsage'; startTime: string; endTime: string }
  | { op: 'openFile'; filePath: string; line?: number }
  | { op: 'showDiff'; filePath: string; oldContent: string; newContent: string; title?: string }
  | { op: 'refreshFile'; filePath: string }
  | { op: 'listMemoryFiles' }
  | { op: 'createMemoryFile'; path: string }
  /** 切换「工作区记忆」开关（写 ~/.zcode/v2/setting.json，与 ZCode 客户端共用）*/
  | { op: 'setMemoryEnabled'; enabled: boolean }
  /** 浏览器设置快照（控制开关/插件安装态）*/
  | { op: 'browserConfig' }
  /** 清除内置浏览器数据（mode=cache 保留 Cookie 与本地站点数据；all 全清）*/
  | { op: 'clearBrowserData'; mode: 'cache' | 'all' }
  /** 浏览器数据概览（清理条目旁「查看」按钮，只读）*/
  | { op: 'browserDataOverview' }
  | { op: 'listSkills' }
  | { op: 'toggleSkill'; path: string; enabled: boolean }
  /** 提示词润色（一次性 CLI headless 调用，零会话污染；模型跟随当前选择）*/
  | { op: 'enhancePrompt'; text: string; workspacePath?: string; providerId?: string; modelId?: string }
  /** 子智能体清单（user + project 作用域磁盘扫描，disabled 已过滤）*/
  | { op: 'listAgents' }
  /** 新建/更新/改名子智能体（originalName 非空且 ≠ name = 改名）*/
  | { op: 'saveAgent'; scope: 'user' | 'project'; agent: AgentDefInput; originalName?: string }
  | { op: 'deleteAgent'; scope: 'user' | 'project'; name: string }
  /** mode：status=状态快照（默认）| connect=真实连接（慢）*/
  | { op: 'listMcpServers'; mode?: 'status' | 'connect' }
  /** 单台服务器工具清单（force=true 前端绕过缓存强制重拉）*/
  | { op: 'mcpServerTools'; name: string; force?: boolean }
  /** MCP 连接日志（CLI 落盘的 mcp.* 事件，今天+昨天文件尾部）*/
  | { op: 'getMcpLogs' }
  /**
   * AskUserQuestion 应答：单问题用 answer（原始值，多选为数组），
   * 多问题用 answers（问题文本 → 值）。zcode.cjs 端按此结构回填工具结果，
   * 整体 JSON 字符串会被服务端判定"无答案"（AI 认为用户没选）。
   */
  | { op: 'askUserResponse'; requestId: string; action: 'accept' | 'decline'; answer?: string | string[]; answers?: Record<string, string | string[]> }
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
  // ============ 定时消息（权威列表在 Java 侧 ZCodeScheduledMessageService）============
  /** 新建定时消息（fireAt 绝对 epoch ms；过早由 Java 钳到 +10s；模型可空=跟随会话）*/
  | { op: 'scheduledCreate'; sessionId: string; workspacePath?: string; text: string; fireAt: number; providerId?: string; modelId?: string }
  | { op: 'scheduledCancel'; id: string }
  | { op: 'scheduledReschedule'; id: string; fireAt: number; text?: string; providerId?: string; modelId?: string }
  /** 立即执行：走 Java 分派（与到点分派同一路径，回合活跃入队尾/空闲直发）*/
  | { op: 'scheduledSendNow'; id: string }
  /** 切会话回退：定时来源的排队消息交还 Java 挂起（hold=true 不自动发）*/
  | { op: 'scheduledRequeue'; sessionId: string; workspacePath?: string; text: string; fireAt: number; providerId?: string; modelId?: string }
  /** 初始化水合：请求 Java 推送全量列表（scheduledList）*/
  | { op: 'scheduledList' }
  /** 到点受理回执：webview 已入队或已发；Java 超时未收到则降级直发 */
  | { op: 'scheduledDueAck'; id: string }
  /** 真发上报：定时消息实际发出（sendMessage 真发点）后上报 Java 记入已发历史（持久徽标数据源）*/
  | { op: 'scheduledFired'; sessionId: string; text: string; fireAt: number }
  /** 任务列表跳转会话：Java 统一 openSessionTab——激活已有宿主标签，无则新建标签按 sessionId 恢复 */
  | { op: 'gotoSession'; sessionId: string }
  /** 历史列表打开前定位：查所有标签是否已绑定该会话（有则 Java 直接激活宿主标签跳转，无副作用）*/
  | { op: 'locateSession'; sessionId: string }
  /** mermaid 复制图片：PNG 纯 base64 → Java 系统剪贴板（JCEF 的 clipboard.write 图片不可靠的降级通道）*/
  | { op: 'copyImage'; dataBase64: string }
  /** 调系统浏览器打开外链。无 url = 打开本项目 GitHub 仓库（设置页开源支持区块）；
   *  带 url = 网页工具卡/来源链接/markdown 链接的跳转（Java 侧 http/https 白名单二次校验）*/
  | { op: 'openExternal'; url?: string }

/** 可切换的模型选项（来自 ~/.zcode/v2/config.json 的 provider 注册表）*/
export interface ModelOption {
  providerId: string
  providerName: string
  /** 内置套餐类型（两个内置套餐显示名相同，靠 providerId 区分）：personal=个人、trial=体验 */
  plan?: 'personal' | 'trial'
  modelId: string
  modelName: string
  /** 上下文窗口大小（config.json limit.context），如 GLM-5.2=1000000 / GLM-5-Turbo=204800 */
  contextWindow?: number
  /** 最大输出 token（config.json limit.output）*/
  maxOutput?: number
  /** 模型支持图片输入（config.json modalities.input 含 image；GLM 套餐为 false——
   *  带图消息的服务端会剥离图片成文字占位，模型看不到图，2026-08-26 实测定性）*/
  supportsImages?: boolean
}

/** 模型管理条目（config.json provider.models 节点，设置页只读展示）*/
export interface ModelManageModel {
  modelId: string
  modelName: string
  contextWindow?: number
  maxOutput?: number
  /** 视觉能力位（modalities.input 含 image），展示「视觉」徽章 */
  supportsImages?: boolean
}

/** 模型管理 provider 分组（与聊天 listModels 的差异：不去重、含 disabled、保留无 baseURL 项）*/
export interface ModelManageProvider {
  providerId: string
  providerName: string
  /** 内置套餐类型（两个内置套餐显示名相同，靠 providerId 区分）：personal=个人、trial=体验 */
  plan?: 'personal' | 'trial'
  /** 内置渠道命中方式：selected=客户端选中渠道生效；fallback=所选渠道凭证不可用回退首个可用内置 */
  via?: 'selected' | 'fallback'
  /** 兜底原因（via=fallback 时）：captchaGated=客户端所选渠道是体验套餐(zcode-plan 网关)
   *  被门控排除，徽章换"体验套餐无法使用"专属文案，区分于凭证失效 */
  viaReason?: 'captchaGated'
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
  /** 来源：user / workspace / plugin / builtin */
  source?: string
  /** 专属图标（codicon 类名，如 codicon-target）；缺省按 kind 取 wand/terminal */
  icon?: string
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
  /** 展示说明（后端中文，仅兜底；正式渲染走前端 i18n）*/
  description?: string
  /** auto 事实文件首个 # 标题（数据非文案，缺失走 factFallback）*/
  title?: string
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
 * 子智能体定义（~/.zcode/agents/<name>.md 或 <项目>/.zcode/agents/<name>.md，
 * 与 ZCode 客户端数据打通：frontmatter + 正文=系统提示词）。
 * 发送时消息文本前置 `@<name> ` 触发主 Agent 调度（2026-08-23 协议实测）。
 */
export interface AgentDef {
  name: string
  description: string
  /** 缺省 = 跟随主 Agent 当前模型 */
  model?: string
  thoughtLevel?: string
  /** 预设色标记（blue/green/red/orange/yellow/purple/pink/cyan）*/
  color?: string
  /** 空 = 继承全部工具（含 MCP）；非空 = 仅列表内工具 */
  tools: string[]
  disallowedTools: string[]
  maxTurns?: number
  /** 是否注入 AGENTS.md（默认 true）*/
  injectAgentsMd: boolean
  mcpServers: string[]
  /** Markdown 正文 = 系统提示词 */
  systemPrompt: string
  /** .md 绝对路径 */
  path: string
  scope: 'user' | 'project'
}

/** saveAgent 的写载荷（path/scope 由后端推导，无需前端携带）*/
export type AgentDefInput = Omit<AgentDef, 'path' | 'scope'>

/** 清除浏览器数据的单站点明细（cache 模式只填缓存两项；-1=页面不支持该 API）*/
export interface BrowserClearedSite {
  url: string
  cacheStorages: number
  serviceWorkers: number
  storage?: boolean
}

/** 概览里的单站点行（三来源归并：已打开 tab 实时计数 + Cookie 按域 + 磁盘标记；-1=仅有磁盘痕迹无实时计数）*/
export interface BrowserOverviewSite {
  /** origin（cookie 来源为裸域，其余为 scheme://host[:port]）*/
  origin: string
  /** 浏览器面板当前打开的站点 */
  open: boolean
  cookies: number
  cacheStorages: number
  serviceWorkers: number
  localStorageEntries: number
  /** 该站点 IndexedDB 磁盘占用（0=无）*/
  indexedDbBytes: number
  hasIndexedDb: boolean
}

/** 浏览器数据概览（清理条目旁「查看」按钮；cookieCount=-1=读取失败）*/
export interface BrowserDataOverview {
  httpCacheBytes: number
  httpCacheEntries: number
  codeCacheBytes: number
  cookieCount: number
  sites: BrowserOverviewSite[]
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
  /** 机器可读错误码（Java EnvChecker 产，i18n 键 app.envErrors.<code>）；探测成功缺省 */
  code?: string
  /** 错误码插值参数（路径/文件名） */
  arg?: string
}

export interface EnvCliStatus {
  configured: boolean
  path?: string
  found: boolean
  /** 形如 "0.16.5"（spawn `node <cli> --version`）；探测失败缺省 */
  version?: string
  error?: string
  code?: string
  arg?: string
}

export interface EnvCredentialStatus {
  ok: boolean
  /** 生效 provider 的首个 model（展示用）*/
  model?: string
  error?: string
  /** 实际读取的 config.json 路径（随 dataBaseDir 重定向）*/
  path?: string
  /** 机器可读错误码（credsMissing/credsInvalid）*/
  code?: string
}

export interface EnvBrowserHostStatus {
  ok: boolean
  error?: string
  /** 机器可读错误码（browserHostCefDown/browserHostHandlerMissing）*/
  code?: string
}

export interface EnvStatus {
  node: EnvNodeStatus
  cli: EnvCliStatus
  credentials: EnvCredentialStatus
  /** browser-use 宿主健康（非阻断建议项；null = 未探测/未初始化，旧包兼容）*/
  browserHost?: EnvBrowserHostStatus
  allOk: boolean
}

export type JavaResponse =
  | { op: 'listSessions'; sessions: SessionInfo[] }  | { op: 'createSession'; sessionId: string }
  | { op: 'tabSessionCleared' }
  | { op: 'sessionDeleted'; sessionId: string }
  | { op: 'sessionArchived'; sessionId: string }
  | { op: 'sessionRestored'; sessionId: string }
  | { op: 'archivedSessions'; sessions: SessionInfo[] }
  /** copyImage 回执：Java 系统剪贴板写入结果 */
  | { op: 'imageCopied'; ok: boolean; error?: string }
  // ============ 定时消息（Java 侧广播/定向推送）============
  /** 全量镜像（广播到全部标签；UI 按 currentSessionId 过滤）；fired=已发记录（徽标匹配用）。
   *  ts=Java 单调取号，webview 只应用更新的快照（多线程广播到达乱序防旧快照复活已移除项）*/
  | { op: 'scheduledList'; ts?: number; items: import('../store/useStore').ScheduledMessageItem[]; fired?: import('../store/useStore').ScheduledFiredRecord[] }
  /** 到点分派：走 webview 准入路径（sendMessage：回合活跃入队尾/空闲直发），处理后 ack */
  | { op: 'scheduledDue'; id: string; sessionId: string; text: string; scheduledFireAt?: number; providerId?: string; modelId?: string }
  /** 跳转会话应答：external=Java 已激活宿主标签（本标签不动）；local=本标签 selectSession */
  | { op: 'gotoSessionOpened' }
  /** 定位应答：found=true 时 Java 已激活宿主标签（发起标签只需切回聊天视图）；false=无宿主标签 */
  | { op: 'sessionTabLocated'; sessionId: string; found: boolean }
  | { op: 'messages'; sessionId: string; messages: ZCodeMessage[]; reconcile?: boolean; goalRefresh?: boolean; goalTarget?: unknown; goalStats?: unknown }
  | { op: 'subagents'; sessionId: string; data: SubagentsResult; error?: string }
  | { op: 'subagentMessages'; sessionId: string; messages: ZCodeMessage[]; error?: string }
  /** 目标操作回执：target/goalStats 为服务端 snapshot 提取；error=服务端拦截/失败（乐观更新回滚）*/
  | { op: 'goalManaged'; sessionId: string; action: string; response?: string; startedTurn?: boolean; target?: unknown; goalStats?: unknown; error?: string }
  | { op: 'sendAccepted'; sessionId: string; accepted: string; cliResponse?: unknown }
  /** getClipboardImage 响应：base64 缺省 = 剪贴板无图片（Java 侧读取失败同样返回空）*/
  | { op: 'clipboardImage'; base64?: string; mediaType?: string }
  /** subscribed 附带驻留水位警告：Java 侧账本预计打开后越过提醒阈值（16 上限，缺陷BA）*/
  | { op: 'subscribed'; sessionId: string; alreadySubscribed?: boolean; residentPoolWarning?: boolean }
  | { op: 'subscribedChild'; sessionId: string; v4?: boolean }
  | { op: 'unsubscribedChild'; sessionId: string }
  | { op: '__jsLogAck' }
  | { op: 'stopped'; sessionId: string }
  | { op: 'streamEvent'; sessionId: string; event: StreamEvent }
  | { op: 'streamBatch'; sessionId: string; events: StreamEvent[] }
  | { op: 'newSession'; oldSessionId: string; sessionId: string }
  | { op: 'askUser'; requestId: string; toolName: string; questions: AskUserQuestion[]; deadlineMs?: number }
  | { op: 'exitPlanApproval'; requestId: string; plan: string; deadlineMs?: number }
  /** 工具权限审批弹窗（服务端 interaction/requestPermission；应答走 askUserResponse，answer=optionId）*/
  | {
      op: 'permissionRequest'
      requestId: string
      toolName: string
      reason: string
      options: PermissionOption[]
      /** 工具输入（Write 的 file_path/content、Bash 的 command 等；缺省容忍）*/
      input?: unknown
      riskLevel?: string
      deadlineMs?: number
    }
  | { op: 'askUserPending'; active: boolean }
  | { op: 'askUserStateAck' }
  /** 服务端同族重发换新 id：保活权限弹窗的 requestId（点击命中服务端当前在等的 id）*/
  | { op: 'permissionRequestRefresh'; requestId: string }
  /** 反向请求终结确认；requestId 缺省 = 旧格式兜底全清（正常路径都带 id 精确关窗）*/
  | { op: 'askUserAck'; requestId?: string }
  | { op: 'tabCreating' }
  | { op: 'externalOpened' }
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
  | { op: 'filesToInput'; refs: string[]; source?: 'drag' | 'menu' | 'picker' }
  | { op: 'models'; models: ModelOption[] }
  | { op: 'modelManage'; configPath?: string; providers: ModelManageProvider[]; error?: string }
  /** 切换回包：changes 含全部实际变更（启用内置套餐时其余内置套餐联动禁用，互斥）*/
  | { op: 'modelToggled'; changes: { providerId: string; enabled: boolean }[] }
  | { op: 'modelSet'; sessionId: string; modelId: string; providerId: string }
  /** 回合中切换挂起（缺陷AC）：Java 挂起目标模型等回合结束补发，前端回滚选中态并提示 */
  | { op: 'modelSetPending'; sessionId: string; modelId: string; providerId: string }
  /** 挂起的切换补发失败（回合结束后重试仍报错）：清除提示并告警；
   *  reason=captchaGated = 体验套餐(zcode-plan 网关)渠道被入口拦截，前端映射本地化文案 */
  | { op: 'modelSetFailed'; sessionId: string; modelId: string; providerId: string; message: string; reason?: 'captchaGated' }
  /** 挂起的延迟切换已撤销（cancelModelSwitch 回执）*/
  | { op: 'modelSwitchCancelled'; sessionId: string }
  /** Java 忙窗口重试成功通知（缺陷AB）：顶栏忙窗口提示据此清除 */
  | { op: 'busyRetryRecovered' }
  /** P2 用量查询失败静默降级（缺陷AB 编排②）：不弹错、不复位 streaming */
  | { op: 'usageError'; sessionId: string; message: string }
  | { op: 'settings'; sessionId: string; mode: { current?: string }; thoughtLevel: ThoughtLevelInfo }
  | { op: 'thoughtLevelSet'; sessionId: string; thoughtLevel: string }
  | { op: 'modeSet'; sessionId: string; mode: string }
  // hitRate 缺省 = 服务端暂无统计（新 turn 首次模型调用完成前聚合器为空），
  // Kotlin 端对 JSON null 不输出该字段——前端据此显示"—"，而非误导性的 0%
  // activeTurnKind/activeTurnId：当前回合类型与 id（'compact' = 上下文压缩中，前端
  // 压缩状态条依据；turnId 供滞后读数比对——见 useStore case 'usage'）
  | { op: 'usage'; sessionId?: string; used: number; size: number; hitRate?: number; breakdown?: ContextBreakdownItem[]; activeTurnKind?: string; activeTurnId?: string }
  // providerId/providerName：monitor 三路 HTTP 实际取 key 的渠道（回退链不筛身份，
  // 可能落到非 coding-plan 渠道，用量页据此提示数据口径）
  | { op: 'quota'; data?: QuotaData | null; error?: string; providerId?: string; providerName?: string }
  | { op: 'appUsage'; data?: AppUsageData | null; error?: string }
  | { op: 'modelUsage'; data?: ModelUsageData | null; error?: string; providerId?: string; providerName?: string }
  | { op: 'toolUsage'; data?: ToolUsageData | null; error?: string; providerId?: string; providerName?: string }
  | { op: 'fileOpened' }
  | { op: 'diffShown' }
  | { op: 'fileRefreshed' }
  | { op: 'memoryFiles'; files: MemoryFileInfo[]; memoryEnabled: boolean; memorySettingPath: string }
  | { op: 'memoryEnabledChanged'; enabled: boolean }
  | { op: 'memoryFileCreated'; path: string }
  /** 浏览器设置快照（op=browserConfig 的响应）*/
  | { op: 'browserConfig'; browserControlEnabled: boolean; pluginInstalled: boolean }
  /** op=clearBrowserData 的响应（sites=已清站点数据明细；httpCache/cookies 全局项）*/
  | { op: 'browserDataCleared'; ok: boolean; all: boolean; httpCache: boolean; cookies?: boolean; sites: BrowserClearedSite[] }
  /** op=browserDataOverview 的响应（概览：磁盘占用 + Cookie 计数 + 已打开站点计数）*/
  | { op: 'browserDataOverview' } & BrowserDataOverview
  | { op: 'skills'; skills: SkillInfo[] }
  | { op: 'skillToggled'; path: string; enabled: boolean }
  /** op=enhancePrompt 的响应（error 非 nil = 失败，弹窗错误态）*/
  | { op: 'enhancePromptResult'; original?: string; text?: string; error?: string; model?: string }
  | { op: 'agents'; agents: AgentDef[] }
  | { op: 'agentSaved'; name: string; scope: string }
  | { op: 'agentDeleted'; name: string; scope: string }
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
  /** 事件来源标记："snapshot" = v4 订阅/重同步的快照回放（全量非流式，前端跳过切片回放） */
  deliveryKind?: string | null
  payload: StreamEventPayload
}

export type StreamEventPayload =
  | { kind: 'text_delta'; delta: string; assistantMessageId?: string; done?: boolean }
  | { kind: 'reasoning_delta'; delta: string; assistantMessageId?: string; done?: boolean }
  | ToolUpdatedPayload
  | TurnStartedPayload
  | TurnCompletedPayload
  | TurnFailedPayload
  | { messageId?: string; text: string } // turn.userInput（v4 快照回放的 user 消息）
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

/** 应用用量时间范围（usage/stats 协议口径，无自定义区间）*/
export type AppUsageRange = '7d' | '30d' | 'all'

/** 应用用量汇总（usage/stats → summary；app-server 本地会话聚合，无 apiKey 依赖）*/
export interface AppUsageSummary {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  cacheHitRate?: number
  totalSessions?: number
  totalTurns?: number
  toolCallCount?: number
  toolErrorRate?: number
  modelErrorRate?: number
  avgTimeToFirstTokenMs?: number
  activeDays?: number
}

/** 应用用量模型行（含第三方模型；share 为 0~1 占比）*/
export interface AppModelUsage {
  modelId?: string
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  requestCount?: number
  share?: number
}

/** 应用用量工具行 */
export interface AppToolUsage {
  toolName?: string
  callCount?: number
  errorCount?: number
  errorRate?: number
}

/** 应用用量数据（usage/stats → data）*/
export interface AppUsageData {
  range?: string
  source?: string
  generatedAt?: number
  summary?: AppUsageSummary
  models?: AppModelUsage[]
  tools?: AppToolUsage[]
  dailyModelUsage?: { date?: string; models?: { modelId?: string; totalTokens?: number }[] }[]
}
