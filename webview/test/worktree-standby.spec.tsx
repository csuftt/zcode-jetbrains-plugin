/**
 * worktree 待命条 + 元数据接线（0.4.6，spec #52）
 *
 * 锁定行为：
 * 1. 老 CLI（supported=false）→ 待命条整体不渲染（门控降级矩阵）
 * 2. 支持时渲染开关（起点恒当前 HEAD，下拉已随 2026-11-14 简化退役）
 * 3. worktreeProgress 驱动 creating/failed 状态
 * 4. listSessions 条目携带 worktree 元数据 → meta map 登记（chip 数据源）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'

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

import '@/i18n/config'
import { useStore, handleResponse } from '@/store/useStore'
import { InputBox } from '@/components/InputBox'

const storage = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) },
    removeItem: (k: string) => { storage.delete(k) },
    key: (i: number) => Array.from(storage.keys())[i] ?? null,
    get length() { return storage.size },
    clear: () => storage.clear(),
  },
})

beforeEach(() => {
  storage.clear()
  sendToJavaMock.mockClear()
  useStore.setState({
    currentSessionId: null,
    worktreeStandby: null,
    worktreeEnabled: false,
    worktreeStartRef: 'HEAD',
    worktreeRefs: null,
    worktreeRefsLoading: false,
    worktreeCreating: null,
    worktreeErrorCode: null,
    worktreeMetaBySession: {},
    sessions: [],
  })
})

afterEach(cleanup)

describe('worktree 待命条（0.4.6）', () => {
  it('老 CLI（supported=false）整体不渲染', () => {
    useStore.setState({ worktreeStandby: { supported: false, gitOk: false } })
    const { queryByText } = render(<InputBox onSend={() => {}} />)
    expect(queryByText('Worktree')).toBeNull()
  })

  it('支持时渲染开关；开启只出说明（起点恒当前 HEAD，无下拉——2026-11-14 简化定案）', () => {
    useStore.setState({ worktreeStandby: { supported: true, gitOk: true } })
    const { getByText, container } = render(<InputBox onSend={() => {}} />)
    expect(getByText('Worktree')).toBeTruthy()

    fireEvent.click(container.querySelector('.worktree-bar__pill')!)
    expect(useStore.getState().worktreeEnabled).toBe(true)
    // 起点下拉已退役：开启不拉候选、不发 worktreeStartRefs
    expect(container.querySelector('.worktree-ref-root')).toBeNull()
    const startRefCalls = (sendToJavaMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { op: string }).op === 'worktreeStartRefs',
    )
    expect(startRefCalls).toHaveLength(0)
  })

  it('非 git 目录：开关禁用并给原因', () => {
    useStore.setState({ worktreeStandby: { supported: true, gitOk: false } })
    const { getByText, container } = render(<InputBox onSend={() => {}} />)
    const pill = container.querySelector('.worktree-bar__pill') as HTMLButtonElement
    expect(pill.disabled).toBe(true)
    expect(getByText('该目录不是 Git 仓库')).toBeTruthy()
  })

  it('起点说明图标：点击钉住气泡（悬浮 tooltip 之外的第二通道）', () => {
    useStore.setState({ worktreeStandby: { supported: true, gitOk: true }, worktreeEnabled: true })
    const { container } = render(<InputBox onSend={() => {}} />)
    act(() => {
      useStore.setState({
        worktreeRefs: { headSha: '26199cafe0', headBranch: 'main', localBranches: [], remoteBranches: [] },
        worktreeRefsLoading: false,
      })
    })
    const note = container.querySelector('.worktree-bar__note') as HTMLButtonElement
    expect(note).toBeTruthy()
    expect(note.getAttribute('data-tooltip')).toContain('detached')
    fireEvent.click(note)
    expect(note.className).toContain('worktree-bar__note--open')
    fireEvent.click(note)
    expect(note.className).not.toContain('worktree-bar__note--open')
  })

  it('worktreeProgress 驱动 creating/failed 状态', () => {
    useStore.setState({ worktreeStandby: { supported: true, gitOk: true } })
    const { getByText } = render(<InputBox onSend={() => {}} />)
    act(() => handleResponse({ op: 'worktreeProgress', phase: 'creating' }, useStore.setState, useStore.getState))
    expect(getByText('正在创建 worktree…')).toBeTruthy()
    act(() => handleResponse({ op: 'worktreeProgress', phase: 'failed', code: 'git-failed' }, useStore.setState, useStore.getState))
    expect(getByText(/worktree 创建失败/)).toBeTruthy()
    expect(useStore.getState().worktreeErrorCode).toBe('git-failed')
  })
})

describe('worktree 元数据接线（0.4.6）', () => {
  it('listSessions 条目携带 worktree → meta map 登记', () => {
    useStore.setState({ currentSessionId: 'sess_wt' })
    handleResponse(
      {
        op: 'listSessions',
        sessions: [
          { sessionId: 'sess_wt', title: 'wt', status: 'idle', mode: 'yolo', workspacePath: 'C:/wt/demo', worktree: { sourceWorkspace: 'G:/proj', cwd: 'C:/wt/demo', worktreeRoot: 'C:/wt/demo', bucket: 'd8b0', startRef: 'HEAD', startSha: '26199ca', origin: 'desktop' } },
        ],
      },
      useStore.setState,
      useStore.getState,
    )
    const meta = useStore.getState().worktreeMetaBySession['sess_wt']
    expect(meta).toBeTruthy()
    expect(meta.bucket).toBe('d8b0')
    expect(meta.origin).toBe('desktop')
  })

  it('createSession 响应带 worktree → 登记并复位待命条', () => {
    useStore.setState({
      creatingSession: true,
      pendingFirstMessage: 'hello',
      worktreeEnabled: true,
      worktreeCreating: 'creating',
    })
    handleResponse(
      { op: 'createSession', sessionId: 'sess_new', worktree: { sourceWorkspace: 'G:/proj', cwd: 'C:/wt/demo', worktreeRoot: 'C:/wt/demo', bucket: 'ab12', startRef: 'feat/x', startSha: 'aa11bb22', origin: 'plugin' } },
      useStore.setState,
      useStore.getState,
    )
    expect(useStore.getState().worktreeMetaBySession['sess_new']?.startRef).toBe('feat/x')
    expect(useStore.getState().worktreeEnabled).toBe(false)
    expect(useStore.getState().worktreeCreating).toBeNull()
  })
})
