// @vitest-environment jsdom
/**
 * 钩子新建/编辑弹窗（HookEditDialog）测试
 *
 * 覆盖：
 *   1. 新建默认态：事件默认 PreToolUse、运行方式 Shell 命令、命令为空时保存禁用
 *   2. command 型保存载荷：matcher 空不进载荷、shell/async/timeout(秒) 按填写序列化
 *   3. process 型字段切换：显示参数多行（按行拆 args）与超时毫秒；隐藏 Shell/后台运行
 *   4. 超时非法值内联报错且不发 op
 *   5. 编辑预填：item+raw 回显、作用域锁定、保存带 reviewItemId/sourcePath、删除入口
 *   6. 保存成功对账回包（sourceOp=workspaceHooksSave）关弹窗；失败内联报错复位 saving
 *   7. 工作区作用域信任提示；用户级不显示
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const sendToJavaMock = vi.fn()
let messageHandler: ((msg: Record<string, unknown>) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: Record<string, unknown>) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (...args: unknown[]) => sendToJavaMock(...args),
}))

import { HookEditDialog, type HookEditTarget } from '@/components/HookEditDialog'
import { useStore } from '@/store/useStore'
import type { WorkspaceHooksStatusItem } from '@/types/messages'

function makeItem(over: Partial<WorkspaceHooksStatusItem> = {}): WorkspaceHooksStatusItem {
  return {
    reviewItemId: 'workspace-hook-0-PreToolUse-0-0',
    event: 'PreToolUse',
    matcher: 'Bash',
    displayCommand: 'bash hook.sh',
    sourcePath: '.zcode/config.json',
    configuredEnabled: true,
    hookDeclarationDigest: 'digest-h1',
    trustState: 'trusted_persistent',
    ...over,
  }
}

function renderDialog(target: HookEditTarget, raw: Record<string, unknown> = {}, onClose = vi.fn(), onRequestDelete = vi.fn()) {
  return render(
    <HookEditDialog
      target={target}
      raw={raw as never}
      onClose={onClose}
      onRequestDelete={onRequestDelete}
    />,
  )
}

function lastSend() {
  return sendToJavaMock.mock.calls[sendToJavaMock.mock.calls.length - 1][0] as Record<string, unknown>
}

beforeEach(() => {
  sendToJavaMock.mockClear()
  messageHandler = null
  // i18n 初始化跟随 store.init（不 init 会渲染出原始 key）
  useStore.getState().init()
  useStore.setState({ connectionStatus: 'mock' })
})

afterEach(cleanup)

describe('新建默认态与保存载荷', () => {
  it('默认事件 PreToolUse / Shell 命令型；命令为空保存禁用', () => {
    const { container } = renderDialog({ scope: 'workspace', workspace: 'G:\\mock', item: null })
    expect(screen.getByText('新建钩子')).toBeTruthy()
    expect((screen.getByLabelText('事件') as HTMLSelectElement).value).toBe('PreToolUse')
    expect((screen.getByLabelText('运行方式') as HTMLSelectElement).value).toBe('command')
    expect(screen.getByLabelText('Shell')).toBeTruthy()
    expect(screen.getByText('后台运行')).toBeTruthy()
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(container.querySelector('.hook-edit__delete')).toBeNull()
  })

  it('填命令后保存：matcher 空不进载荷；shell/async/timeout(秒) 按填写序列化', () => {
    renderDialog({ scope: 'workspace', workspace: 'G:\\mock', item: null })
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: "  echo 'hi'  " } })
    fireEvent.change(screen.getByLabelText(/匹配器/), { target: { value: '   ' } })
    fireEvent.change(screen.getByLabelText('Shell'), { target: { value: 'bash' } })
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByText('高级'))
    fireEvent.change(screen.getByLabelText('超时（秒）'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(sendToJavaMock).toHaveBeenCalledTimes(1)
    const req = lastSend()
    expect(req.op).toBe('workspaceHooksSave')
    expect(req.scope).toBe('workspace')
    expect(req.workspace).toBe('G:\\mock')
    expect(req.payload).toEqual({
      event: 'PreToolUse',
      type: 'command',
      command: "echo 'hi'",
      shell: 'bash',
      async: true,
      timeout: 30,
    })
    expect(req.reviewItemId).toBeUndefined()
  })

  it('进程型：切换后显示参数多行与超时毫秒、隐藏 Shell/后台运行；args 按行拆进载荷', () => {
    renderDialog({ scope: 'user', item: null })
    fireEvent.change(screen.getByLabelText('运行方式'), { target: { value: 'process' } })

    expect(screen.queryByLabelText('Shell')).toBeNull()
    expect(screen.queryByText('后台运行')).toBeNull()
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'node' } })
    fireEvent.change(screen.getByLabelText(/参数/), { target: { value: 'hook.js\n\n--verbose\n  ' } })
    fireEvent.click(screen.getByText('高级'))
    fireEvent.change(screen.getByLabelText('超时（毫秒）'), { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    const req = lastSend()
    expect(req.scope).toBe('user')
    expect(req.payload).toEqual({
      event: 'PreToolUse',
      type: 'process',
      command: 'node',
      args: ['hook.js', '--verbose'],
      timeoutMs: 5000,
    })
  })

  it('用户级新建不显示工作区信任提示；工作区显示', () => {
    const user = renderDialog({ scope: 'user', item: null })
    expect(user.container.textContent).not.toContain('重新信任')
    cleanup()
    const ws = renderDialog({ scope: 'workspace', workspace: 'G:\\mock', item: null })
    expect(ws.container.textContent).toContain('重新信任')
  })
})

describe('校验与错误', () => {
  it('超时非法（负数）内联报错且不发 op', () => {
    renderDialog({ scope: 'user', item: null })
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'echo hi' } })
    fireEvent.click(screen.getByText('高级'))
    fireEvent.change(screen.getByLabelText('超时（秒）'), { target: { value: '-1' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(sendToJavaMock).not.toHaveBeenCalled()
    expect(screen.getByText('超时须为正数')).toBeTruthy()
  })

  it('保存失败 error（sourceOp=workspaceHooksSave）内联展示且 saving 复位可重试', () => {
    renderDialog({ scope: 'user', item: null })
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'echo hi' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect((screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement).disabled).toBe(true)

    act(() => {
      messageHandler!({ op: 'error', message: '钩子保存失败：非法事件名', sourceOp: 'workspaceHooksSave' })
    })
    expect(screen.getByText('钩子保存失败：非法事件名')).toBeTruthy()
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
  })

  it('保存成功对账回包（sourceOp=workspaceHooksSave）触发 onClose；无 sourceOp 的列表回包不关', () => {
    const onClose = vi.fn()
    renderDialog({ scope: 'user', item: null }, {}, onClose)
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'echo hi' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    act(() => {
      messageHandler!({ op: 'workspaceHooksList', status: { scope: 'user', items: [] } })
    })
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      messageHandler!({
        op: 'workspaceHooksList',
        sourceOp: 'workspaceHooksSave',
        status: { scope: 'user', items: [] },
      })
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('编辑预填与删除入口', () => {
  const item = makeItem()

  it('item+raw 回显：事件/匹配器/命令/args/shell/timeout；作用域锁定；保存带定位字段', () => {
    renderDialog(
      { scope: 'workspace', workspace: 'G:\\mock', item },
      { type: 'command', command: 'bash hook.sh --flag', shell: 'bash', timeout: 15 },
    )
    expect(screen.getByText('编辑钩子')).toBeTruthy()
    expect((screen.getByLabelText('事件') as HTMLSelectElement).value).toBe('PreToolUse')
    expect((screen.getByLabelText(/匹配器/) as HTMLInputElement).value).toBe('Bash')
    expect((screen.getByLabelText('命令') as HTMLInputElement).value).toBe('bash hook.sh --flag')
    expect((screen.getByLabelText('Shell') as HTMLInputElement).value).toBe('bash')
    expect((screen.getByLabelText('作用域') as HTMLSelectElement).disabled).toBe(true)

    // 高级区因原始带超时自动展开
    expect((screen.getByLabelText('超时（秒）') as HTMLInputElement).value).toBe('15')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    const req = lastSend()
    expect(req.reviewItemId).toBe('workspace-hook-0-PreToolUse-0-0')
    expect(req.sourcePath).toBe('.zcode/config.json')
    expect(req.payload).toEqual({
      event: 'PreToolUse',
      type: 'command',
      command: 'bash hook.sh --flag',
      matcher: 'Bash',
      shell: 'bash',
      timeout: 15,
    })
  })

  it('process 型编辑：args 多行回显与超时毫秒权威字段优先', () => {
    renderDialog(
      { scope: 'user', item: makeItem({ matcher: null, event: 'Stop', reviewItemId: 'user-hook-0-Stop-0-0' }) },
      { type: 'process', command: 'node', args: ['a.js', '--b'], timeout: 9, timeoutMs: 8000 },
    )
    expect((screen.getByLabelText('命令') as HTMLInputElement).value).toBe('node')
    expect((screen.getByLabelText(/参数/) as HTMLTextAreaElement).value).toBe('a.js\n--b')
    expect((screen.getByLabelText('超时（毫秒）') as HTMLInputElement).value).toBe('8000')
  })

  it('编辑态显示删除入口，点击转交页面确认流程', () => {
    const onRequestDelete = vi.fn()
    renderDialog({ scope: 'workspace', workspace: 'G:\\mock', item }, { type: 'command', command: 'x' }, vi.fn(), onRequestDelete)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(onRequestDelete).toHaveBeenCalledWith(item)
  })
})
