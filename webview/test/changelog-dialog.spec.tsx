/**
 * ChangelogDialog（版本更新弹窗）渲染测试
 *
 * 行为约定（props 驱动，注入测试数据）：
 *   - 默认展示最新版（page=0）：v 徽章 / 节标题（标准节加 emoji）/ 列表项 / 引言段
 *   - 双语条目：中文段在前英文段在后，中间有语言分隔线
 *   - ←/→ 翻页、Esc 关闭（键盘 capture）；点遮罩关闭
 *   - 页码文本（当前 / 总数）恒显；≤10 版另有圆点导航（active 圆点），>10 版仅页码
 */

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import '@/i18n/config'
import { ChangelogDialog } from '@/components/ChangelogDialog'
import type { ChangelogEntry } from '@/version/changelog'

afterEach(cleanup)

const mkEntry = (version: string, bilingual: boolean): ChangelogEntry => ({
  version,
  date: '2026-08-21',
  zh: {
    intro: version === '9.9.9' ? '首版说明。\n> 引用行' : undefined,
    sections: [
      { title: 'Fixed', items: ['**修复甲**：描述一', '描述二'] },
      { title: '自定义节', items: ['条目'] },
    ],
  },
  ...(bilingual
    ? {
        en: {
          sections: [
            { title: 'Fixed', items: ['**Fix A**: description one'] },
            { title: 'Custom section', items: ['item'] },
          ],
        },
      }
    : {}),
})

const twoEntries = [mkEntry('9.9.9', true), mkEntry('9.9.8', false)]

describe('ChangelogDialog 渲染', () => {
  it('默认展示最新版：徽章 / emoji 节标题 / 列表项 / 引言（> 行为 blockquote）', () => {
    render(<ChangelogDialog entries={twoEntries} onClose={() => {}} />)
    expect(screen.getByText('v9.9.9')).toBeTruthy()
    expect(screen.getAllByText('🐛 Fixed').length).toBe(2) // zh + en 各一
    expect(screen.getByText('自定义节')).toBeTruthy() // 非标准节不加 emoji
    expect(screen.getByText('2026-08-21')).toBeTruthy()
    const strong = document.querySelectorAll('.changelog-dialog__list strong')
    expect(strong[0]?.textContent).toBe('修复甲')
    expect(strong[1]?.textContent).toBe('Fix A')
    expect(document.querySelector('.changelog-dialog__intro blockquote')?.textContent).toBe('引用行')
  })

  it('双语条目：中文段在前、英文段在后，中间语言分隔线；单语条目无分隔线', () => {
    render(<ChangelogDialog entries={twoEntries} onClose={() => {}} />)
    // 双语版（page 0）有分隔线，且 zh 节标题先于 en 出现在 DOM
    expect(document.querySelector('.changelog-dialog__lang-divider')).not.toBeNull()
    const titles = [...document.querySelectorAll('.changelog-dialog__section-title')].map((n) => n.textContent)
    expect(titles.indexOf('自定义节')).toBeLessThan(titles.indexOf('Custom section'))
    // 翻到单语版（page 1）无分隔线
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(document.querySelector('.changelog-dialog__lang-divider')).toBeNull()
  })

  it('→ 键翻到下一版，← 键翻回，首版 ← 不可再退', () => {
    render(<ChangelogDialog entries={twoEntries} onClose={() => {}} />)
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByText('v9.9.8')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(screen.getByText('v9.9.9')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(screen.getByText('v9.9.9')).toBeTruthy() // 仍为首版
  })

  it('Esc 与点遮罩触发 onClose', () => {
    const onClose = vi.fn()
    render(<ChangelogDialog entries={twoEntries} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(document.querySelector('.changelog-dialog__overlay') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('≤10 版圆点导航 + 页码文本，active 圆点与页码跟随翻页', () => {
    render(<ChangelogDialog entries={twoEntries} onClose={() => {}} />)
    const dots = document.querySelectorAll('.changelog-dialog__dot')
    expect(dots.length).toBe(2)
    expect(dots[0].classList.contains('changelog-dialog__dot--active')).toBe(true)
    expect(screen.getByText('1 / 2')).toBeTruthy()
    fireEvent.click(dots[1])
    expect(dots[1].classList.contains('changelog-dialog__dot--active')).toBe(true)
    expect(screen.getByText('v9.9.8')).toBeTruthy()
    expect(screen.getByText('2 / 2')).toBeTruthy()
  })

  it('>10 版改文本页码（n / total）', () => {
    const many = Array.from({ length: 12 }, (_, i) => mkEntry(`1.0.${11 - i}`, false))
    render(<ChangelogDialog entries={many} onClose={() => {}} />)
    expect(document.querySelectorAll('.changelog-dialog__dot').length).toBe(0)
    expect(screen.getByText('1 / 12')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByText('2 / 12')).toBeTruthy()
  })

  it('entries 为空数组不渲染', () => {
    const { container } = render(<ChangelogDialog entries={[]} onClose={() => {}} />)
    expect(container.querySelector('.changelog-dialog__overlay')).toBeNull()
  })
})
