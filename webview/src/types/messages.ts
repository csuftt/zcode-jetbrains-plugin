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
  /** interrupted = 孤儿运行中断态：会话被强杀/中断时服务端只写 turnHeader 终态，
   *  Agent 工具 part 在转录里永远停在 running——非流式历史落地时本地纠偏（仅限
   *  Agent/Task/subagent 工具，服务端永不回传此值） */
  status: 'pending' | 'running' | 'completed' | 'error' | 'interrupted'
  input?: Record<string, unknown>
  /** 流式期间累积的原始工具输入 JSON 片段（tool_input_delta，未完整无法解析时展示原文）*/
  inputRaw?: string
  output?: string
  title?: string
  /** 失败详情双形态：历史读回（session/messages）为纯字符串；流式 tool.updated(kind=error) 为 {message, code} */
  error?: string | { message: string; code?: string }
  metadata?: Record<string, unknown>
  /** 工具结果媒体（如 CUA get_app_state 截图）：来自 v4 行 output.display.media，
   *  data 为 base64（无前缀），mimeType 形如 image/jpeg */
  media?: { mimeType: string; data: string }[]
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
  /** model_change：切换前后模型（服务端实测字段为 modelId 小写 d，modelID 为老类型定义笔误保留兼容；
   * providerID 大写 D 为 2026-09-14 db.sqlite 实测字段——供应商变化时渲染要带上供应名，
   * 本地合成卡写入时沿用同名字段保持两源一致）*/
  fromModel?: { modelID?: string; modelId?: string; label?: string; variant?: string; providerID?: string }
  toModel?: { modelID?: string; modelId?: string; label?: string; variant?: string; providerID?: string }
  /** goal_verification：目标校验（消息 id 形如 msg_goal_verify_<targetId>_<iteration>）*/
  targetId?: string
  verificationId?: string
  goalIteration?: number
  verification?: { passed: boolean; reason?: string; nextAction?: string | null }
  /** session_fork：分叉来源（2026-09-05 diag-fork2.py 实测；另含 targetMessageId/restoredFileCount）*/
  parentSessionId?: string
  targetMessageId?: string
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
  // assistant 消息用扁平字段（v1 大写 D）；v2 服务端改小写驼峰 modelId/providerId
  //（2026-09-17 db.sqlite 实测：值都在，仅字段名变了），双命名兼容读取
  modelID?: string
  providerID?: string
  modelId?: string
  providerId?: string
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
   * 协议回合 id(本地流式壳专属):turn.started 事件携带,同 turn 重复投递的幂等
   * 判重键 + turn.completed 本地补 completed 的对账键。服务端转录真身无此字段,
   * 快照落地被真身顶替后自然消失
   */
  turnId?: string
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

/** 历史列表用：某会话当前已在哪个标签打开（listOpenSessions 应答元素）*/
export interface OpenTabInfo {
  sessionId: string
  tabName: string
}

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
  /** 会话种类（仅 fork 值下发；历史列表 fork 徽标判据，Java 层已按 sqlite fork id 集归一打标）*/
  sessionKind?: string
  /** 目标模式会话标识（sqlite session_target 有行即算，active/complete 都标）；与 sessionKind 正交 */
  goalTarget?: boolean
}

/**
 * 后台工作投影条目（v4 snapshot backgroundWorks 原样形状，服务端权威状态机）。
 * resultPending = 已完成、结果等待前台空闲投递（投递后条目消失）；workId 是取消/
 * 输出查询的主键；childSessionId 仅 subagent 条目携带。
 * status 'ended' 是**本地转录重建合成值**（协议无此值）：IDE 重启后运行时投影消失，
 * 从转录后台化确认行重建的历史任务已随进程死亡，以 ended 呈现（不可取消、无投影）。
 */
export interface BackgroundWorkSummary {
  workId: string
  kind: 'bash' | 'subagent' | 'workflow'
  title: string
  status: 'running' | 'resultPending' | 'failed' | 'cancelled' | 'ended'
  startedAt: number
  endedAt?: number
  cancellable?: boolean
  blocked?: boolean
  anchorRowId?: number | null
  childSessionId?: string
}

/** 后台 bash 输出快照（v4/conversation/backgroundBashOutput 响应两形态原样）*/
export type BackgroundBashOutputResult =
  | {
      kind: 'output'
      workId: string
      status: 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'spawn_error'
      output: string
      truncated: boolean
      outputPath: string
    }
  | { kind: 'unavailable' | 'unsupported' | 'read_failed'; workId: string; code?: string }

// ============ 工作区钩子准入（v4 workspaceHookAdmission 投影，官方横幅数据源） ============

/** 单条钩子声明的信任状态（设计 §2.2；字符串兜底防版本漂移） */
export type HookTrustState =
  | 'trusted_persistent'
  | 'pending_trust'
  | 'blocked_untrusted'
  | 'revoked'
  | 'stale_digest'
  | (string & {})

/** 钩子准入投影（官方会话内「N 个 Hook 待审核」横幅的数据源）；
 *  null=已准入/无待审（收敛横幅）。官方不把待审钩子放进 pendingInteractions
 *  评审交互（2026-10-13 客户端实测），旧评审卡路线已移除 */
export interface WorkspaceHookAdmission {
  pendingCount: number
  bundleDigest?: string
  workspaceIdentity?: string
}

/** zcode CLI `hooks trust status --json` 的单条钩子 */
export type HookScope = 'workspace' | 'user'

export interface WorkspaceHooksStatusItem {
  reviewItemId: string
  event: string
  matcher: string | null
  displayCommand: string
  sourcePath: string
  configuredEnabled: boolean
  hookDeclarationDigest: string
  /** user_scope=用户级钩子（~/.zcode/cli/config.json，无信任准入，enabled 即生效） */
  trustState: HookTrustState | 'user_scope'
}

/** zcode CLI `hooks trust status --json` 结果（工作区钩子权威数据源）；
 *  scope=user 时为 Kotlin 直读用户配置构造的同构形态（无 bundleDigest/reasonCode） */
export interface WorkspaceHooksStatus {
  scope?: HookScope
  workspacePath?: string
  workspaceIdentity?: string
  userConfigPath?: string
  bundleDigest?: string
  reasonCode?: string
  /** 插件附加：`.zcode/config.json` 根开关 hooks.enabled（缺省 false=钩子系统未启用，条目照列但永不生效） */
  rootEnabled?: boolean
  items: WorkspaceHooksStatusItem[]
}

/**
 * sessions-index v4 topic 的会话摘要（官方 SessionSummary 原样字段，Java 侧已过滤
 * 子代理会话与软删）。列表活性订阅（op=sessionIndexUpdate）的行数据。
 */
