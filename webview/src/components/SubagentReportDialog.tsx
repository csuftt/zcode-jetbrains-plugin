/**
 * 子代理报告弹窗（最终报告全文阅读）
 *
 * 入口：Agent 工具卡头部按钮 / 详情弹窗头部按钮（仅状态=已完成）。
 * markdown 为打开时从 Agent 工具 part.state.output 取的快照——报告完成后
 * 不再变化，无需轮询。与详情弹窗互斥切换（2026-09-02 用户定案：过程↔结论
 * 是切换关系，从详情开报告即关详情；工具 📖 的 Markdown 预览才是叠加阅读层）。
 * 「查看完整执行过程」按钮走 openSubagentDetail（关报告开详情，同一切换语义）。
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { MarkdownBlock } from './MarkdownBlock'
import { ScrollJumpButton } from './ScrollJumpButton'
import { clockTime, formatToolDuration } from '@/utils/time'
import { transcriptModel, validSpan } from '@/utils/parseStatus'
import '../styles/subagent-detail.less'

export function SubagentReportDialog() {
  const { t } = useTranslation()
  const report = useStore((s) => s.subagentReport)
  const openSubagentDetail = useStore((s) => s.openSubagentDetail)
  const closeSubagentReport = useStore((s) => s.closeSubagentReport)
  const agents = useStore((s) => s.agents)
  const subagents = useStore((s) => s.subagents)
  const subagentDefs = useStore((s) => s.subagentDefs)
  const childMessages = useStore((s) => s.childMessages)

  // 头部 meta（与详情弹窗同款三源）：报告只在完成后可开，耗时取权威 span
  // （无 live 计时）；模型取转录末条 assistant（从主聊天工具卡直接打开时转录
  // 可能未拉过——回退子代理定义值，比空着好）
  const key = report?.callID
  const item = key ? agents.find((a) => a.callID === key) : undefined
  const info = key ? subagents.find((s) => s.toolCallId === key) : undefined
  const csid = item?.childSessionId ?? info?.childSessionId
  const span = validSpan(item?.startedAt, item?.endedAt) ?? validSpan(info?.startedAt, info?.endedAt)
  const startTime = (item?.startedAt ?? info?.startedAt) ? clockTime(item?.startedAt ?? info?.startedAt!) : ''
  const duration = span ? formatToolDuration(span.endedAt - span.startedAt) : ''
  const model = transcriptModel(csid ? childMessages[csid] : undefined)
    ?? subagentDefs?.find((d) => d.name === (item?.subagentType ?? info?.subagentType))?.model

  const bodyRef = useRef<HTMLDivElement>(null)

  // 转录缺失时静默补拉（底部栏点已完成子代理直接开报告——childMessages 尚未
  // 拉过，模型第一时间显示不出，须等详情弹窗才触发的缺陷）：已完成子会话的
  // resume 无害（运行期 resume 才杀 v4 流），silent 不闪 loading/error
  const loadChildMessages = useStore((s) => s.loadChildMessages)
  const loading = useStore((s) => s.childMessagesLoading)
  const transcript = csid ? childMessages[csid] : undefined
  useEffect(() => {
    if (!report || !csid || transcript || loading) return
    loadChildMessages(csid, true)
  }, [report, csid, transcript, loading, loadChildMessages])

  // Escape 关闭（预览与报告互斥不可能同开，无让位分支）
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
              <span className="subagent-detail-meta-item">{t('tool.subagent.finalReport')}</span>
              {startTime && <span className="subagent-detail-meta-item">{startTime}</span>}
              {model && <span className="subagent-detail-meta-item">{model}</span>}
              {duration && <span className="subagent-detail-meta-item">{duration}</span>}
            </div>
          </div>
          {/* 切换到完整执行过程弹窗（互斥：本弹窗关闭）*/}
          <button
            className="subagent-detail-icon-btn"
            data-tip={t('tool.subagent.viewFullProcess')}
            onClick={() => openSubagentDetail(report.callID)}
          >
            <span className="codicon codicon-history" />
          </button>
          <button className="subagent-detail-icon-btn" data-tip={t('tool.close')} onClick={closeSubagentReport}>
            <span className="codicon codicon-chrome-close" />
          </button>
        </div>
        <div className="subagent-detail-body subagent-report-body" ref={bodyRef}>
          <MarkdownBlock markdown={report.markdown} />
        </div>
        {/* 滚动跳转按钮（↑置顶/↓置底，对齐主界面）：长报告快速回顶/到底 */}
        <ScrollJumpButton containerRef={bodyRef} />
      </div>
    </div>
  )
}
