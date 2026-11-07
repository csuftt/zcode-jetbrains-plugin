// @vitest-environment jsdom
/**
 * 关联目录 chips 行入口回归（多目录会话·变体A）
 *
 * 背景：首版把 chips 行做成"有关联目录才渲染"，空态连 ⊕ 都不显示——
 * 添加第一个关联目录的唯一入口不可达（真机踩坑 2026-10-27）。
 * 锁死：空态（无关联目录、激活=本项目）chips 行也必须常驻渲染。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, createEvent, cleanup } from '@testing-library/react'
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

  it('信息条显示浏览目录全路径（本项目也显示，悬浮同值）', () => {
    renderHistory()
    const ws = document.querySelector('.history-info__ws') as HTMLElement
    expect(ws).not.toBeNull()
    expect(ws.textContent).toBe('G:/mock-project')
    expect(ws.getAttribute('data-tooltip')).toBe('G:/mock-project')
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
    expect(chips).toHaveLength(4) // 本项目 + other + 编辑 + 添加目录
    fireEvent.click(screen.getByText('other'))
    expect(onSwitchWorkspace).toHaveBeenCalledWith('E:/work/other')
  })

  it('方案B两段式布局：chips 在换行区，编辑/添加固定动作区；新建会话在 tab 行右端', () => {
    renderHistory({ linkedWorkspaces: ['E:/work/other'] })
    const flow = document.querySelector('.history-ws-chips__flow')
    const actions = document.querySelector('.history-ws-chips__actions')
    expect(flow).not.toBeNull()
    expect(actions).not.toBeNull()
    // 换行区只装目录 chips（本项目+关联）
    expect(flow!.querySelectorAll('.history-ws-chip')).toHaveLength(2)
    expect(flow!.querySelector('.history-ws-chip--project')).not.toBeNull()
    // 动作区两钮：编辑/添加目录（新建会话不在 chips 行）
    expect(actions!.querySelector('.history-ws-chip--edit')).not.toBeNull()
    expect(actions!.querySelector('.history-ws-chip--add')).not.toBeNull()
    expect(actions!.querySelector('.history-ws-chip--new')).toBeNull()
    // 新建会话实底主钮在 tab 行右端
    expect(document.querySelector('.history-tabs__new')).not.toBeNull()
    fireEvent.click(document.querySelector('.history-tabs__new')!)
    // onClick 走 onNewSession（renderHistory 默认 mock，断言不抛错即可——调用断言见专门用例）
  })

  it('新建会话按钮：点击触发 onNewSession（待命态+落位由 App 组合）', () => {
    const onNewSession = vi.fn()
    renderHistory({ onNewSession })
    fireEvent.click(document.querySelector('.history-tabs__new')!)
    expect(onNewSession).toHaveBeenCalledTimes(1)
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

describe('关联目录 chips 拖动排序（常驻可拖，2026-11-07 定稿）', () => {
  const THREE = ['E:/a/alpha', 'E:/b/beta', 'E:/c/gamma']

  /** chip 按目录名查找（getByText 命中 name span，回溯 button）*/
  const chipOf = (name: string) => screen.getByText(name).closest('button') as HTMLElement

  /** jsdom 的 getBoundingClientRect 恒零：指定 chip 的矩形（模拟换行行内几何）*/
  const stubRect = (el: HTMLElement, left: number, width: number) => {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left, width, top: 0, height: 24, right: left + width, bottom: 24, x: left, y: 0, toJSON: () => ({}),
    } as DOMRect)
  }

  /** flow 区 chip 名字序（含首位本项目 chip「mock-project」，校验它恒第一不动）*/
  const flowNames = () =>
    Array.from(document.querySelectorAll('.history-ws-chips__flow .history-ws-chip__name')).map(
      (el) => el.textContent,
    )

  /**
   * 派发带指针坐标的鼠标事件：jsdom/RTL 下 fireEvent init 的 clientX/Y 落不到事件上
   * （坐标是原型只读 getter，RTL 的 Object.assign 静默失败——探针实测），须 createEvent
   * 后 defineProperty 强写。仅测试基建缺口，真机 Chromium 坐标原生可用。
   * mousedown 派发到 chip（handler 读坐标记起点）；mousemove 派发到 document（bubbles
   * 冒到 window 级监听）；mouseup 派发到 window（同样冒到）。
   */
  const mouseAt = (kind: 'mouseDown' | 'mouseMove' | 'mouseUp', target: EventTarget, clientX: number, clientY = 12) => {
    const ev = createEvent[kind](target as HTMLElement, { bubbles: true })
    Object.defineProperty(ev, 'clientX', { value: clientX })
    Object.defineProperty(ev, 'clientY', { value: clientY })
    fireEvent(target, ev)
  }

  /** 一次「拖拽过」的 click 抑制序列用 mouseup 后紧跟 click 模拟（浏览器在同一手势内派发）*/
  it('拖 gamma 到 alpha 左半区：预览即时重排，mouseup 提交新序（项目 chip 恒第一）', () => {
    const onReorderWorkspaces = vi.fn()
    renderHistory({ linkedWorkspaces: THREE, onReorderWorkspaces })
    const gamma = chipOf('gamma')
    const alpha = chipOf('alpha')
    stubRect(alpha, 200, 120) // 中心 260
    mouseAt('mouseDown', gamma, 500)
    // 位移过阈值后命中 alpha 左半区（clientX=210 < 260）→ 插到 alpha 前
    mouseAt('mouseMove', document, 210)
    // 预览序即时生效：gamma 排到最前（本项目 chip 仍第一）
    expect(flowNames()).toEqual(['mock-project', 'gamma', 'alpha', 'beta'])
    mouseAt('mouseUp', window, 210)
    expect(onReorderWorkspaces).toHaveBeenCalledTimes(1)
    expect(onReorderWorkspaces).toHaveBeenCalledWith(['E:/c/gamma', 'E:/a/alpha', 'E:/b/beta'])
  })

  it('拖 alpha 到 beta 右半区：插到 beta 之后（alpha 原居首位，落位=夹在 beta/gamma 之间）', () => {
    const onReorderWorkspaces = vi.fn()
    renderHistory({ linkedWorkspaces: THREE, onReorderWorkspaces })
    const alpha = chipOf('alpha')
    const beta = chipOf('beta')
    stubRect(beta, 320, 110) // 中心 375
    mouseAt('mouseDown', alpha, 500)
    // 指针在 beta 右半区（clientX=400 ≥ 375）→ 插到 beta 后（=移到末尾须拖到末位 chip 右半区）
    mouseAt('mouseMove', document, 400)
    expect(flowNames()).toEqual(['mock-project', 'beta', 'alpha', 'gamma'])
    mouseAt('mouseUp', window, 400)
    expect(onReorderWorkspaces).toHaveBeenCalledWith(['E:/b/beta', 'E:/a/alpha', 'E:/c/gamma'])
  })

  it('mousedown 后位移未过阈值松手（纯点击）：不提交且 click 不被抑制', () => {
    const onReorderWorkspaces = vi.fn()
    const onSwitchWorkspace = vi.fn()
    renderHistory({ linkedWorkspaces: THREE, onReorderWorkspaces, onSwitchWorkspace })
    const beta = chipOf('beta')
    mouseAt('mouseDown', beta, 500)
    mouseAt('mouseUp', window, 500)
    expect(onReorderWorkspaces).not.toHaveBeenCalled()
    fireEvent.click(beta)
    expect(onSwitchWorkspace).toHaveBeenCalledWith('E:/b/beta')
  })

  it('拖拽过后 click 被抑制（mouseup 落在 chip 上派发 click，不得误切目录）', () => {
    const onSwitchWorkspace = vi.fn()
    renderHistory({ linkedWorkspaces: THREE, onSwitchWorkspace })
    const gamma = chipOf('gamma')
    const alpha = chipOf('alpha')
    stubRect(alpha, 200, 120)
    mouseAt('mouseDown', gamma, 500)
    mouseAt('mouseMove', document, 210)
    mouseAt('mouseUp', window, 210)
    fireEvent.click(gamma)
    expect(onSwitchWorkspace).not.toHaveBeenCalled()
  })

  it('mousemove 高频重复命中同一位：预览序幂等（仅一次重排态，mouseup 仍只提交一次）', () => {
    const onReorderWorkspaces = vi.fn()
    renderHistory({ linkedWorkspaces: THREE, onReorderWorkspaces })
    const gamma = chipOf('gamma')
    const alpha = chipOf('alpha')
    stubRect(alpha, 200, 120)
    mouseAt('mouseDown', gamma, 500)
    for (let i = 0; i < 5; i++) mouseAt('mouseMove', document, 210)
    mouseAt('mouseUp', window, 210)
    expect(onReorderWorkspaces).toHaveBeenCalledTimes(1)
  })
})
