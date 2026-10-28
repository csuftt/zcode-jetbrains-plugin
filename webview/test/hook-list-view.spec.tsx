// @vitest-environment jsdom
/**
 * 钩子管理页（HookListView）测试
 *
 * 覆盖：
 *   1. 挂载即拉列表（workspaceHooksList），响应前 loading；响应到达渲染事件/匹配器/命令/徽标
 *   2. 搜索前端过滤
 *   3. 安全提示横幅：存在未信任钩子时显示，全部信任后消失（与官方同一判定）
 *   4. 未信任行：行内「信任」按钮（单 digest grant），开关强制关闭且禁用
 *   5. 乐观更新：点信任/开关瞬间翻转，权威响应到达后对账
 *   6. error 响应：丢弃乐观覆盖回退到上一份权威状态并报错
 *   7. 点命令块 → openFile 拼工作区根；无工作区；无「全部信任」批量按钮
 *   8. 删除：垃圾桶按钮 → 二次确认弹窗（只删登记项、脚本保留）；确认乐观消行发 delete；
 *      取消不发；error 回退重现；来源门禁由 Kotlin 写操作兜底
 *   9. 作用域缓存：挂载并行预取工作区+用户级，切换零请求、缓存即时呈现；
 *      迟到响应按自身 scope 落账不影响当前视图；刷新按钮才重拉当前域
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

import * as React from 'react'
import { useStore } from '@/store/useStore'
import { HookListView } from '@/components/HookListView'
import type { WorkspaceHooksStatus, WorkspaceHooksStatusItem } from '@/types/messages'

function makeItem(over: Partial<WorkspaceHooksStatusItem> = {}): WorkspaceHooksStatusItem {
  return {
    reviewItemId: 'workspace-hook-0-UserPromptSubmit-0-0',
    event: 'UserPromptSubmit',
    matcher: null,
    displayCommand: 'bash hook.sh',
    sourcePath: '.zcode/config.json',
    configuredEnabled: true,
    hookDeclarationDigest: 'digest-h1',
    trustState: 'pending_trust',
    ...over,
  }
}

function makeStatus(over: Partial<WorkspaceHooksStatus> = {}): WorkspaceHooksStatus {
  return {
    workspacePath: 'G:/mock',
    workspaceIdentity: 'g:/mock',
    bundleDigest: 'digest-b1',
    items: [
      makeItem(),
      makeItem({
        reviewItemId: 'workspace-hook-0-PreToolUse-0-0',
        event: 'PreToolUse',
        matcher: 'Bash',
        displayCommand: 'node block.js',
        hookDeclarationDigest: 'digest-h2',
        trustState: 'trusted_persistent',
      }),
    ],
    ...over,
  }
}

/** 模拟 Kotlin 推列表响应（act 包裹，zustand 外的状态变更需 flush） */
function pushStatus(status: WorkspaceHooksStatus) {
  act(() => {
    messageHandler!({ op: 'workspaceHooksList', status })
  })
}

function pushError(message: string, sourceOp = 'workspaceHooksList') {
  act(() => {
    messageHandler!({ op: 'error', message, sourceOp })
  })
}

function rows() {
  return Array.from(document.querySelectorAll('.hook-row'))
}

function rowSwitch(i: number): HTMLButtonElement {
  return rows()[i].querySelector('.hook-switch') as HTMLButtonElement
}

beforeEach(() => {
  sendToJavaMock.mockClear()
  useStore.getState().init()
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: 'sess_1',
    currentWorkspacePath: 'G:\\mock',
  })
})

afterEach(cleanup)

