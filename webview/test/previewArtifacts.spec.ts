/**
 * 产物预览卡提取纯函数测试（B2 二期）
 * 对齐官方客户端提取语义：五源+保护区 / md-html fileChanges 门控 / 网站卡严格域 / 限额去重
 */
import { describe, expect, it } from 'vitest'
import {
  buildPreviewCards,
  extractPreviewFileReferences,
  getPreviewCardFilePath,
  getPreviewFileKind,
  PREVIEW_CARD_CANDIDATE_LIMIT,
  resolvePreviewPath,
} from '@/utils/previewArtifacts'

const WS = 'G:/demo'

describe('resolvePreviewPath', () => {
  it('相对路径锚 workspace', () => {
    expect(resolvePreviewPath(WS, 'docs/report.md')).toBe('G:/demo/docs/report.md')
  })
  it('绝对路径原样归一（反斜杠→正斜杠）', () => {
    expect(resolvePreviewPath(WS, 'G:\\demo\\docs\\plan.md')).toBe('G:/demo/docs/plan.md')
  })
  it('尾部标点与行号剥离', () => {
    expect(resolvePreviewPath(WS, 'report.md。')).toBe('G:/demo/report.md')
    expect(resolvePreviewPath(WS, 'src/a.md:12')).toBe('G:/demo/src/a.md')
    expect(resolvePreviewPath(WS, 'src/a.md:12:34')).toBe('G:/demo/src/a.md')
  })
  it('file:// URL 取 pathname（Windows 盘符形态去首斜杠）', () => {
    expect(resolvePreviewPath(WS, 'file:///G:/demo/a.md')).toBe('G:/demo/a.md')
  })
  it('~/ 前缀拒绝（shell 展示语义非稳定引用）', () => {
    expect(resolvePreviewPath(WS, '~/notes.md')).toBeNull()
  })
  it('越出 workspace 的 ../ 拒绝', () => {
    expect(resolvePreviewPath(WS, '../outside.md')).toBeNull()
  })
  it('空 workspace 时相对路径拒绝', () => {
    expect(resolvePreviewPath('', 'a.md')).toBeNull()
  })
})

describe('getPreviewFileKind', () => {
  it('扩展名表全覆盖', () => {
    expect(getPreviewFileKind('a.MD')).toBe('markdown')
    expect(getPreviewFileKind('a.html')).toBe('html')
    expect(getPreviewFileKind('a.htm')).toBe('html')
    expect(getPreviewFileKind('a.docx')).toBe('docx')
    expect(getPreviewFileKind('a.xlsx')).toBe('xlsx')
    expect(getPreviewFileKind('a.pptx')).toBe('pptx')
    expect(getPreviewFileKind('a.pdf')).toBe('pdf')
    expect(getPreviewFileKind('a.mp4')).toBe('video')
    expect(getPreviewFileKind('a.flac')).toBe('audio')
    expect(getPreviewFileKind('a.txt')).toBeNull()
  })
})

describe('extractPreviewFileReferences 基础源', () => {
  it('裸路径（相对+带目录）', () => {
    const refs = extractPreviewFileReferences('见 docs/report.md 和 README.md。', WS)
    expect(refs.map((r) => r.kind)).toEqual(['markdown', 'markdown'])
    expect(refs[0]!.path).toBe('G:/demo/docs/report.md')
    expect(refs[1]!.path).toBe('G:/demo/README.md')
  })
  it('反引号定界', () => {
    const refs = extractPreviewFileReferences('产出在 `build/output.pdf` 内', WS)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.kind).toBe('pdf')
  })
  it('markdown 链接', () => {
    const refs = extractPreviewFileReferences('[报告](docs/report.md) 已生成', WS)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.path).toBe('G:/demo/docs/report.md')
  })
  it('file:// URL', () => {
    const refs = extractPreviewFileReferences('文件 file:///G:/demo/a.docx 完成', WS)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.kind).toBe('docx')
  })
  it('citation 指令只放行 Office/PDF/音视频', () => {
    const ok = extractPreviewFileReferences(
      ':zcode-file-citation{path="docs/rep.pdf"}',
      WS,
    )
    expect(ok.map((r) => r.kind)).toEqual(['pdf'])
    // artifact_kind 与扩展名不符 → 不出卡
    const mismatch = extractPreviewFileReferences(
      '::zcode-file-citation{path="docs/rep.xlsx" artifact_kind="presentation"}',
      WS,
    )
    expect(mismatch).toHaveLength(0)
    // citation 内 md 路径不走 citation 通道（md 必须 fileChanges 门控）
    const mdCitation = extractPreviewFileReferences(
      ':zcode-file-citation{path="docs/a.md"}',
      WS,
    )
    expect(mdCitation).toHaveLength(0)
  })
  it('保护区：md 链接内的路径不再被裸路径正则重复捞出', () => {
    const refs = extractPreviewFileReferences('[a.md](docs/a.md)', WS)
    expect(refs).toHaveLength(1)
  })
  it('同路径去重保留后提及', () => {
    const refs = extractPreviewFileReferences('docs/a.md 完成后又改了 docs/a.md', WS)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.start).toBeGreaterThan(10)
  })
})

