/**
 * 浏览器设置页（BrowserSettingsView）交互回归：
 * - 进入页面拉 browserConfig 快照；快照未到时占位
 * - 浏览器控制为只读状态卡（无开关、不发 op、按快照显示状态徽标）
 * - 清除全部 → ConfirmDialog 二次确认后才发 clearBrowserData(all)
 * - 「查看」概览弹窗按站点分组展示
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const sent: { op: string }[] = []
vi.mock('@/ipc/bridge', () => ({
  sendToJava: (req: { op: string }) => {
    sent.push(req)
  },
  isInJcef: () => false,
}))

import '@/i18n/config'
import { BrowserSettingsView } from '@/components/BrowserSettingsView'
import { useStore } from '@/store/useStore'

function setConfig(cfg: Record<string, unknown> | null) {
  useStore.setState({ browserConfig: cfg as never, browserBusy: null, browserError: null, browserCleared: null })
}

describe('浏览器设置页', () => {
  beforeEach(() => {
    sent.length = 0
    setConfig(null)
  })
  afterEach(cleanup)

  it('进入页面拉取 browserConfig 快照', () => {
    render(<BrowserSettingsView />)
    expect(sent.some((m) => m.op === 'browserConfig')).toBe(true)
  })

  it('浏览器控制为只读状态卡：无开关、不发 op、按快照显示状态徽标', () => {
    setConfig({ browserControlEnabled: true, pluginInstalled: true })
    render(<BrowserSettingsView />)
    // 只读卡存在，页面上没有任何开关（证书开关已随功能移除）
    expect(document.querySelector('.browser-settings__readonly')).toBeTruthy()
    expect(document.querySelectorAll('.setting-toggle__switch').length).toBe(0)
    expect(document.body.textContent).toContain('已启用')
    expect(document.body.textContent).toContain('ZCode 客户端')

    // 未安装态显示未安装徽标
    cleanup()
    setConfig({ browserControlEnabled: false, pluginInstalled: false })
    render(<BrowserSettingsView />)
    expect(document.body.textContent).toContain('未安装')
    // 只读：任何点击路径都不产生 setBrowserControl
    expect(sent.some((m) => m.op === 'setBrowserControl')).toBe(false)
  })

  it('清除全部需二次确认，取消不发 op', () => {
    setConfig({ browserControlEnabled: false, pluginInstalled: true })
    render(<BrowserSettingsView />)
    const btns = screen.getAllByRole('button')
    const clearAllBtn = btns.find((b) => b.className.includes('action-btn--danger')) as HTMLButtonElement
    fireEvent.click(clearAllBtn)
    // ConfirmDialog 出现，取消
    expect(document.querySelector('.modal-overlay')).toBeTruthy()
    fireEvent.click(document.querySelector('.modal-overlay')!)
    expect(sent.some((m) => m.op === 'clearBrowserData')).toBe(false)
  })

  it('清除全部确认后发送 clearBrowserData(all)', async () => {
    setConfig({ browserControlEnabled: false, pluginInstalled: true })
    render(<BrowserSettingsView />)
    const clearAllBtn = screen.getAllByRole('button').find((b) => b.className.includes('action-btn--danger')) as HTMLButtonElement
    fireEvent.click(clearAllBtn)
    const confirmBtn = document.querySelector('.modal-content button[class*=confirm], .modal-content button:last-child') as HTMLButtonElement
    fireEvent.click(confirmBtn)
    await waitFor(() => {
      const last = sent[sent.length - 1]
      expect(last.op).toBe('clearBrowserData')
      expect((last as { mode?: string }).mode).toBe('all')
    })
  })

  it('「查看」按钮拉取概览，数据到达后弹窗按站点分组展示', async () => {
    setConfig({ browserControlEnabled: false, pluginInstalled: true })
    render(<BrowserSettingsView />)
    // 「清除全部」条目的查看按钮（最后一个查看按钮 = 全部档，展示全部站点与 Cookie 行）
    const viewBtn = screen.getAllByRole('button').filter((b) => b.textContent!.includes('查看')).pop()! as HTMLButtonElement
    fireEvent.click(viewBtn)
    expect(sent.some((m) => m.op === 'browserDataOverview')).toBe(true)

    // 模拟概览响应（handleResponse 不便直调，直接 setState 到达态）
    useStore.setState({
      browserBusy: null,
      browserOverview: {
        httpCacheBytes: 12 * 1024 * 1024, httpCacheEntries: 456, codeCacheBytes: 2048, cookieCount: 38,
        sites: [
          { origin: 'github.com', open: true, cookies: 12, cacheStorages: 2, serviceWorkers: 1, localStorageEntries: 58, indexedDbBytes: 0, hasIndexedDb: false },
          { origin: 'https://localhost:5173', open: false, cookies: 0, cacheStorages: 0, serviceWorkers: 0, localStorageEntries: -1, indexedDbBytes: 4096, hasIndexedDb: true },
        ],
      },
    })
    await waitFor(() => {
      // 站点分组展示：站点名 + 徽标 + 数据标签
      expect(document.querySelector('.browser-overview')).toBeTruthy()
      expect(document.body.textContent).toContain('github.com')
      expect(document.body.textContent).toContain('已打开')
      expect(document.body.textContent).toContain('Cookie 12')
      expect(document.body.textContent).toContain('localhost:5173')
      expect(document.body.textContent).toContain('IndexedDB 4.0 KB')
      // 全局行
      expect(document.body.textContent).toContain('HTTP 缓存')
      expect(document.body.textContent).toContain('12.0 MB')
    })
    // 关闭弹窗
    fireEvent.click(document.querySelector('.browser-overview__close')!)
    expect(document.querySelector('.browser-overview')).toBeFalsy()
  })

  it('缓存档概览只列有缓存类数据的站点', async () => {
    setConfig({ browserControlEnabled: false, pluginInstalled: true })
    render(<BrowserSettingsView />)
    const viewBtns = screen.getAllByRole('button').filter((b) => b.textContent!.includes('查看'))
    fireEvent.click(viewBtns[0]) // 第一个查看按钮 = 清除缓存条目
    useStore.setState({
      browserBusy: null,
      browserOverview: {
        httpCacheBytes: 1024, httpCacheEntries: 5, codeCacheBytes: 0, cookieCount: 3,
        sites: [
          { origin: 'a.com', open: true, cookies: 3, cacheStorages: 1, serviceWorkers: 0, localStorageEntries: 0, indexedDbBytes: 0, hasIndexedDb: false },
          { origin: 'b.com', open: false, cookies: 0, cacheStorages: 0, serviceWorkers: 0, localStorageEntries: -1, indexedDbBytes: 0, hasIndexedDb: true },
        ],
      },
    })
    await waitFor(() => {
      expect(document.body.textContent).toContain('a.com')
      expect(document.body.textContent).not.toContain('b.com')
      // 缓存档不展示 Cookie 全局行
      expect(document.body.textContent).not.toContain('38 条')
    })
    fireEvent.click(document.querySelector('.browser-overview__close')!)
  })

  it('RD 后端 host 下浏览器控制卡显示远程不可用提示，本地环境不显示', () => {
    setConfig({ browserControlEnabled: true, pluginInstalled: true })
    // 本地环境（envStatus 无 rdHost）：不出现提示行
    render(<BrowserSettingsView />)
    expect(document.querySelector('.browser-settings__rd-note')).toBeFalsy()
    cleanup()

    // RD 后端（rdHost=true）：提示行出现
    useStore.setState({ envStatus: { rdHost: true } as never })
    render(<BrowserSettingsView />)
    const note = document.querySelector('.browser-settings__rd-note')
    expect(note).toBeTruthy()
    expect(note!.textContent).toContain('远程开发模式下不可用')
  })
})
