/**
 * 流式 Markdown 逐块渲染优化
 *
 * 规划文档第二节第 1 点（cc-gui 的 splitMarkdownBlocks + BlockSection）：
 *
 * 问题：流式逐字 token 来时，每次重新渲染整篇 Markdown → O(整篇) → 卡。
 *
 * 解法：
 *   1. splitMarkdownBlocks()：按空行切 markdown，但不切进代码围栏/数学公式内部。
 *   2. 每个块独立渲染成 HTML，用 React.memo 包裹，key 用块索引 + 内容 hash。
 *   3. 流式时只有"最后一个块"在增长，前面块的 HTML 不变 → React 不碰它们的 DOM。
 *      单次 token 渲染成本从 O(整篇) 降到 O(最后一块)。
 */

import { memo, useMemo } from 'react'
import { renderMarkdown } from '@/utils/markdown'
import { MermaidBlock } from './MermaidBlock'
import '../styles/markdown.less'

interface BlockSectionProps {
  /** 单个块的 markdown 文本（已切分好）*/
  markdown: string
  /** 是否在流式中（最后一块传 true，做 streamSafe 补全）*/
  isStreaming: boolean
}

/**
 * 提取纯 mermaid 代码块（整块就是 ```mermaid 围栏）。
 * 兼容已闭合与未闭合（流式中）两种形态。
 * 与其它文本混排的 mermaid 块不拦截（按普通代码块渲染，可接受）。
 */
function extractMermaid(block: string): { code: string } | null {
  const m = block.match(/^```(mermaid|mmd)\s*\n([\s\S]*?)(?:\n```\s*)?$/)
  if (!m) return null
  return { code: m[2] }
}

/**
 * 单个块的渲染器。memo 包裹：只要 markdown 内容不变就不重渲染。
 *
 * - 纯 mermaid 块 → MermaidBlock（图表渲染，流式防抖）
 * - 其他块 → renderMarkdown 输出 HTML（dangerouslySetInnerHTML 是必须的——marked 输出
 *   HTML，安全性由 renderMarkdown 里的 DOMPurify 保证）
 */
export const BlockSection = memo(function BlockSection({ markdown, isStreaming }: BlockSectionProps) {
  const mermaidBlock = useMemo(() => extractMermaid(markdown), [markdown])

  if (mermaidBlock) {
    return (
      <div className="md-block md-block--mermaid">
        <MermaidBlock code={mermaidBlock.code} streaming={isStreaming} />
      </div>
    )
  }

  const html = useMemo(
    () => renderMarkdown(markdown, isStreaming),
    [markdown, isStreaming],
  )
  return <div className="md-block" dangerouslySetInnerHTML={{ __html: html }} />
})

/**
 * 按顶层块切分 Markdown。
 *
 * 规则（cc-gui splitMarkdownBlocks）：
 *   - 按空行切分
 *   - 但不切进代码围栏（``` 或 ~~~）内部
 *   - 不切进数学公式（$$...$$）内部（阶段 2.3 暂无 KaTeX，但预留逻辑）
 *
 * @returns 块数组，每个块是一段连续的非空行
 */
export function splitMarkdownBlocks(md: string): string[] {
  if (!md) return []

  const lines = md.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let inFence = false
  let fenceChar = ''

  for (const line of lines) {
    const trimmed = line.trim()

    // 检测围栏开关
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      const ch = fenceMatch[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (fenceChar === ch) {
        inFence = false
        fenceChar = ''
      }
    }

    // 空行且不在围栏内 → 块边界
    if (trimmed === '' && !inFence) {
      if (current.length > 0) {
        blocks.push(current.join('\n'))
        current = []
      }
    } else {
      current.push(line)
    }
  }

  // 收尾：最后一块
  if (current.length > 0) {
    blocks.push(current.join('\n'))
  }

  return blocks
}
