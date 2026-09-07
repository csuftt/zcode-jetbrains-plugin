/**
 * 锚点轨道的压缩点徽章（2026-09-07 需求：压缩上下文在轨道上显眼标识）
 *
 * - 压缩摘要消息（role=user + info.summary）生成专属压缩徽章节点
 *   （实心强调色 + compress 图标），不生成普通圆点
 *   （2026-08-31 缺陷当时的处理是直接排除、轨道无标识）
 * - 徽章与 user 圆点按消息流顺序合并分布，位置与对话相对位置一致
 * - 点击徽章跳转到压缩摘要卡（data-anchor-msg 落点）
 * - hover 即时 tooltip「上下文已压缩」（不走圆点 500ms 延迟）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

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

import '@/i18n/config'
import { MessageAnchorRail } from '@/components/MessageAnchorRail'
import type { ZCodeMessage } from '@/types/messages'

// jsdom 无 IntersectionObserver（组件在锚点≥1 时建 observer 做高亮）
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)

const containerRef = { current: document.createElement('div') }

function userMsg(id: string, text: string): ZCodeMessage {
  return { info: { id, sessionID: 's1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text }] }
}
function compactSummaryMsg(id: string): ZCodeMessage {
  return {
    info: { id, sessionID: 's1', role: 'user', time: { created: 2 }, summary: { title: 'Compact summary', body: '压缩摘要正文' } },
    parts: [{ type: 'text', text: '压缩摘要' }],
  } as never
}

beforeEach(() => {
  document.body.appendChild(containerRef.current)
  // scrollToAnchor 依赖容器 scrollTo（jsdom 未实现，挂 spy 断言调用）
  containerRef.current.scrollTo = vi.fn()
})
afterEach(() => { cleanup(); containerRef.current.remove() })

describe('锚点轨道压缩点徽章', () => {
  it('压缩消息生成专属徽章而非普通圆点，位置按消息流序落在两圆点之间', () => {
    const { container } = render(
      <MessageAnchorRail
        messages={[userMsg('u1', '第一个问题'), compactSummaryMsg('c1'), userMsg('u2', '第二个问题')]}
        containerRef={containerRef}
      />,
    )
    const dots = Array.from(container.querySelectorAll<HTMLDivElement>('.messages-anchor-dot'))
    const badges = Array.from(container.querySelectorAll<HTMLButtonElement>('.messages-anchor-compact'))
    expect(dots.length).toBe(2)
    expect(badges.length).toBe(1)

    // 三节点序列 [u1, c1, u2] → 均匀分布 4% / 48% / 92%（压缩在中间）
    const dotTops = dots.map((d) => parseFloat(d.style.top))
    const badgeTop = parseFloat(badges[0].style.top)
    expect(dotTops[0]).toBeCloseTo(4, 5)
    expect(dotTops[1]).toBeCloseTo(92, 5)
    expect(badgeTop).toBeCloseTo(48, 5)
  })

  it('仅剩压缩消息时轨道仍渲染（1 徽章 0 圆点，单节点固定顶部）', () => {
    const { container } = render(
      <MessageAnchorRail messages={[compactSummaryMsg('c1')]} containerRef={containerRef} />,
    )
    expect(container.querySelector('.messages-anchor-rail')).not.toBeNull()
    expect(container.querySelectorAll('.messages-anchor-compact').length).toBe(1)
    expect(container.querySelectorAll('.messages-anchor-dot').length).toBe(0)
    expect(parseFloat(container.querySelector<HTMLButtonElement>('.messages-anchor-compact')!.style.top)).toBeCloseTo(4, 5)
  })

  it('hover 即时显示「上下文已压缩」tooltip（无摘要正文泄漏）', () => {
    const { container } = render(
      <MessageAnchorRail messages={[userMsg('u1', '问题'), compactSummaryMsg('c1')]} containerRef={containerRef} />,
    )
    const badge = container.querySelector<HTMLButtonElement>('.messages-anchor-compact')!
    fireEvent.mouseEnter(badge)
    const tooltip = badge.querySelector('.anchor-tooltip')
    expect(tooltip).not.toBeNull()
    expect(tooltip!.textContent).toBe('上下文已压缩')
    expect(container.textContent).not.toContain('压缩摘要正文')
  })

  it('点击徽章滚动消息容器到压缩卡落点（data-anchor-msg）', () => {
    const target = document.createElement('div')
    target.setAttribute('data-anchor-msg', 'c1')
    containerRef.current.appendChild(target)

    const { container } = render(
      <MessageAnchorRail messages={[userMsg('u1', '问题'), compactSummaryMsg('c1')]} containerRef={containerRef} />,
    )
    fireEvent.click(container.querySelector<HTMLButtonElement>('.messages-anchor-compact')!)
    expect(containerRef.current.scrollTo).toHaveBeenCalled()
    target.remove()
  })
})
