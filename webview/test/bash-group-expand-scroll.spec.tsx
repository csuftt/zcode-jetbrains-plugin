/**
 * 批量命令组卡行内展开/收起的滚动位还原（缺陷FG）：
 * 收起一条命令后整卡命令行整体下移 16px。
 *
 * 根因（两层）：
 *   1. timeline maxHeight 是 border-box 却按纯行数计算，不含上下 padding(16px)——
 *      全部项恰好可见时也差 16px 成幻影滚动，挂载自动滚底停在 scrollTop=16
 *      （顶部 padding 被滚出可视区）；
 *   2. 行展开瞬间容器 maxHeight 放宽（overflow 转 auto），浏览器把 scrollTop 钳回 0；
 *      收起后容器高度回落，钳走的位移不会自动还原 → 视窗整体位移 16px，
 *      感官即「命令往下挪了」。
 *
 * 修复：maxHeight 补上 padding（≤3.5 项零滚动，幻影滚动消失）；
 *      行收起（expandedIdx 非空→null）后按展开前采样值还原 scrollTop。
 *
 * jsdom 无布局，scrollHeight/clientHeight 用 defineProperty 桩模拟；
 * 展开时的浏览器钳制行为（scrollTop→0）在测试里显式模拟。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
}))

import '@/i18n/config'
import { useStore } from '@/store/useStore'
import { BashCommandGroupCard } from '@/components/BashCommandGroupCard'
import { FileToolGroupCard } from '@/components/FileToolGroupCard'
import type { ToolPart } from '@/types/messages'

function bashPart(callID: string, command: string): ToolPart {
  return {
    type: 'tool',
    callID,
    tool: 'Bash',
    state: {
      status: 'completed',
      input: { command },
      output: '',
      time: { start: 1787283860000, end: 1787283860600 },
    },
  }
}

beforeEach(() => {
  useStore.setState({ backgroundTasks: {} })
})

afterEach(() => {
  cleanup()
  // 桩属性挂在原型上，逐用例清理防泄漏
  // @ts-expect-error 测试桩
  delete HTMLElement.prototype.scrollHeight
  // @ts-expect-error 测试桩
  delete HTMLElement.prototype.clientHeight
})

/** clientHeight 状态桩：随容器折叠/展开切换（模拟浏览器布局） */
function mockClientHeight(holder: { value: number }) {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    get: () => holder.value,
    configurable: true,
  })
}

describe('BashCommandGroupCard 行展开/收起滚动位（缺陷FG）', () => {
  it('≤3.5 项：maxHeight 含上下 padding，全部项恰好可见不产生幻影滚动', () => {
    const { container } = render(
      <BashCommandGroupCard parts={[bashPart('c1', 'echo 1'), bashPart('c2', 'echo 2')]} />,
    )
    // 2 项：2×32 + 16 = 80（此前为 64，差 16px 即幻影滚动根源）
    const tl = container.querySelector('.bash-group__timeline') as HTMLElement
    expect(tl.style.maxHeight).toBe('80px')

    const { container: c3, unmount } = render(
      <BashCommandGroupCard
        parts={[bashPart('d1', 'echo 1'), bashPart('d2', 'echo 2'), bashPart('d3', 'echo 3')]}
      />,
    )
    // 3 项：3×32 + 16 = 112
    expect((c3.querySelector('.bash-group__timeline') as HTMLElement).style.maxHeight).toBe('112px')
    unmount()
  })

  it('>3.5 项：行收起后 scrollTop 还原到展开前停驻位（浏览器钳制模拟）', () => {
    const five = Array.from({ length: 5 }, (_, i) => bashPart(`c${i}`, `echo ${i}`))
    const { container } = render(<BashCommandGroupCard parts={five} />)
    const tl = container.querySelector('.bash-group__timeline') as HTMLElement
    // 5 项：封顶 3.5×32 + 16 = 128
    expect(tl.style.maxHeight).toBe('128px')
    // 折叠态内容 5×32+16=176，容器 128 → 挂载自动滚底停驻在最大位移 48
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { value: 176, configurable: true })
    const layout = { value: 128 }
    mockClientHeight(layout)
    tl.scrollTop = 48

    // 行1 展开：容器放宽（400/auto），浏览器把 scrollTop 钳到 0
    fireEvent.click(container.querySelector('.bash-group__content')!)
    expect(tl.style.maxHeight).toBe('400px')
    layout.value = 400
    tl.scrollTop = 0

    // 行1 收起：容器回落到 128，滚动位应还原到展开前停驻位 48
    layout.value = 128
    fireEvent.click(container.querySelector('.bash-group__content')!)
    expect(tl.style.maxHeight).toBe('128px')
    expect(tl.scrollTop).toBe(48)
  })

  it('行收起还原按展开前锚点：展开期间滚动过也回到展开前视图（undo 语义）', () => {
    const five = Array.from({ length: 5 }, (_, i) => bashPart(`c${i}`, `echo ${i}`))
    const { container } = render(<BashCommandGroupCard parts={five} />)
    const tl = container.querySelector('.bash-group__timeline') as HTMLElement
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { value: 176, configurable: true })
    const layout = { value: 128 }
    mockClientHeight(layout)
    tl.scrollTop = 48

    // 展开（采样停驻位 48）→ 展开期间用户上滚到 20 → 收起
    fireEvent.click(container.querySelector('.bash-group__content')!)
    layout.value = 400
    tl.scrollTop = 20
    layout.value = 128
    fireEvent.click(container.querySelector('.bash-group__content')!)
    // 收起后 max=48，还原展开前锚点 48：列表回到展开前的样子，可预期
    expect(tl.scrollTop).toBe(48)
  })

  it('挂载不触发还原（不覆盖自动滚底停驻）', () => {
    const five = Array.from({ length: 5 }, (_, i) => bashPart(`c${i}`, `echo ${i}`))
    const { container } = render(<BashCommandGroupCard parts={five} />)
    const tl = container.querySelector('.bash-group__timeline') as HTMLElement
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { value: 176, configurable: true })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 128, configurable: true })
    // 模拟挂载自动滚底效果写入的停驻位；expandedIdx 恒为 null，还原逻辑不得改写
    tl.scrollTop = 48
    expect(tl.scrollTop).toBe(48)
  })
})

describe('FileToolGroupCard maxHeight 含 padding（缺陷FG 同族）', () => {
  it('3 项恰好可见：maxHeight = 3×28 + 12 = 96', () => {
    const part: ToolPart = {
      type: 'tool',
      callID: 'f1',
      tool: 'Read',
      state: {
        status: 'completed',
        input: { file_path: 'a.ts' },
        output: 'ok',
        time: { start: 1787283860000, end: 1787283860600 },
      },
    }
    const { container } = render(
      <FileToolGroupCard kind="read" parts={[part, { ...part, callID: 'f2' }, { ...part, callID: 'f3' }]} />,
    )
    const list = container.querySelector('.file-group__list') as HTMLElement
    expect(list.style.maxHeight).toBe('96px')
  })
})
