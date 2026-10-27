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
import { VisualizeBlock } from './VisualizeBlock'
import { splitVisualizeDirectives } from '@/utils/visualizeDirective'
import { copyText } from '@/utils/clipboard'
import { openExternalUrl } from '@/ipc/bridge'
import { openFileLinkFromEvent } from '@/utils/fileLink'
import { useStore } from '@/store/useStore'
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
  // 先拦出 ::visualize 指令段（围栏感知），普通文本段再走常规切块渲染——
  // DOMPurify 白名单无 iframe，可视化卡必须走 React 组件而非 HTML 注入
  const pieces = useMemo(() => splitVisualizeDirectives(markdown), [markdown])
  // 工作区根：文件路径链接化解析相对路径用（currentWorkspacePath 优先——
  // worktree 场景以当前会话工作区为准）
  const workspaceRoot = useStore((s) => s.currentWorkspacePath || s.projectPath)

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
  // 事件委托 preventDefault 后走 openExternalUrl（协议白名单 + Java 侧二次校验）。
  // 同委托还管 .md-file-link 文件路径链接（openFile op 在 IDE 打开并跳行）
  const handleLink = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (openFileLinkFromEvent(e)) return
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') || ''
    if (href) openExternalUrl(href)
  }, [])

  if (pieces.length === 0) return null

  return (
    <div className="markdown-body" onClick={handleCopy} onClickCapture={handleLink}>
      {pieces.map((seg, i) => {
        if (seg.type === 'viz') {
          return <VisualizeBlock key={`viz-${i}`} directive={seg.directive} />
        }
        if (seg.type === 'viz-pending') {
          // 流式中指令行未写完：先隐藏裸文本（防反斜杠路径闪现），写完的下一帧替换成组件
          return <div key={`vizp-${i}`} className="viz-pending" aria-hidden="true" />
        }
        const blocks = splitMarkdownBlocks(seg.text)
        return blocks.map((block, j) => (
          <BlockSection
            key={`${i}-${j}`}
            markdown={block}
            // 只有最后一段的最后一块可能是流式中（在增长），前面的块都是完整的
            isStreaming={streaming && i === pieces.length - 1 && j === blocks.length - 1}
            workspaceRoot={workspaceRoot}
          />
        ))
      })}
      {streaming && <span className="markdown-body__cursor">▋</span>}
    </div>
  )
}
