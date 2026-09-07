/**
 * 锚点高亮的贴底接管（2026-09-07 真机反馈缺陷）
 *
 * 现象：滚动条滚到最底，高亮仍停在倒数第二个锚点。
 * 根因：高亮判定是「视口上部 32% 区域内 DOM 第一条」，末尾锚点消息
 * 短、整体位于视口下部，贴底时永远进不了判定区。
 * 修复语义：贴底（scrollHeight - scrollTop - clientHeight ≤ 2px）时
 * 直接点亮最后一个锚点——observer 回调与 scroll 监听共用判定（触发
 * 顺序无关），点击跳转锁定期内不接管。
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

function anchorNode(id: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-anchor-msg', id)
  containerRef.current.appendChild(el)
  return el
}

function fireObserver(target: Element) {
  const cb = observerCallbacks[observerCallbacks.length - 1]
  cb([{ target, isIntersecting: true }])
}

/** jsdom 无布局（尺寸恒 0 → 天然贴底），按场景显式设置 */
function setDims(scrollHeight: number, clientHeight: number, scrollTop: number) {
  const el = containerRef.current
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true })
}

beforeEach(() => {
  document.body.appendChild(containerRef.current)
  containerRef.current.scrollTo = vi.fn()
})
afterEach(() => {
  cleanup()
  containerRef.current.replaceChildren()
  containerRef.current.remove()
  observerCallbacks.length = 0
})

describe('锚点高亮贴底接管', () => {
  it('滚动事件贴底：最后一个锚点点亮；离开底部后 observer 恢复「区内第一条」语义', () => {
    const node1 = anchorNode('u1')
    const node3 = anchorNode('u3')
    const { container } = render(
      <MessageAnchorRail
        messages={[userMsg('u1', '问题一'), userMsg('u2', '问题二'), userMsg('u3', '问题三')]}
        containerRef={containerRef}
      />,
    )
    const dots = container.querySelectorAll<HTMLDivElement>('.messages-anchor-dot')
    expect(dots.length).toBe(3)

    // 贴底（差值 0 ≤ 2px）滚动：末尾锚点 u3 点亮（修复前停在 u2）
    setDims(1000, 500, 500)
    act(() => { containerRef.current.dispatchEvent(new Event('scroll')) })
    expect(dots[2].className).toContain('is-active')
    expect(dots[1].className).not.toContain('is-active')

    // 离开底部向上滚：observer 相交变化恢复「区内第一条」
    setDims(1000, 500, 200)
    act(() => { fireObserver(node1) })
    expect(dots[0].className).toContain('is-active')
    node1.remove(); node3.remove()
  })

  it('贴底瞬间无相交变化也生效（scroll 监听兜底 observer 的盲区）', () => {
    anchorNode('u1')
    anchorNode('u2')
    const { container } = render(
      <MessageAnchorRail
        messages={[userMsg('u1', '问题一'), userMsg('u2', '问题二')]}
        containerRef={containerRef}
      />,
    )
    const dots = container.querySelectorAll<HTMLDivElement>('.messages-anchor-dot')

    // 不派发 observer 回调，仅滚动贴底（拖滚动条/End 键路径）
    setDims(800, 400, 399) // 差值 1px ≤ 2px 容差
    act(() => { containerRef.current.dispatchEvent(new Event('scroll')) })
    expect(dots[1].className).toContain('is-active')
  })

  it('observer 回调先判贴底：贴底时相交变化也点亮最后一个（触发顺序无关）', () => {
    const node1 = anchorNode('u1')
    anchorNode('u2')
    const { container } = render(
      <MessageAnchorRail
        messages={[userMsg('u1', '问题一'), userMsg('u2', '问题二')]}
        containerRef={containerRef}
      />,
    )
    const dots = container.querySelectorAll<HTMLDivElement>('.messages-anchor-dot')

    setDims(1000, 500, 500)
    // 与 scroll 同帧先后触发的 observer 回调：贴底判定优先于区内第一条
    act(() => { fireObserver(node1) })
    expect(dots[1].className).toContain('is-active')
    node1.remove()
  })

  it('点击跳转锁定期内贴底不接管（点击目标语义优先）', () => {
    anchorNode('u1')
    anchorNode('u2')
    const { container } = render(
      <MessageAnchorRail
        messages={[userMsg('u1', '问题一'), userMsg('u2', '问题二')]}
        containerRef={containerRef}
      />,
    )
    const dots = container.querySelectorAll<HTMLDivElement>('.messages-anchor-dot')

    // 点击 u1 锁定高亮，随后滚动贴底（跳转钳制场景）：不抢高亮
    fireEvent.click(dots[0])
    setDims(600, 500, 100) // 差值 0 → 贴底
    act(() => { containerRef.current.dispatchEvent(new Event('scroll')) })
    expect(dots[0].className).toContain('is-active')
    expect(dots[1].className).not.toContain('is-active')
  })
})
