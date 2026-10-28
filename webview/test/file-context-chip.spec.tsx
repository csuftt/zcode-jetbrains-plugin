/**
 * 用户气泡「当前文件上下文」chip 测试（隐式通道回显）
 *
 * 数据桥两来源（utils/fileContextParts 头注释）：
 *   - 服务端转录形态：user 消息 file part {type:'file', mime, filename: basename,
 *     url: 完整路径, metadata:{originalUrl, preview:{text}}}——行号从 preview.text
 *     头行解析（"[Selected code from PATH, lines X-Y of N]"，CurrentFileAttachment 装配）。
 *     2026-10-08 本机 db.part 实证样本直接作为 fixture。
 *   - 乐观形态（useStore.sendMessage 构造）：行号放 metadata.selection（结构化）。
 *
 * 断言三层：
 *   1. 纯函数：collectFileContextChips 提取与排除判据 / parseSelectionFromPreview
 *      头行解析 / fileContextPartFromAttachment 与服务端形态同构
 *   2. 渲染：气泡外 .msg__filectx 注脚排（clip 图标 + basename + #L 行号 + title 完整路径）；
 *      图片附件（mime image/*）不出 chip（走 collectImageParts 通道）
 *   3. 排除判据：正文 @引用（text part）不产 chip；zcode-artifact / http url 不产 chip
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: () => () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import '@/i18n/config'
import { MessageBubble } from '@/components/MessageBubble'
import {
  collectFileContextChips,
  parseSelectionFromPreview,
  fileContextPartFromAttachment,
} from '@/utils/fileContextParts'
import type { ZCodeMessage, MessagePart, FilePart } from '@/types/messages'

afterEach(() => cleanup())

// ---------- 纯函数 ----------

describe('parseSelectionFromPreview（preview.text 头行解析）', () => {
  it('选区区间头行 → {lineStart, lineEnd}', () => {
    expect(
      parseSelectionFromPreview('[Selected code from G:/proj/src/App.ts, lines 10-20 of 183]\n1\tcode'),
    ).toEqual({ lineStart: 10, lineEnd: 20 })
  })

  it('单行选区头行 → 起止相等', () => {
    expect(
      parseSelectionFromPreview('[Selected code from G:/proj/a.py, line 7 of 42]\n7\tcode'),
    ).toEqual({ lineStart: 7, lineEnd: 7 })
  })

  it('整文件头行（Full content）无行号 → null；空值 → null', () => {
    expect(parseSelectionFromPreview('[Full content of G:/proj/README.md, 183 lines]\n1\t<div>')).toBeNull()
    expect(parseSelectionFromPreview(undefined)).toBeNull()
  })
})

describe('collectFileContextChips（提取与排除判据）', () => {
  /** 2026-10-08 db.part 实证的服务端转录形态（README.md 整文件样本）*/
  const SERVER_WHOLE: FilePart = {
    type: 'file',
    mime: 'text/plain',
    filename: 'README.md',
    url: 'G:/AI-Agent/zcode-idea-plugin/README.md',
    metadata: {
      originalUrl: 'G:/AI-Agent/zcode-idea-plugin/README.md',
      preview: { text: '[Full content of G:/AI-Agent/zcode-idea-plugin/README.md, 183 lines]\n1\t<div>' },
    },
  }

  it('服务端形态：url+preview 头行解析出 chip（整文件无行号）', () => {
    const chips = collectFileContextChips([SERVER_WHOLE])
    expect(chips).toHaveLength(1)
    expect(chips[0]).toEqual({
      path: 'G:/AI-Agent/zcode-idea-plugin/README.md',
      filename: 'README.md',
    })
  })

  it('选区 preview：头行解析行号区间', () => {
    const chips = collectFileContextChips([
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'App.ts',
        url: 'E:/proj/src/App.ts',
        metadata: { preview: { text: '[Selected code from E:/proj/src/App.ts, lines 10-20 of 183]\n10\tcode' } },
      },
    ])
    expect(chips[0]).toEqual({ path: 'E:/proj/src/App.ts', filename: 'App.ts', lineStart: 10, lineEnd: 20 })
  })

  it('乐观形态：metadata.selection 结构化行号优先，filename 缺省时从 url 取 basename', () => {
    const chips = collectFileContextChips([
      { type: 'file', mime: 'text/plain', url: 'E:\\proj\\src\\main.py', metadata: { originalUrl: 'E:\\proj\\src\\main.py', selection: { lineStart: 5, lineEnd: 5 } } },
    ])
    expect(chips[0]).toEqual({ path: 'E:\\proj\\src\\main.py', filename: 'main.py', lineStart: 5, lineEnd: 5 })
  })

  it('排除判据：图片 mime、非磁盘 url、text part 均不产 chip', () => {
    const parts: MessagePart[] = [
      { type: 'file', mime: 'image/png', filename: 'pic.png', url: 'http://127.0.0.1:1234/zcode-image/x' } as FilePart,
      { type: 'file', mime: 'text/plain', filename: 'art.md', url: 'zcode-artifact://abc' } as FilePart,
      { type: 'file', mime: 'text/plain', filename: 'nopath.md' } as FilePart,
      { type: 'text', text: '正文里的 @G:/proj/App.ts 不是附件' },
      SERVER_WHOLE,
    ]
    const chips = collectFileContextChips(parts)
    expect(chips).toHaveLength(1)
    expect(chips[0].filename).toBe('README.md')
  })
})

