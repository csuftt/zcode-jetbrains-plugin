/**
 * 知识库工具卡（单卡）友好渲染：
 *   - 头部：工具窗那本书的图标（不再是 database 图标）+ 中文友好名 + 动作摘要
 *     + 结果数量（检索/浏览/目录结构；出错标「未成功」）
 *   - 展开区：参数按中文字段展示，结果按工具解析成条目列表 / 目录树 / 正文 / 一句回执，
 *     替代裸 JSON；解析失败回退原文；可切到「原始数据」
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  openExternalUrl: () => {},
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { ToolCallCard } from '@/components/ToolCallCard'
import type { ToolPart } from '@/types/messages'

const LIST_OUT = JSON.stringify([
  {
    id: 'kb-4f70a2bb64', title: 'Keepalived 配置经验总结', folder: '故障运维/运维手册', tags: ['Keepalived'],
    project: 'keepalived', status: 'ok', sourcePath: 'E:/a/keepalived.md', contentPath: 'E:/a/keepalived.md',
  },
  {
    id: 'kb-ca22aefd1f', title: '自签 Harbor 排障手册', folder: '故障运维/运维手册', tags: ['Docker', 'Harbor'],
    project: 'docs', status: 'snapshot', sourcePath: 'E:/b/harbor.md', contentPath: 'G:/lib/snapshots/harbor.md',
  },
  {
    id: 'kb-ad7975f864', title: 'Docker 内存限制治理', folder: '典型案例', tags: [], project: '运维',
    status: 'missing', sourcePath: 'G:/c/docker.md', contentPath: '',
  },
])

const SEARCH_OUT = JSON.stringify([{
  id: 'kb-476262abdb', title: 'MCP 演练文档', folder: '', tags: ['演练标签'], project: 'docs', status: 'ok',
  sourcePath: 'G:/tmp/演练文档.md', contentPath: 'G:/tmp/演练文档.md',
  snippet: '…收录的临时文档，测完即删。\n内容里放一个检索用的词：栀子花。',
}])

const TREE_OUT = JSON.stringify({
  folders: [
    { id: 'f-1', path: '典型案例', count: 12, subtreeCount: 12 },
    { id: 'f-2', path: '平台架构', count: 0, subtreeCount: 21 },
    { id: 'f-3', path: '平台架构/信创兼容', count: 5, subtreeCount: 5 },
  ],
  rootCount: 0,
  total: 42,
  tags: [{ name: '信创', color: '#8B2F4F', count: 7 }, { name: 'Harbor', color: '', count: 1 }],
})

const READ_OUT = '### MCP 演练文档\n- folder:  | tags: ["演练标签"] | project: docs | status: ok\n' +
  '- source: G:/tmp/演练文档.md\n\n# MCP 演练文档\n\n这是一篇用来演练的文档。'

let seq = 0
function kbPart(
  short: string,
  input: Record<string, unknown>,
  output?: string,
  extra: Partial<ToolPart['state']> = {},
): ToolPart {
  return {
    type: 'tool',
    callID: `call_kb_${short}_${seq++}`,
    tool: `MCP.zcgui-knowledge_${short}`,
    state: { status: 'completed', input, output, time: { start: 1787283860000, end: 1787283861000 }, ...extra },
  }
}

function expandCard(container: HTMLElement) {
  fireEvent.click(container.querySelector('.tool-card__header')!)
}

beforeEach(() => {
  useStore.setState({ markdownPreview: null, subagentDetail: null, subagentReport: null })
})

afterEach(cleanup)

describe('头部', () => {
  it('图标是工具窗那本书（内联 SVG），不再是 database 图标', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_tag', { action: 'create', name: '演练标签' }, '{"name":"演练标签","color":"#4A9EFF"}')} />)
    expect(container.querySelector('.tool-card__icon svg.tool-card__kb-icon')).not.toBeNull()
    expect(container.querySelector('.codicon-database')).toBeNull()
    expect(container.querySelector('.tool-card__name')!.textContent).toBe('标签管理')
    expect(container.querySelector('.tool-card__summary')!.textContent).toBe('新建标签「演练标签」')
  })

  it('整理类工具：头部没有数量标注', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_entry', { action: 'delete', ids: ['kb-1'] }, '{"removed":1}')} />)
    expect(container.querySelector('.tool-card__kb-hint')).toBeNull()
  })

  it('检索 / 浏览 / 目录结构：收起就能看到结果数量', () => {
    expect(render(<ToolCallCard part={kbPart('kb_search', { query: '栀子花' }, SEARCH_OUT)} />).container
      .querySelector('.tool-card__kb-hint')!.textContent).toBe('命中 1 条')
    expect(render(<ToolCallCard part={kbPart('kb_list', { folder: '运维' }, LIST_OUT)} />).container
      .querySelector('.tool-card__kb-hint')!.textContent).toBe('3 条')
    expect(render(<ToolCallCard part={kbPart('kb_tree', {}, TREE_OUT)} />).container
      .querySelector('.tool-card__kb-hint')!.textContent).toBe('3 个目录')
  })

  it('输出是出错回执：标「未成功」', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_folder', { action: 'delete', path: 'nope' }, '{"error":"folder not found: nope"}', { status: 'error' })} />)
    const hint = container.querySelector('.tool-card__kb-hint')!
    expect(hint.textContent).toBe('未成功')
    expect(hint.classList.contains('tool-card__kb-hint--err')).toBe(true)
  })
})

describe('展开区：整理类工具', () => {
  it('参数按中文字段展示，结果是一句回执（带标签色块），不再有裸 JSON', () => {
    const { container } = render(
      <ToolCallCard part={kbPart('kb_tag', { action: 'create', name: '演练标签' }, '{"name":"演练标签","color":"#4A9EFF"}')} />,
    )
    expandCard(container)
    const params = [...container.querySelectorAll('.kb-param')].map((p) => p.textContent)
    expect(params).toEqual(['操作新建', '标签演练标签'])
    expect(container.querySelector('.kb-receipt')!.textContent).toBe('已创建标签「演练标签」，颜色 #4A9EFF')
    expect((container.querySelector('.kb-receipt .kb-swatch') as HTMLElement).style.background).toBe('rgb(74, 158, 255)')
    expect(container.querySelector('.tool-card__code')).toBeNull()
  })

  it('条目移动：回执说清移到哪、放在第几位', () => {
    const { container } = render(
      <ToolCallCard part={kbPart('kb_entry', { action: 'move', ids: ['kb-1'], folderPath: '平台部署', index: 3 }, '{"moved":1}')} />,
    )
    expandCard(container)
    expect(container.querySelector('.kb-receipt')!.textContent).toBe('已把 1 条移到「平台部署」，放在第 4 位')
  })

  it('出错回执：红叉 + 原因', () => {
    const { container } = render(
      <ToolCallCard part={kbPart('kb_folder', { action: 'delete', path: 'nope' }, '{"error":"folder not found: nope"}', { status: 'error' })} />,
    )
    expandCard(container)
    expect(container.querySelector('.kb-receipt--err')!.textContent).toBe('未成功')
    expect(container.querySelector('.kb-receipt__detail')!.textContent).toBe('folder not found: nope')
  })

  it('工具自身报错（state.error）：错误区块', () => {
    const { container } = render(
      <ToolCallCard part={kbPart('kb_read', { id: 'kb-1' }, undefined, { status: 'error', error: 'MCP server exited' })} />,
    )
    expandCard(container)
    const section = container.querySelector('.tool-card__section--err')!
    expect(section.textContent).toContain('MCP server exited')
    expect(container.querySelectorAll('.tool-card__section--err')).toHaveLength(1)
  })

  it('结果带出错回执时优先于工具自身报错（回执里的原因更具体）', () => {
    const { container } = render(
      <ToolCallCard part={kbPart('kb_folder', { action: 'delete', path: 'nope' }, '{"error":"folder not found: nope"}', { status: 'error', error: 'Tool execution failed' })} />,
    )
    expandCard(container)
    expect(container.querySelector('.kb-receipt--err')!.textContent).toBe('未成功')
    expect(container.querySelector('.kb-receipt__detail')!.textContent).toBe('folder not found: nope')
    expect(container.textContent).not.toContain('Tool execution failed')
  })

  it('工具自身报错：切到「原始数据」也看得到错误', () => {
    const { container } = render(
      <ToolCallCard part={kbPart('kb_read', { id: 'kb-1' }, undefined, { status: 'error', error: 'Tool input failed inputSchema validation' })} />,
    )
    expandCard(container)
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === '原始数据')!)
    const section = container.querySelector('.tool-card__section--err')!
    expect(section.textContent).toContain('Tool input failed inputSchema validation')
  })
})

describe('展开区：检索与浏览', () => {
  it('浏览：条目列表（标题 / 标签 / 状态标注），同一目录只说一次，不再有裸 JSON', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_list', { folder: '全部' }, LIST_OUT)} />)
    expandCard(container)
    const rows = container.querySelectorAll('.kb-row')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('Keepalived 配置经验总结')
    expect(rows[1].querySelectorAll('.kb-row__tag')).toHaveLength(2)
    expect([...rows[1].querySelectorAll('.kb-row__state')].map((e) => e.textContent)).toEqual(['快照'])
    expect(rows[2].querySelector('.kb-row__state')!.textContent).toBe('已失效')
    // 三条分属两个目录：每行各报目录
    expect(rows[0].querySelector('.kb-row__folder')!.textContent).toBe('故障运维/运维手册')
    expect(rows[2].querySelector('.kb-row__folder')!.textContent).toBe('典型案例')
    expect(container.querySelector('.tool-card__code')).toBeNull()
  })

  it('浏览：结果都在同一个目录下时目录写在说明行里', () => {
    const same = JSON.stringify(JSON.parse(LIST_OUT).slice(0, 2))
    const { container } = render(<ToolCallCard part={kbPart('kb_list', { folder: '故障运维/运维手册' }, same)} />)
    expandCard(container)
    expect(container.querySelector('.kb-caption')!.textContent).toBe('共 2 条 · 故障运维/运维手册')
    expect(container.querySelector('.kb-row__folder')).toBeNull()
  })

  it('检索：说明行写命中条数，每条带命中片段', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_search', { query: '栀子花' }, SEARCH_OUT)} />)
    expandCard(container)
    expect(container.querySelector('.kb-caption')!.textContent).toBe('命中 1 条')
    expect(container.querySelector('.kb-row__snippet')!.textContent).toContain('栀子花')
  })

  it('空结果：一句话，没有列表', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_search', { query: '不存在' }, '[]')} />)
    expandCard(container)
    expect(container.querySelector('.kb-caption')!.textContent).toBe('没有命中的条目')
    expect(container.querySelector('.kb-rows')).toBeNull()
  })

  it('列表一次放全，不设「显示全部」：全部条目都在限高滚动区里', () => {
    const many = JSON.stringify(Array.from({ length: 25 }, (_, i) => ({
      id: `kb-${i}`, title: `条目 ${i}`, folder: '', tags: [], project: '', status: 'ok', sourcePath: '', contentPath: '',
    })))
    const { container } = render(<ToolCallCard part={kbPart('kb_list', {}, many)} />)
    expandCard(container)
    // 结果再长也由滚动区承载：不截断、不设「显示全部」
    expect(container.querySelector('.kb-rows')!.classList.contains('kb-scroll')).toBe(true)
    expect(container.querySelectorAll('.kb-row')).toHaveLength(25)
    expect(container.querySelector('.kb-more')).toBeNull()
  })

  it('目录结构：目录树连同标签在一个限高滚动区里', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_tree', {}, TREE_OUT)} />)
    expandCard(container)
    const scroll = container.querySelector('.kb-scroll')!
    expect(scroll.querySelector('.kb-tree')).not.toBeNull()
    expect(scroll.querySelector('.kb-tags')).not.toBeNull()
  })
})

describe('展开区：目录结构与读全文', () => {
  it('目录结构：根级一行 + 目录按深度缩进 + 含下级报总数 + 标签带色点与条数', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_tree', {}, TREE_OUT)} />)
    expandCard(container)
    expect(container.querySelector('.kb-caption')!.textContent).toBe('全库 42 条 · 3 个目录')
    const rows = [...container.querySelectorAll('.kb-tree__row')]
    expect(rows.map((r) => r.querySelector('.kb-tree__name')!.textContent)).toEqual(['根级', '典型案例', '平台架构', '信创兼容'])
    expect(rows[3].getAttribute('style')).toContain('padding-left: 14px')
    expect(rows[2].querySelector('.kb-tree__count')!.textContent).toBe('21 条')
    expect(rows[2].querySelector('.kb-tree__count')!.classList.contains('kb-tree__count--sum')).toBe(true)
    const chips = [...container.querySelectorAll('.kb-tagchip')]
    expect(chips.map((c) => c.textContent)).toEqual(['信创7', 'Harbor1'])
    expect((chips[0].querySelector('.kb-tagchip__dot') as HTMLElement).style.background).toBe('rgb(139, 47, 79)')
  })

  it('读全文：标题 + 目录/标签 + 源路径 + 正文；「查看完整结果」开预览弹窗', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_read', { id: 'kb-476262abdb' }, READ_OUT)} />)
    expandCard(container)
    expect(container.querySelector('.kb-read__title')!.textContent).toBe('MCP 演练文档')
    expect(container.querySelector('.kb-read__source')!.textContent).toBe('G:/tmp/演练文档.md')
    expect(container.querySelector('.kb-read__text')!.textContent).toBe('# MCP 演练文档\n\n这是一篇用来演练的文档。')
    fireEvent.click(container.querySelector('.tool-card__full-btn')!)
    expect(useStore.getState().markdownPreview?.title).toBe('MCP 演练文档')
    expect(useStore.getState().markdownPreview?.meta).toBe('G:/tmp/演练文档.md')
  })
})

describe('回退与原始数据', () => {
  it('输出解析不了（流式半截 / 形状变更）→ 原文', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_list', { folder: 'x' }, '[{"id":"kb-1"')} />)
    expandCard(container)
    expect(container.querySelector('.kb-rows')).toBeNull()
    expect(container.querySelector('.tool-card__code')!.textContent).toBe('[{"id":"kb-1"')
  })

  it('点「原始数据」看 JSON，再点「友好视图」回来', () => {
    const { container } = render(
      <ToolCallCard part={kbPart('kb_tag', { action: 'create', name: '演练标签' }, '{"name":"演练标签","color":"#4A9EFF"}')} />,
    )
    expandCard(container)
    fireEvent.click(container.querySelector('.kb-raw__btn')!)
    const code = [...container.querySelectorAll('.tool-card__code')].map((e) => e.textContent)
    expect(code).toEqual([
      JSON.stringify({ action: 'create', name: '演练标签' }, null, 2),
      '{"name":"演练标签","color":"#4A9EFF"}',
    ])
    expect(container.querySelector('.kb-receipt')).toBeNull()
    fireEvent.click(container.querySelector('.kb-raw__btn')!)
    expect(container.querySelector('.kb-receipt')).not.toBeNull()
  })

  it('「原始数据」挂在第一个区块标签行的右端，不单独占一行；原始数据视图里的「友好视图」同理', () => {
    const { container } = render(
      <ToolCallCard part={kbPart('kb_tag', { action: 'create', name: '演练标签' }, '{"name":"演练标签","color":"#4A9EFF"}')} />,
    )
    expandCard(container)
    const firstLabel = container.querySelector('.tool-card__section .tool-card__label')!
    expect(firstLabel.classList.contains('tool-card__label--with-action')).toBe(true)
    expect(firstLabel.querySelector('.kb-raw__btn')!.textContent).toBe('原始数据')
    // 展开区里没有单独成行的切换按钮
    expect(container.querySelector('.kb-body > .kb-raw')).toBeNull()
    expect(container.querySelector('.kb-body')!.lastElementChild!.classList.contains('tool-card__section')).toBe(true)

    fireEvent.click(firstLabel.querySelector('.kb-raw__btn')!)
    const rawFirstLabel = container.querySelector('.tool-card__section .tool-card__label')!
    expect(rawFirstLabel.querySelector('.kb-raw__btn')!.textContent).toBe('友好视图')
  })

  it('读全文：「原始数据」在输入行的右端，「查看完整结果」在输出行的右端', () => {
    const { container } = render(<ToolCallCard part={kbPart('kb_read', { id: 'kb-476262abdb' }, READ_OUT)} />)
    expandCard(container)
    const labels = [...container.querySelectorAll('.tool-card__section .tool-card__label')]
    expect(labels[0].querySelector('.kb-raw__btn')).not.toBeNull()
    expect(labels[0].querySelector('.tool-card__full-btn')).toBeNull()
    expect(labels[1].querySelector('.tool-card__full-btn')).not.toBeNull()
    expect(labels[1].querySelector('.kb-raw__btn')).toBeNull()
  })

  it('结果还没回来：参数 + 等待提示', () => {
    const { container } = render(
      <ToolCallCard part={kbPart('kb_search', { query: 'x' }, undefined, { status: 'running', time: { start: 1 } })} />,
    )
    expandCard(container)
    expect([...container.querySelectorAll('.kb-param')].map((p) => p.textContent)).toEqual(['检索词x'])
    expect(container.querySelector('.kb-empty')!.textContent).toBe('等待结果…')
    expect(container.querySelector('.kb-raw__btn')).toBeNull()
  })
})
