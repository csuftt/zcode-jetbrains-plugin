/**
 * 闪屏探针 v2（临时诊断：间歇闪屏排查，0.3.2 真机反馈）
 *
 * v1 真机取证（idea.log 10:38-10:41）：闪屏期间 .messages-container 元素增删=0、
 * >400px 滚动瞬移=0、console 零错误 —— DOM 结构稳定，闪的在 v1 观察面之外。
 * v2 补四路盲区（用户补充：所有会话都闪，非 goal 独有 → 消息区之外的常驻
 * 组件同样在嫌疑内）：
 * 1) 观察 document.body 全树（v1 只盯消息区；Header/输入框/StatusPanel/
 *    锚点轨道/portal 弹层全覆盖）
 * 2) attributes 观察class/style/hidden 翻转——视觉闪不需要结构变化
 * 3) 视口尺寸抖动（window resize + 根元素 ResizeObserver：webview 尺寸
 *    微变 = 整页重排闪）
 * 4) visibilitychange / blur（JCEF 层隐藏显示反复触发）+ 滚动拉锯
 *    （500ms 窗口 scrollTop 方向翻转 ≥3 次 = 自动贴底与用户滚动打架）
 *
 * 聚合 300ms 一条；10s 内超 20 条触发限流（防日志风暴反噬 EDT）。
 * 关闭：localStorage `zcode.flashProbe` = '0'。
 * 定案后移除本文件与 main.tsx 的挂载点（诊断日志纪律：埋点使命完成要摘）。
 */

import { isInJcef, sendToJava } from '@/ipc/bridge'

const AGGREGATE_MS = 300
/** 单条日志的节点摘要上限（防爆量） */
const MAX_NODES = 6
/** 限流：10s 窗口内最多 20 条，超出记一次 rate-limited 后静默到窗口结束 */
const RATE_WINDOW_MS = 10_000
const RATE_LIMIT = 20

function nodeBrief(n: Node): string {
  if (!(n instanceof Element)) return '#text'
  const cls = String(n.className || '')
  const first = cls.split(/\s+/).filter(Boolean)[0] ?? n.tagName.toLowerCase()
  // 只留首个类名片段，data-anchor-msg 缩写（同 v1，日志可 grep 回组件）
  const anchor = n.getAttribute?.('data-anchor-msg')
  return anchor ? `${first}[${anchor.slice(0, 10)}]` : first
}

