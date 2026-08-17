/**
 * 子代理详情弹窗（原始过程查看）
 *
 * 入口：底部状态面板"子代理"条目点击 / 主聊天 Agent 工具卡点击。
 *
 * 数据分三层（按运行状态取最优）：
 * - 运行中：每 3s 静默轮询 childMessages 快照（subagentMessages op：resume + 读）——
 *   子会话原生事件流服务端不投递（subscribeChild 实测无效），轮询是实时性的
 *   唯一可靠来源；childLiveMessages（事件流归约）保留为优先源，服务端若某天
 *   开始投递原生事件则自动升级为真·实时；
 * - 已结束：childMessages——stopped 通知 / turn 结束自动拉取的权威全量转录；
 * - 兜底：subagentActivities 的实时工具列表（父会话转发的工具事件聚合，
 *   快照未返回时——如历史会话——至少展示工具过程）。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useStore } from '@/store/useStore'
import { MarkdownBlock } from './MarkdownBlock'
import { ToolCallCard } from './ToolCallCard'
import { BashCommandGroupCard } from './BashCommandGroupCard'
import { FileToolGroupCard } from './FileToolGroupCard'
import { groupParts, type PartRenderUnit } from '@/utils/groupParts'
import type { ZCodeMessage } from '@/types/messages'
import '../styles/subagent-detail.less'

/**
 * 分组单元 → 组卡片/单卡（弹窗内 Transcript 与回退工具列表共用，
 * 规则同主聊天 MessageBubble：连续同类工具聚组，单个走原单卡）
 */
function UnitRenderer({ unit }: { unit: PartRenderUnit }) {
  if (unit.kind === 'toolGroup') {
    return unit.group === 'bash'
      ? <BashCommandGroupCard parts={unit.parts} />
      : <FileToolGroupCard kind={unit.group} parts={unit.parts} />
  }
  if (unit.part.type === 'tool') return <ToolCallCard part={unit.part} />
  return null
}

