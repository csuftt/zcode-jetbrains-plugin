/**
 * 用户消息引用 chip 化测试（2026-09-10）：
 * - renderUserRefChips：四类引用解析（markdown 会话链接 / 裸会话 token / 命令·技能引用 / @路径含行号）、
 *   重叠防护、普通消息返回 null、中文边界
 * - hasUserRefChips：显隐判据与解析同源、g 正则 lastIndex 状态安全（重复调用结果一致）
 * - UserBubble 集成：chip 渲染 + 「显示原文」切换按钮 + 复制仍是原始文本
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { renderUserRefChips, hasUserRefChips } from '../src/utils/userRefChips'

describe('renderUserRefChips 解析', () => {
  const resolver = (id: string) => (id === 'sess_bbb' ? '已命名会话' : undefined)

  it('markdown 会话链接 → 会话 chip（标题反转移义）', () => {
    const nodes = renderUserRefChips('参考 [#修复 List\\[\\] bug](#sess_a) 继续')!
    expect(nodes).not.toBeNull()
    const html = JSON.stringify(nodes)
    expect(html).toContain('sess-ref')
    expect(html).toContain('修复 List[] bug')
    expect(html).toContain('sess_a')
  })

  it('裸 token 词边界转换 + resolver 反查标题；查不到显示 id 前缀兜底', () => {
    const nodes = renderUserRefChips('见 #sess_bbb 详情', resolver)!
    const html = JSON.stringify(nodes)
    expect(html).toContain('已命名会话')
    expect(html).toContain('sess_bbb')

    const fallback = renderUserRefChips('见 #sess_ffff0000 详情')!
    expect(JSON.stringify(fallback)).toContain('ffff0000…')
  })

  it('@路径 → 文件 chip（basename + 行号后缀）；@ 可选（裸路径也识别）', () => {
    const nodes = renderUserRefChips('改了 @C:\\proj\\src\\App.tsx#L10-20 和 /home/u/main.go')!
    const html = JSON.stringify(nodes)
    expect(html).toContain('App.tsx')
    expect(html).toContain('L10-20')
    expect(html).toContain('main.go')
    // 前后文本保留
    expect(html).toContain('改了')
    expect(html).toContain('和')
  })

  it('带 @ 的路径 chip 边界含 @（差一位回归：chip 后不残留路径尾字符）', () => {
    const nodes = renderUserRefChips(
      '@G:/metrics/代码仓库数据.xlsx\n根据数据@G:/metrics/account_mapping.csv ，总结',
    )!
    const segs = nodes.filter((n): n is string => typeof n === 'string')
    // chip 吞掉 @，尾段从路径后的空白/标点开始；若 end 少算 @ 的 1 位，会残留 'x'/'v'
    expect(segs).toEqual(['\n根据数据', ' ，总结'])
  })

  it('markdown 链接优先：链接体内不重复识别路径/裸 token（重叠防护）', () => {
    const nodes = renderUserRefChips('[#标题](#sess_a) [#标题2](#sess_b)')!
    const html = JSON.stringify(nodes)
    expect(html).toContain('sess_a')
    expect(html).toContain('sess_b')
    // 不出现被拆成文本的残留链接语法
    expect(html).not.toContain('](#sess_')
  })

  it('普通消息返回 null（零差异回退）', () => {
    expect(renderUserRefChips('今天天气不错')).toBeNull()
    expect(renderUserRefChips('这是 #普通话题 标签')).toBeNull()
    expect(renderUserRefChips('相对路径 src/index.ts 不算')).toBeNull()
  })

  it('chip 前后文本段完整保留（拼接顺序正确）', () => {
    const nodes = renderUserRefChips('前[#标](#sess_a)后', resolver)!
    const html = JSON.stringify(nodes)
    expect(html.indexOf('前')).toBeGreaterThanOrEqual(0)
    expect(html).toContain('后')
  })
})

describe('renderUserRefChips 命令/技能引用（按已知名清单匹配）', () => {
  const cmdNames = new Map([
    ['ask-matt', { kind: 'skill' as const }],
    ['code-review', { kind: 'command' as const }],
    ['goal', { kind: 'goal' as const }],
  ])

  it('已知技能名 → cmd-ref--skill chip，显示裸名不带斜杠（对齐输入框）', () => {
    const nodes = renderUserRefChips('/ask-matt 你什么什么', undefined, cmdNames)!
    const html = JSON.stringify(nodes)
    expect(html).toContain('cmd-ref--skill')
    expect(html).toContain('codicon-wand')
    expect(html).toContain('ask-matt')
    expect(html).toContain('你什么什么')
  })

  it('未知名字不转 chip（防误伤），尾部标点不算名字', () => {
    // /nope 不在清单：整条消息无引用 → null
    expect(renderUserRefChips('/nope 试试', undefined, cmdNames)).toBeNull()
    // 尾部冒号是标点：名字截到 code-review
    const nodes = renderUserRefChips('用/code-review: 看看', undefined, cmdNames)!
    expect(JSON.stringify(nodes)).toContain('cmd-ref--command')
    expect(JSON.stringify(nodes)).toContain('code-review')
  })

  it('goal 变体；POSIX 多段路径仍走文件 chip 不被命令抢走', () => {
    const goal = renderUserRefChips('/goal 做完这事', undefined, cmdNames)!
    expect(JSON.stringify(goal)).toContain('cmd-ref--goal')

    const path = renderUserRefChips('/usr/local/bin/run.db 看下', undefined, cmdNames)!
    expect(JSON.stringify(path)).toContain('file-ref')
    expect(JSON.stringify(path)).not.toContain('cmd-ref')
  })

  it('不传清单（null）：斜杠词一律不识别（零差异）', () => {
    expect(renderUserRefChips('/ask-matt 你什么什么')).toBeNull()
  })
})

describe('hasUserRefChips 判据', () => {
  it('与解析同源：有引用 true，无引用 false', () => {
    expect(hasUserRefChips('看 [#标](#sess_a) 这个')).toBe(true)
    expect(hasUserRefChips('看 #sess_a 这个')).toBe(true)
    expect(hasUserRefChips('看 @C:\\a\\b.ts 这个')).toBe(true)
    expect(hasUserRefChips('普通文本一行')).toBe(false)
  })

  it('命令引用：清单内 true，清单外/不传清单 false', () => {
    const cmdNames = new Map([['ask-matt', { kind: 'skill' as const }]])
    expect(hasUserRefChips('/ask-matt 试试', cmdNames)).toBe(true)
    expect(hasUserRefChips('/nope 试试', cmdNames)).toBe(false)
    expect(hasUserRefChips('/ask-matt 试试')).toBe(false)
  })

  it('g 正则 lastIndex 状态安全：同一文本重复调用结果一致', () => {
    const text = '有 @C:\\a\\b.ts 引用'
    expect(hasUserRefChips(text)).toBe(true)
    expect(hasUserRefChips(text)).toBe(true)
    expect(hasUserRefChips(text)).toBe(true)
    expect(hasUserRefChips('普通文本')).toBe(false)
    expect(hasUserRefChips(text)).toBe(true)
  })
})

// ============ UserBubble 集成 ============

const sentRequests: Array<Record<string, unknown>> = []
vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getTabWorkspacePath: () => '',
  getInitialSessionId: () => '',
  onMessage: () => {},
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: (req: Record<string, unknown>) => { sentRequests.push(req) },
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { MessageBubble } from '@/components/MessageBubble'
import type { ZCodeMessage } from '@/types/messages'

const storage = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) },
    removeItem: (k: string) => { storage.delete(k) },
    key: (i: number) => Array.from(storage.keys())[i] ?? null,
    get length() { return storage.size },
    clear: () => storage.clear(),
  },
})

function mkUserMsg(text: string): ZCodeMessage {
  return {
    info: { id: 'u1', role: 'user', time: { created: 1757400000000 } },
    parts: [{ type: 'text', text }],
  } as unknown as ZCodeMessage
}

beforeEach(() => {
  storage.clear()
  useStore.getState().init()
  useStore.setState({
    currentSessionId: 'sess_cur',
    sessions: [
      { sessionId: 'sess_bbb', title: '已命名会话', status: 'completed', mode: 'yolo', workspacePath: 'G:\\mock', createdAt: 1, updatedAt: 2 },
    ],
  })
})
afterEach(cleanup)

describe('UserBubble 集成', () => {
  it('含引用的消息：chip 渲染 + 「显示原文」按钮切换', () => {
    const text = '参考 [#已命名会话](#sess_bbb) 与 @C:\\x\\a.ts 继续'
    const { container, getByTitle } = render(<MessageBubble message={mkUserMsg(text)} />)
    expect(container.querySelector('.user-ref-chip.sess-ref')).not.toBeNull()
    expect(container.querySelector('.user-ref-chip.file-ref')).not.toBeNull()
    expect(container.textContent).not.toContain('](#sess_bbb)')

    const btn = getByTitle('显示原文')
    fireEvent.click(btn)
    // 原文态：chip 消失、原始文本回来、按钮高亮且 title 反转
    expect(container.querySelector('.user-ref-chip')).toBeNull()
    expect(container.textContent).toContain('](#sess_bbb)')
    expect((getByTitle('还原引用显示') as HTMLButtonElement).className).toContain('--active')
    fireEvent.click(getByTitle('还原引用显示'))
    expect(container.querySelector('.user-ref-chip.sess-ref')).not.toBeNull()
  })

  it('普通消息：无切换按钮、渲染零差异', () => {
    const { container } = render(<MessageBubble message={mkUserMsg('普通消息')} />)
    expect(container.querySelector('.user-ref-chip')).toBeNull()
    expect(container.querySelector('.msg__action-btn')?.getAttribute('title')).toBe('复制')
  })

  it('复制按钮始终复制原始文本（非 chip 视觉文本）', () => {
    const text = '看 [#标](#sess_bbb) 这个'
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const { getByTitle } = render(<MessageBubble message={mkUserMsg(text)} />)
    fireEvent.click(getByTitle('复制'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text)
  })

  it('/技能引用：slashCommands 入 store 后 chip 化（kind→变体），「显示原文」可用', () => {
    useStore.setState({
      slashCommands: [
        { name: 'ask-matt', kind: 'skill', description: 'router' },
        { name: 'init', kind: 'command', source: 'builtin' },
      ],
    })
    const text = '/ask-matt 你什么什么'
    const { container, getByTitle } = render(<MessageBubble message={mkUserMsg(text)} />)
    const chip = container.querySelector('.user-ref-chip.cmd-ref--skill')
    expect(chip).not.toBeNull()
    // 显示裸名不带斜杠（对齐输入框 cmd chip）；textContent 不含斜杠残留
    expect(container.textContent).toContain('ask-matt')
    expect(container.textContent).not.toContain('/ask-matt')

    fireEvent.click(getByTitle('显示原文'))
    expect(container.querySelector('.user-ref-chip')).toBeNull()
    expect(container.textContent).toContain('/ask-matt')
  })
})
