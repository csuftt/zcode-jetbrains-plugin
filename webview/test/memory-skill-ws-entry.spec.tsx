// @vitest-environment jsdom
/**
 * 多目录会话：记忆页/技能页浏览目录下拉组件回归
 *
 * 锁死：
 * 1. 无关联目录不渲染下拉（单一选项的下拉是噪音）
 * 2. 有关联目录渲染下拉：本项目 + 各关联目录 option（全路径挂 title）
 * 3. 切换 option 触发对应 listMemoryFiles/listSkills 请求落在新目录
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:/mock-project',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
  // MemoryView 深处子组件引用的其他 bridge 导出兜底
  openFile: () => {},
}))

import { useStore } from '@/store/useStore'
import { MemoryView } from '@/components/MemoryView'
import { SkillListView } from '@/components/SkillListView'

const WS_PROJECT = 'G:/mock-project'
const WS_OTHER = 'E:/work/other-project'

beforeEach(() => {
  sentRequests.length = 0
  useStore.setState({
    projectPath: WS_PROJECT,
    linkedWorkspaces: [],
    memoryWorkspace: '',
    skillsWorkspace: '',
    memoryFiles: [],
    memoryLoading: false,
    memoryEnabled: true,
    skills: [],
    skillsLoading: false,
    cuaIcons: {},
  })
})

afterEach(cleanup)

describe('记忆页目录下拉', () => {
  it('无关联目录不渲染下拉', () => {
    render(<MemoryView />)
    expect(document.querySelector('.memory-view__ws-select')).toBeNull()
  })

  it('有关联目录渲染下拉（本项目+关联目录），切换触发按新目录重拉', () => {
    useStore.setState({ linkedWorkspaces: [WS_OTHER] })
    render(<MemoryView />)
    const sel = document.querySelector('.memory-view__ws-select') as HTMLSelectElement
    expect(sel).not.toBeNull()
    // 挂载首拉落在本项目
    expect(sentRequests.filter((r) => r.op === 'listMemoryFiles')[0]).toMatchObject({ workspacePath: WS_PROJECT })
    // option 集合：本项目（中文文案）+ 目录名
    expect(screen.getByText('本项目')).not.toBeNull()
    expect(screen.getByText('other-project')).not.toBeNull()
    // 切到关联目录 → 重拉带新目录 + 作用域更新
    fireEvent.change(sel, { target: { value: WS_OTHER } })
    const last = sentRequests.filter((r) => r.op === 'listMemoryFiles').at(-1)
    expect(last).toMatchObject({ workspacePath: WS_OTHER })
    expect(useStore.getState().memoryWorkspace).toBe(WS_OTHER)
  })
})

describe('技能页目录下拉', () => {
  it('无关联目录不渲染；有关联目录切换触发按新目录重扫', () => {
    render(<SkillListView />)
    expect(document.querySelector('.skill-list-view__ws-select')).toBeNull()
    cleanup()

    useStore.setState({ linkedWorkspaces: [WS_OTHER] })
    render(<SkillListView />)
    const sel = document.querySelector('.skill-list-view__ws-select') as HTMLSelectElement
    expect(sel).not.toBeNull()
    expect(sentRequests.filter((r) => r.op === 'listSkills')[0]).toMatchObject({ workspacePath: WS_PROJECT })
    fireEvent.change(sel, { target: { value: WS_OTHER } })
    expect(sentRequests.filter((r) => r.op === 'listSkills').at(-1)).toMatchObject({ workspacePath: WS_OTHER })
    expect(useStore.getState().skillsWorkspace).toBe(WS_OTHER)
  })
})
