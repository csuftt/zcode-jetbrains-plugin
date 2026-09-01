/**
 * MermaidBlock 工具栏（复制代码/复制图片/放大）与放大弹窗测试
 *
 * 行为约定：
 *   - 渲染成功：右上角工具栏 3 按钮（复制代码 | 复制图片 | 放大查看）
 *   - 复制代码 → navigator.clipboard.writeText(mermaid 源码)，按钮闪 ✓（mermaid-copy-ok）
 *   - 复制图片 → SVG 经 canvas 位图化成 PNG，navigator.clipboard.write(ClipboardItem)，按钮闪 ✓；
 *     clipboard.write 拒绝 → 按钮闪 ✗（mermaid-copy-fail）
 *   - 放大弹窗：6 按钮（复制代码 | 复制图片 | 缩小 | 百分比 | 放大 | 关闭），svg 容器 .mermaid-modal-svg
 *   - 拖动平移防御：内容未溢出（pannable=false）时 mousedown 不进入 dragging
 *
 * mermaid 库 mock 掉（jsdom 无布局，真渲染无意义）；剪贴板/图片/canvas/RO 均按链路 stub。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import '@/i18n/config'
import { initBridge } from '@/ipc/bridge'
import { MermaidBlock } from '@/components/MermaidBlock'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 120 60"><rect/></svg>' })),
  },
}))

const MERMAID_CODE = 'flowchart LR\n    A --> B'

const writeText = vi.fn(async () => {})
const clipboardWrite = vi.fn(async () => {})

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText, write: clipboardWrite },
    configurable: true,
  })
  vi.stubGlobal('ClipboardItem', class {
    items: Map<string, Blob>
    constructor(items: Record<string, Blob>) {
      this.items = new Map(Object.entries(items))
    }
  })
  // Image：设 src 即异步 onload（jsdom 不真加载图片）
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_v: string) {
      setTimeout(() => this.onload?.(), 0)
    }
  })
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:fake'),
    configurable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  // canvas：jsdom 无 2d 上下文，stub 成功链路（fillRect + drawImage + toBlob 出 PNG）
  const ctx2d = { fillRect: vi.fn(), drawImage: vi.fn() }
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx2d)
  HTMLCanvasElement.prototype.toBlob = vi.fn((cb: (b: Blob | null) => void) => {
    cb(new Blob(['png-bytes'], { type: 'image/png' }))
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete (window as unknown as Record<string, unknown>).__ZCODE_CEF_QUERY__
})

async function renderDiagram() {
  render(<MermaidBlock code={MERMAID_CODE} />)
  await waitFor(() => {
    expect(document.querySelector('.mermaid-block')).toBeTruthy()
  })
  return [...document.querySelectorAll('.mermaid-toolbar button')]
}

describe('MermaidBlock 复制工具栏', () => {
  it('渲染成功：工具栏 3 按钮（复制代码 | 复制图片 | 放大查看）', async () => {
    const btns = await renderDiagram()
    expect(btns.map((b) => b.title)).toEqual(['复制代码', '复制图片', '放大查看'])
  })

  it('复制代码：writeText 收到 mermaid 源码，按钮闪 ✓', async () => {
    const btns = await renderDiagram()
    fireEvent.click(btns[0])
    await waitFor(() => {
      expect(btns[0].className).toContain('mermaid-copy-ok')
    })
    expect(writeText).toHaveBeenCalledWith(MERMAID_CODE)
    expect(btns[0].title).toBe('已复制')
  })

  it('复制图片：SVG 位图化成 PNG 写剪贴板（ClipboardItem image/png），按钮闪 ✓', async () => {
    const btns = await renderDiagram()
    fireEvent.click(btns[1])
    await waitFor(() => {
      expect(btns[1].className).toContain('mermaid-copy-ok')
    })
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    const [items] = clipboardWrite.mock.calls[0]
    const item = items[0]
    const blob = item.items.get('image/png')
    expect(blob).toBeInstanceOf(Blob)
    expect(blob!.type).toBe('image/png')
  })

  it('复制图片失败（clipboard.write 拒绝且非 JCEF）：按钮闪 ✗', async () => {
    clipboardWrite.mockRejectedValueOnce(new Error('denied'))
    const btns = await renderDiagram()
    fireEvent.click(btns[1])
    await waitFor(() => {
      expect(btns[1].className).toContain('mermaid-copy-fail')
    })
    expect(btns[1].title).toBe('复制失败')
  })

  it('JCEF 降级：clipboard.write 拒绝 → Java 桥 copyImage → imageCopied 回执闪 ✓', async () => {
    initBridge()
    const queries: string[] = []
    ;(window as unknown as Record<string, unknown>).__ZCODE_CEF_QUERY__ = (
      args: { request: string },
    ) => {
      queries.push(args.request)
    }
    clipboardWrite.mockRejectedValueOnce(new Error('denied'))
    const btns = await renderDiagram()
    fireEvent.click(btns[1])
    await waitFor(() => {
      expect(queries.length).toBe(1)
    })
    const req = JSON.parse(queries[0])
    expect(req.op).toBe('copyImage')
    expect(typeof req.dataBase64).toBe('string')
    expect(req.dataBase64.length).toBeGreaterThan(0)
    // Java 回执 → 成功反馈
    window.zcodeBridge!.onMessage({ op: 'imageCopied', ok: true })
    await waitFor(() => {
      expect(btns[1].className).toContain('mermaid-copy-ok')
    })
  })
})

describe('MermaidBlock 放大弹窗', () => {
  async function openModal() {
    const btns = await renderDiagram()
    fireEvent.click(btns[2]) // 放大查看
    await waitFor(() => {
      expect(document.querySelector('.mermaid-modal-overlay')).toBeTruthy()
    })
    return [...document.querySelectorAll('.mermaid-modal-toolbar button')].map((b) => b.title)
  }

  it('工具栏 6 按钮：复制代码 | 复制图片 | 缩小 | 重置 | 放大 | 关闭', async () => {
    const titles = await openModal()
    expect(titles).toEqual([
      '复制代码',
      '复制图片',
      '缩小 (-10%)',
      '重置为 100%（滚轮可缩放）',
      '放大 (+10%)',
      '关闭 (Esc)',
    ])
  })

  it('弹窗 svg 容器存在（.mermaid-modal-svg，居中由 CSS margin:auto 实现）', async () => {
    await openModal()
    expect(document.querySelector('.mermaid-modal-svg svg')).toBeTruthy()
  })

  it('弹窗内复制代码可用：writeText 收到源码', async () => {
    await openModal()
    const btn = [...document.querySelectorAll('.mermaid-modal-toolbar button')][0]
    fireEvent.click(btn)
    await waitFor(() => {
      expect(btn.className).toContain('mermaid-copy-ok')
    })
    expect(writeText).toHaveBeenCalledWith(MERMAID_CODE)
  })

  it('拖动防御：内容未溢出（pannable=false）时 mousedown 不进入 dragging', async () => {
    await openModal()
    const content = document.querySelector('.mermaid-modal-content') as HTMLElement
    expect(content.className).not.toContain('mermaid-modal-content--pan')
    fireEvent.mouseDown(content, { button: 0, clientX: 100, clientY: 100 })
    expect(content.className).not.toContain('dragging')
  })

  it('Esc 关闭弹窗', async () => {
    await openModal()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(document.querySelector('.mermaid-modal-overlay')).toBeFalsy()
    })
  })
})
