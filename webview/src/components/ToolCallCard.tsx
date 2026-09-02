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
import type { ToolPart } from '@/types/messages'
import { relativeTime, formatToolDuration } from '@/utils/time'
import { parsePartialToolInput, lineCount, tailLines } from '@/utils/partialToolInput'
import { extractWebSources, extractDomain } from '@/utils/webSources'
import { isBackgroundTaskOutput } from '@/utils/backgroundTask'
import { toolErrorText } from '@/utils/parseStatus'
import { sendToJava, openExternalUrl } from '@/ipc/bridge'
import { useStore } from '@/store/useStore'
import { useTick } from '@/hooks/useTick'
import { FileIcon } from './FileIcon'
import '../styles/tool-call-card.less'

interface Props {
  part: ToolPart
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
  }
  // mcp__ 前缀的工具统一用 package 图标
  if (tool.startsWith('mcp__')) return 'codicon-package'
  return map[tool] || 'codicon-tools'
}

/** 工具 → 显示名（对齐 cc-gui zh.json tools.*；文案经 i18n，未收录工具回退原名）*/
function toolDisplayName(tool: string, t: TFunction): string {
  if (tool.startsWith('mcp__')) {
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
    case 'ExitPlanMode':
      return String(input.plan || '').slice(0, 60)
    case 'TaskOutput':
    case 'TaskStop':
      return String(input.task_id || '')
    default:
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
    default: return { text: '…', cls: 'pending' }
  }
}

export function ToolCallCard({ part }: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const { tool, state } = part
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
  const summary = inputSummary(tool, state.input) ||
    (isWriteEdit && filePath ? fileName(filePath) : '') ||
    streamTitle ||
    (rawInput ? rawInput.replace(/\s+/g, ' ').slice(0, 80) : '')
  const badge = statusBadge(state.status)
  const hasOutput = !!state.output

  // 耗时
  const durMs = state.time?.start && state.time?.end
    ? state.time.end - state.time.start
    : null

  // diff 按钮只在完成态（input 已解析）有意义：流式期间内容还在生成
  const hasDiff = !!input && tool === 'Edit' && oldContent && newContent

  // 行数徽标（收起即可见）：流式期间随 delta 累计跳动，完成态定格收尾；
  // lineCount 口径与组卡（FileToolGroupCard）一致，流式→完成数字不回跳
  const lineStats = useMemo(() => {
    if (!isWriteEdit) return null
    const add = lineCount(newContent)
    const del = tool === 'Edit' ? lineCount(oldContent) : 0
    return add > 0 || del > 0 ? { add, del } : null
  }, [isWriteEdit, tool, newContent, oldContent])

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

  // Read 工具不需要展开（只有文件名 + 点击打开，不渲染 output）；
  // Skill 输入/输出全在头部 📖 弹窗，展开区仅流式原始输入/出错时有内容；
  // ExitPlanMode 同款：plan 全文走 📖 弹窗，完成后无展开区（流式中仍可看原始片段）
  const expandable = tool !== 'Read' &&
    !(tool === 'Skill' && !rawInput && !state.error) &&
    !(tool === 'ExitPlanMode' && !rawInput && !state.error)

  return (
    <div className={`tool-card tool-card--${badge.cls}`}>
      <div className="tool-card__header" onClick={() => expandable && setExpanded(!expanded)}>
        <span className="tool-card__icon"><span className={`codicon ${toolIcon(tool)}`} /></span>
        <span className="tool-card__name">{toolDisplayName(tool, t)}</span>
        {summary && (
          isFileTool ? (
            <span
              className="tool-card__summary tool-card__file-link"
              title={filePath}
              onClick={input ? handleOpenFile : undefined}
            >
              <FileIcon path={filePath} className="file-type-icon tool-card__file-ic" />
              <span className="tool-card__file-name">{summary}</span>
            </span>
          ) : (
            <span className="tool-card__summary" title={summary}>{summary}</span>
          )
        )}
        {/* 行数徽标（Write/Edit）：流式期间累计跳动（"已写入 N 行"进度），完成态定格 */}
        {lineStats && (
          <span className="file-group__stats tool-card__lines">
            {lineStats.add > 0 && <span className="file-group__add">+{lineStats.add}</span>}
            {lineStats.add > 0 && lineStats.del > 0 && <span className="file-group__stats-sep" />}
            {lineStats.del > 0 && <span className="file-group__del">−{lineStats.del}</span>}
          </span>
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
        {expandable && <span className="tool-card__toggle">{expanded ? '▼' : '▶'}</span>}
      </div>
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
            {subStatus === 'running' ? t('tool.status.running') : subStatus === 'error' ? t('tool.status.error') : subStatus === 'completed' ? t('tool.status.completed') : t('tool.status.spawned')}
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
          {/* 其他工具：JSON 输入/输出。Skill 无展开区内容（技能名在头部摘要、
              技能文档走 📖 弹窗）；Agent 类输出（最终报告）同样只走头部弹窗按钮；
              ExitPlanMode 的 plan 全文走 📖 弹窗，展开区不渲染 input JSON；
              web 双工具走上方专用分支（input 友好展示 + 来源列表/短预览）*/}
          {tool !== 'Bash' && tool !== 'Write' && tool !== 'Edit' && tool !== 'Skill' && tool !== 'ExitPlanMode' && !isWebTool && (
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
          {state.error && tool !== 'Bash' && (
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
