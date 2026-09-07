/**
 * 锚点点击跳转的高亮锁定（2026-09-07 真机反馈缺陷）
 *
 * 现象：点击倒数第一个锚点，高亮亮点停在倒数第二个（相邻锚点消息
 * 都落在 observer 的上部 32% 判定区，「区内 DOM 第一条」语义把高亮
 * 抢给上一条）。
 * 修复语义：点击即点亮目标；锁定期内 observer 回调被抑制；滚动静止
 * 后延时释放恢复观察；连续点击只有最新代际的释放回调生效。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: vi.fn(),
  onStreamBatch: () => () => {},
  onStreamEvent: () => () => {},
  onMessage: () => () => {},
  onDiagLog: () => () => {},
  getDiagLog: () => [],
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
}))

import { MessageAnchorRail } from '@/components/MessageAnchorRail'
import type { ZCodeMessage } from '@/types/messages'

// 收集 observer 回调（测试里手动模拟滚动途中的相交变化）
const observerCallbacks: Array<(entries: Array<{ target: Element; isIntersecting: boolean }>) => void> = []
class IntersectionObserverStub {
  constructor(cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
    observerCallbacks.push(cb)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)

const containerRef = { current: document.createElement('div') }

function userMsg(id: string, text: string): ZCodeMessage {
  return { info: { id, sessionID: 's1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text }] }
}

/** 容器里放跳转目标节点（scrollToAnchor 查询 data-anchor-msg）*/
function anchorNode(id: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-anchor-msg', id)
  containerRef.current.appendChild(el)
  return el
}

/** 模拟 observer 回调：某目标进入判定区 */
function fireObserver(target: Element) {
  const cb = observerCallbacks[observerCallbacks.length - 1]
  cb([{ target, isIntersecting: true }])
}

/** 模拟滚动静止（scrollTo 是 mock 不会真滚，手动派发 scrollend；
 *  jsdom 29 与 JCEF 均支持 onscrollend，组件走 scrollend 释放路径）*/
function fireScrollEnd() {
  containerRef.current.dispatchEvent(new Event('scrollend'))
}

/** jsdom 无布局（scrollHeight/clientHeight 恒 0 → 天然「贴底」），
 *  断言非贴底路径前显式设尺寸；own property 会跨用例残留，逐用例覆盖 */
function setDims(scrollHeight: number, clientHeight: number, scrollTop: number) {
  const el = containerRef.current
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true })
}

beforeEach(() => {
  document.body.appendChild(containerRef.current)
  containerRef.current.scrollTo = vi.fn()
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  containerRef.current.replaceChildren()
  containerRef.current.remove()
  observerCallbacks.length = 0
  vi.useRealTimers()
})

describe('锚点点击跳转高亮锁定', () => {
  it('点击圆点立即点亮目标，锁定期内 observer 相交回调不抢高亮，释放后恢复', () => {
    const node1 = anchorNode('u1')
    const node2 = anchorNode('u2')
    const { container } = render(
      <MessageAnchorRail
        messages={[userMsg('u1', '问题一'), userMsg('u2', '问题二')]}
        containerRef={containerRef}
      />,
    )
    const dots = container.querySelectorAll<HTMLDivElement>('.messages-anchor-dot')
    expect(dots.length).toBe(2)

    // 点击第二个圆点：立即点亮
    fireEvent.click(dots[1])
    expect(dots[1].className).toContain('is-active')
    expect(dots[0].className).not.toContain('is-active')

    // 非贴底（贴底时贴底规则会点亮最后一个锚点，见 anchor-bottom-active.spec）
    setDims(1000, 500, 100)

    // 滚动途中 u1 相交变化（正是真机缺陷场景：上一条抢高亮）——被锁抑制
    act(() => { fireObserver(node1) })
    expect(dots[1].className).toContain('is-active')
    expect(dots[0].className).not.toContain('is-active')

    // 滚动静止（scrollend）后 150ms 释放延时窗口内，迟到的相交回调仍被吸收
    // （真实环境 scrollend 触发时 observer 可能还有一帧未派发）
    act(() => { fireScrollEnd() })
    act(() => { fireObserver(node1) })
    expect(dots[1].className).toContain('is-active')
    act(() => { vi.advanceTimersByTime(200) })
    // 释放后 observer 恢复：u1 相交变化正常接管高亮
    act(() => { fireObserver(node1) })
    expect(dots[0].className).toContain('is-active')
    expect(dots[1].className).not.toContain('is-active')
    node1.remove(); node2.remove()
  })

  it('连续点击两次：第一次的释放回调被代际作废，不提前解锁', () => {
    const node1 = anchorNode('u1')
    const node2 = anchorNode('u2')
    const { container } = render(
      <MessageAnchorRail
        messages={[userMsg('u1', '问题一'), userMsg('u2', '问题二')]}
        containerRef={containerRef}
      />,
    )
    const dots = container.querySelectorAll<HTMLDivElement>('.messages-anchor-dot')

    // 非贴底（隔离用例 1 残留的 own property 尺寸）
    setDims(1000, 500, 100)

    // 第一次点击 u1：滚动静止 → release 排下 150ms 释放延时
    fireEvent.click(dots[0])
    act(() => { fireScrollEnd() })

    // 延时触发前第二次点击 u2：代际 +1，第一次的释放链全部作废
    fireEvent.click(dots[1])
    expect(dots[1].className).toContain('is-active')
    act(() => { vi.advanceTimersByTime(300) })
    // 第一次的 150ms 释放延时已触发——代际不符，不解锁
    act(() => { fireObserver(node1) })
    expect(dots[1].className).toContain('is-active')
    expect(dots[0].className).not.toContain('is-active')
    node1.remove(); node2.remove()
  })
})
