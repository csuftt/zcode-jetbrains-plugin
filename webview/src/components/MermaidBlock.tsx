/**
 * Mermaid 图表渲染块
 *
 * 由 BlockSection 拦截整块 ```mermaid 代码围栏后渲染。
 *
 * 流式友好策略：
 *   - 流式中 500ms 防抖 + mermaid.parse 语法校验，通过才渲染（未闭合/不完整语法不闪错误）
 *   - 内容变化时旧图保留，稳定后替换（不闪空窗）
 *   - 流式结束（streaming=false）立即渲染
 * 主题跟随 html[data-theme]（MutationObserver），明暗切换自动重渲染。
 *
 * 放大查看：图表右上角 hover 出放大按钮 → MermaidModal 全屏弹窗，
 * 右上角工具栏（缩小 | 百分比 | 放大 | 关闭），步进 10%，范围 20%–300%。
 * 弹窗内滚轮缩放（向上放大/向下缩小，每格 ±10%，以鼠标位置为锚点）。
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import mermaid from 'mermaid'

interface Props {
  /** mermaid 源码（```mermaid 围栏内内容）*/
  code: string
  /** 是否在流式中（防抖渲染）*/
  streaming?: boolean
}

let renderSeq = 0

/** 当前主题（html[data-theme]，缺省按暗色）*/
function currentTheme(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

export function MermaidBlock({ code, streaming = false }: Props) {
  const { t } = useTranslation()
  const [theme, setTheme] = useState<'dark' | 'light'>(() => currentTheme())
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // 放大弹窗是否打开
  const [modalOpen, setModalOpen] = useState(false)
  // 已成功渲染的代码版本（内容变化时重渲染）
  const renderedRef = useRef<string | null>(null)
  const lastThemeRef = useRef(theme)

  // 监听 html[data-theme] 明暗切换 → 重渲染
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setTheme(currentTheme()))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  // 渲染主流程：防抖 + 语法校验 + 主题重渲染
  useEffect(() => {
    const themeChanged = lastThemeRef.current !== theme
    lastThemeRef.current = theme

    if (!code.trim()) return
    // 同一版本代码已渲染成功，且主题没变 → 跳过
    if (!themeChanged && renderedRef.current === code) return
    setFailed(false)

    const doRender = async () => {
      try {
        // 每次渲染前按当前主题初始化（mermaid 全局单例）
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
        })
        await mermaid.parse(code) // 语法校验，不合法会 throw
        const { svg: out } = await mermaid.render(`mmd_${++renderSeq}`, code)
        renderedRef.current = code
        setSvg(out)
      } catch {
        // 解析失败：流式中保持文本等待下一个 delta；流式结束仍失败 → 标记错误
        if (!streaming && !themeChanged) setFailed(true)
        if (themeChanged) renderedRef.current = null // 主题变了但渲染失败 → 允许重试
      }
    }

    if (streaming) {
      // 流式中：500ms 防抖，等文本稳定再尝试（语法不完整时 parse 失败但保持文本）
      const t = setTimeout(doRender, 500)
      return () => clearTimeout(t)
    }
    doRender()
  }, [code, streaming, theme])

  // 已渲染成功 → 显示图表（SVG 由 mermaid 库生成）+ 右上角放大按钮
  if (svg) {
    return (
      <div className="mermaid-block">
        <button
          className="mermaid-zoom-btn"
          onClick={() => setModalOpen(true)}
          title={t('chat.mermaid.zoomInView')}
        >
          <span className="codicon codicon-chrome-maximize" />
        </button>
        <div dangerouslySetInnerHTML={{ __html: svg }} />
        {modalOpen && <MermaidModal svg={svg} onClose={() => setModalOpen(false)} />}
      </div>
    )
  }

  // 未渲染/失败 → 显示源码（流式中提示生成中，失败提示错误）
  return (
    <div className="mermaid-fallback">
      <pre className="mermaid-code"><code>{code}</code></pre>
      {failed && <div className="mermaid-error">{t('chat.mermaid.parseFailed')}</div>}
      {streaming && !failed && <div className="mermaid-loading">{t('chat.mermaid.generating')}</div>}
    </div>
  )
}

