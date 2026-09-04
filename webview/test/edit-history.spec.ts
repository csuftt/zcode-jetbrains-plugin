/**
 * 编辑历史消息工具测试（2026-09-04，对齐官方 Edit History 语义）
 *
 * 锁定：
 * - 命令判据（isEditRewindCommand 只匹配 conversation 形态，/rewind status 等不误伤）
 * - rewind.triggered payload 判定（scope/strategy 缺一不可）
 * - applyRewindCuts 轮删除规则：user 消息起删到下一条真实 user 消息前；
 *   多 cut 顺序应用；target 找不到 no-op；合成通知不算轮界
 * - findEditableUserMessage：只取最后一条；乐观 id / 附件 / 空文本 / 命令消息 /
 *   子代理通知 / compact 摘要均排除
 * - kv 截断记忆读写（persist → localStorage）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import type { ZCodeMessage, MessagePart } from '@/types/messages'
import {
  buildEditRewindCommand,
  isEditRewindCommand,
  asConversationRewind,
  applyRewindCuts,
  findEditableUserMessage,
  addRewindCut,
  loadRewindCuts,
} from '@/utils/editHistory'

/* ---- localStorage mock：本 vitest jsdom 的 localStorage 是无 clear/removeItem 的
 * 空壳（项目已知坑，goal-card.spec 同款 Map 实现）---- */
function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  }
}
Object.defineProperty(window, 'localStorage', {
  value: makeLocalStorage(),
  configurable: true,
  writable: true,
})

function um(id: string, text: string, extra: Partial<ZCodeMessage['info']> = {}): ZCodeMessage {
  return { info: { role: 'user', time: { created: 1 }, id, sessionID: 's1', ...extra }, parts: text ? [{ type: 'text', text }] : [] }
}
function am(id: string, text: string, extra: Partial<ZCodeMessage['info']> = {}): ZCodeMessage {
  return { info: { role: 'assistant', time: { created: 1 }, id, sessionID: 's1', ...extra }, parts: text ? [{ type: 'text', text }] : [] }
}

describe('isEditRewindCommand / buildEditRewindCommand', () => {
  it('构造与识别 conversation 形态', () => {
    const cmd = buildEditRewindCommand('msg_abc')
    expect(cmd).toBe('/rewind conversation msg_abc')
    expect(isEditRewindCommand(cmd)).toBe(true)
    expect(isEditRewindCommand('  /rewind   conversation   msg_x  ')).toBe(true)
  })
  it('其他 rewind 变体不误伤', () => {
    expect(isEditRewindCommand('/rewind')).toBe(false)
    expect(isEditRewindCommand('/rewind status')).toBe(false)
    expect(isEditRewindCommand('/rewind latest')).toBe(false)
    expect(isEditRewindCommand('/rewind workspace msg_x')).toBe(false)
    expect(isEditRewindCommand('/rewind fork')).toBe(false)
    expect(isEditRewindCommand('普通消息')).toBe(false)
  })
})

describe('asConversationRewind', () => {
  it('conversation + active_chain → targetMessageId', () => {
    expect(asConversationRewind({ scope: 'conversation', strategy: 'active_chain', targetMessageId: 'm1' })).toBe('m1')
    expect(asConversationRewind({ scope: 'both', strategy: 'active_chain', targetMessageId: 'm1' })).toBe('m1')
  })
  it('workspace-only / 非 active_chain / 缺字段 → null', () => {
    expect(asConversationRewind({ scope: 'workspace', strategy: 'active_chain', targetMessageId: 'm1' })).toBeNull()
    expect(asConversationRewind({ scope: 'conversation', strategy: 'checkpoint_required', targetMessageId: 'm1' })).toBeNull()
    expect(asConversationRewind({ scope: 'conversation', strategy: 'active_chain' })).toBeNull()
    expect(asConversationRewind(null)).toBeNull()
  })
})

