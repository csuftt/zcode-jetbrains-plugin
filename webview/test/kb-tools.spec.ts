/**
 * 知识库工具的输出解析与友好展示数据（utils/kbTools）：
 *   - 条目行 / 目录结构 / 读全文 / 出错回执的解析，形状不对返回 null
 *   - 参数的中文字段、整理类工具的一句话回执、结果数量
 */
import { describe, it, expect } from 'vitest'
import {
  kbParams,
  kbParseRead,
  kbParseRows,
  kbParseTree,
  kbReceipt,
  kbResultHint,
  kbStateLabel,
} from '@/utils/kbTools'

const LIST_OUT = JSON.stringify([
  {
    id: 'kb-4f70a2bb64', title: 'Keepalived 配置经验总结', folder: '故障运维/运维手册', tags: ['Keepalived'],
    project: 'keepalived', status: 'ok', sourcePath: 'E:/a/keepalived.md', contentPath: 'E:/a/keepalived.md',
  },
  {
    id: 'kb-ca22aefd1f', title: '自签 Harbor 排障手册', folder: '故障运维/运维手册', tags: ['Docker', 'Harbor'],
    project: 'docs', status: 'snapshot', sourcePath: 'E:/b/harbor.md', contentPath: 'G:/lib/snapshots/kb-ca22aefd1f/harbor.md',
  },
  {
    id: 'kb-ad7975f864', title: 'Docker 内存限制治理', folder: '典型案例', tags: [], project: '运维',
    status: 'missing', sourcePath: 'G:/c/docker.md', contentPath: '',
  },
])

const SEARCH_OUT = JSON.stringify([
  {
    id: 'kb-476262abdb', title: 'MCP 演练文档', folder: '', tags: ['演练标签', 'x y'], project: 'docs', status: 'ok',
    sourcePath: 'G:/tmp/演练文档.md', contentPath: 'G:/tmp/演练文档.md',
    snippet: '…演练 MCP 收录的临时文档，测完即删。\n\n## 小节\n内容里放一个检索用的词：栀子花。\n',
  },
])

const TREE_OUT = JSON.stringify({
  folders: [
    { id: 'f-1', path: '典型案例', count: 12, subtreeCount: 12 },
    { id: 'f-2', path: '平台架构', count: 0, subtreeCount: 21 },
    { id: 'f-3', path: '平台架构/信创兼容', count: 5, subtreeCount: 5 },
  ],
  rootCount: 0,
  total: 42,
  tags: [
    { name: '信创', color: '#8B2F4F', count: 7 },
    { name: 'Harbor', color: '', count: 1 },
  ],
})

describe('条目行解析', () => {
  it('逐行取标题/目录/标签/状态，快照与失效状态保留', () => {
    const rows = kbParseRows(LIST_OUT)!
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ title: 'Keepalived 配置经验总结', folder: '故障运维/运维手册', tags: ['Keepalived'], status: 'ok' })
    expect(rows[1].status).toBe('snapshot')
    expect(rows[2]).toMatchObject({ status: 'missing', tags: [], contentPath: '' })
  })

  it('不是 JSON / 不是数组 / 行里缺标题 → null（渲染层回退原文）', () => {
    expect(kbParseRows('not json')).toBeNull()
    expect(kbParseRows('{"error":"x"}')).toBeNull()
    expect(kbParseRows('[{"id":"kb-1"}]')).toBeNull()
    expect(kbParseRows(undefined)).toBeNull()
  })

  it('检索结果带命中片段', () => {
    expect(kbParseRows(SEARCH_OUT)![0].snippet).toContain('栀子花')
  })
})

describe('目录结构解析', () => {
  it('目录（直接挂载/含下级）、根级与全库条数、标签', () => {
    const tree = kbParseTree(TREE_OUT)!
    expect(tree.folders.map((f) => f.path)).toEqual(['典型案例', '平台架构', '平台架构/信创兼容'])
    expect(tree.folders[1]).toMatchObject({ count: 0, subtreeCount: 21 })
    expect(tree.total).toBe(42)
    expect(tree.tags[0]).toEqual({ name: '信创', color: '#8B2F4F', count: 7 })
  })

  it('形状不对 → null', () => {
    expect(kbParseTree(LIST_OUT)).toBeNull()
    expect(kbParseTree('{"folders":[]}')).toBeNull()
    expect(kbParseTree('{"folders":[{"path":"a"}],"tags":[],"rootCount":0,"total":1}')).toBeNull()
  })
})