describe('拉取与渲染', () => {
  it('挂载即并行预取工作区与用户级两个作用域，响应前显示加载中', () => {
    const { container } = render(<HookListView />)
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'workspaceHooksList', workspace: 'G:\\mock', scope: 'workspace' })
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'workspaceHooksList', scope: 'user' })
    expect(container.textContent).toContain('加载中')
  })

  it('根开关缺失（rootEnabled:false）显示警告与打开配置入口，rootEnabled:true 不显示', () => {
    const { container } = render(<HookListView />)
    pushStatus(makeStatus({ rootEnabled: false }))
    expect(container.textContent).toContain('hooks.enabled:true')
    expect(container.querySelector('.hook-list__notice-action')).toBeTruthy()

    cleanup()
    const { container: c2 } = render(<HookListView />)
    pushStatus(makeStatus({ rootEnabled: true }))
    expect(c2.textContent).not.toContain('hooks.enabled:true')
    expect(c2.querySelector('.hook-list__notice-action')).toBeNull()
  })

  it('响应到达后渲染事件/匹配器/命令/信任徽标与已安装计数', () => {
    const { container } = render(<HookListView />)
    pushStatus(makeStatus())

    expect(rows()).toHaveLength(2)
    expect(container.textContent).toContain('UserPromptSubmit')
    expect(container.textContent).toContain('PreToolUse')
    expect(container.textContent).toContain('Bash')
    expect(container.textContent).toContain('bash hook.sh')
    expect(container.textContent).toContain('node block.js')
    expect(container.textContent).toContain('已安装 2')
    expect(container.querySelector('.hook-badge--stateTrusted')!.textContent).toContain('已信任')
    expect(container.querySelector('.hook-badge--stateUntrusted')!.textContent).toContain('未信任')
  })

  it('空 items 显示空态', () => {
    const { container } = render(<HookListView />)
    pushStatus(makeStatus({ items: [] }))
    expect(container.textContent).toContain('当前工作区没有钩子')
  })

  it('不存在「全部信任」批量按钮', () => {
    render(<HookListView />)
    pushStatus(makeStatus())
    expect(screen.queryByRole('button', { name: '全部信任' })).toBeNull()
  })
})

describe('搜索过滤', () => {
  it('按命令关键字过滤，清空后恢复', () => {
    render(<HookListView />)
    pushStatus(makeStatus())

    fireEvent.change(screen.getByPlaceholderText('搜索事件或命令'), { target: { value: 'block' } })
    expect(rows()).toHaveLength(1)
    expect(document.querySelector('.hook-row')!.textContent).toContain('PreToolUse')

    fireEvent.change(screen.getByPlaceholderText('搜索事件或命令'), { target: { value: '' } })
    expect(rows()).toHaveLength(2)
  })

  it('按事件名匹配', () => {
    render(<HookListView />)
    pushStatus(makeStatus())
    fireEvent.change(screen.getByPlaceholderText('搜索事件或命令'), { target: { value: 'userprompt' } })
    expect(rows()).toHaveLength(1)
  })
})

describe('安全提示横幅', () => {
  it('存在未信任钩子时显示；全部信任后消失', () => {
    const { container } = render(<HookListView />)
    pushStatus(makeStatus())
    const notice = () => container.querySelector('.hook-list__notice')
    expect(notice()!.textContent).toContain('钩子可在沙盒外运行')

    const trusted = makeStatus()
    trusted.items = trusted.items.map((it) => ({ ...it, trustState: 'trusted_persistent' as const }))
    pushStatus(trusted)
    expect(notice()).toBeNull()
  })
})

describe('未信任行：信任按钮与开关禁用', () => {
  it('未信任行显示信任按钮；开关强制关闭且禁用（点击不发 toggle）', () => {
    render(<HookListView />)
    pushStatus(makeStatus())

    const firstRow = rows()[0] as HTMLElement
    const trustBtn = firstRow.querySelector('.hook-row__trust') as HTMLButtonElement
    expect(trustBtn.textContent).toContain('信任')

    const sw = rowSwitch(0)
    expect(sw.disabled).toBe(true)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(sw.title).toBe('请先信任该钩子再启用')
    expect(sw.classList.contains('hook-switch--on')).toBe(false)
    fireEvent.click(sw)
    expect(sendToJavaMock).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'workspaceHooksToggle' }))
  })
})

