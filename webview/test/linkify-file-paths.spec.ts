/**
 * 消息内文件路径链接化（设计稿 docs/internal/feat/消息内文件路径可点击打开.md）：
 *   1. resolveFileLink：候选文本 → 绝对路径 + 行号（从严校验——扩展名白名单、
 *      ~ / .. 拒绝、首尾粘连标点裁剪、中文行文粘字剥离）
 *   2. linkifyFilePaths：HTML 后处理——pre/a 子树不碰、行内 code 识别、
 *      URL 文本不误报、无工作区根时相对路径不链接、幂等
 *   3. openFileLinkFromEvent：点击委托 → openFile op（有 line 则带）
 *   4. renderMarkdown 集成：第三参 workspaceRoot 控制相对路径解析
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MouseEvent } from 'react'

const sendToJavaMock = vi.fn()

vi.mock('@/ipc/bridge', () => ({
  sendToJava: (...args: unknown[]) => sendToJavaMock(...args),
}))

import { linkifyFilePaths, resolveFileLink } from '@/utils/linkifyFilePaths'
import { openFileLinkFromEvent } from '@/utils/fileLink'
import { renderMarkdown } from '@/utils/markdown'

const ROOT = 'E:/ws'

describe('resolveFileLink 解析与从严校验', () => {
  it.each([
    ['相对路径+行号', 'webview/src/utils/markdown.ts:193', 'E:/ws/webview/src/utils/markdown.ts', 193],
    ['相对路径+L 行号', 'webview/src/a.ts:L12', 'E:/ws/webview/src/a.ts', 12],
    ['行范围取首行', 'webview/src/a.ts:12-34', 'E:/ws/webview/src/a.ts', 12],
    ['GitHub #L 行号', 'webview/vite.config.ts#L31', 'E:/ws/webview/vite.config.ts', 31],
    ['GitHub #L 范围取首行', 'webview/vite.config.ts#L31-32', 'E:/ws/webview/vite.config.ts', 31],
    ['GitHub #L-L 范围取首行', 'webview/vite.config.ts#L31-L32', 'E:/ws/webview/vite.config.ts', 31],
    ['相对路径无行号', 'docs/internal/feat/x.md', 'E:/ws/docs/internal/feat/x.md', undefined],
    ['CJK 路径段', 'docs/internal/feat/消息内文件路径可点击打开.md', 'E:/ws/docs/internal/feat/消息内文件路径可点击打开.md', undefined],
    ['./ 前缀归一', './src/a.ts', 'E:/ws/src/a.ts', undefined],
    ['Windows 绝对（反斜杠归一为正斜杠）', 'E:\\proj\\a\\b.md', 'E:/proj/a/b.md', undefined],
    ['Windows 绝对+行号', 'E:/proj/a/b.md:7', 'E:/proj/a/b.md', 7],
    ['Unix 绝对', '/home/user/proj/a.py', '/home/user/proj/a.py', undefined],
    ['括号粘连裁剪', '(webview/src/a.ts)', 'E:/ws/webview/src/a.ts', undefined],
    ['句尾点号裁剪', 'webview/src/a.ts.', 'E:/ws/webview/src/a.ts', undefined],
    ['中文行文粘字剥离', '见webview/src/a.ts', 'E:/ws/webview/src/a.ts', undefined],
    // 2026-10-09 缺口修复：带行号裸文件名 + 目录形态（feat/file-link-linenum-folder-open）
    ['裸文件名+行号（.gitignore:37）', '.gitignore:37', 'E:/ws/.gitignore', 37],
    ['裸文件名+行号（长文件名）', 'ZCodeToolWindowPanel.kt:1606', 'E:/ws/ZCodeToolWindowPanel.kt', 1606],
    ['裸文件名+GitHub #L 行号', 'CHANGELOG.md#L12', 'E:/ws/CHANGELOG.md', 12],
    ['目录 Unix 绝对（原样下发，Kotlin 前导 / 回退兜底）', '/docs/internal/', '/docs/internal/', undefined],
    ['目录相对', 'webview/src/', 'E:/ws/webview/src/', undefined],
    ['目录 Windows 绝对', 'E:/proj/a/b/', 'E:/proj/a/b/', undefined],
    ['目录相对带尾反斜杠（归一为正斜杠）', 'webview\\src\\', 'E:/ws/webview/src/', undefined],
  ])('%s：%s', (_name, raw, absPath, line) => {
    const target = resolveFileLink(raw, ROOT)
    expect(target).not.toBeNull()
    expect(target!.absPath).toBe(absPath)
    expect(target!.line).toBe(line)
  })

  it('显示文本保留 AI 原文（行号后缀在显示里，反斜杠不归一）', () => {
    expect(resolveFileLink('webview/src/a.ts:193', ROOT)!.display).toBe('webview/src/a.ts:193')
    expect(resolveFileLink('E:\\proj\\a\\b.md', ROOT)!.display).toBe('E:\\proj\\a\\b.md')
    expect(resolveFileLink('(webview/src/a.ts)', ROOT)!.display).toBe('webview/src/a.ts')
    expect(resolveFileLink('见webview/src/a.ts', ROOT)!.display).toBe('webview/src/a.ts')
  })

  it.each([
    ['裸文件名（无分隔符无行号，维持从严）', 'App.tsx'],
    ['裸文件名无行号（.gitignore）', '.gitignore'],
    ['时间形态（无扩展名）', '12:30'],
    ['目录形态无尾斜杠（无法与版本号串区分）', 'docs/internal'],
    ['分支名误报（扩展名白名单挡）', 'feature/0.2.1'],
    ['and/or 碎片', 'and/or'],
    ['~ 开头（基准非工作区根）', '~/.zcode/v2/setting.json'],
    ['.. 开头', '../other/x.ts'],
    ['中间含 /../', 'a/../b.ts'],
    ['未知扩展名', 'a/b/c.xyzabc'],
    ['目录路径（无扩展名）', 'C:\\Users\\Winmin'],
  ])('不链接：%s', (_name, raw) => {
    expect(resolveFileLink(raw, ROOT)).toBeNull()
  })

  it('无工作区根：相对路径不解析，绝对路径照常', () => {
    expect(resolveFileLink('webview/src/a.ts', '')).toBeNull()
    expect(resolveFileLink('E:/proj/a/b.md', '')!.absPath).toBe('E:/proj/a/b.md')
  })
})

describe('linkifyFilePaths HTML 后处理', () => {
  it('行内 code 里的路径链接化（span 属性 + 原文显示）', () => {
    const out = linkifyFilePaths('<p>改动在 <code>webview/src/a.ts:12</code> 完成</p>', ROOT)
    expect(out).toContain('class="md-file-link"')
    expect(out).toContain('data-file-path="E:/ws/webview/src/a.ts"')
    expect(out).toContain('data-file-line="12"')
    expect(out).toContain('>webview/src/a.ts:12</span>')
    // data-tip 悬浮气泡按真机拍板关闭（2026-10-09，代码注释保留供排查用）
    expect(out).not.toContain('data-tip')
  })

  it('pre 子树（围栏代码块）不链接', () => {
    const html = '<pre><code>webview/src/a.ts</code></pre>'
    expect(linkifyFilePaths(html, ROOT)).toBe(html)
  })

  it('a 子树（链接文字）不链接', () => {
    const html = '<p><a href="https://x.com">webview/src/a.ts</a></p>'
    expect(linkifyFilePaths(html, ROOT)).toBe(html)
  })

  it('URL 纯文本不误报（http://x.com/a.ts 无链接）', () => {
    const html = '<p>见 http://x.com/a.ts 即可</p>'
    expect(linkifyFilePaths(html, ROOT)).toBe(html)
  })

  it('无工作区根：相对路径原样，绝对路径链接', () => {
    const rel = '<p>改动在 webview/src/a.ts 完成</p>'
    expect(linkifyFilePaths(rel, '')).toBe(rel)
    const abs = linkifyFilePaths('<p>见 E:\\proj\\a\\b.md 即可</p>', '')
    expect(abs).toContain('data-file-path="E:/proj/a/b.md"')
  })

  it('无路径形态直接原样返回（快速门禁）', () => {
    const html = '<p>hello <strong>world</strong></p>'
    expect(linkifyFilePaths(html, ROOT)).toBe(html)
  })

  it('幂等：二次处理不重复包 span', () => {
    const once = linkifyFilePaths('<p>见 webview/src/a.ts 即可</p>', ROOT)
    expect(linkifyFilePaths(once, ROOT)).toBe(once)
  })

  it('CJK 句号留在链接外', () => {
    const out = linkifyFilePaths('<p>见 docs/internal/feat/x.md。</p>', ROOT)
    expect(out).toContain('>docs/internal/feat/x.md</span>。')
  })

  // 2026-10-09 缺口修复：裸文件名行号 + 目录形态（feat/file-link-linenum-folder-open）
  it('裸文件名+行号链接化（纯裸文件名文本不被快速门禁短路）', () => {
    const out = linkifyFilePaths('<p>排除 <code>.gitignore:37</code> 是既定规则</p>', ROOT)
    expect(out).toContain('class="md-file-link"')
    expect(out).toContain('data-file-path="E:/ws/.gitignore"')
    expect(out).toContain('data-file-line="37"')
    expect(out).toContain('>.gitignore:37</span>')
  })

  it('无行号裸文件名不链接（token 层不命中）', () => {
    const html = '<p>改动在 <code>changelog.ts</code> 与 <code>ZCodeToolWindowPanel.kt</code></p>'
    expect(linkifyFilePaths(html, ROOT)).toBe(html)
  })

  it('时间形态 12:30 不链接（门禁整文短路）', () => {
    const html = '<p>时长 12:30 结束</p>'
    expect(linkifyFilePaths(html, ROOT)).toBe(html)
  })

  it('目录路径链接化（结尾 /，无行号属性）', () => {
    const out = linkifyFilePaths('<p>见 <code>/docs/internal/</code> 与 <code>webview/src/</code></p>', ROOT)
    expect(out).toContain('data-file-path="/docs/internal/"')
    expect(out).toContain('data-file-path="E:/ws/webview/src/"')
    expect(out).not.toContain('data-file-line')
    expect(out).toContain('>/docs/internal/</span>')
  })

  it('目录无尾斜杠不链接', () => {
    const html = '<p>文档在 docs/internal 下面</p>'
    expect(linkifyFilePaths(html, ROOT)).toBe(html)
  })
})

describe('openFileLinkFromEvent 点击委托', () => {
  beforeEach(() => sendToJavaMock.mockClear())

  function fire(html: string, selector: string): boolean {
    const container = document.createElement('div')
    container.innerHTML = html
    const target = container.querySelector(selector) as HTMLElement
    const e = { target, preventDefault: vi.fn() } as unknown as MouseEvent<HTMLElement>
    return openFileLinkFromEvent(e)
  }

  it('带行号：openFile op 携带 line', () => {
    const handled = fire(
      '<p>见 <span class="md-file-link" data-file-path="E:/ws/a/b.ts" data-file-line="193">a/b.ts:193</span></p>',
      '.md-file-link',
    )
    expect(handled).toBe(true)
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'openFile', filePath: 'E:/ws/a/b.ts', line: 193 })
  })

  it('无行号：payload 不带 line 键', () => {
    fire('<span class="md-file-link" data-file-path="E:/ws/a/b.ts">a/b.ts</span>', '.md-file-link')
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'openFile', filePath: 'E:/ws/a/b.ts' })
  })

  it('点在链接内部子元素上也能命中（closest 委托）', () => {
    fire(
      '<span class="md-file-link" data-file-path="E:/ws/a/b.ts"><em>a/b.ts</em></span>',
      'em',
    )
    expect(sendToJavaMock).toHaveBeenCalledWith({ op: 'openFile', filePath: 'E:/ws/a/b.ts' })
  })

  it('非链接目标不处理（返回 false 让调用方走其它分支）', () => {
    const handled = fire('<p><span>plain</span></p>', 'span')
    expect(handled).toBe(false)
    expect(sendToJavaMock).not.toHaveBeenCalled()
  })
})

describe('renderMarkdown 集成（workspaceRoot 第三参）', () => {
  it('传根：行内 code 相对路径链接化', () => {
    const html = renderMarkdown('改动在 `webview/src/a.ts:12` 完成', false, ROOT)
    expect(html).toContain('class="md-file-link"')
    expect(html).toContain('data-file-path="E:/ws/webview/src/a.ts"')
    expect(html).toContain('data-file-line="12"')
  })

  it('不传根：相对路径不链接，绝对路径链接', () => {
    expect(renderMarkdown('改动在 `webview/src/a.ts` 完成')).not.toContain('md-file-link')
    expect(renderMarkdown('打开 `E:/proj/a/b.md` 即可')).toContain('md-file-link')
  })

  it('围栏代码块里的路径不链接', () => {
    const html = renderMarkdown('```\nwebview/src/a.ts\n```', false, ROOT)
    expect(html).not.toContain('md-file-link')
  })

  it('真机回归（2026-10-08）：CJK 文件名消息原文链接化', () => {
    const html = renderMarkdown(
      '已创建 `docs/静夜思.md`，内容为李白《静夜思》全诗（含标题、作者与四句正文）。',
      false,
      'E:/myIdeaProject/zcode-jet-plugin-test',
    )
    expect(html).toContain('data-file-path="E:/myIdeaProject/zcode-jet-plugin-test/docs/静夜思.md"')
    expect(html).toContain('>docs/静夜思.md</span>')
  })

  it('真机回归（2026-10-09）：#L 行号后缀整体进链接（显示不断截）', () => {
    const out = linkifyFilePaths('<p><code>webview/vite.config.ts#L31-32</code></p>', ROOT)
    expect(out).toContain('>webview/vite.config.ts#L31-32</span>')
    expect(out).toContain('data-file-path="E:/ws/webview/vite.config.ts"')
    expect(out).toContain('data-file-line="31"')
  })

  it('真机回归（2026-10-09）：commit 报告场景——.gitignore:37 与 /docs/internal/ 双双链接', () => {
    const html = renderMarkdown(
      '设计文档未随提交——`.gitignore:37` 排除 `/docs/internal/` 是项目既定规则',
      false,
      ROOT,
    )
    expect(html).toContain('data-file-path="E:/ws/.gitignore"')
    expect(html).toContain('data-file-line="37"')
    expect(html).toContain('data-file-path="/docs/internal/"')
  })
})
