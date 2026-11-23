/**
 * 状态面板（对齐 cc-gui StatusPanel）
 *
 * 固定在消息列表与输入框之间的一行 tab（tab 名对齐 ZCode 客户端叫法：todos 清单=进程、
 * 后台运行汇总=任务；i18n 键名 todoTab/workTab 按数据源命名与中文文案错位，勿按键名望文生义）：
 *   📋 进程 n/m（流式中且有进行中任务时转圈）
 *   ⚙ 任务（运行中优先显示总数，空闲回落完成/总数）
 *   ✏️ 文件 +n -m
 *
 * 点击 tab 弹出详情列表（点击外部 / Escape 关闭）。任务 tab 内分两个子 tab：
 * 「后台任务」（bash/工作流投影条目：状态/取消/bash 输出查看，H7）与「代理任务」
 * （既有子代理列表：点击弹执行记录/报告；运行中条目加取消——经 childSessionId 匹配
 * backgroundWorks 投影的 workId，匹配不到不显示按钮，宁可不显示也不能停错）。
 * 两处取消均为两段式确认（首击 × 变「确认停止？」，再击才发取消，鼠标离开条目还原）。
 * 数据：todos/agents/fileChanges 从消息历史解析（utils/parseStatus.ts），后台任务
 * 是 v4 帧投影（store.backgroundWorksBySession）。
 *
 * 简化（与 cc-gui 差异）：
 * - 文件状态统一 M（ZCode 无 git 状态数据）；无 undo
 * - 文件项点击在 IDEA 编辑器打开；行尾 diff 按钮弹该文件编辑内容的前后对比
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useStore } from '@/store/useStore'
import { sendToJava } from '@/ipc/bridge'
import { getAgentToolOutput } from '@/utils/parseStatus'
import { mergeBackgroundWorks } from '@/utils/backgroundTask'
import { BackgroundTaskList } from './BackgroundTaskList'
import type { AgentItem, BackgroundWorkSummary } from '@/types/messages'
import '../styles/status-panel.less'

type TabType = 'todo' | 'agent' | 'files'
/** 后台工作 popover 的子 tab：后台任务（bash/工作流）/ 子代理（既有列表） */
type BgSubTab = 'bg' | 'sub'

const EMPTY_WORKS: BackgroundWorkSummary[] = []

/** todo/agent 状态 → codicon 图标 */
function statusIcon(status: string): { icon: string; spin?: boolean } {
  switch (status) {
    case 'completed': return { icon: 'codicon-check' }
    case 'in_progress':
    case 'running': return { icon: 'codicon-loading', spin: true }
    case 'error': return { icon: 'codicon-error' }
    // 孤儿运行中断态（强杀/中断后历史落地纠偏）：非错误非完成，禁止圈示意
    case 'interrupted': return { icon: 'codicon-circle-slash' }
    default: return { icon: 'codicon-circle-outline' }
  }
}