describe('乐观更新', () => {
  it('点信任：瞬间按已信任渲染（徽标变、按钮消失、开关可用呈开启态），响应到达后保持', () => {
    render(<HookListView />)
    pushStatus(makeStatus())

    fireEvent.click(rows()[0].querySelector('.hook-row__trust') as HTMLButtonElement)
    expect(sendToJavaMock).toHaveBeenCalledWith({
      op: 'workspaceHooksGrant',
      workspace: 'G:\\mock',
      hookDigests: ['digest-h1'],
    })

    // 权威响应未到：乐观态已翻转
    let sw = rowSwitch(0)
    expect(rows()[0].querySelector('.hook-row__trust')).toBeNull()
    expect(rows()[0].querySelector('.hook-badge')!.textContent).toContain('已信任')
    expect(sw.disabled).toBe(false)
    expect(sw.getAttribute('aria-checked')).toBe('true')

    // 权威对账
    const updated = makeStatus()
    updated.items[0] = { ...updated.items[0], trustState: 'trusted_persistent' }
    pushStatus(updated)
    sw = rowSwitch(0)
    expect(rows()[0].querySelector('.hook-row__trust')).toBeNull()
    expect(sw.disabled).toBe(false)
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('已信任行显示撤销信任；点撤销发 revoke 并瞬间回未信任态，失败回退', () => {
    render(<HookListView />)
    pushStatus(makeStatus())

    // 推权威已信任态（第一条）
    const updated = makeStatus()
    updated.items[0] = { ...updated.items[0], trustState: 'trusted_persistent' }
    pushStatus(updated)
    const revokeBtn = rows()[0].querySelector('.hook-row__revoke') as HTMLButtonElement
    expect(revokeBtn).toBeTruthy()
    expect(revokeBtn.textContent).toContain('撤销信任')

    fireEvent.click(revokeBtn)
    expect(sendToJavaMock).toHaveBeenCalledWith({
      op: 'workspaceHooksRevoke',
      workspace: 'G:\\mock',
      hookDigests: ['digest-h1'],
    })
    // 乐观回未信任：撤销按钮消失、信任按钮回归、开关禁用
    expect(rows()[0].querySelector('.hook-row__revoke')).toBeNull()
    expect((rows()[0].querySelector('.hook-row__trust') as HTMLButtonElement).textContent).toContain('信任')
    expect(rowSwitch(0).disabled).toBe(true)

    // 失败回退：error 清乐观覆盖，回到权威已信任态
    pushError('撤销失败', 'workspaceHooksRevoke')
    expect(rows()[0].querySelector('.hook-row__revoke')).toBeTruthy()
    expect(document.body.textContent).toContain('撤销失败')
  })

  it('点开关：瞬间翻转且无需等响应；响应到达后按权威值保持', () => {
    render(<HookListView />)
    pushStatus(makeStatus())

    // 第二条（PreToolUse）已信任可切
    expect(rowSwitch(1).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(rowSwitch(1))

    // 瞬间翻转（此时 pushStatus 尚未发生）
    expect(rowSwitch(1).getAttribute('aria-checked')).toBe('false')
    expect(sendToJavaMock).toHaveBeenCalledWith({
      op: 'workspaceHooksToggle',
      workspace: 'G:\\mock',
      scope: 'workspace',
      reviewItemId: 'workspace-hook-0-PreToolUse-0-0',
      sourcePath: '.zcode/config.json',
      enabled: false,
    })

    const updated = makeStatus()
    updated.items[1] = { ...updated.items[1], configuredEnabled: false }
    pushStatus(updated)
    expect(rowSwitch(1).getAttribute('aria-checked')).toBe('false')
  })

  it('error 响应：丢弃乐观覆盖回退到上一份权威状态并显示错误', () => {
    const { container } = render(<HookListView />)
    pushStatus(makeStatus())

    // 乐观关闭第二条
    fireEvent.click(rowSwitch(1))
    expect(rowSwitch(1).getAttribute('aria-checked')).toBe('false')

    // 失败：回退为权威的开启态
    pushError('写入失败', 'workspaceHooksToggle')
    expect(rowSwitch(1).getAttribute('aria-checked')).toBe('true')
    expect(container.textContent).toContain('写入失败')
  })

  it('无关操作的 error（sourceOp 不带 workspaceHooks 前缀）不清乐观态也不显示', () => {
    const { container } = render(<HookListView />)
    pushStatus(makeStatus())

    // 乐观关闭第二条
    fireEvent.click(rowSwitch(1))
    expect(rowSwitch(1).getAttribute('aria-checked')).toBe('false')

    pushError('send 失败', 'send')
    expect(rowSwitch(1).getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).not.toContain('send 失败')
  })
})

describe('删除钩子（只删登记项，脚本保留）', () => {
  it('每行显示删除按钮；点击弹确认弹窗（事件/命令摘要 + 脚本保留提示），未确认不发 op', () => {
    const { container } = render(<HookListView />)
    pushStatus(makeStatus())

    expect(rows()[0].querySelector('.hook-row__delete')).toBeTruthy()
    expect(rows()[1].querySelector('.hook-row__delete')).toBeTruthy()

    fireEvent.click(rows()[1].querySelector('.hook-row__delete') as HTMLButtonElement)

    const dialog = document.querySelector('.modal-content')!
    expect(dialog.textContent).toContain('删除该钩子？')
    expect(dialog.textContent).toContain('PreToolUse')
    expect(dialog.textContent).toContain('Bash')
    expect(dialog.textContent).toContain('node block.js')
    expect(dialog.textContent).toContain('脚本文件保留')
    expect(sendToJavaMock).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'workspaceHooksDelete' }))
    expect(container.textContent).toContain('删除该钩子？')
  })

  it('确认删除：乐观消行并发 workspaceHooksDelete；权威 status 到达后保持', () => {
    render(<HookListView />)
    pushStatus(makeStatus())

    fireEvent.click(rows()[1].querySelector('.hook-row__delete') as HTMLButtonElement)
    fireEvent.click(document.querySelector('.modal-btn-danger')!)

    expect(sendToJavaMock).toHaveBeenCalledWith({
      op: 'workspaceHooksDelete',
      workspace: 'G:\\mock',
      scope: 'workspace',
      reviewItemId: 'workspace-hook-0-PreToolUse-0-0',
      sourcePath: '.zcode/config.json',
    })
    // 乐观消行（权威 status 未到）
    expect(rows()).toHaveLength(1)
    expect(document.querySelector('.modal-content')).toBeNull()
    expect(rows()[0].textContent).toContain('UserPromptSubmit')

    // 权威对账：只剩一条
    const updated = makeStatus({ items: [makeItem()] })
    pushStatus(updated)
    expect(rows()).toHaveLength(1)
    expect(rows()[0].textContent).toContain('UserPromptSubmit')
  })

  it('取消：弹窗关闭、不发 op、行保留', () => {
    render(<HookListView />)
    pushStatus(makeStatus())

    fireEvent.click(rows()[0].querySelector('.hook-row__delete') as HTMLButtonElement)
    fireEvent.click(document.querySelector('.modal-btn-cancel')!)

    expect(document.querySelector('.modal-content')).toBeNull()
    expect(sendToJavaMock).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'workspaceHooksDelete' }))
    expect(rows()).toHaveLength(2)
  })

  it('error 响应：删除失败回退重现行并显示错误', () => {
    const { container } = render(<HookListView />)
    pushStatus(makeStatus())

    fireEvent.click(rows()[1].querySelector('.hook-row__delete') as HTMLButtonElement)
    fireEvent.click(document.querySelector('.modal-btn-danger')!)
    expect(rows()).toHaveLength(1)

    pushError('删除失败', 'workspaceHooksDelete')
    expect(rows()).toHaveLength(2)
    expect(container.textContent).toContain('删除失败')
  })

  it('删除按钮对所有列表行显示（来源是否可改由 Kotlin 写操作门禁兜底）', () => {
    const status = makeStatus({
      items: [
        makeItem(),
        makeItem({
          reviewItemId: 'workspace-hook-0-PreToolUse-0-0',
          event: 'PreToolUse',
          sourcePath: '../.zcode/config.json',
        }),
      ],
    })
    render(<HookListView />)
    pushStatus(status)

    expect(rows()[0].querySelector('.hook-row__delete')).toBeTruthy()
    expect(rows()[1].querySelector('.hook-row__delete')).toBeTruthy()
  })
})

