/**
 * 用量折线图悬停浮层与图例测试（LineChart，2026-09-02）
 *
 * 行为：
 *   - 图例：曲线下方渲染色点 + 系列名（颜色 ↔ 模型对应关系），
 *     色点取 var(--chart-line-N)（N 按序号 % 6 循环）
 *   - 悬停：指针 x 吸附最近数据点索引，画竖直参考线 + 各系列数据点，
 *     浮层列出该点各系列数值（fmtBig）与总计（usage.chart.total）；
 *     数值 0 的系列不进浮层，其余按数值降序（总计行仍在最底，色点颜色随系列不随排序变）
 *   - 靠右翻转：参考线偏右时浮层 translate(-100%) 到线左侧，避免溢出
 *   - 移出图表：浮层消失
 *
 * 坐标口径：jsdom 下容器 clientWidth=0 → 宽度回退 220（Math.max(220,…)），
 * plotW = 220-44-12 = 164；4 点时 xFor(i) = 44 + 164·i/3。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

vi.mock('@/ipc/bridge', () => ({
  sendToJava: () => {},
  isInJcef: () => false,
  onMessage: () => () => {},
}))

import '@/i18n/config'
import { LineChart } from '@/components/LineChart'

const X_LABELS = ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']
const SERIES = [
  { name: 'GLM-5.3', values: [100, 200, 50, 80] },
  { name: 'GLM-5.3-Air', values: [40, 60, 70, 30] },
  { name: 'Qwen3-Coder', values: [70, 0, 0, 10] },
]

/** jsdom 无 ResizeObserver，装空实现让组件挂载走通 */
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

function renderChart(props?: { xLabels?: string[]; granularity?: string }) {
  const utils = render(
    <LineChart
      series={SERIES}
      xLabels={props?.xLabels ?? X_LABELS}
      granularity={props?.granularity ?? 'daily'}
    />,
  )
  const svg = document.querySelector('.line-chart__svg') as SVGSVGElement
  // 指针坐标换算走 svg 的 getBoundingClientRect，mock 成 left=0 的 220px 视口
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 220, height: 110, right: 220, bottom: 110, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  return { ...utils, svg }
}

describe('用量折线图：悬停浮层与图例', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  it('图例：曲线下方渲染全部系列名，色点按调色板序号取色', () => {
    renderChart()
    const legend = document.querySelector('.lc-legend') as HTMLElement
    expect(legend).toBeTruthy()
    expect(legend.textContent).toContain('GLM-5.3')
    expect(legend.textContent).toContain('GLM-5.3-Air')
    expect(legend.textContent).toContain('Qwen3-Coder')
    const dots = legend.querySelectorAll('.lc-legend__dot')
    expect(dots.length).toBe(3)
    expect((dots[0] as HTMLElement).style.background).toBe('var(--chart-line-1)')
    expect((dots[1] as HTMLElement).style.background).toBe('var(--chart-line-2)')
    expect((dots[2] as HTMLElement).style.background).toBe('var(--chart-line-3)')
  })

  it('悬停吸附最近数据点：浮层列各系列数值与总计，含该点 x 标签', () => {
    const { svg } = renderChart()
    // clientX=100 → (100-44)/164·3 ≈ 1.02 → 吸附 idx=1（GLM-5.3=200，Air=60，Qwen=0，总计 260）
    fireEvent.mouseMove(svg, { clientX: 100 })
    const tip = document.querySelector('.lc-tooltip') as HTMLElement
    expect(tip).toBeTruthy()
    expect(tip.textContent).toContain('08-31') // x 标签（daily → MM-DD）
    expect(tip.textContent).toContain('200')
    expect(tip.textContent).toContain('60')
    expect(tip.textContent).toContain('总计')
    expect(tip.textContent).toContain('260')
    // 参考线 + 每系列一个数据点（0 值系列画点但不进浮层行）
    expect(document.querySelector('.lc-hover-line')).toBeTruthy()
    expect(document.querySelectorAll('.lc-dot').length).toBe(3)
  })

  it('浮层行按数值降序，0 值系列不显示；色点颜色随系列不随排序变', () => {
    const { svg } = renderChart()
    // clientX=145 → (145-44)/164·3 ≈ 1.85 → 吸附 idx=2（GLM=50，Air=70，Qwen=0，总计 120）
    fireEvent.mouseMove(svg, { clientX: 145 })
    const tip = document.querySelector('.lc-tooltip') as HTMLElement
    expect(tip).toBeTruthy()
    expect(tip.textContent).toContain('120')
    expect(tip.textContent).not.toContain('Qwen3-Coder')
    // 行顺序：Air(70) 在 GLM(50) 前，总计行最末
    const rows = [...tip.querySelectorAll('.lc-tooltip__row')].map((r) => r.textContent)
    expect(rows.length).toBe(3)
    expect(rows[0]).toContain('GLM-5.3-Air')
    expect(rows[0]).toContain('70')
    expect(rows[1]).toContain('GLM-5.3')
    expect(rows[1]).toContain('50')
    expect(rows[2]).toContain('总计')
    // Air 是系列 2，排序后色点仍取 chart-line-2
    const dotColors = [...tip.querySelectorAll('.lc-tooltip__dot')].map(
      (d) => (d as HTMLElement).style.background,
    )
    expect(dotColors[0]).toBe('var(--chart-line-2)')
    expect(dotColors[1]).toBe('var(--chart-line-1)')
  })

  it('靠右悬停浮层翻到参考线左侧（translate -100%）', () => {
    const { svg } = renderChart()
    fireEvent.mouseMove(svg, { clientX: 208 }) // idx=3，hoverX=208 > 220-170
    const tip = document.querySelector('.lc-tooltip') as HTMLElement
    expect(tip).toBeTruthy()
    expect(tip.style.transform).toBe('translate(-100%, 0)')
  })

  it('hourly 浮层 x 标签带日期（MM-DD HH:mm），跨天可辨', () => {
    const { svg } = renderChart({
      xLabels: ['2026-08-13 09:00', '2026-08-13 12:00', '2026-08-14 09:00', '2026-08-14 12:00'],
      granularity: 'hourly',
    })
    // clientX=100 → 吸附 idx=1 → '08-13 12:00'
    fireEvent.mouseMove(svg, { clientX: 100 })
    const tip = document.querySelector('.lc-tooltip') as HTMLElement
    expect(tip).toBeTruthy()
    expect(tip.textContent).toContain('08-13 12:00')
    // 次日点 idx=2 → '08-14 09:00'
    fireEvent.mouseMove(svg, { clientX: 145 })
    expect(document.querySelector('.lc-tooltip')!.textContent).toContain('08-14 09:00')
  })

  it('移出图表浮层消失，再悬停恢复', () => {
    const { svg } = renderChart()
    fireEvent.mouseMove(svg, { clientX: 100 })
    expect(document.querySelector('.lc-tooltip')).toBeTruthy()
    fireEvent.mouseLeave(svg)
    expect(document.querySelector('.lc-tooltip')).toBeNull()
    fireEvent.mouseMove(svg, { clientX: 60 })
    expect(document.querySelector('.lc-tooltip')).toBeTruthy()
  })
})
