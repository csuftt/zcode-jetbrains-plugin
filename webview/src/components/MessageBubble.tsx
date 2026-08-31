/**
 * 消息气泡
 *
 * 规划文档第四节：
 *   - user 消息：右对齐，蓝色气泡，纯文本（不走 markdown），时间戳在上方
 *   - assistant 消息：左对齐，无气泡背景，满宽 markdown 渲染
 *
 * part 渲染策略（基于抓包）：
 *   text     → MarkdownBlock（连续的 text part 合并）
 *   reasoning → ThinkingBlock（折叠）
 *   tool     → ToolCallCard（折叠）；连续同类聚组（见 utils/groupParts.ts）：
 *              Bash → BashCommandGroupCard（批量运行命令）
 *              Read/Edit/Write/Grep/Glob → FileToolGroupCard（批量读/编/搜）
 *   step-start / step-finish → 不渲染（边界标记）
 *
 * 规划文档第二节第 3 点（工具分组）：连续同类 tool part 合并成一个组（cc-gui 规则）。
 *
 * 完成轮折叠（对齐官方客户端）：非流式的完整轮默认只渲染最终结论（最后一个 text），
 * 执行过程不进 DOM；结论上方渲染「执行过程」折叠栏（概览：思考/工具计数 + 轮次耗时），
 * 点击展开/收起。搜索面板打开时强制展开全部过程（searchActive），
 * 保会话内搜索 TreeWalker 能扫到/定位到过程文本。
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { ZCodeMessage, MessagePart, TextPart, ImagePart, FilePart } from '@/types/messages'
import { useStore } from '@/store/useStore'
import { MarkdownBlock } from './MarkdownBlock'
import { AgentNotificationCard } from './AgentNotificationCard'
import { isAgentNotification, isCompactSummaryMessage, findTimelinePart } from '@/utils/parseNotification'
import { clockTime, formatDuration } from '@/utils/time'
import { readTurnCollapseConfig } from '@/utils/turnCollapseConfig'
import { KV_HYDRATED_EVENT } from '@/utils/persist'
import { useTick } from '@/hooks/useTick'
import { CompactionSummaryCard } from './CompactionSummaryCard'
import { TimelineSeparator } from './TimelineSeparator'
import {
  collectImageParts,
  imagePartSrc,
  imagePartTitle,
  MessageImage,
  renderPartUnits,
} from './PartUnits'
import { groupParts } from '@/utils/groupParts'
import '../styles/message-bubble.less'

interface Props {
  message: ZCodeMessage
  /** 是否正在流式（用于打字机光标 + 思考自动展开）*/
  streaming?: boolean
  /** user 消息的锚点 id（供 MessageAnchorRail 定位，assistant 不传）*/
  anchorAttr?: string
  /** 会话内搜索面板激活（长用户消息临时展开，保 TreeWalker 高亮/定位）*/
  searchActive?: boolean
}

export const MessageBubble = memo(function MessageBubble({ message, streaming, anchorAttr, searchActive }: Props) {
  const { info, parts } = message
  const isUser = info.role === 'user'
  const time = clockTime(info.time?.created)
  // 已发定时记录：服务端读回的消息不带定时标记，按下匹配补「定时执行」徽标
  const firedHistory = useStore((s) => s.firedHistory)

  // 子 agent / 任务回调的合成通知（role 是 user 但 synthetic）：独立卡片渲染，不当用户消息
  if (isAgentNotification(info)) {
    return <AgentNotificationCard message={message} time={time} />
  }
  // 压缩摘要消息（role=user + info.summary）：折叠卡片，不当用户气泡
  // （消息级无 synthetic 标记，isHiddenSyntheticMessage 拦不住，必须在此分流）
  if (isCompactSummaryMessage(info)) {
    return <CompactionSummaryCard message={message} time={time} />
  }
  // 时间线分隔符消息（assistant + timeline part）：无气泡结构的横线分隔卡，
  // 此前 timeline part 不被识别渲染成"只有耗时行的空壳气泡"
  const timelinePart = findTimelinePart(parts)
  if (timelinePart) {
    return <TimelineSeparator part={timelinePart} />
  }
  if (isUser) {
    const userText = collectUserText(parts)
    // 乐观消息自带 scheduledFireAt（真发时本地构造）；服务端读回（历史重拉/后台直发打开标签）
    // 不带任何定时标记，按 sessionId+text 从 Java 已发记录匹配还原
    const firedAt =
      typeof info.scheduledFireAt === 'number'
        ? (info.scheduledFireAt as number)
        : firedHistory.find((f) => f.sessionId === info.sessionID && f.text === userText)?.fireAt
    return (
      <UserBubble
        text={userText}
        imageParts={collectImageParts(parts)}
        time={time}
        anchorAttr={anchorAttr}
        searchActive={searchActive}
        scheduledFireAt={firedAt}
      />
    )
  }
  return <AssistantBubble message={message} time={time} streaming={streaming} searchActive={searchActive} />
})