export function StatusPanel() {
  const { t } = useTranslation()
  const todos = useStore((s) => s.todos)
  const agents = useStore((s) => s.agents)
  const fileChanges = useStore((s) => s.fileChanges)
  const streaming = useStore((s) => s.streaming)
  const currentSessionId = useStore((s) => s.currentSessionId)
  const bgWorks = useStore((s) => (currentSessionId ? s.backgroundWorksBySession[currentSessionId] : undefined))
  const fromTranscript = useStore((s) => s.backgroundWorksFromTranscript)
  const deliveredWorkStatuses = useStore((s) => s.deliveredWorkStatuses)
  const cancelBackgroundWork = useStore((s) => s.cancelBackgroundWork)
  const openSubagentDetail = useStore((s) => s.openSubagentDetail)
  const openSubagentReport = useStore((s) => s.openSubagentReport)
  const messages = useStore((s) => s.messages)
  const statusPanelCollapsed = useStore((s) => s.statusPanelCollapsed)
  const [openTab, setOpenTab] = useState<TabType | null>(null)
  const [bgSubTab, setBgSubTab] = useState<BgSubTab>('sub')
  // 子代理取消两段式确认（防误点：× 与展开箭头相邻且停止不可逆）：首击只进确认态
  // （× 变「确认停止？」红色文字按钮），再击才发取消；鼠标离开条目/popover 收起即还原
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // popover 用 fixed 定位（脱离父级 overflow:hidden 裁剪），位置由 tab 行的 rect 计算
  const [popoverPos, setPopoverPos] = useState<{ left: number; bottom: number } | null>(null)

  // 统计
  const todoCompleted = todos.filter((t) => t.status === 'completed').length
  const hasInProgressTodo = todos.some((t) => t.status === 'in_progress')
  const agentCompleted = agents.filter((a) => a.status === 'completed').length
  const totalAdd = fileChanges.reduce((n, f) => n + f.additions, 0)
  const totalDel = fileChanges.reduce((n, f) => n + f.deletions, 0)
  // 后台工作 tab 计数（后台任务与子代理两类合并，用户反馈：后台任务须纳入总数）：
  // 数据源 = 投影 ∪ 转录重建合并（重启后投影消失，重建条目让栏不空；投影优先去重）。
  // - 未完成 > 0：chip 显示未完成总数（后台 running+resultPending + 子代理
  //   running/pending），与两个子 tab 徽标同口径——旧「running 优先」口径在实时流
  //   场景与面板对不上（真机三连反馈：待投递条目面板算未完成、chip 被漏掉）
  // - 空闲：显示 完成/总数（完成 = 后台任务终态 ended/failed/cancelled + 子代理
  //   completed；resultPending 归未完成侧——真机实勘回归：重启后转录重建条目全是
  //   ended，分子只数 resultPending 会把整栏算成 0/N 未完成）
  const bgWorksAll = useMemo(
    () => mergeBackgroundWorks(bgWorks ?? EMPTY_WORKS, fromTranscript, deliveredWorkStatuses),
    [bgWorks, fromTranscript, deliveredWorkStatuses],
  )
  const bgTasks = bgWorksAll.filter((w: BackgroundWorkSummary) => w.kind !== 'subagent')
  // 后台任务子 tab 徽标 = 未完成数（running + resultPending；真机反馈：全量计数被
  // 转录重建的历史条目撑大——历史条目只进列表不进计数）
  const bgUnfinished = bgTasks.filter(
    (w: BackgroundWorkSummary) => w.status === 'running' || w.status === 'resultPending',
  ).length
  const agentsUnfinished = agents.filter((a) => a.status === 'running' || a.status === 'pending').length
  const unfinishedWorkTotal = bgUnfinished + agentsUnfinished
  const workDone =
    bgTasks.filter(
      (w: BackgroundWorkSummary) => w.status === 'ended' || w.status === 'failed' || w.status === 'cancelled',
    ).length + agentCompleted
  const workTotal = bgTasks.length + agents.length

  // 列表点击的默认页分流：已完成 → 最终报告弹窗（报告 md 缺失时回退执行记录），
  // 其余状态 → 执行记录弹窗。两弹窗头部按钮互斥切换的逻辑不变。
  // 本面板浮层不收起：浮层 portal 在 body 末尾，与 modal 遮罩同为 z-index 1000 时
  // DOM 序靠后者在上（浮层盖在弹窗上）——用户实测拍板保留，看完一个接着点下一个
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

  // 子代理取消：经 childSessionId 精确匹配投影里的 running work 取 workId
  // （AgentItem.callID 是工具调用 id 非 agentId，不能直接当取消键）；匹配不到
  // （cold/热投影交接窗口或重复身份）不显示取消按钮——宁可不显示也不能停错（官方同款保守）
  const runningWorkByChild = new Map(
    (bgWorks ?? [])
      .filter((w: BackgroundWorkSummary) => w.kind === 'subagent' && w.status === 'running')
      .map((w: BackgroundWorkSummary) => [w.childSessionId, w]),
  )
  const cancelableAgentWork = (a: AgentItem): BackgroundWorkSummary | null => {
    if (a.status !== 'running' || !a.childSessionId) return null
    const w = runningWorkByChild.get(a.childSessionId)
    return w && w.cancellable !== false ? w : null
  }

  // popover 收起/切 tab 时还原未完成的取消确认
  useEffect(() => {
    setConfirmCancelId(null)
  }, [openTab])

  // 点击外部 / Escape 关闭 popover
  useEffect(() => {
    if (!openTab) return
    const handleClickOutside = (e: MouseEvent) => {
      // 大弹窗（modal 遮罩系）内部点击不算"外部"：浮层保留，关掉弹窗还能接着点下一个
      if ((e.target as Element)?.closest?.('.modal-overlay')) return
      // panelRef 包含 tab 行；popover 渲染在 body 下，单独判断
      const popover = document.getElementById('status-panel-popover-fixed')
      if (panelRef.current && !panelRef.current.contains(e.target as Node)
        && popover && !popover.contains(e.target as Node)) {
        setOpenTab(null)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      // 大弹窗打开时 Esc 先归大弹窗，浮层保留
      if (document.querySelector('.modal-overlay')) return
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
    // 打开新 tab 时，计算 popover 位置（贴在 tab 行正上方：任务/子代理统一靠面板左缘，
    // 文件靠面板右缘；窄视口下 8px 收敛防出屏）
    // 注：位置计算放在 updater 外（updater 内写 state 属副作用，React 18 下 updater 可能被重放）
    const rect = panelRef.current?.getBoundingClientRect()
    if (rect) {
      const popoverWidth = 360 // 与 .status-panel-popover 的 width 保持一致
      const margin = 8
      const maxLeft = Math.max(margin, window.innerWidth - popoverWidth - margin)
      const left = tab === 'files' ? rect.right - popoverWidth : rect.left
      setPopoverPos({ left: Math.min(Math.max(left, margin), maxLeft), bottom: window.innerHeight - rect.top + 4 })
    }
    setOpenTab(tab)
  }

  // 折叠开关（输入框工具条右侧按钮控制，cc-gui 同款交互）：收起时整块不渲染
  if (statusPanelCollapsed) return null

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

        {/* 后台工作 tab（原「子代理」扩展：bash/工作流投影 + 子代理，子 tab 切换） */}
        <div
          className={`status-panel-tab ${openTab === 'agent' ? 'active' : ''}`}
          onClick={() => toggleTab('agent')}
        >
          <span className="codicon codicon-server-process" />
          <span className="tab-label">{t('app.status.workTab')}</span>
          {unfinishedWorkTotal > 0 ? (
            <>
              <span className="tab-progress">{unfinishedWorkTotal}</span>
              <span className="codicon codicon-loading status-panel-tab-loading" />
            </>
          ) : workTotal > 0 && (
            <span className="tab-progress">{workDone}/{workTotal}</span>
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
            <>
              {/* 子 tab 切换：后台任务（bash/工作流投影）/ 子代理（既有列表），带各自计数 */}
              <div className="status-panel-subtabs">
                <button
                  type="button"
                  className={`status-panel-subtab ${bgSubTab === 'bg' ? 'active' : ''}`}
                  onClick={() => setBgSubTab('bg')}
                >
                  {t('app.status.bgTab')}
                  {bgUnfinished > 0 && <span className="status-panel-subtab-count">{bgUnfinished}</span>}
                </button>
                <button
                  type="button"
                  className={`status-panel-subtab ${bgSubTab === 'sub' ? 'active' : ''}`}
                  onClick={() => setBgSubTab('sub')}
                >
                  {t('app.status.subTab')}
                  {agentsUnfinished > 0 && <span className="status-panel-subtab-count">{agentsUnfinished}</span>}
                </button>
              </div>

              {bgSubTab === 'bg' ? (
                <BackgroundTaskList sessionId={currentSessionId} />
              ) : agents.length === 0 ? (
                <div className="status-panel-empty">{t('app.status.noAgents')}</div>
              ) : (
                <div className="status-panel-agent-list">
                  {agents.map((a) => {
                    const { icon, spin } = statusIcon(a.status)
                    const cancelWork = cancelableAgentWork(a)
                    return (
                      <div
                        key={a.callID}
                        className={`status-panel-agent-item status-${a.status} clickable`}
                        title={t('app.status.viewSubagentDetail')}
                        onClick={() => handleAgentClick(a)}
                        onMouseLeave={() => setConfirmCancelId(null)}
                      >
                        <span className={`codicon ${icon} ${spin ? 'spin' : ''} status-panel-agent-icon`} />
                        <div className="status-panel-agent-body">
                          <span className="status-panel-agent-desc" title={a.description}>{a.description}</span>
                          {a.subagentType && <span className="status-panel-agent-type">{a.subagentType}</span>}
                          {a.summary && <span className="status-panel-agent-summary" title={a.summary}>{a.summary}</span>}
                        </div>
                        {cancelWork ? (
                          confirmCancelId === cancelWork.workId ? (
                            <button
                              type="button"
                              className="status-panel-agent-cancel-confirm"
                              onClick={(e) => {
                                e.stopPropagation() // 不触发条目点击（详情弹窗）
                                setConfirmCancelId(null)
                                cancelBackgroundWork(currentSessionId!, cancelWork.workId)
                              }}
                            >
                              {t('app.status.bgWorks.confirmCancel')}
                            </button>
                          ) : (
                            <span
                              className="codicon codicon-close status-panel-agent-cancel"
                              title={t('app.status.bgWorks.cancel')}
                              onClick={(e) => {
                                e.stopPropagation() // 不触发条目点击（详情弹窗）
                                setConfirmCancelId(cancelWork.workId) // 两段式：首击只确认，不发取消
                              }}
                            />
                          )
                        ) : null}
                        <span className="codicon codicon-chevron-right status-panel-agent-arrow" />
                      </div>
                    )
                  })}
                </div>
              )}
            </>
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
