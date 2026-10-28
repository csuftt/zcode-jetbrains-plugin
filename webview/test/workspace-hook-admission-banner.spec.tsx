// @vitest-environment jsdom
/**
 * 工作区钩子准入横幅测试（官方同款形态，v4 workspaceHookAdmission 投影）
 *
 * 覆盖：
 *   1. pendingCount>0 → 横幅渲染（文案含待审核数）
 *   2. admission null / pendingCount=0 → 横幅收敛
 *   3. 去审核 → pendingSettingsSection='hooks' + 切设置视图；设置视图下不渲染
 *   4. 忽略按待审束记忆：同束不再出现，新束（digest 变化）重新出现
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const sendToJavaMock = vi.fn()
const onGoReviewMock = vi.fn()
let streamBatchHandler: ((sid: string, events: unknown[]) => void) | null = null
let messageHandler: ((msg: Record<string, unknown>) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: Record<string, unknown>) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: (fn: (sid: string, events: unknown[]) => void) => { streamBatchHandler = fn },
  sendToJava: (...args: unknown[]) => sendToJavaMock(...args),
}))

import * as React from 'react'
import { useStore } from '@/store/useStore'
import { WorkspaceHookAdmissionBanner } from '@/components/WorkspaceHookAdmissionBanner'
import type { WorkspaceHookAdmission } from '@/types/messages'

function pushAdmission(admission: WorkspaceHookAdmission | null) {
  // act 包裹：zustand 更新发生在 React 事件外，否则重渲染被调度延迟、断言时未 flush
  act(() => {
    streamBatchHandler!('sess_1', [{
      type: 'workspaceHookAdmission', seq: 0, sessionId: 'sess_1', timestamp: 1,
      payload: { admission },
    }])
  })
}

const PENDING: WorkspaceHookAdmission = {
  pendingCount: 1, bundleDigest: 'sha256:b1', workspaceIdentity: 'g:/mock',
}

function renderBanner(visible = true) {
  return render(<WorkspaceHookAdmissionBanner visible={visible} onGoReview={onGoReviewMock} />)
}

beforeEach(() => {
  sendToJavaMock.mockClear()
  onGoReviewMock.mockClear()
  useStore.getState().init()
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: 'sess_1',
    currentWorkspacePath: 'G:\\mock',
    currentView: 'chat',
  })
})

afterEach(cleanup)

describe('准入横幅', () => {
  it('pendingCount>0 渲染横幅（文案含待审核数）', () => {
    pushAdmission(PENDING)
    renderBanner()
    expect(screen.getByRole('note').textContent).toContain('待审核')
    expect(screen.getByRole('button', { name: '去审核' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '忽略' })).toBeTruthy()
  })

  it('admission null 或 pendingCount=0 收敛横幅', () => {
    pushAdmission(PENDING)
    const { container } = renderBanner()
    expect(container.querySelector('.hook-admission-banner')).toBeTruthy()

    pushAdmission(null)
    expect(container.querySelector('.hook-admission-banner')).toBeNull()

    pushAdmission({ ...PENDING, pendingCount: 0 })
    expect(container.querySelector('.hook-admission-banner')).toBeNull()
  })

  it('去审核：回调 onGoReview（App 侧落 hooks 设置段并切视图）', () => {
    pushAdmission(PENDING)
    renderBanner()
    expect(onGoReviewMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '去审核' }))
    expect(onGoReviewMock).toHaveBeenCalledTimes(1)
  })

  it('visible=false 不渲染（设置/历史视图由 App 关掉横幅）', () => {
    pushAdmission(PENDING)
    const { container } = renderBanner(false)
    expect(container.querySelector('.hook-admission-banner')).toBeNull()
  })

  it('忽略按待审束记忆：同束不再出现，新束重新出现', () => {
    pushAdmission(PENDING)
    const { container } = renderBanner()
    fireEvent.click(screen.getByRole('button', { name: '忽略' }))
    expect(container.querySelector('.hook-admission-banner')).toBeNull()

    // 同一束（同 digest 同数量）重推不重现
    pushAdmission(PENDING)
    expect(container.querySelector('.hook-admission-banner')).toBeNull()

    // 新待审束（digest 变化）重新出现
    pushAdmission({ ...PENDING, bundleDigest: 'sha256:b2' })
    expect(container.querySelector('.hook-admission-banner')).toBeTruthy()
  })
})
