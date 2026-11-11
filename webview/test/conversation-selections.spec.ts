/**
 * 划词引用（conversation selections，调研 ⑩）纯函数回归：
 *   - appendSelectionBlock：官方 Ofe 逐字节兼容（围栏块拼在文本末尾，只保留 {text}）
 *   - splitSelectionBlock：官方 kfe 双格式回读 + fail-open（解析失败不吞消息）
 *   - validateAddSelection：官方 Dfe 四级校验（single/duplicate/count/total 按序）
 * 协议核心纪律：块必须在整条消息末尾（展示剥离正则锚 \s*$）。
 */
import { describe, it, expect } from 'vitest'
import {
  appendSelectionBlock,
  splitSelectionBlock,
  validateAddSelection,
  SELECTION_LIMIT_SINGLE,
  SELECTION_LIMIT_COUNT,
  SELECTION_LIMIT_TOTAL,
  type ConversationSelection,
} from '@/utils/conversationSelections'

function sel(rowId: string, text: string, contentType: ConversationSelection['contentType'] = 'assistant'): ConversationSelection {
  return { id: `id-${rowId}-${text.length}`, rowId, contentType, text }
}

describe('appendSelectionBlock（官方 Ofe）', () => {
  it('无引用时原样返回', () => {
    expect(appendSelectionBlock('正文', [])).toBe('正文')
  })

  it('序列化只保留 text 字段（官方双向互认）', () => {
    const out = appendSelectionBlock('这是什么意思？', [sel('msg1-0', '被引用的话')])
    const expected = ['这是什么意思？', '', '# userselect:', '```userselect', JSON.stringify([{ text: '被引用的话' }]), '```'].join('\n')
    expect(out).toBe(expected)
  })

  it('纯引用无正文：块即整条消息', () => {
    const out = appendSelectionBlock('', [sel('m-0', 'a'), sel('m-1', 'b')])
    expect(out).toBe(['# userselect:', '```userselect', JSON.stringify([{ text: 'a' }, { text: 'b' }]), '```'].join('\n'))
  })

  it('多条引用合入同一块', () => {
    const out = appendSelectionBlock('正文', [sel('m-0', 'a'), sel('m-1', 'b')])
    expect(out).toContain('[{"text":"a"},{"text":"b"}]')
    expect(out.endsWith('```')).toBe(true)
  })
})

describe('splitSelectionBlock（官方 kfe 双格式 + fail-open）', () => {
  it('新格式往返：append 后 split 还原正文与引用', () => {
    const original = '帮我看看这段'
    const composed = appendSelectionBlock(original, [sel('m-0', '第一段'), sel('m-2', '第二段')])
    const { visibleContent, references } = splitSelectionBlock(composed)
    expect(visibleContent).toBe(original)
    expect(references.map((r) => r.text)).toEqual(['第一段', '第二段'])
  })

  it('无块的普通消息原样通过', () => {
    const { visibleContent, references } = splitSelectionBlock('普通消息，里面也可能出现 ``` 代码块\n```js\nconst a = 1\n```')
    expect(visibleContent).toBe('普通消息，里面也可能出现 ``` 代码块\n```js\nconst a = 1\n```')
    expect(references).toEqual([])
  })

  it('旧格式（zcode-conversation-selections）兼容剥块', () => {
    const text = ['旧消息', '', '# Conversation selections:', '```zcode-conversation-selections', JSON.stringify([{ text: '旧引用' }]), '```'].join('\n')
    const { visibleContent, references } = splitSelectionBlock(text)
    expect(visibleContent).toBe('旧消息')
    expect(references.map((r) => r.text)).toEqual(['旧引用'])
  })

  it('块不在消息末尾时不剥（正则锚 \\s*$）', () => {
    const text = ['# userselect:', '```userselect', '[]', '```', '后面还有正文'].join('\n')
    const { visibleContent, references } = splitSelectionBlock(text)
    expect(visibleContent).toBe(text)
    expect(references).toEqual([])
  })

  it('JSON 损坏 fail-open：整段原文展示', () => {
    const text = ['正文', '', '# userselect:', '```userselect', '{not json', '```'].join('\n')
    const { visibleContent, references } = splitSelectionBlock(text)
    expect(visibleContent).toBe(text)
    expect(references).toEqual([])
  })

  it('条目缺 text 字段被过滤（官方 Nfe 逐条校验）', () => {
    const payload = JSON.stringify([{ text: '好的引用' }, { foo: 'bar' }, { text: '' }])
    const text = ['正文', '', '# userselect:', '```userselect', payload, '```'].join('\n')
    const { references } = splitSelectionBlock(text)
    expect(references.map((r) => r.text)).toEqual(['好的引用'])
  })
})

