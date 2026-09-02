/**
 * Markdown 渲染块
 *
 * 规划文档第四节：assistant 消息满宽 Markdown 渲染。
 * 内部用 BlockSection 逐块 memo，流式优化。
 *
 * 用法：
 *   <MarkdownBlock markdown={text} />
 *   <MarkdownBlock markdown={text} streaming />  // 流式中的最后一段
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { BlockSection, splitMarkdownBlocks } from './BlockSection'
import { copyText } from '@/utils/clipboard'
import { openExternalUrl } from '@/ipc/bridge'
import '../styles/markdown.less'

interface Props {
  markdown: string
  /** 是否在流式中（影响最后一个块的 streamSafe 补全）*/
  streaming?: boolean
}

/** 复制成功后按钮保持 ✓ 的时长（ms） */
const COPY_DONE_MS = 1500

export function MarkdownBlock({ markdown, streaming = false }: Props) {
  const { t } = useTranslation()
  const blocks = useMemo(() => splitMarkdownBlocks(markdown), [markdown])

  // 代码块复制按钮活在 dangerouslySetInnerHTML 里，React 管不到，
  // 统一在容器上事件委托；成功反馈直接改 classList（memo 块不受影响）
  const handleCopy = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.md-code-copy')
    if (!btn) return
    const code = btn.closest('.md-code-wrap')?.querySelector('code')
    const text = code?.textContent ?? ''
    if (!text) return
    const ok = await copyText(text)
    if (!ok) return
    btn.classList.add('md-code-copy--done')
    btn.title = t('chat.code.copied')
    window.setTimeout(() => {
      btn.classList.remove('md-code-copy--done')
      btn.title = t('chat.code.copy')
    }, COPY_DONE_MS)
  }, [t])

  // 外链点击接管：renderMarkdown 产出 <a target=_blank>，但 JCEF 没挂
  // onBeforePopup 拦截层，原生点击要么无反应要么把 webview 导航走——
  // 事件委托 preventDefault 后走 openExternalUrl（协议白名单 + Java 侧二次校验）
  const handleLink = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') || ''
    if (href) openExternalUrl(href)
  }, [])

  if (blocks.length === 0) return null

  return (
    <div className="markdown-body" onClick={handleCopy} onClickCapture={handleLink}>
      {blocks.map((block, i) => (
        <BlockSection
          key={i}
          markdown={block}
          // 只有最后一个块可能是流式中（在增长），前面的块都是完整的
          isStreaming={streaming && i === blocks.length - 1}
        />
      ))}
      {streaming && <span className="markdown-body__cursor">▋</span>}
    </div>
  )
}
