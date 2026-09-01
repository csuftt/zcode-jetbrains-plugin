/**
 * BlockSection 条件 hooks 回归测试（React #300 黑屏）
 *
 * 缺陷：mermaid 形态提前 return 跳过 html useMemo → 同一块实例在
 * 「mermaid ↔ 普通」形态间切换时 hooks 数量变化 →
 * "Rendered fewer hooks than expected" → React 整树卸载 → JCEF 黑屏。
 *
 * 触发形态：mermaid 围栏闭合后、空行切块生效前，流式 delta 把后续文本
 * 追加进同一块（如「mermaid 图 + 表格」的回复）。
 * 修复：两个 useMemo 无条件调用。本测试按行流式回放完整回复序列，断言不抛。
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

import '@/i18n/config'
import { MarkdownBlock } from '@/components/MarkdownBlock'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 120 60"><rect/></svg>' })),
  },
}))

const FULL = [
  '正文段，先给结论。',
  '',
  '```mermaid',
  'flowchart LR',
  '    A[用户浏览商品] --> B[加入购物车]',
  '    B --> C[提交订单]',
  '    C --> D{库存校验}',
  '    D -->|库存充足| E[锁定库存]',
  '    D -->|库存不足| F[提示缺货]',
  '```',
  '', // 空行切块
  '这张图特意设计的测试点：',
  '',
  '| 测试项 | 操作 |',
  '|---|---|',
  '| 复制代码 | hover 工具栏 |',
  '| 垂直居中 | 点放大进弹窗 |',
  '',
  '测完有问题随时说。',
].join('\n')

afterEach(cleanup)

describe('BlockSection 流式形态切换', () => {
  it('按行流式回放「mermaid + 表格」回复不触发 React #300', async () => {
    const errors: unknown[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args[0])
    }
    try {
      const utils = render(<MarkdownBlock markdown="" streaming />)
      const lines = FULL.split('\n')
      for (let i = 1; i <= lines.length; i++) {
        await act(async () => {
          utils.rerender(<MarkdownBlock markdown={lines.slice(0, i).join('\n')} streaming />)
        })
      }
      await act(async () => {
        utils.rerender(<MarkdownBlock markdown={FULL} streaming={false} />)
      })
    } finally {
      console.error = origError
    }
    const hookErrors = errors.filter((e) =>
      String(e).includes('fewer hooks'),
    )
    expect(hookErrors).toEqual([])
  })

  it('回放结束后：mermaid 图与表格块同时渲染', async () => {
    const utils = render(<MarkdownBlock markdown="" streaming />)
    await act(async () => {
      utils.rerender(<MarkdownBlock markdown={FULL} streaming={false} />)
    })
    // mermaid 块走 MermaidBlock（渲染出 svg），表格块走 marked HTML
    await act(async () => {})
    expect(document.querySelector('svg')).toBeTruthy()
    expect(document.querySelector('table')).toBeTruthy()
  })
})
