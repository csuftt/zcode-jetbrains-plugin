/**
 * 知识库批量组卡（KbToolGroupCard，同名 kb 工具相邻聚组）：
 *   - 头部：工具窗那本书的图标 + 中文友好名 + 次数
 *   - 成员行：展开箭头 + 动作摘要 + 结果数量 + 状态；点一行就地展开这次调用的
 *     参数与结果（与单卡展开区同一套渲染），再点收起；键盘 Enter / 空格同样可切
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  openExternalUrl: () => {},
}))

import '@/i18n/config'
import { KbToolGroupCard } from '@/components/KbToolGroupCard'
import type { ToolPart } from '@/types/messages'

function rows(folder: string, n: number): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({
    id: `kb-${folder}-${i}`, title: `${folder} 条目 ${i}`, folder, tags: [], project: '', status: 'ok',
    sourcePath: '', contentPath: '',
  })))
}

function kbPart(
  short: string,
  input: Record<string, unknown>,
  output?: string,
  status: ToolPart['state']['status'] = 'completed',
): ToolPart {
  return {
    type: 'tool',
    callID: `call_${short}_${Math.random().toString(36).slice(2)}`,
    tool: `MCP.zcgui-knowledge_${short}`,
    state: { status, input, output, time: { start: 1787283860000, end: status === 'completed' ? 1787283861000 : undefined } },
  }
}

// 组卡本身不碰 store（读全文弹窗入口在这些用例里用不到）
afterEach(cleanup)

describe('知识库批量组卡', () => {
  it('头部：书的图标 + 友好名 + 次数；成员行带动作摘要与结果数量', () => {
    const { container } = render(
      <KbToolGroupCard parts={[
        kbPart('kb_list', { folder: '故障运维/运维手册' }, rows('故障运维/运维手册', 3)),
        kbPart('kb_list', { folder: '平台部署' }, rows('平台部署', 3)),
      ]} />,
    )
    expect(container.querySelector('.bash-group__title')!.textContent).toBe('知识库浏览 (2)')
    expect(container.querySelector('.bash-group__icon svg.bash-group__kb-icon')).not.toBeNull()
    expect(container.querySelector('.codicon-database')).toBeNull()
    const lines = [...container.querySelectorAll('.kb-group__row')]
    expect(lines.map((l) => l.querySelector('.kb-group__summary')!.textContent))
      .toEqual(['浏览「故障运维/运维手册」', '浏览「平台部署」'])
    expect(lines.map((l) => l.querySelector('.kb-group__hint')!.textContent)).toEqual(['3 条', '3 条'])
    // 没点之前不展开任何一行
    expect(container.querySelector('.kb-group__detail')).toBeNull()
  })

  it('点一行展开这次调用的参数与结果，再点收起；各行互不影响', () => {
    const { container } = render(
      <KbToolGroupCard parts={[
        kbPart('kb_entry', { action: 'move', ids: ['kb-1'], folderPath: '平台部署' }, '{"moved":1}'),
        kbPart('kb_entry', { action: 'delete', ids: ['kb-2'] }, '{"removed":1}'),
      ]} />,
    )
    const lines = [...container.querySelectorAll('.kb-group__row')]
    fireEvent.click(lines[0])
    const detail = container.querySelector('.kb-group__detail')!
    expect(detail.querySelector('.kb-param')!.textContent).toBe('操作移动')
    expect(detail.querySelector('.kb-receipt')!.textContent).toBe('已把 1 条移到「平台部署」')
    expect(lines[0].getAttribute('aria-expanded')).toBe('true')
    // 第二行没展开
    expect(container.querySelectorAll('.kb-group__detail')).toHaveLength(1)

    fireEvent.click(lines[1])
    expect(container.querySelectorAll('.kb-group__detail')).toHaveLength(2)
    expect(container.querySelectorAll('.kb-receipt')[1].textContent).toBe('已摘除 1 条')

    fireEvent.click(lines[0])
    expect(container.querySelectorAll('.kb-group__detail')).toHaveLength(1)
    expect(container.querySelector('.kb-receipt')!.textContent).toBe('已摘除 1 条')
    expect(lines[0].getAttribute('aria-expanded')).toBe('false')
  })

  it('键盘：Enter / 空格展开与收起', () => {
    const { container } = render(<KbToolGroupCard parts={[kbPart('kb_tag', { action: 'create', name: 'a' }, '{"name":"a","color":"#000000"}')]} />)
    const row = container.querySelector('.kb-group__row')!
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(container.querySelector('.kb-group__detail')).not.toBeNull()
    fireEvent.keyDown(row, { key: ' ' })
    expect(container.querySelector('.kb-group__detail')).toBeNull()
  })

  it('展开行里的「原始数据」只影响这一行；结果没回来的行显示等待', () => {
    const { container } = render(
      <KbToolGroupCard parts={[
        kbPart('kb_tag', { action: 'create', name: 'a' }, '{"name":"a","color":"#000000"}'),
        kbPart('kb_search', { query: 'x' }, undefined, 'running'),
      ]} />,
    )
    const lines = [...container.querySelectorAll('.kb-group__row')]
    fireEvent.click(lines[0])
    fireEvent.click(lines[1])
    expect(container.querySelectorAll('.kb-group__detail')).toHaveLength(2)
    expect(container.querySelector('.kb-receipt')!.textContent).toBe('已创建标签「a」，颜色 #000000')
    expect(container.querySelectorAll('.kb-empty')).toHaveLength(1)
    fireEvent.click(container.querySelector('.kb-raw__btn')!)
    expect(container.querySelectorAll('.tool-card__code')).toHaveLength(2) // 这一行的输入 + 输出 JSON
    expect(container.querySelector('.kb-receipt')).toBeNull()
  })

  it('超过 3 行：没展开时内部滚动；有行展开时放宽到 420px，仍然限高可滚', () => {
    const parts = Array.from({ length: 5 }, (_, i) => kbPart('kb_list', { folder: `目录${i}` }, rows(`目录${i}`, 1)))
    const { container } = render(<KbToolGroupCard parts={parts} />)
    const list = container.querySelector('.file-group__list') as HTMLElement
    expect(list.style.maxHeight).toBe('84px')
    fireEvent.click(container.querySelectorAll('.kb-group__row')[2])
    expect(list.style.maxHeight).toBe('420px')
    expect(list.style.overflowY).toBe('auto')
  })

  it('点头部整体收起/展开列表', () => {
    const { container } = render(
      <KbToolGroupCard parts={[
        kbPart('kb_list', { folder: 'a' }, rows('a', 1)),
        kbPart('kb_list', { folder: 'b' }, rows('b', 1)),
      ]} />,
    )
    fireEvent.click(container.querySelector('.bash-group__header')!)
    expect(container.querySelector('.file-group__list')).toBeNull()
    fireEvent.click(container.querySelector('.bash-group__header')!)
    expect(container.querySelectorAll('.kb-group__row')).toHaveLength(2)
  })
})