describe('buildPreviewCards', () => {
  it('md 命中本轮 fileChanges 才出卡（changedPaths 为 null 未拉到时暂不出）', () => {
    const text = '报告见 docs/report.md'
    expect(buildPreviewCards(text, WS, null)).toHaveLength(0)
    expect(buildPreviewCards(text, WS, [])).toHaveLength(0)
    const cards = buildPreviewCards(text, WS, ['docs/report.md'])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ type: 'file', kind: 'markdown', path: 'G:/demo/docs/report.md' })
  })
  it('md 裸文件名按叶子名唯一命中账本路径', () => {
    const cards = buildPreviewCards('已写 report.md', WS, ['docs/report.md'])
    expect(cards[0]!.type === 'file' && cards[0]!.path).toBe('G:/demo/docs/report.md')
  })
  it('叶子名歧义（多处同名）不猜', () => {
    expect(buildPreviewCards('已写 report.md', WS, ['a/report.md', 'b/report.md'])).toHaveLength(0)
  })
  it('html 命中后出 html 文件卡', () => {
    const cards = buildPreviewCards('页面 index.html 已生成', WS, ['index.html'])
    expect(cards[0]).toMatchObject({ type: 'file', kind: 'html', title: 'index.html' })
  })
  it('Office/PDF/音视频 无需门控（changedPaths 空也出）', () => {
    const cards = buildPreviewCards('看 demo.pdf 与 song.mp3', WS, [])
    expect(cards.map((c) => (c.type === 'file' ? c.kind : ''))).toEqual(['audio', 'pdf'])
  })
  it('reverted 账本路径视为未命中（组件传空数组即抑制）', () => {
    expect(buildPreviewCards('见 a.md', WS, [])).toHaveLength(0)
  })
  it('网站卡：localhost/127.0.0.1 http(s)，外域不出', () => {
    const cards = buildPreviewCards('预览 http://localhost:3000 与 https://example.com', WS, [])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ type: 'website', url: 'http://localhost:3000' })
    const ip = buildPreviewCards('本地 http://127.0.0.1:8080/app/', WS, [])
    expect(ip[0]!).toMatchObject({ type: 'website' })
  })
  it('网站卡尾部标点剥离 + md 链接标签做标题', () => {
    const cards = buildPreviewCards('[首页](http://localhost:5173)。', WS, [])
    expect(cards[0]).toMatchObject({ type: 'website', title: '首页', url: 'http://localhost:5173' })
  })
  it('后提及优先排序', () => {
    const cards = buildPreviewCards('先看 a.pdf 再看 b.pdf', WS, [])
    expect(cards.map((c) => (c.type === 'file' ? c.title : ''))).toEqual(['b.pdf', 'a.pdf'])
  })
  it('候选上限 15', () => {
    const text = Array.from({ length: 20 }, (_, i) => `f${i}.pdf`).join(' ')
    expect(buildPreviewCards(text, WS, [])).toHaveLength(PREVIEW_CARD_CANDIDATE_LIMIT)
  })
  it('同文件文件卡与网站卡并存时按 key 去重不炸', () => {
    const cards = buildPreviewCards('http://localhost:3000 和 http://localhost:3000', WS, [])
    expect(cards).toHaveLength(1)
  })
})

