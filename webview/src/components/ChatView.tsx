/**
 * 聊天视图：消息列表容器（cc-gui ChatScreen 简化版）
 *
 * - 滚动展示所有消息（自动滚底，用户上滚不强制）
 * - 无消息时显示 WelcomeScreen
 * - 左侧 MessageAnchorRail 锚点导航
 * - 右上角 ConversationSearch 会话内搜索浮层
 * - 右下滚动跳转按钮（cc-gui ScrollControl）：滚轮上滑显示↑置顶、下滑显示↓置底，
 *   停止滚动 1.5s 后淡出，回到底部或内容不满一屏时隐藏
 * - 停止生成按钮已移到输入框（发送/停止互斥）
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ZCodeMessage } from '@/types/messages'
import { MessageBubble } from './MessageBubble'
import { WaitingIndicator } from './WaitingIndicator'
import { WelcomeScreen } from './WelcomeScreen'
import { MessageAnchorRail } from './MessageAnchorRail'
import { ConversationSearch } from './ConversationSearch'
import { GoalCard } from './GoalCard'
import { NEAR_BOTTOM_PX, HIDE_DELAY_MS, UP_GHOST_MS } from './ScrollJumpButton'
import { isAgentNotification } from '@/utils/parseNotification'
import { useStore } from '@/store/useStore'
import { findEditableUserMessage } from '@/utils/editHistory'
import '../styles/chat-view.less'
import '../styles/compaction.less'

interface Props {
  messages: ZCodeMessage[]
  loading: boolean
  waiting: boolean
  waitingSince?: number
  streamingMessageId?: string | null
  /** 上下文压缩回合进行中（/compact 或 autocompact）：显示压缩状态条，隐藏等待转圈 */
  compacting?: boolean
  /** 会话内搜索面板开关（App 级状态，Ctrl+F / Header 搜索按钮触发）*/
  searchOpen?: boolean
  /** 关闭搜索面板 */
  onSearchClose?: () => void
}

/** 计算最后一条消息的内容指纹（流式增长时变化 → 触发滚动）*/
function lastMessageFingerprint(messages: ZCodeMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last) return ''
  // 拼接所有 part 的长度（text/reasoning 的内容增长会改变指纹）
  return last.parts.map((p) => {
    if (p.type === 'text') return `t${p.text.length}`
    if (p.type === 'reasoning') return `r${p.text.length}`
    if (p.type === 'tool') return `o${p.callID}${p.state.status}`
    return p.type
  }).join(',') + '#' + messages.length
}

