// @vitest-environment jsdom
/**
 * 计划审批面板 dock 形态（issue #17，0.3.7）
 *
 * 改造：计划与审批分离——审批面板底部停靠非模态（对齐询问弹窗 dock 形态），
 * 计划全文走「查看完整计划」按钮开全局预览弹窗；意见框改多行 textarea；
 * 无超时等待（Java 侧取消 5min 自动 decline，不再推 deadlineMs）。
 *
 * 断言：
 *   1. dock 类挂载：overlay 带 --dock、面板可折叠（收起只留 header 一行）
 *   2. 无 deadlineMs 时渲染「已等待」正计时而非倒计时
 *   3. 意见框为多行 textarea（Enter 换行、Ctrl+Enter 提交）；意见空时「继续规划」禁用
 *   4. 「查看完整计划」打开全局预览浮层（openMarkdownPreview）
 *   5. 三应答路径回传形状不变：approve 严格小写 / feedback 意见文本 / decline 裸拒绝
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const sendToJavaMock = vi.fn()
let streamEventHandler: ((sid: string, event: unknown) => void) | null = null
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null
let messageHandler: ((msg: Record<string, unknown>) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: Record<string, unknown>) => void) => { messageHandler = fn },
  onStreamEvent: (fn: (sid: string, event: unknown) => void) => { streamEventHandler = fn },
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (...args: unknown[]) => sendToJavaMock(...args),
}))

import * as React from 'react'
import { useStore } from '@/store/useStore'
import { PlanApprovalDialog } from '@/components/PlanApprovalDialog'

function renderPanel(over: Partial<Parameters<typeof PlanApprovalDialog>[0]> = {}) {
  return render(
    <PlanApprovalDialog
      requestId="req_plan_1"
      plan="# 计划\n1. 步骤一"
      onClose={() => useStore.setState({ exitPlanApproval: null })}
      {...over}
    />,
  )
}

beforeEach(() => {
  sendToJavaMock.mockClear()
  useStore.getState().init()
  useStore.setState({ connectionStatus: 'mock', markdownPreview: null })
})

afterEach(cleanup)

describe('dock 形态与折叠', () => {
  it('overlay 带 --dock 类；收起后只留 header（body/footer 不渲染）', () => {
    const { container } = renderPanel()
    const overlay = container.querySelector('.plan-approval-overlay')
    expect(overlay?.classList.contains('plan-approval-overlay--dock')).toBe(true)
    expect(container.querySelector('.plan-approval-dialog__feedback-input')).toBeTruthy()

    fireEvent.click(screen.getByTitle('收起'))
    expect(container.querySelector('.plan-approval-dialog__feedback-input')).toBeNull()
    expect(container.querySelector('.plan-approval-dialog__view-plan')).toBeNull()

    // 收起态点 header 展开
    fireEvent.click(container.querySelector('.plan-approval-dialog__header')!)
    expect(container.querySelector('.plan-approval-dialog__feedback-input')).toBeTruthy()
  })
})

describe('无超时等待', () => {
  it('无 deadlineMs：渲染已等待正计时（已等待 title），不渲染倒计时 title', () => {
    renderPanel({ askedAt: Date.now() })
    // DialogElapsed 与 DialogCountdown 共用 .dialog-countdown 类名，按 title 文案区分
    expect(document.querySelector('[title="提问自动继续已关闭：将一直等待你的回答"]')).toBeTruthy()
    expect(document.querySelector('[title="长时间未应答将超时，自动视为拒绝并关闭弹窗"]')).toBeNull()
  })
})

describe('意见输入（多行 textarea）', () => {
  it('Enter 换行不提交；Ctrl+Enter 提交意见；空意见禁用继续规划', () => {
    renderPanel()
    const ta = document.querySelector('.plan-approval-dialog__feedback-input') as HTMLTextAreaElement
    expect(ta).toBeTruthy()
    expect(ta.tagName).toBe('TEXTAREA')

    const feedbackBtn = screen.getByRole('button', { name: /继续规划/ })
    expect((feedbackBtn as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(ta, { target: { value: '把第二步拆细' } })
    expect((feedbackBtn as HTMLButtonElement).disabled).toBe(false)

    // 裸 Enter：换行，不提交
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(sendToJavaMock).not.toHaveBeenCalled()

    // Ctrl+Enter：提交意见
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true })
    expect(sendToJavaMock).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'askUserResponse', requestId: 'req_plan_1', action: 'accept', answer: '把第二步拆细' }),
    )
  })

  it('行为说明动态切换：无意见=按钮后果；有意见=明确批准不附带意见（消歧义）', () => {
    const { container } = renderPanel()
    const tip = () => container.querySelector('.plan-approval-dialog__tip')!.textContent!
    // 意见为空：说明三按钮后果
    expect(tip()).toContain('批准执行')
    expect(tip()).not.toContain('不会附带')

    const ta = container.querySelector('.plan-approval-dialog__feedback-input') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '改一下' } })
    // 有意见：明示「继续规划」提交意见、批准不带意见
    expect(tip()).toContain('不会附带')
    expect(tip()).toContain('继续规划')
  })
})

describe('查看完整计划', () => {
  it('点击打开全局预览浮层（openMarkdownPreview：title+markdown 全文）', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /查看完整计划/ }))
    const preview = useStore.getState().markdownPreview
    expect(preview).toBeTruthy()
    expect(preview!.markdown).toContain('# 计划')
  })

  it('短计划：完整显示摘要（无限高形态），按钮为流式条形', () => {
    const { container } = renderPanel()
    expect(container.querySelector('.plan-approval-dialog__summary--clipped')).toBeNull()
    expect(container.querySelector('.plan-approval-dialog__view-plan--overlay')).toBeNull()
    // 摘要区渲染了 markdown 内容
    expect(container.querySelector('.plan-approval-dialog__summary')!.textContent).toContain('步骤一')
  })

  it('长计划：摘要限高渐隐（--clipped）+ 悬浮「查看完整计划」按钮', () => {
    const longPlan = Array.from({ length: 30 }, (_, i) => `${i + 1}. 第${i + 1}步做一些事情`).join('\n')
    const { container } = renderPanel({ plan: longPlan })
    expect(container.querySelector('.plan-approval-dialog__summary--clipped')).toBeTruthy()
    expect(container.querySelector('.plan-approval-dialog__view-plan--overlay')).toBeTruthy()
    // 悬浮按钮同样能打开全文预览
    fireEvent.click(container.querySelector('.plan-approval-dialog__view-plan--overlay')!)
    expect(useStore.getState().markdownPreview?.markdown).toContain('第30步')
  })
})

describe('三应答路径形状', () => {
  it('批准：answer 严格小写 approve + 乐观切模式 + planApprovalAnswer 标记', () => {
    useStore.setState({ currentMode: 'plan', prePlanMode: 'build', agentPlanActive: true })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /批准执行/ }))

    expect(sendToJavaMock).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'askUserResponse', requestId: 'req_plan_1', action: 'accept', answer: 'approve' }),
    )
    const st = useStore.getState()
    expect(st.planApprovalAnswer).toBe('approve')
    expect(st.currentMode).toBe('build')
    expect(st.agentPlanActive).toBe(false)
  })

  it('裸拒绝：action=decline 无 answer；UI 留在 plan', () => {
    useStore.setState({ currentMode: 'plan', prePlanMode: 'build' })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }))

    expect(sendToJavaMock).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'askUserResponse', requestId: 'req_plan_1', action: 'decline' }),
    )
    const st = useStore.getState()
    expect(st.planApprovalAnswer).toBe('decline')
    expect(st.currentMode).toBe('plan')
  })
})
