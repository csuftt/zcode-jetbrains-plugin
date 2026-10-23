/**
 * AskUserDialog 提交结构回归测试
 *
 * 覆盖缺陷：旧版把所有答案 JSON.stringify 成字符串塞进 askUserResponse.answer——
 * zcode.cjs 端 normalizeAskUserQuestionAnswers 按问题文本匹配 answers 对象/单问题
 * 取原始 answer 值，整体 JSON 字符串匹配不到任何 key（多问题答案全丢，AI 认为
 * 用户没选）；数组也被当成带引号方括号的字面量字符串。
 *
 * 断言提交结构：
 *   - 单问题单选 → answer 为字符串
 *   - 单问题多选 → answer 为原始数组（非 JSON 字符串）
 *   - 多问题 → answers 为 {问题文本: 值} 对象（值多选为数组）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { act } from 'react-dom/test-utils'

const sent: Array<Record<string, unknown>> = []
vi.mock('@/ipc/bridge', () => ({
  sendToJava: (req: Record<string, unknown>) => { sent.push(req) },
}))

// 组件引入 i18n 初始化（语言包合并 + react-i18next 挂载）
import '@/i18n/config'
import { AskUserDialog } from '@/components/AskUserDialog'

function renderDialog(questions: Parameters<typeof AskUserDialog>[0]['questions']) {
  return render(
    <AskUserDialog
      requestId="req-1"
      toolName="AskUserQuestion"
      questions={questions}
      onClose={() => {}}
    />,
  )
}

/** 点击选项（按 label 文本）*/
function clickOption(label: string): void {
  fireEvent.click(screen.getByText(label))
}

/** 点击下一步（非最后一题）*/
function next(): void {
  fireEvent.click(screen.getByText('下一题'))
}

/** 点击提交（最后一个问题的确认按钮）*/
function submit(): void {
  fireEvent.click(screen.getByText('确认'))
}

beforeEach(() => {
  sent.length = 0
})

afterEach(() => {
  cleanup()
})

describe('AskUserDialog 提交结构', () => {
  it('单问题单选 → answer 为字符串', () => {
    renderDialog([
      { question: '部署方式?', options: [{ label: 'Docker' }, { label: 'K8s' }] },
    ])
    clickOption('Docker')
    submit()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ op: 'askUserResponse', action: 'accept' })
    expect(sent[0].answer).toBe('Docker')
    expect(sent[0].answers).toBeUndefined()
  })

  it('单问题多选 → answer 为原始数组（不再是 JSON 字符串）', () => {
    renderDialog([
      { question: '使用哪些技术?', multiSelect: true, options: [{ label: 'Redis' }, { label: 'MySQL' }, { label: 'Pulsar' }] },
    ])
    clickOption('Redis')
    clickOption('Pulsar')
    submit()

    expect(sent).toHaveLength(1)
    expect(sent[0].answer).toEqual(['Redis', 'Pulsar'])
    // 旧实现会 JSON.stringify 成 '["Redis","Pulsar"]' 字符串
    expect(typeof sent[0].answer).toBe('object')
  })

  it('多问题（含多选）→ answers 为 {问题文本: 值} 对象', () => {
    renderDialog([
      { question: '部署环境?', options: [{ label: '生产' }, { label: '测试' }] },
      { question: '使用哪些中间件?', multiSelect: true, options: [{ label: 'Redis' }, { label: 'Pulsar' }] },
    ])
    clickOption('生产')
    next() // 下一题
    clickOption('Redis')
    clickOption('Pulsar')
    submit() // 最后一题确认

    expect(sent).toHaveLength(1)
    expect(sent[0].answers).toEqual({
      '部署环境?': '生产',
      '使用哪些中间件?': ['Redis', 'Pulsar'],
    })
    expect(sent[0].answer).toBeUndefined()
  })

  it('「其他」自定义输入并入答案（单问题）', async () => {
    const { container } = renderDialog([
      { question: '部署方式?', options: [{ label: 'Docker' }] },
    ])
    clickOption('其他（自定义答案）')
    const input = container.querySelector('.ask-user-dialog__custom-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '自建机房' } })
    submit()

    expect(sent[0].answer).toBe('自建机房')
  })

  it('未选任何选项时提交按钮禁用', () => {
    renderDialog([
      { question: '部署方式?', options: [{ label: 'Docker' }, { label: 'K8s' }] },
    ])
    expect((screen.getByText('确认') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('忽略本题（issue#45-4.2）', () => {
  /** 点击「忽略本题」按钮 */
  function skip(): void {
    fireEvent.click(screen.getByText('忽略本题'))
  }

  it('多问题部分忽略 → answers 缺被忽略题的 key（服务端=部分跳过，AI 自行判断）', () => {
    renderDialog([
      { question: '部署环境?', options: [{ label: '生产' }, { label: '测试' }] },
      { question: '使用哪些中间件?', multiSelect: true, options: [{ label: 'Redis' }, { label: 'Pulsar' }] },
    ])
    skip() // 第 1 题忽略，自动进第 2 题
    clickOption('Redis')
    submit()

    expect(sent[0].action).toBe('accept')
    expect(sent[0].answers).toEqual({ '使用哪些中间件?': ['Redis'] })
    // 被忽略题不得以空串占位（服务端 blank 丢弃会致整个 answers 失效）
    expect(sent[0].answers).not.toHaveProperty('部署环境?')
  })

  it('多问题全部忽略 → answers 为显式空对象（服务端=全部跳过继续，非 decline）', () => {
    renderDialog([
      { question: '部署环境?', options: [{ label: '生产' }, { label: '测试' }] },
      { question: '数据库?', options: [{ label: 'MySQL' }, { label: 'PG' }] },
    ])
    skip() // 第 1 题 → 自动进第 2 题
    skip() // 第 2 题（末题停留原地）
    submit()

    expect(sent[0].action).toBe('accept') // 不是 decline（那是整批取消语义）
    expect(sent[0].answers).toEqual({})
  })

  it('单问题忽略 → answers 显式空对象，不带 answer（缺 content 会服务端报错）', () => {
    renderDialog([{ question: '部署方式?', options: [{ label: 'Docker' }, { label: 'K8s' }] }])
    skip() // 末题停留原地，确认按钮因已忽略解锁
    submit()

    expect(sent[0].action).toBe('accept')
    expect(sent[0].answers).toEqual({})
    expect(sent[0].answer).toBeUndefined()
  })

  it('忽略后重新选择即解除：提交恢复正常 answer', () => {
    renderDialog([{ question: '部署方式?', options: [{ label: 'Docker' }, { label: 'K8s' }] }])
    skip()
    expect(document.querySelector('.ask-user-dialog__skipped-hint')).not.toBeNull()
    clickOption('K8s') // 重新选择解除忽略，提示条消失
    expect(document.querySelector('.ask-user-dialog__skipped-hint')).toBeNull()
    submit()

    expect(sent[0].answer).toBe('K8s')
    expect(sent[0].answers).toBeUndefined()
  })
})