/** 用户消息长文折叠阈值（对齐 InputBox 粘贴折叠 PASTE_* 常量：≥10 行或 ≥500 字符）*/
const USER_COLLAPSE_LINES = 10
const USER_COLLAPSE_CHARS = 500

/**
 * user 消息：纯文本，右对齐蓝色气泡。
 *
 * 长文折叠：全文仍完整渲染进 DOM（搜索 TreeWalker 依赖完整文本节点），
 * 仅用 max-height+渐隐做视觉折叠；点击按钮 portal 弹窗看全文。
 */
function UserBubble({
  text,
  imageParts,
  time,
  anchorAttr,
  searchActive,
  scheduledFireAt,
}: {
  text: string
  imageParts: Array<ImagePart | FilePart>
  time: string
  anchorAttr?: string
  searchActive?: boolean
  /** 定时消息标记（fireAt）：发出后气泡上带「定时执行」徽标（历史重拉不带，预期）*/
  scheduledFireAt?: number
}) {
  const { t } = useTranslation()
  const [showFull, setShowFull] = useState(false)
  const lines = useMemo(() => text.split('\n').length, [text])
  const collapsible = lines >= USER_COLLAPSE_LINES || text.length >= USER_COLLAPSE_CHARS
  // 搜索面板激活时强制展开：高亮 mark 与 scrollIntoView 定位需要全文可见
  const collapsed = collapsible && !searchActive
  const hasImages = imageParts.length > 0
  const images = useMemo(
    () =>
      imageParts
        .map((img, i) => ({
          src: imagePartSrc(img),
          key: img.id ?? `${img.type}-${i}`,
          title: imagePartTitle(img),
        }))
        .filter((x): x is { src: string; key: string; title: string | undefined } => !!x.src),
    [imageParts],
  )

  return (
    <div className="msg msg--user" data-anchor-msg={anchorAttr}>
      <div className="msg__time">
        {time}
        {scheduledFireAt != null && (
          <span className="msg__schedule-badge" title={t('input.schedule.firedBadge')}>
            <span className="codicon codicon-clockface" />
            {t('input.schedule.firedBadge')}
          </span>
        )}
      </div>
      <div className={`msg__bubble${collapsed ? ' msg__bubble--collapsed' : ''}`}>
        {hasImages && (
          <div className="msg__images">
            {images.map((img) => (
              <MessageImage key={img.key} src={img.src} title={img.title} />
            ))}
          </div>
        )}
        {text ? text : hasImages ? null : t('chat.message.emptyText')}
        {collapsed && (
          <button type="button" className="msg__expand" onClick={() => setShowFull(true)}>
            <span className="codicon codicon-unfold" />
            {t('chat.message.viewFull', { lines, count: text.length })}
          </button>
        )}
      </div>
      {showFull && (
        <UserTextPreviewDialog text={text} lines={lines} onClose={() => setShowFull(false)} />
      )}
    </div>
  )
}

/**
 * 用户消息全文弹窗。portal 挂 body（脱离 messages-container），
 * 避免全文 pre/文本进入会话内搜索的 TreeWalker 与代码块匹配范围。
 */
