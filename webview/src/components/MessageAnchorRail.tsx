/**
 * 消息锚点导航（cc-gui MessageAnchorRail 移植）
 *
 * - 只取 user 消息生成圆点（位置 4%~96%，单条时固定在顶部）
 * - 无 user 消息不渲染；>30 条均匀抽样（保留首尾）
 * - IntersectionObserver 高亮当前（视口上 32% 区域第一条）
 * - 点击平滑滚动到目标（停在视口上 28% 处）
 * - hover 500ms 显示该消息前 300 字预览
 * - 轨道终点是历史入口节点（与圆点同族）：点击弹窗列出全部用户消息
 *   （不受 30 条抽样限制），点击条目跳转
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
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

interface HistoryItem {
  id: string
  time: number
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

/** 真实 user 消息（排除子agent/任务回调等合成通知，以及压缩摘要消息——
 *  role 也是 user 但渲染走 CompactionSummaryCard、不挂 data-anchor-msg）*/
function filterUserMessages(messages: ZCodeMessage[]): ZCodeMessage[] {
  return messages.filter((m) =>
    m.info.role === 'user' && !isAgentNotification(m.info) && !isCompactSummaryMessage(m.info))
}

/** 拼接消息 text part 文本并截断 */
function extractText(m: ZCodeMessage, max: number): string {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => ('text' in p ? (p as { text: string }).text : ''))
    .join(' ')
    .slice(0, max)
}

/** 消息时间：当天 HH:mm，跨天 M-d HH:mm */
function formatMsgTime(created: number): string {
  if (!Number.isFinite(created) || created <= 0) return ''
  const d = new Date(created)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`
}

export function MessageAnchorRail({ messages, containerRef }: Props) {
  const { t } = useTranslation()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [nodeHover, setNodeHover] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const historyListRef = useRef<HTMLDivElement | null>(null)

  // 弹窗数据源：全部用户消息（不抽样）
  const historyItems = useMemo<HistoryItem[]>(() => {
    return filterUserMessages(messages).map((m) => ({
      id: m.info.id,
      time: m.info.time?.created ?? 0,
      preview: extractText(m, 200),
    }))
  }, [messages])

  // 锚点列表：抽样子集（保留首尾）
  const anchors = useMemo<Anchor[]>(() => {
    const userMsgs = filterUserMessages(messages)
    if (userMsgs.length === 0) return []
    const max = 30
    const sampled = userMsgs.length > max ? sampleItems(userMsgs, max) : userMsgs
    return sampled.map((m, idx) => ({
      id: m.info.id,
      // 单锚点放顶部（避免除以 0），多个时均匀分布在 4%~96%
      position: sampled.length === 1 ? 0.04 : 0.04 + (idx / (sampled.length - 1)) * 0.92,
      preview: extractText(m, 300),
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

  // 弹窗打开：列表滚到当前 active 项；Esc / 点击 rail 外关闭
  useEffect(() => {
    if (!historyOpen) return
    const active = historyListRef.current?.querySelector('.anchor-history-item.is-active')
    // jsdom 无 scrollIntoView，防御性判存在
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'center' })
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHistoryOpen(false)
    }
    const onMouseDown = (e: MouseEvent) => {
      if (railRef.current && !railRef.current.contains(e.target as Node)) setHistoryOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [historyOpen])

  // hover 500ms 后显示预览
  const handleMouseEnter = (id: string) => {
    hoverTimer.current = setTimeout(() => setHoverId(id), 500)
  }
  const handleMouseLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    setHoverId(null)
  }

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

  if (anchors.length === 0) return null

  return (
    <div className="messages-anchor-rail" ref={railRef}>
      {/* 轨道终点 = 历史入口节点（与圆点同族样式；hover 即时出 tooltip 补偿发现性）*/}
      <button
        type="button"
        className={`anchor-history-node${historyOpen ? ' is-open' : ''}`}
        aria-label={t('chat.anchorHistory.buttonAria')}
        aria-expanded={historyOpen}
        onMouseEnter={() => setNodeHover(true)}
        onMouseLeave={() => setNodeHover(false)}
        onClick={() => setHistoryOpen((v) => !v)}
      >
        {nodeHover && <div className="anchor-tooltip">{t('chat.anchorHistory.button')}</div>}
      </button>
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
      {historyOpen && (
        <div className="anchor-history-popover" role="dialog" aria-label={t('chat.anchorHistory.title')}>
          <div className="anchor-history-header">
            <span className="anchor-history-title">{t('chat.anchorHistory.title')}</span>
            <span className="anchor-history-count">{t('chat.anchorHistory.count', { count: historyItems.length })}</span>
            <button
              type="button"
              className="anchor-history-close"
              onClick={() => setHistoryOpen(false)}
              aria-label={t('chat.search.closeAria')}
            >
              <span className="codicon codicon-close" aria-hidden="true" />
            </button>
          </div>
          <div className="anchor-history-list" ref={historyListRef}>
            {historyItems.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                className={`anchor-history-item${activeId === item.id ? ' is-active' : ''}`}
                aria-label={t('chat.anchorHistory.jumpAria')}
                onClick={() => {
                  setHistoryOpen(false)
                  scrollToAnchor(item.id)
                }}
              >
                <span className="anchor-history-meta">
                  #{idx + 1}{item.time ? ` · ${formatMsgTime(item.time)}` : ''}
                </span>
                <span className="anchor-history-text">{item.preview || t('chat.anchorHistory.noText')}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