export function ChatView({ messages, loading, waiting, waitingSince, streamingMessageId, compacting, searchOpen, onSearchClose }: Props) {
  const { t } = useTranslation()
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)
  const streaming = useStore((s) => s.streaming)
  const queuedCount = useStore((s) => s.queuedMessages.length)
  const editReplay = useStore((s) => s.editReplay)
  // 编辑按钮仅出现在最后一轮可编辑用户消息上（官方 Edit History 语义），
  // 且仅在空闲态（无回合/无排队/非编辑重放）开放——rewind 与活动回合互斥
  const editableMsgId = useMemo(
    () => (!streaming && queuedCount === 0 && !editReplay
      ? findEditableUserMessage(messages)?.info.id ?? null
      : null),
    [messages, streaming, queuedCount, editReplay],
  )
  // 最近一次滚轮上滑时刻：其后的短窗口内 scroll 的"到底判定"不恢复自动跟滚——
  // 上滑断跟后流式置底/微小回弹引发的 scroll 会把跟滚立刻拉回（上滑弹跳根因）
  const lastUpWheelAt = useRef(0)
  const prevLastId = useRef<string | undefined>(undefined)
  const fingerprint = lastMessageFingerprint(messages)
  // 滚动跳转按钮（cc-gui ScrollControl）：单个按钮，方向跟随用户滚轮方向，
  // 停止滚动 1.5s 后淡出；回到底部或内容不满一屏时立即隐藏
  const [scrollBtnVisible, setScrollBtnVisible] = useState(false)
  const [scrollBtnDirection, setScrollBtnDirection] = useState<'up' | 'down'>('down')
  const scrollHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 卸载时清理隐藏定时器
  useEffect(() => () => {
    if (scrollHideTimer.current) clearTimeout(scrollHideTimer.current)
  }, [])

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    // 上滑后的短窗内不因"到底判定"恢复跟滚（流式置底/微小回弹会立刻拉回用户）
    if (!(nearBottom && Date.now() - lastUpWheelAt.current < UP_GHOST_MS)) {
      userScrolledUp.current = !nearBottom
    }
    // cc-gui checkScrollPosition：到底部（或内容不再溢出）即隐藏跳转按钮——
    // 上滑余震窗内除外：起步第一格 scroll 离底仍 <80px，会立即打掉刚显示的 ↑
    if ((nearBottom || el.scrollHeight <= el.clientHeight) && Date.now() - lastUpWheelAt.current >= UP_GHOST_MS) {
      setScrollBtnVisible(false)
    }
  }

  // 滚轮方向决定按钮箭头：deltaY>0 下滑→↓置底，deltaY<0 上滑→↑置顶（cc-gui handleWheel）。
  // 上滑必须立即断开自动跟滚并显示 ↑——滚轮意图先于 scroll 生效，等 scroll 承认
  // 会被高频流式置底反复拽回（弹跳）；从底部起步的第一格也要出 ↑（wheel 先于
  // scroll，scrollTop 未更新，不能被 nearBottom 早退吞掉）
  const handleWheel = (e: React.WheelEvent) => {
    const el = containerRef.current
    if (!el) return
    // 内容不满一屏，不显示
    if (el.scrollHeight <= el.clientHeight) return
    if (e.deltaY < 0) {
      lastUpWheelAt.current = Date.now()
      userScrolledUp.current = true
      if (scrollHideTimer.current) clearTimeout(scrollHideTimer.current)
      setScrollBtnDirection('up')
      setScrollBtnVisible(true)
      scrollHideTimer.current = setTimeout(() => setScrollBtnVisible(false), HIDE_DELAY_MS)
      return
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // 已在底部附近，下滑无意义不显示（wheel 先于 scroll 触发，此时 scrollTop 还未更新）；
    // 上滑余震窗内的惯性/微抖反向事件直接忽略（隐藏或切向 ↓ 都会打断刚显示的 ↑）
    if (e.deltaY > 0 && distanceFromBottom < NEAR_BOTTOM_PX) {
      if (Date.now() - lastUpWheelAt.current >= UP_GHOST_MS) setScrollBtnVisible(false)
      return
    }
    if (e.deltaY > 0) {
      if (scrollHideTimer.current) clearTimeout(scrollHideTimer.current)
      setScrollBtnDirection('down')
      setScrollBtnVisible(true)
      scrollHideTimer.current = setTimeout(() => setScrollBtnVisible(false), HIDE_DELAY_MS)
    }
  }

  // 消息变化（含流式内容增长）+ 新消息 + waiting 变化时滚动
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const last = messages[messages.length - 1]
    // 用户刚发送消息（末尾新增真实 user 消息）→ 强制滚到底，并重置上滑标志，
    // 让后续流式回复自动跟滚（即使发送前用户上滑阅读过历史）
    const userJustSent =
      !!last &&
      last.info.role === 'user' &&
      !isAgentNotification(last.info) &&
      last.info.id !== prevLastId.current
    if (last) prevLastId.current = last.info.id
    if (userJustSent) userScrolledUp.current = false
    if (userJustSent || !userScrolledUp.current) {
      // 直接设 scrollTop（比 scrollIntoView 更可靠，不依赖布局完成）
      el.scrollTop = el.scrollHeight
    }
  }, [fingerprint, waiting])

  // 点击跳转：up 置顶（停止流式自动跟滚）/ down 置底（恢复跟滚），点击后按钮隐藏（cc-gui handleClick）
  const handleJumpClick = () => {
    const el = containerRef.current
    if (!el) return
    if (scrollBtnDirection === 'up') {
      userScrolledUp.current = true
      el.scrollTo({ top: 0, behavior: 'smooth' })
    } else {
      userScrolledUp.current = false
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
    setScrollBtnVisible(false)
  }

  if (loading) {
    return (
      <div className="messages-shell">
        <div className="chat-view__loading">
          <span className="chat-view__loading-dots"><span /><span /><span /></span>
          {t('chat.loading')}
        </div>
      </div>
    )
  }

  if (messages.length === 0 && !waiting) {
    return (
      <div className="messages-shell">
        {/* 目标模式状态卡（悬浮容器组件自带：折叠/拖动/搜索避让；无目标不渲染）*/}
        <GoalCard belowSearch={searchOpen} />
        <WelcomeScreen />
      </div>
    )
  }

  return (
    <div className="messages-shell">
      <MessageAnchorRail messages={messages} containerRef={containerRef} />
      {/* 目标模式状态卡（悬浮容器组件自带：折叠/拖动/搜索避让）*/}
      <GoalCard belowSearch={searchOpen} />
      {/* 会话内搜索浮层（消息变化即重扫：fingerprint 覆盖流式追加与切会话重拉）*/}
      <ConversationSearch
        open={!!searchOpen}
        onClose={() => onSearchClose?.()}
        containerRef={containerRef}
        messagesSignal={`${fingerprint}|${streamingMessageId ?? ''}`}
      />
      <div className="messages-container" ref={containerRef} onScroll={handleScroll} onWheel={handleWheel}>
        <div className="chat-view__inner">
          {messages.map((m) => {
            // autocompant 场景：turn.started 已建流式消息、usage 轮询才发现压缩——
            // 压缩期间该消息零 delta，跳过渲染避免空壳气泡（数据保留，回合结束重拉权威修复）
            if (compacting && m.info.id === streamingMessageId
              && !m.parts.some((p) => p.type === 'text' || p.type === 'reasoning' || p.type === 'tool')) {
              return null
            }
            return (
              <MessageBubble
                key={m.info.id}
                message={m}
                streaming={m.info.id === streamingMessageId}
                anchorAttr={m.info.role === 'user' && !isAgentNotification(m.info) ? m.info.id : undefined}
                searchActive={!!searchOpen}
                editable={m.info.id === editableMsgId}
              />
            )
          })}
          {/* 压缩状态条与等待转圈互斥：摘要生成期间（事件静默 63s+）明确告知在压缩 */}
          {compacting ? (
            <div className="compacting-indicator">
              <span className="compacting-indicator__spin" />
              {t('chat.compaction.compressing')}
            </div>
          ) : editReplay ? (
            // 编辑重放：rewind turn（不渲染命令轮）→ 快照落地 → 重发新文本，
            // 期间等待指示用编辑专属文案（与普通等待转圈区分）
            <div className="compacting-indicator">
              <span className="compacting-indicator__spin" />
              {t('chat.edit.replaying')}
            </div>
          ) : (
            <>
              {waiting && <WaitingIndicator since={waitingSince} />}
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      {/* 滚动跳转按钮（常驻 DOM + is-visible 过渡显隐，避免条件渲染时动画丢失）*/}
      <button
        type="button"
        className={`scroll-control-button ${scrollBtnVisible ? 'is-visible' : ''}`}
        title={scrollBtnDirection === 'up' ? t('chat.scroll.backToTop') : t('chat.scroll.toBottom')}
        onClick={handleJumpClick}
      >
        <span className={`codicon ${scrollBtnDirection === 'up' ? 'codicon-arrow-up' : 'codicon-arrow-down'}`} />
      </button>
    </div>
  )
}