export function installFlashProbe(): void {
  if (typeof window === 'undefined') return
  try {
    if (window.localStorage.getItem('zcode.flashProbe') === '0') return
  } catch {
    /* localStorage 不可用按启用 */
  }
  if (!isInJcef()) return // dev/mock 不装

  const log = (text: string) => {
    try {
      sendToJava({ op: '__jsLog', level: 'warn', text })
    } catch {
      /* 诊断不设障 */
    }
  }

  const startedAt = Date.now()

  /* ============ 限流（10s / 20 条） ============ */
  let rateWindowStart = Date.now()
  let rateCount = 0
  let rateSilenced = false
  const emit = (text: string) => {
    const now = Date.now()
    if (now - rateWindowStart > RATE_WINDOW_MS) {
      rateWindowStart = now
      rateCount = 0
      rateSilenced = false
    }
    if (rateSilenced) return
    rateCount++
    if (rateCount > RATE_LIMIT) {
      rateSilenced = true
      // 限流本身也占一条，让日志里可见"有事件被吞了"而不是断流假象
      try {
        sendToJava({ op: '__jsLog', level: 'warn', text: '[flash-probe] rate-limited (10s)' })
      } catch {
        /* 诊断不设障 */
      }
      return
    }
    log(text)
  }
  const at = () => `@${((Date.now() - startedAt) / 1000).toFixed(1)}s`

  /* ============ 1+2) 全树结构 + 属性变化（body 下全兜） ============ */
  const added: string[] = []
  const removed: string[] = []
  const attrs: string[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    flushTimer = null
    if (added.length === 0 && removed.length === 0 && attrs.length === 0) return
    const a = added.slice(0, MAX_NODES).join(',')
    const r = removed.slice(0, MAX_NODES).join(',')
    const m = attrs.slice(0, MAX_NODES).join(',')
    emit(`[flash-probe] dom +${added.length}${a ? `(${a})` : ''} -${removed.length}${r ? `(${r})` : ''} attr~${attrs.length}${m ? `(${m})` : ''} ${at()}`)
    added.length = 0
    removed.length = 0
    attrs.length = 0
  }
  const queueFlush = () => {
    if (!flushTimer) flushTimer = setTimeout(flush, AGGREGATE_MS)
  }

  new MutationObserver((muts) => {
    for (const mu of muts) {
      if (mu.type === 'attributes') {
        attrs.push(`${nodeBrief(mu.target)}.${mu.attributeName ?? '?'}`)
        continue
      }
      for (const n of mu.addedNodes) {
        // 文本增长不算闪屏（流式正常增量），只记元素级（同 v1）
        if (n instanceof Element) added.push(nodeBrief(n))
      }
      for (const n of mu.removedNodes) {
        if (n instanceof Element) removed.push(nodeBrief(n))
      }
    }
    queueFlush()
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden'],
  })

  /* ============ 3) 视口尺寸抖动（webview 尺寸微变 = 整页重排闪） ============ */
  let lastW = window.innerWidth
  let lastH = window.innerHeight
  const reportViewport = (src: string) => {
    const w = window.innerWidth
    const h = window.innerHeight
    if (w !== lastW || h !== lastH) {
      emit(`[flash-probe] viewport ${lastW}x${lastH} -> ${w}x${h} via ${src} ${at()}`)
      lastW = w
      lastH = h
    }
  }
  window.addEventListener('resize', () => reportViewport('resize'))
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => reportViewport('ResizeObserver')).observe(document.documentElement)
  }

  /* ============ 4a) JCEF 可见性 / 焦点翻转 ============ */
  // img 重载（src 不变时结构/属性层均不可见，capture load 兜底——本地图片
  // 端点若反复重载，解码重绘在视觉上就是闪）
  window.addEventListener('load', (e) => {
    const t = e.target
    if (t instanceof HTMLImageElement && t.src) {
      emit(`[flash-probe] img load ${t.src.slice(-48)} ${at()}`)
    }
  }, true)
  document.addEventListener('visibilitychange', () => {
    emit(`[flash-probe] visibility hidden=${document.hidden} ${at()}`)
  })
  window.addEventListener('blur', () => emit(`[flash-probe] window blur ${at()}`))
  window.addEventListener('focus', () => emit(`[flash-probe] window focus ${at()}`))

  /* ============ 4b) 滚动拉锯（小幅高频反向 = 贴底滚动打架，v1 400px 阈值盲区） ============ */
  const attachYoyo = () => {
    const container = document.querySelector('.messages-container')
    if (!container) {
      setTimeout(attachYoyo, 1000) // 会话视图未挂载，轮询等（同 v1）
      return
    }
    const events: { t: number; top: number }[] = []
    container.addEventListener('scroll', () => {
      const now = performance.now()
      events.push({ t: now, top: container.scrollTop })
      while (events.length > 0 && now - events[0].t > 500) events.shift()
      if (events.length < 3) return
      let flips = 0
      let range = 0
      let min = events[0].top
      let max = events[0].top
      for (let i = 2; i < events.length; i++) {
        const d0 = events[i - 1].top - events[i - 2].top
        const d1 = events[i].top - events[i - 1].top
        if (d0 !== 0 && d1 !== 0 && Math.sign(d0) !== Math.sign(d1)) flips++
      }
      for (const e of events) {
        if (e.top < min) min = e.top
        if (e.top > max) max = e.top
      }
      range = max - min
      // 500ms 内方向翻转 ≥3 次且总幅度 >24px = 拉锯（用户滚动是单向惯性）
      if (flips >= 3 && range > 24) {
        events.length = 0
        emit(`[flash-probe] yoyo ${flips}flips ${Math.round(range)}px ${at()}`)
      }
    }, { passive: true })
  }
  attachYoyo()

  emit(`[flash-probe] v2 installed on body+viewport+visibility`)
}
