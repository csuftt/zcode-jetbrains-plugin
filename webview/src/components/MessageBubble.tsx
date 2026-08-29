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
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { ZCodeMessage, MessagePart, TextPart, ImagePart, FilePart } from '@/types/messages'
import { useStore } from '@/store/useStore'
import { MarkdownBlock } from './MarkdownBlock'
import { ToolCallCard } from './ToolCallCard'
import { ThinkingBlock } from './ThinkingBlock'
import { AgentNotificationCard } from './AgentNotificationCard'
import { BashCommandGroupCard } from './BashCommandGroupCard'
import { FileToolGroupCard } from './FileToolGroupCard'
import { groupParts } from '@/utils/groupParts'
import { isAgentNotification, isCompactSummaryMessage, findTimelinePart } from '@/utils/parseNotification'
import { clockTime, formatDuration } from '@/utils/time'
import { useTick } from '@/hooks/useTick'
import { CompactionSummaryCard } from './CompactionSummaryCard'
import { TimelineSeparator } from './TimelineSeparator'
import { ImagePreview } from './ImagePreview'
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
  return <AssistantBubble message={message} time={time} streaming={streaming} />
})

/**
 * user 消息的图片 part 收集：乐观消息（type:'image'）与服务端读回
 * （type:'file' + mime image/*，2026-08-26 RPC 实测形态）两种形态统一收集。
 */
function collectImageParts(parts: MessagePart[]): Array<ImagePart | FilePart> {
  return parts.filter((p): p is ImagePart | FilePart =>
    p.type === 'image' || (p.type === 'file' && (p.mime ?? '').startsWith('image/')),
  )
}

/** 图片 part → 可渲染 src：image 用 dataUrl/拼 base64；file 用 url（Java 已换成 http）*/
function imagePartSrc(img: ImagePart | FilePart): string {
  if (img.type === 'image') {
    if (img.dataUrl) return img.dataUrl
    if (img.dataBase64) return `data:${img.mediaType || 'image/png'};base64,${img.dataBase64}`
    return ''
  }
  // file part：zcode-artifact://（Java 未转换/转换失败）不可渲染，返回空跳过
  return img.url && /^https?:\/\//.test(img.url) ? img.url : ''
}

/** 图片 part 的展示标题（hover/大图预览）*/
function imagePartTitle(img: ImagePart | FilePart): string | undefined {
  if (img.type === 'image') return img.source?.filename ?? img.source?.placeholder
  return img.filename ?? (img.metadata?.image as Record<string, unknown> | undefined)?.filename as string | undefined
}

/**
 * 消息内图片（限宽圆角，点击大图预览）。user 气泡与 PartRenderer 共用。
 */
function MessageImage({ src, title }: { src: string; title?: string }) {
  const [preview, setPreview] = useState(false)
  return (
    <>
      <img className="msg__image" src={src} alt={title ?? ''} title={title} onClick={() => setPreview(true)} />
      {preview && <ImagePreview src={src} title={title} onClose={() => setPreview(false)} />}
    </>
  )
}

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
            <span className="codicon codicon-calendar" />
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

/** assistant 消息：左对齐，满宽 markdown + 工具卡片 + 思考 */
function AssistantBubble({ message, time, streaming }: { message: ZCodeMessage; time: string; streaming?: boolean }) {
  const { info, parts } = message
  // 找最后一个 reasoning part
  const lastReasoningIdx = (() => {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].type === 'reasoning') return i
    }
    return -1
  })()

  // 最后一个 reasoning 之后是否已有 text part（有则折叠 reasoning，没有则保持展开）
  const hasTextAfterLastReasoning = lastReasoningIdx >= 0
    ? parts.slice(lastReasoningIdx + 1).some((p) => p.type === 'text')
    : false

  // 流式时最后一个 part 是正在增长的
  const lastPartIdx = parts.length - 1

  // 连续 Bash 命令聚组（cc-gui groupBlocks 规则）：压缩批量命令的消息区长度。
  // 分组保留原始 part 下标，reasoning 自动展开/流式判定的 index 语义不变
  const units = useMemo(() => groupParts(parts), [parts])

  return (
    <div className="msg msg--assistant">
      <div className="msg__content">
        {units.map((unit) =>
          unit.kind === 'toolGroup' ? (
            unit.group === 'bash' ? (
              <BashCommandGroupCard key={`bash-${unit.startIndex}`} parts={unit.parts} />
            ) : (
              <FileToolGroupCard key={`${unit.group}-${unit.startIndex}`} kind={unit.group} parts={unit.parts} />
            )
          ) : (
            <PartRenderer
              key={unit.index}
              part={unit.part}
              // reasoning 自动展开：是最后一个 reasoning + 后面还没有正文
              autoExpandReasoning={unit.index === lastReasoningIdx && !hasTextAfterLastReasoning}
              streaming={!!streaming && unit.index === lastPartIdx}
            />
          ),
        )}
      </div>
      <MessageFooter info={info} time={time} streaming={streaming} />
    </div>
  )
}

/** 单个 part 的渲染分发 */
function PartRenderer({
  part,
  autoExpandReasoning,
  streaming,
}: {
  part: MessagePart
  autoExpandReasoning: boolean
  streaming: boolean
}) {
  switch (part.type) {
    case 'text':
      return <MarkdownBlock markdown={part.text} streaming={streaming} />

    case 'image':
    case 'file': {
      // file part：仅 image/* 是图片（Java 已把 url 换成 http；非图片/未转换返回 null）
      if (part.type === 'file' && !(part.mime ?? '').startsWith('image/')) return null
      const src = imagePartSrc(part)
      if (!src) return null
      return <MessageImage src={src} title={imagePartTitle(part)} />
    }

    case 'reasoning':
      // 自动展开：思考还在进行中或刚结束还没正文。正文出现后自动折叠。
      // streaming（本 part 是流式中最后一个 part）驱动思考耗时跳动计时
      return <ThinkingBlock part={part} autoExpand={autoExpandReasoning} streaming={streaming} />

    case 'tool':
      return <ToolCallCard part={part} />

    case 'step-start':
    case 'step-finish':
      return null

    default:
      return null
  }
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
