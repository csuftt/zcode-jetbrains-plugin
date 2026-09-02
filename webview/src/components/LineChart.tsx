/**
 * 用量折线图（纯 SVG，复刻 glm-plan-usage-idea LineChart 并增强）
 *
 *   - 响应式宽度：ResizeObserver 测容器宽度，按实际像素算坐标（文字不变形）
 *   - Y 轴：maxVal = 所有点最大值 × 1.15（≤0 取 1），4 档等分网格线 + compact 缩写标签
 *   - X 轴：只显示首/中/尾 3 个标签，按 granularity 格式化（daily→MM-DD / hourly→HH:mm）
 *   - 每条 series：先画半透明面积填充（到基线），再画顶部折线
 *   - 6 色调色板（var(--chart-line/fill-1..6)），按序号 % 6 取色，亮/暗主题自动切换
 *   - 图例：曲线下方色点 + 系列名（颜色↔模型对应关系）
 *   - 悬停：吸附最近 x 点，画竖直参考线 + 各系列数据点，浮层列出各系列数值与总计
 *     （数值 0 的系列不进浮层，其余按数值降序；浮层 x 标签 hourly 带日期 MM-DD HH:mm；
 *     浮层用 HTML 绝对定位覆盖在 SVG 上，不随坐标缩放变形，pointer-events 关闭防闪烁）
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { compact, fmtBig, formatXLabel, formatXLabelFull } from '@/utils/format'
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

/** 调色板长度（与 variables.less 的 --chart-line-1..6 对齐）*/
const PALETTE = 6

export function LineChart({ series, xLabels, granularity, height = 110 }: Props) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [w, setW] = useState(420)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

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

  /** 悬停：按指针 x 吸附最近的数据点索引（夹在绘图区内）*/
  const onMove = (e: React.MouseEvent) => {
    if (n === 0 || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const idx = n <= 1 ? 0 : Math.round(((x - PAD_L) / plotW) * (n - 1))
    setHoverIdx(Math.min(n - 1, Math.max(0, idx)))
  }

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

  // 悬停浮层数据：各系列当前点数值（缺省 0），0 值行不显示，其余按数值降序
  // （si 保留系列序号供色点取色，排序不改变颜色↔曲线的对应）
  const hoverRows =
    hoverIdx != null
      ? series
          .map((s, si) => ({ si, name: s.name, value: s.values[hoverIdx] ?? 0 }))
          .filter((r) => r.value > 0)
          .sort((a, b) => b.value - a.value)
      : []
  const hoverTotal =
    hoverIdx != null
      ? series.reduce((sum, s) => sum + (s.values[hoverIdx] ?? 0), 0)
      : 0
  const hoverX = hoverIdx != null ? xFor(hoverIdx) : 0
  // 靠右时浮层翻到参考线左侧，避免溢出容器
  const flip = hoverX > w - 170

  return (
    <div ref={ref} className="line-chart">
      <svg
        ref={svgRef}
        width={w}
        height={height}
        className="line-chart__svg"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
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
          const idx = si % PALETTE
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
        {/* 悬停参考线 + 各系列数据点 */}
        {hoverIdx != null && (
          <g className="lc-hover">
            <line x1={hoverX} y1={PAD_T} x2={hoverX} y2={baseline} className="lc-hover-line" />
            {series.map((s, si) =>
              hoverIdx < s.values.length ? (
                <circle
                  key={`d${si}`}
                  cx={hoverX}
                  cy={yFor(s.values[hoverIdx])}
                  r={3}
                  className="lc-dot"
                  style={{ fill: `var(--chart-line-${(si % PALETTE) + 1})` }}
                />
              ) : null,
            )}
          </g>
        )}
      </svg>

      {/* 图例：色点 + 系列名 */}
      {series.length > 0 && (
        <div className="lc-legend">
          {series.map((s, si) => (
            <span key={si} className="lc-legend__item" title={s.name}>
              <span
                className="lc-legend__dot"
                style={{ background: `var(--chart-line-${(si % PALETTE) + 1})` }}
              />
              <span className="lc-legend__name">{s.name}</span>
            </span>
          ))}
        </div>
      )}

      {/* 悬停浮层：各系列数值 + 总计 */}
      {hoverIdx != null && (
        <div
          className="lc-tooltip"
          style={{ left: hoverX, top: PAD_T, transform: flip ? 'translate(-100%, 0)' : undefined }}
        >
          <div className="lc-tooltip__x">{formatXLabelFull(xLabels[hoverIdx], granularity)}</div>
          {hoverRows.map((r) => (
            <div key={r.si} className="lc-tooltip__row">
              <span
                className="lc-tooltip__dot"
                style={{ background: `var(--chart-line-${(r.si % PALETTE) + 1})` }}
              />
              <span className="lc-tooltip__name" title={r.name}>{r.name}</span>
              <span className="lc-tooltip__val">{fmtBig(r.value)}</span>
            </div>
          ))}
          <div className="lc-tooltip__row lc-tooltip__row--total">
            <span className="lc-tooltip__name">{t('usage.chart.total')}</span>
            <span className="lc-tooltip__val">{fmtBig(hoverTotal)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
