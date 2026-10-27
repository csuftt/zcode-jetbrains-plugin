/**
 * ::visualize 内联可视化块组件测试：
 * 1. vizOpen 换 URL → fetch html → srcdoc 渲染（无 frame 导航，规避 JCEF 外转）+ resize 高度自适应
 * 2. singlefile 降级（回 html）→ srcdoc 形态
 * 3. vizOpen 失败 → 错误卡带路径
 * 4. 复制图片：上报视口矩形 copyVizImage op + imageCopied 回执驱动按钮反馈
 * 5. 在浏览器打开：url 模式出按钮调 openExternalUrl，singlefile 降级无按钮
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

const messageHandlers = new Set<(msg: unknown) => void>()
const sentRequests: Array<Record<string, unknown>> = []

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\demo',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => {
    messageHandlers.add(fn)
    return () => {
      messageHandlers.delete(fn)
    }
  },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => {
    sentRequests.push(req)
  },
  openExternalUrl: vi.fn(),
}))

vi.mock('@/utils/clipboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/clipboard')>()
  return { ...actual, copyText: vi.fn(async () => true) }
})

import '@/i18n/config'
import { openExternalUrl } from '@/ipc/bridge'
import { VisualizeBlock } from '@/components/VisualizeBlock'

const PATH = 'C:\\Users\\me\\.zcode\\v2\\visualizations\\ab\\gold.html'
const VIZ_URL = 'http://127.0.0.1:53712/viz/abc?theme=dark'
const DECORATED_HTML = '<style>injected</style><h3>图表</h3>'

function respond(msg: Record<string, unknown>) {
  messageHandlers.forEach((fn) => fn(msg))
}

function respondVizOpen(payload: Record<string, unknown>) {
  respond({ op: 'vizOpenResult', path: PATH, ok: true, ...payload })
}

/** 以指定 iframe 为 source 派发子页 postMessage（校验 ev.source 的链路） */
function postFrom(iframe: HTMLIFrameElement, data: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow as Window | null }))
  })
}

async function waitForIframe(container: HTMLElement): Promise<HTMLIFrameElement> {
  return (await waitFor(() => {
    const el = container.querySelector('iframe[srcdoc]')
    expect(el).not.toBeNull()
    return el!
  })) as HTMLIFrameElement
}

beforeEach(() => {
  sentRequests.length = 0
  vi.mocked(openExternalUrl).mockClear()
  // url 模式统一走 fetch html → srcdoc（无 frame 导航请求）
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(DECORATED_HTML) })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('VisualizeBlock', () => {
  it('url 模式：vizOpen → fetch html → srcdoc 渲染（无 src 导航），resize 驱动高度', async () => {
    const { container } = render(<VisualizeBlock directive={{ path: PATH }} />)
    await waitFor(() => {
      expect(sentRequests.some((r) => r.op === 'vizOpen')).toBe(true)
    })
    // vizOpen 等回执期间骨架已显示
    expect(screen.getByText('可视化加载中…')).toBeTruthy()
    respondVizOpen({ url: VIZ_URL })
    const iframe = await waitForIframe(container)
    expect(iframe.getAttribute('src')).toBeNull()
    expect(iframe.getAttribute('srcdoc')).toBe(DECORATED_HTML)
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(fetch).toHaveBeenCalledWith(VIZ_URL)
    // 子页 resize → 高度更新、骨架消失
    postFrom(iframe, { source: 'zcode-viz', type: 'resize', height: 480.7 })
    await waitFor(() => {
      expect(container.querySelector('.viz-block__loading')).toBeNull()
    })
    expect(container.querySelector('.viz-block__body')?.getAttribute('style')).toContain('481')
    // 非本 iframe 来源的消息不采纳
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { source: 'zcode-viz', type: 'resize', height: 1 }, source: null }))
    })
    expect(container.querySelector('.viz-block__body')?.getAttribute('style')).toContain('481')
  })

  it('singlefile 降级：直接回 html → srcdoc（不发 fetch）', async () => {
    const { container } = render(<VisualizeBlock directive={{ path: PATH }} />)
    await waitFor(() => {
      expect(sentRequests.some((r) => r.op === 'vizOpen')).toBe(true)
    })
    respondVizOpen({ html: '<style>x</style><h3>降级可视化</h3>' })
    const iframe = await waitForIframe(container)
    expect(iframe.getAttribute('srcdoc')).toContain('降级可视化')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('vizOpen 失败 → 错误卡带路径', async () => {
    render(<VisualizeBlock directive={{ path: PATH }} />)
    await waitFor(() => {
      expect(sentRequests.some((r) => r.op === 'vizOpen')).toBe(true)
    })
    respond({ op: 'vizOpenResult', path: PATH, ok: false, error: '路径不在允许的可视化目录内' })
    expect(await screen.findByText('可视化加载失败')).toBeTruthy()
    expect(document.querySelector('.viz-block__error code')?.textContent).toBe(PATH)
  })

  it('复制图片：上报视口矩形 copyVizImage，imageCopied 回执驱动成功/失败反馈', async () => {
    // jsdom 的 getBoundingClientRect 恒 0，会走"零矩形拒绝"分支，桩成真实形态
    vi.spyOn(HTMLIFrameElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 20,
      width: 800,
      height: 400,
    } as DOMRect)
    const { container } = render(<VisualizeBlock directive={{ path: PATH }} />)
    await waitFor(() => {
      expect(sentRequests.some((r) => r.op === 'vizOpen')).toBe(true)
    })
    respondVizOpen({ url: VIZ_URL })
    await waitForIframe(container)
    fireEvent.click(container.querySelector('.viz-block__toolbar button')!)
    await waitFor(() => {
      const req = sentRequests.find((r) => r.op === 'copyVizImage')
      expect(req).toBeTruthy()
      expect(req).toMatchObject({ x: 10, y: 20, w: 800, h: 400 })
    })
    respond({ op: 'imageCopied', ok: true })
    await waitFor(() => {
      expect(container.querySelector('.viz-copy-ok')).not.toBeNull()
    })
    // 失败回执 → 失败态
    fireEvent.click(container.querySelector('.viz-block__toolbar button')!)
    respond({ op: 'imageCopied', ok: false, error: 'screen capture failed' })
    await waitFor(() => {
      expect(container.querySelector('.viz-copy-fail')).not.toBeNull()
    })
  })

  it('在浏览器打开：url 模式出按钮并调 openExternalUrl；singlefile 降级不显示', async () => {
    const { container } = render(<VisualizeBlock directive={{ path: PATH }} />)
    await waitFor(() => {
      expect(sentRequests.some((r) => r.op === 'vizOpen')).toBe(true)
    })
    respondVizOpen({ url: VIZ_URL })
    await waitForIframe(container)
    const openBtn = container.querySelector('.viz-block__toolbar button:nth-child(2)') as HTMLButtonElement
    expect(openBtn).not.toBeNull()
    expect(openBtn.title).toBe('在浏览器打开')
    fireEvent.click(openBtn)
    expect(openExternalUrl).toHaveBeenCalledWith(VIZ_URL)
    // singlefile 降级（无 url）→ 不显示浏览器打开按钮
    cleanup()
    const sf = render(<VisualizeBlock directive={{ path: PATH }} />)
    await waitFor(() => {
      expect(sentRequests.filter((r) => r.op === 'vizOpen')).toHaveLength(2)
    })
    respond({ op: 'vizOpenResult', path: PATH, ok: true, html: '<h3>降级</h3>' })
    await waitForIframe(sf.container)
    expect(sf.container.querySelector('.viz-block__toolbar button:nth-child(2)')).toBeNull()
  })
})
