/**
 * 消息锚点导航（cc-gui MessageAnchorRail 移植）
 *
 * - user 消息生成圆点（位置 4%~92%，单条时固定在顶部；底部 8% 让位
 *   历史入口节点）；压缩摘要消息生成专属压缩徽章（实心强调色 +
 *   compress 图标，全保留不参与抽样）
 * - 两类节点按消息流顺序合并后统一均匀分布（压缩点在轨道上的相对
 *   位置与对话中一致）；合并列表为空才不渲染
 * - user 圆点 >30 条均匀抽样（保留首尾）
 * - IntersectionObserver 高亮当前（视口上 32% 区域第一条）；滚动贴底时
 *   例外接管点亮最后一个锚点（末尾锚点消息短、进不了判定区，否则
 *   高亮永远停在倒数第二个）
 * - 点击平滑滚动到目标（停在视口上 28% 处）
 * - hover 500ms 显示该消息前 300 字预览；压缩徽章 hover 即时显示
 *   「上下文已压缩」（无摘要内容，发现性优先对齐历史节点）
 * - 轨道终点是历史入口节点（与圆点同族）：点击弹窗列出全部用户消息
 *   与压缩点（不受 30 条抽样限制；压缩条目不占用户消息编号），
 *   点击条目跳转
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ZCodeMessage } from '@/types/messages'
import { isAgentNotification, isCompactSummaryMessage } from '@/utils/parseNotification'
import { ScrollJumpButton } from './ScrollJumpButton'
import '../styles/chat-view.less'

interface Props {
  messages: ZCodeMessage[]
  containerRef: React.RefObject<HTMLDivElement | null>
}

interface Anchor {
  id: string
  kind: 'user' | 'compact'
  position: number
  preview: string
}

interface HistoryItem {
  id: string
  kind: 'user' | 'compact'
  /** 用户消息序号（压缩条目不占编号，保持「第几条用户消息」语义）*/
  seq?: number
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
 *  role 也是 user 但走专属压缩徽章节点，不生成普通圆点）*/
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

/** 贴底判定容差（px）：平滑滚动/亚像素布局存在小数误差 */
const BOTTOM_EPSILON = 2

