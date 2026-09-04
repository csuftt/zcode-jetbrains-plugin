/**
 * 弹窗分层定案（2026-09-02 缺陷修复 + 用户细化定案）：
 * - 报告弹窗与详情弹窗是**互斥切换**（过程↔结论 头部按钮来回切，不叠两层）
 * - Markdown 预览（工具 📖：网页结果/Skill 文档）是详情之上的**阅读层叠加**，
 *   关预览后详情仍在（用户实测要的保留场景）
 * - Esc 分层：叠开时只关最上层（预览），再按才关详情
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  openExternalUrl: () => {},
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { SubagentDetailDialog } from '@/components/SubagentDetailDialog'
import { MarkdownPreviewDialog } from '@/components/MarkdownPreviewDialog'

const DETAIL_KEY = 'call_stack_1'
const PREVIEW = { title: '网页获取 · x.com', markdown: '# 阅读内容' }
const REPORT = { callID: DETAIL_KEY, title: '子代理最终报告', markdown: '# 报告正文' }

function renderDialogs() {
  return render(
    <>
      <SubagentDetailDialog />
      <MarkdownPreviewDialog />
    </>,
  )
}

beforeEach(() => {
  useStore.setState({
    subagentDetail: DETAIL_KEY,
    subagentReport: null,
    markdownPreview: null,
    agents: [{ callID: DETAIL_KEY, status: 'completed', description: '分层测试任务' }],
    subagentActivities: [],
    subagents: [],
    childMessages: {},
    childLiveMessages: {},
    childMessagesLoading: false,
    childMessagesError: null,
    childSessionKeys: {},
    messages: [],
  })
})

afterEach(() => cleanup())

describe('弹窗分层：store 状态语义', () => {
  it('报告 = 互斥切换：从详情开报告即关详情，关报告不回详情（用户定案）', () => {
    useStore.getState().openSubagentReport(REPORT)
    expect(useStore.getState().subagentReport).toEqual(REPORT)
    expect(useStore.getState().subagentDetail).toBeNull()
    useStore.getState().closeSubagentReport()
    expect(useStore.getState().subagentReport).toBeNull()
    expect(useStore.getState().subagentDetail).toBeNull()
  })

  it('预览 = 阅读层叠加：详情开着 → 开预览详情保留；关预览详情仍在（缺陷修复点）', () => {
    useStore.getState().openMarkdownPreview(PREVIEW)
    expect(useStore.getState().markdownPreview).toEqual(PREVIEW)
    expect(useStore.getState().subagentDetail).toBe(DETAIL_KEY)
    useStore.getState().closeMarkdownPreview()
    expect(useStore.getState().markdownPreview).toBeNull()
    expect(useStore.getState().subagentDetail).toBe(DETAIL_KEY)
  })

  it('预览与报告互斥（同时只读一个）；重新开详情清阅读层（焦点切换语义保留）', () => {
    const st = useStore.getState()
    st.openMarkdownPreview(PREVIEW)
    st.openSubagentReport(REPORT)
    expect(useStore.getState().markdownPreview).toBeNull()
    expect(useStore.getState().subagentReport).toEqual(REPORT)
    st.openMarkdownPreview(PREVIEW)
    expect(useStore.getState().subagentReport).toBeNull()
    st.openSubagentDetail(DETAIL_KEY)
    expect(useStore.getState().markdownPreview).toBeNull()
    expect(useStore.getState().subagentDetail).toBe(DETAIL_KEY)
  })
})

describe('弹窗分层：Esc 与遮罩渲染', () => {
  it('详情+预览叠开：按一次 Esc 只关预览，详情不动；再按才关详情', () => {
    act(() => { useStore.getState().openMarkdownPreview(PREVIEW) })
    renderDialogs()
    expect(screen.getByText('网页获取 · x.com')).toBeTruthy()
    expect(document.querySelectorAll('.subagent-detail-overlay').length).toBe(2)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().markdownPreview).toBeNull()
    expect(useStore.getState().subagentDetail).toBe(DETAIL_KEY)
    expect(document.querySelectorAll('.subagent-detail-overlay').length).toBe(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().subagentDetail).toBeNull()
    expect(document.querySelector('.subagent-detail-overlay')).toBeNull()
  })

  it('叠开时预览 overlay 加 --stacked（遮罩透明），独立开时没有', () => {
    renderDialogs()
    act(() => { useStore.getState().openMarkdownPreview(PREVIEW) })
    let overlays = document.querySelectorAll('.subagent-detail-overlay')
    expect(overlays.length).toBe(2)
    expect(overlays[1].className).toContain('subagent-detail-overlay--stacked')
    act(() => { useStore.setState({ subagentDetail: null }) })
    overlays = document.querySelectorAll('.subagent-detail-overlay')
    expect(overlays.length).toBe(1)
    expect(overlays[0].className).not.toContain('--stacked')
  })
})