function UserTextPreviewDialog({
  text,
  lines,
  onClose,
}: {
  text: string
  lines: number
  onClose: () => void
}) {
  const { t } = useTranslation()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-content msg-fulltext"
        role="dialog"
        aria-label={t('chat.message.fullTextAria')}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t('chat.message.fullTextTitle', { lines, count: text.length })}</h3>
        <pre className="msg-fulltext__body">{text}</pre>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-primary" onClick={onClose} type="button">
            {t('chat.message.closeFull')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 完成轮折叠判定（对齐官方客户端：已完成轮默认只展示最终结论，点「已工作 X」展开过程）。
 *
 * 「最终结论」= 最后一个 text part；结论之前存在可见过程（reasoning/tool/中间 text/图）
 * 即可折叠。结论之后可能挂收尾动作（模型总结后又做的工具调用/思考，如收纳浏览器面板）——
 * 不阻断折叠，保留在结论之后渲染（折的是结论之前的过程）。
 * 折叠态只渲染结论+尾部，过程不进 DOM（性能收益 + 老会话减负）；
 * 会话内搜索靠 searchActive 强制展开兜底（与 UserBubble 长文折叠同策略）。
 */
const PROCESS_TYPES: ReadonlySet<string> = new Set(['text', 'reasoning', 'tool', 'image', 'file'])

function turnCollapseInfo(parts: MessagePart[]): { lastTextIdx: number; collapsible: boolean } {
  let lastTextIdx = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'text') {
      lastTextIdx = i
      break
    }
  }
  if (lastTextIdx < 0) return { lastTextIdx, collapsible: false }
  return { lastTextIdx, collapsible: parts.slice(0, lastTextIdx).some((p) => PROCESS_TYPES.has(p.type)) }
}

/**
 * 「自动折叠执行过程」配置读取。挂载即读（设置视图切换重挂 ChatView 已覆盖
 * 改设置后的回显）；KV 水合事件兜底启动竞态（水合前读到默认值），storage
 * 事件兜底多标签同步。
 */
