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

import { useEffect, useRef, useState } from 'react'
import type { ZCodeMessage } from '@/types/messages'
import { MessageBubble } from './MessageBubble'
import { WaitingIndicator } from './WaitingIndicator'
import { WelcomeScreen } from './WelcomeScreen'
import { MessageAnchorRail } from './MessageAnchorRail'
import { ConversationSearch } from './ConversationSearch'
import { isAgentNotification } from '@/utils/parseNotification'
import '../styles/chat-view.less'

interface Props {
  messages: ZCodeMessage[]
  loading: boolean
  waiting: boolean
  waitingSince?: number
  streamingMessageId?: string | null
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

export function ChatView({ messages, loading, waiting, waitingSince, streamingMessageId, searchOpen, onSearchClose }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)
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
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    userScrolledUp.current = !nearBottom
    // cc-gui checkScrollPosition：到底部（或内容不再溢出）即隐藏跳转按钮
    if (nearBottom || el.scrollHeight <= el.clientHeight) {
      setScrollBtnVisible(false)
    }
  }

  // 滚轮方向决定按钮箭头：deltaY>0 下滑→↓置底，deltaY<0 上滑→↑置顶（cc-gui handleWheel）
  const handleWheel = (e: React.WheelEvent) => {
    const el = containerRef.current
    if (!el) return
    // 内容不满一屏，不显示
    if (el.scrollHeight <= el.clientHeight) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // 已在底部附近，不显示（wheel 先于 scroll 触发，此时 scrollTop 还未更新）
    if (distanceFromBottom < 80) {
      setScrollBtnVisible(false)
      return
    }
    if (scrollHideTimer.current) clearTimeout(scrollHideTimer.current)
    if (e.deltaY > 0) {
      setScrollBtnDirection('down')
    } else if (e.deltaY < 0) {
      setScrollBtnDirection('up')
    }
    setScrollBtnVisible(true)
    scrollHideTimer.current = setTimeout(() => setScrollBtnVisible(false), 1500)
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
          加载消息中…
        </div>
      </div>
    )
  }

  if (messages.length === 0 && !waiting) {
    return (
      <div className="messages-shell">
        <WelcomeScreen />
      </div>
    )
  }

  return (
    <div className="messages-shell">
      <MessageAnchorRail messages={messages} containerRef={containerRef} />
      {/* 会话内搜索浮层（消息变化即重扫：fingerprint 覆盖流式追加与切会话重拉）*/}
      <ConversationSearch
        open={!!searchOpen}
        onClose={() => onSearchClose?.()}
        containerRef={containerRef}
        messagesSignal={`${fingerprint}|${streamingMessageId ?? ''}`}
      />
      <div className="messages-container" ref={containerRef} onScroll={handleScroll} onWheel={handleWheel}>
        <div className="chat-view__inner">
          {messages.map((m) => (
            <MessageBubble
              key={m.info.id}
              message={m}
              streaming={m.info.id === streamingMessageId}
              anchorAttr={m.info.role === 'user' && !isAgentNotification(m.info) ? m.info.id : undefined}
            />
          ))}
          {waiting && <WaitingIndicator since={waitingSince} />}
          <div ref={bottomRef} />
        </div>
      </div>
      {/* 滚动跳转按钮（常驻 DOM + is-visible 过渡显隐，避免条件渲染时动画丢失）*/}
      <button
        type="button"
        className={`scroll-control-button ${scrollBtnVisible ? 'is-visible' : ''}`}
        title={scrollBtnDirection === 'up' ? '回到顶部' : '跳到底部'}
        onClick={handleJumpClick}
      >
        <span className={`codicon ${scrollBtnDirection === 'up' ? 'codicon-arrow-up' : 'codicon-arrow-down'}`} />
      </button>
    </div>
  )
}
