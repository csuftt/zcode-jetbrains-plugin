/**
 * Markdown 注入面（dangerouslySetInnerHTML）外链点击接管契约：
 *
 *   renderMarkdown / renderInline 产出 <a target=_blank>，JCEF 没挂
 *   onBeforePopup 拦截层，原生点击会把 webview 顶帧导航走（内网地址加载
 *   失败即整页空白，2026-11-09 用户点思考块里的链接白屏实证）。
 *   契约：容器委托 preventDefault + openExternalUrl 桥接管，与
 *   MarkdownBlock 同语义。
 *
 *   1. ThinkingBlock 正文：http 外链点击 → openExternalUrl + defaultPrevented
 *      （缺陷 GW：此前只委托了 .md-file-link，外链裸奔）
 *   2. ThinkingBlock 正文：.md-file-link 仍优先短路走 openFile（组合顺序守卫）
 *   3. ChangelogDialog 正文（renderInline 同族注入面）：外链点击同契约
 *
 * jsdom 对锚点默认行为无导航语义，preventDefault 以事件冒泡监听器读
 * defaultPrevented 断言。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

const openExternalUrlMock = vi.fn()
const sendToJavaMock = vi.fn()

vi.mock('@/ipc/bridge', () => ({
  sendToJava: (...args: unknown[]) => sendToJavaMock(...args),
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
  GITHUB_REPO_URL: 'https://github.com/csuftt/zcode-jetbrains-plugin',
}))

import '@/i18n/config'
import { ThinkingBlock } from '@/components/ThinkingBlock'
import { ChangelogDialog } from '@/components/ChangelogDialog'
import type { ReasoningPart } from '@/types/messages'
import type { ChangelogEntry } from '@/version/changelog'

function makePart(text: string): ReasoningPart {
  return { type: 'reasoning', text }
}

/** dispatch 完成后读事件终态 defaultPrevented（与委托相位无关：bubble/capture
 * 委托均覆盖；面板 stopPropagation 只截传播不撤 preventDefault，语义同浏览器
 * 抑制默认导航的判定） */
function clickAndCheckPrevented(el: Element): boolean {
  const evt = new MouseEvent('click', { bubbles: true, cancelable: true })
  el.dispatchEvent(evt)
  return evt.defaultPrevented
}

afterEach(() => {
  cleanup()
  openExternalUrlMock.mockClear()
  sendToJavaMock.mockClear()
})

describe('ThinkingBlock 外链点击接管（缺陷 GW）', () => {
  beforeEach(() => {
    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })

  it('正文 http 外链点击 → openExternalUrl + preventDefault（防 webview 被导航走）', () => {
    const { container } = render(
      <ThinkingBlock
        part={makePart('上级管理端：[wvp 管理端](http://10.100.18.148:31023)（suiteng_user）')}
        autoExpand
      />,
    )
    const anchor = container.querySelector('a[href="http://10.100.18.148:31023"]')
    expect(anchor).not.toBeNull()
    const prevented = clickAndCheckPrevented(anchor!)
    expect(openExternalUrlMock).toHaveBeenCalledWith('http://10.100.18.148:31023')
    expect(prevented).toBe(true)
  })

  it('.md-file-link 仍优先短路走 openFile（组合顺序守卫）', () => {
    const { container } = render(<ThinkingBlock part={makePart('看 [fileLink](src/utils/fileLink.ts) 的实现')} autoExpand />)
    const body = container.querySelector('.thinking-block__body') as HTMLElement
    expect(body).not.toBeNull()
    // 文件链接 DOM 形态由 renderMarkdown 注入，这里直接植元素测委托本身
    body.innerHTML = '<span class="md-file-link" data-file-path="G:/demo/a.ts" data-file-line="12">a.ts</span>'
    const link = body.querySelector('.md-file-link')!
    const prevented = clickAndCheckPrevented(link)
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'openFile', filePath: 'G:/demo/a.ts', line: 12 })
    expect(openExternalUrlMock).not.toHaveBeenCalled()
    expect(prevented).toBe(true)
  })
})

describe('ChangelogDialog 外链点击接管（同族注入面）', () => {
  const entry: ChangelogEntry = {
    version: '9.9.9',
    date: '2026-11-09',
    zh: {
      intro: '升级说明见 [仓库](https://example.com/repo)。',
      sections: [{ title: 'Fixed', items: ['条目一'] }],
    },
  }

  it('intro 里的外链点击 → openExternalUrl + preventDefault', () => {
    const { container } = render(<ChangelogDialog entries={[entry]} onClose={() => {}} />)
    const anchor = container.querySelector('a[href="https://example.com/repo"]')
    expect(anchor).not.toBeNull()
    const prevented = clickAndCheckPrevented(anchor!)
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/repo')
    expect(prevented).toBe(true)
  })

  it('非链接区域点击不触发外链桥（关闭/翻页按钮不受影响）', () => {
    const { container } = render(<ChangelogDialog entries={[entry]} onClose={() => {}} />)
    fireEvent.click(container.querySelector('.changelog-dialog__section-title')!)
    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })
})
