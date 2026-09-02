/**
 * 弹窗分层叠加（2026-09-02 缺陷修复，用户实测反馈）：
 * 子代理详情弹窗内打开"最终报告/总结"或 Markdown 预览，关闭阅读层后
 * 详情弹窗应仍在（此前 openSubagentReport/openMarkdownPreview 会把
 * subagentDetail 清空，两层一起消失）。
 *
 * 断言：
 *   1. store：开报告/预览保留 subagentDetail；关阅读层详情仍在；报告与预览互斥
 *   2. Esc 分层：叠开时按 Esc 只关最上层（报告），详情不动；再按才关详情
 *   3. 叠开时上层 overlay 加 --stacked（遮罩透明防双层变暗），独立开时没有
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
import { SubagentReportDialog } from '@/components/SubagentReportDialog'

const DETAIL_KEY = 'call_stack_1'
const REPORT = { callID: DETAIL_KEY, title: '子代理最终报告', markdown: '# 报告正文' }

function renderDialogs() {
  return render(
    <>
      <SubagentDetailDialog />
      <SubagentReportDialog />
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
  it('详情开着 → 开报告：详情保留；关报告：详情仍在（缺陷修复点）', () => {
    const st = useStore.getState()
    st.openSubagentReport(REPORT)
    expect(useStore.getState().subagentReport).toEqual(REPORT)
    expect(useStore.getState().subagentDetail).toBe(DETAIL_KEY)
    useStore.getState().closeSubagentReport()
    expect(useStore.getState().subagentReport).toBeNull()
    expect(useStore.getState().subagentDetail).toBe(DETAIL_KEY)
  })

  it('详情开着 → 开 Markdown 预览：详情保留（web/Skill 工具 📖 从子代理弹窗内打开）', () => {
    useStore.getState().openMarkdownPreview({ title: '网页获取 · x.com', markdown: '内容' })
    expect(useStore.getState().markdownPreview).not.toBeNull()
    expect(useStore.getState().subagentDetail).toBe(DETAIL_KEY)
    useStore.getState().closeMarkdownPreview()
    expect(useStore.getState().subagentDetail).toBe(DETAIL_KEY)
  })

  it('报告与预览仍互斥（同时只读一个）；重新开详情清阅读层（焦点切换语义保留）', () => {
    const st = useStore.getState()
    st.openSubagentReport(REPORT)
    st.openMarkdownPreview({ title: '预览', markdown: 'x' })
    expect(useStore.getState().subagentReport).toBeNull()
    expect(useStore.getState().markdownPreview).not.toBeNull()
    st.openSubagentDetail(DETAIL_KEY)
    expect(useStore.getState().markdownPreview).toBeNull()
    expect(useStore.getState().subagentDetail).toBe(DETAIL_KEY)
  })
})

describe('弹窗分层：Esc 与遮罩渲染', () => {
  it('叠开时按一次 Esc 只关报告，详情不动；再按才关详情', () => {
    act(() => { useStore.getState().openSubagentReport(REPORT) })
    renderDialogs()
    // 两层都在（报告标题在 header 标题与 meta 各一处）
    expect(screen.getAllByText('子代理最终报告').length).toBeGreaterThan(0)
    expect(document.querySelector('.subagent-detail-dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    // 报告关了，详情弹窗还在（仍有 overlay + 详情标题任务描述）
    expect(screen.queryAllByText('子代理最终报告')).toHaveLength(0)
    expect(useStore.getState().subagentReport).toBeNull()
    expect(useStore.getState().subagentDetail).toBe(DETAIL_KEY)
    expect(document.querySelector('.subagent-detail-overlay')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().subagentDetail).toBeNull()
    expect(document.querySelector('.subagent-detail-overlay')).toBeNull()
  })

  it('叠开时报告 overlay 加 --stacked（遮罩透明），独立开时没有', () => {
    renderDialogs()
    act(() => { useStore.getState().openSubagentReport(REPORT) })
    let overlays = document.querySelectorAll('.subagent-detail-overlay')
    expect(overlays.length).toBe(2)
    expect(overlays[1].className).toContain('subagent-detail-overlay--stacked')
    // 关掉详情后报告独立存在：不再有 stacked 类
    act(() => { useStore.setState({ subagentDetail: null }) })
    overlays = document.querySelectorAll('.subagent-detail-overlay')
    expect(overlays.length).toBe(1)
    expect(overlays[0].className).not.toContain('--stacked')
  })
})
