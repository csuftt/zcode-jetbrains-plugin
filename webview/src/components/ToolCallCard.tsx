/**
 * 工具调用折叠卡片
 *
 * 基于抓包真实结构（2026-08-13）：
 *   part.type = "tool"
 *   part.tool = "Read" | "Edit" | "Bash" | "Agent" | ...
 *   part.callID = "call_xxx"
 *   part.state = { status, input, output, title, time }
 *
 * 规划文档第四节：
 *   🔧 Read(src/main.ts) ✓ 2.1KB
 *   折叠卡片，默认收起，点击展开看 input/output。
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ToolPart, AskUserQuestion } from '@/types/messages'
import { relativeTime, formatToolDuration } from '@/utils/time'
import { parsePartialToolInput, tailLines } from '@/utils/partialToolInput'
import { lineDiffStats } from '@/utils/lineDiff'
import { extractWebSources, extractDomain } from '@/utils/webSources'
import { isCronTool, describeCronSchedule, parseCronToolOutput, describeAutomationTime } from '@/utils/cronTool'
import { ImagePreview } from './ImagePreview'
import { isBackgroundTaskOutput } from '@/utils/backgroundTask'
import { toolErrorText } from '@/utils/parseStatus'
import { extractAskQuestions, parseAskUserAnswers } from '@/utils/askUserAnswer'
import { sendToJava, openExternalUrl } from '@/ipc/bridge'
import { useStore } from '@/store/useStore'
import { useTick } from '@/hooks/useTick'
import { extractTodoItems, diffTodos, findPrevTodoWriteTodos } from '@/utils/todoDiff'
import { isAgentMessageTool, shortAgentId, parseAgentMessageReceipt } from '@/utils/agentMessage'
import { isCuaTool, cuaToolShortName, cuaIconKeyFromOutput, parseCuaAppList, parseCuaWindows } from '@/utils/cuaTools'
import { isKbTool, kbToolLabel, kbActionSummary, kbResultHint } from '@/utils/kbTools'
import { FileIcon } from './FileIcon'
import { CuaAppIcon } from './CuaAppIcon'
import { KbIcon } from './KbIcon'
import { KbToolBody } from './KbToolBody'
import '../styles/tool-call-card.less'

interface Props {
  part: ToolPart
  /** 会话内最近一次解析到的 CUA 应用图标 key（动作类工具自身无 app 信号时兜底）*/
  cuaIconKey?: string | null
}

/** 工具 → codicon 图标 class（对齐 cc-gui GenericToolBlock CODICON_MAP）*/
function toolIcon(tool: string): string {
  const map: Record<string, string> = {
    Read: 'codicon-eye',
    Edit: 'codicon-edit',
    Write: 'codicon-pencil',
    Bash: 'codicon-terminal',
    Agent: 'codicon-hubot',
    Task: 'codicon-tools',
    Grep: 'codicon-search',
    Glob: 'codicon-folder',
    WebFetch: 'codicon-globe',
    WebSearch: 'codicon-search',
    TodoWrite: 'codicon-checklist',
    Skill: 'codicon-wand', // 与输入框 SkillRef chip 的技能图标一致
    AskUserQuestion: 'codicon-question',
    EnterPlanMode: 'codicon-bookmark',
    ExitPlanMode: 'codicon-bookmark',
    TaskStop: 'codicon-close',
    // 定时任务家族（automation 宿主化）：与输入框日历入口/定时卡片同图标体系
    CronCreate: 'codicon-clockface',
    CronUpdate: 'codicon-clockface',
    CronList: 'codicon-clockface',
    CronDelete: 'codicon-clockface',
    // #会话引用的上下文拉取（与输入框会话 chip 同图标）
    ReadSessionContext: 'codicon-comment-discussion',
    // 代理间消息族（协调者↔子代理通信）：发信/回信
    SendMessage: 'codicon-mail',
    RespondToCoordinator: 'codicon-reply',
  }
  // mcp__ 前缀的工具统一用 package 图标（知识库工具族不用 codicon：头部直接画工具窗那本书，见 KbIcon）
  if (tool.startsWith('mcp__')) return 'codicon-package'
  return map[tool] || 'codicon-tools'
}

/** 工具 → 显示名（对齐 cc-gui zh.json tools.*；文案经 i18n，未收录工具回退原名）。
 *  工具参数流停不下来的提示条（ToolInputStallBanner）也用它，和卡上叫同一个名字 */
export function toolDisplayName(tool: string, t: TFunction): string {
  // 知识库工具族用中文友好名（MCP.zcgui-knowledge_kb_search 双前缀形态一并识别）
  if (isKbTool(tool)) return kbToolLabel(tool)
  if (tool.startsWith('mcp__')) {
    // CUA 族用短名（list_apps 比 MCP·zcgui-computer-use__list_apps 可读，与组卡一致）
    if (isCuaTool(tool)) return cuaToolShortName(tool)
    // mcp__server__tool → MCP·server__tool
    return t('tool.mcpToolName', { name: tool.slice(4) })
  }
  return t(`tool.names.${tool}`, { defaultValue: tool })
}

/**
 * 从工具 input 里提取一个简短描述（卡片标题右侧显示）
 * 优先级：description（模型生成的用途说明）> 工具特定字段 > 第一个字符串值
 */
