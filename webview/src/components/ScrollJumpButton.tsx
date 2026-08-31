/**
 * 弹窗滚动跳转按钮（对齐主界面 ChatView ScrollControl 交互）：
 * 滚轮方向决定 ↑置顶/↓置底、停止滚动 1.5s 后淡出、回到底部或内容不满一屏隐藏。
 *
 * 原生事件监听滚动容器（调用方只传 containerRef，不动容器 JSX）；按钮复用
 * 主界面 scroll-control-button 全局类（ChatView 恒挂载，样式必在场），
 * absolute 定位要求弹窗容器有 position:relative。
 * onStickChange：用户上滑状态变化（scrolledUp=false=回底——调用方据此恢复
 * 自动跟滚，如子代理详情弹窗的内容指纹滚底）。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RefObject } from 'react'

const NEAR_BOTTOM_PX = 80
const HIDE_DELAY_MS = 1500
/** 上滑余震窗：滚轮上滑后的短窗内，scroll/wheel 的"还在底部附近"判定都不可信
 *  （起步第一格 scrollTop 离底 <80px、触摸板惯性有反向小事件）——既不恢复跟滚
 *  也不隐藏/切向刚显示的 ↑ 按钮 */
const UP_GHOST_MS = 600

export function ScrollJumpButton({
  containerRef,
  onStickChange,
}: {
  containerRef: RefObject<HTMLElement | null>
  onStickChange?: (scrolledUp: boolean) => void
}) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  const [direction, setDirection] = useState<'up' | 'down'>('down')
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 最近一次滚轮上滑时刻：其后的短窗口内 scroll 的"到底判定"不恢复自动跟滚——
  // 上滑断跟后流式置底/微小回弹引发的 scroll 会把跟滚立刻拉回（弹跳的另一半）
  const lastUpWheelAt = useRef(0)
  // 回调走 ref：effect 只按容器挂载一次，调用方内联回调变化不重挂监听
  const onStickChangeRef = useRef(onStickChange)
  onStickChangeRef.current = onStickChange

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const nearBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    const onScroll = () => {
      const nb = nearBottom()
      if (!(nb && Date.now() - lastUpWheelAt.current < UP_GHOST_MS)) {
        onStickChangeRef.current?.(!nb)
      }
      // 到底部（或内容不再溢出）即隐藏跳转按钮——上滑余震窗内除外：起步第一格
      // scroll 时离底仍 <80px（nb=true），会把刚显示的 ↑ 立即打掉（"↑ 出现即
      // 消失、要滚几格才稳定"的根因）；正常 1.5s 淡出定时器不受此影响
      if ((nb || el.scrollHeight <= el.clientHeight) && Date.now() - lastUpWheelAt.current >= UP_GHOST_MS) {
        setVisible(false)
      }
    }
    const onWheel = (e: WheelEvent) => {
      // 内容不满一屏不显示
      if (el.scrollHeight <= el.clientHeight) return
      if (e.deltaY < 0) {
        // 上滑：立即显示 ↑ 并断开调用方自动跟滚——滚轮意图先于 scroll 生效，
        // 否则高频流式置底会在 scroll 承认上滑前把用户反复拽回（弹跳）；
        // 从底部起步的第一格也要出按钮（wheel 先于 scroll，scrollTop 未更新，
        // 不能用 nearBottom 早退吞掉 ↑）
        lastUpWheelAt.current = Date.now()
        onStickChangeRef.current?.(true)
        if (hideTimer.current) clearTimeout(hideTimer.current)
        setDirection('up')
        setVisible(true)
        hideTimer.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS)
        return
      }
      if (e.deltaY > 0) {
        // 下滑：已在底部附近无意义（wheel 先于 scroll，scrollTop 未更新）——
        // 上滑余震窗内的惯性/微抖反向事件直接忽略（隐藏或切向 ↓ 都会打断刚显示的 ↑）
        if (nearBottom()) {
          if (Date.now() - lastUpWheelAt.current >= UP_GHOST_MS) setVisible(false)
          return
        }
        if (hideTimer.current) clearTimeout(hideTimer.current)
        setDirection('down')
        onStickChangeRef.current?.(!nearBottom())
        setVisible(true)
        hideTimer.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS)
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [containerRef])

  const handleClick = () => {
    const el = containerRef.current
    if (!el) return
    if (direction === 'up') {
      onStickChangeRef.current?.(true)
      el.scrollTo({ top: 0, behavior: 'smooth' })
    } else {
      onStickChangeRef.current?.(false)
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
    setVisible(false)
  }

  return (
    <button
      type="button"
      className={`scroll-control-button ${visible ? 'is-visible' : ''}`}
      title={direction === 'up' ? t('chat.scroll.backToTop') : t('chat.scroll.toBottom')}
      onClick={handleClick}
    >
      <span className={`codicon ${direction === 'up' ? 'codicon-arrow-up' : 'codicon-arrow-down'}`} />
    </button>
  )
}
