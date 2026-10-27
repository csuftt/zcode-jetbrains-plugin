/**
 * ::visualize 指令解析测试：
 * 1. JSON 形态（含 Windows 反斜杠转义路径）
 * 2. 单/双冒号兼容 + key="value" 降级形态
 * 3. 围栏感知切分（代码块内不拦截）
 * 4. 流式中未闭合前缀 → viz-pending
 */
import { describe, it, expect } from 'vitest'
import { parseVizDirective, splitVisualizeDirectives, maskVisualizeDirectives } from '@/utils/visualizeDirective'
import { extractPreviewFileReferences } from '@/utils/previewArtifacts'

describe('parseVizDirective', () => {
  it('双冒号 JSON 形态：Windows 反斜杠转义路径正确解码', () => {
    // 消息原文里路径是 JSON 转义形态（字面双反斜杠），测试字符串按 JS 转义写四支
    const line = '::visualize{"path":"C:\\\\Users\\\\me\\\\.zcode\\\\v2\\\\visualizations\\\\ab\\\\gold.html","title":"金价趋势","mode":"wide"}'
    const d = parseVizDirective(line)
    expect(d).not.toBeNull()
    expect(d!.path).toBe('C:\\Users\\me\\.zcode\\v2\\visualizations\\ab\\gold.html')
    expect(d!.title).toBe('金价趋势')
    expect(d!.mode).toBe('wide')
  })

  it('单冒号同族兼容', () => {
    const d = parseVizDirective(':visualize{"path":"/home/me/.zcode/visualizations/x.html"}')
    expect(d).not.toBeNull()
    expect(d!.path).toBe('/home/me/.zcode/visualizations/x.html')
    expect(d!.title).toBeUndefined()
  })

  it('key="value" 降级形态（citation 同族，不做 JSON 解码）', () => {
    const d = parseVizDirective('::visualize{path="C:\\tmp\\chart.html" title="图"}')
    expect(d).not.toBeNull()
    expect(d!.path).toBe('C:\\tmp\\chart.html')
    expect(d!.title).toBe('图')
  })

  it('无 path 的 JSON → null', () => {
    expect(parseVizDirective('::visualize{"title":"只有标题"}')).toBeNull()
  })

  it('普通文本行 → null', () => {
    expect(parseVizDirective('这是普通段落')).toBeNull()
    expect(parseVizDirective('```mermaid\\ngraph TD\\n```')).toBeNull()
  })

  it('前后空白容忍', () => {
    const d = parseVizDirective('  ::visualize{"path":"/a/b.html"}  ')
    expect(d).not.toBeNull()
    expect(d!.path).toBe('/a/b.html')
  })
})

describe('splitVisualizeDirectives', () => {
  it('正文前后混合：md 段原样保留，指令段被拦出', () => {
    const md = [
      '# 标题',
      '',
      '::visualize{"path":"C:\\\\v\\\\a.html"}',
      '',
      '结尾说明',
    ].join('\n')
    const segs = splitVisualizeDirectives(md)
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ type: 'md', text: '# 标题' })
    expect(segs[1].type).toBe('viz')
    expect(segs[2]).toEqual({ type: 'md', text: '结尾说明' })
  })

  it('代码围栏内的指令行不拦截', () => {
    const md = ['```text', '::visualize{"path":"/x.html"}', '```'].join('\n')
    const segs = splitVisualizeDirectives(md)
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('md')
    expect((segs[0] as { text: string }).text).toContain('::visualize')
  })

  it('流式中未闭合前缀 → viz-pending（隐藏裸文本）', () => {
    const segs = splitVisualizeDirectives('前置文本\n\n::visualize{"path":"C:\\\\v\\\\a')
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ type: 'md', text: '前置文本' })
    expect(segs[1].type).toBe('viz-pending')
  })

  it('空串 → 空数组；纯指令 → 单段', () => {
    expect(splitVisualizeDirectives('')).toEqual([])
    const segs = splitVisualizeDirectives('::visualize{"path":"/a.html"}')
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('viz')
  })

  it('相邻多指令行逐行拦出（无需空行分隔）', () => {
    const segs = splitVisualizeDirectives(
      ['::visualize{"path":"/a.html"}', '::visualize{"path":"/b.html"}'].join('\n'),
    )
    expect(segs.filter((s) => s.type === 'viz')).toHaveLength(2)
  })
})

describe('maskVisualizeDirectives（预览卡双出防线）', () => {
  const DIR = '::visualize{"path":"C:\\\\Users\\\\me\\\\.zcode\\\\v2\\\\visualizations\\\\ab\\\\gold-price-trend-2026.html","title":"金价"}'

  it('指令行等长掩码，offset 与换行结构不变', () => {
    const text = `前置说明\n\n${DIR}\n\n结尾说明`
    const masked = maskVisualizeDirectives(text)
    expect(masked.length).toBe(text.length)
    expect(masked).not.toContain('::visualize')
    expect(masked).toContain('前置说明')
    expect(masked).toContain('结尾说明')
  })

  it('掩码后 extractPreviewFileReferences 不再抽出 html 候选', () => {
    const text = `::visualize{"path":"C:\\\\v\\\\gold-price-trend-2026.html"}\n\n正文说明`
    expect(extractPreviewFileReferences(text, 'G:/demo')).toEqual([])
  })

  it('无指令文本原样返回', () => {
    const text = '# 标题\n\n普通正文 docs/a.md'
    expect(maskVisualizeDirectives(text)).toBe(text)
  })

  it('围栏内指令行不掩码', () => {
    const text = '```text\n::visualize{"path":"/x.html"}\n```'
    expect(maskVisualizeDirectives(text)).toBe(text)
  })
})
