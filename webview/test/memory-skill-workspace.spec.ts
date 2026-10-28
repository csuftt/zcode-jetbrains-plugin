/**
 * 多目录会话：记忆页/技能页浏览目录切换 store 链路回归
 *
 * 覆盖：
 * 1. loadMemoryFiles/loadSkills 缺省=本项目；显式传参=切换；无参=延续当前作用域
 * 2. 应答乱序守卫：晚到的旧目录清单/扫描不覆盖当前浏览（回显 workspacePath 比对）
 * 3. createMemoryFile/toggleSkill 携带当前浏览目录（Kotlin 白名单按目标目录校验）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
}))

import { useStore, handleResponse } from '@/store/useStore'

const WS_PROJECT = 'G:/mock-project'
const WS_OTHER = 'E:/work/other-project'

beforeEach(() => {
  sentRequests.length = 0
  useStore.setState({
    projectPath: WS_PROJECT,
    linkedWorkspaces: [],
    memoryWorkspace: '',
    skillsWorkspace: '',
    memoryFiles: null,
    skills: null,
    memoryLoading: false,
    skillsLoading: false,
  })
})

describe('记忆页浏览目录', () => {
  it('缺省拉取落在本项目；显式传参切换作用域', () => {
    useStore.getState().loadMemoryFiles()
    expect(sentRequests.at(-1)).toMatchObject({ op: 'listMemoryFiles', workspacePath: WS_PROJECT })
    useStore.getState().loadMemoryFiles(WS_OTHER)
    expect(sentRequests.at(-1)).toMatchObject({ op: 'listMemoryFiles', workspacePath: WS_OTHER })
    expect(useStore.getState().memoryWorkspace).toBe(WS_OTHER)
  })

  it('无参调用延续当前作用域（设置页切走再回不清选择）', () => {
    useStore.setState({ memoryWorkspace: WS_OTHER })
    useStore.getState().loadMemoryFiles()
    expect(sentRequests.at(-1)).toMatchObject({ op: 'listMemoryFiles', workspacePath: WS_OTHER })
  })

  it('传空串切回本项目（空串是显式目标非缺省）', () => {
    useStore.setState({ memoryWorkspace: WS_OTHER })
    useStore.getState().loadMemoryFiles('')
    expect(sentRequests.at(-1)).toMatchObject({ op: 'listMemoryFiles', workspacePath: WS_PROJECT })
    expect(useStore.getState().memoryWorkspace).toBe('')
  })

  it('乱序守卫：旧目录清单晚到不覆盖，当前目录清单正常落地', () => {
    useStore.setState({ memoryWorkspace: WS_OTHER })
    // 旧目录（本项目）响应晚到 → 丢弃，loading 不解除
    handleResponse(
      { op: 'memoryFiles', files: [], memoryEnabled: true, memorySettingPath: 'x', workspacePath: WS_PROJECT } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().memoryFiles).toBeNull()
    expect(useStore.getState().memoryLoading).toBe(false) // 守卫 break 不动 loading
    // 当前目录响应 → 落地
    useStore.getState().loadMemoryFiles() // 置 loading
    handleResponse(
      { op: 'memoryFiles', files: [{ name: 'AGENTS.md', scope: 'project', kind: 'instructions', path: 'p', exists: true, description: '' }], memoryEnabled: true, memorySettingPath: 'x', workspacePath: WS_OTHER } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().memoryFiles).toHaveLength(1)
    expect(useStore.getState().memoryLoading).toBe(false)
  })

  it('createMemoryFile 携带当前浏览目录（Kotlin 白名单按目标目录校验）', () => {
    useStore.setState({ memoryWorkspace: WS_OTHER })
    useStore.getState().createMemoryFile('E:/work/other-project/AGENTS.md')
    expect(sentRequests.at(-1)).toMatchObject({
      op: 'createMemoryFile',
      path: 'E:/work/other-project/AGENTS.md',
      workspacePath: WS_OTHER,
    })
  })
})

describe('技能页浏览目录', () => {
  it('缺省=本项目；显式切换；无参延续', () => {
    useStore.getState().loadSkills()
    expect(sentRequests.at(-1)).toMatchObject({ op: 'listSkills', workspacePath: WS_PROJECT })
    useStore.getState().loadSkills(WS_OTHER)
    expect(useStore.getState().skillsWorkspace).toBe(WS_OTHER)
    useStore.getState().loadSkills()
    expect(sentRequests.at(-1)).toMatchObject({ op: 'listSkills', workspacePath: WS_OTHER })
  })

  it('乱序守卫：旧目录扫描晚到不覆盖当前浏览', () => {
    useStore.setState({ skillsWorkspace: WS_OTHER, skillsLoading: true })
    handleResponse(
      { op: 'skills', skills: [{ name: 'old-skill', scope: 'project', path: 'p1', directory: 'd', source: 'zcode', enabled: true }], workspacePath: WS_PROJECT } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().skills).toBeNull()
    handleResponse(
      { op: 'skills', skills: [{ name: 'new-skill', scope: 'project', path: 'p2', directory: 'd', source: 'zcode', enabled: true }], workspacePath: WS_OTHER } as never,
      useStore.setState, useStore.getState,
    )
    expect(useStore.getState().skills).toHaveLength(1)
    expect(useStore.getState().skills![0].name).toBe('new-skill')
  })

  it('toggleSkill 携带当前浏览目录', () => {
    useStore.setState({ skillsWorkspace: WS_OTHER })
    useStore.getState().toggleSkill('E:/work/other-project/.zcode/skills/x/SKILL.md', false)
    expect(sentRequests.at(-1)).toMatchObject({ op: 'toggleSkill', workspacePath: WS_OTHER, enabled: false })
  })
})