describe('fileContextPartFromAttachment（乐观 part 与服务端形态同构）', () => {
  it('选区附件：basename/url/metadata.selection，单行归一起止相等', () => {
    const p = fileContextPartFromAttachment({ kind: 'currentFile', path: 'E:/proj/src/App.ts', lineStart: 10, lineEnd: 12 })
    expect(p.type).toBe('file')
    expect(p.mime).toBe('text/plain')
    expect(p.filename).toBe('App.ts')
    expect(p.url).toBe('E:/proj/src/App.ts')
    expect(p.metadata).toEqual({ originalUrl: 'E:/proj/src/App.ts', selection: { lineStart: 10, lineEnd: 12 } })
    // 乐观 part 能被自己的提取函数还原（同构闭环）
    expect(collectFileContextChips([p])).toEqual([
      { path: 'E:/proj/src/App.ts', filename: 'App.ts', lineStart: 10, lineEnd: 12 },
    ])
  })

  it('整文件附件：无 selection 字段', () => {
    const p = fileContextPartFromAttachment({ kind: 'currentFile', path: 'G:/w/README.md' })
    expect(p.metadata).toEqual({ originalUrl: 'G:/w/README.md' })
    expect(collectFileContextChips([p]).length > 0).toBe(true)
  })
})

// ---------- 渲染 ----------

function userMessage(parts: MessagePart[]): ZCodeMessage {
  return {
    info: { role: 'user', time: { created: 1759900000000 }, id: 'srv_u_1', sessionID: 'sess_x' },
    parts,
  }
}

describe('MessageBubble 用户气泡上下文注脚渲染', () => {
  it('服务端 file part → 气泡外注脚排：clip 图标 + basename + #L 行号 + data-tip 全路径', () => {
    const msg = userMessage([
      { type: 'text', text: '看看这个文件' },
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'App.ts',
        url: 'E:/proj/src/App.ts',
        metadata: { originalUrl: 'E:/proj/src/App.ts', preview: { text: '[Selected code from E:/proj/src/App.ts, lines 10-20 of 183]\n10\tcode' } },
      },
    ])
    const { container } = render(<MessageBubble message={msg} />)
    const ctx = container.querySelector('.msg__filectx')
    expect(ctx).toBeTruthy()
    // 注脚在气泡外（不被长文折叠渐隐遮盖的结构保证）
    expect(ctx!.querySelector('.user-filectx-chip')).toBeTruthy()
    expect(ctx!.querySelector('.codicon-paperclip')).toBeTruthy()
    expect(screen.getByText('App.ts')).toBeTruthy()
    expect(screen.getByText('#L10-20')).toBeTruthy()
    const chip = ctx!.querySelector('.user-filectx-chip') as HTMLElement
    // 悬浮全路径走全局 [data-tip] CSS 气泡（JCEF 不渲染原生 title）；短路径不截断
    expect(chip.getAttribute('data-tip')).toBe('E:/proj/src/App.ts')
    expect(chip.className).toContain('tip-align-right')
  })

  it('超长路径 data-tip 中段省略（nowrap 单行防溢出，保头尾）', () => {
    const longPath = `E:/very/deep/nested/${'directory/'.repeat(12)}SomeComponent.tsx`
    const { container } = render(
      <MessageBubble
        message={userMessage([
          { type: 'file', mime: 'text/plain', filename: 'SomeComponent.tsx', url: longPath, metadata: { originalUrl: longPath, selection: { lineStart: 1, lineEnd: 2 } } },
        ])}
      />,
    )
    const chip = container.querySelector('.user-filectx-chip') as HTMLElement
    const tip = chip.getAttribute('data-tip') ?? ''
    expect(tip.length).toBeLessThanOrEqual(61)
    expect(tip.startsWith('E:/very')).toBe(true)
    expect(tip.endsWith('SomeComponent.tsx')).toBe(true)
    expect(tip).toContain('…')
  })

  it('乐观形态（metadata.selection 单行）→ #L5；整文件 → 无 #L 后缀', () => {
    const { container } = render(
      <MessageBubble
        message={userMessage([
          { type: 'text', text: '单行' },
          { type: 'file', mime: 'text/plain', filename: 'main.py', url: 'E:/p/main.py', metadata: { originalUrl: 'E:/p/main.py', selection: { lineStart: 5, lineEnd: 5 } } },
        ])}
      />,
    )
    expect(screen.getByText('#L5')).toBeTruthy()
    cleanup()
    const whole = render(
      <MessageBubble
        message={userMessage([
          { type: 'text', text: '整文件' },
          { type: 'file', mime: 'text/plain', filename: 'README.md', url: 'G:/w/README.md', metadata: { originalUrl: 'G:/w/README.md', preview: { text: '[Full content of G:/w/README.md, 9 lines]\n1\tx' } } },
        ])}
      />,
    )
    expect(whole.container.querySelector('.msg__filectx')).toBeTruthy()
    expect(whole.container.querySelector('.file-ref__lines')).toBeNull()
  })

  it('纯文本消息（含正文 @路径）不渲染注脚容器（零噪音）', () => {
    const { container } = render(
      <MessageBubble message={userMessage([{ type: 'text', text: '帮我看下 @E:/proj/App.ts 的问题' }])} />,
    )
    expect(container.querySelector('.msg__filectx')).toBeNull()
  })

  it('图片附件消息不出上下文 chip（mime image/* 归图片通道）', () => {
    const { container } = render(
      <MessageBubble
        message={userMessage([
          { type: 'file', mime: 'image/png', filename: 'shot.png', url: 'http://127.0.0.1:1/zcode-image/abc' } as FilePart,
          { type: 'text', text: '看图' },
        ])}
      />,
    )
    expect(container.querySelector('.msg__filectx')).toBeNull()
  })
})