function useAutoCollapseConfig(): boolean {
  const [auto, setAuto] = useState(() => readTurnCollapseConfig().autoCollapse)
  useEffect(() => {
    const refresh = () => setAuto(readTurnCollapseConfig().autoCollapse)
    window.addEventListener(KV_HYDRATED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(KV_HYDRATED_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])
  return auto
}

/** assistant 消息：左对齐，满宽 markdown + 工具卡片 + 思考 */
function AssistantBubble({
  message,
  time,
  streaming,
  searchActive,
}: {
  message: ZCodeMessage
  time: string
  streaming?: boolean
  searchActive?: boolean
}) {
  const { info, parts } = message

  // 连续 Bash 命令聚组（cc-gui groupBlocks 规则）：压缩批量命令的消息区长度。
  // 分组保留原始 part 下标，reasoning 自动展开/流式判定的 index 语义不变
  const units = useMemo(() => groupParts(parts), [parts])
  // 单元渲染走共享管线（与子代理弹窗共用，含组卡/单卡/reasoning 自动展开推导）；
  // 折叠态只渲染尾部单元（结论后的收尾动作），推导仍基于完整 parts
  const renderedUnits = useMemo(() => renderPartUnits(units, parts, streaming), [units, parts, streaming])

  // 完成轮折叠（流式期间全渲染，turn 结束起默认只留结论）；
  // 「自动折叠执行过程」设置控制默认态，手动点折叠栏的意图优先于设置；
  // 搜索面板激活时强制展开，保 TreeWalker 能扫到过程文本。
  // 折的是结论之前的过程；结论之后挂的收尾动作（工具/思考）不折，保留在结论后面
  const { lastTextIdx, collapsible } = useMemo(() => turnCollapseInfo(parts), [parts])
  const autoCollapse = useAutoCollapseConfig()
  const [manualExpand, setManualExpand] = useState<boolean | null>(null)
  // 设置开 → 默认收起；手动点击过的意图（非 null）优先于设置默认值
  const expanded = manualExpand ?? !autoCollapse
  const collapsed = collapsible && !streaming && !expanded && !searchActive
  // 折叠栏概览只统计结论之前的过程（尾部收尾动作不折，不计数）
  const processParts = useMemo(
    () => (collapsible ? parts.slice(0, lastTextIdx) : parts),
    [collapsible, lastTextIdx, parts],
  )
  // 折叠态下保留的尾部单元：整组/单个 part 全部落在结论之后（工具组是连续同类
  // tool 的极大游程，text 不在其中，不会出现跨越结论的组）
  const renderedTailUnits = useMemo(
    () =>
      collapsible
        ? renderPartUnits(
            units.filter((u) => (u.kind === 'toolGroup' ? u.startIndex : u.index) > lastTextIdx),
            parts,
            streaming,
          )
        : [],
    [collapsible, lastTextIdx, units, parts, streaming],
  )
  // 折叠栏概览的轮次耗时：服务端权威值（completed - created）；重拉窗口缺 completed 就不显示
  const processMs =
    collapsible && info.time?.created && info.time.completed
      ? info.time.completed - info.time.created
      : null

  return (
    <div className="msg msg--assistant">
      <div className="msg__content">
        {collapsible && !streaming && (
          <TurnProcessBar
            parts={processParts}
            collapsed={collapsed}
            durationMs={processMs}
            onToggle={() => setManualExpand(!expanded)}
          />
        )}
        {collapsed ? (
          <>
            <MarkdownBlock markdown={(parts[lastTextIdx] as TextPart).text} />
            {renderedTailUnits}
          </>
        ) : (
          renderedUnits
        )}
      </div>
      <MessageFooter info={info} time={time} streaming={streaming} />
    </div>
  )
}

/**
 * 完成轮折叠栏（对齐官方客户端位置：用户消息之后、最终结论之前）：
 * 「▸ 执行过程 · 思考 N 次 · N 个工具 · X 分 Y 秒」概览条，点击展开/收起执行过程。
 * 展开后条仍在过程顶部，随时可收起——不需要滚到消息底部找按钮。
 */
function TurnProcessBar({
  parts,
  collapsed,
  durationMs,
  onToggle,
}: {
  parts: MessagePart[]
  collapsed: boolean
  durationMs: number | null
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const tools = parts.reduce((n, p) => (p.type === 'tool' ? n + 1 : n), 0)
  const thoughts = parts.reduce((n, p) => (p.type === 'reasoning' ? n + 1 : n), 0)
  const items: string[] = []
  if (thoughts > 0) items.push(t('chat.message.processThoughts', { count: thoughts }))
  if (tools > 0) items.push(t('chat.message.processTools', { count: tools }))
  if (durationMs != null) items.push(formatDuration(durationMs))
  return (
    <button type="button" className="msg__process-bar" onClick={onToggle}>
      <span className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`} aria-hidden="true" />
      <span className="msg__process-bar-label">{t('chat.message.processLabel')}</span>
      {items.length > 0 && <span className="msg__process-bar-meta">{items.join(' · ')}</span>}
    </button>
  )
}

/** user 消息的文本收集：把所有 text part 合并 */
function collectUserText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

/**
 * assistant 消息底部：时间 + 轮次耗时 + token 信息
 *
 * 轮次耗时（对齐 cc-gui）：
 *   - 流式中：⏱ 工作中 X 秒（每秒跳动，起点 = 消息 created 即 turn.started）
 *   - 已完成：⏱ 已工作 X 分 Y 秒（completed - created，服务端权威值）
 *   - turn 结束 → 重拉消息之间有短暂窗口缺 completed，用最后一次跳动值冻结过渡
 */
function MessageFooter({ info, time, streaming }: { info: ZCodeMessage['info']; time: string; streaming?: boolean }) {
  const { t } = useTranslation()
  const tokens = info.tokens
  const model = info.modelID

  const now = useTick(!!streaming)
  const lastElapsedRef = useRef<number | null>(null)
  let durationMs: number | null = null
  let working = false
  const created = info.time?.created
  if (created) {
    if (info.time.completed) {
      durationMs = info.time.completed - created
    } else if (streaming) {
      working = true
      durationMs = now - created
      lastElapsedRef.current = durationMs
    } else {
      durationMs = lastElapsedRef.current
    }
  }

  return (
    <div className="msg__footer">
      <span className="msg__footer-time">{time}</span>
      {model && <span className="msg__footer-model">{model}</span>}
      {durationMs != null && (
        <span className={`msg__footer-duration${working ? ' msg__footer-duration--working' : ''}`}>
          ⏱ {working ? t('chat.message.working') : t('chat.message.worked')} {formatDuration(durationMs)}
        </span>
      )}
      {tokens && (
        <span className="msg__footer-tokens">
          💡 {tokens.input.toLocaleString()} in / {tokens.output.toLocaleString()} out
          {tokens.cache?.read ? ` · ${t('chat.message.cachePercent', { percent: Math.round((tokens.cache.read / tokens.input) * 100) })}` : ''}
        </span>
      )}
      {info.cost ? <span className="msg__footer-cost">${info.cost.toFixed(4)}</span> : null}
    </div>
  )
}