describe('读全文解析', () => {
  it('头信息拆成标题/目录/标签/项目/状态/源路径，空行之后是正文', () => {
    const doc = kbParseRead(
      '### MCP 演练文档\n- folder: 运维/手册 | tags: ["a","b"] | project: docs | status: ok\n' +
      '- source: G:/tmp/演练文档.md\n\n# MCP 演练文档\n\n正文第一行\n',
    )!
    expect(doc).toEqual({
      title: 'MCP 演练文档', folder: '运维/手册', tags: ['a', 'b'], project: 'docs', status: 'ok',
      source: 'G:/tmp/演练文档.md', body: '# MCP 演练文档\n\n正文第一行\n',
    })
  })

  it('仅快照条目多一行 content 说明，不影响正文起点', () => {
    const doc = kbParseRead(
      '### 标题\n- folder:  | tags: [] | project: p | status: snapshot\n- source: Z:/nope.md\n' +
      '- content: from the knowledge base snapshot G:/s.md (the source file is not present)\n\n正文',
    )!
    expect(doc.status).toBe('snapshot')
    expect(doc.source).toBe('Z:/nope.md')
    expect(doc.body).toBe('正文')
  })

  it('头信息对不上 → null', () => {
    expect(kbParseRead('just text')).toBeNull()
    expect(kbParseRead('### 标题\n没有元信息行\n\n正文')).toBeNull()
  })

  it('换行是字面的 \\n（服务端多转义一次）→ 整段是一行，拆不出元信息', () => {
    expect(kbParseRead('### 标题\\n- folder: a | tags: [] | project: p | status: ok\\n- source: x.md\\n\\n正文')).toBeNull()
  })
})

describe('结果数量（收起即可见）', () => {
  it('检索：命中条数 / 无命中；浏览：条数；目录结构：目录数', () => {
    expect(kbResultHint('MCP.zcgui-knowledge_kb_search', SEARCH_OUT)).toEqual({ text: '命中 1 条' })
    expect(kbResultHint('MCP.zcgui-knowledge_kb_search', '[]')).toEqual({ text: '无命中' })
    expect(kbResultHint('MCP.zcgui-knowledge_kb_list', LIST_OUT)).toEqual({ text: '3 条' })
    expect(kbResultHint('MCP.zcgui-knowledge_kb_tree', TREE_OUT)).toEqual({ text: '3 个目录' })
  })

  it('整理类工具没有可数的 → null；还没输出 → null；解析不了 → null', () => {
    expect(kbResultHint('MCP.zcgui-knowledge_kb_tag', '{"name":"a","color":"#000000"}')).toBeNull()
    expect(kbResultHint('MCP.zcgui-knowledge_kb_list', undefined)).toBeNull()
    expect(kbResultHint('MCP.zcgui-knowledge_kb_list', 'half')).toBeNull()
  })

  it('输出是出错回执 → 未成功', () => {
    expect(kbResultHint('MCP.zcgui-knowledge_kb_folder', '{"error":"folder not found: nope"}')).toEqual({ text: '未成功', error: true })
  })

  it('状态用词：快照 / 已失效，正常不标', () => {
    expect(kbStateLabel('snapshot')).toBe('快照')
    expect(kbStateLabel('missing')).toBe('已失效')
    expect(kbStateLabel('ok')).toBe('')
  })
})

describe('参数的友好展示', () => {
  it('只列传了的，字段名是中文，值原样', () => {
    expect(kbParams('MCP.zcgui-knowledge_kb_search', { query: '栀子花', folder: '运维', limit: 20 })).toEqual([
      { label: '检索词', value: '栀子花' },
      { label: '目录', value: '运维' },
      { label: '最多', value: '20 条' },
    ])
    expect(kbParams('MCP.zcgui-knowledge_kb_list', {})).toEqual([{ label: '范围', value: '全部条目' }])
    expect(kbParams('MCP.zcgui-knowledge_kb_tree', {})).toEqual([])
  })

  it('整理类工具：操作译成中文，多条条目折成条数（悬浮看 id 列表），标签颜色带色块', () => {
    expect(kbParams('MCP.zcgui-knowledge_kb_entry', {
      action: 'move', ids: ['kb-1', 'kb-2', 'kb-1'], folderPath: '', index: 0,
    })).toEqual([
      { label: '操作', value: '移动' },
      { label: '条目', value: '3 条', title: 'kb-1\nkb-2\nkb-1' },
      { label: '移到', value: '根级' },
      { label: '放在第几位', value: '1' },
    ])
    expect(kbParams('MCP.zcgui-knowledge_kb_tag', { action: 'color', name: '演练标签', color: '#123456' })).toEqual([
      { label: '操作', value: '改颜色' },
      { label: '标签', value: '演练标签' },
      { label: '颜色', value: '#123456', swatch: '#123456' },
    ])
    expect(kbParams('MCP.zcgui-knowledge_kb_add', { path: 'G:/d/文档.md', tags: ['a', 'b'], notes: '' })).toEqual([
      { label: '文件', value: 'G:/d/文档.md' },
      { label: '标签', value: 'a、b' },
    ])
  })
})

