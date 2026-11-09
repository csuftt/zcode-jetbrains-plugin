/**
 * 思考过程折叠块
 *
 * 基于抓包真实结构（2026-08-13）：
 *   part.type = "reasoning"（不是 thinking！）
 *   part.text = "这是一个经典的组合数学问题..."
 *
 * 规划文档第二节第 4 点（cc-gui thinking-block 策略）：
 *   - 默认折叠
 *   - 流式时最新的 thinking 块自动展开（由父组件传 autoExpand）
 *   - 用户手动展开/折叠过的块永不被自动覆盖（manuallyToggled）
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReasoningPart } from '@/types/messages'
import { renderMarkdown } from '@/utils/markdown'
import { handleMarkdownLinkClick } from '@/utils/externalLink'
import { formatDuration } from '@/utils/time'
import { useTick } from '@/hooks/useTick'
import { useStore } from '@/store/useStore'
import { NEAR_BOTTOM_PX, UP_GHOST_MS } from './ScrollJumpButton'
import '../styles/thinking-block.less'

interface Props {
  part: ReasoningPart
  /** 父组件要求自动展开（流式中的最新块）*/
  autoExpand?: boolean
  /** 思考正在进行中（本 part 是流式消息的最后一个 part）→ 耗时跳动计时 */
  streaming?: boolean
}

export function ThinkingBlock({ part, autoExpand = false, streaming = false }: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(autoExpand)
  // 工作区根：文件路径链接化解析相对路径用（与 MarkdownBlock 同源）
  const workspaceRoot = useStore((s) => s.currentWorkspacePath || s.projectPath)
  // 用户是否手动操作过（操作过后不再受 autoExpand 影响）
  const manuallyToggled = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 距底附近才自动跟滚：用户上滚回看历史时置底会强制拉回（流式增长 16ms 一轮，
  // 无条件置底根本滚不动）；滚回底部附近自动恢复跟滚
  const stickToBottom = useRef(true)
  // 最近一次滚轮上滑时刻：其后短窗内 nearBottom 的 scroll 不恢复跟滚——
  // 起步第一格 scroll 距底仍 <80px，恢复会被下一轮流式置底立刻拽回（上滑弹跳）
  const lastUpWheelAt = useRef(0)

  // autoExpand 变化时，如果用户没手动操作过，跟随自动状态
  useEffect(() => {
    if (!manuallyToggled.current) {
      setExpanded(autoExpand)
    }
  }, [autoExpand])

  // 流式内容增长时自动滚到底部（思考过程实时刷新；用户上滚查看历史时不打扰）
  useEffect(() => {
    const el = bodyRef.current
    if (el && expanded && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [part.text, expanded])

  const handleBodyScroll = () => {
    const el = bodyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    // 上滑余震窗内的 nearBottom 不恢复跟滚（起步第一格仍在 80px 窗口内）
    if (!(nearBottom && Date.now() - lastUpWheelAt.current < UP_GHOST_MS)) {
      stickToBottom.current = nearBottom
    }
  }

  // 滚轮上滑先于 scroll 断跟：从底部起步的第一格 scroll 距底仍 <80px，
  // 会被 nearBottom 判定误保持跟滚，下一轮流式置底立刻拽回（上滑弹跳）
  const handleBodyWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      lastUpWheelAt.current = Date.now()
      stickToBottom.current = false
    }
  }

  // 思考耗时：有 end 用静态差值；进行中（无 end + streaming）跳动计时；
  // 停止跳动后（turn 结束重拉消息前的窗口期）冻结在最后一次跳动值
  const now = useTick(streaming)
  const lastElapsedRef = useRef<number | null>(null)
  let durationMs: number | null = null
  const time = part.time
  if (time?.start) {
    if (time.end) {
      durationMs = time.end - time.start
    } else if (streaming) {
      durationMs = now - time.start
      lastElapsedRef.current = durationMs
    } else {
      durationMs = lastElapsedRef.current
    }
  }

  const handleToggle = () => {
    manuallyToggled.current = true
    // 重新展开恢复跟滚：再次展开的意图通常是看最新内容（思考尾部）
    if (!expanded) stickToBottom.current = true
    setExpanded(!expanded)
  }

  if (!part.text?.trim()) return null

  return (
    <div className={`thinking-block ${expanded ? 'thinking-block--expanded' : ''}`}>
      <div className="thinking-block__header" onClick={handleToggle}>
        <span className="thinking-block__icon"><span className="codicon codicon-sparkle-filled" /></span>
        <span className="thinking-block__title">{streaming ? t('chat.thinking.thinking') : t('chat.thinking.thought')}</span>
        {durationMs != null && (
          <span className={`thinking-block__duration${streaming ? ' thinking-block__duration--active' : ''}`}>
            {formatDuration(durationMs)}
          </span>
        )}
        <span className="thinking-block__toggle">{expanded ? '▼' : '▶'}</span>
      </div>
      {expanded && (
        <div
          ref={bodyRef}
          className="thinking-block__body markdown-body"
          onScroll={handleBodyScroll}
          onWheel={handleBodyWheel}
          onClick={handleMarkdownLinkClick}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text, false, workspaceRoot) }}
        />
      )}
    </div>
  )
}
