/**
 * 划词引用浮条复现测试（真机反馈「浮条不出现」2026-11-11）：
 * jsdom 模拟 mouseup→rAF→evaluate 全链，逐关断言找出断点。
 * rect 全 0 的 hasLayout 拦截在 jsdom 下天然触发，mock 掉以隔离布局因素。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import React, { useEffect, useRef, useState } from 'react'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import { useConversationSelections } from '@/hooks/useConversationSelections'

function Host({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const bar = useConversationSelections({ containerRef: ref, enabled })
  return (
    <>
      <div ref={ref} className="messages-container">
        <div data-selection-id="m1-0" data-selection-type="assistant">
          被划选的正文内容
        </div>
      </div>
      {bar}
    </>
  )
}

function selectText(container: HTMLElement, el: HTMLElement): Selection {
  const sel = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(el)
  sel.removeAllRanges()
  sel.addRange(range)
  // jsdom 的 getBoundingClientRect 恒 0：mock 到容器坐标（隔离 hasLayout 因素）
  const raf = Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }
  raf.getBoundingClientRect = () =>
    ({ left: 100, top: 100, width: 200, height: 20, right: 300, bottom: 120, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect
  return sel
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  window.getSelection()?.removeAllRanges()
})

describe('划词浮条复现（真机不出浮条定位）', () => {
  it('渲染容器+划选+mouseup → 浮条出现', () => {
    const { container } = render(<Host />)
    const target = container.querySelector('[data-selection-id]')!
    selectText(container, target)
    expect(window.getSelection()!.isCollapsed).toBe(false)

    fireEvent.mouseUp(container.querySelector('.messages-container')!)
    // rAF：fake timers 下手动 flush
    act(() => {
      vi.runAllTicks()
      // jsdom rAF 走 setTimeout(16ms) 模拟
      vi.advanceTimersByTime(50)
    })
    expect(document.querySelector('.convsel-bar')).not.toBeNull()
  })

  it('真机时序复现：容器延迟挂载（首帧 loading 分支无容器）浮条仍出现', () => {
    // 真机根因（2026-11-11 实锤）：ChatView loading/空会话分支提前 return，
    // 首帧 ref.current=null → 旧实现 effect 直接不挂监听且永不重跑。
    // 修复后监听挂 document，容器何时出现都免疫。
    function DeferredHost() {
      const [mounted, setMounted] = useState(false)
      useEffect(() => {
        const t = setTimeout(() => setMounted(true), 30)
        return () => clearTimeout(t)
      }, [])
      return mounted ? <Host /> : <div className="messages-shell">loading 占位</div>
    }
    const { container } = render(<DeferredHost />)
    // 首帧：容器不在 DOM
    expect(container.querySelector('.messages-container')).toBeNull()
    act(() => vi.advanceTimersByTime(60))
    expect(container.querySelector('.messages-container')).not.toBeNull()

    const target = container.querySelector('[data-selection-id]')!
    selectText(container, target)
    fireEvent.mouseUp(container.querySelector('.messages-container')!)
    act(() => vi.advanceTimersByTime(50))
    expect(document.querySelector('.convsel-bar')).not.toBeNull()
  })

  it('非 collapsed 的 selectionchange 不收起浮条', () => {
    const { container } = render(<Host />)
    const target = container.querySelector('[data-selection-id]')!
    selectText(container, target)
    fireEvent.mouseUp(container.querySelector('.messages-container')!)
    act(() => vi.advanceTimersByTime(50))
    expect(document.querySelector('.convsel-bar')).not.toBeNull()
    // selectionchange 且非折叠：浮条保留
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(document.querySelector('.convsel-bar')).not.toBeNull()
  })
})