describe('applyRewindCuts', () => {
  const base = () => [
    um('u1', '问题一'),
    am('a1', '回答一'),
    um('u2', '问题二'),
    am('a2', '回答二'),
    um('u3', '问题三（编辑后）'),
    am('a3', '回答三'),
  ]

  it('单 cut：删目标轮（user + 其后 assistant），后续轮保留', () => {
    const out = applyRewindCuts(base(), ['u2'])
    expect(out.map((m) => m.info.id)).toEqual(['u1', 'a1', 'u3', 'a3'])
  })

  it('多 cut 顺序应用（先编辑 u2 再编辑 u3）', () => {
    const out = applyRewindCuts(base(), ['u2', 'u3'])
    expect(out.map((m) => m.info.id)).toEqual(['u1', 'a1'])
  })

  it('target 找不到 → no-op（服务端未来自行截断时不双删）', () => {
    const msgs = base()
    expect(applyRewindCuts(msgs, ['u_nonexistent'])).toBe(msgs)
  })

  it('目标后紧跟合成通知消息不算轮界，通知随轮删除', () => {
    const msgs = [
      um('u1', '问题一'),
      am('a1', '回答一'),
      um('u2', '问题二'),
      // 后台任务完成合成通知（role=user + synthetic + source=background_task）
      um('n1', '<task-notification>…</task-notification>', { synthetic: true, source: 'background_task' }),
      um('u3', '问题三'),
    ]
    const out = applyRewindCuts(msgs, ['u2'])
    expect(out.map((m) => m.info.id)).toEqual(['u1', 'a1', 'u3'])
  })

  it('空 cuts 原样返回', () => {
    const msgs = base()
    expect(applyRewindCuts(msgs, [])).toBe(msgs)
  })
})

describe('findEditableUserMessage', () => {
  it('返回最后一条真实用户消息', () => {
    const msgs = [um('u1', '一'), am('a1', '答'), um('u2', '二'), am('a2', '答2')]
    expect(findEditableUserMessage(msgs)?.info.id).toBe('u2')
  })

  it('排除乐观消息（local_u_ 前缀无服务端 id）', () => {
    const msgs = [um('u1', '一'), am('a1', '答'), um('local_u_123', '刚发的还没重拉')]
    expect(findEditableUserMessage(msgs)?.info.id).toBe('u1')
  })

  it('排除带图片/文件附件的消息（一期不支持附件编辑）', () => {
    const withImage: ZCodeMessage = {
      info: { role: 'user', time: { created: 1 }, id: 'u_img', sessionID: 's1' },
      parts: [
        { type: 'image', mediaType: 'image/png', dataUrl: 'data:image/png;base64,x' } as MessagePart,
        { type: 'text', text: '看图' },
      ],
    }
    const msgs = [um('u1', '一'), withImage]
    expect(findEditableUserMessage(msgs)?.info.id).toBe('u1')
  })

  it('排除空文本与 rewind 命令消息', () => {
    const msgs = [um('u1', '一'), um('u2', ''), um('u3', '/rewind conversation msg_x')]
    expect(findEditableUserMessage(msgs)?.info.id).toBe('u1')
  })

  it('排除子代理通知与 compact 摘要卡', () => {
    const msgs = [
      um('u1', '一'),
      am('a1', '答'),
      um('n1', '<task-notification>…</task-notification>', { synthetic: true, source: 'background_task' }),
      um('c1', '摘要正文', { summary: { title: 'Compact summary', body: '摘要正文' } }),
    ]
    expect(findEditableUserMessage(msgs)?.info.id).toBe('u1')
  })

  it('无可编辑消息返回 null', () => {
    expect(findEditableUserMessage([am('a1', '答')])).toBeNull()
    expect(findEditableUserMessage([])).toBeNull()
  })
})

describe('rewind cuts kv 记忆', () => {
  beforeEach(() => {
    window.localStorage.removeItem('zcode.edit.rewind-cuts')
  })

  it('追加与读取（按会话隔离、去重）', () => {
    addRewindCut('s1', 'u2')
    addRewindCut('s1', 'u3')
    addRewindCut('s1', 'u2') // 重复 no-op
    addRewindCut('s2', 'x1')
    expect(loadRewindCuts('s1')).toEqual(['u2', 'u3'])
    expect(loadRewindCuts('s2')).toEqual(['x1'])
    expect(loadRewindCuts('unknown')).toEqual([])
  })

  it('损坏数据 fail-soft 返回空', () => {
    window.localStorage.setItem('zcode.edit.rewind-cuts', '{broken json')
    expect(loadRewindCuts('s1')).toEqual([])
  })
})
