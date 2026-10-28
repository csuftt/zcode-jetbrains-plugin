// @vitest-environment jsdom
/**
 * 关联目录 chips 行入口回归（多目录会话·变体A）
 *
 * 背景：首版把 chips 行做成"有关联目录才渲染"，空态连 ⊕ 都不显示——
 * 添加第一个关联目录的唯一入口不可达（真机踩坑 2026-10-27）。
 * 锁死：空态（无关联目录、激活=本项目）chips 行也必须常驻渲染。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { HistoryView } from '@/components/HistoryView'

afterEach(cleanup)

function renderHistory(overrides: Record<string, unknown> = {}) {
  const props = {
    sessions: [],
    archivedSessions: [],
    archivedLoading: false,
    currentSessionId: null,
    onLocate: vi.fn().mockResolvedValue(false),
    onLoadOpenTabs: vi.fn().mockResolvedValue([]),
    onOpenNewTab: vi.fn(),
    onSelect: vi.fn(),
    onBack: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onDeleteArchived: vi.fn(),
    onTogglePin: vi.fn(),
    pinnedSessionIds: [],
    unreadSessionIds: [],
    onRefresh: vi.fn(),
    onLoadArchived: vi.fn(),
    projectWorkspacePath: 'G:/mock-project',
    ...overrides,
  }
  render(<HistoryView {...props} />)
  return props
}

describe('chips 行空态入口', () => {
  it('无关联目录时也渲染 chips 行（本项目 chip + ⊕ 常驻）', () => {
    renderHistory()
    expect(document.querySelector('.history-ws-chips')).not.toBeNull()
    expect(document.querySelector('.history-ws-chip--project')).not.toBeNull()
    expect(document.querySelector('.history-ws-chip--add')).not.toBeNull()
  })

  it('新建会话按钮：点击触发 onNewSession（待命态+落位由 App 组合）', () => {
    const onNewSession = vi.fn()
    renderHistory({ onNewSession })
    fireEvent.click(document.querySelector('.history-ws-chip--new')!)
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })

  it('信息条显示浏览目录全路径（本项目也显示，悬浮同值）', () => {
    renderHistory()
    const ws = document.querySelector('.history-info__ws') as HTMLElement
    expect(ws).not.toBeNull()
    expect(ws.textContent).toBe('G:/mock-project')
    expect(ws.title).toBe('G:/mock-project')
  })

  it('点 ⊕ 触发添加关联目录（系统目录选择框入口）', () => {
    const onAddWorkspace = vi.fn()
    renderHistory({ onAddWorkspace })
    fireEvent.click(document.querySelector('.history-ws-chip--add')!)
    expect(onAddWorkspace).toHaveBeenCalledTimes(1)
  })

  it('有关联目录时逐个渲染 chip，点击切换', () => {
    const onSwitchWorkspace = vi.fn()
    renderHistory({
      linkedWorkspaces: ['E:/work/other'],
      onSwitchWorkspace,
    })
    const chips = Array.from(document.querySelectorAll('.history-ws-chip'))
    expect(chips).toHaveLength(5) // 本项目 + other + ⊕ + 编辑开关 + 新建会话
    fireEvent.click(screen.getByText('other'))
    expect(onSwitchWorkspace).toHaveBeenCalledWith('E:/work/other')
  })

  it('编辑模式开关：默认非编辑态，点编辑按钮进入（容器带编辑类），再点退出', () => {
    renderHistory({ linkedWorkspaces: ['E:/work/other'] })
    expect(document.querySelector('.history-ws-chips--editing')).toBeNull()
    expect(document.querySelector('.history-ws-chip--edit')).not.toBeNull()
    fireEvent.click(document.querySelector('.history-ws-chip--edit')!)
    expect(document.querySelector('.history-ws-chips--editing')).not.toBeNull()
    expect(document.querySelector('.history-ws-chip--edit-active')).not.toBeNull()
    fireEvent.click(document.querySelector('.history-ws-chip--edit')!)
    expect(document.querySelector('.history-ws-chips--editing')).toBeNull()
  })

  it('编辑态下点 × 只弹二次确认，确认后才真正移除（误触防护）', () => {
    const onRemoveWorkspace = vi.fn()
    renderHistory({ linkedWorkspaces: ['E:/work/other'], onRemoveWorkspace })
    // 进入编辑模式再点 ×
    fireEvent.click(document.querySelector('.history-ws-chip--edit')!)
    fireEvent.click(document.querySelector('.history-ws-chip__remove')!)
    // 未确认前不删
    expect(onRemoveWorkspace).not.toHaveBeenCalled()
    // 确认弹窗出现（确认按钮文案=t('history.wsChips.remove') 中文值），点确认
    fireEvent.click(screen.getByText('移除关联（不影响该目录下的会话数据）'))
    expect(onRemoveWorkspace).toHaveBeenCalledTimes(1)
    expect(onRemoveWorkspace).toHaveBeenCalledWith('E:/work/other')
  })

  it('二次确认弹窗取消：不删除', () => {
    const onRemoveWorkspace = vi.fn()
    renderHistory({ linkedWorkspaces: ['E:/work/other'], onRemoveWorkspace })
    fireEvent.click(document.querySelector('.history-ws-chip--edit')!)
    fireEvent.click(document.querySelector('.history-ws-chip__remove')!)
    fireEvent.click(screen.getByText('取消'))
    expect(onRemoveWorkspace).not.toHaveBeenCalled()
  })
})

describe('归档 tab 切目录跟随刷新', () => {
  // 归档 tab 全量 props 基座（vitest 运行时不查类型，缺省走组件默认值）
  function archivedProps(overrides: Record<string, unknown> = {}) {
    return {
      sessions: [],
      archivedSessions: [],
      archivedLoading: false,
      currentSessionId: null,
      onLocate: vi.fn().mockResolvedValue(false),
      onLoadOpenTabs: vi.fn().mockResolvedValue([]),
      onOpenNewTab: vi.fn(),
      onSelect: vi.fn(),
      onBack: vi.fn(),
      onArchive: vi.fn(),
      onRestore: vi.fn(),
      onDeleteArchived: vi.fn(),
      onTogglePin: vi.fn(),
      pinnedSessionIds: [],
      unreadSessionIds: [],
      onRefresh: vi.fn(),
      onLoadArchived: vi.fn(),
      linkedWorkspaces: ['E:/work/other'],
      activeWorkspacePath: 'G:/mock-project',
      projectWorkspacePath: 'G:/mock-project',
      onSwitchWorkspace: vi.fn(),
      onAddWorkspace: vi.fn(),
      onRemoveWorkspace: vi.fn(),
      ...overrides,
    }
  }

  it('切目录瞬间（archivedSessions 已清、归档请求未发）显示加载态而非「回收站为空」', () => {
    const { rerender } = render(
      <HistoryView
        {...archivedProps({ archivedSessions: [{ sessionId: 's1', title: 'A', updatedAt: 1 }] })}
      />,
    )
    // 进入已归档 tab，列表正常显示
    fireEvent.click(screen.getByText('已归档'))
    expect(screen.getByText('A')).not.toBeNull()
    // 模拟切目录：store 先清空 archivedSessions + 置 sessionsLoading（effect 尚未跑）
    rerender(<HistoryView {...archivedProps({ sessionsLoading: true, activeWorkspacePath: 'E:/work/other' })} />)
    expect(screen.queryByText('📭 回收站为空')).toBeNull()
    expect(screen.getByText('加载中…')).not.toBeNull()
  })

  it('归档 tab 内 activeWorkspacePath 变化触发 onLoadArchived 重拉；props 不变的重渲染不触发', () => {
    const onLoadArchived = vi.fn()
    const { rerender } = render(<HistoryView {...archivedProps({ onLoadArchived })} />)
    // 会话 tab：不拉归档
    expect(onLoadArchived).not.toHaveBeenCalled()
    // 进归档 tab：拉一次
    fireEvent.click(screen.getByText('已归档'))
    expect(onLoadArchived).toHaveBeenCalledTimes(1)
    // 同 props 重渲染：不重复拉
    rerender(<HistoryView {...archivedProps({ onLoadArchived })} />)
    expect(onLoadArchived).toHaveBeenCalledTimes(1)
    // 切目录（activeWorkspacePath 变化）：跟随重拉
    rerender(<HistoryView {...archivedProps({ onLoadArchived, activeWorkspacePath: 'E:/work/other' })} />)
    expect(onLoadArchived).toHaveBeenCalledTimes(2)
  })
})