describe('钩子脚本入口与无工作区', () => {
  it('点命令块：带 displayCommand/sourcePath 走 workspaceHooksOpenScript（Kotlin 解析脚本路径）', () => {
    render(<HookListView />)
    pushStatus(makeStatus())
    fireEvent.click(document.querySelector('.hook-row__command')!)
    expect(sendToJavaMock).toHaveBeenCalledWith({
      op: 'workspaceHooksOpenScript',
      workspace: 'G:\\mock',
      scope: 'workspace',
      displayCommand: 'bash hook.sh',
      sourcePath: '.zcode/config.json',
    })
  })

  it('error 响应后可再次刷新', () => {
    const { container } = render(<HookListView />)
    pushError('CLI 执行失败')
    expect(container.textContent).toContain('CLI 执行失败')
    fireEvent.click(container.querySelector('.hook-list__refresh')!)
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'workspaceHooksList', workspace: 'G:\\mock', scope: 'workspace' })
  })

  it('待命态（无会话 currentWorkspacePath 空）回退 IDE 项目根 projectPath，正常拉取', () => {
    useStore.setState({ currentWorkspacePath: '', projectPath: 'G:\\mock' })
    render(<HookListView />)
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'workspaceHooksList', workspace: 'G:\\mock', scope: 'workspace' })
    pushStatus(makeStatus())
    expect(rows()).toHaveLength(2)
  })

  it('无工作区：工作区 tab 显示提示不发工作区请求，但挂载仍预取用户级且切换零请求', () => {
    useStore.setState({ currentWorkspacePath: '', projectPath: '' })
    const { container } = render(<HookListView />)
    expect(container.textContent).toContain('未打开工作区')
    // 用户级与项目无关，挂载即预取；工作区域请求跳过
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'workspaceHooksList', scope: 'user' })
    expect(sendToJavaMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ op: 'workspaceHooksList', scope: 'workspace' }),
    )

    // 切到用户级不产生新请求（预取缓存）
    const callsBefore = sendToJavaMock.mock.calls.length
    fireEvent.click(screen.getByRole('tab', { name: '用户级' }))
    expect(sendToJavaMock.mock.calls.length).toBe(callsBefore)
  })
})

