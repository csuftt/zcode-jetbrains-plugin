/**
 * AskUserQuestion 工具卡回看（解析器 + 卡片点击 → 只读弹窗）
 *
 * 数据源实证（2026-09-07，diag-askuser-history.py + zcode.cjs bri()）：
 * 完成态 state.output 为服务端回执，答案嵌在 `"问题"="答案"` 对里。
 *
 * 覆盖：
 *   - 解析器：全答/部分答/全跳过/拒绝文本/空 output
 *   - 选项匹配：单选精确/多选逗号串/自定义剩余文本
 *   - 卡片：完成态显示已选答案行、点击开回看弹窗（复用实时弹窗样式）、
 *     选中项高亮 + 自定义答案「其他」块、Esc/按钮关闭
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  openExternalUrl: () => {},
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { ToolCallCard } from '@/components/ToolCallCard'
import { AskUserReviewDialog } from '@/components/AskUserReviewDialog'
import {
  parseAskUserAnswers,
  matchAnswerToOptions,
  extractAskQuestions,
} from '@/utils/askUserAnswer'
import type { ToolPart, AskUserQuestion } from '@/types/messages'

const QUESTIONS: AskUserQuestion[] = [
  {
    header: 'B区安排',
    question: 'B 区测试需要你实时配合，接下来怎么安排？',
    multiSelect: false,
    options: [
      { label: '逐项配合测完（推荐）', description: '最完整' },
      { label: '只测新增', description: '聚焦本版' },
      { label: '先到这', description: '自查' },
    ],
  },
]

/** 服务端回执原文（实测格式，zcode.cjs bri() 拼装）*/
const OUTPUT_ALL =
  'User has answered your questions: "B 区测试需要你实时配合，接下来怎么安排？"="逐项配合测完（推荐）". You can now continue with the user\'s answers in mind.'

function askPart(overrides: Partial<ToolPart['state']> = {}): ToolPart {
  return {
    type: 'tool',
    callID: 'call_ask_1',
    tool: 'AskUserQuestion',
    state: {
      status: 'completed',
      input: { questions: QUESTIONS },
      output: OUTPUT_ALL,
      time: { start: 1788788587196, end: 1788788587201 },
      ...overrides,
    },
  }
}

function renderCard(part: ToolPart) {
  // 对齐 App 挂载形态：工具卡与回看弹窗并列（弹窗 store 自管理开关）
  return render(
    <>
      <ToolCallCard part={part} />
      <AskUserReviewDialog />
    </>,
  )
}

beforeEach(() => {
  useStore.setState({ askUserReview: null })
})

afterEach(() => cleanup())

describe('parseAskUserAnswers 答案解析', () => {
  it('全答模板：提取 问题→答案 对', () => {
    const r = parseAskUserAnswers(OUTPUT_ALL, QUESTIONS)
    expect(r).not.toBeNull()
    expect(r!.recognized).toBe(true)
    expect(r!.answers[QUESTIONS[0].question]).toBe('逐项配合测完（推荐）')
  })

  it('多问题部分回答：只提取已答项', () => {
    const qs = [...QUESTIONS, { question: '第二个问题？', options: [{ label: 'A' }] }]
    const output =
      'The user answered some questions and skipped 1. Provided answers: "B 区测试需要你实时配合，接下来怎么安排？"="只测新增". Continue with the provided answers and use your best judgment for the unanswered questions; do not invent user preferences.'
    const r = parseAskUserAnswers(output, qs)
    expect(r!.recognized).toBe(true)
    expect(Object.keys(r!.answers)).toHaveLength(1)
    expect(r!.answers['第二个问题？']).toBeUndefined()
  })

  it('全跳过模板：recognized=true 但无答案对', () => {
    const output =
      'The user did not provide answers to these questions. Continue using your best judgment; do not treat this as a rejection or invent a user preference.'
    const r = parseAskUserAnswers(output, QUESTIONS)
    expect(r!.recognized).toBe(true)
    expect(r!.answers).toEqual({})
  })

  it('拒绝/异常文本：recognized=false（UI 走原文回执兜底）', () => {
    const r = parseAskUserAnswers('Permission denied by user', QUESTIONS)
    expect(r!.recognized).toBe(false)
    expect(r!.answers).toEqual({})
  })

  it('空 output：null（实时 batch 收尾后、轮末重拉前的窗口）', () => {
    expect(parseAskUserAnswers(undefined, QUESTIONS)).toBeNull()
    expect(parseAskUserAnswers('', QUESTIONS)).toBeNull()
  })

  it('回执含 selected preview/user notes 注释不影响答案提取', () => {
    const output =
      'User has answered your questions: "B 区测试需要你实时配合，接下来怎么安排？"="逐项配合测完（推荐）" selected preview:\nsome preview text\nuser notes: 我想加一条. You can now continue with the user\'s answers in mind.'
    const r = parseAskUserAnswers(output, QUESTIONS)
    expect(r!.answers[QUESTIONS[0].question]).toBe('逐项配合测完（推荐）')
  })
})

