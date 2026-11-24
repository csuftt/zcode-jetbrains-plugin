/**
 * 聊天里的知识库图标（KbIcon）与插件资源里的工具窗图标（icons/knowledge.svg）是同一个造型：
 * 两边各存一份路径数据，这里盯着一致——改图标时两处一起改，别只改一边。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { KB_ICON_PATHS } from '@/components/KbIcon'

const RESOURCE_DIR = path.resolve(__dirname, '../../intellij-plugin/src/main/resources/icons')

/** SVG 文件里按书写顺序排列的路径数据（空白归一）*/
function pathDataOf(file: string): string[] {
  const text = readFileSync(path.join(RESOURCE_DIR, file), 'utf8')
  return [...text.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1].trim().replace(/\s+/g, ' '))
}

describe('知识库图标与工具窗图标同形', () => {
  it('亮色、暗色两份资源与网页内联版的路径逐条相同', () => {
    for (const file of ['knowledge.svg', 'knowledge_dark.svg']) {
      const paths = pathDataOf(file)
      expect(paths.length).toBeGreaterThan(0)
      expect(paths.map((d) => d.replace(/\s+/g, ' '))).toEqual(KB_ICON_PATHS.map((d) => d.replace(/\s+/g, ' ')))
    }
  })
})
