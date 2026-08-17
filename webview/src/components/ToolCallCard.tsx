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

import { useState } from 'react'
import type { ToolPart } from '@/types/messages'
import { relativeTime, formatToolDuration } from '@/utils/time'
import { sendToJava } from '@/ipc/bridge'
import { useStore } from '@/store/useStore'
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

/** 工具 → 中文名（对齐 cc-gui zh.json tools.*）*/
function toolDisplayName(tool: string): string {
  const map: Record<string, string> = {
    Read: '读取文件',
    Edit: '编辑文件',
    Write: '写入文件',
    Bash: '运行命令',
    Agent: '子代理',
    Task: '任务',
    Grep: '搜索',
    Glob: '文件匹配',
    WebFetch: '网页获取',
    WebSearch: '网页搜索',
    TodoWrite: '任务列表',
    Skill: '技能',
    AskUserQuestion: '询问用户',
    EnterPlanMode: '进入规划',
    ExitPlanMode: '退出规划',
    TaskStop: '停止任务',
    TaskOutput: '查看输出',
  }
  if (tool.startsWith('mcp__')) {
    // mcp__server__tool → MCP·server__tool
    return `MCP·${tool.slice(4)}`
  }
  return map[tool] || tool
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
  const [expanded, setExpanded] = useState(false)
  const { tool, state } = part
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
    return String(info?.status ?? item?.status ?? act?.status ?? '')
  })
  // 流式期间的原始工具输入（tool_input_delta 累积的 JSON 片段，未完整无法解析）：
  // 回合中即可看到"在运行什么命令/读写什么文件"，回合结束全量刷新后被解析的 input 取代
  const rawInput = !state.input && state.inputRaw ? state.inputRaw : ''
  const summary = inputSummary(tool, state.input) ||
    (rawInput ? rawInput.replace(/\s+/g, ' ').slice(0, 80) : '')
  const badge = statusBadge(state.status)
  const hasOutput = !!state.output

  // 耗时
  const durMs = state.time?.start && state.time?.end
    ? state.time.end - state.time.start
    : null

  // Edit/Write 文件操作（cc-gui EditToolBlock：文件名点击打开 / diff / 刷新）
  const input = state.input as Record<string, unknown> | undefined
  const filePath = input ? String(input.file_path || input.path || '') : ''
  const isFileTool = (tool === 'Edit' || tool === 'Write' || tool === 'Read') && filePath
  const oldContent = input ? String(input.old_string ?? input.oldString ?? '') : ''
  const newContent = input ? String(input.new_string ?? input.newString ?? input.content ?? '') : ''
  const hasDiff = tool === 'Edit' && oldContent && newContent

  const handleOpenFile = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (filePath) sendToJava({ op: 'openFile', filePath })
  }
  const handleShowDiff = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (filePath) {
      const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath
      sendToJava({ op: 'showDiff', filePath, oldContent, newContent, title: `编辑文件：${fileName}` })
    }
  }
  const handleRefreshFile = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (filePath) sendToJava({ op: 'refreshFile', filePath })
  }

  // Read 工具不需要展开（只有文件名 + 点击打开，不渲染 output）；
  // Skill 输入/输出全在头部 📖 弹窗，展开区仅流式原始输入/出错时有内容
  const expandable = tool !== 'Read' && !(tool === 'Skill' && !rawInput && !state.error)

  return (
    <div className={`tool-card tool-card--${badge.cls}`}>
      <div className="tool-card__header" onClick={() => expandable && setExpanded(!expanded)}>
        <span className="tool-card__icon"><span className={`codicon ${toolIcon(tool)}`} /></span>
        <span className="tool-card__name">{toolDisplayName(tool)}</span>
        {summary && (
          isFileTool ? (
            <span
              className="tool-card__summary tool-card__file-link"
              title={filePath}
              onClick={handleOpenFile}
            >
              <FileIcon path={filePath} className="file-type-icon tool-card__file-ic" />
              <span className="tool-card__file-name">{summary}</span>
            </span>
          ) : (
            <span className="tool-card__summary" title={summary}>{summary}</span>
          )
        )}
        {/* Edit/Write 的 diff + 刷新按钮（cc-gui EditToolBlock）*/}
        {hasDiff && (
          <button className="tool-card__action" onClick={handleShowDiff} title="查看 Diff" aria-label="diff">
            <span className="codicon codicon-diff" />
          </button>
        )}
        {isFileTool && (
          <button className="tool-card__action" onClick={handleRefreshFile} title="在编辑器中刷新" aria-label="刷新">
            <span className="codicon codicon-refresh" />
          </button>
        )}
        {/* 子代理最终报告弹窗阅读（报告不在展开区渲染，这是唯一查看入口）*/}
        {isAgentTool && hasOutput && (
          <button
            className="tool-card__action"
            title="弹窗查看子代理报告"
            aria-label="查看报告"
            onClick={(e) => {
              e.stopPropagation()
              openSubagentReport({
                callID: part.callID,
                title: summary || '子代理报告',
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
            title="弹窗查看技能内容"
            aria-label="查看技能内容"
            onClick={(e) => {
              e.stopPropagation()
              openMarkdownPreview({
                title: `/${summary || 'skill'}`,
                meta: '技能文档',
                markdown: state.output!,
              })
            }}
          >
            <span className="codicon codicon-book" />
          </button>
        )}
        <span className={`tool-card__badge tool-card__badge--${badge.cls}`}>{badge.text}</span>
        {durMs != null && <span className="tool-card__dur">{formatToolDuration(durMs)}</span>}
        {expandable && <span className="tool-card__toggle">{expanded ? '▼' : '▶'}</span>}
      </div>
      {/* 子代理摘要行（Agent/Task）：实时工具数 + 状态，点击查看原始过程 */}
      {isAgentTool && subStatus && (
        <div
          className="tool-card__subagent-line"
          title="查看子代理执行过程"
          onClick={(e) => {
            e.stopPropagation()
            openSubagentDetail(part.callID)
          }}
        >
          <span className={`codicon ${subStatus === 'running' || subStatus === 'pending'
            ? 'codicon-loading subagent-line-spin' : 'codicon-chevron-right'}`}
          />
          <span className="tool-card__subagent-status">
            {subStatus === 'running' ? '运行中' : subStatus === 'error' ? '失败' : subStatus === 'completed' ? '已完成' : '已派生'}
            {subCount > 0 && ` · ${subCount} 个工具`}
          </span>
          <span className="tool-card__subagent-view">查看过程</span>
        </div>
      )}
      {expandable && expanded && (
        <div className="tool-card__body">
          {/* 流式中的原始输入（缺陷F）：解析版 input 未到时展示累积 JSON 片段 */}
          {rawInput && (
            <div className="tool-card__section">
              <div className="tool-card__label">输入（流式）</div>
              <pre className="tool-card__code">{rawInput}</pre>
            </div>
          )}
          {/* Bash：终端风格（命令 + 输出）*/}
          {tool === 'Bash' && (
            <>
              <div className="tool-card__bash-cmd">$ {String(input?.command ?? input?.cmd ?? '')}</div>
              {hasOutput && <pre className="tool-card__code tool-card__bash-out">{state.output}</pre>}
              {state.error && (
                <pre className="tool-card__code tool-card__bash-out tool-card__bash-out--err">{state.error.message}</pre>
              )}
            </>
          )}
          {/* Write：content 代码预览 */}
          {tool === 'Write' && newContent && (
            <pre className="tool-card__code">{newContent}</pre>
          )}
          {/* Edit：old → new 对比 */}
          {tool === 'Edit' && (
            <>
              {oldContent && (
                <div className="tool-card__section">
                  <div className="tool-card__label tool-card__label--del">修改前</div>
                  <pre className="tool-card__code">{oldContent}</pre>
                </div>
              )}
              {newContent && (
                <div className="tool-card__section">
                  <div className="tool-card__label tool-card__label--add">修改后</div>
                  <pre className="tool-card__code">{newContent}</pre>
                </div>
              )}
            </>
          )}
          {/* 其他工具：JSON 输入/输出。Skill 无展开区内容（技能名在头部摘要、
              技能文档走 📖 弹窗）；Agent 类输出（最终报告）同样只走头部弹窗按钮 */}
          {tool !== 'Bash' && tool !== 'Write' && tool !== 'Edit' && tool !== 'Skill' && (
            <>
              {state.input && Object.keys(state.input).length > 0 && (
                <div className="tool-card__section">
                  <div className="tool-card__label">{isAgentTool ? '提示词' : '输入'}</div>
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
                  <div className="tool-card__label">输出</div>
                  <pre className="tool-card__code">{state.output}</pre>
                </div>
              )}
            </>
          )}
          {state.error && tool !== 'Bash' && (
            <div className="tool-card__section tool-card__section--err">
              <div className="tool-card__label">错误</div>
              <pre className="tool-card__code">{state.error.message}</pre>
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