describe('getPreviewCardFilePath', () => {
  it('文件卡有路径、网站卡无', () => {
    expect(getPreviewCardFilePath({ type: 'file', kind: 'pdf', title: 'a', path: '/x/a.pdf' })).toBe('/x/a.pdf')
    expect(getPreviewCardFilePath({ type: 'website', title: 'w', url: 'http://localhost:1' })).toBeNull()
  })
})

describe('占位符路径展开（缺陷 GY）', () => {
  const ENV = { TEMP: 'C:/Users/demo/AppData/Local/Temp', TMPDIR: '/tmp' }

  it('resolvePreviewPath：%VAR% 展开为绝对路径', () => {
    expect(resolvePreviewPath(WS, '%TEMP%\\report.md', ENV)).toBe('C:/Users/demo/AppData/Local/Temp/report.md')
    expect(resolvePreviewPath(WS, '$TMPDIR/a.md', ENV)).toBe('/tmp/a.md')
    expect(resolvePreviewPath(WS, '${TMPDIR}/a.md', ENV)).toBe('/tmp/a.md')
  })
  it('resolvePreviewPath：白名单未到（null）→ 不可解析，绝不按 workspace 相对拼接', () => {
    expect(resolvePreviewPath(WS, '%TEMP%\\report.md', null)).toBeNull()
    expect(resolvePreviewPath(WS, '%TEMP%\\report.md')).not.toBe('G:/demo/%TEMP%/report.md')
  })
  it('resolvePreviewPath：变量查不到 → 不可解析', () => {
    expect(resolvePreviewPath(WS, '%UNKNOWN_VAR%\\report.md', ENV)).toBeNull()
  })
  it('resolvePreviewPath：~/ 仍拒绝（官方对齐，不受展开影响）', () => {
    expect(resolvePreviewPath(WS, '~/notes.md', ENV)).toBeNull()
  })

  it('ENV 源：无反引号裸占位符路径可提取（FILE_PATH_RE 起始类不含 % 的缺口）', () => {
    const refs = extractPreviewFileReferences('文档已写好：%TEMP%\\handoff-db-adapt-guides.md 请查收', WS, ENV)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.kind).toBe('markdown')
    expect(refs[0]!.path).toBe('C:/Users/demo/AppData/Local/Temp/handoff-db-adapt-guides.md')
  })
  it('ENV 源与反引号定界源不双出', () => {
    const refs = extractPreviewFileReferences('文档已写好：`%TEMP%\\handoff.md` 请查收', WS, ENV)
    expect(refs).toHaveLength(1)
  })
  it('白名单未到时占位符引用不产（env 到达后组件二段补出）', () => {
    expect(extractPreviewFileReferences('%TEMP%\\handoff.md', WS, null)).toHaveLength(0)
  })

  it('md 占位符卡：展开后命中 fileChanges 账本出卡', () => {
    const cards = buildPreviewCards(
      '文档已写好：%TEMP%\\handoff-db-adapt-guides.md',
      WS,
      ['C:\\Users\\demo\\AppData\\Local\\Temp\\handoff-db-adapt-guides.md'],
      ENV,
    )
    expect(cards).toHaveLength(1)
    // 命中后卡片路径取账本原始形态（既有设计：组件 stat/openFile 两侧都做斜杠归一）
    expect(cards[0]).toMatchObject({
      type: 'file',
      kind: 'markdown',
      path: 'C:\\Users\\demo\\AppData\\Local\\Temp\\handoff-db-adapt-guides.md',
    })
  })
  it('md 占位符卡：账本无该路径不出（防幻觉门控不放松）', () => {
    expect(buildPreviewCards('%TEMP%\\handoff.md', WS, ['other.md'], ENV)).toHaveLength(0)
  })
  it('Office 占位符卡：无门控直出（展开后 stat 存在性由组件层保证）', () => {
    const cards = buildPreviewCards('报告 %TEMP%\\demo.pdf 已生成', WS, [], ENV)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ type: 'file', kind: 'pdf', title: 'demo.pdf' })
  })
})