function inputSummary(tool: string, input?: Record<string, unknown>): string {
  if (!input) return ''
  // 有 description 优先用（Bash/Agent 等工具的模型生成描述）
  if (typeof input.description === 'string' && input.description.trim()) {
    return input.description.trim().slice(0, 80)
  }
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
      // 只显示文件名（最后一段），完整路径在 title 属性里 hover 可见、点击用 filePath 跳转
      return String(input.file_path || input.path || '').replace(/\\/g, '/').split('/').pop() || ''
    case 'Bash':
      return String(input.command || input.cmd || '')
    case 'Grep':
      return String(input.pattern || '')
    case 'Glob':
      return String(input.pattern || '')
    case 'Agent':
      // description 已在上面处理，这里回退到 prompt
      return String(input.prompt || '').slice(0, 40)
    case 'WebFetch':
      return String(input.url || '')
    case 'WebSearch':
      return String(input.query || '')
    case 'Skill':
      return String(input.skill || input.args || '')
    case 'TodoWrite':
      // 摘要位置让给进度徽标（已完成/总数，渲染层计算）
      return ''
    case 'ExitPlanMode':
      return String(input.plan || '').slice(0, 60)
    case 'AskUserQuestion':
      // 摘要让位给第一个问题文本（弹窗回看入口的识别锚点）
      return String((input.questions as AskUserQuestion[] | undefined)?.[0]?.question || '').slice(0, 80)
    case 'TaskOutput':
    case 'TaskStop':
      return String(input.task_id || '')
    case 'CronCreate':
      // title 官方约定保留用户的自然语言时间短语（「每20分钟喝水提醒」），直接可读
      return String(input.title || '').slice(0, 60)
    case 'CronUpdate':
    case 'CronDelete':
      return String(input.title || input.id || '')
    case 'CronList':
      return ''
    case 'ReadSessionContext':
      // #会话引用的上下文拉取：摘要显示检索意图（handoff 策略加前缀区分「接续交接」）
      return input.strategy === 'handoff'
        ? `[handoff] ${String(input.query || '').slice(0, 60)}`
        : String(input.query || '').slice(0, 80)
    case 'SendMessage':
      // summary 是官方给 UI 的 5-10 词预览；前置收件人短 id 便于区分多个子代理
      return [
        typeof input.to === 'string' && input.to ? shortAgentId(input.to) : '',
        typeof input.summary === 'string' ? input.summary.slice(0, 60) : '',
      ].filter(Boolean).join(' · ')
    case 'RespondToCoordinator':
      return String(input.summary || '').slice(0, 80)
    default:
      // 知识库工具族：一行动作摘要（检索「x」/移动 3 条 → 目录）
      if (isKbTool(tool)) return kbActionSummary(tool, input)
      // mcp__* 工具用 title，其他用第一个字符串值
      if (tool.startsWith('mcp__') && typeof input.title === 'string') return input.title
      const first = Object.values(input).find((v) => typeof v === 'string')
      return first ? String(first).slice(0, 60) : ''
  }
}

/** 状态标记 */
function statusBadge(status: ToolPart['state']['status']): { text: string; cls: string } {
  switch (status) {
    case 'completed': return { text: '✓', cls: 'ok' }
    case 'running': return { text: '⟳', cls: 'running' }
    case 'error': return { text: '✗', cls: 'err' }
    // 孤儿运行中断态（强杀/中断后历史落地纠偏，见 markInterruptedAgentParts）
    case 'interrupted': return { text: '⊘', cls: 'err' }
    default: return { text: '…', cls: 'pending' }
  }
}

/** TodoWrite 任务状态 → codicon（进行中的转圈动画由 less 补）*/
function todoStatusIcon(status: string): string {
  switch (status) {
    case 'completed': return 'codicon-check'
    case 'in_progress': return 'codicon-loading'
    case 'pending': return 'codicon-circle-large-outline'
    default: return 'codicon-circle-small'
  }
}

/** 任务状态 → css 修饰类后缀（未知状态归 other）*/
function todoStatusKind(status: string): string {
  return status === 'completed' || status === 'in_progress' || status === 'pending' ? status : 'other'
}

/** 任务状态显示名（i18n，未收录状态回退原值——服务端可能引入新状态词）*/
function todoStatusLabel(status: string, t: TFunction): string {
  switch (status) {
    case 'completed': return t('tool.todo.statusCompleted')
    case 'in_progress': return t('tool.todo.statusInProgress')
    case 'pending': return t('tool.todo.statusPending')
    default: return status
  }
}

