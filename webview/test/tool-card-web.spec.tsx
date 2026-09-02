/**
 * 网页工具卡（WebSearch/WebFetch）友好渲染（2026-09-02 规划落地）：
 *   - 头部 📖 弹窗按钮（有输出时）与 WebFetch 🌐 打开原网页按钮
 *   - 展开区 input 友好展示（URL/提问/搜索词，替代裸 JSON）
 *   - 输出来源链接列表（点击调系统浏览器）；无链接输出回退 3 行短预览
 *   - 📖 点击 → openMarkdownPreview（MarkdownPreviewDialog 全文渲染）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const openExternalUrlMock = vi.fn()

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { ToolCallCard } from '@/components/ToolCallCard'
import type { ToolPart } from '@/types/messages'

const SEARCH_OUT = [
  'Web search results for query: "jcef plugin"',
  '',
  '```json',
  '{"link": "https://in-code-fence.example.com/x"}',
  '```',
  '1. **[JCEF 官方文档](https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html)**',
  '2. **[社区问答](https://intellij-support.jetbrains.com/hc/en-us/community/posts/360009678839)**',
].join('\n')

function webPart(tool: 'WebSearch' | 'WebFetch', input: Record<string, unknown>, output: string): ToolPart {
  return {
    type: 'tool',
    callID: 'call_web_test',
    tool,
    state: { status: 'completed', input, output, time: { start: 1787283860000, end: 1787283861000 } },
  }
}

function expandCard(container: HTMLElement) {
  fireEvent.click(container.querySelector('.tool-card__header')!)
}

beforeEach(() => {
  openExternalUrlMock.mockClear()
  useStore.setState({ markdownPreview: null, subagentDetail: null, subagentReport: null })
})

afterEach(() => cleanup())

describe('WebSearch 卡片', () => {
  it('头部有 📖 弹窗按钮；展开后显示来源链接列表而非裸 JSON input', () => {
    const { container } = render(
      <ToolCallCard part={webPart('WebSearch', { query: 'jcef plugin' }, SEARCH_OUT)} />,
    )
    expect(screen.getByTitle('弹窗查看结果')).toBeTruthy()
    expandCard(container)
    // 来源列表：code fence 里的链接不出现，markdown 链接按 url 去重后列出
    const items = container.querySelectorAll('.web-source-item')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('plugins.jetbrains.com')
    expect(items[0].textContent).toContain('JCEF 官方文档')
    // 展开区不再是通用分支的裸 JSON（无 "query" 键转储）
    expect(container.textContent).not.toContain('"query"')
  })

  it('来源条目点击 → openExternalUrl(条目 url)', () => {
    const { container } = render(
      <ToolCallCard part={webPart('WebSearch', { query: 'jcef plugin' }, SEARCH_OUT)} />,
    )
    expandCard(container)
    fireEvent.click(container.querySelectorAll('.web-source-item')[0])
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html')
  })

  it('📖 点击 → 弹窗标题带 query（空白收敛+40字截断）、全文渲染', () => {
    render(<ToolCallCard part={webPart('WebSearch', { query: 'jcef plugin' }, SEARCH_OUT)} />)
    fireEvent.click(screen.getByTitle('弹窗查看结果'))
    const preview = useStore.getState().markdownPreview
    expect(preview).not.toBeNull()
    expect(preview!.title).toBe('网页搜索 · jcef plugin')
    expect(preview!.meta).toBeUndefined()
    expect(preview!.markdown).toBe(SEARCH_OUT)
  })

  it('无链接输出（如空结果）→ 回退 3 行短预览 + 截断指示', () => {
    const out = Array.from({ length: 8 }, (_, i) => `第${i + 1}行内容`).join('\n')
    const { container } = render(
      <ToolCallCard part={webPart('WebSearch', { query: 'q' }, out)} />,
    )
    expandCard(container)
    expect(container.querySelectorAll('.web-source-item')).toHaveLength(0)
    expect(container.textContent).toContain('第1行内容')
    expect(container.textContent).toContain('⋯')
    expect(container.textContent).not.toContain('第8行内容')
  })
})

describe('WebFetch 卡片', () => {
  const input = {
    url: 'https://plugins.jetbrains.com/docs/marketplace/approval.html',
    prompt: '有没有禁止外链的条款？',
  }

  it('头部有 🌐 打开原网页 + 📖 弹窗按钮；🌐 点击 → openExternalUrl(url)', () => {
    render(<ToolCallCard part={webPart('WebFetch', input, '## 回答\n无相关条款')} />)
    fireEvent.click(screen.getByTitle('打开原网页'))
    expect(openExternalUrlMock).toHaveBeenCalledWith(input.url)
    expect(screen.getByTitle('弹窗查看结果')).toBeTruthy()
  })

  it('🌐 只在完成态显示（运行中不出现——结果未出，跳原页诉求不成立）', () => {
    const running: ToolPart = {
      ...webPart('WebFetch', input, ''),
      state: { ...webPart('WebFetch', input, '').state, status: 'running' },
    }
    render(<ToolCallCard part={running} />)
    expect(screen.queryByTitle('打开原网页')).toBeNull()
  })

  it('展开后显示 URL 行（可点）与提问段；无来源列表时输出走短预览', () => {
    const { container } = render(
      <ToolCallCard part={webPart('WebFetch', input, 'HTTP 404 Not Found 的短错误文本')} />,
    )
    expandCard(container)
    const urlRow = container.querySelector('.tool-card__weburl')
    expect(urlRow).not.toBeNull()
    expect(urlRow!.textContent).toContain(input.url)
    expect(container.textContent).toContain('有没有禁止外链的条款？')
    expect(container.textContent).toContain('HTTP 404 Not Found 的短错误文本')
    fireEvent.click(urlRow!)
    expect(openExternalUrlMock).toHaveBeenCalledWith(input.url)
  })

  it('📖 点击 → 弹窗标题带域名、meta 带完整 URL', () => {
    render(<ToolCallCard part={webPart('WebFetch', input, '## 回答\n详见 [指南](https://x.example.com/g)。')} />)
    fireEvent.click(screen.getByTitle('弹窗查看结果'))
    const preview = useStore.getState().markdownPreview
    expect(preview!.title).toContain('plugins.jetbrains.com')
    expect(preview!.meta).toBe(input.url)
  })

  it('展开区不渲染输出全文（长输出只进弹窗，卡片保持轻）', () => {
    const out = Array.from({ length: 60 }, (_, i) => `行${i}`).join('\n')
    const { container } = render(<ToolCallCard part={webPart('WebFetch', input, out)} />)
    expandCard(container)
    expect(container.textContent).not.toContain('行59')
  })
})
