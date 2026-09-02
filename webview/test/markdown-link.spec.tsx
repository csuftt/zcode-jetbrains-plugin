/**
 * markdown 外链渲染与点击链路（2026-09-02 审查收尾补测）：
 *   1. renderMarkdown：http(s) 链接保留 <a href>；非白名单协议（mailto/ftp/锚点）
 *      按"纯文本渲染"unwrap 掉 <a>（DOMPurify afterSanitizeAttributes hook）
 *   2. MarkdownBlock handleLink：白名单链接点击 → openExternalUrl（防 JCEF
 *      内部导航的 preventDefault 接管路径）
 *   3. openExternalUrl：前端白名单——非 http(s) 不发桥消息
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

const openExternalUrlMock = vi.fn()

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}))

import { renderMarkdown } from '@/utils/markdown'
import { MarkdownBlock } from '@/components/MarkdownBlock'

// 白名单用例测真实现（vi.mock 只服务组件渲染；真函数走 __ZCODE_CEF_QUERY__ 通道）
const { openExternalUrl: realOpenExternalUrl, GITHUB_REPO_URL } = await vi.importActual<
  typeof import('@/ipc/bridge')
>('@/ipc/bridge')

afterEach(() => cleanup())

describe('renderMarkdown 链接协议白名单', () => {
  it('http/https 链接保留 <a href>', () => {
    const html = renderMarkdown('[文档](https://example.com/a) 与 [http](http://b.com/c)')
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('href="http://b.com/c"')
  })

  it.each([
    ['mailto', '[信箱](mailto:a@b.com)'],
    ['ftp', '[文件](ftp://x.com/f)'],
    ['页内锚点', '[目录](#section)'],
    ['相对路径', '[本地](./doc/x.html)'],
  ])('%s 链接 unwrap 成纯文本（无 <a>，文字保留）', (_name, md) => {
    const html = renderMarkdown(md)
    expect(html).not.toContain('<a')
    expect(html).toMatch(/信箱|文件|目录|本地/)
  })

  it('非白名单链接整体压平后正文不丢', () => {
    const html = renderMarkdown('前文 [不可跳](javascript:alert(1)) 后文')
    expect(html).toContain('前文')
    expect(html).toContain('后文')
    expect(html).toContain('不可跳')
  })
})

describe('MarkdownBlock 外链点击接管', () => {
  beforeEach(() => openExternalUrlMock.mockClear())

  it('点击 http 链接 → openExternalUrl(href)', () => {
    const { container } = render(<MarkdownBlock markdown="看 [官方文档](https://docs.example.com/x)" />)
    const anchor = container.querySelector('a[href="https://docs.example.com/x"]')
    expect(anchor).not.toBeNull()
    fireEvent.click(anchor!)
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://docs.example.com/x')
  })

  it('DOMPurify unwrap 后无 <a>，点击文本不触发跳转', () => {
    const { container } = render(<MarkdownBlock markdown="联系 [信箱](mailto:a@b.com)" />)
    expect(container.querySelector('a')).toBeNull()
    fireEvent.click(container.querySelector('.markdown-body p')!)
    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })
})

describe('openExternalUrl 前端白名单', () => {
  it('http/https 发桥消息（__ZCODE_CEF_QUERY__ 通道）', () => {
    const spy = vi.fn()
    ;(window as unknown as Record<string, unknown>).__ZCODE_CEF_QUERY__ = spy
    try {
      realOpenExternalUrl('https://example.com/page')
      expect(spy).toHaveBeenCalledTimes(1)
      const sent = JSON.parse(spy.mock.calls[0][0].request)
      expect(sent).toEqual({ op: 'openExternal', url: 'https://example.com/page' })
    } finally {
      delete (window as unknown as Record<string, unknown>).__ZCODE_CEF_QUERY__
    }
  })

  it('非 http(s) 与空白串静默拒绝（不发桥消息）', () => {
    const spy = vi.fn()
    ;(window as unknown as Record<string, unknown>).__ZCODE_CEF_QUERY__ = spy
    try {
      realOpenExternalUrl('javascript:alert(1)')
      realOpenExternalUrl('file:///c:/x')
      realOpenExternalUrl('')
      realOpenExternalUrl('   ')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      delete (window as unknown as Record<string, unknown>).__ZCODE_CEF_QUERY__
    }
  })

  it('仓库地址常量仍为 openExternal 无参默认目标（回归锚点）', () => {
    expect(GITHUB_REPO_URL).toBe('https://github.com/csuftt/zcode-jetbrains-plugin')
  })
})
