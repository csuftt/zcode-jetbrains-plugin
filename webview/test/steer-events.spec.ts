/**
 * steer 引导式插队纯函数回归测试（2026-09-07 diag-steer 探针定案的事件形状）
 *
 * 覆盖 streamReducer 两件：
 *   1. asSteerDrainedInputs：turn.steerDrained.drainedInputs 解析（可选字段缺失兜底、坏条目过滤）
 *   2. appendSteerUserMessages：注入 user 气泡（幂等——steerDrained 与回合结束
 *      重拉可能先后到达，重拉是权威替换，流式期间不得重复追加）
 * （turn.steerQueued 载荷不解析：queueLength 无 UI 消费，事件走 store 默认忽略）
 */

import { describe, it, expect } from 'vitest'
import { asSteerDrainedInputs, appendSteerUserMessages } from '@/utils/streamReducer'
import type { ZCodeMessage } from '@/types/messages'

const DRAINED_PAYLOAD = {
  pendingInputIds: ['queue_sendText-e2680ca4'],
  targetTurnId: 'turn_xxx',
  injectedMessageIds: ['msg_mtqo6hn8_5df42c60-e186-4e75-8372-feac8247e8ec'],
  drainedInputs: [
    {
      pendingInputId: 'queue_sendText-e2680ca4',
      messageId: 'msg_mtqo6hn8_5df42c60-e186-4e75-8372-feac8247e8ec',
      text: '改要求：从当前数字继续往下数，但每行数字后面加一个 # 号',
      delivery: 'guide',
    },
  ],
}

function userMsg(id: string, text: string): ZCodeMessage {
  return {
    info: { role: 'user', time: { created: 1 }, id, sessionID: 'sess_x' },
    parts: [{ type: 'text', text }],
  }
}

describe('asSteerDrainedInputs', () => {
  it('解析 drainedInputs（messageId+text）', () => {
    const inputs = asSteerDrainedInputs(DRAINED_PAYLOAD)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].messageId).toBe('msg_mtqo6hn8_5df42c60-e186-4e75-8372-feac8247e8ec')
    expect(inputs[0].text).toContain('# 号')
  })

  it('drainedInputs 缺失（schema 可选字段）返回空数组，由 store 回退乐观文本', () => {
    expect(asSteerDrainedInputs({ injectedMessageIds: ['msg_a'] })).toEqual([])
    expect(asSteerDrainedInputs(null)).toEqual([])
  })

  it('过滤坏条目（缺 messageId/text）', () => {
    const inputs = asSteerDrainedInputs({ drainedInputs: [{ messageId: 'msg_a' }, { messageId: 'msg_b', text: 'ok' }] })
    expect(inputs).toEqual([{ messageId: 'msg_b', text: 'ok' }])
  })
})

describe('appendSteerUserMessages', () => {
  const drained = () => asSteerDrainedInputs(DRAINED_PAYLOAD)

  it('追加尾部（调用时机在流式壳封口后，尾部即 u2 权威槽位）', () => {
    const out = appendSteerUserMessages([userMsg('u1', '数到200')], drained(), 'sess_x', 42)
    expect(out).toHaveLength(2)
    expect(out[1].info.role).toBe('user')
    expect(out[1].info.id).toBe('msg_mtqo6hn8_5df42c60-e186-4e75-8372-feac8247e8ec')
    expect(out[1].info.time.created).toBe(42)
    expect((out[1].parts[0] as { text: string }).text).toContain('# 号')
  })

  it('追加位置在已有 assistant 消息之后（壳封口后的实时结构镜像服务端拆分序）', () => {
    const assistantMsg: ZCodeMessage = {
      info: { role: 'assistant', time: { created: 1 }, id: 'stream_t1', sessionID: 'sess_x' },
      parts: [{ type: 'text', text: '1\n2\n3' }],
    }
    const out = appendSteerUserMessages([userMsg('u1', '数到200'), assistantMsg], drained(), 'sess_x', 42)
    expect(out).toHaveLength(3)
    expect(out[2].info.role).toBe('user')
    expect(out[1].info.id).toBe('stream_t1')
  })

  it('幂等：同 id 重复到达（事件重放/批内重复）不重复追加', () => {
    const base = [userMsg('u1', '数到200')]
    const once = appendSteerUserMessages(base, drained(), 'sess_x')
    const twice = appendSteerUserMessages(once, drained(), 'sess_x')
    expect(twice).toHaveLength(2)
    expect(twice).toBe(once) // 无新增时返回原引用（引用稳定防多余重渲染）
  })

  it('空条目原样返回', () => {
    const base = [userMsg('u1', '数到200')]
    expect(appendSteerUserMessages(base, [], 'sess_x')).toBe(base)
  })
})
