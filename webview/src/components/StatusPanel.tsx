/**
 * 状态面板（对齐 cc-gui StatusPanel）
 *
 * 固定在消息列表与输入框之间的一行 tab：
 *   📋 任务 n/m（流式中且有进行中任务时转圈）
 *   🤖 Agent n/m
 *   ✏️ 文件 +n -m
 *
 * 点击 tab 弹出详情列表（点击外部 / Escape 关闭）。
 * 数据从消息历史解析（utils/parseStatus.ts），由 useStore 维护。
 *
 * 简化（与 cc-gui 差异）：
 * - 文件状态统一 M（ZCode 无 git 状态数据）；无 undo
 * - 文件项点击在 IDEA 编辑器打开；行尾 diff 按钮弹该文件编辑内容的前后对比
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useStore } from '@/store/useStore'
import { sendToJava } from '@/ipc/bridge'
import { getAgentToolOutput } from '@/utils/parseStatus'
import type { AgentItem } from '@/types/messages'
import '../styles/status-panel.less'

type TabType = 'todo' | 'agent' | 'files'

/** todo/agent 状态 → codicon 图标 */
function statusIcon(status: string): { icon: string; spin?: boolean } {
  switch (status) {
    case 'completed': return { icon: 'codicon-check' }
    case 'in_progress':
    case 'running': return { icon: 'codicon-loading', spin: true }
    case 'error': return { icon: 'codicon-error' }
    default: return { icon: 'codicon-circle-outline' }
  }
}