describe('matchAnswerToOptions 选项匹配', () => {
  const options = QUESTIONS[0].options

  it('单选精确匹配', () => {
    expect(matchAnswerToOptions('只测新增', options)).toEqual({ matched: ['只测新增'], extra: null })
  })

  it('多选逗号串（服务端 join 形态）逐段匹配', () => {
    expect(matchAnswerToOptions('只测新增, 先到这', options)).toEqual({
      matched: ['只测新增', '先到这'],
      extra: null,
    })
  })

  it('中文逗号同样切分', () => {
    expect(matchAnswerToOptions('只测新增，先到这', options).matched).toEqual(['只测新增', '先到这'])
  })

  it('不匹配任何选项 → 全部归入自定义文本', () => {
    expect(matchAnswerToOptions('我想先跑单元测试', options)).toEqual({
      matched: [],
      extra: '我想先跑单元测试',
    })
  })
})

describe('extractAskQuestions 输入提取', () => {
  it('结构合法 → 原样返回', () => {
    expect(extractAskQuestions({ questions: QUESTIONS })).toEqual(QUESTIONS)
  })
  it('缺失/形态不对 → 空数组（流式未解析、协议变更防御）', () => {
    expect(extractAskQuestions(undefined)).toEqual([])
    expect(extractAskQuestions({ questions: 'not-array' })).toEqual([])
    expect(extractAskQuestions({ questions: [{ nope: 1 }] })).toEqual([])
  })
})

