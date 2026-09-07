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
  getWorkspacePath: () => 'G:\mock',
}))

import { MessageAnchorRail } from '@/components/MessageAnchorRail'
import type { ZCodeMessage } from '@/types/messages'

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)

const containerRef = { current: document.createElement('div') }
beforeEach(() => { document.body.appendChild(containerRef.current) })
afterEach(() => { cleanup(); containerRef.current.remove() })

// 模拟真实长会话：742 条消息，~74 条 user（>30 触发抽样），2 条真实形态压缩消息
function buildLarge(): ZCodeMessage[] {
  const msgs: ZCodeMessage[] = []
  let userIdx = 0
  for (let i = 0; i < 742; i++) {
    if (i === 376 || i === 738) {
      msgs.push({
        info: {
          id: `msg_compact_${i}`, sessionID: 's1', role: 'user',
          time: { created: 1788583442994 + i },
          summary: { title: 'Compact summary', body: 'Summary: ...', diffs: [] },
        } as never,
        parts: [{ type: 'text', text: '压缩摘要' }, { type: 'compaction', auto: false, trigger: 'manual' }],
      } as never)
      continue
    }
    if (i % 10 === 0) {
      userIdx++
      msgs.push({ info: { id: `msg_u_${userIdx}`, sessionID: 's1', role: 'user', time: { created: 1 + i } }, parts: [{ type: 'text', text: `用户消息${userIdx}` }] })
    } else {
      msgs.push({ info: { id: `msg_a_${i}`, sessionID: 's1', role: 'assistant', time: { created: 1 + i } }, parts: [{ type: 'text', text: '回答' }] })
    }
  }
  return msgs
}

describe('长会话（>30 抽样 + 压缩点全保留）', () => {
  it('压缩徽章在抽样路径下仍然生成（2 个），位置合法', () => {
    const { container } = render(<MessageAnchorRail messages={buildLarge()} containerRef={containerRef} />)
    const dots = container.querySelectorAll('.messages-anchor-dot')
    const badges = Array.from(container.querySelectorAll('.messages-anchor-compact'))
    console.log('dots:', dots.length, 'badges:', badges.length)
    badges.forEach((b) => console.log('badge top:', b.style.top))
    expect(badges.length).toBe(2)
    const tops = badges.map((b) => parseFloat(b.style.top))
    tops.forEach((t) => { expect(t).toBeGreaterThanOrEqual(4); expect(t).toBeLessThanOrEqual(92) })
    // 弹窗数据源（历史条目）也应含 2 条压缩
    expect(dots.length).toBe(30)
  })
})
