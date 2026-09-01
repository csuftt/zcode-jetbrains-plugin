/**
 * StarSupportSection（开源与支持区块）测试
 *
 * 行为约定：
 *   - 渲染：标题/描述/两按钮文案（i18n zh 包）
 *   - 主按钮：点击经桥发 { op: 'openExternal' }（目标 URL 硬编码 Java 侧，前端不传参）
 *   - 次按钮：点击复制仓库地址，成功后按钮内联变「已复制」、1.5s 回弹；
 *     复制失败显示「复制失败」文案
 */

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

import '@/i18n/config'
import { StarSupportSection, GITHUB_REPO_URL } from '@/components/StarSupportSection'

vi.mock('@/ipc/bridge', () => ({ sendToJava: vi.fn() }))
vi.mock('@/utils/clipboard', () => ({ copyText: vi.fn() }))

import { sendToJava } from '@/ipc/bridge'
import { copyText } from '@/utils/clipboard'

const mockedSend = vi.mocked(sendToJava)
const mockedCopy = vi.mocked(copyText)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('StarSupportSection 渲染', () => {
  it('展示标题 / 描述 / 前往 Star 与复制两按钮', () => {
    render(<StarSupportSection />)
    expect(screen.getByText('开源与支持')).toBeTruthy()
    expect(screen.getByText('前往 GitHub 点 Star')).toBeTruthy()
    expect(screen.getByText('复制仓库地址')).toBeTruthy()
  })
})

describe('主按钮：一键直达', () => {
  it('点击经桥发 { op: "openExternal" }，不携带任何参数', () => {
    render(<StarSupportSection />)
    fireEvent.click(screen.getByText('前往 GitHub 点 Star'))
    expect(mockedSend).toHaveBeenCalledTimes(1)
    expect(mockedSend).toHaveBeenCalledWith({ op: 'openExternal' })
  })
})

describe('次按钮：复制地址 + 内联反馈', () => {
  it('复制成功按钮变「已复制」，1.5s 后回弹', async () => {
    mockedCopy.mockResolvedValue(true)
    vi.useFakeTimers()
    render(<StarSupportSection />)

    await act(async () => {
      fireEvent.click(screen.getByText('复制仓库地址'))
    })
    expect(mockedCopy).toHaveBeenCalledWith(GITHUB_REPO_URL)
    expect(screen.getByText('已复制')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(1600)
    })
    expect(screen.getByText('复制仓库地址')).toBeTruthy()
  })

  it('复制失败显示失败文案', async () => {
    mockedCopy.mockResolvedValue(false)
    render(<StarSupportSection />)

    await act(async () => {
      fireEvent.click(screen.getByText('复制仓库地址'))
    })
    expect(screen.getByText('复制失败，请手动复制')).toBeTruthy()
  })
})
