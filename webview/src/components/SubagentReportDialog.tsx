/**
 * 子代理报告弹窗（最终报告全文阅读）
 *
 * 入口：Agent 工具卡头部按钮 / 详情弹窗头部按钮（仅状态=已完成）。
 * markdown 为打开时从 Agent 工具 part.state.output 取的快照——报告完成后
 * 不再变化，无需轮询。与详情弹窗互斥（见 store openSubagentReport）：
 * 报告 → 过程 → 报告 可通过头部按钮来回切换，Escape 只关当前弹窗。
 */

import { useEffect } from 'react'
import { useStore } from '@/store/useStore'
import { MarkdownBlock } from './MarkdownBlock'
import '../styles/subagent-detail.less'

export function SubagentReportDialog() {
  const report = useStore((s) => s.subagentReport)
  const openSubagentDetail = useStore((s) => s.openSubagentDetail)
  const closeSubagentReport = useStore((s) => s.closeSubagentReport)

  // Escape 关闭
  useEffect(() => {
    if (!report) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSubagentReport()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [report, closeSubagentReport])

  if (!report) return null

  return (
    <div className="subagent-detail-overlay" onClick={closeSubagentReport}>
      <div className="subagent-detail-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="subagent-detail-header">
          <span className="codicon codicon-book subagent-detail-header__icon" />
          <div className="subagent-detail-header__main">
            <span className="subagent-detail-header__title" title={report.title}>
              {report.title}
            </span>
            <div className="subagent-detail-header__meta">
              <span className="subagent-detail-meta-item">子代理最终报告</span>
            </div>
          </div>
          {/* 切换到完整执行过程弹窗（互斥：本弹窗关闭）*/}
          <button
            className="subagent-detail-icon-btn"
            data-tip="查看完整执行过程"
            onClick={() => openSubagentDetail(report.callID)}
          >
            <span className="codicon codicon-history" />
          </button>
          <button className="subagent-detail-icon-btn" data-tip="关闭" onClick={closeSubagentReport}>
            <span className="codicon codicon-chrome-close" />
          </button>
        </div>
        <div className="subagent-detail-body subagent-report-body">
          <MarkdownBlock markdown={report.markdown} />
        </div>
      </div>
    </div>
  )
}