describe('validateAddSelection（官方 Dfe 按序四级）', () => {
  it('成功追加：新数组返回、原数组不变', () => {
    const list: ConversationSelection[] = []
    const { list: next, error } = validateAddSelection(list, { rowId: 'm-0', contentType: 'assistant', text: 'x' })
    expect(error).toBeNull()
    expect(next).toHaveLength(1)
    expect(list).toHaveLength(0)
    expect(next[0].rowId).toBe('m-0')
    expect(next[0].contentType).toBe('assistant')
    expect(next[0].text).toBe('x')
  })

  it('single：单条超 8000 拒绝', () => {
    const { error } = validateAddSelection([], { rowId: 'm-0', contentType: 'assistant', text: 'a'.repeat(SELECTION_LIMIT_SINGLE + 1) })
    expect(error).toBe('single')
  })

  it('single：恰好 8000 允许', () => {
    const { error } = validateAddSelection([], { rowId: 'm-0', contentType: 'assistant', text: 'a'.repeat(SELECTION_LIMIT_SINGLE) })
    expect(error).toBeNull()
  })

  it('duplicate：指纹去重静默拒绝（不改列表）', () => {
    const { list } = validateAddSelection([], { rowId: 'm-0', contentType: 'assistant', text: '同一段' })
    const { list: again, error } = validateAddSelection(list, { rowId: 'm-0', contentType: 'assistant', text: '同一段' })
    expect(error).toBe('duplicate')
    expect(again).toBe(list)
  })

  it('duplicate 判定按 rowId+contentType+text：同文不同行不算重', () => {
    const { list } = validateAddSelection([], { rowId: 'm-0', contentType: 'assistant', text: '同一段' })
    const { list: next, error } = validateAddSelection(list, { rowId: 'm-1', contentType: 'assistant', text: '同一段' })
    expect(error).toBeNull()
    expect(next).toHaveLength(2)
  })

  it('count：第 9 条拒绝', () => {
    let list: ConversationSelection[] = []
    for (let i = 0; i < SELECTION_LIMIT_COUNT; i++) {
      const r = validateAddSelection(list, { rowId: `m-${i}`, contentType: 'assistant', text: `t${i}` })
      expect(r.error).toBeNull()
      list = r.list
    }
    const { error } = validateAddSelection(list, { rowId: 'm-9', contentType: 'assistant', text: 't9' })
    expect(error).toBe('count')
  })

  it('total：总量超 16000 拒绝', () => {
    // 手工构造已通过的引用列表（单条受 8000 限制，用两条拼到 15999）
    const list = [sel('m-0', 'a'.repeat(SELECTION_LIMIT_SINGLE)), sel('m-1', 'b'.repeat(SELECTION_LIMIT_TOTAL - SELECTION_LIMIT_SINGLE - 1))]
    const { error } = validateAddSelection(list, { rowId: 'm-2', contentType: 'assistant', text: 'bb' })
    expect(error).toBe('total')
  })

  it('校验顺序：single 先于 duplicate/count（超长重复文本报 single）', () => {
    const long = 'a'.repeat(SELECTION_LIMIT_SINGLE + 1)
    const { list } = validateAddSelection([], { rowId: 'm-0', contentType: 'assistant', text: long })
    // 上面必然 single 拒绝、list 不变，构造重复超长对重复条目校验顺序
    const seeded = [sel('m-0', long)]
    const { error } = validateAddSelection(seeded, { rowId: 'm-0', contentType: 'assistant', text: long })
    expect(error).toBe('single')
    expect(list).toHaveLength(0)
  })
})
