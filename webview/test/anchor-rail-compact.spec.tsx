/**
 * 锚点导航对压缩摘要消息的排除（2026-08-31 用户实测缺陷）
 *
 * 现象：压缩上下文的摘要消息（role=user + info.summary）被生成为左侧锚点圆点，
 * 但它渲染走 CompactionSummaryCard、不挂 data-anchor-msg，点击无法跳转。
 * 期望：摘要消息不进锚点列表；真实 user 消息不受影响。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

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

beforeEach(() => { document.body.appendChild(containerRef.current) })
afterEach(() => { cleanup(); containerRef.current.remove() })

describe('锚点导航排除压缩摘要消息', () => {
  it('compact summary 消息不生成锚点圆点，真实 user 消息正常生成', () => {
    const { container } = render(
      <MessageAnchorRail
        messages={[userMsg('u1', '第一个问题'), compactSummaryMsg('c1'), userMsg('u2', '第二个问题')]}
        containerRef={containerRef}
      />,
    )
    const dots = container.querySelectorAll('.messages-anchor-dot')
    expect(dots.length).toBe(2)
    // 预览文本只在 hover 后渲染（500ms 延迟），初始 DOM 无摘要泄漏可断言：圆点数即覆盖
  })

  it('仅剩摘要消息时不渲染锚点栏', () => {
    const { container } = render(
      <MessageAnchorRail messages={[compactSummaryMsg('c1')]} containerRef={containerRef} />,
    )
    expect(container.querySelector('.messages-anchor-rail')).toBeNull()
  })
})
