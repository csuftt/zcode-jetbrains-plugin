/**
 * 缺陷HQ 四轮（webview 侧）：待命落位归一的本地解析 + 落点 scope 同步
 *
 * 锁定行为：
 * 1. resolveWorktreeSource：worktree meta 映射（worktreeRoot 命中/落位在其下）→ 源工作区，
 *    worktreeState 反解需回显匹配（防切目录串台），普通目录不命中
 * 2. resetToNewSession：覆盖前会话执行根在副本时，待命落位归一到源目录（chip 不翻转）
 * 3. createSession 响应落点≠当前列表 scope 时：scope 切到落点并重拉列表（header 不再
 *    fallback sess 前缀、历史页不留在副本作用域）
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
import { resolveWorktreeSource } from '@/utils/worktreeSource'

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
    sessionsWorkspace: '',
    creatingSession: false,
  })
})

describe('resolveWorktreeSource', () => {
  const meta = {
    worktreeRoot: WT_ROOT,
    cwd: WT_ROOT,
    sourceWorkspace: SRC,
  }

  it('meta 映射：worktreeRoot 精确命中 / 落位在其下', () => {
    const st = { activeWorkspacePath: WT_ROOT, worktreeMetaBySession: { s1: meta as never } }
    expect(resolveWorktreeSource(st)).toBe(SRC)
    const sub = { activeWorkspacePath: `${WT_ROOT}\\intellij-plugin`, worktreeMetaBySession: { s1: meta as never } }
    expect(resolveWorktreeSource(sub)).toBe(SRC)
  })

  it('worktreeState 反解：仅回显目录==落位目录时采信', () => {
    const matched = {
      activeWorkspacePath: WT_ROOT,
      worktreeStandby: { supported: true, gitOk: true, sourceWorkspace: SRC, resolvedFor: WT_ROOT },
    }
    expect(resolveWorktreeSource(matched)).toBe(SRC)
    // 回显目录是别处（挂载早期空串探测/切目录后旧反解）→ 不采信
    const stale = {
      activeWorkspacePath: 'G:\\another',
      worktreeStandby: { supported: true, gitOk: true, sourceWorkspace: SRC, resolvedFor: WT_ROOT },
    }
    expect(resolveWorktreeSource(stale)).toBeUndefined()
  })

  it('普通目录/无上下文 → undefined', () => {
    expect(resolveWorktreeSource({ activeWorkspacePath: SRC, worktreeMetaBySession: {} })).toBeUndefined()
    expect(resolveWorktreeSource(null)).toBeUndefined()
  })
})

describe('缺陷HQ 四轮 store 行为', () => {
  it('resetToNewSession：副本执行根归一到源目录（chip 不翻转）', () => {
    useStore.setState({
      currentSessionId: 'sess_x',
      currentWorkspacePath: WT_ROOT,
      // 列表里已有该副本 meta（主列表注入），本地映射即可归一
      worktreeMetaBySession: { sess_x: { worktreeRoot: WT_ROOT, cwd: WT_ROOT, sourceWorkspace: SRC } as never },
      activeWorkspacePath: WT_ROOT,
    })
    useStore.getState().resetToNewSession()
    expect(useStore.getState().activeWorkspacePath).toBe(SRC)
  })

  it('createSession 响应落点≠scope：切 scope 并重拉落点目录列表', () => {
    useStore.setState({ activeWorkspacePath: WT_ROOT })
    handleResponse(
      { op: 'createSession', sessionId: 'sess_new', workspacePath: SRC } as never,
      useStore.setState, useStore.getState,
    )
    const st = useStore.getState()
    expect(st.currentWorkspacePath).toBe(SRC)
    expect(st.activeWorkspacePath).toBe(SRC)
    // 重拉列表落在落点目录
    const listReq = sendToJavaMock.mock.calls
      .map((c) => c[0] as { op: string; workspacePath?: string })
      .find((m) => m.op === 'listSessions')
    expect(listReq?.workspacePath).toBe(SRC)
  })

  it('createSession 响应落点==scope：列表重拉仍落在落点目录（case 尾统一拉取）', () => {
    useStore.setState({ activeWorkspacePath: SRC })
    handleResponse(
      { op: 'createSession', sessionId: 'sess_new2', workspacePath: SRC } as never,
      useStore.setState, useStore.getState,
    )
    const listReq = sendToJavaMock.mock.calls
      .map((c) => c[0] as { op: string; workspacePath?: string })
      .find((m) => m.op === 'listSessions')
    expect(listReq?.workspacePath).toBe(SRC)
  })
})