/** 秒级耗时格式化（子代理 startedAt/endedAt 是 ms 时间戳）*/
function formatDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return ''
  const end = endedAt ?? Date.now()
  const sec = Math.max(0, Math.round((end - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return min < 60 ? `${min}m${sec % 60}s` : `${Math.floor(min / 60)}h${min % 60}m`
}

/** 状态徽标文案 */
function statusText(status: string | undefined, t: TFunction): { text: string; cls: string } {
  switch (status) {
    case 'running': return { text: t('tool.status.running'), cls: 'running' }
    case 'completed': return { text: t('tool.status.completed'), cls: 'completed' }
    case 'error': return { text: t('tool.status.error'), cls: 'error' }
    default: return { text: t('tool.status.pending'), cls: 'pending' }
  }
}

/** 子会话完整消息 → 转录（user prompt + assistant 文本/工具，复用主聊天渲染组件）。
 *  完成态：末条 assistant 消息即子代理最终报告，在过程流中折叠为入口行
 *  （全文由报告弹窗承载，避免过程末尾大段报告与独立查看入口重复）；
 *  运行中不折叠——实时文本是了解进展的唯一窗口。*/
function Transcript({
  messages,
  running,
  onOpenReport,
}: {
  messages: ZCodeMessage[]
  running: boolean
  /** 点击折叠行打开报告弹窗（入参 = 该条文本，Agent 工具输出缺失时兜底）*/
  onOpenReport: (fallbackMd: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="subagent-detail-transcript">
      {messages.map((msg, i) => {
        const reportText = msg.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('')
          .trim()
        const collapsed = !running && i === messages.length - 1
          && msg.info.role === 'assistant' && reportText.length > 0
        return (
          <div key={msg.info.id || i} className={`subagent-detail-msg role-${msg.info.role}`}>
            <div className="subagent-detail-msg-role">
              {msg.info.role === 'user' ? t('tool.subagent.roleTask') : 'AI'}
            </div>
            <div className="subagent-detail-msg-body">
              {/* 连续同类工具聚组（同主聊天规则）：子代理连读十几个文件时压缩弹窗长度 */}
              {groupParts(msg.parts).map((unit) =>
                unit.kind === 'single' && unit.part.type === 'text' && unit.part.text.trim() ? (
                  collapsed ? null : <MarkdownBlock key={unit.index} markdown={unit.part.text} />
                ) : (
                  <UnitRenderer key={unit.kind === 'toolGroup' ? `${unit.group}-${unit.startIndex}` : unit.index} unit={unit} />
                ),
              )}
              {collapsed && (
                <div className="subagent-detail-report-collapsed" onClick={() => onOpenReport(reportText)}>
                  <span className="codicon codicon-book" />
                  <span>{t('tool.subagent.finalReportCollapsed')}</span>
                  <span className="codicon codicon-chevron-right" />
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function SubagentDetailDialog() {
  const { t } = useTranslation()
  const detailKey = useStore((s) => s.subagentDetail)
  const agents = useStore((s) => s.agents)
  const activities = useStore((s) => s.subagentActivities)
  const subagents = useStore((s) => s.subagents)
  const childMessages = useStore((s) => s.childMessages)
  const childLiveMessages = useStore((s) => s.childLiveMessages)
  const loading = useStore((s) => s.childMessagesLoading)
  const error = useStore((s) => s.childMessagesError)
  const messages = useStore((s) => s.messages)
  const closeDetail = useStore((s) => s.closeSubagentDetail)
  const openSubagentReport = useStore((s) => s.openSubagentReport)
  const loadChildMessages = useStore((s) => s.loadChildMessages)
  // 手动刷新/轮询共用的按钮动画：loading 只在非静默请求往返期间为 true
  // （本地→Kotlin→CLI 链路快时闪烁几十 ms 不可感知），故每次触发保证至少转 600ms
  const [refreshSpin, setRefreshSpin] = useState(false)
  const refreshSpinTimer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(refreshSpinTimer.current), [])
  const triggerSpin = () => {
    setRefreshSpin(true)
    window.clearTimeout(refreshSpinTimer.current)
    refreshSpinTimer.current = window.setTimeout(() => setRefreshSpin(false), 600)
  }

  const key = detailKey
  const item = key ? agents.find((a) => a.callID === key) : undefined
  const activity = key ? activities.find((a) => a.key === key) : undefined
  const info = key ? subagents.find((s) => s.toolCallId === key) : undefined

  const childSessionId = item?.childSessionId ?? activity?.childSessionId ?? info?.childSessionId
  const transcript = childSessionId ? childMessages[childSessionId] : undefined
  const liveMessages = childSessionId ? childLiveMessages[childSessionId] : undefined
  const running = item?.status === 'running' || item?.status === 'pending'
  // 显示源：运行中实时流优先（手动拉的快照不覆盖实时）；结束后权威快照优先
  const display = running ? (liveMessages ?? transcript) : (transcript ?? liveMessages)

  // 自动滚底（与 ChatView 同策略）：距底 80px 内才跟随内容滚动，用户上滑即停
  const bodyRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)
  const handleScroll = () => {
    const el = bodyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    userScrolledUp.current = !nearBottom
  }
  // 内容指纹：实时工具追加/状态变化、实时流文本增长、转录加载完成、loading 切换都会变
  const activityFingerprint = activity?.tools
    .map((t) => `${t.callID}:${t.state.status}:${t.state.output?.length ?? 0}`)
    .join(',') ?? ''
  const displayFingerprint = (display ?? [])
    .map((m) => m.parts.map((p) =>
      p.type === 'text' ? `t${p.text.length}`
      : p.type === 'reasoning' ? `r${p.text.length}`
      : p.type === 'tool' ? `o${p.callID}${p.state.status}${p.state.output?.length ?? 0}`
      : p.type,
    ).join(','))
    .join('|')
  const contentFingerprint = `${activityFingerprint}#${displayFingerprint}#${loading}`
  // 打开/切换子代理详情 → 重置上滑标志并定位到底部（最新进展）
  useEffect(() => {
    userScrolledUp.current = false
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [key])
  // 内容增长时跟随滚底（用户上滑阅读历史时不打扰）
  useEffect(() => {
    const el = bodyRef.current
    if (!el || userScrolledUp.current) return
    el.scrollTop = el.scrollHeight
  }, [contentFingerprint])

  // 已结束且有 childSessionId 但未加载 → 自动拉完整过程
  useEffect(() => {
    if (!key || !childSessionId || transcript || running || loading || error) return
    loadChildMessages(childSessionId)
  }, [key, childSessionId, transcript, running, loading, error, loadChildMessages])

  // 运行中：每 3s 静默轮询子会话快照（实时兜底）。
  // 子会话原生事件流（text_delta 等）服务端实测不投递——subscribeChild 补订后
  // 事件仍不到（只推父会话转发的工具级摘要），实时流归约无源；而"resume + 读
  // 快照"路径（手动刷新按钮）实测可靠，故运行中以轮询快照为准。
  // 结束（running=false，事件流收尾时会再拉一次权威全量）或关闭弹窗即停。
  // 若某版本服务端开始投递原生事件，liveMessages 仍有数据且优先于轮询快照（见 display）
  useEffect(() => {
    if (!running || !childSessionId) return
    // 打开即拉一次（不等第一个 3s），此后每 3s 轮询；每次触发同样旋转按钮
    // （最短 600ms 心跳动画）——自动刷新对用户可见，而非只有数据悄悄变化
    const poll = () => {
      loadChildMessages(childSessionId, true)
      triggerSpin()
    }
    poll()
    const timer = setInterval(poll, 3000)
    return () => clearInterval(timer)
  }, [running, childSessionId, loadChildMessages])

  // Escape 关闭
  useEffect(() => {
    if (!key) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDetail()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [key, closeDetail])

  if (!key) return null

  const duration = formatDuration(item?.startedAt ?? info?.startedAt, item?.endedAt ?? info?.endedAt)
  const badge = statusText(item?.status, t)
  const toolCount = activity?.tools.length ?? 0

  const handleRefresh = () => {
    if (!childSessionId) return
    loadChildMessages(childSessionId)
    triggerSpin()
  }

  // 主聊天里 Agent 工具 part 的 output（最终报告，childSessionId 缺失时的兜底内容）
  let agentOutput = ''
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool' && p.callID === key && p.state.output) agentOutput = p.state.output
    }
  }
  // 报告按钮：状态=已完成才显示（running 时报告未生成、error 时无完整报告可读），
  // 状态取三源之最先非空（流式聚合 / RPC 权威 / 转发活动，见数据分三层注释）
  const finalStatus = item?.status ?? info?.status ?? activity?.status
  const reportReady = finalStatus === 'completed' && !!agentOutput

  return (
    <div className="subagent-detail-overlay" onClick={closeDetail}>
      <div className="subagent-detail-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="subagent-detail-header">
          <span className="codicon codicon-hubot subagent-detail-header__icon" />
          <div className="subagent-detail-header__main">
            <span className="subagent-detail-header__title" title={item?.description}>
              {item?.description || activity?.description || t('tool.subagent.task')}
            </span>
            <div className="subagent-detail-header__meta">
              {(item?.subagentType || activity?.agentType || info?.subagentType) && (
                <span className="subagent-detail-badge type">
                  {item?.subagentType || activity?.agentType || info?.subagentType}
                </span>
              )}
              <span className={`subagent-detail-badge ${badge.cls}`}>{badge.text}</span>
              {duration && <span className="subagent-detail-meta-item">{duration}</span>}
              {toolCount > 0 && <span className="subagent-detail-meta-item">{t('tool.toolsCount', { count: toolCount })}</span>}
            </div>
          </div>
          {childSessionId && (
            <button
              className="subagent-detail-icon-btn"
              data-tip={running ? t('tool.subagent.refreshNow') : t('tool.subagent.reloadFull')}
              onClick={handleRefresh}
            >
              <span className={`codicon codicon-refresh ${loading || refreshSpin ? 'spin' : ''}`} />
            </button>
          )}
          {/* 已完成：弹窗阅读最终报告（与过程弹窗互斥切换，报告弹窗内可切回）*/}
          {reportReady && (
            <button
              className="subagent-detail-icon-btn"
              data-tip={t('tool.subagent.viewFinalReport')}
              onClick={() => openSubagentReport({
                callID: key,
                title: item?.description || activity?.description || t('tool.subagentReport'),
                markdown: agentOutput,
              })}
            >
              <span className="codicon codicon-book" />
            </button>
          )}
          <button className="subagent-detail-icon-btn" data-tip={t('tool.close')} onClick={closeDetail}>
            <span className="codicon codicon-chrome-close" />
          </button>
        </div>

        <div className="subagent-detail-body" ref={bodyRef} onScroll={handleScroll}>
          {error && (
            <div className="subagent-detail-error">
              <span className="codicon codicon-error" />
              <span>{t('tool.subagent.loadFailed', { error })}</span>
              {childSessionId && (
                <button className="subagent-detail-retry" onClick={handleRefresh}>{t('tool.retry')}</button>
              )}
            </div>
          )}

          {/* 层1：完整对话（运行中=实时流；已结束=权威转录）*/}
          {display && display.length > 0 && (
            <Transcript
              messages={display}
              running={running}
              onOpenReport={(fallbackMd) => openSubagentReport({
                callID: key,
                title: item?.description || activity?.description || t('tool.subagentReport'),
                markdown: agentOutput || fallbackMd,
              })}
            />
          )}

          {/* 层2 回退：无对话流（事件流缺失，如历史会话）→ 父会话转发的实时工具列表 */}
          {!display && toolCount > 0 && (
            <>
              {running && (
                <div className="subagent-detail-hint">
                  <span className="codicon codicon-loading spin" /> {t('tool.subagent.runningFallback')}
                </div>
              )}
              <div className="subagent-detail-tools">
                {/* 转发的工具事件列表同样聚组（回退场景常见：Explore 连续读多文件）*/}
                {groupParts(activity!.tools).map((unit) => (
                  <UnitRenderer
                    key={unit.kind === 'toolGroup' ? `${unit.group}-${unit.startIndex}` : unit.index}
                    unit={unit}
                  />
                ))}
              </div>
            </>
          )}

          {/* 层3：无实时数据 → 兜底显示 Agent 工具的最终报告 */}
          {!display && toolCount === 0 && agentOutput && (
            <div className="subagent-detail-fallback">
              <div className="subagent-detail-hint">{t('tool.subagent.noChildSession')}</div>
              <MarkdownBlock markdown={agentOutput} />
            </div>
          )}

          {/* 层4：什么都没有 */}
          {!display && toolCount === 0 && !agentOutput && (
            <div className="subagent-detail-empty">
              {loading ? t('tool.subagent.loading') : t('tool.subagent.noData')}
              {childSessionId && !loading && (
                <button className="subagent-detail-retry" onClick={handleRefresh}>{t('tool.subagent.loadFull')}</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
