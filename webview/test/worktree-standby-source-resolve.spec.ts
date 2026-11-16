/**
 * 缺陷HQ 待命落位归一（副本作用域会话三来源落空·展示层）
 *
 * 锁定行为：
 * 1. worktreeState 回带 sourceWorkspace（Java 反解托管根副本→源工作区）→ worktreeStandby 登记
 * 2. createSession 请求优先落反解源目录（待命落位归一，不再跟随副本根）
 * 3. 未命中反解（普通目录，无 sourceWorkspace）保持激活目录原样
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendToJavaMock = vi.fn()
vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: () => () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (...args: unknown[]) => sendToJavaMock(...(args as [])),
}))

import { useStore, handleResponse } from '@/store/useStore'

const WT_ROOT = 'C:\\Users\\x\\.zcode\\worktrees\\5de0\\zcode-idea-plugin'
const SRC = 'G:\\proj\\zcode-idea-plugin'

beforeEach(() => {
  sendToJavaMock.mockClear()
  useStore.setState({
    activeWorkspacePath: WT_ROOT,
    projectPath: SRC,
    currentSessionId: null,
    currentWorkspacePath: null,
    worktreeStandby: null,
    worktreeEnabled: false,
    worktreeMetaBySession: {},
    sessions: [],
    creatingSession: false,
  })
})

describe('缺陷HQ 待命落位归一', () => {
  it('worktreeState 回带 sourceWorkspace → worktreeStandby 登记（含回显匹配键）', () => {
    handleResponse(
      { op: 'worktreeState', supported: true, gitOk: true, sourceWorkspace: SRC, workspacePath: WT_ROOT } as never,
      useStore.setState, useStore.getState,
    )
    const st = useStore.getState()
    expect(st.worktreeStandby?.supported).toBe(true)
    expect(st.worktreeStandby?.sourceWorkspace).toBe(SRC)
    expect(st.worktreeStandby?.resolvedFor).toBe(WT_ROOT)
  })

  it('副本作用域待命建会话：请求直接落反解源目录', () => {
    useStore.setState({ activeWorkspacePath: WT_ROOT })
    handleResponse(
      { op: 'worktreeState', supported: true, gitOk: true, sourceWorkspace: SRC, workspacePath: WT_ROOT } as never,
      useStore.setState, useStore.getState,
    )
    useStore.getState().createSession()
    const call = sendToJavaMock.mock.calls.map((c) => c[0]).find((m) => (m as { op: string }).op === 'createSession')
    expect(call).toBeTruthy()
    expect((call as { workspacePath?: string }).workspacePath).toBe(SRC)
  })

  it('普通目录未命中反解：保持激活目录原样', () => {
    useStore.setState({ activeWorkspacePath: 'G:\\other-project' })
    handleResponse(
      { op: 'worktreeState', supported: true, gitOk: true, workspacePath: 'G:\\other-project' } as never,
      useStore.setState, useStore.getState,
    )
    useStore.getState().createSession()
    const call = sendToJavaMock.mock.calls.map((c) => c[0]).find((m) => (m as { op: string }).op === 'createSession')
    expect((call as { workspacePath?: string }).workspacePath).toBe('G:\\other-project')
  })

  it('切目录后旧反解不串台：回显目录≠当前落位目录 → 不采信', () => {
    // 先探测副本（拿到源目录），随后 chips 切到另一个目录
    handleResponse(
      { op: 'worktreeState', supported: true, gitOk: true, sourceWorkspace: SRC, workspacePath: WT_ROOT } as never,
      useStore.setState, useStore.getState,
    )
    useStore.setState({ activeWorkspacePath: 'G:\\another-linked' })
    useStore.getState().createSession()
    const call = sendToJavaMock.mock.calls.map((c) => c[0]).find((m) => (m as { op: string }).op === 'createSession')
    expect((call as { workspacePath?: string }).workspacePath).toBe('G:\\another-linked')
  })

  it('挂载早期空串探测不生效：空 workspacePath 回显不匹配真实落位目录', () => {
    // 复刻真机 15:41 现场：请求发在 store init 之前（空串），Java 回退项目根并回显空串之外的目录
    useStore.setState({ activeWorkspacePath: WT_ROOT, projectPath: SRC })
    handleResponse(
      { op: 'worktreeState', supported: true, gitOk: true, workspacePath: SRC } as never,
      useStore.setState, useStore.getState,
    )
    useStore.getState().createSession()
    const call = sendToJavaMock.mock.calls.map((c) => c[0]).find((m) => (m as { op: string }).op === 'createSession')
    // 副本落位没拿到反解（回显=项目根≠副本根）→ 原样副本根；随后真实探测会纠正（由 Java 归一兜底落源目录）
    expect((call as { workspacePath?: string }).workspacePath).toBe(WT_ROOT)
  })
})