export interface SessionIndexEntry {
  sessionId: string
  workspaceId?: string
  title?: string
  /** custom=用户显式重命名；default/generated 均非手动标题（官方 titleSource 语义） */
  titleSource?: string
  /** draft/prewarming/running/completedSuccess/completedInterrupted/error */
  phase?: string
  sessionEnded?: boolean
  hasBackgroundWork?: boolean
  lastActivityAt?: number
  createdAt?: number
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

/**
 * 当前文件上下文附件描述（webview→Java op 层自有形态，不是 zcode.cjs 协议字段）。
 * InputBox doSend 按 chip 显示值（enabled && currentFileRef 同一取值表达式）派生，
 * 放 attachments 数组首位；Java 按 path+行号读文件切片内容，转成 zcode.cjs
 * session/send 的 kind:'file' + textContent 附件发出（ZCode 源码坐实的隐式内容
 * 通道：模型收到 Read 工具结果形态的 system-reminder，user bubble 不显示）。
 */
export interface CurrentFileAttachmentInput {
  kind: 'currentFile'
  /** 绝对路径（ref 去 @ 前缀、去 #L 行号后缀）*/
  path: string
  /** 选区起始行（1 起，含）；与 lineEnd 成对出现，缺省 = 整文件 */
  lineStart?: number
  /** 选区结束行（1 起，含）*/
  lineEnd?: number
}

/** session/send 可携带的附件（图片内联 base64 / 当前文件上下文描述）*/
export type SendAttachmentInput = ImageAttachmentInput | CurrentFileAttachmentInput

/**
 * 编辑附件条目（op:editUserQuery 的 attachments 元素，Java 侧解析为 v4 ref 引用
 * 形态 {ref,fileName,mime,bytes}）。cache=保留的原消息图片（url 为 /zcode-image/
 * 映射或 zcode-artifact://，背后是 zcode.cjs image-cache 落盘文件，直接引用磁盘
 * 路径）；inline=编辑时新粘贴的图（dataBase64 → Java 落临时文件供服务端读）。
 */
export type JavaEditAttachment =
  | { source: 'cache'; url: string; mime: string; fileName?: string }
  | { source: 'inline'; dataBase64: string; mime: string; fileName?: string }

export type JavaRequest =  | { op: 'askUserPendingState' }
  /** 前端诊断日志直落 idea.log（Java handleJsMessage 的 [webview-console] 通道） */
  | { op: '__jsLog'; level: string; text: string }
  | { op: 'listSessions'; workspacePath?: string }
  | { op: 'createSession'; workspacePath?: string; thoughtLevel?: string }
  /** 关联目录三件套（多目录会话·变体A）：拉列表 / 弹系统目录选择框添加 / 按路径移除 */
  | { op: 'getLinkedWorkspaces' }
  /** 启动兜底：__ZCODE_WORKSPACE__ 注入空串（重启初期面板先于 basePath 就绪）时拉生效项目路径 */
  | { op: 'getProjectPath' }
  | { op: 'addLinkedWorkspace' }
  | { op: 'removeLinkedWorkspace'; path: string }
  /** 前端进入无会话待命态（「新建会话」延迟创建）→ Java 清 TabState 绑定与标签 tooltip */
  | { op: 'clearTabSession' }
  | { op: 'deleteSession'; sessionId: string }
  /** 归档会话（标记 time_archived，不删数据，可恢复）*/
  | { op: 'archiveSession'; sessionId: string }
  /** 恢复归档会话（置 time_archived = NULL）*/
  | { op: 'restoreSession'; sessionId: string }
  /** 删除归档会话（软删对齐 ZCode 客户端：tasks.deleted=1，数据保留可复活）*/
  | { op: 'deleteArchivedSession'; sessionId: string }
  /** 置顶/取消置顶会话（tasks-index pinned 位，写库后 Java 全标签广播 sessionPinsChanged）*/
  | { op: 'setSessionPinned'; sessionId: string; pinned: boolean }
  /** 拉取当前置顶会话全量集（历史列表加载对账，顺带吸收官方桌面端库内 pin 变化）*/
  | { op: 'listPinnedSessions' }
  /** 拉取当前未读会话全量集（历史列表加载对账；tasks-index unread_at 位）*/
  | { op: 'listUnreadSessions' }
  /** 后台 bash 任务输出快照（v4/conversation/backgroundBashOutput；running 态前端 1s 轮询）*/
  | { op: 'backgroundBashOutput'; sessionId: string; workId: string }
  /** 取消后台工作（v4/command cancelBackgroundWork；子代理另有 stop 连带/取消链路）*/
  | { op: 'cancelBackgroundWork'; sessionId: string; workId: string }
  /** 后台工作投影缓存查询（打开会话对账；重复订阅不重推快照的兜底）*/
  | { op: 'backgroundWorksList'; sessionId: string }
  /** 钩子管理页：拉取/授予/撤销/启停（Kotlin 经 zcode CLI hooks trust 子命令；
   *  grant all=true=授予当前全部，否则按 hookDigests；revoke 空 hookDigests=全撤；
   *  scope=user 走用户级配置（~/.zcode/cli/config.json，直读直写无 CLI、无信任）；
   *  所有操作回统一形态 {op:'workspaceHooksList', status} */
  | { op: 'workspaceHooksList'; workspace?: string; scope?: HookScope }
  | { op: 'workspaceHooksGrant'; workspace: string; hookDigests?: string[]; all?: boolean; bundleDigest?: string }
  | { op: 'workspaceHooksRevoke'; workspace: string; hookDigests?: string[] }
  | { op: 'workspaceHooksToggle'; workspace?: string; reviewItemId: string; sourcePath: string; enabled: boolean; scope?: HookScope }
  /** 删除单条钩子登记项（Kotlin 从 config 移除并逐级剪枝；脚本文件保留在磁盘；
   *  回统一形态 {op:'workspaceHooksList', status}）*/
  | { op: 'workspaceHooksDelete'; workspace?: string; reviewItemId: string; sourcePath: string; scope?: HookScope }
  /** 命令行点击：在 IDE 打开钩子脚本文件（Kotlin 从 displayCommand 解析脚本路径，
   *  解析不到/文件不存在时回退打开来源配置 sourcePath；scope=user 相对路径基准 home）*/
  | { op: 'workspaceHooksOpenScript'; workspace?: string; displayCommand: string; sourcePath: string; scope?: HookScope }
  /** 自动归档：读共享配置（~/.zcode/v2/setting.json，与 ZCode 客户端同源）*/
  | { op: 'getAutoArchiveConfig' }
  /** 自动归档：写共享配置（客户端下次读取同样生效）*/
  | { op: 'setAutoArchiveConfig'; enabled: boolean; olderThanDays: number }
  /** 自动归档：拉取归档记录（仅 >0 轮次，Kotlin PropertiesComponent 存储）*/
  | { op: 'getAutoArchiveRecords' }
  /** 自动归档：手动立即扫描一轮（受开关约束；多目录会话 workspacePath=历史页浏览目录，缺省项目根）*/
  | { op: 'runAutoArchiveNow'; workspacePath?: string }
  /** 拉取已归档会话列表 */
  | { op: 'listArchivedSessions'; workspacePath?: string }
  /** reconcile=true：流式静默对账探测（看门狗只读快照，响应带 reconcile 标记） */
  | { op: 'messages'; sessionId: string; workspacePath?: string; reconcile?: boolean; goalRefresh?: boolean }
  | { op: 'subagents'; sessionId: string }
  | { op: 'subagentMessages'; sessionId: string; workspacePath?: string }
  | { op: 'send'; sessionId: string; text: string; workspacePath?: string; providerId?: string; modelId?: string; thoughtLevel?: string; attachments?: SendAttachmentInput[] }
  /** 剪贴板兜底：JCEF 偶发不把图片暴露给 clipboardData（CC-GUI 用 IDE action 兜底，
   *  我们用按需桥更轻）——Java 读 AWT 剪贴板 DataFlavor.imageFlavor → PNG base64 返回 */
  | { op: 'getClipboardImage' }
  | { op: 'subscribe'; sessionId: string; workspacePath?: string }
  /** 订阅子代理会话事件流（实时归约前提；不改当前会话/标签状态，见 Java handleSubscribeChild）*/
  | { op: 'subscribeChild'; sessionId: string; workspacePath?: string }
  /** 子代理 stopped 终点退订：收敛 v4 订阅/行表/探针计数（best-effort，失败无害）*/
  | { op: 'unsubscribeChild'; sessionId: string }
  | { op: 'stop'; sessionId: string; /** 连带中止的后台任务 id（exec_ bash 任务，账本仍在跑的）；子代理由 Java 侧权威枚举 */ taskIds?: string[] }
  /** 引导式插队（steer）：v4 sendText requestedDelivery=guide，注入运行中回合（2026-09-07 探针定案）。
   *  commandId 前端生成（queueItemId=queue_<commandId> 服务端确定性派生，撤销句柄）；
   *  仅纯文本——带附件引导已砍（0.3.4 定案：guide+附件服务端必降级 queue 且不自动排空）*/
  | { op: 'steerMessage'; sessionId: string; text: string; commandId: string }
  /** 撤回引导中/服务端队列中的条目（v4 deleteQueueItem）：引导 chip ✕ 触发 */
  | { op: 'cancelSteer'; sessionId: string; queueItemId: string }
  /** 促发服务端队列条目立即执行（v4 sendQueuedNow，缺陷FD）：发送被服务端繁忙窗口
   *  静默降级进队列后的捞回；失败回退分类见应答 promoteQueuedInput */
  | { op: 'promoteQueuedInput'; sessionId: string; queueItemId: string }
  | { op: 'getIdeTheme' }
  | { op: 'listFiles'; query: string }
  | { op: 'listCommands'; query?: string }
  | { op: 'listModels' }
  /** 设置页「模型管理」清单（apiKey 缺失的无效 provider 已过滤，带 configPath）*/
  | { op: 'modelManageList' }
  /** 渠道连通性测试（provider/testModelConnectivity，服务端真发一次最小模型请求）*/
  | { op: 'modelTestConnectivity'; providerId: string; modelId: string }
  /** 切换 provider 启用/禁用（Kotlin 备份+原子写回 config.json 的 enabled 字段）*/
  | { op: 'modelToggleProvider'; providerId: string; enabled: boolean }
  /** 切换单个模型启用/禁用（NEW 代；写 provider_config.json providerModelRules[].config.enabled）*/
  | { op: 'modelToggleModel'; providerId: string; modelId: string; enabled: boolean }
  /** 设置/清除内置渠道自定义 apiKey 覆盖（apiKey 空串=清除），写 ~/.zcgui/config.json 并触发注册表推送 */
  | { op: 'modelSetProviderKey'; providerId: string; apiKey: string }
  /** 添加自定义模型渠道（写 config.json provider 注册表，UUID 作 providerId）*/
  | { op: 'modelAddProvider'; draft: ProviderSaveDraft }
  /** 编辑自定义渠道（字段缺省=不变；apiKey null=不变 空串=清除；models 传了整表替换）*/
  | { op: 'modelUpdateProvider'; providerId: string; draft: ProviderSaveDraft }
  /** 删除自定义渠道（含其全部模型）*/
  | { op: 'modelRemoveProvider'; providerId: string }
  | { op: 'modelReorderProviders'; providerIds: string[] }
  /** 重新执行内置渠道迁移（v2）：清一次性标记 + 立跑兜底迁移，回包 modelRemigrated */
  | { op: 'modelRemigrateBuiltins' }
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
  | { op: 'getSessionDebug'; sessionId: string }
  | { op: 'getQuota' }
  | { op: 'getAppUsage'; range: AppUsageRange }
  | { op: 'getModelUsage'; startTime: string; endTime: string }
  | { op: 'getToolUsage'; startTime: string; endTime: string }
  /** 打开文件；findText 可选——在编辑器 Find 栏填充该关键词并高亮全部命中 */
  | { op: 'openFile'; filePath: string; line?: number; findText?: string }
  /** 产物预览卡批量文件存在性检查（渲染前过滤已删除路径，防闪卡）*/
  | { op: 'checkFilesExist'; requestId: string; paths: string[] }
  /** 产物预览卡：用系统默认程序打开文件（Office/PDF/音视频等 IDE 无编辑器的类型；Java 侧白名单扩展名）*/
  | { op: 'openFileSystem'; filePath: string }
  | { op: 'showDiff'; filePath: string; oldContent: string; newContent: string; title?: string }
  | { op: 'refreshFile'; filePath: string }
  | { op: 'listMemoryFiles'; workspacePath?: string }
  /** 自动记忆目录全文检索（空格分词 AND；空 query 返回空表=退出搜索态）*/
  | { op: 'searchMemoryFiles'; query: string; workspacePath?: string }
  | { op: 'createMemoryFile'; path: string; workspacePath?: string }
  /** 在系统文件管理器中定位显示文件/目录（记忆目录排查入口）*/
  | { op: 'revealInFileManager'; path: string }
  /** 切换「工作区记忆」开关（写 ~/.zcode/v2/setting.json，与 ZCode 客户端共用）*/
  | { op: 'setMemoryEnabled'; enabled: boolean }
  /** 电脑控制开关快照（设置页「电脑控制」）*/
  | { op: 'getCuaEnabled' }
  /** 切换电脑控制开关（PropertiesComponent 全局；注入在新建会话时读取）*/
  | { op: 'setCuaEnabled'; enabled: boolean }
  /** 按 key 取 server 落盘的应用图标 PNG（base64；CUA 工具卡 header 渲染用）*/
  | { op: 'getCuaIcon'; key: string }
  /** 浏览器设置快照（控制开关/插件安装态）*/
  | { op: 'browserConfig' }
  /** 清除内置浏览器数据（mode=cache 保留 Cookie 与本地站点数据；all 全清）*/
  | { op: 'clearBrowserData'; mode: 'cache' | 'all' }
  /** 浏览器数据概览（清理条目旁「查看」按钮，只读）*/
  | { op: 'browserDataOverview' }
  | { op: 'listSkills'; workspacePath?: string }
  | { op: 'toggleSkill'; path: string; enabled: boolean; workspacePath?: string }
  /** 提示词润色（一次性 CLI headless 调用，零会话污染；模型跟随当前选择）。
   *  seq=润色代际（发起时自增），回包原样透传，前端据此丢弃关闭弹窗后的迟到回包 */
  | { op: 'enhancePrompt'; seq: number; text: string; workspacePath?: string; providerId?: string; modelId?: string }
  /** 用户取消润色：Kotlin 走 workspace/cancelGenerateText 即时中止在途请求（或销毁 CLI 子进程）*/
  | { op: 'cancelEnhancePrompt'; seq: number }
  /** AI 重新生成会话标题（excerpt=全会话对话摘录；providerId/modelId=当前会话模型透传，
   *  generateText 跟随会话模型避免选中未注册渠道，Kotlin 走 generateText + v4 renameSession）*/
  | { op: 'regenerateSessionTitle'; sessionId: string; excerpt: string; providerId?: string; modelId?: string }
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
  /** 模型调用轨迹（CLI 落盘的 model-io jsonl，debug+rollout 双目录尾部）*/
  | { op: 'getModelTrajectory'; sessionId: string }
  /** ::visualize 内联可视化打开：校验白名单路径换 /viz/<token> URL（singlefile 降级回 html 走 srcdoc）*/
  | { op: 'vizOpen'; path: string; theme?: 'dark' | 'light' }
  /** ::visualize 复制图片：上报 iframe 视口矩形，Java Robot 屏幕截取写系统剪贴板（沙箱拿不到 DOM 内容）*/
  | { op: 'copyVizImage'; x: number; y: number; w: number; h: number; vw: number; vh: number }
  /**
   * AskUserQuestion 应答：单问题用 answer（原始值，多选为数组），
   * 多问题用 answers（问题文本 → 值）。zcode.cjs 端按此结构回填工具结果，
   * 整体 JSON 字符串会被服务端判定"无答案"（AI 认为用户没选）。
   */
  | { op: 'askUserResponse'; requestId: string; action: 'accept' | 'decline'; answer?: string | string[]; answers?: Record<string, string | string[]> }
  | { op: 'createTab'; workspacePath?: string }
  /** 会话内嵌浏览器开关（展示/收起右侧分栏，聊天区宽度恒定）*/
  | { op: 'toggleBrowserPane' }
  | { op: 'setTabTitle'; title: string; sessionId?: string }
  /** 外观配置全量回存 IDE（权威源，重启经 __ZCODE_APPEARANCE__ 注入回前端）*/
  | { op: 'appearanceSave'; config: AppearanceConfig }
  /** 通用 kv 增量回存 IDE（entries=改动 key 的 upsert，deletes=要删的 key；权威源重启经 __ZCODE_KVSTORE__ 注入）*/
  | { op: 'kvSave'; entries: Record<string, string>; deletes?: string[] }
  /** 拉取权威 kv（注入未达时的兜底通道：executeJavaScript 时序不稳 → 走消息通道必然可达）*/
  | { op: 'kvLoad' }
  // ============ 浏览器级缩放（Ctrl+滚轮 = Chromium 原生行为，平台无变化通知）============
  /** 查询当前缩放百分比（前端 devicePixelRatio 变化时触发；percent 权威值在 Java 侧）*/
  | { op: 'zoomQuery' }
  /** 重置缩放为 100%（Ctrl+0 / 点击 toast；Java 侧 setZoomLevel(0)）*/
  | { op: 'zoomReset' }
  /** 环境三件套检测（node/zcode.cjs/凭证），启动时与主界面「重新检测」触发 */
  | { op: 'checkEnv' }
  /** 保存环境路径配置：字段缺席=不改该项，空串=清除（回退自动探测）；后端验证通过才落盘 */
  | { op: 'envSave'; nodePath?: string; cliPath?: string; cdpPortFile?: string }
  /** 拉取当前打开文件 ref（webview mount/重连时用；Kotlin 同步回包，对应 EditorContextTracker.snapshot）*/
  | { op: 'getCurrentFile' }
  /** 拉取网络代理配置（与 ZCode 客户端共享的 setting.json 三键） */
  | { op: 'getProxyConfig' }
  /** 保存网络代理三字段（空串=清除该项；写共享 setting.json，客户端重启后同样生效） */
  | { op: 'setProxyConfig'; httpProxy: string; noProxy: string; caCertPath: string }
  /** 重启 app-server 让新代理 env 生效（用户主动触发，接受打断进行中的回合） */
  | { op: 'restartAppServer' }
  // ============ Node 进程管理（设置页「进程」条目）============
  /** 进程快照（常驻 app-server / 直接子进程 / 疑似孤立；按需拉取无轮询） */
  | { op: 'getNodeProcesses' }
  /** 结束指定进程（pid 必须在 Kotlin 侧最新快照内，所有权守卫拒绝集外 pid） */
  | { op: 'killNodeProcess'; pid: number }
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
  | { op: 'gotoSession'; sessionId: string; workspacePath?: string }
  /** 从历史消息分叉新会话（B2 一期）：保留到该消息（含），新会话由 sessionForked 应答承载 */
  | { op: 'forkSession'; sessionId: string; messageId: string }
  /**
   * 编辑最后一轮用户消息（v4/command editUserQuery，diag-edit-v4 定案）：服务端
   * abort 活动回合 + rewind + 重发，回合中可编辑。attachments=编辑后的图片附件
   * 全量清单（cache=保留原图 image-cache 引用 / inline=新增粘贴图）；缺省=不带
   * 字段（服务端沿用原附件，仅限纯文本消息），[] =显式清空附件
   */
  | {
      op: 'editUserQuery'
      sessionId: string
      messageId: string
      newText: string
      attachments?: JavaEditAttachment[]
    }
  /**
   * 查询某轮改动的文件清单（B2 回合产物：v4/conversation/fileChanges）。
   * messageId = 该轮 assistant 消息 id（= turnHeader entityId）；应答 turnFileChangesResult
   */
  | { op: 'turnFileChanges'; sessionId: string; messageId: string }
  /** 预览撤销某轮的文件改动（v4/conversation/fileRewindPreview，hash 预检全有或全无） */
  | { op: 'turnFileRewindPreview'; sessionId: string; messageId: string }
  /** 执行撤销某轮的文件改动（v4/command applyFileRewind：恢复/删除文件，不截断聊天） */
  | { op: 'turnFileRewindApply'; sessionId: string; messageId: string }
  /** 会话重开后触发逐轮更改条重扫（标题订阅快照只在首订时有；Java 临时订阅重扫，异步） */
  | { op: 'turnFileChangesSync'; sessionId: string }
  /** 逐轮审查 → IDEA 侧内嵌（unified）对比弹窗：Java 把本轮 hunk 着色渲染成 Swing 弹窗
   *  （+/-行底色、无左右分栏；数据即服务端直出 hunk，不读磁盘）。path=相对路径（error
   *  应答回显，降级内置弹窗定位用）；缺参回 turnFileDiffError */
  | { op: 'turnFileDiff'; filePath: string; path: string; patches: TurnFileDiffHunk[]; title?: string }
  /** 历史列表打开前定位：查所有标签是否已绑定该会话（有则 Java 直接激活宿主标签跳转，无副作用）*/
  | { op: 'locateSession'; sessionId: string }
  /** 历史列表快照：查所有已绑定真实会话的标签（元素含标签名；只读，无副作用）*/
  | { op: 'listOpenSessions' }
  /** mermaid 复制图片：PNG 纯 base64 → Java 系统剪贴板（JCEF 的 clipboard.write 图片不可靠的降级通道）*/
  | { op: 'copyImage'; dataBase64: string }
  /** 调系统浏览器打开外链。无 url = 打开本项目 GitHub 仓库（设置页开源支持区块）；
   *  带 url = 网页工具卡/来源链接/markdown 链接的跳转（Java 侧 http/https 白名单二次校验）*/
  | { op: 'openExternal'; url?: string }
  /** 手机远程：开始连接 relay（幂等，已在连接则只回状态）*/
  | { op: 'remotePairStart' }
  /** 手机远程：强制重出码（重算 QR 时间戳，sid/hash 不变）*/
  | { op: 'remoteRefreshQr' }
  /** 手机远程：断开 relay 连接（凭据保留，重连免换码）*/
  | { op: 'remoteStop' }
  /** 手机远程：查询当前状态（QR URL / 连接态）*/
  | { op: 'remoteStatus' }
  /** 手机远程：解除配对（清除 PasswordSafe 凭据，下次连接重新注册设备）*/
  | { op: 'remoteUnpair' }

/** 可切换的模型选项（来自 ~/.zcode/v2/config.json 的 provider 注册表）*/
export interface ModelOption {
  providerId: string
  providerName: string
  /** 内置套餐类型（两个内置套餐显示名相同，靠 providerId 区分）：personal=个人、trial=体验、team=客户端选中的团队套餐、builtin=账号渠道统一标识（2026-10-23，团队/档位字样均有误导故统一） */
  plan?: 'personal' | 'trial' | 'team' | 'builtin'
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
  /** 输入类型位（modalities.input 含 video/pdf），编辑弹窗回填 */
  supportsVideo?: boolean
  supportsPdf?: boolean
  /** 模型级开关（config.enabled；缺省 true=启用，仅显式 false 停用）。
   *  停用模型：聊天下拉隐藏，管理页仍显示（弱化+可原地重开） */
  enabled?: boolean
}

/** 自定义渠道编辑弹窗的模型行草稿（context 必填：autocompact 阈值依赖 limit.context）*/
export interface ProviderModelDraft {
  modelId: string
  context: number
  output?: number
  /** 输入类型位（modalities.input 追加 image/video/pdf；文本恒选不传）*/
  images?: boolean
  video?: boolean
  pdf?: boolean
}

/** 自定义渠道保存草稿（add/update 共用；apiKey 三态见 modelUpdateProvider 注释）*/
export interface ProviderSaveDraft {
  name: string
  kind: 'anthropic' | 'openai-compatible'
  baseURL: string
  apiKey: string | null
  models: ProviderModelDraft[]
}

/** Node 进程管理条目（getNodeProcesses 响应载荷，设置页「进程」tab）*/
export interface NodeProcessInfo {
  pid: number
  kind: 'appServer' | 'descendant' | 'orphan'
  /** appServer 的进程角色：main=主进程 / enhance=润色进程 */
  role?: 'main' | 'enhance'
  /** 行内标签：appServer=项目名、descendant/orphan=可执行短名或角色名（zcode-plugin-host 等） */
  label: string
  /** 进程真身短名（appServer 行补显——label 是项目名，不补显看不出是 node，真机实测反馈） */
  process?: string
  project?: string
  /** 父进程 pid（descendant=所属 app-server；orphan=残留父 pid，可能缺省） */
  parentPid?: number
  /** 启动时刻 epoch ms（缺省=平台取不到，前端显示占位） */
  startedAt?: number
  /** 完整命令行（仅 orphan 携带，结束前归属确认用） */
  commandLine?: string
}

/** 模型管理 provider 分组（与聊天 listModels 的差异：不去重、含 disabled、保留无 baseURL 项）*/
export interface ModelManageProvider {  providerId: string
  providerName: string
  /** 内置套餐类型（两个内置套餐显示名相同，靠 providerId 区分）：personal=个人、trial=体验、team=客户端选中的团队套餐、builtin=账号渠道统一标识（2026-10-23，团队/档位字样均有误导故统一） */
  plan?: 'personal' | 'trial' | 'team' | 'builtin'
  /** 内置渠道命中方式：selected=客户端选中渠道生效；fallback=所选渠道凭证不可用回退首个可用内置 */
  via?: 'selected' | 'fallback'
  /** 兜底原因（via=fallback 时）：captchaGated=客户端所选渠道是体验套餐(zcode-plan 网关)
   *  被门控排除，徽章换"体验套餐无法使用"专属文案，区分于凭证失效 */
  viaReason?: 'captchaGated'
  /** 已配置插件自定义 apiKey 覆盖（~/.zcgui/config.json，issue #8）→ 卡片徽章 */
  customKey?: boolean
  /** 已存覆盖 key 明文（弹窗回填；本地手填值，非窃取客户端机密） */
  customKeyValue?: string
  /** 实际生效计费 key：来源/脱敏态/明文（眼睛切换） */
  activeKeySource?: 'custom' | 'config' | 'oauth'
  activeKeyMasked?: string
  activeKeyValue?: string
  /** 团队选中未配覆盖（按个人 key 计费）→ 卡片提醒 */
  teamPlanNoOverride?: boolean
  /** 个人选中配了覆盖（客户端 key 未使用）→ 卡片提醒 */
  overrideOnPersonal?: boolean
  baseURL?: string
  /** 协议形态（config.json kind：anthropic / openai-compatible…），编辑弹窗回填 */
  kind?: string
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

/**
 * session/debug 调试快照（官方开发者工具 TPS 面板数据源，服务端算好 tokensPerSecond）。
 * rounds 每模型请求一条（只收 main_turn）；app-server 进程内存快照，agent 重启清零。
 */
export interface SessionDebugRound {
  requestIndex: number
  requestId: string
  recordedAt: number
  usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    cachedWriteInputTokens?: number
  }
  hitRate: number | null
  generationDurationMs: number | null
  tokensPerSecond: number | null
}

export interface SessionDebugSummary {
  rounds: SessionDebugRound[]
  cache: {
    hitRateRequestCount: number
    totalInputTokens: number
    totalCacheReadTokens: number
    hitRate: number | null
  } | null
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
  /** 技能目录绝对路径（仅 skill 条目；$ 技能提及 chip 序列化 [$name](path) 用）*/
  path?: string
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
  /** auto 事实文件展示摘要：MEMORY.md 索引链接文本优先，frontmatter description / # 标题兜底 */
  title?: string
  /** auto 事实文件未被 MEMORY.md 索引引用（前端标「找不到引用」，排在有引用条目之后）*/
  orphaned?: boolean
}

/**
 * 自动记忆全文搜索单条命中（设置页记忆搜索框，Kotlin 端全文匹配）
 */
export interface MemorySearchHitInfo {
  path: string
  name: string
  /** 全部关键词命中总次数（排序依据）*/
  matchCount: number
  /** 首个命中处上下文片段（前后各 48 字符，换行已折叠）*/
  snippet: string
}

/**
 * 自动记忆目录定位（设置页展示 + 排查「有记忆但读取不到」）
 * 命中判定按目录名末尾 16 位哈希（前缀 CLI 可能改写，如中文目录名 → project）。
 */
export interface MemoryDirInfo {
  /** 记忆根目录（所有项目共用）*/
  projectsRoot: string
  /** 按当前项目路径推算的期望目录（前缀仅参考）*/
  expectedDir: string
  /** 实际命中的记忆目录；null/缺省 = 该路径下 CLI 未建过记忆 */
  dir?: string | null
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

// ============ 模型调用轨迹（ModelIoTrajectoryReader 契约，对齐官方 modelTrajectory.ts）============

/** 一次请求里的消息内容片段（text / reasoning / 工具调用 / 工具结果 / 其他原始结构） */
export interface TrajectoryPart {
  kind: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'image' | 'unknown'
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  mediaType?: string
  raw?: unknown
}

/** 单条对话消息（system / user / assistant / tool） */
export interface TrajectoryMessage {
  role: string
  parts?: TrajectoryPart[]
}

/** main=主会话 subagent=子智能体 compact=上下文压缩 sidecar=辅助请求 */
export interface TrajectoryCallSource {
  kind: 'main' | 'sidecar' | 'subagent' | 'compact'
  querySource?: string
}

export interface TrajectoryUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

/** 一次模型调用（一条 model_io 记录）；request.messages 是该次发送的完整上下文 */
export interface TrajectoryRecord {
  requestId: string
  attempt?: number
  startedAt: string
  completedAt?: string
  durationMs?: number
  turnId?: string
  traceId?: string
  callSource?: TrajectoryCallSource
  model?: { modelId?: string; providerId?: string; role?: string; source?: string }
  request?: { messages?: TrajectoryMessage[]; toolNames?: string[] }
  response?: {
    finishReason?: string
    text?: string
    reasoningText?: string
    toolCalls?: TrajectoryPart[]
    usage?: TrajectoryUsage
    responseId?: string
    modelId?: string
  }
  error?: { name: string; message: string; stack?: string }
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
  /** 协议代际标签："v1" = 内置渠道体系（config.json）/ "v2" = 供应商注册表体系（provider_config.json + 账号渠道）；判代失败缺省 */
  generation?: string
  error?: string
  code?: string
  arg?: string
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
  /** 用户配置的 JCEF DevToolsActivePort 文件路径（未配置/旧包缺省 = 自动检测）*/
  cdpPortFile?: string
  /** 实际生效的 CDP 端点文件（发现池首个端口可达；未探测/旧包缺省。设置页 CDP 输入框未配置时回显）*/
  cdpActiveFile?: string
  /** 实际生效的 CDP 端口号（随 cdpActiveFile 一起到达）*/
  cdpActivePort?: number
  /** browser-use 宿主健康（非阻断建议项；null = 未探测/未初始化，旧包兼容）*/
  browserHost?: EnvBrowserHostStatus
  allOk: boolean
  /** RD 后端 host（远程开发模式）：浏览器控制设置卡据此提示 browser-use 不可用（旧包兼容，缺省视为 false）*/
  rdHost?: boolean
}

/** 自动归档单条会话引用（记录详情用）*/
export interface AutoArchivedSessionRef { sessionId: string; title: string }

/** 自动归档轮次记录（仅归档数>0；mode: auto=定时轮 / manual=手动触发；workspace=实际扫描目录，缺省视为项目根）*/
export interface AutoArchiveRecord {
  ts: number
  mode: 'auto' | 'manual'
  days: number
  count: number
  workspace?: string
  sessions: AutoArchivedSessionRef[]
}

export type JavaResponse =
  /** workspacePath=请求作用域回显：前端丢弃晚到的旧目录响应（快速连切防串台）*/
  | { op: 'listSessions'; sessions: SessionInfo[]; workspacePath?: string }  | { op: 'createSession'; sessionId: string }
  /** 关联目录全量快照（get/add/remove 三 op 共用应答形；added=本次新增并应由前端切换激活）*/
  | { op: 'linkedWorkspaces'; workspaces: string[]; added?: string }
  /** getProjectPath 应答：生效项目路径（口径同 Java effectiveWorkspacePath，basePath 未就绪回退 user.dir）*/
  | { op: 'projectPath'; workspacePath: string }
  | { op: 'tabSessionCleared' }
  /** forkSession 应答：新会话由前端 openSessionNewTab 承载（与历史打开编排一致）*/
  | { op: 'sessionForked'; forkedSessionId: string; parentSessionId?: string }
  /** 老 CLI 无 v4 面（-32601）：隐藏分叉入口（不做 legacy 回退——该路径带文件恢复副作用）*/
  | { op: 'forkUnsupported' }
  /** editUserQuery 应答：v4 编辑受理（后续编排全由事件流驱动，ack 可能晚于事件到达）。
   *  newCli=v2 代（rewind.triggered 已撤出 legacy 流，前端据 ack 就地乐观截断）；
   *  disposition=blocked 时附 reason/message（服务端守卫拒绝）*/
  | { op: 'editAccepted'; sessionId: string; disposition?: string; newCli?: boolean; reason?: string; message?: string }
  /** 老 CLI 无 v4 edit 面（-32601，无 reason）：前端记忆全局不可用，空闲时回退 legacy 编排。
   *  reason=targetGone（2026-09-12 三轮反馈）：行流里找不到目标行（会话级行流缺失/
   *  乐观 id 过期）——不记忆全局不可用，仅本次降级（带图目标不得回退，legacy 丢图） */
  | { op: 'editUnsupported'; reason?: 'targetGone'; message?: string }
  /** v4 编辑被拒（守卫不过/附件解析失败等）：专用 op，不走全局 error 复位（回合可能在跑）。
   *  reason=机器可读错误码（missingParams/attachmentResolveFailed/notLatestUserMessage/
   *  commandFailed/internalError）→ 前端映射 i18n 五语言文案；message 原文仅回退兜底 */
  | { op: 'editRejected'; message?: string; reason?: string }
  /** turnFileChanges 应答：某轮改动文件清单（B2 回合产物）。reason 错误码见 turnFileOpError */
  | { op: 'turnFileChangesResult'; sessionId: string; messageId: string; data: TurnFileChangesDetail }
  | { op: 'turnFileChangesError'; reason: string; message?: string }
  /** turnFileDiff 应答：missingParams=缺 filePath/patches（正常链路不会出现，兜底降级）；
   *  path 回显请求里的相对路径（前端降级内置弹窗定位） */
  | { op: 'turnFileDiffError'; reason: string; message?: string; path?: string }
  /** turnFileDiff 受理 ack（Swing 弹窗 EDT 异步弹出，Java 侧失败只落日志不回 error） */
  | { op: 'turnFileDiffShown' }
  /** turnFileRewindPreview 应答：safe/unsafe/ignored 三桶预览 */
  | { op: 'turnFileRewindPreviewResult'; sessionId: string; messageId: string; data: TurnFileRewindPreview }
  | { op: 'turnFileRewindPreviewError'; reason: string; message?: string }
  /** turnFileRewindApply 应答：applied=服务端确认已执行（本地以随后到达的 turn.fileChanges
   *  state=reverted 事件为准做乐观更新） */
  | { op: 'turnFileRewindApplied'; sessionId: string; messageId: string }
  | { op: 'turnFileRewindApplyError'; reason: string; message?: string }
  /** turnFileChangesSync 回执（重扫异步执行，事件经流式通道后续到达） */
  | { op: 'turnFileChangesSynced'; sessionId: string }
  /** checkFilesExist 应答：按请求回显 requestId（产物预览卡渲染前批量校验）*/
  | { op: 'checkFilesExistResult'; requestId?: string; results: { path: string; exists: boolean }[] }
  /** 会话待交互计数推送（审批/提问挂起数；协议客户端反向请求计数，全量快照）。
   *  会话列表红点角标数据源——本地方案（官方 pendingInteractionSummary 在 v4
   *  sessions-index topic 订阅里，需常驻占 v4 订阅槽） */
  | { op: 'pendingInteractions'; counts: Record<string, number> }
  /** 置顶会话全量集（listPinnedSessions 应答 / setSessionPinned 写库后全标签广播，同形覆盖）*/
  | { op: 'pinnedSessions'; pinned: string[] }
  | { op: 'sessionPinsChanged'; pinned: string[] }
  /** 未读会话全量集（listUnreadSessions 应答 / 相位迁移标未读与打开清除后广播，同形覆盖）*/
  | { op: 'sessionUnreads'; unread: string[] }
  | { op: 'sessionUnreadsChanged'; unread: string[] }
  /** 后台工作投影（v4 帧合成的 SessionEvent type='backgroundWorks'，经 streamBatch 到达；
   *  payload.works 为服务端权威全量数组，全量替换语义）*/
  /** 后台 bash 输出快照应答（原样透传协议两形态；组件按 workId 匹配消费）*/
  | { op: 'backgroundBashOutputResult'; sessionId: string; workId: string; result: BackgroundBashOutputResult }
  /** 后台工作取消应答（ACK status=accepted|rejected...；投影由 backgroundWorks 事件收敛）*/
  | { op: 'backgroundWorkCancelled'; sessionId: string; workId: string; status: string; reasonCode?: string }
  /** 后台工作投影缓存应答（打开会话对账；值=本进程最后已知投影）*/
  | { op: 'backgroundWorksList'; sessionId: string; works: BackgroundWorkSummary[] }
  /** 钩子管理页统一应答：list/grant/revoke/toggle 都回最新权威 status */
  | { op: 'workspaceHooksList'; status: WorkspaceHooksStatus }
  | { op: 'sessionTurnPhase'; sessionId: string; phase: 'running' | 'ended' }
  /** 会话索引推送（sessions-index v4 订阅）：full=initial 快照全量；sessions 为官方 SessionSummary 过滤后的原样字段 */
  | { op: 'sessionIndexUpdate'; full: boolean; sessions: SessionIndexEntry[]; removed: string[] }
  /** steerMessage 应答：accepted=true 时 UI 由 turn.steerQueued/steerDrained 事件驱动；error=受理失败（清 chip + 横幅）。queueItemId=queue_<commandId>（前端已预置，ack 仅核对）*/
  | { op: 'steerMessage'; sessionId: string; accepted?: boolean; delivery?: string; queueItemId?: string; error?: string }
  /** cancelSteer 应答：removed=true 已撤销（清 chip + 队列条目回插）；false=已注入落位（queue.itemMissing），提示不可撤 */
  | { op: 'cancelSteer'; sessionId: string; queueItemId: string; removed: boolean; error?: string }
  /** promoteQueuedInput 应答（缺陷FD 兜底）：发送被服务端静默降级进队列后的促发结果。
   *  ok=true 已促发执行；ok=false 时 removed=true 条目已取消（前端回插本地队列重发）/
   *  removed=false 条目已不存在（已落位或他方促发中，前端不重发）/ 缺省=促发与删除都失败 */
  | { op: 'promoteQueuedInput'; sessionId: string; queueItemId: string; ok: boolean; removed?: boolean; error?: string }
  | { op: 'sessionDeleted'; sessionId: string }
  | { op: 'sessionArchived'; sessionId: string }
  | { op: 'sessionRestored'; sessionId: string }
  | { op: 'sessionArchiveDeleted'; sessionId: string }
  | { op: 'autoArchiveConfig'; enabled: boolean; olderThanDays: number; lastSweepAt: number }
  | { op: 'autoArchiveConfigChanged'; enabled: boolean; olderThanDays: number }
  | { op: 'autoArchiveRecords'; records: AutoArchiveRecord[] }
  | { op: 'autoArchiveRan'; count: number; skipped?: 'disabled'; lastSweepAt: number; records: AutoArchiveRecord[] }
  | { op: 'archivedSessions'; sessions: SessionInfo[]; workspacePath?: string }
  /** 会话统计增量（切目录慢修复：列表立即回，stats 后台算完推送合并）*/
  | { op: 'sessionStatsPatch'; workspacePath?: string; items: { sessionId: string; messageCount: number; sizeBytes: number }[] }
  /** copyImage 回执：Java 系统剪贴板写入结果 */
  | { op: 'imageCopied'; ok: boolean; error?: string }
  /** vizOpen 回执：url=内置 server 的 /viz/<token>（沙箱 iframe 加载）；html=singlefile 降级 srcdoc 直出 */
  | { op: 'vizOpenResult'; path: string; ok: boolean; url?: string; html?: string; error?: string }
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
  /** 当前各标签已绑定的会话快照（listOpenSessions 应答，历史列表「已在会话N打开」标注用）*/
  | { op: 'openSessions'; tabs: OpenTabInfo[] }
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
  /** app-server 进程判死并自动重启（缺陷FQ）：webview 立即失败收尾活跃回合并提示 */
  | { op: 'protocolDead' }
  | { op: 'askUserStateAck' }
  /** 服务端同族重发换新 id：保活权限弹窗的 requestId（点击命中服务端当前在等的 id）*/
  | { op: 'permissionRequestRefresh'; requestId: string }
  /** 反向请求终结确认；requestId 缺省 = 旧格式兜底全清（正常路径都带 id 精确关窗）*/
  | { op: 'askUserAck'; requestId?: string }
  /** 手机远程状态（op 响应 / 状态变化广播同构体；qrUrl 仅 waiting 态携带）*/
  | { op: 'remoteState'; state: 'off' | 'connecting' | 'waiting' | 'paired' | 'error' | 'kicked'; deviceName?: string; qrUrl?: string; error?: string }
  | { op: 'tabCreating' }
  | { op: 'externalOpened' }
  | { op: 'browserPaneToggled'; visible: boolean }
  | { op: 'tabTitleSet' }
  | { op: 'appearanceSave' }
  | { op: 'kvSave' }
  /** 权威 kv 下发（kvLoad 的响应；注入兜底通道）*/
  | { op: 'kvLoaded'; kv: Record<string, string> }
  /** 浏览器缩放百分比（zoomQuery/zoomReset 的响应；percent 由 Java getZoomLevel 换算）*/
  | { op: 'zoomLevel'; percent: number }
  /** 环境状态（checkEnv 查询 / envSave 保存成功后的重检结果 / IDE 广播同构体）*/
  | { op: 'envStatus'; status: EnvStatus }
  /** 网络代理回显（getProxyConfig 响应；restartPending=app-server 在跑需重启生效）*/
  | { op: 'proxyConfig'; httpProxy: string; noProxy: string; caCertPath: string; restartPending: boolean }
  /** 网络代理保存成功（setProxyConfig 响应，载荷同 proxyConfig）*/
  | { op: 'proxyConfigSaved'; httpProxy: string; noProxy: string; caCertPath: string; restartPending: boolean }
  /** app-server 已重启（restartAppServer 响应；下次请求懒重建带新 env）*/
  | { op: 'appServerRestarted' }
  // ============ Node 进程管理（设置页「进程」条目）============
  /** 进程条目：kind=appServer 常驻进程（role=main 主进程/enhance 润色进程，project 归属项目）、
   *  descendant 常驻进程直接子进程、orphan 疑似孤立（IDE 崩溃遗留/换代泄漏）。
   *  startedAt 缺省=平台取不到启动时刻；commandLine 仅 orphan 携带（归属确认用） */
  | { op: 'nodeProcesses'; snapshotAt: number; totals: { appServer: number; descendant: number; orphan: number }; processes: NodeProcessInfo[] }
  /** 结束进程回执（killNodeProcess 响应；ok=false 时附 error）*/
  | { op: 'nodeProcessKillResult'; pid: number; ok: boolean; error?: string }
  | { op: 'ideTheme'; isDark: boolean }
  | { op: 'files'; files: string[] }
  | { op: 'commands'; commands: SlashCommand[] }
  /** IDE 侧推送文件引用（drag=OS 拖拽/menu=右键菜单/picker=附件按钮）；
   * 前端分流：仅 picker 进顶部附件栏，drag/menu 一律内联到光标处 */
  | { op: 'filesToInput'; refs: string[]; source?: 'drag' | 'menu' | 'picker' }
  /** IDE 侧推送纯文本正文（控制台选中日志等，issue #14）：光标处插文本，非引用语义 */
  | { op: 'textToInput'; text: string }
  | {
      op: 'models'
      models: ModelOption[]
      /** 生效渠道实际计费 key 来源（custom=zcgui 覆盖 / config=客户端配置 / oauth=订阅 token） */
      billingKeySource?: 'custom' | 'config' | 'oauth'
      /** 客户端选中团队套餐但未配覆盖（实际按个人 key 计费）→ 输入框黄色提醒 */
      teamPlanNoOverride?: boolean
      /** v2 代际标记（上下文构成无数据源等代际降级的判断依据） */
      newCli?: boolean
    }
  | { op: 'modelManage'; configPath?: string; providers: ModelManageProvider[]; error?: string; newCli?: boolean
      /** 可显示「重新执行内置渠道迁移」入口（v1 config.json 有渠道 + 当前无映射表内置渠道）*/
      remigrate?: boolean }
  /** 连通性测试回包（provider/testModelConnectivity）：ok=false 时 error=服务端原始报错 */
  | { op: 'modelConnectivityResult'; ok: boolean; providerId: string; modelId: string; error?: string }
  /** 切换回包：changes 含全部实际变更（启用内置套餐时其余内置套餐联动禁用，互斥）*/
  | { op: 'modelToggled'; changes: { providerId: string; enabled: boolean }[] }
  | { op: 'modelSetProviderKey'; ok: boolean; providerId: string; cleared: boolean }
  /** 自定义渠道增/改/删回包：ok=false 时 error 在编辑弹窗内提示（不进全局错误条）*/
  | { op: 'modelProviderSaved'; ok: boolean; action: 'add' | 'update' | 'remove'; providerId: string; error?: string }
  | { op: 'modelProvidersReordered'; ok: boolean }
  /** 重迁回包：migrated = 迁入渠道显示名（空 = 旧配置无可迁移渠道）；ok=false 时 error 有文案 */
  | { op: 'modelRemigrated'; ok: boolean; migrated?: string[]; error?: string }
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
  /** session/debug 快照（networkEntries Java 侧剥掉，只透传 rounds + cache）*/
  | { op: 'sessionDebug'; sessionId: string; rounds?: SessionDebugRound[]; cache?: SessionDebugSummary['cache'] }
  /** P2 同 usageError：streaming 期轮询失败静默（会话未 active / agent 刚重启快照为空）*/
  | { op: 'sessionDebugError'; sessionId: string; message: string }
  // providerId/providerName：monitor 三路 HTTP 实际取 key 的渠道（回退链不筛身份，
  // 可能落到非 coding-plan 渠道，用量页据此提示数据口径）
  | { op: 'quota'; data?: QuotaData | null; error?: string; providerId?: string; providerName?: string; providerKeyMasked?: string }
  | { op: 'appUsage'; data?: AppUsageData | null; error?: string }
  | { op: 'modelUsage'; data?: ModelUsageData | null; error?: string; providerId?: string; providerName?: string; providerKeyMasked?: string }
  | { op: 'toolUsage'; data?: ToolUsageData | null; error?: string; providerId?: string; providerName?: string; providerKeyMasked?: string }
  | { op: 'fileOpened' }
  | { op: 'diffShown' }
  | { op: 'fileRefreshed' }
  | { op: 'memoryFiles'; files: MemoryFileInfo[]; memoryEnabled: boolean; memorySettingPath: string; memoryDir?: MemoryDirInfo | null; workspacePath?: string }
  | { op: 'memoryEnabledChanged'; enabled: boolean }
  | { op: 'cuaEnabled'; enabled: boolean }
  | { op: 'cuaEnabledChanged'; enabled: boolean }
  /** op=getCuaIcon 的响应：data 缺省=图标文件缺失（前端保持占位不重试）*/
  | { op: 'cuaIcon'; key: string; data?: string }
  | { op: 'memoryFileCreated'; path: string }
  | { op: 'revealedInFileManager' }
  /** op=searchMemoryFiles 的响应（query 回带：前端对齐丢弃乱序应答）*/
  | { op: 'memorySearchResults'; query: string; results: MemorySearchHitInfo[]; workspacePath?: string }
  /** 浏览器设置快照（op=browserConfig 的响应）*/
  | { op: 'browserConfig'; browserControlEnabled: boolean; pluginInstalled: boolean }
  /** op=clearBrowserData 的响应（sites=已清站点数据明细；httpCache/cookies 全局项）*/
  | { op: 'browserDataCleared'; ok: boolean; all: boolean; httpCache: boolean; cookies?: boolean; sites: BrowserClearedSite[] }
  /** op=browserDataOverview 的响应（概览：磁盘占用 + Cookie 计数 + 已打开站点计数）*/
  | { op: 'browserDataOverview' } & BrowserDataOverview
  | { op: 'skills'; skills: SkillInfo[]; workspacePath?: string }
  | { op: 'skillToggled'; path: string; enabled: boolean }
  /** op=enhancePrompt 的响应（error 非 nil = 失败，弹窗错误态）；seq 透传发起代际，
   *  与活动代不符（弹窗已关/已被新请求取代）时前端直接丢弃 */
  | { op: 'enhancePromptResult'; seq?: number; original?: string; text?: string; error?: string; model?: string }
  /** op=cancelEnhancePrompt 的回执（取消已受理；被取消代的结果由 seq 守卫丢弃）*/
  | { op: 'enhanceCancelResult'; seq?: number }
  /** op=regenerateSessionTitle 的响应（title 非空 = 成功并已应用；error = 失败提示）*/
  | { op: 'sessionTitleRegenerated'; sessionId: string; title?: string; error?: string }
  | { op: 'agents'; agents: AgentDef[] }
  | { op: 'agentSaved'; name: string; scope: string }
  | { op: 'agentDeleted'; name: string; scope: string }
  /** rpcError 存在 = mcp/list RPC 失败，servers 为磁盘配置降级清单 */
  | { op: 'mcpServers'; mode: string; servers: McpServerInfo[]; rpcError?: string }
  /** 单台服务器的工具清单（McpToolsClient 直连结果；失败只有 error）*/
  | { op: 'mcpServerTools'; name: string; tools?: McpToolInfo[]; toolCount?: number; error?: string }
  /** MCP 连接日志条目（McpLogReader 读 CLI jsonl，中文摘要已拼好）*/
  | { op: 'mcpLogs'; logs: McpLogEntry[] }
  /** 模型调用轨迹（ModelIoTrajectoryReader 读 model-io jsonl；error 存在 = 读取失败）*/
  | { op: 'modelTrajectoryResult'; sessionId: string; records?: TrajectoryRecord[]; sourceFiles?: string[]; truncated?: boolean; totalCount?: number; error?: string }
  /** envStatus 存在 = 环境前置检查失败（EnvCheckException），前端据此刷新环境提醒条；
   *  sourceOp 存在 = 钩子族/send 等带归属的错误，前端按域过滤（不误吞其他操作的失败）；
   *  sessionId 存在 = send 来源错误附带的目标会话（落位看门狗快路定位凭据用） */
  | { op: 'error'; message: string; envStatus?: EnvStatus; sourceOp?: string; sessionId?: string }
  /** app-server stderr 解析出的后端模型 API 错误（APICallError 兜底通道）：
   *  429 配额超限等被服务端按可重试分类退避重试，turn 终止帧迟迟不发时的第一现场 */
  | { op: 'backendError'; statusCode?: number; code?: string; message: string }
  /** 当前打开文件 ref（@path / @path#L10 / @path#L10-20 / null = 无打开编辑器）。
   *  Kotlin→webview 推送：getCurrentFile 响应 / EditorContextTracker 200ms 防抖推送。
   *  当前只驱动 CurrentFileChip 显示（topbar 当前文件 chip），不参与发送。 */
  | { op: 'currentFile'; ref: string | null }

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

// ============ 逐轮文件更改与回退（B2 回合产物，v4 fileChanges 族）============

/** 单轮文件更改摘要（turnHeader.fileChanges 订阅直出，+/−行数服务端算好）*/
export interface TurnFileChangeSummary {
  /** 回合头行 rowId（撤销/详情查询的 CAS target = turnHeader 行）*/
  rowId: number
  additions: number
  deletions: number
  files: number
  /** reverted = 该轮已被回退（服务端在 applyFileRewind 后回推）*/
  state?: 'active' | 'reverted'
  canRewind: boolean
  /** 原始锚（payload.messageId 原值：productTurnId 或 assistant 消息 id）——
   *  流式壳 id→重拉真身 id 漂移时，快照落地按它重锚定（内部字段，渲染不用）*/
  _anchor?: string
}

/** store 逐轮更改条数据（key = turnHeader entityId = 该轮 assistant 消息 id）*/
export type TurnFileChangesMap = Record<string, TurnFileChangeSummary>

/** unified diff hunk（服务端 readonlyDiffHunk 原样直出）*/
export interface TurnFileDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** unified 格式行：前缀 ' '/'+'/'-' */
  lines: string[]
}

/** 单文件改动明细（v4/conversation/fileChanges 应答 items 元素）*/
export interface TurnFileChangeItem {
  path: string
  additions: number
  deletions: number
  writeCount: number
  toolNames: string[]
  patches: TurnFileDiffHunk[]
}

/** fileChanges 查询应答 */
export interface TurnFileChangesDetail {
  files: number
  additions: number
  deletions: number
  state?: 'active' | 'reverted'
  items: TurnFileChangeItem[]
}

/** 回退预览单文件（safe 桶：action=restore 恢复 / delete 删除新建文件）*/
export interface TurnFileRewindSafeFile {
  action: 'restore' | 'delete'
  operationCount: number
  path: string
  toolNames: string[]
}

/** 回退预览 unsafe 桶（hash 预检不过：外部修改过/读不到等，不可整批撤销）*/
export interface TurnFileRewindUnsafeFile {
  reason: 'checkpoint_missing' | 'checkpoint_unreadable' | 'external_modified' | 'file_read_failed' | 'unsupported_checkpoint'
  message?: string
  currentHash?: string
  expectedHash?: string
  operationCount: number
  path: string
  toolNames: string[]
}

/** 回退预览 ignored 桶（shell 工具产生的变更不在回退范围）*/
export interface TurnFileRewindIgnoredFile {
  operationCount: number
  path: string
  toolNames: string[]
}

/** fileRewindPreview 应答（全有或全无：unsafeFiles 非空时 canApply=false）*/
export interface TurnFileRewindPreview {
  canApply: boolean
  safeFiles: TurnFileRewindSafeFile[]
  unsafeFiles: TurnFileRewindUnsafeFile[]
  ignoredFiles: TurnFileRewindIgnoredFile[]
}

// ============ 额度数据（glm plan usage API）============
// 来源：{baseDomain}/api/monitor/usage/quota/limit → data.limits[]
// type: TOKENS_LIMIT(token额度，zai 团队后端等价为 CREDIT_LIMIT) | TIME_LIMIT(次数额度)
// unit: 3=每5小时, 6=每周, 5=每月工具调用（官方 findCodingPlanQuotaLimit 口径；
//       MCP 额度是独立接口，不在 quota/limit 返回内）
// number: 窗口序号（5h 池=5、工具调用=1），部分套餐响应缺省

export interface QuotaLimit {
  type?: string
  unit?: number
  number?: number
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
