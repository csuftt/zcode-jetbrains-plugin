/**
 * 会话标题目录徽标双击定位（2026-11-12）：
 * 双击 ws-header-badge → sendToJava openFile(filePath=徽标目录)。Java 侧 openFile
 * 的目录路由 = ProjectView.select + expandPath（定位并展开）。jsdom 只验发报，
 * 项目树选中/展开真机项。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

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
import { useStore } from '@/store/useStore'
import { ChatHeader } from '@/components/ChatHeader'

const DIR = 'G:\\AI-Agent\\claude-done-work'

function renderHeader(wsBadge: { dir: string; isProject: boolean; colorIndex: number | null }) {
  return render(
    <ChatHeader
      currentView="chat"
      sessionTitle="新会话"
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
      wsBadge={wsBadge}
    />,
  )
}

describe('会话标题目录徽标双击定位', () => {
  beforeEach(() => {
    sentRequests.length = 0
    useStore.setState({ detachWindow: { detached: false, pinned: false } })
  })
  afterEach(() => cleanup())

  it('双击目录徽标发 openFile（Java 目录路由=Project View 定位并展开）', () => {
    const { container } = renderHeader({ dir: DIR, isProject: false, colorIndex: 1 })
    const badge = container.querySelector('.ws-header-badge') as HTMLElement
    expect(badge).toBeTruthy()
    fireEvent.doubleClick(badge)
    expect(sentRequests).toEqual([{ op: 'openFile', filePath: DIR }])
  })

  it('单击目录徽标不发报（动作只在双击）', () => {
    const { container } = renderHeader({ dir: DIR, isProject: false, colorIndex: 1 })
    fireEvent.click(container.querySelector('.ws-header-badge') as HTMLElement)
    expect(sentRequests).toHaveLength(0)
  })

  it('悬浮气泡两行：全路径 + 弱化双击提示（分行 DOM，可分别设字号/颜色）', () => {
    const { container } = renderHeader({ dir: DIR, isProject: false, colorIndex: 1 })
    const badge = container.querySelector('.ws-header-badge') as HTMLElement
    // 不再用 data-tooltip 伪元素（只能整段一个样式），避免双气泡
    expect(badge.getAttribute('data-tooltip')).toBeNull()
    expect(container.querySelector('.ws-header-badge__tip-path')?.textContent).toBe(DIR)
    const hint = container.querySelector('.ws-header-badge__tip-hint')?.textContent ?? ''
    expect(hint).toContain('双击可在项目视图中定位')
  })
})