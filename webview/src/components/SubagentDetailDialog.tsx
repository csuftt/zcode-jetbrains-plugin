/**
 * 子代理详情弹窗（原始过程查看）
 *
 * 入口：底部状态面板"子代理"条目点击 / 主聊天 Agent 工具卡点击。
 *
 * 数据分三层（按运行状态取最优）：
 * - 运行中：childLiveMessages（v4 订阅的实时事件流归约，subscribeChild 建立）——
 *   运行期绝不走 subagentMessages（resume + 读）：resume 会把子会话切到 legacy
 *   投递、v4 增量帧退化为空壳（2026-09-02 diag 实验 7/8 定案，顺序无关）；
 *   v4 不可用（订阅失败/老 CLI 降级）才启用 3s 静默轮询快照兜底；
 * - 已结束：childMessages——stopped 通知 / turn 结束自动拉取的权威全量转录；
 * - 兜底：subagentActivities 的实时工具列表（父会话转发的工具事件聚合，
 *   快照未返回时——如历史会话——至少展示工具过程）。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useStore } from '@/store/useStore'
import { MarkdownBlock } from './MarkdownBlock'
import { renderPartUnits } from './PartUnits'
import { ScrollJumpButton } from './ScrollJumpButton'
import { TimelineSeparator } from './TimelineSeparator'
import { groupParts } from '@/utils/groupParts'
import { getAgentToolOutput, getAgentToolErrorText, transcriptModel, validSpan } from '@/utils/parseStatus'
import { findTimelinePart } from '@/utils/parseNotification'
import { clockTime, formatToolDuration } from '@/utils/time'
import type { ZCodeMessage } from '@/types/messages'
import '../styles/subagent-detail.less'

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
 *  运行中不折叠——实时文本是了解进展的唯一窗口。
 *  ⚠️ 折叠只对权威转录（isLive=false）**且子代理成功完成**生效：live 是 v4 归约的
 *  单条大 assistant 消息（整轮累积），折叠它 = 正文全部隐藏只剩工具卡（2026-08-31
 *  用户实测"点击工具后内容变空"的根因）；失败时末条只是中断残段，折叠成
 *  "最终报告已生成"是误报（同日实测：报告内容不对且无失败原因）——残段原样
 *  展示，失败原因由列表末尾的失败提示条承载。*/