export function ToolCallCard({ part, cuaIconKey }: Props) {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const { tool, state } = part
  // CUA 工具结果截图（v4 行 output.display.media）：卡片内缩略图，点击全屏预览
  const cuaMedia = state.media
  const [cuaPreviewOpen, setCuaPreviewOpen] = useState(false)
  // 应用图标（仅 CUA 工具扫描，避免大输出文本的无效正则开销）：
  // 自带 app 行的 key 优先（get_app_state/list_windows/list_apps），动作类工具退
  // 调用方顺扫的会话级最近 key；非 CUA 工具恒 null（渲染 codicon 兜底）
  const isCuaToolCard = isCuaTool(tool)
  // 知识库工具族：图标用工具窗那本书（内联 SVG）；检索/浏览/目录结构的条数在头部收起即可见
  const isKbCard = isKbTool(tool)
  const kbHint = useMemo(
    () => (isKbCard ? kbResultHint(tool, state.output) : null),
    [isKbCard, tool, state.output],
  )
  const appIconKey = !isCuaToolCard
    ? null
    : cuaIconKeyFromOutput(state.output) ?? cuaIconKey ?? null
  // CUA 列表类工具（list_apps/list_windows）友好渲染：解析失败回退裸 JSON
  const cuaApps = useMemo(
    () => (isCuaToolCard && cuaToolShortName(tool) === 'list_apps' ? parseCuaAppList(state.output) : null),
    [isCuaToolCard, tool, state.output],
  )
  const cuaWins = useMemo(
    () => (isCuaToolCard && cuaToolShortName(tool) === 'list_windows' ? parseCuaWindows(state.output) : null),
    [isCuaToolCard, tool, state.output],
  )
  // 后台任务（缺陷Y 体验增强）：Bash run_in_background 的 result 解析出的任务，
  // 按 toolCallId 索引（同一回合并发多个后台任务各自独立记账）。
  // 匹配本卡片 callID → 头部打后台标识：运行中「后台运行中」+ 真实运行时间（秒级
  // 跳动）；完成通知标记 endedAt 后保留为「后台完成」+ 定格耗时（不再跳动）。
  // 不受回合结束影响（后台化确认后回合可能立即结束，任务仍在后台跑）
  const backgroundTasks = useStore((s) => s.backgroundTasks)
  const backgroundTask = part.callID ? backgroundTasks[part.callID] : undefined
  // 历史消息静态识别（持久化标识）：会话重载后账本为空，从 part 输出内容识别
  // 官方后台化确认 → 静态「后台完成」徽标（不计时——startedAt 不可考）
  const bgFromPart = isBackgroundTaskOutput(part.state.output)
  const isBackground = tool === 'Bash' && (!!backgroundTask || bgFromPart)
  const bgRunning = isBackground && !!backgroundTask && !backgroundTask.endedAt
  const bgElapsed = useTick(bgRunning, 1000)
  // Agent/Task 卡片的子代理摘要（实时聚合活动 + RPC 状态），点击查看原始过程。
  // ⚠️ selector 必须返回原始值：返回新对象会破坏 useSyncExternalStore 的
  // snapshot 引用稳定性 → Maximum update depth exceeded（React 整树卸载）
  const isAgentTool = tool === 'Agent' || tool === 'Task' || tool === 'subagent'
  const openSubagentDetail = useStore((s) => s.openSubagentDetail)
  const openSubagentReport = useStore((s) => s.openSubagentReport)
  const openMarkdownPreview = useStore((s) => s.openMarkdownPreview)
  const subCount = useStore((s) =>
    isAgentTool ? (s.subagentActivities.find((a) => a.key === part.callID)?.tools.length ?? 0) : 0)
  const subStatus = useStore((s): string => {
    if (!isAgentTool) return ''
    const info = s.subagents.find((x) => x.toolCallId === part.callID)
    const item = s.agents.find((a) => a.callID === part.callID)
    const act = s.subagentActivities.find((a) => a.key === part.callID)
    // 防降级（同 mergeAgentItems）：本地活动/合并结果已终态时，不被过期的
    // RPC running 盖回——轮询自停后 RPC 缓存可能永远停在 running
    //（2026-08-20 前台代理实测：卡片转圈到回合结束的根源）
    const local = String(item?.status ?? act?.status ?? '')
    if (local === 'completed' || local === 'error') return local
    return String(info?.status ?? local)
  })
  // 流式期间的原始工具输入（tool_input_delta 累积的 JSON 片段，未完整无法解析）：
  // 回合中即可看到"在运行什么命令/读写什么文件"，回合结束全量刷新后被解析的 input 取代
  const rawInput = !state.input && state.inputRaw ? state.inputRaw : ''
  // Write/Edit 流式增强：从部分 JSON 提取 file_path（很快完整）与 content/new_string
  // 未闭合前缀——头部显示文件名格式、行数徽标随写入累计，展开区替代裸 JSON 原文
  const isWriteEdit = tool === 'Write' || tool === 'Edit'
  const partial = useMemo(
    () => (rawInput && isWriteEdit ? parsePartialToolInput(rawInput) : null),
    [rawInput, isWriteEdit],
  )
  const partialFields = partial?.fields ?? {}
  // Edit/Write 文件操作（cc-gui EditToolBlock：文件名点击打开 / diff / 刷新）；
  // 流式期间 file_path 从部分 JSON 提取（文件尚未落盘，不绑点击/刷新）
  const input = state.input as Record<string, unknown> | undefined
  const filePath = input
    ? String(input.file_path || input.path || '')
    : String(partialFields.file_path || partialFields.path || '')
  const isFileTool = (tool === 'Edit' || tool === 'Write' || tool === 'Read') && filePath
  const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p
  const oldContent = input
    ? String(input.old_string ?? input.oldString ?? '')
    : String(
        partial?.openField === 'old_string' || partial?.openField === 'oldString'
          ? partial.openPrefix
          : partialFields.old_string ?? partialFields.oldString ?? '',
      )
  const newContent = input
    ? String(input.new_string ?? input.newString ?? input.content ?? '')
    : String(
        partial?.openField === 'new_string' || partial?.openField === 'newString' || partial?.openField === 'content'
          ? partial.openPrefix
          : partialFields.new_string ?? partialFields.newString ?? partialFields.content ?? '',
      )
  // 流式临时标题：真实序列 content 先于 file_path 生成（rollout 实测 13/13），
  // 写入期间拿不到路径——用已生成内容的首个非空行作占位标题，行数徽标表达进度
  const streamTitle = (() => {
    if (!isWriteEdit) return ''
    const source = newContent || oldContent
    if (!source) return ''
    const firstLine = source.split('\n').find((l) => l.trim()) ?? ''
    return firstLine.replace(/^\/\*\*?|^\*|^\/\/\s*/g, '').trim().slice(0, 40)
  })()
  // ReadSessionContext（#会话引用）标题反查：input.sessionId → 会话列表标题，
  // 用户认会话靠标题而非 36 位 id；查不到（已删/别的项目）时摘要退回 query。
  // selector 返回原始字符串（引用稳定，避免 useSyncExternalStore 重建循环）
  const sessCtxTitle = useStore((s) => {
    if (tool !== 'ReadSessionContext') return ''
    const sid = (state.input as Record<string, unknown> | undefined)?.sessionId
    return typeof sid === 'string' ? (s.sessions.find((x) => x.sessionId === sid)?.title ?? '') : ''
  })
  const summary = tool === 'ReadSessionContext' && sessCtxTitle
    ? `${sessCtxTitle}${inputSummary(tool, state.input) ? ` · ${inputSummary(tool, state.input)}` : ''}`
    : inputSummary(tool, state.input) ||
    (isWriteEdit && filePath ? fileName(filePath) : '') ||
    streamTitle ||
    (rawInput ? rawInput.replace(/\s+/g, ' ').slice(0, 80) : '')
  // CUA 列表类工具摘要让位给数量（{{count}} 个窗口应用），替代空/无意义摘要
  const headerSummary = (cuaApps
    ? t('tool.cua.appCount', { count: cuaApps.length, defaultValue: '{{count}} 个窗口应用' })
    : cuaWins
      ? t('tool.cua.windowCount', { count: cuaWins.length, defaultValue: '{{count}} 个窗口' })
      : null) ?? summary
  const badge = statusBadge(state.status)
  const hasOutput = !!state.output

  // 耗时
  const durMs = state.time?.start && state.time?.end
    ? state.time.end - state.time.start
    : null

  // diff 按钮只在完成态（input 已解析）有意义：流式期间内容还在生成
  const hasDiff = !!input && tool === 'Edit' && oldContent && newContent

  // 行数徽标（收起即可见）：流式期间随 delta 累计跳动，完成态定格收尾；
  // LCS 对齐口径（与组卡一致、与 diff 视图显示一致，issue #23 跟进），流式→完成数字不回跳
  const lineStats = useMemo(() => {
    if (!isWriteEdit) return null
    const { additions: add, deletions: del } = lineDiffStats(oldContent, newContent)
    return add > 0 || del > 0 ? { add, del } : null
  }, [isWriteEdit, newContent, oldContent])

  const handleOpenFile = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (filePath) sendToJava({ op: 'openFile', filePath })
  }
  const handleShowDiff = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (filePath) {
      const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath
      sendToJava({ op: 'showDiff', filePath, oldContent, newContent, title: t('tool.editFileTitle', { name: fileName }) })
    }
  }
  const handleRefreshFile = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (filePath) sendToJava({ op: 'refreshFile', filePath })
  }

  // 网页工具（WebSearch/WebFetch）：输出是数 KB markdown 长文，卡片只留轻量视图
  //（来源链接列表 / 短预览），全文走头部 📖 弹窗（对齐 Skill/ExitPlanMode 家族模式）
  const isWebTool = tool === 'WebFetch' || tool === 'WebSearch'
  const webUrl = isWebTool && typeof input?.url === 'string' ? input.url : ''
  // 定时任务家族（automation 宿主化）：input 友好展示（触发时刻/标题/提示词）替代裸 JSON；
  // output 为 JSON 文本（message 一行 / automations 列表），解析失败（第一期拒绝周期任务
  // 的错误文本/流式半截）回退原文展示
  const isCron = isCronTool(tool)
  const cronSchedule = useMemo(
    () => (isCron ? describeCronSchedule(input ?? undefined, t, i18n.language) : null),
    [isCron, input, t, i18n.language],
  )
  const cronParsed = useMemo(
    () => (isCron && hasOutput ? parseCronToolOutput(state.output) : null),
    [isCron, hasOutput, state.output],
  )
  const webSources = useMemo(
    () => (isWebTool && state.output ? extractWebSources(state.output) : []),
    [isWebTool, state.output],
  )
  // 输出短预览（无来源链接可列时的回退视图；截断指示与 StreamPreview 同款）
  const webOutPreview = useMemo(() => {
    if (!isWebTool || !state.output) return ''
    const lines = state.output.split('\n')
    return lines.length <= 3 ? state.output : `${lines.slice(0, 3).join('\n')}\n⋯`
  }, [isWebTool, state.output])
  const handleOpenWebPage = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (webUrl) openExternalUrl(webUrl)
  }
  const handleViewWebResult = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!state.output) return
    openMarkdownPreview({
      title: tool === 'WebFetch'
        ? t('tool.webFetchTitle', { domain: extractDomain(webUrl) })
        : t('tool.webSearchTitle', {
          query: (typeof input?.query === 'string' ? input.query : '').replace(/\s+/g, ' ').trim().slice(0, 40) || toolDisplayName(tool, t),
        }),
      meta: webUrl || undefined,
      markdown: state.output,
    })
  }

  // 代理间消息族（SendMessage/RespondToCoordinator）：input 友好展示（收件人/正文）
  // 替代裸 JSON；output 为回执 JSON 文本，解析出送达形态一行展示，非 JSON 回退原文
  const isMsgTool = isAgentMessageTool(tool)
  const msgReceipt = useMemo(
    () => (isMsgTool && hasOutput ? parseAgentMessageReceipt(state.output) : null),
    [isMsgTool, hasOutput, state.output],
  )

  // TodoWrite（任务列表）：与上一次调用对比做增量标注（新增/状态变更/删除）。
  // 上次快照按 callID 在主消息流里顺序回溯（跨消息，TodoWrite 不聚组、每次调用
  // 一张卡）；子代理弹窗等 parts 不在主流中的场景回溯不到 → 纯当前列表无标注。
  // ⚠️ selector 返回原始引用（messages/undefined 二选一），不得返回新对象
  const isTodoTool = tool === 'TodoWrite'
  const todoItems = useMemo(() => (isTodoTool ? extractTodoItems(part) : []), [isTodoTool, part])
  const todoMessages = useStore((s) => (isTodoTool ? s.messages : undefined))
  const todoDiff = useMemo(
    () => (isTodoTool ? diffTodos(todoMessages ? findPrevTodoWriteTodos(todoMessages, part.callID) : null, todoItems) : null),
    [isTodoTool, todoMessages, part.callID, todoItems],
  )

  // AskUserQuestion（询问用户）：问题/选项/已选答案回看——点击卡片开只读弹窗
  // （复用实时提问弹窗样式）。答案从完成态 output 解析（服务端回执，轮末整包重拉
  // 后落库；实时 batch 收尾不带 output，期间弹窗降级为仅回看问题）。
  // 提问中（流式 input 未解析）回退普通展开看原始输入。
  const isAskUserTool = tool === 'AskUserQuestion'
  const askQuestions = useMemo(() => extractAskQuestions(input), [input])
  const askParse = useMemo(
    () => (isAskUserTool && askQuestions.length ? parseAskUserAnswers(state.output, askQuestions) : null),
    [isAskUserTool, askQuestions, state.output],
  )
  const askReviewable = isAskUserTool && askQuestions.length > 0
  const askAnswerLine = askParse
    ? askQuestions.map((q) => askParse.answers[q.question]).filter(Boolean).join(' · ')
    : ''
  const openAskUserReview = useStore((s) => s.openAskUserReview)

  const handleHeaderClick = () => {
    if (askReviewable) {
      openAskUserReview({
        questions: askQuestions,
        answers: askParse?.answers ?? {},
        recognized: askParse?.recognized ?? false,
        raw: state.output ?? '',
      })
      return
    }
    if (expandable) setExpanded(!expanded)
  }

  // Read 工具不需要展开（只有文件名 + 点击打开，不渲染 output）；
  // Skill 输入/输出全在头部 📖 弹窗，展开区仅流式原始输入/出错时有内容；
  // ExitPlanMode 同款：plan 全文走 📖 弹窗，完成后无展开区（流式中仍可看原始片段）；
  // AskUserQuestion 已解析出问题时点击=开回看弹窗，不再展开 JSON（流式未解析仍可展开）
  const expandable = tool !== 'Read' &&
    !(tool === 'Skill' && !rawInput && !state.error) &&
    !(tool === 'ExitPlanMode' && !rawInput && !state.error) &&
    !askReviewable

  return (
    <div className={`tool-card tool-card--${badge.cls}`}>
      <div
        className="tool-card__header"
        onClick={handleHeaderClick}
        title={askReviewable ? t('tool.askUserReview.viewDetail') : undefined}
      >
        {/* 应用图标（CUA 工具，对齐官方客户端「行前显示目标应用图标」）：
            有 key 走懒取图，取不到/非 CUA 回落 codicon 工具图标（CUA 族用桌面图标）*/}
        <span className="tool-card__icon">
          <CuaAppIcon
            iconKey={appIconKey}
            className="tool-card__app-icon"
            fallback={
              isKbCard ? (
                <KbIcon className="tool-card__kb-icon" />
              ) : (
                <span className={`codicon ${isCuaToolCard ? 'codicon-device-desktop' : toolIcon(tool)}`} />
              )
            }
          />
        </span>
        <span className="tool-card__name">{toolDisplayName(tool, t)}</span>
        {headerSummary && (
          isFileTool ? (
            <span
              className="tool-card__summary tool-card__file-link"
              title={filePath}
              onClick={input ? handleOpenFile : undefined}
            >
              <FileIcon path={filePath} className="file-type-icon tool-card__file-ic" />
              <span className="tool-card__file-name">{headerSummary}</span>
            </span>
          ) : (
            <span className="tool-card__summary" title={headerSummary}>{headerSummary}</span>
          )
        )}
        {/* 知识库检索/浏览/目录结构的结果数量（收起即可见）；出错时标「未成功」 */}
        {kbHint && (
          <span className={`tool-card__kb-hint${kbHint.error ? ' tool-card__kb-hint--err' : ''}`}>
            {kbHint.text}
          </span>
        )}
        {/* 行数徽标（Write/Edit）：流式期间累计跳动（"已写入 N 行"进度），完成态定格 */}
        {lineStats && (
          <span className="file-group__stats tool-card__lines">
            {lineStats.add > 0 && <span className="file-group__add">+{lineStats.add}</span>}
            {lineStats.add > 0 && lineStats.del > 0 && <span className="file-group__stats-sep" />}
            {lineStats.del > 0 && <span className="file-group__del">−{lineStats.del}</span>}
          </span>
        )}
        {/* 任务列表：进度徽标（已完成/总数）+ 增量摘要（+新增 ~变更 −删除），收起即可感知 */}
        {isTodoTool && todoItems.length > 0 && (
          <>
            <span className="tool-card__todo-progress">
              {todoDiff?.completedCount ?? 0}/{todoItems.length}
            </span>
            {todoDiff && (todoDiff.addedCount > 0 || todoDiff.statusChangedCount > 0 || todoDiff.removed.length > 0) && (
              <span className="tool-card__todo-delta">
                {todoDiff.addedCount > 0 && <span className="todo-delta__add">+{todoDiff.addedCount}</span>}
                {todoDiff.statusChangedCount > 0 && <span className="todo-delta__chg">~{todoDiff.statusChangedCount}</span>}
                {todoDiff.removed.length > 0 && <span className="todo-delta__del">−{todoDiff.removed.length}</span>}
              </span>
            )}
          </>
        )}
        {/* Edit/Write 的 diff + 刷新按钮（cc-gui EditToolBlock）*/}
        {hasDiff && (
          <button className="tool-card__action" onClick={handleShowDiff} title={t('tool.viewDiff')} aria-label={t('tool.viewDiff')}>
            <span className="codicon codicon-diff" />
          </button>
        )}
        {isFileTool && input && (
          <button className="tool-card__action" onClick={handleRefreshFile} title={t('tool.refreshInEditor')} aria-label={t('tool.refreshInEditor')}>
            <span className="codicon codicon-refresh" />
          </button>
        )}
        {/* 子代理最终报告弹窗阅读（报告不在展开区渲染，这是唯一查看入口）*/}
        {isAgentTool && hasOutput && (
          <button
            className="tool-card__action"
            title={t('tool.viewSubagentReport')}
            aria-label={t('tool.viewSubagentReport')}
            onClick={(e) => {
              e.stopPropagation()
              openSubagentReport({
                callID: part.callID,
                title: summary || t('tool.subagentReport'),
                markdown: state.output!,
              })
            }}
          >
            <span className="codicon codicon-book" />
          </button>
        )}
        {/* 技能加载内容弹窗阅读（output = SKILL.md 全文，md 渲染；技能卡无展开区内容，唯一查看入口）*/}
        {tool === 'Skill' && hasOutput && (
          <button
            className="tool-card__action"
            title={t('tool.viewSkillContent')}
            aria-label={t('tool.viewSkillContent')}
            onClick={(e) => {
              e.stopPropagation()
              openMarkdownPreview({
                title: `/${summary || 'skill'}`,
                meta: t('tool.skillDoc'),
                markdown: state.output!,
              })
            }}
          >
            <span className="codicon codicon-book" />
          </button>
        )}
        {/* 计划详情弹窗阅读（ExitPlanMode 的 plan 全文 md 渲染；完成后无展开区，这是唯一查看入口）*/}
        {tool === 'ExitPlanMode' && typeof input?.plan === 'string' && input.plan.trim() && (
          <button
            className="tool-card__action"
            title={t('tool.viewPlan')}
            aria-label={t('tool.viewPlan')}
            onClick={(e) => {
              e.stopPropagation()
              openMarkdownPreview({
                title: t('tool.planTitle'),
                markdown: String(input.plan),
              })
            }}
          >
            <span className="codicon codicon-book" />
          </button>
        )}
        {/* WebFetch 打开原网页（🌐，完成态）：系统浏览器直达（openExternal 桥带 url 形态；
            运行中不显示——结果未出，跳原页的诉求不成立，方案 3.1）*/}
        {tool === 'WebFetch' && webUrl && state.status === 'completed' && (
          <button
            className="tool-card__action"
            title={t('tool.viewPage')}
            aria-label={t('tool.viewPage')}
            onClick={handleOpenWebPage}
          >
            <span className="codicon codicon-globe" />
          </button>
        )}
        {/* web 结果弹窗阅读：输出 markdown 全文走 📖 弹窗（对齐 Skill/子代理报告入口）*/}
        {isWebTool && hasOutput && (
          <button
            className="tool-card__action"
            title={t('tool.viewWebResult')}
            aria-label={t('tool.viewWebResult')}
            onClick={handleViewWebResult}
          >
            <span className="codicon codicon-book" />
          </button>
        )}
        {isBackground ? (
          backgroundTask?.endedAt ? (
            <>
              <span className="tool-card__badge tool-card__badge--bg tool-card__badge--bg-done">
                <span className="codicon codicon-check" />
                {t('tool.backgroundCompleted')}
              </span>
              <span className="tool-card__dur tool-card__dur--bg">{formatToolDuration(backgroundTask.endedAt - backgroundTask.startedAt)}</span>
            </>
          ) : bgRunning ? (
            <>
              <span className="tool-card__badge tool-card__badge--bg">
                <span className="codicon codicon-debug-alt" />
                {t('tool.backgroundRunning')}
              </span>
              <span className="tool-card__dur tool-card__dur--bg">{formatToolDuration(bgElapsed - backgroundTask!.startedAt)}</span>
            </>
          ) : (
            // 历史静态（无账本条目）：后台化确认已回 → 「后台完成」徽标，不计时
            <span className="tool-card__badge tool-card__badge--bg tool-card__badge--bg-done">
              <span className="codicon codicon-check" />
              {t('tool.backgroundCompleted')}
            </span>
          )
        ) : (
          <>
            <span className={`tool-card__badge tool-card__badge--${badge.cls}`}>{badge.text}</span>
            {durMs != null && <span className="tool-card__dur">{formatToolDuration(durMs)}</span>}
          </>
        )}
        {/* 电脑控制截图缩略图（常驻 header 右侧，收起即可见）：点击全屏预览（缩放/拖拽）。
            数据源 v4 行 output.display.media，base64 无前缀 */}
        {cuaMedia && cuaMedia.length > 0 && (
          <img
            src={`data:${cuaMedia[0].mimeType};base64,${cuaMedia[0].data}`}
            alt={t('tool.cua.screenshot', '屏幕截图')}
            className="tool-card__cua-thumb"
            title={t('tool.cua.viewFull', '点击放大查看截图')}
            onClick={(e) => {
              e.stopPropagation()
              setCuaPreviewOpen(true)
            }}
          />
        )}
        {expandable && <span className="tool-card__toggle">{expanded ? '▼' : '▶'}</span>}
      </div>
      {/* 已选答案摘要行（询问用户）：完成态且答案可解析时收起即可见，点击同开回看弹窗 */}
      {askReviewable && askAnswerLine && (
        <div
          className="tool-card__askuser-line"
          title={t('tool.askUserReview.viewDetail')}
          onClick={handleHeaderClick}
        >
          <span className="codicon codicon-check tool-card__askuser-check" />
          <span className="tool-card__askuser-label">{t('tool.askUserReview.yourAnswer')}</span>
          <span className="tool-card__askuser-answer">{askAnswerLine}</span>
        </div>
      )}
      {/* 子代理摘要行（Agent/Task）：实时工具数 + 状态，点击查看原始过程 */}
      {isAgentTool && subStatus && (
        <div
          className="tool-card__subagent-line"
          title={t('tool.viewSubagentProcess')}
          onClick={(e) => {
            e.stopPropagation()
            openSubagentDetail(part.callID)
          }}
        >
          <span className={`codicon ${subStatus === 'running' || subStatus === 'pending'
            ? 'codicon-loading subagent-line-spin' : 'codicon-chevron-right'}`}
          />
          <span className="tool-card__subagent-status">
            {subStatus === 'running' ? t('tool.status.running') : subStatus === 'interrupted' ? t('tool.status.interrupted') : subStatus === 'error' ? t('tool.status.error') : subStatus === 'completed' ? t('tool.status.completed') : t('tool.status.spawned')}
            {subCount > 0 && ` · ${t('tool.toolsCount', { count: subCount })}`}
          </span>
          <span className="tool-card__subagent-view">{t('tool.viewProcess')}</span>
        </div>
      )}
      {expandable && expanded && (
        <div className="tool-card__body">
          {/* Write 流式写入视图：spinner + 已生成行数累计 + 内容尾部预览
              （替代裸 JSON 原文"一行行变长"，大文件也不再撑爆 DOM）*/}
          {partial && tool === 'Write' && (
            <div className="tool-card__section">
              <div className="tool-card__stream-line">
                <span className="codicon codicon-loading tool-card__stream-spin" />
                <span>{t('tool.writing')}</span>
                {lineStats && lineStats.add > 0 && (
                  <span className="file-group__add">+{lineStats.add}</span>
                )}
              </div>
              {newContent && <StreamPreview text={newContent} />}
            </div>
          )}
          {/* Edit 流式视图：修改前（生成中）+ 修改后（写入中）两段 */}
          {partial && tool === 'Edit' && (
            <>
              {oldContent && (
                <div className="tool-card__section">
                  <div className="tool-card__label tool-card__label--del">{t('tool.beforeChange')}</div>
                  <StreamPreview text={oldContent} />
                </div>
              )}
              <div className="tool-card__section">
                <div className="tool-card__stream-line">
                  <span className="codicon codicon-loading tool-card__stream-spin" />
                  <span>{t('tool.editing')}</span>
                  {lineStats && lineStats.add > 0 && (
                    <span className="file-group__add">+{lineStats.add}</span>
                  )}
                </div>
                {newContent && <StreamPreview text={newContent} />}
              </div>
            </>
          )}
          {/* 流式中的原始输入（缺陷F）：Write/Edit 已有专用视图，其余工具展示累积 JSON 片段 */}
          {rawInput && !partial && (
            <div className="tool-card__section">
              <div className="tool-card__label">{t('tool.inputStreaming')}</div>
              <pre className="tool-card__code">{rawInput}</pre>
            </div>
          )}
          {/* 网页工具（WebSearch/WebFetch）：输入友好展示替代裸 JSON；
              输出来源链接列表（点击调系统浏览器）或 3 行短预览，全文走 📖 弹窗 */}
          {isWebTool && input && (
            <>
              {webUrl && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{t('tool.webUrl')}</div>
                  <div
                    className="tool-card__weburl"
                    title={webUrl}
                    onClick={handleOpenWebPage}
                  >
                    <span className="codicon codicon-globe" />
                    <span className="tool-card__weburl-text">{webUrl}</span>
                  </div>
                </div>
              )}
              {typeof input.prompt === 'string' && input.prompt.trim() && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{t('tool.webPrompt')}</div>
                  <pre className="tool-card__code tool-card__prompt">{input.prompt}</pre>
                </div>
              )}
              {typeof input.query === 'string' && input.query.trim() && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{t('tool.webQuery')}</div>
                  <pre className="tool-card__code tool-card__prompt">{input.query}</pre>
                </div>
              )}
              {hasOutput && (
                <div className="tool-card__section">
                  <div className="tool-card__label tool-card__label--with-action">
                    {t('tool.output')}
                    <button className="tool-card__full-btn" onClick={handleViewWebResult}>
                      {t('tool.viewFullResult')}
                      <span className="codicon codicon-book" />
                    </button>
                  </div>
                  {webSources.length > 0 ? (
                    <ul className="web-source-list">
                      {webSources.map((s) => (
                        <li
                          key={s.url}
                          className="web-source-item"
                          title={s.url}
                          onClick={() => openExternalUrl(s.url)}
                        >
                          <span className="codicon codicon-link web-source-item__icon" />
                          <span className="web-source-item__domain">{s.domain}</span>
                          <span className="web-source-item__title">{s.title}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <pre className="tool-card__code">{webOutPreview}</pre>
                  )}
                </div>
              )}
            </>
          )}
          {/* 定时任务家族（automation 宿主化）：触发时刻/标题/提示词友好展示替代裸 JSON；
              输出解析 message 一行 / 任务列表，非 JSON 输出回退原文 */}
          {isCron && input && (
            <>
              {cronSchedule && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{t('tool.cron.schedule')}</div>
                  <div className="tool-card__cron-schedule">
                    <span className="codicon codicon-clockface" />
                    <span className="tool-card__cron-schedule-text">{cronSchedule}</span>
                    {input.recurring === false && (
                      <span className="tool-card__cron-once">{t('tool.cron.once')}</span>
                    )}
                  </div>
                </div>
              )}
              {typeof input.title === 'string' && input.title.trim() && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{t('tool.cron.taskTitle')}</div>
                  <pre className="tool-card__code tool-card__prompt">{input.title}</pre>
                </div>
              )}
              {typeof input.prompt === 'string' && input.prompt.trim() && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{t('tool.prompt')}</div>
                  <pre className="tool-card__code tool-card__prompt">{input.prompt}</pre>
                </div>
              )}
            </>
          )}
          {isCron && hasOutput && (
            cronParsed?.automations ? (
              <div className="tool-card__section">
                <div className="tool-card__label">
                  {t('tool.cron.listTitle', { count: cronParsed.automations.length })}
                </div>
                <ul className="cron-task-list">
                  {cronParsed.automations.map((a, i) => (
                    <li key={a.automationId || `${a.title}-${i}`} className="cron-task-item" title={a.prompt}>
                      <span className="codicon codicon-clockface cron-task-item__icon" />
                      <span className="cron-task-item__title">{a.title || a.automationId}</span>
                      <span className="cron-task-item__time">{describeAutomationTime(a, t, i18n.language)}</span>
                      {a.lifecycleStatus === 'completed' && (
                        <span className="cron-task-item__tag">{t('tool.cron.completed')}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : cronParsed?.message ? (
              <div className="tool-card__section">
                <div className="tool-card__label">{t('tool.output')}</div>
                <pre className="tool-card__code tool-card__prompt">{cronParsed.message}</pre>
              </div>
            ) : (
              <div className="tool-card__section">
                <div className="tool-card__label">{t('tool.output')}</div>
                <pre className="tool-card__code">{state.output}</pre>
              </div>
            )
          )}
          {/* 代理间消息族（SendMessage/RespondToCoordinator）：收件人（仅 SendMessage 有 to）
              + 正文按原文换行展示替代裸 JSON；回执解析为送达形态一行，非 JSON 回退原文 */}
          {isMsgTool && input && (
            <>
              {typeof input.to === 'string' && input.to && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{t('tool.agentMsg.recipient')}</div>
                  <div className="tool-card__msg-recipient" title={input.to}>
                    <span className="codicon codicon-hubot" />
                    <span className="tool-card__msg-recipient-id">{shortAgentId(input.to)}</span>
                  </div>
                </div>
              )}
              {typeof input.message === 'string' && input.message.trim() && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{t('tool.agentMsg.message')}</div>
                  <pre className="tool-card__code tool-card__prompt">{input.message}</pre>
                </div>
              )}
            </>
          )}
          {isMsgTool && hasOutput && (
            <div className="tool-card__section">
              <div className="tool-card__label">{t('tool.output')}</div>
              {msgReceipt ? (
                <div
                  className={`tool-card__msg-receipt${msgReceipt.status === 'failed' ? ' tool-card__msg-receipt--err' : ''}`}
                  title={msgReceipt.id}
                >
                  <span className={`codicon ${msgReceipt.status === 'failed' ? 'codicon-error' : 'codicon-check'}`} />
                  <span className="tool-card__msg-receipt-text">
                    {msgReceipt.status === 'failed'
                      ? (msgReceipt.error || t('tool.agentMsg.failed'))
                      : t(`tool.agentMsg.delivery.${msgReceipt.delivery ?? 'sent'}`)}
                    {msgReceipt.id && (
                      <span className="tool-card__msg-receipt-id">{msgReceipt.id}</span>
                    )}
                  </span>
                </div>
              ) : (
                <pre className="tool-card__code">{state.output}</pre>
              )}
            </div>
          )}
          {/* 任务列表（TodoWrite）：全量列表 + 增量标注（新增/状态变更），已移除单列一节 */}
          {isTodoTool && input && todoDiff && todoDiff.entries.length > 0 && (
            <div className="tool-card__section tool-card__section--todo">
              <ul className="todo-list">
                {todoDiff.entries.map((e) => (
                  <li
                    key={e.content}
                    className={`todo-item todo-item--${todoStatusKind(e.status)}${e.change === 'added' ? ' todo-item--added' : e.change === 'status' ? ' todo-item--changed' : ''}`}
                    title={e.content}
                  >
                    <span className={`codicon ${todoStatusIcon(e.status)}${e.status === 'in_progress' ? ' todo-item__spin' : ''}`} />
                    <span className="todo-item__content">{e.content}</span>
                    {e.change === 'added' && (
                      <span className="todo-item__tag todo-item__tag--add">{t('tool.todo.added')}</span>
                    )}
                    {e.change === 'status' && (
                      <span className="todo-item__tag todo-item__tag--chg">
                        {todoStatusLabel(e.prevStatus ?? '', t)} → {todoStatusLabel(e.status, t)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {todoDiff.removed.length > 0 && (
                <div className="todo-removed">
                  <div className="todo-removed__label">{t('tool.todo.removed', { count: todoDiff.removed.length })}</div>
                  <ul className="todo-list todo-list--removed">
                    {todoDiff.removed.map((r) => (
                      <li key={r.content} className="todo-item todo-item--removed" title={r.content}>
                        <span className={`codicon ${todoStatusIcon(r.status)}`} />
                        <span className="todo-item__content">{r.content}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {/* Bash：终端风格（命令 + 输出）*/}
          {tool === 'Bash' && (
            <>
              <div className="tool-card__bash-cmd">$ {String(input?.command ?? input?.cmd ?? '')}</div>
              {hasOutput && <pre className="tool-card__code tool-card__bash-out">{state.output}</pre>}
              {state.error && (
                <pre className="tool-card__code tool-card__bash-out tool-card__bash-out--err">{toolErrorText(state.error)}</pre>
              )}
            </>
          )}
          {/* Write：content 代码预览（流式期间走上方专用视图，不重复渲染）*/}
          {tool === 'Write' && newContent && !partial && (
            <pre className="tool-card__code">{newContent}</pre>
          )}
          {/* Edit：old → new 对比（同上，流式期间不渲染）*/}
          {tool === 'Edit' && !partial && (
            <>
              {oldContent && (
                <div className="tool-card__section">
                  <div className="tool-card__label tool-card__label--del">{t('tool.beforeChange')}</div>
                  <pre className="tool-card__code">{oldContent}</pre>
                </div>
              )}
              {newContent && (
                <div className="tool-card__section">
                  <div className="tool-card__label tool-card__label--add">{t('tool.afterChange')}</div>
                  <pre className="tool-card__code">{newContent}</pre>
                </div>
              )}
            </>
          )}
          {/* CUA 列表类工具（list_apps/list_windows）：行式应用列表（真实图标+名称
              +pid+窗口标题+前台徽标）替代裸 JSON；解析失败不进此分支，走下方原文 */}
          {(cuaApps || cuaWins) && (
            <div className="tool-card__section">
              <div className="tool-card__label">
                {cuaApps ? t('tool.cua.appList', '窗口应用') : t('tool.cua.windowList', '应用窗口')}
              </div>
              <ul className="cua-app-list">
                {cuaApps?.map((a) => (
                  <li key={a.pid} className="cua-app-item" title={a.title}>
                    <CuaAppIcon
                      iconKey={a.icon ?? null}
                      className="cua-app-item__icon"
                      fallback={<span className="codicon codicon-device-desktop cua-app-item__fallback" />}
                    />
                    <span className="cua-app-item__name">{a.name}</span>
                    <span className="cua-app-item__pid">pid {a.pid}</span>
                    <span className="cua-app-item__title">{a.title}</span>
                    {a.active && <span className="cua-app-item__active">{t('tool.cua.foreground', '前台')}</span>}
                  </li>
                ))}
                {cuaWins?.map((w) => (
                  <li key={w.windowId} className="cua-app-item">
                    <span className="cua-app-item__fallback">#</span>
                    <span className="cua-app-item__pid">{w.windowId}</span>
                    <span className="cua-app-item__title">{w.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* 其他工具：JSON 输入/输出。Skill 无展开区内容（技能名在头部摘要、
              技能文档走 📖 弹窗）；Agent 类输出（最终报告）同样只走头部弹窗按钮；
              ExitPlanMode 的 plan 全文走 📖 弹窗，展开区不渲染 input JSON；
              web 双工具走上方专用分支（input 友好展示 + 来源列表/短预览）；
              定时任务家族走上方 cron 分支（触发时刻/标题/提示词 + message/任务列表）；
              代理间消息族走上方消息分支（收件人/正文/回执）；
              TodoWrite 走上方任务列表分支（diff 标注），仅流式未解析时落到 rawInput 原文；
              CUA 列表类已解析走上方应用列表分支，未解析（流式半截/形状变更）仍回这里；
              知识库工具族走上方 KbToolBody（参数 + 条目列表/目录树/正文/回执，解析不了回退原文） */}
          {isKbCard && <KbToolBody part={part} />}
          {tool !== 'Bash' && tool !== 'Write' && tool !== 'Edit' && tool !== 'Skill' && tool !== 'ExitPlanMode' && !isWebTool && !isCron && !isTodoTool && !isMsgTool && !cuaApps && !cuaWins && !isKbCard && (
            <>
              {state.input && Object.keys(state.input).length > 0 && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{isAgentTool ? t('tool.prompt') : t('tool.input')}</div>
                  {/* Agent 输入只展示 prompt（description/subagent_type 已在卡片头部），
                      其余字段对读者是噪音；无 prompt 的回退 JSON */}
                  {isAgentTool && typeof input?.prompt === 'string' && input.prompt.trim() ? (
                    <pre className="tool-card__code tool-card__prompt">{String(input.prompt)}</pre>
                  ) : (
                    <pre className="tool-card__code">{JSON.stringify(state.input, null, 2)}</pre>
                  )}
                </div>
              )}
              {hasOutput && !isAgentTool && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{t('tool.output')}</div>
                  <pre className="tool-card__code">{state.output}</pre>
                </div>
              )}
            </>
          )}
          {state.error && tool !== 'Bash' && !isKbCard && (
            <div className="tool-card__section tool-card__section--err">
              <div className="tool-card__label">{t('tool.error')}</div>
              <pre className="tool-card__code">{toolErrorText(state.error)}</pre>
            </div>
          )}
      {state.time?.start && (
        <div className="tool-card__time">{relativeTime(state.time.start)}</div>
      )}
        </div>
      )}
      {/* 截图全屏预览（portal，卡片根部挂载——header 缩略图收起状态也可点开） */}
      {cuaPreviewOpen && cuaMedia && cuaMedia.length > 0 && (
        <ImagePreview
          images={cuaMedia.map((m) => ({ src: `data:${m.mimeType};base64,${m.data}`, title: t('tool.cua.screenshot', '屏幕截图') }))}
          initialIndex={0}
          onClose={() => setCuaPreviewOpen(false)}
        />
      )}
    </div>
  )
}

/** 流式内容预览：只渲染尾部 15 行窗口 + 顶部截断指示（DOM 恒定，大文件流式不卡）*/
function StreamPreview({ text }: { text: string }) {
  const { text: tail, truncated } = tailLines(text)
  return (
    <>
      {truncated && <div className="tool-card__tail-clip">⋯</div>}
      <pre className="tool-card__code">{tail}</pre>
    </>
  )
}