describe('整理类工具的一句话回执', () => {
  const T = (short: string) => `mcp__zcgui-knowledge__${short}`

  it('标签：新建带颜色与色块，改名/删除带受影响的条目数', () => {
    expect(kbReceipt(T('kb_tag'), { action: 'create', name: '演练标签' }, '{"name":"演练标签","color":"#4A9EFF"}'))
      .toEqual({ text: '已创建标签「演练标签」，颜色 #4A9EFF', swatch: '#4A9EFF' })
    expect(kbReceipt(T('kb_tag'), { action: 'rename', name: 'a', newName: 'b' }, '{"updatedEntries":2}').text)
      .toBe('标签「a」已改名为「b」，2 条条目跟着改')
    expect(kbReceipt(T('kb_tag'), { action: 'delete', name: 'a' }, '{"updatedEntries":0}').text)
      .toBe('已删除标签「a」，没有条目用到它')
    expect(kbReceipt(T('kb_tag'), { action: 'color', name: 'a', color: '#111111' }, '{"ok":"color set"}'))
      .toEqual({ text: '标签「a」已改为 #111111', swatch: '#111111' })
  })

  it('目录：新建/改名/移动（位置）/删除（退回根级的条数）', () => {
    expect(kbReceipt(T('kb_folder'), { action: 'create', path: '运维/Nginx' }, '{"id":"f-1","path":"运维/Nginx"}').text)
      .toBe('已新建目录「运维/Nginx」')
    expect(kbReceipt(T('kb_folder'), { action: 'rename', path: 'a', newName: 'b' }, '{"ok":"renamed"}').text)
      .toBe('目录「a」已改名为「b」')
    expect(kbReceipt(T('kb_folder'), { action: 'move', path: '平台部署', newPath: '', index: 3 }, '{"ok":"moved"}').text)
      .toBe('目录「平台部署」已移到「根级」，放在第 4 位')
    expect(kbReceipt(T('kb_folder'), { action: 'delete', path: 'a' }, '{"movedToRoot":3}').text)
      .toBe('已删除目录「a」，其中 3 条退回根级')
  })

  it('条目：移动/更新/摘除的条数', () => {
    expect(kbReceipt(T('kb_entry'), { action: 'move', ids: ['kb-1'], folderPath: '平台部署' }, '{"moved":1}').text)
      .toBe('已把 1 条移到「平台部署」')
    expect(kbReceipt(T('kb_entry'), { action: 'update', ids: ['kb-1'] }, '{"updated":1}').text).toBe('已更新 1 条')
    expect(kbReceipt(T('kb_entry'), { action: 'delete', ids: ['kb-1'] }, '{"removed":1}').text).toBe('已摘除 1 条')
  })

  it('收录：新建与「此前已收录」两种说法', () => {
    expect(kbReceipt(T('kb_add'), { path: 'x.md' }, '{"id":"kb-1","title":"文档","folder":"运维","existed":false}').text)
      .toBe('已收录「文档」，放在「运维」')
    expect(kbReceipt(T('kb_add'), { path: 'x.md' }, '{"id":"kb-1","title":"文档","folder":"","existed":true}').text)
      .toBe('「文档」此前已收录，这次更新了元数据，放在根级')
  })

  it('输出是出错回执 → 未成功 + 原因；形状对不上 → null', () => {
    expect(kbReceipt(T('kb_folder'), { action: 'delete', path: 'a' }, '{"error":"folder not found: a"}'))
      .toEqual({ text: '未成功', detail: 'folder not found: a' })
    expect(kbReceipt(T('kb_folder'), { action: 'delete', path: 'a' }, '{"ok":"moved"}')).toBeNull()
    expect(kbReceipt(T('kb_list'), {}, '[]')).toBeNull()
  })
})
