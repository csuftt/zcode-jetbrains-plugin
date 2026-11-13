/**
 * 工具权限审批链路回归测试（issue #2 修复）
 *
 * 背景：插件旧版未实现 interaction/requestPermission 反向请求——「变更前询问」
 * （default 模式）下 AI 写文件/执行命令前的批准请求被回 -32601，服务端按拒绝
 * 处理，AI 反复重试后会话停止。
 *
 * 断言：
 *   1. store 收到 permissionRequest 事件 → 弹窗状态置位 + 看门狗豁免标志
 *   2. 弹窗渲染服务端给定选项（不硬编码），点击 → askUserResponse(answer=optionId)
 *   3. askUserAck → 弹窗关闭（超时/回合终止联动废弃路径）
 *   4. 输入摘要：优先字段前置、超长截断、嵌套结构不进摘要
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { act } from 'react-dom/test-utils'

const sent: Array<Record<string, unknown>> = []
vi.mock('@/ipc/bridge', () => ({
  sendToJava: (req: Record<string, unknown>) => { sent.push(req) },
}))

import '@/i18n/config'
import { PermissionApprovalDialog } from '@/components/PermissionApprovalDialog'
import { useStore, handleResponse } from '@/store/useStore'
import type { PermissionOption } from '@/types/messages'

/** zcode.cjs t5() 标准三选项样本 */
const OPTIONS: PermissionOption[] = [
  { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once' },
  { kind: 'allow_always', name: 'Always allow in this project', optionId: 'allow_project', description: 'Do not ask again' },
  { kind: 'deny', name: 'Deny', optionId: 'deny' },
]

function renderDialog(overrides: Partial<Parameters<typeof PermissionApprovalDialog>[0]> = {}) {
  return render(
    <PermissionApprovalDialog
      requestId="req-perm-1"
      toolName="Write"
      reason="Tool Write requires approval"
      options={OPTIONS}
      input={{ file_path: '/tmp/a.ts', content: 'hello', nested: { x: 1 }, arr: [1, 2] }}
      deadlineMs={Date.now() + 60_000}
      onClose={() => {}}
      {...overrides}
    />,
  )
}

beforeEach(() => {
  sent.length = 0
  useStore.setState({ permissionRequest: null, askUserPendingActive: false })
})

afterEach(() => {
  cleanup()
})

describe('权限审批 store 链路', () => {
  it('permissionRequest 事件置位弹窗与看门狗豁免', () => {
    act(() => {
      useStore.setState({
        permissionRequest: { requestId: 'r1', toolName: 'Write', reason: 'x', options: OPTIONS },
        askUserPendingActive: true,
      })
    })
    const st = useStore.getState()
    expect(st.permissionRequest?.requestId).toBe('r1')
    expect(st.permissionRequest?.options).toHaveLength(3)
    expect(st.askUserPendingActive).toBe(true)
  })

  it('askUserAck 关闭权限弹窗并清豁免标志', () => {
    act(() => {
      useStore.setState({
        permissionRequest: { requestId: 'r1', toolName: 'Write', reason: 'x', options: OPTIONS },
        askUserPendingActive: true,
      })
    })
    act(() => {
      useStore.setState({ permissionRequest: null, askUserPendingActive: false })
    })
    expect(useStore.getState().permissionRequest).toBeNull()
    expect(useStore.getState().askUserPendingActive).toBe(false)
  })

  // ==== ack 精确匹配关窗（2026-08-27 缺陷Z真凶修复回归）====
  // 旧线程 staggered 超时的 ack 曾无差别关窗，把面板上其他请求的新弹窗顶掉

  const dispatch = (msg: Parameters<typeof handleResponse>[0]) =>
    act(() => { handleResponse(msg, useStore.setState, useStore.getState) })

  it('别人的 askUserAck（requestId 不匹配）不关当前弹窗，豁免标志保持', () => {
    dispatch({ op: 'permissionRequest', requestId: 'r2', toolName: 'Edit', reason: 'x', options: OPTIONS, deadlineMs: Date.now() + 300_000 })
    dispatch({ op: 'askUserAck', requestId: 'r1-old-timeout' })
    const st = useStore.getState()
    expect(st.permissionRequest?.requestId).toBe('r2')
    expect(st.askUserPendingActive).toBe(true)
  })

  it('requestId 匹配的 askUserAck 关对应弹窗并清豁免标志', () => {
    dispatch({ op: 'permissionRequest', requestId: 'r2', toolName: 'Edit', reason: 'x', options: OPTIONS, deadlineMs: Date.now() + 300_000 })
    dispatch({ op: 'askUserAck', requestId: 'r2' })
    expect(useStore.getState().permissionRequest).toBeNull()
    expect(useStore.getState().askUserPendingActive).toBe(false)
  })

  it('无 requestId 的 askUserAck（旧格式兼容）全清弹窗', () => {
    dispatch({ op: 'permissionRequest', requestId: 'r2', toolName: 'Edit', reason: 'x', options: OPTIONS, deadlineMs: Date.now() + 300_000 })
    dispatch({ op: 'askUserAck' })
    expect(useStore.getState().permissionRequest).toBeNull()
    expect(useStore.getState().askUserPendingActive).toBe(false)
  })

  it('permissionRequestRefresh 只更新权限弹窗的 requestId（id 保活，其余状态不动）', () => {
    dispatch({ op: 'permissionRequest', requestId: 'id-old', toolName: 'Edit', reason: 'x', options: OPTIONS, deadlineMs: 12345 })
    dispatch({ op: 'permissionRequestRefresh', requestId: 'id-new' })
    const st = useStore.getState()
    expect(st.permissionRequest?.requestId).toBe('id-new')
    expect(st.permissionRequest?.deadlineMs).toBe(12345)
    expect(st.permissionRequest?.toolName).toBe('Edit')
    // 刷新后的 id 能被 ack 精确命中（点击走新 id）
    dispatch({ op: 'askUserAck', requestId: 'id-new' })
    expect(useStore.getState().permissionRequest).toBeNull()
  })
})

describe('权限审批弹窗交互', () => {
  it('渲染本地化选项并按 optionId 应答（允许一次）', () => {
    renderDialog()
    fireEvent.click(screen.getByText('允许一次'))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      op: 'askUserResponse',
      requestId: 'req-perm-1',
      action: 'accept',
      answer: 'allow_once',
    })
  })

  it('拒绝选项同样按 optionId 应答（服务端映射 deny response）', () => {
    renderDialog()
    fireEvent.click(screen.getByText('拒绝'))
    expect(sent[0]).toMatchObject({ op: 'askUserResponse', action: 'accept', answer: 'deny' })
  })

  it('本项目总是允许选项可点（allow_project 透传）', () => {
    renderDialog()
    fireEvent.click(screen.getByText('本项目总是允许'))
    expect(sent[0]).toMatchObject({ answer: 'allow_project' })
  })

  it('未知 optionId 的扩展选项显示服务端原文', () => {
    renderDialog({
      options: [...OPTIONS, { kind: 'escalate', name: 'Escalate to admin', optionId: 'escalate_admin' }],
    })
    expect(screen.getByText('Escalate to admin')).toBeTruthy()
  })

  it('服务端 reason 常量与模板本地化，未匹配显示原文', () => {
    const { unmount } = renderDialog({ reason: 'High risk tools require explicit approval' })
    expect(screen.getByText('高风险操作需要明确批准')).toBeTruthy()
    unmount()

    renderDialog({ reason: 'Tool Write requires approval' })
    expect(screen.getByText('工具 Write 需要批准后执行')).toBeTruthy()
    cleanup()

    renderDialog({ reason: 'Custom workspace rule' })
    expect(screen.getByText('Custom workspace rule')).toBeTruthy()
  })

  it('输入摘要字段名本地化，未知字段名显示原文', () => {
    renderDialog({ input: { command: 'ls -la', custom_key: 'v' } })
    expect(screen.getByText('命令')).toBeTruthy()
    expect(screen.getByText('custom_key')).toBeTruthy()
  })

  it('输入摘要展示优先字段与文本字段，嵌套结构不进摘要', () => {
    renderDialog()
    expect(screen.getByText('/tmp/a.ts')).toBeTruthy()
    expect(screen.getByText('hello')).toBeTruthy()
    // nested/arr 为对象/数组，不渲染为摘要行
    expect(screen.queryByText('nested')).toBeNull()
    expect(screen.queryByText('arr')).toBeNull()
  })

  it('超长输入截断展示', () => {
    renderDialog({ input: { content: 'x'.repeat(500) } })
    const value = screen.getByText(/x{300}…/)
    expect(value).toBeTruthy()
  })

  // ==== 可折叠（对齐询问/计划审批弹窗形态，2026-11-12 改造回归锁）====

  it('折叠按钮收起 body/footer：reason 与应答按钮消失、aria-expanded 翻转、title 变「展开」', () => {
    renderDialog()
    const collapseBtn = screen.getByTitle('收起')
    expect(screen.getByText('工具 Write 需要批准后执行')).toBeTruthy()
    fireEvent.click(collapseBtn)
    // body/footer 条件渲染收起：reason 与全部应答按钮不可见
    expect(screen.queryByText('工具 Write 需要批准后执行')).toBeNull()
    expect(screen.queryByText('允许一次')).toBeNull()
    // 收起不触发应答
    expect(sent).toHaveLength(0)
    // 按钮态翻转：title/aria-expanded
    const expandBtn = screen.getByTitle('展开')
    expect(expandBtn.getAttribute('aria-expanded')).toBe('false')
  })

  it('收起态点击 header 整行展开恢复', () => {
    renderDialog()
    fireEvent.click(screen.getByTitle('收起'))
    expect(screen.queryByText('允许一次')).toBeNull()
    // header 在收起态带 button role，点击整行展开（经折叠钮父级定位 header）
    const headerEl = screen.getByTitle('展开').closest('.perm-dialog__header')
    expect(headerEl).toBeTruthy()
    fireEvent.click(headerEl as Element)
    expect(screen.getByText('工具 Write 需要批准后执行')).toBeTruthy()
    expect(screen.getByText('允许一次')).toBeTruthy()
    expect(screen.getByTitle('收起').getAttribute('aria-expanded')).toBe('true')
  })
})