export function MessageAnchorRail({ messages, containerRef }: Props) {
  const { t } = useTranslation()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [nodeHover, setNodeHover] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const historyListRef = useRef<HTMLDivElement | null>(null)
  /** 点击跳转高亮锁：true 期间 observer 不更新 active（配合 suppressGen 代际防旧回调误释放）*/
  const suppressHighlightRef = useRef(false)
  const suppressGenRef = useRef(0)

  // 弹窗数据源：全部用户消息 + 压缩点（均不抽样），按消息流顺序排列；
  // 压缩条目文案渲染时按 kind 取固定词条（不进数据，避免 t 进 useMemo）
  const historyItems = useMemo<HistoryItem[]>(() => {
    let userSeq = 0
    return messages
      .filter((m) => m.info.role === 'user' && !isAgentNotification(m.info))
      .map((m) => {
        const compact = isCompactSummaryMessage(m.info)
        return {
          id: m.info.id,
          kind: compact ? ('compact' as const) : ('user' as const),
          seq: compact ? undefined : ++userSeq,
          time: m.info.time?.created ?? 0,
          preview: compact ? '' : extractText(m, 200),
        }
      })
  }, [messages])
  // 头部计数只数用户消息（压缩点是插入的导航标记，不改变「N 条」语义）
  const userTotal = useMemo(() => historyItems.filter((i) => i.kind === 'user').length, [historyItems])

  // 锚点列表：user 抽样子集（保留首尾）+ 压缩点全保留，按消息流顺序
  // 合并后统一均匀分布（4%~92%，尾端让位历史节点）
  const anchors = useMemo<Anchor[]>(() => {
    const userMsgs = filterUserMessages(messages)
    const hasCompact = messages.some((m) => isCompactSummaryMessage(m.info))
    if (userMsgs.length === 0 && !hasCompact) return []
    const max = 30
    const sampledUser = userMsgs.length > max ? sampleItems(userMsgs, max) : userMsgs
    const keepIds = new Set(sampledUser.map((m) => m.info.id))
    const seq = messages
      .filter((m) => keepIds.has(m.info.id) || isCompactSummaryMessage(m.info))
      .map((m) => ({ m, kind: isCompactSummaryMessage(m.info) ? ('compact' as const) : ('user' as const) }))
    return seq.map(({ m, kind }, idx) => ({
      id: m.info.id,
      kind,
      // 单锚点放顶部（避免除以 0），多个时均匀分布在 4%~92%
      position: seq.length === 1 ? 0.04 : 0.04 + (idx / (seq.length - 1)) * 0.88,
      preview: kind === 'compact' ? '' : extractText(m, 300),
    }))
  }, [messages])

  // 贴底接管：「视口上部 32% 第一条」语义在滚动贴底时失效——末尾锚点
  // 消息短、整体位于视口下部，永远进不了判定区，高亮停在倒数第二个
  // （真机实测：滚到底亮点不落到最后一个）。贴底时直接点亮最后一个
  // 锚点；observer 回调与 scroll 监听共用本判定（两处先判贴底，触发
  // 顺序无关都收敛同一结果）；点击跳转锁定期内不接管（点击目标语义优先）
  const highlightLastAnchorAtBottom = useCallback(() => {
    const last = anchors[anchors.length - 1]
    if (!last) return false
    const container = containerRef.current
    if (!container) return false
    if (container.scrollHeight - container.scrollTop - container.clientHeight > BOTTOM_EPSILON) return false
    setActiveId(last.id)
    return true
  }, [anchors, containerRef])

  // IntersectionObserver：视口上 32% 区域内的第一条设为 active（按 DOM 顺序）
  useEffect(() => {
    const container = containerRef.current
    if (!container || anchors.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        // 点击跳转的锁定期内不抢高亮（见 scrollToAnchor 的 suppress 说明）
        if (suppressHighlightRef.current) return
        // 贴底优先于「区内第一条」：末尾锚点可能永远进不了判定区
        if (highlightLastAnchorAtBottom()) return
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
  }, [anchors, containerRef, highlightLastAnchorAtBottom])

  // 贴底 scroll 监听（observer 的兜底）：observer 只在相交变化时回调，
  // 贴底瞬间若无新的相交变化（末尾锚点本就在判定区外）不会触发；
  // 滚轮/拖滚动条/End 键等一切贴底路径都经此落到最后一个锚点
  useEffect(() => {
    const container = containerRef.current
    if (!container || anchors.length === 0) return
    const onScroll = () => {
      if (!suppressHighlightRef.current) highlightLastAnchorAtBottom()
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [anchors, containerRef, highlightLastAnchorAtBottom])

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
  // 高亮锁定：跳转把目标停在 28% 而判定区是上部 32%，相邻锚点消息较短也落进
  // 判定区时，「区内 DOM 第一条」语义会把高亮抢给上一条（实测：点倒数第一个、
  // 亮点停在倒数第二个）——点击即点亮目标，抑制 observer 到滚动静止后再恢复；
  // 代际号让连续点击时只有最新一次的释放回调生效
  const scrollToAnchor = (id: string) => {
    const container = containerRef.current
    if (!container) return
    const node = container.querySelector(`[data-anchor-msg="${id}"]`) as HTMLElement | null
    if (!node) return
    const containerRect = container.getBoundingClientRect()
    const nodeRect = node.getBoundingClientRect()
    // node 顶部相对容器顶部的偏移 = 当前 scrollTop + 二者 rect 差
    const delta = nodeRect.top - containerRect.top
    setActiveId(id)
    suppressHighlightRef.current = true
    const gen = ++suppressGenRef.current
    container.scrollTo({
      top: container.scrollTop + delta - container.clientHeight * 0.28,
      behavior: 'smooth',
    })
    // 滚动静止（scrollend）后延时释放，吸收静止瞬间的最后一次相交回调；
    // 无 scrollend 的环境（jsdom/老内核）退化为定时兜底， wheel 打断 smooth
    // 也会触发 scrollend（滚动序列结束），2.5s 兜底仅防事件缺失
    const release = () => {
      if (gen !== suppressGenRef.current) return
      setTimeout(() => {
        if (gen === suppressGenRef.current) suppressHighlightRef.current = false
      }, 150)
    }
    if ('onscrollend' in container) {
      container.addEventListener('scrollend', release, { once: true })
      setTimeout(() => container.removeEventListener('scrollend', release), 2500)
    } else {
      setTimeout(release, 1200)
    }
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
        <span className="codicon codicon-layers" aria-hidden="true" />
        {nodeHover && <div className="anchor-tooltip">{t('chat.anchorHistory.button')}</div>}
      </button>
      <div className="messages-anchor-track" />
      {anchors.map((a) =>
        a.kind === 'compact' ? (
          <button
            key={a.id}
            type="button"
            className={`messages-anchor-compact${activeId === a.id ? ' is-active' : ''}`}
            style={{ top: `${a.position * 100}%` }}
            aria-label={t('chat.compaction.title')}
            /* hover 即时出 tooltip（不走圆点 500ms 延迟）：结构性事件发现性优先 */
            onMouseEnter={() => setHoverId(a.id)}
            onMouseLeave={handleMouseLeave}
            onClick={() => scrollToAnchor(a.id)}
          >
            <span className="codicon codicon-fold" aria-hidden="true" />
            {hoverId === a.id && <div className="anchor-tooltip">{t('chat.compaction.title')}</div>}
          </button>
        ) : (
          <div
            key={a.id}
            className={`messages-anchor-dot ${activeId === a.id ? ' is-active' : ''}`}
            style={{ top: `${a.position * 100}%` }}
            onMouseEnter={() => handleMouseEnter(a.id)}
            onMouseLeave={handleMouseLeave}
            onClick={() => scrollToAnchor(a.id)}
          >
            {hoverId === a.id && <div className="anchor-tooltip">{a.preview}</div>}
          </div>
        ),
      )}
      {historyOpen && (
        <div className="anchor-history-popover" role="dialog" aria-label={t('chat.anchorHistory.title')}>
          <div className="anchor-history-header">
            <span className="anchor-history-title">{t('chat.anchorHistory.title')}</span>
            <span className="anchor-history-count">{t('chat.anchorHistory.count', { count: userTotal })}</span>
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
            {historyItems.map((item) =>
              item.kind === 'compact' ? (
                <button
                  key={item.id}
                  type="button"
                  className={`anchor-history-item anchor-history-item--compact${activeId === item.id ? ' is-active' : ''}`}
                  aria-label={t('chat.compaction.title')}
                  onClick={() => {
                    setHistoryOpen(false)
                    scrollToAnchor(item.id)
                  }}
                >
                  <span className="anchor-history-meta">
                    <span className="codicon codicon-fold anchor-history-compact-icon" aria-hidden="true" />
                    {t('chat.compaction.title')}{item.time ? ` · ${formatMsgTime(item.time)}` : ''}
                  </span>
                </button>
              ) : (
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
                    #{item.seq}{item.time ? ` · ${formatMsgTime(item.time)}` : ''}
                  </span>
                  <span className="anchor-history-text">{item.preview || t('chat.anchorHistory.noText')}</span>
                </button>
              ),
            )}
          </div>
          {/* 滚动跳转按钮（↑置顶/↓置底，滚轮触发浮现，对齐主界面/子代理弹窗）*/}
          <ScrollJumpButton containerRef={historyListRef} />
        </div>
      )}
    </div>
  )
}