describe('用户级作用域（~/.zcode/cli/config.json，无信任准入）', () => {
  const USER_CONFIG = 'C:/Users/me/.zcode/cli/config.json'

  function makeUserItem(over: Partial<WorkspaceHooksStatusItem> = {}): WorkspaceHooksStatusItem {
    return {
      reviewItemId: 'user-hook-0-Stop-0-0',
      event: 'Stop',
      matcher: null,
      displayCommand: 'node notify.cjs',
      sourcePath: USER_CONFIG,
      configuredEnabled: true,
      hookDeclarationDigest: '',
      trustState: 'user_scope',
      ...over,
    }
  }

  function makeUserStatus(items: WorkspaceHooksStatusItem[]): WorkspaceHooksStatus {
    return { scope: 'user', userConfigPath: USER_CONFIG, items }
  }

  function pushUserStatus(items: WorkspaceHooksStatusItem[]) {
    act(() => {
      messageHandler!({ op: 'workspaceHooksList', status: makeUserStatus(items) })
    })
  }

  function gotoUserScope() {
    fireEvent.click(screen.getByRole('tab', { name: '用户级' }))
  }

  it('挂载已预取用户级；切换过去零请求；渲染无信任徽标/按钮，开关直接可用', () => {
    const { container } = render(<HookListView />)
    // 挂载预取即含 scope=user（不带 workspace）
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'workspaceHooksList', scope: 'user' })

    const callsBeforeSwitch = sendToJavaMock.mock.calls.length
    gotoUserScope()
    // 切换不重新加载
    expect(sendToJavaMock.mock.calls.length).toBe(callsBeforeSwitch)

    pushUserStatus([
      makeUserItem(),
      makeUserItem({
        reviewItemId: 'user-hook-0-PreToolUse-0-0',
        event: 'PreToolUse',
        matcher: 'Bash',
        displayCommand: 'bash heal.sh',
        configuredEnabled: false,
      }),
    ])

    expect(rows()).toHaveLength(2)
    expect(container.querySelector('.hook-badge')).toBeNull()
    expect(container.querySelector('.hook-row__trust')).toBeNull()
    // 全局生效的中性提示，无未信任警告横幅
    expect(container.textContent).toContain('对所有项目生效')
    expect(container.querySelector('.hook-list__notice--info')).toBeTruthy()
    expect(container.querySelector('.hook-list__notice:not(.hook-list__notice--info)')).toBeNull()
    // 第一条启用：开关可用且 on；第二条 off 也可点
    expect(rowSwitch(0).disabled).toBe(false)
    expect(rowSwitch(0).getAttribute('aria-checked')).toBe('true')
    expect(rowSwitch(1).getAttribute('aria-checked')).toBe('false')
  })

  it('开关/删除/点命令均带 scope=user 且不带 workspace', () => {
    render(<HookListView />)
    gotoUserScope()
    pushUserStatus([makeUserItem()])

    fireEvent.click(rowSwitch(0))
    expect(sendToJavaMock).toHaveBeenCalledWith({
      op: 'workspaceHooksToggle',
      scope: 'user',
      reviewItemId: 'user-hook-0-Stop-0-0',
      sourcePath: USER_CONFIG,
      enabled: false,
    })

    fireEvent.click(document.querySelector('.hook-row__command')!)
    expect(sendToJavaMock).toHaveBeenCalledWith({
      op: 'workspaceHooksOpenScript',
      scope: 'user',
      displayCommand: 'node notify.cjs',
      sourcePath: USER_CONFIG,
    })

    fireEvent.click(rows()[0].querySelector('.hook-row__delete') as HTMLButtonElement)
    fireEvent.click(document.querySelector('.modal-btn-danger')!)
    expect(sendToJavaMock).toHaveBeenCalledWith({
      op: 'workspaceHooksDelete',
      scope: 'user',
      reviewItemId: 'user-hook-0-Stop-0-0',
      sourcePath: USER_CONFIG,
    })
    expect(rows()).toHaveLength(0)
  })

  it('空列表显示用户级空态', () => {
    const { container } = render(<HookListView />)
    gotoUserScope()
    pushUserStatus([])
    expect(container.textContent).toContain('用户级暂无钩子')
  })

  it('两域数据缓存后双向切换零请求且即时呈现', () => {
    render(<HookListView />)
    pushStatus(makeStatus())
    pushUserStatus([makeUserItem()])

    // 工作区 → 用户级：无新请求，立即出用户级行
    let callsBefore = sendToJavaMock.mock.calls.length
    gotoUserScope()
    expect(sendToJavaMock.mock.calls.length).toBe(callsBefore)
    expect(rows()).toHaveLength(1)
    expect(rows()[0].textContent).toContain('notify.cjs')

    // 用户级 → 工作区：无新请求，立即出工作区缓存行
    callsBefore = sendToJavaMock.mock.calls.length
    fireEvent.click(screen.getByRole('tab', { name: /mock/ }))
    expect(sendToJavaMock.mock.calls.length).toBe(callsBefore)
    expect(rows()).toHaveLength(2)
  })

  it('响应按自身 scope 落账：用户视图下来迟的工作区响应只更新工作区缓存', () => {
    render(<HookListView />)
    pushStatus(makeStatus())
    gotoUserScope()
    pushUserStatus([makeUserItem()])
    expect(rows()).toHaveLength(1)

    // 工作区慢响应（CLI ~1s）到达：不进用户视图，但进工作区缓存
    act(() => {
      messageHandler!({ op: 'workspaceHooksList', status: { ...makeStatus(), scope: 'workspace' } })
    })
    expect(rows()).toHaveLength(1)
    expect(document.querySelector('.hook-badge')).toBeNull()

    // 切回工作区零请求，直接看到刚落账的数据
    const callsBefore = sendToJavaMock.mock.calls.length
    fireEvent.click(screen.getByRole('tab', { name: /mock/ }))
    expect(sendToJavaMock.mock.calls.length).toBe(callsBefore)
    expect(rows()).toHaveLength(2)
  })

  it('刷新按钮只重拉当前作用域', () => {
    render(<HookListView />)
    pushUserStatus([makeUserItem()])
    gotoUserScope()
    sendToJavaMock.mockClear()
    fireEvent.click(document.querySelector('.hook-list__refresh')!)
    expect(sendToJavaMock).toHaveBeenCalledTimes(1)
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'workspaceHooksList', scope: 'user' })
  })

  it('打开配置按钮：工作区 tab 拼 .zcode/config.json；用户级 tab 用响应里的 userConfigPath', () => {
    render(<HookListView />)
    pushStatus(makeStatus())
    const openBtnTitle = '打开配置文件'
    fireEvent.click(document.querySelector(`.hook-list__icon-btn[title="${openBtnTitle}"]`)!)
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'openFile', filePath: 'G:\\mock/.zcode/config.json' })

    gotoUserScope()
    pushUserStatus([makeUserItem()])
    fireEvent.click(document.querySelector(`.hook-list__icon-btn[title="${openBtnTitle}"]`)!)
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'openFile', filePath: USER_CONFIG })
  })
})