function Transcript({
  messages,
  running,
  isLive,
  allowReportCollapse,
  onOpenReport,
}: {
  messages: ZCodeMessage[]
  running: boolean
  /** 显示源是否实时流（live 归约，单条大消息结构）——禁用末条报告折叠 + 末条打字机光标 */
  isLive: boolean
  /** 末条报告折叠入口只对成功完成的子代理生效（finalStatus==='completed'） */
  allowReportCollapse: boolean
  /** 点击折叠行打开报告弹窗（入参 = 该条文本，Agent 工具输出缺失时兜底）*/
  onOpenReport: (fallbackMd: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="subagent-detail-transcript">
      {messages.map((msg, i) => {
        // timeline marker 消息（role=assistant + timeline part，主界面 MessageBubble
        // 同款分流）：子会话首条的 model_change 无 fromModel——创建时固有的
        // "以模型 X 开始"标记，v4 实时流不含它，legacy 快照读回才有，照渲染即
        // 头部多出的空 AI 行 → 跳过；其余（中途压缩/真实切换）渲染横线分隔卡
        const timelinePart = findTimelinePart(msg.parts)
        if (timelinePart) {
          if (timelinePart.timelineType === 'model_change' && !timelinePart.fromModel) return null
          return <TimelineSeparator key={msg.info.id || i} part={timelinePart} />
        }
        const reportText = msg.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('')
          .trim()
        const collapsed = allowReportCollapse && !running && !isLive && i === messages.length - 1
          && msg.info.role === 'assistant' && reportText.length > 0
        return (
          <div key={msg.info.id || i} className={`subagent-detail-msg role-${msg.info.role}`}>
            <div className="subagent-detail-msg-role">
              {msg.info.role === 'user' ? t('tool.subagent.roleTask') : 'AI'}
            </div>
            <div className="subagent-detail-msg-body">
              {/* 连续同类工具聚组 + reasoning/图片 全走共享渲染管线（同主聊天），
                  整批一次调用（renderPartUnits 内部按 parts 推导思考展开/末条流式）；
                  text 空文本跳过；完成态末条报告折叠为入口行（弹窗特有）；
                  live 源末条 assistant 消息带 streaming（打字机光标，等待中的可见交互） */}
              {renderPartUnits(
                groupParts(msg.parts).filter((unit) => {
                  if (unit.kind !== 'single' || unit.part.type !== 'text') return true
                  return !(!unit.part.text.trim() || collapsed)
                }),
                msg.parts,
                isLive && running && !collapsed && i === messages.length - 1 && msg.info.role === 'assistant',
                running,
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
  const subagentDefs = useStore((s) => s.subagentDefs)
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
  // 显示源：运行中实时流优先（手动拉的快照不覆盖实时）；结束后权威快照优先。
  // 空数组也回退（?? 只防 null/undefined）：任一源异常为空时另一源兜底，防"变空"。
  // live 接管加**实质内容迟滞**：live 只含订阅点之后的内容，中途打开弹窗时它往往
  // 只有 turn.started 建的空壳消息——此时不接管（快照先撑住显示），长出实际
  // 内容（正文/思考/工具任一）才切换，消除"快照→空壳→重长"的源跳变闪烁
  const liveHasContent = (m?: ZCodeMessage[]) => !!m && m.some((msg) =>
    msg.parts.some((p) =>
      (p.type === 'text' && p.text.trim()) ||
      (p.type === 'reasoning' && p.text.trim()) ||
      p.type === 'tool'))
  const hasAny = (m?: ZCodeMessage[]) => !!m && m.length > 0
  const display = running
    ? (liveHasContent(liveMessages) ? liveMessages : (hasAny(transcript) ? transcript : liveMessages))
    : (hasAny(transcript) ? transcript : liveMessages)
  const isLive = display === liveMessages

  // 自动滚底（与 ChatView 同策略）：距底 80px 内才跟随内容滚动，用户上滑即停
  //（上滑状态由 ScrollJumpButton 的 onStickChange 维护：scroll 事件原生监听）
  const bodyRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)
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

  // running→结束翻转：旧快照里的工具卡永远停在 running（v4 模式快照只在打开时拉过
  // 一次，"标题已完成、列表假转圈"的根因）——翻转沿自动重拉权威转录；1.5s 后静默
  // 补一次（服务端回合清算落库有滞后，首拉可能仍拿到倒数第二步）
  const prevRunningRef = useRef(running)
  const settleRetimer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(settleRetimer.current), [])
  useEffect(() => {
    if (prevRunningRef.current && !running && childSessionId) {
      loadChildMessages(childSessionId)
      window.clearTimeout(settleRetimer.current)
      settleRetimer.current = window.setTimeout(() => {
        loadChildMessages(childSessionId, true)
      }, 1500)
    }
    prevRunningRef.current = running
  }, [running, childSessionId, loadChildMessages])

  // 运行中的快照获取：v4 实时通道可用（subscribeChild 应答标志）时**完全不拉快照**——
  // 初始内容已由 v4 订阅的 snapshot 帧回放（batch 进 childLiveMessages），而
  // subagentMessages 链路的 session/resume 会把子会话切到 legacy 投递、v4 增量帧
  // 从此退化为空壳（2026-09-02 diag 实验 7/8 定案：运行中 resume 必杀 v4 流，read
  // 又必须 resume——所以运行中一个 resume 都不能发生）。v4 不可用（老 CLI 降级）
  // 才保留打开首拉 + 3s 轮询兜底。结束（running=false，事件流收尾时会再拉一次
  // 权威全量）或关闭弹窗即停。手动入口同样受守卫（handleRefresh：运行中不发了，
  // 按钮本身也只在非运行中渲染——用户实测点刷新即断流，"主动杀流由翻转沿兜底"
  // 的取舍不成立：live 冻结到回合结束，显示上无从感知"兜底"何时来）。
  // 三态守卫：true=实时流在场；undefined=订阅未决（childSessionId 到位即触发本 effect，
  // 而 subscribeChild 应答未回——此时照发 loadChildMessages 就是运行中 resume，2026-09-02
  // demo18 实测：v4 订阅 500ms 后的 resume 照样把会话切 legacy、增量帧全空壳，diag 实验 7
  // 同结论——顺序无关，运行期间一个 resume 都不能发生）；false=v4 不可用才降级轮询
  const v4state = useStore((s) => (childSessionId ? s.childSessionV4[childSessionId] : undefined))
  useEffect(() => {
    if (!running || !childSessionId) return
    if (v4state !== false) return // 等待订阅定夺：未决期间不拉（resume 杀流），也不轮询
    // 打开即拉一次（降级场景作为轮询首拍）
    loadChildMessages(childSessionId, true)
    const timer = setInterval(() => loadChildMessages(childSessionId, true), 3000)
    return () => clearInterval(timer)
  }, [running, childSessionId, v4state, loadChildMessages])

  // Escape 关闭（分层：Markdown 预览阅读层叠开时 Esc 归最上层，本弹窗不动；
  // 报告与详情互斥切换不可能同开，无让位分支）
  useEffect(() => {
    if (!key) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (useStore.getState().markdownPreview) return
      closeDetail()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [key, closeDetail])

  if (!key) return null

  // 耗时（与工具命令卡同格式："X.X 秒" / "X 分 Y 秒"，i18n）：item（三源合并，
  // part.time 优先）无有效对再看 RPC 原始 info，跨源不混搭。运行中以当前时刻
  // 实时累计；已结束但无有效终点则不显示（宁缺勿错——RPC 起止可能相等/倒挂，
  // 正是历史完成后显示 "0s" 的根源）
  const span = validSpan(item?.startedAt, item?.endedAt) ?? validSpan(info?.startedAt, info?.endedAt)
  const liveStart = span ? undefined : (running ? item?.startedAt ?? info?.startedAt : undefined)
  const duration = span
    ? formatToolDuration(span.endedAt - span.startedAt)
    : liveStart ? formatToolDuration(Math.max(0, Date.now() - liveStart)) : ''
  // 开始时刻（主界面 msg__footer-time 同款 clockTime：当天 HH:mm，跨天带日期）。
  // 三源之最先非空——与耗时同源，时刻不存在时耗时也不存在，二者同现同隐
  const startTs = item?.startedAt ?? info?.startedAt ?? activity?.startedAt
  const startTime = startTs ? clockTime(startTs) : ''
  // 模型（主界面 msg__footer-model 同款显示实际执行模型）：权威转录里最后一条
  // assistant 的 modelID 最准（多 turn 取末条，见 transcriptModel）；运行中 live
  // 归约不产此字段，回退子代理定义的 model（缺省=跟随主会话——不猜当前值，
  // 宁缺勿错，结束后权威重拉自然补上）
  const model = transcriptModel(display)
    ?? (running
      ? subagentDefs?.find((d) => d.name === (item?.subagentType ?? activity?.agentType ?? info?.subagentType))?.model
      : undefined)
  const badge = statusText(item?.status, t)
  const toolCount = activity?.tools.length ?? 0

  const handleRefresh = () => {
    if (!childSessionId) return
    // 与自动路径同守卫：运行中 + v4 在场/未决时发 loadChildMessages = resume 杀流。
    // header 按钮已只在非运行中渲染，这里是错误态重试/空态加载入口的兜底
    if (running && v4state !== false) return
    loadChildMessages(childSessionId)
    triggerSpin()
  }

  // 主聊天里 Agent 工具 part 的 output（最终报告，childSessionId 缺失时的兜底内容）
  const agentOutput = getAgentToolOutput(messages, key)
  // 失败原因：失败的 Agent part 没有 output、只有 state.error（历史读回为字符串，
  // 如 [1301] 内容审查拦截文案）——session/subagents 的 ended 只收录 success 条目，
  // 失败子会话拿不到 childSessionId、转录无从拉取时，这是弹窗唯一能展示的失败详情
  const failErrorText = getAgentToolErrorText(messages, key)
  // 报告按钮：状态=已完成才显示（running 时报告未生成、error 时无完整报告可读），
  // 状态取三源之最先非空（流式聚合 / RPC 权威 / 转发活动，见数据分三层注释）
  const finalStatus = item?.status ?? info?.status ?? activity?.status
  // 成功铁证否决误标的失败（2026-09-01 实测：任务成功、报告在场，活动却被中途
  // 事件误标 error——弹窗显示"执行失败"+假耗时，内容与状态自相矛盾）：
  // a) RPC ended 的 status=success（服务端 ended 只收录成功条目，是权威认定）；
  // b) Agent 工具有最终报告且无任何错误详情（真失败没有 output、只有 state.error，
  //    或 output 是 "Agent failed: ..." 的失败收尾形态——错误详情以 output 承载）
  const successEvidence = info?.status === 'success'
    || (!!agentOutput && !failErrorText && !agentOutput.startsWith('Agent failed'))
  const failed = !running && (finalStatus === 'error' || finalStatus === 'failed') && !successEvidence
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
              {startTime && <span className="subagent-detail-meta-item">{startTime}</span>}
              {model && <span className="subagent-detail-meta-item">{model}</span>}
              {duration && <span className="subagent-detail-meta-item">{duration}</span>}
              {toolCount > 0 && <span className="subagent-detail-meta-item">{t('tool.toolsCount', { count: toolCount })}</span>}
            </div>
          </div>
          {/* 手动重拉完整记录：只在非运行中出现——运行中实时流就是最新数据，
              点刷新只会触发 resume 杀流（断流实测 2026-09-04）；降级轮询场景
              3s 自动拉也不需要它 */}
          {!running && childSessionId && (
            <button
              className="subagent-detail-icon-btn"
              data-tip={t('tool.subagent.reloadFull')}
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

        <div className="subagent-detail-body" ref={bodyRef}>
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
              isLive={isLive}
              allowReportCollapse={finalStatus === 'completed'}
              onOpenReport={(fallbackMd) => openSubagentReport({
                callID: key,
                title: item?.description || activity?.description || t('tool.subagentReport'),
                markdown: agentOutput || fallbackMd,
              })}
            />
          )}

          {/* 失败收尾提示条：独立于转录渲染（排在层 2-4 之前）——失败子会话不被
              session/subagents 的 ended 收录，历史重开时 childSessionId 无从获取、
              转录拉不到，这条常是弹窗唯一内容；错误详情优先 Agent 工具 output
              （流式收尾文本），缺失时读 part.state.error（历史读回形态） */}
          {failed && (
            <div className="subagent-detail-failed">
              <div className="subagent-detail-failed__head">
                <span className="codicon codicon-error" />
                <span>{t('tool.subagent.taskFailed')}</span>
              </div>
              {(agentOutput || failErrorText) && (
                <div className="subagent-detail-failed__reason">
                  <MarkdownBlock markdown={agentOutput || failErrorText} />
                </div>
              )}
            </div>
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
                {/* 转发的工具事件列表同样聚组（回退场景常见：Explore 连续读多文件）；
                    running 期间 softenError：组卡 error 工具降级「↻ 重试中」 */}
                {renderPartUnits(groupParts(activity!.tools), activity!.tools, undefined, running)}
              </div>
            </>
          )}

          {/* 层3：无实时数据 → 兜底显示 Agent 工具的最终报告（失败场景由上方失败条承载，不双显） */}
          {!display && toolCount === 0 && agentOutput && !failed && (
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
        {/* 滚动跳转按钮（↑置顶/↓置底，对齐主界面）：子代理过程动辄几十个工具卡，
            置顶看 prompt/置底追进展是高频操作 */}
        <ScrollJumpButton
          containerRef={bodyRef}
          onStickChange={(up) => { userScrolledUp.current = up }}
        />
      </div>
    </div>
  )
}