describe('工具卡回看交互', () => {
  it('完成态显示「你的回答」摘要行，点击卡片开回看弹窗', () => {
    renderCard(askPart())
    // 摘要行：问题文本做卡片 summary + 回答行
    expect(screen.getByText('逐项配合测完（推荐）')).toBeTruthy()
    expect(screen.getByText('你的回答')).toBeTruthy()
    // 点击头部 → 弹窗打开
    fireEvent.click(screen.getByText('B 区测试需要你实时配合，接下来怎么安排？'))
    expect(useStore.getState().askUserReview).not.toBeNull()
    // 弹窗内容：问题 + 选项 + 选中标记 + 关闭
    expect(screen.getByText('问题与你的回答')).toBeTruthy()
    expect(screen.getByText('先到这')).toBeTruthy()
    expect(screen.getByText('关闭')).toBeTruthy()
  })

  it('弹窗选中项高亮（active 类），Esc 关闭', () => {
    const { container } = renderCard(askPart())
    fireEvent.click(screen.getByText('B 区测试需要你实时配合，接下来怎么安排？'))
    // 「你的回答」行也出现在弹窗内（翻译 key 共用），取 overlay 内的选项断言 active
    const active = container.querySelectorAll('.ask-user-dialog__option.active')
    expect(active).toHaveLength(1)
    expect(active[0]!.textContent).toContain('逐项配合测完（推荐）')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useStore.getState().askUserReview).toBeNull()
  })

  it('自定义答案（「其他」）以高亮块展示', () => {
    const output =
      'User has answered your questions: "B 区测试需要你实时配合，接下来怎么安排？"="我想先跑单元测试". You can now continue with the user\'s answers in mind.'
    renderCard(askPart({ output }))
    fireEvent.click(screen.getByText('B 区测试需要你实时配合，接下来怎么安排？'))
    expect(screen.getByText('自定义答案')).toBeTruthy()
    // 卡片摘要行与弹窗「其他」块各出现一次
    expect(screen.getAllByText('我想先跑单元测试').length).toBeGreaterThanOrEqual(1)
  })

  it('全跳过回执：recognized 时显示「未回答」标注；拒绝文本走原文回执兜底', () => {
    const output =
      'The user did not provide answers to these questions. Continue using your best judgment; do not treat this as a rejection or invent a user preference.'
    renderCard(askPart({ output }))
    fireEvent.click(screen.getByText('B 区测试需要你实时配合，接下来怎么安排？'))
    expect(screen.getByText('未回答')).toBeTruthy()

    cleanup()
    useStore.setState({ askUserReview: null })
    renderCard(askPart({ output: 'User dismissed the dialog' }))
    fireEvent.click(screen.getByText('B 区测试需要你实时配合，接下来怎么安排？'))
    expect(screen.getByText('系统回执')).toBeTruthy()
    expect(screen.getByText(/User dismissed the dialog/)).toBeTruthy()
  })

  it('实时窗口（output 未落库）：弹窗只回看问题，不误标「未回答」', () => {
    renderCard(askPart({ output: '' }))
    fireEvent.click(screen.getByText('B 区测试需要你实时配合，接下来怎么安排？'))
    expect(screen.getByText('问题与你的回答')).toBeTruthy()
    expect(screen.queryByText('未回答')).toBeNull()
    expect(screen.queryByText('系统回执')).toBeNull()
  })

  it('关闭按钮复位 store', () => {
    renderCard(askPart())
    fireEvent.click(screen.getByText('B 区测试需要你实时配合，接下来怎么安排？'))
    fireEvent.click(screen.getByText('关闭'))
    expect(useStore.getState().askUserReview).toBeNull()
  })

  it('多问题回看按实时弹窗翻页：进度标注 + 上一题/下一题 + 末页关闭', () => {
    useStore.setState({
      askUserReview: {
        questions: [
          ...QUESTIONS,
          { question: '第二个问题？', multiSelect: false, options: [{ label: '选项A' }, { label: '选项B' }] },
        ],
        answers: { 'B 区测试需要你实时配合，接下来怎么安排？': '只测新增', '第二个问题？': '选项A' },
        recognized: true,
        raw: '',
      },
    })
    render(<AskUserReviewDialog />)
    // 第 1 页：有进度标注与下一题，无上一题
    expect(screen.getByText('第 1/2 题')).toBeTruthy()
    expect(screen.getByText('下一题')).toBeTruthy()
    expect(screen.queryByText('上一题')).toBeNull()
    fireEvent.click(screen.getByText('下一题'))
    // 第 2 页：出现上一题，按钮变关闭
    expect(screen.getByText('第 2/2 题')).toBeTruthy()
    expect(screen.getByText('上一题')).toBeTruthy()
    expect(screen.getByText('第二个问题？')).toBeTruthy()
    fireEvent.click(screen.getByText('上一题'))
    expect(screen.getByText('B 区测试需要你实时配合，接下来怎么安排？')).toBeTruthy()
    fireEvent.click(screen.getByText('下一题'))
    fireEvent.click(screen.getByText('关闭'))
    expect(useStore.getState().askUserReview).toBeNull()
  })

  it('流式中（input 未解析）：不显示答案行，头部点击不弹窗（退化为展开）', () => {
    renderCard(askPart({ input: undefined, output: undefined, status: 'running' }))
    expect(screen.queryByText('你的回答')).toBeNull()
    const before = useStore.getState().askUserReview
    // 工具显示名走 i18n（tool.names.AskUserQuestion = 询问用户）
    fireEvent.click(screen.getByText('询问用户'))
    expect(useStore.getState().askUserReview).toBe(before)
  })
})
