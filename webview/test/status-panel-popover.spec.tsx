/**
 * 状态面板弹窗定位与让位回归
 *
 * - 弹窗锚定整行面板：任务/子代理统一靠面板左缘，文件靠面板右缘；窄视口 8px 收敛
 * - 点击子代理行打开大弹窗后浮层保留（modal 遮罩内点击/Esc 不关闭），方便连续查看
 * - Esc / 点击面板外其他区域关闭
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
  getTabWorkspacePath: () => '',
}))

import '@/i18n/config'
import { StatusPanel } from '@/components/StatusPanel'
import { useStore } from '@/store/useStore'

/** 给面板行设定几何（全宽 900px 视口，rect 0..900） */
function stubLayout(viewportWidth = 900) {
  window.innerWidth = viewportWidth
  const panel = document.querySelector('.status-panel') as HTMLElement | null
  if (!panel) throw new Error('panel not mounted')
  panel.getBoundingClientRect = () => new DOMRect(0, 600, viewportWidth, 30)
}

function open(tabIndex: number) {
  const { container } = render(<StatusPanel />)
  stubLayout()
  fireEvent.click(container.querySelectorAll('.status-panel-tab')[tabIndex])
  return document.getElementById('status-panel-popover-fixed') as HTMLElement
}

beforeEach(() => {
  useStore.setState({
    todos: [{ content: '任务1', status: 'in_progress' } as never],
    agents: [{ callID: 'a1', description: '子代理1', status: 'running' } as never],
    fileChanges: [{ filePath: 'a.ts', fileName: 'a.ts', additions: 1, deletions: 0 } as never],
    statusPanelCollapsed: false,
  })
})
afterEach(() => {
  cleanup()
  // 用例手工挂到 body 的 modal 遮罩统一摘除，避免污染后续用例的"无大弹窗"前提
  document.querySelectorAll('.modal-overlay').forEach((n) => n.remove())
  vi.restoreAllMocks()
})

describe('StatusPanel 弹窗定位', () => {
  it('任务 tab 弹窗靠面板左缘（8px 边距收敛）', () => {
    const popover = open(0)
    expect(popover.style.left).toBe('8px')
  })

  it('子代理 tab 弹窗与任务同位（靠面板左缘）', () => {
    const popover = open(1)
    expect(popover.style.left).toBe('8px')
  })

  it('文件 tab 弹窗右缘对齐面板右缘（右缘 8px 边距收敛）', () => {
    const popover = open(2)
    // 面板右缘 900 → 弹窗左 540，再被右缘 8px 边距收敛到 532
    expect(popover.style.left).toBe('532px')
  })

  it('窄视口收敛到 8px 不出屏', () => {
    const { container } = render(<StatusPanel />)
    stubLayout(200)
    fireEvent.click(container.querySelectorAll('.status-panel-tab')[2])
    const popover = document.getElementById('status-panel-popover-fixed')!
    expect(popover.style.left).toBe('8px')
  })
})

describe('StatusPanel 浮层让位语义', () => {
  it('点击子代理行打开大弹窗后浮层保留', () => {
    const popover = open(1)
    expect(popover).not.toBeNull()
    fireEvent.click(popover.querySelector('.status-panel-agent-item') as HTMLElement)
    expect(document.getElementById('status-panel-popover-fixed')).not.toBeNull()
  })

  it('大弹窗（modal 遮罩）内点击不关闭浮层；遮罩外点击才关闭', () => {
    const popover = open(1)
    // 模拟大弹窗遮罩在 DOM 中（浮层 portal 之后挂载）
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    document.body.appendChild(overlay)
    // 遮罩内点击 → 保留
    fireEvent.mouseDown(overlay)
    expect(document.getElementById('status-panel-popover-fixed')).not.toBeNull()
    // 遮罩外（面板外区域）点击 → 关闭
    fireEvent.mouseDown(document.body)
    expect(document.getElementById('status-panel-popover-fixed')).toBeNull()
    void popover
  })

  it('大弹窗打开时 Esc 不关闭浮层；无大弹窗时 Esc 关闭', () => {
    open(1)
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    document.body.appendChild(overlay)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.getElementById('status-panel-popover-fixed')).not.toBeNull()
    overlay.remove()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.getElementById('status-panel-popover-fixed')).toBeNull()
  })
})
