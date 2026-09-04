/**
 * 锚点导航顶部历史按钮 + 全量用户消息弹窗
 *
 * - 按钮渲染在 rail 顶部；点击弹出列表
 * - 弹窗列出全部用户消息（不受锚点 30 条抽样限制）
 * - 点击列表项：关闭弹窗并滚动消息容器到目标
 * - Esc / 点击 rail 外部关闭；压缩摘要不进列表
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

/** 造 n 条用户消息（id 顺序编号）*/
function makeUserMsgs(n: number): ZCodeMessage[] {
  return Array.from({ length: n }, (_, i) => userMsg(`u${i + 1}`, `第${i + 1}条用户消息`))
}

beforeEach(() => {
  document.body.appendChild(containerRef.current)
  // scrollToAnchor 依赖容器 scrollTo（jsdom 未实现，挂 spy 断言调用）
  containerRef.current.scrollTo = vi.fn()
})
afterEach(() => { cleanup(); containerRef.current.remove() })

function renderRail(messages: ZCodeMessage[]) {
  return render(<MessageAnchorRail messages={messages} containerRef={containerRef} />)
}

describe('锚点历史按钮与弹窗', () => {
  it('有用户消息时渲染顶部历史按钮，无用户消息时整条 rail 不渲染', () => {
    const withUser = renderRail([userMsg('u1', '问题一')])
    expect(withUser.container.querySelector('.anchor-history-node')).not.toBeNull()
    cleanup()

    const empty = renderRail([{ info: { id: 'a1', sessionID: 's1', role: 'assistant', time: { created: 1 } }, parts: [{ type: 'text', text: '回答' }] }])
    expect(empty.container.querySelector('.anchor-history-rail')).toBeNull()
  })

  it('点击按钮弹出列表，显示全部用户消息（35 条 > 30 抽样上限，圆点 30 个而列表 35 条）', () => {
    const { container } = renderRail(makeUserMsgs(35))
    expect(container.querySelectorAll('.messages-anchor-dot').length).toBe(30)

    fireEvent.click(container.querySelector('.anchor-history-node')!)
    const items = container.querySelectorAll('.anchor-history-item')
    expect(items.length).toBe(35)
    // 首尾消息都在列表里（抽样只保证圆点首尾，列表是全量）
    expect(items[0].textContent).toContain('第1条用户消息')
    expect(items[34].textContent).toContain('第35条用户消息')
    // 头部计数
    expect(container.querySelector('.anchor-history-count')!.textContent).toContain('35')
  })

  it('圆点分布上限收到 92%（尾端让位底部历史节点）；弹窗内挂滚动跳转按钮', () => {
    const { container } = renderRail(makeUserMsgs(5))
    const dots = Array.from(container.querySelectorAll<HTMLDivElement>('.messages-anchor-dot'))
    const tops = dots.map((d) => parseFloat(d.style.top))
    expect(Math.min(...tops)).toBeCloseTo(4, 5)
    expect(Math.max(...tops)).toBeLessThanOrEqual(92)

    fireEvent.click(container.querySelector('.anchor-history-node')!)
    // 滚轮触发浮现的 ↑/↓ 跳转按钮常驻 DOM（is-visible 过渡显隐）
    expect(container.querySelectorAll('.scroll-control-button').length).toBeGreaterThanOrEqual(1)
  })

  it('压缩摘要消息不进弹窗列表', () => {
    const { container } = renderRail([userMsg('u1', '第一个问题'), compactSummaryMsg('c1'), userMsg('u2', '第二个问题')])
    fireEvent.click(container.querySelector('.anchor-history-node')!)
    const items = container.querySelectorAll('.anchor-history-item')
    expect(items.length).toBe(2)
    expect(container.textContent).not.toContain('压缩摘要')
  })

  it('点击列表项：弹窗关闭并滚动消息容器到目标', () => {
    // 容器内放跳转目标节点（scrollToAnchor 查询 data-anchor-msg）
    const target = document.createElement('div')
    target.setAttribute('data-anchor-msg', 'u2')
    containerRef.current.appendChild(target)

    const { container } = renderRail([userMsg('u1', '问题一'), userMsg('u2', '问题二')])
    fireEvent.click(container.querySelector('.anchor-history-node')!)
    fireEvent.click(container.querySelectorAll('.anchor-history-item')[1])

    expect(container.querySelector('.anchor-history-popover')).toBeNull()
    expect(containerRef.current.scrollTo).toHaveBeenCalled()
    target.remove()
  })

  it('Esc 与点击 rail 外部均关闭弹窗；再次点按钮可重新打开', () => {
    const { container } = renderRail([userMsg('u1', '问题一')])

    // Esc 关闭
    fireEvent.click(container.querySelector('.anchor-history-node')!)
    expect(container.querySelector('.anchor-history-popover')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector('.anchor-history-popover')).toBeNull()

    // 重新打开后点击外部关闭
    fireEvent.click(container.querySelector('.anchor-history-node')!)
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    fireEvent.mouseDown(outside)
    expect(container.querySelector('.anchor-history-popover')).toBeNull()
    outside.remove()

    // 按钮可再次打开（toggle 状态未卡死）
    fireEvent.click(container.querySelector('.anchor-history-node')!)
    expect(container.querySelector('.anchor-history-popover')).not.toBeNull()
  })
})