/**
 * Mermaid 放大弹窗（portal 到 body，避免父级 overflow 裁剪）
 *
 * 右上角工具栏从左到右：缩小 | 百分比(点击重置100%) | 放大 | 关闭
 * 缩放：svg 容器宽度百分比（zoom=1 铺满弹窗、≥聊天区宽度；放大后溢出可横向滚动）
 * 滚轮：向上放大/向下缩小（每格 ±10%），以鼠标位置为锚点（缩放后鼠标下的内容点不动）。
 *   注意 React 的 onWheel 是 passive 监听，preventDefault() 无效，须原生 addEventListener。
 */
function MermaidModal({ svg, onClose }: { svg: string; onClose: () => void }) {
  const { t } = useTranslation()
  const MIN = 0.2
  const MAX = 3
  const STEP = 0.1
  const [zoom, setZoom] = useState(1)
  const pct = Math.round(zoom * 100)
  const contentRef = useRef<HTMLDivElement>(null)
  // zoom 同步副本：滚轮 handler 里读当前值做锚点计算（state 异步更新读不到）
  const zoomRef = useRef(1)
  const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z))
  // 缩放统一入口：clamp + 清理浮点尾差 + 同步 ref
  const applyZoom = (next: number) => {
    const z = clamp(+next.toFixed(3))
    zoomRef.current = z
    setZoom(z)
  }
  const zoomOut = () => applyZoom(zoomRef.current - STEP)
  const zoomIn = () => applyZoom(zoomRef.current + STEP)
  const reset = () => applyZoom(1)

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 滚轮缩放（原生监听，passive:false 才能 preventDefault 屏蔽内容滚动）
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // 鼠标滚轮一格 deltaY≈±100(pixel)，clamp 后每格 ±10%；触控板小步距平滑缩放
      const raw = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      const d = Math.max(-100, Math.min(100, raw))
      const old = zoomRef.current
      const next = clamp(+(old - d * 0.001).toFixed(3))
      if (next === old) return
      zoomRef.current = next
      setZoom(next)
      // 鼠标锚点：内容点 cx = 鼠标视口位置 + scroll - padding，缩放 r 倍后仍回到鼠标处
      const r = next / old
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const pl = parseFloat(getComputedStyle(el).paddingLeft) || 0
      const pt = parseFloat(getComputedStyle(el).paddingTop) || 0
      el.scrollLeft = Math.max(0, pl + (el.scrollLeft + mx - pl) * r - mx)
      el.scrollTop = Math.max(0, pt + (el.scrollTop + my - pt) * r - my)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return createPortal(
    <div className="mermaid-modal-overlay" onClick={onClose}>
      {/* 右上角工具栏：缩小 | 百分比(点击重置) | 放大 | 关闭 */}
      <div className="mermaid-modal-toolbar" onClick={(e) => e.stopPropagation()}>
        <button
          className="mermaid-modal-btn"
          onClick={zoomOut}
          disabled={zoom <= MIN}
          title={t('chat.mermaid.zoomOutTitle')}
        >
          <span className="codicon codicon-zoom-out" />
        </button>
        <button className="mermaid-modal-pct" onClick={reset} title={t('chat.mermaid.resetZoom')}>
          {pct}%
        </button>
        <button
          className="mermaid-modal-btn"
          onClick={zoomIn}
          disabled={zoom >= MAX}
          title={t('chat.mermaid.zoomInTitle')}
        >
          <span className="codicon codicon-zoom-in" />
        </button>
        <button
          className="mermaid-modal-btn mermaid-modal-close"
          onClick={onClose}
          title={t('chat.mermaid.close')}
        >
          <span className="codicon codicon-chrome-close" />
        </button>
      </div>
      <div
        className="mermaid-modal-content"
        ref={contentRef}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 宽度按 zoom 百分比：100% 铺满弹窗（不窄于聊天区），放大后超出可视区横向滚动 */}
        <div
          className="mermaid-modal-svg"
          style={{ width: `${zoom * 100}%` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>,
    document.body,
  )
}
