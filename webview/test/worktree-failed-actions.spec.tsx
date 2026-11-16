/**
 * worktree 创建失败三键（spec #52 Story 4：重试 / 放弃 worktree 直接发送 / 取消）
 *
 * 背景（0.4.6 评审缺陷HS 同批）：失败时通用错误处理曾清掉 pendingFirstMessage，
 * 重试仅重 Arms 开关、直发也无草稿可发——两键空转且无取消出口。
 * 修复后：worktreeProgress failed 先于 error 回执到达，error 处理按
 * worktreeCreating==='failed' 守卫保草稿；三键各自消费草稿。
 *
 * 覆盖：
 * 1. 失败态渲染三键
 * 2. 重试=保草稿重走懒创建（createSession 带 worktree，暂存不清）
 * 3. 直发=普通创建（createSession 不带 worktree 字段）
 * 4. 取消=解除失败态 + 草稿回填输入框 + 清暂存
 * 5. error 回执守卫：worktree 失败序列后草稿仍在（非 worktree 失败仍清——旧路径不回归）
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

const DRAFT = '帮我把构建脚本迁到 k8s'

// jsdom 的 innerText 是假实现（getter 有私有值、textContent 不落 DOM，agent-enhance.spec
// 同款问题的无条件版）：polyfill 成 textContent，取消回填断言走真实 DOM
Object.defineProperty(HTMLDivElement.prototype, 'innerText', {
  configurable: true,
  get(this: HTMLDivElement) {
    return this.textContent ?? ''
  },
  set(this: HTMLDivElement, v: string) {
    this.textContent = v
  },
})

function setFailedState() {
  useStore.setState({
    currentSessionId: null,
    creatingSession: false,
    streaming: false,
    worktreeStandby: { supported: true, gitOk: true },
    worktreeEnabled: true,
    worktreeCreating: 'failed',
    worktreeErrorCode: 'git-failed',
    pendingFirstMessage: DRAFT,
    pendingFirstAttachments: null,
    pendingFirstScheduledFireAt: null,
  })
}

function failedButtons() {
  const btns = Array.from(document.querySelectorAll('.worktree-bar__failed .worktree-bar__btn')) as HTMLButtonElement[]
  expect(btns.length).toBe(3)
  return btns
}

beforeEach(() => {
  storage.clear()
  sendToJavaMock.mockClear()
  useStore.setState({
    currentSessionId: null,
    creatingSession: false,
    streaming: false,
    worktreeStandby: null,
    worktreeEnabled: false,
    worktreeCreating: null,
    worktreeErrorCode: null,
    worktreeMetaBySession: {},
    pendingFirstMessage: null,
    pendingFirstAttachments: null,
    pendingFirstScheduledFireAt: null,
    sessions: [],
  })
})

afterEach(cleanup)

describe('worktree 创建失败三键（spec #52 Story 4）', () => {
  it('失败态渲染三键：重试创建 / 关闭 worktree 发送 / 取消', () => {
    setFailedState()
    const { getByText } = render(<InputBox onSend={() => {}} />)
    expect(getByText('重试创建')).toBeTruthy()
    expect(getByText('关闭 worktree 发送')).toBeTruthy()
    expect(getByText('取消')).toBeTruthy()
  })

  it('重试=保草稿重走懒创建：createSession 带 worktree，暂存不清', () => {
    setFailedState()
    render(<InputBox onSend={() => {}} />)
    const [retry] = failedButtons()
    fireEvent.click(retry)
    expect(useStore.getState().worktreeCreating).toBeNull()
    expect(useStore.getState().worktreeEnabled).toBe(true)
    expect(useStore.getState().pendingFirstMessage).toBe(DRAFT)
    const cs = (sendToJavaMock.mock.calls.map((c) => c[0] as { op: string; worktree?: unknown }))
      .filter((m) => m.op === 'createSession')
    expect(cs).toHaveLength(1)
    expect(cs[0].worktree).toEqual({ enabled: true })
  })

  it('直发=普通创建：createSession 不带 worktree 字段', () => {
    setFailedState()
    render(<InputBox onSend={() => {}} />)
    const [, sendWithout] = failedButtons()
    fireEvent.click(sendWithout)
    expect(useStore.getState().worktreeEnabled).toBe(false)
    expect(useStore.getState().pendingFirstMessage).toBe(DRAFT)
    const cs = (sendToJavaMock.mock.calls.map((c) => c[0] as { op: string; worktree?: unknown }))
      .filter((m) => m.op === 'createSession')
    expect(cs).toHaveLength(1)
    expect(cs[0].worktree).toBeUndefined()
  })

  it('取消=解除失败态 + 草稿回填输入框 + 清暂存', () => {
    setFailedState()
    const { container } = render(<InputBox onSend={() => {}} />)
    const editor = container.querySelector('[contenteditable]') as HTMLDivElement | null
    expect(editor).toBeTruthy()
    const [,, cancel] = failedButtons()
    fireEvent.click(cancel)
    expect(useStore.getState().worktreeCreating).toBeNull()
    expect(useStore.getState().worktreeEnabled).toBe(false)
    expect(useStore.getState().pendingFirstMessage).toBeNull()
    expect(editor!.textContent).toContain(DRAFT)
    // 取消后无 createSession 外发（用户回编辑态自行处置）
    expect(sendToJavaMock.mock.calls.filter((c) => (c[0] as { op: string }).op === 'createSession')).toHaveLength(0)
  })

  it('error 回执守卫：worktree 失败序列后草稿仍在；非 worktree 失败仍清', () => {
    useStore.setState({
      currentSessionId: null,
      creatingSession: true,
      streaming: true,
      worktreeStandby: { supported: true, gitOk: true },
      worktreeEnabled: true,
      worktreeCreating: 'creating',
      pendingFirstMessage: DRAFT,
    })
    // Java 侧先推 progress failed、后回 error 应答（两通道时序）
    act(() => handleResponse({ op: 'worktreeProgress', phase: 'failed', code: 'git-failed' }, useStore.setState, useStore.getState))
    act(() => handleResponse({ op: 'error', message: 'worktree 创建失败（git-failed）' }, useStore.setState, useStore.getState))
    expect(useStore.getState().creatingSession).toBe(false)
    expect(useStore.getState().pendingFirstMessage).toBe(DRAFT)

    // 非 worktree 创建失败（无 failed 态）：旧路径不变，草稿清空防卡死
    useStore.setState({ creatingSession: true, pendingFirstMessage: '另一个草稿', worktreeCreating: null })
    act(() => handleResponse({ op: 'error', message: 'boom' }, useStore.setState, useStore.getState))
    expect(useStore.getState().pendingFirstMessage).toBeNull()
  })
})
