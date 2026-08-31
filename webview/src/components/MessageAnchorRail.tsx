/**
 * 消息锚点导航（cc-gui MessageAnchorRail 移植）
 *
 * - 只取 user 消息生成圆点（位置 4%~96%，单条时固定在顶部）
 * - 无 user 消息不渲染；>30 条均匀抽样（保留首尾）
 * - IntersectionObserver 高亮当前（视口上 32% 区域第一条）
 * - 点击平滑滚动到目标（停在视口上 28% 处）
 * - hover 500ms 显示该消息前 300 字预览
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ZCodeMessage } from '@/types/messages'
import { isAgentNotification, isCompactSummaryMessage } from '@/utils/parseNotification'
import '../styles/chat-view.less'

interface Props {
  messages: ZCodeMessage[]
  containerRef: React.RefObject<HTMLDivElement | null>
}

interface Anchor {
  id: string
  position: number
  preview: string
}

/** 均匀抽样（cc-gui sampleAnchorItems）*/
function sampleItems<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  return items.filter((_, index) => {
    const sampleIndex = Math.round((index / (items.length - 1)) * (max - 1))
    return index === 0 || sampleIndex !== Math.round(((index - 1) / (items.length - 1)) * (max - 1))
  })
}

export function MessageAnchorRail({ messages, containerRef }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 锚点列表：只取真实 user 消息（排除子agent/任务回调等合成通知，以及压缩摘要
  // 消息——role 也是 user 但渲染走 CompactionSummaryCard、不挂 data-anchor-msg，
  // 收进锚点点了也跳不动）
  const anchors = useMemo<Anchor[]>(() => {
    const userMsgs = messages.filter((m) =>
      m.info.role === 'user' && !isAgentNotification(m.info) && !isCompactSummaryMessage(m.info))
    if (userMsgs.length === 0) return []
    const max = 30
    const sampled = userMsgs.length > max ? sampleItems(userMsgs, max) : userMsgs
    return sampled.map((m, idx) => ({
      id: m.info.id,
      // 单锚点放顶部（避免除以 0），多个时均匀分布在 4%~96%
      position: sampled.length === 1 ? 0.04 : 0.04 + (idx / (sampled.length - 1)) * 0.92,
      preview: m.parts
        .filter((p) => p.type === 'text')
        .map((p) => ('text' in p ? (p as { text: string }).text : ''))
        .join(' ')
        .slice(0, 300),
    }))
  }, [messages])

  // IntersectionObserver：视口上 32% 区域内的第一条设为 active（按 DOM 顺序）
  useEffect(() => {
    const container = containerRef.current
    if (!container || anchors.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.target.compareDocumentPosition(b.target) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        if (visible.length > 0) {
          setActiveId(visible[0].target.getAttribute('data-anchor-msg'))
        }
      },
      { root: container, rootMargin: '0px 0px -68% 0px', threshold: 0 },
    )

    container.querySelectorAll('[data-anchor-msg]').forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [anchors, containerRef])

  // hover 500ms 后显示预览
  const handleMouseEnter = (id: string) => {
    hoverTimer.current = setTimeout(() => setHoverId(id), 500)
  }
  const handleMouseLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    setHoverId(null)
  }

  if (anchors.length === 0) return null

  // 点击滚动：目标停在视口上 28% 处
  // 用 getBoundingClientRect 相对容器计算（offsetTop 相对最近定位祖先，嵌套定位时会算错）
  const scrollToAnchor = (id: string) => {
    const container = containerRef.current
    if (!container) return
    const node = container.querySelector(`[data-anchor-msg="${id}"]`) as HTMLElement | null
    if (!node) return
    const containerRect = container.getBoundingClientRect()
    const nodeRect = node.getBoundingClientRect()
    // node 顶部相对容器顶部的偏移 = 当前 scrollTop + 二者 rect 差
    const delta = nodeRect.top - containerRect.top
    container.scrollTo({
      top: container.scrollTop + delta - container.clientHeight * 0.28,
      behavior: 'smooth',
    })
  }

  return (
    <div className="messages-anchor-rail">
      <div className="messages-anchor-track" />
      {anchors.map((a) => (
        <div
          key={a.id}
          className={`messages-anchor-dot ${activeId === a.id ? 'is-active' : ''}`}
          style={{ top: `${a.position * 100}%` }}
          onMouseEnter={() => handleMouseEnter(a.id)}
          onMouseLeave={handleMouseLeave}
          onClick={() => scrollToAnchor(a.id)}
        >
          {hoverId === a.id && <div className="anchor-tooltip">{a.preview}</div>}
        </div>
      ))}
    </div>
  )
}
