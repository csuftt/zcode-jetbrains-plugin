/**
 * 用量折线图（纯 SVG，复刻 glm-plan-usage-idea LineChart）
 *
 *   - 响应式宽度：ResizeObserver 测容器宽度，按实际像素算坐标（文字不变形）
 *   - Y 轴：maxVal = 所有点最大值 × 1.15（≤0 取 1），4 档等分网格线 + compact 缩写标签
 *   - X 轴：只显示首/中/尾 3 个标签，按 granularity 格式化（daily→MM-DD / hourly→HH:mm）
 *   - 每条 series：先画半透明面积填充（到基线），再画顶部折线
 *   - 3 色调色板（var(--chart-line/fill-1..3)），按序号 % 3 取色，亮/暗主题自动切换
 *   - 纯静态（对齐 glm 原版，无 hover tooltip）
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { compact, formatXLabel } from '@/utils/format'
import '../styles/line-chart.less'

export interface ChartSeries {
  name: string
  values: number[]
}

interface Props {
  series: ChartSeries[]
  xLabels: string[]
  granularity?: string
  height?: number
}

const PAD_L = 44
const PAD_R = 12
const PAD_T = 10
const PAD_B = 22

export function LineChart({ series, xLabels, granularity, height = 110 }: Props) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(420)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setW(Math.max(220, Math.floor(el.clientWidth)))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const n = xLabels.length
  const plotW = Math.max(10, w - PAD_L - PAD_R)
  const plotH = Math.max(10, height - PAD_T - PAD_B)
  const baseline = PAD_T + plotH

  const xFor = useMemo(() => {
    if (n <= 1) return () => PAD_L + plotW
    return (i: number) => PAD_L + (plotW * i) / (n - 1)
  }, [n, plotW])

  const maxVal = useMemo(() => {
    let m = 0
    for (const s of series) for (const v of s.values) if (v > m) m = v
    return m <= 0 ? 1 : m * 1.15
  }, [series])

  const yFor = (v: number) => PAD_T + plotH * (1 - Math.min(1, Math.max(0, v / maxVal)))

  // 空数据兜底
  if (n === 0 || series.every((s) => s.values.length === 0)) {
    return <div ref={ref} className="line-chart line-chart--empty">{t('usage.chart.empty')}</div>
  }

  // Y 网格 4 档（从顶到底）
  const yTicks = [0, 1, 2, 3, 4].map((i) => ({
    y: PAD_T + (plotH * i) / 4,
    label: compact((maxVal * (4 - i)) / 4),
  }))

  // X 标签：首/中/尾（去重保序）
  const xTickIdx = Array.from(
    new Set([0, Math.floor((n - 1) / 2), n - 1].filter((i) => i >= 0 && i < n)),
  )

  return (
    <div ref={ref} className="line-chart">
      <svg width={w} height={height} className="line-chart__svg">
        {/* Y 网格线 + 标签 */}
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={PAD_L} y1={t.y} x2={w - PAD_R} y2={t.y} className="lc-grid" />
            <text x={4} y={t.y + 3} className="lc-y-label">{t.label}</text>
          </g>
        ))}
        {/* X 轴标签 */}
        {xTickIdx.map((i) => (
          <text
            key={`x${i}`}
            x={xFor(i)}
            y={height - PAD_B + 14}
            className="lc-x-label"
            textAnchor="middle"
          >
            {formatXLabel(xLabels[i], granularity)}
          </text>
        ))}
        {/* 数据：先画所有面积，再画所有折线（避免折线被面积覆盖）*/}
        {series.map((s, si) => {
          const idx = si % 3
          const pts = s.values.map((v, i) => ({ x: xFor(i), y: yFor(v) }))
          if (pts.length === 0) return null
          const last = pts[pts.length - 1]
          const first = pts[0]
          const areaPath =
            `M ${first.x},${baseline} ` +
            pts.map((p) => `L ${p.x},${p.y}`).join(' ') +
            ` L ${last.x},${baseline} Z`
          const linePath = pts
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`)
            .join(' ')
          return (
            <g key={`s${si}`}>
              <path d={areaPath} className="lc-area" style={{ fill: `var(--chart-fill-${idx + 1})` }} />
              <path d={linePath} className="lc-line" style={{ stroke: `var(--chart-line-${idx + 1})` }} />
            </g>
          )
        })}
      </svg>
    </div>
  )
}
