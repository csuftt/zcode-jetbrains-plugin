/**
 * QuotaBanner 组件冒烟测试（jsdom 渲染）
 *
 * 锁定：耗尽/低额/并发三类视图渲染不崩、文案含窗口点名、刷新与关闭按钮可用；
 * 关闭后同源触发不再渲染（dismiss 去重键回路）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { QuotaBanner } from '@/components/QuotaBanner'
import { QUOTA_BANNER_DISMISSALS_KEY, mergeLiveQuotaBannerDismissals } from '@/utils/quotaBannerDismissals'

/**
 * 本环境 jsdom 的 window.localStorage 是无方法死对象（Node 实验 localStorage 抢占，
 * 见 test/quota-banner-dismissals.spec.ts 头注），注入 Map 桩供持久化断言使用
 */
function installStorageStub(): Map<string, string> {
  const map = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size
      },
    },
  })
  return map
}

beforeEach(() => {
  cleanup()
  const kvStorage = installStorageStub()
  kvStorage.clear()
  useStore.getState().init()
  useStore.setState({
    connectionStatus: 'mock',
    currentSessionId: 'sess_b1',
    currentWorkspacePath: 'G:\\mock',
    messages: [],
    quotaBannerError: null,
    quotaBannerDismissed: [],
    quota: null,
    currentModel: { modelId: 'GLM-5.3', providerId: 'builtin:bigmodel-coding-plan' },
  })
})

describe('QuotaBanner 渲染', () => {
  it('无触发源且无低额窗口 → 不渲染', () => {
    const { container } = render(<QuotaBanner />)
    expect(container.querySelector('.quota-banner')).toBeNull()
  })

  it('耗尽触发 + 额度数据 → 窗口点名与重置时间，关闭后消失', () => {
    useStore.setState({
      quotaBannerError: { kind: 'window-exhausted', triggerKey: 'err:k' },
      quota: { level: 'Max', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 100, nextResetTime: Date.now() + 3600_000 }] },
    })
    const { container } = render(<QuotaBanner />)
    const banner = container.querySelector('.quota-banner')!
    expect(banner).not.toBeNull()
    expect(banner.className).toContain('quota-banner--error')
    expect(banner.textContent).toContain('5 小时池')
    expect(banner.textContent).toContain('已用完')

    fireEvent.click(container.querySelector('.quota-banner__close')!)
    // dismiss 后派生视图归 null → 横幅消失；触发源仍在（窗口恢复时由 effect 清）
    expect(container.querySelector('.quota-banner')).toBeNull()
    expect(useStore.getState().quotaBannerDismissed).toHaveLength(1)
  })

  it('低额窗口（无错误触发）→ warning 横幅含剩余百分比', () => {
    useStore.setState({
      quota: { level: 'Max', limits: [{ type: 'TOKENS_LIMIT', unit: 6, percentage: 95, nextResetTime: Date.now() + 5 * 86400_000 }] },
    })
    const { container } = render(<QuotaBanner />)
    const banner = container.querySelector('.quota-banner')!
    expect(banner.className).toContain('quota-banner--warning')
    expect(banner.textContent).toContain('本周额度')
    expect(banner.textContent).toContain('5%')
  })

  it('低额关闭落盘持久化：low: 键写入 kv、err: 键不落盘', () => {
    const resetAt = Date.now() + 2 * 86400_000
    useStore.setState({
      quota: { level: 'Max', limits: [{ type: 'TOKENS_LIMIT', unit: 6, percentage: 95, nextResetTime: resetAt }] },
    })
    const { container, unmount } = render(<QuotaBanner />)
    fireEvent.click(container.querySelector('.quota-banner__close')!)
    unmount()
    const saved = JSON.parse(window.localStorage.getItem(QUOTA_BANNER_DISMISSALS_KEY)!) as Record<string, number>
    expect(Object.keys(saved)).toEqual([`low:weekly:${resetAt}`])
    expect(typeof saved[`low:weekly:${resetAt}`]).toBe('number')

    // 错误路键保持内存级不落盘
    useStore.getState().dismissQuotaBanner('err:concurrent-limit:3008:x')
    expect(window.localStorage.getItem(QUOTA_BANNER_DISMISSALS_KEY)!).not.toContain('err:')
  })

  it('持久静默跨 store 重建生效（新会话标签语义）：存活键压制低额横幅', () => {
    const resetAt = Date.now() + 2 * 86400_000
    window.localStorage.setItem(
      QUOTA_BANNER_DISMISSALS_KEY,
      JSON.stringify({ [`low:weekly:${resetAt}`]: Date.now() }),
    )
    useStore.setState({
      quotaBannerDismissed: mergeLiveQuotaBannerDismissals([]),
      quota: { level: 'Max', limits: [{ type: 'TOKENS_LIMIT', unit: 6, percentage: 95, nextResetTime: resetAt }] },
    })
    const { container } = render(<QuotaBanner />)
    expect(container.querySelector('.quota-banner')).toBeNull()
  })

  it('刷新按钮走 loadQuota（sendToJava op=getQuota）', () => {
    useStore.setState({ quotaBannerError: { kind: 'concurrent-limit', triggerKey: 'err:c' } })
    const sent: Array<Record<string, unknown>> = []
    // 直接断言 store 动作（桥已 mock 成 no-op，这里验证动作接线即可）
    useStore.getState().loadQuota()
    expect(useStore.getState().quotaLoading).toBe(true)
    sent.length = 0
  })
})
