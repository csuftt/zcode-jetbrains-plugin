/**
 * 会话弹窗置顶回归（调研 ⑧ 真机反馈 2026-11-11：尺寸/位置/默认置顶三件套）：
 *   1. store：detachWindowState 归约（推送/应答同形双源）、toggleDetachPin 发 op
 *   2. ChatHeader：仅 detached 渲染置顶按钮、钉住态样式类、点击发 toggleDetachPin
 * （几何=面板尺寸+主窗左上对齐在 Java Swing 侧，jsdom/单测不覆盖，真机项）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: () => () => {},
  onStreamEvent: () => () => {},
  onStreamBatch: () => () => {},
  sendToJava: (req: Record<string, unknown>) => {
    sentRequests.push(req)
  },
}))

import '@/i18n/config'
import { useStore, handleResponse } from '@/store/useStore'
import { ChatHeader } from '@/components/ChatHeader'

function renderHeader() {
  return render(
    <ChatHeader
      currentView="chat"
      sessionTitle="弹窗会话"
      onBack={() => {}}
      onNewSession={() => {}}
      onNewTab={() => {}}
      onOpenBrowser={() => {}}
      onOpenTrajectory={() => {}}
      onSearch={() => {}}
      onHistory={() => {}}
      onSettings={() => {}}
      onTitleChange={() => {}}
      onRegenerateTitle={() => {}}
      canRegenerateTitle={false}
      regeneratingTitle={false}
    />,
  )
}

describe('会话弹窗置顶（⑧）', () => {
  beforeEach(() => {
    sentRequests.length = 0
    useStore.setState({ detachWindow: { detached: false, pinned: false } })
  })
  afterEach(() => cleanup())

  it('handleResponse：detachWindowState 归约落 state（推送/应答同形）', () => {
    act(() => {
      handleResponse(
        { op: 'detachWindowState', detached: true, pinned: true } as never,
        useStore.setState,
        () => useStore.getState(),
      )
    })
    expect(useStore.getState().detachWindow).toEqual({ detached: true, pinned: true })
    act(() => {
      handleResponse(
        { op: 'detachWindowState', detached: false, pinned: false } as never,
        useStore.setState,
        () => useStore.getState(),
      )
    })
    expect(useStore.getState().detachWindow).toEqual({ detached: false, pinned: false })
  })

  it('主窗态不渲染置顶按钮（零噪音）', () => {
    renderHeader()
    expect(screen.queryByLabelText('窗口置顶')).toBeNull()
    expect(screen.queryByLabelText('取消置顶')).toBeNull()
  })

  it('弹窗态渲染置顶按钮，钉住态带高亮类与取消文案', () => {
    useStore.setState({ detachWindow: { detached: true, pinned: true } })
    renderHeader()
    const btn = screen.getByLabelText('取消置顶')
    expect(btn.className).toContain('icon-button--pinned')
  })

  it('弹窗未钉住态：文案「窗口置顶」、无高亮类', () => {
    useStore.setState({ detachWindow: { detached: true, pinned: false } })
    renderHeader()
    const btn = screen.getByLabelText('窗口置顶')
    expect(btn.className).not.toContain('icon-button--pinned')
  })

  it('点击置顶按钮发 toggleDetachPin（置顶权威在 Java，态经推送回流）', () => {
    useStore.setState({ detachWindow: { detached: true, pinned: true } })
    renderHeader()
    fireEvent.click(screen.getByLabelText('取消置顶'))
    expect(sentRequests.some((r) => r.op === 'toggleDetachPin')).toBe(true)
  })
})