export function StatusPanel() {
  const { t } = useTranslation()
  const todos = useStore((s) => s.todos)
  const agents = useStore((s) => s.agents)
  const fileChanges = useStore((s) => s.fileChanges)
  const streaming = useStore((s) => s.streaming)
  const openSubagentDetail = useStore((s) => s.openSubagentDetail)
  const openSubagentReport = useStore((s) => s.openSubagentReport)
  const messages = useStore((s) => s.messages)
  const [openTab, setOpenTab] = useState<TabType | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // popover 用 fixed 定位（脱离父级 overflow:hidden 裁剪），位置由 tab 行的 rect 计算
  const [popoverPos, setPopoverPos] = useState<{ left: number; bottom: number } | null>(null)

  // 统计
  const todoCompleted = todos.filter((t) => t.status === 'completed').length
  const hasInProgressTodo = todos.some((t) => t.status === 'in_progress')
  const agentCompleted = agents.filter((a) => a.status === 'completed').length
  const hasRunningAgent = agents.some((a) => a.status === 'running')
  const totalAdd = fileChanges.reduce((n, f) => n + f.additions, 0)
  const totalDel = fileChanges.reduce((n, f) => n + f.deletions, 0)

  // 列表点击的默认页分流：已完成 → 最终报告弹窗（报告 md 缺失时回退执行记录），
  // 其余状态 → 执行记录弹窗。两弹窗头部按钮互斥切换的逻辑不变
  const handleAgentClick = (a: AgentItem) => {
    if (a.status === 'completed') {
      const markdown = getAgentToolOutput(messages, a.callID)
      if (markdown) {
        openSubagentReport({ callID: a.callID, title: a.description || t('tool.subagentReport'), markdown })
        return
      }
    }
    openSubagentDetail(a.callID)
  }

  // 点击外部 / Escape 关闭 popover
  useEffect(() => {
    if (!openTab) return
    const handleClickOutside = (e: MouseEvent) => {
      // panelRef 包含 tab 行；popover 渲染在 body 下，单独判断
      const popover = document.getElementById('status-panel-popover-fixed')
      if (panelRef.current && !panelRef.current.contains(e.target as Node)
        && popover && !popover.contains(e.target as Node)) {
        setOpenTab(null)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenTab(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [openTab])

  const toggleTab = (tab: TabType) => {
    if (openTab === tab) {
      setOpenTab(null)
      return
    }
    // 打开新 tab 时，计算 popover 位置（贴在 tab 行正上方）
    // 注：位置计算放在 updater 外（updater 内写 state 属副作用，React 18 下 updater 可能被重放）
    const rect = panelRef.current?.getBoundingClientRect()
    if (rect) setPopoverPos({ left: rect.left, bottom: window.innerHeight - rect.top + 4 })
    setOpenTab(tab)
  }

  return (
    <div className="status-panel" ref={panelRef}>
      <div className="status-panel-tabs">
        {/* 任务 tab */}
        <div
          className={`status-panel-tab ${openTab === 'todo' ? 'active' : ''}`}
          onClick={() => toggleTab('todo')}
        >
          <span className="codicon codicon-checklist" />
          <span className="tab-label">{t('app.status.todoTab')}</span>
          {todos.length > 0 && (
            <span className="tab-progress">{todoCompleted}/{todos.length}</span>
          )}
          {streaming && hasInProgressTodo && (
            <span className="codicon codicon-loading status-panel-tab-loading" />
          )}
        </div>

        {/* Agent tab */}
        <div
          className={`status-panel-tab ${openTab === 'agent' ? 'active' : ''}`}
          onClick={() => toggleTab('agent')}
        >
          <span className="codicon codicon-hubot" />
          <span className="tab-label">{t('app.status.agentTab')}</span>
          {agents.length > 0 && (
            <span className="tab-progress">{agentCompleted}/{agents.length}</span>
          )}
          {streaming && hasRunningAgent && (
            <span className="codicon codicon-loading status-panel-tab-loading" />
          )}
        </div>

        {/* 文件改动 tab */}
        <div
          className={`status-panel-tab ${openTab === 'files' ? 'active' : ''}`}
          onClick={() => toggleTab('files')}
        >
          <span className="codicon codicon-edit" />
          <span className="tab-label">{t('app.status.fileTab')}</span>
          {fileChanges.length > 0 && (
            <span className="tab-stats">
              {totalAdd > 0 && <span className="stat-additions">+{totalAdd}</span>}
              {totalDel > 0 && <span className="stat-deletions">-{totalDel}</span>}
            </span>
          )}
        </div>
      </div>

      {/* 详情 popover —— portal 到 body + fixed 定位，避免被父级 overflow:hidden 裁剪 */}
      {openTab && popoverPos && createPortal(
        <div
          id="status-panel-popover-fixed"
          className="status-panel-popover"
          style={{ position: 'fixed', left: popoverPos.left, bottom: popoverPos.bottom }}
        >
          {openTab === 'todo' && (
            todos.length === 0 ? (
              <div className="status-panel-empty">{t('app.status.noTodos')}</div>
            ) : (
              <div className="status-panel-todo-list">
                {todos.map((todo, i) => {
                  const { icon, spin } = statusIcon(todo.status)
                  return (
                    <div key={i} className={`status-panel-todo-item status-${todo.status}`}>
                      <span className={`codicon ${icon} ${spin ? 'spin' : ''} status-panel-todo-icon`} />
                      <span className="status-panel-todo-content">{todo.content}</span>
                    </div>
                  )
                })}
              </div>
            )
          )}

          {openTab === 'agent' && (
            agents.length === 0 ? (
              <div className="status-panel-empty">{t('app.status.noAgents')}</div>
            ) : (
              <div className="status-panel-agent-list">
                {agents.map((a) => {
                  const { icon, spin } = statusIcon(a.status)
                  return (
                    <div
                      key={a.callID}
                      className={`status-panel-agent-item status-${a.status} clickable`}
                      title={t('app.status.viewSubagentDetail')}
                      onClick={() => handleAgentClick(a)}
                    >
                      <span className={`codicon ${icon} ${spin ? 'spin' : ''} status-panel-agent-icon`} />
                      <div className="status-panel-agent-body">
                        <span className="status-panel-agent-desc" title={a.description}>{a.description}</span>
                        {a.subagentType && <span className="status-panel-agent-type">{a.subagentType}</span>}
                        {a.summary && <span className="status-panel-agent-summary" title={a.summary}>{a.summary}</span>}
                      </div>
                      <span className="codicon codicon-chevron-right status-panel-agent-arrow" />
                    </div>
                  )
                })}
              </div>
            )
          )}

          {openTab === 'files' && (
            fileChanges.length === 0 ? (
              <div className="status-panel-empty">{t('app.status.noFiles')}</div>
            ) : (
              <div className="status-panel-file-list">
                {fileChanges.map((f) => {
                  const edits = f.edits ?? []
                  const hasDiffContent = edits.some((e) => e.oldContent || e.newContent)
                  return (
                    <div
                      key={f.filePath}
                      className="status-panel-file-item clickable"
                      title={t('app.status.openInEditor', { path: f.filePath })}
                      onClick={() => sendToJava({ op: 'openFile', filePath: f.filePath })}
                    >
                      <span className="file-change-status status-modified">M</span>
                      <span className="file-change-name" title={f.filePath}>{f.fileName}</span>
                      {(f.additions > 0 || f.deletions > 0) && (
                        <span className="file-change-stats">
                          {f.additions > 0 && <span className="additions">+{f.additions}</span>}
                          {f.deletions > 0 && <span className="deletions">-{f.deletions}</span>}
                        </span>
                      )}
                      {hasDiffContent && (
                        <span
                          className="codicon codicon-diff status-panel-file-diff"
                          title={t('app.status.viewDiff')}
                          onClick={(e) => {
                            e.stopPropagation()
                            // 同文件多次编辑依次拼接（段间空行分隔，避免相邻片段被 diff 对齐混淆）
                            const oldContent = edits.map((x) => x.oldContent).join('\n\n')
                            const newContent = edits.map((x) => x.newContent).join('\n\n')
                            sendToJava({
                              op: 'showDiff',
                              filePath: f.filePath,
                              oldContent,
                              newContent,
                              title: t('app.status.diffTitle', { name: f.fileName }),
                            })
                          }}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
