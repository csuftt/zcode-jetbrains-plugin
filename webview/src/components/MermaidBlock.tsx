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
 * 放大查看：图表右上角 hover 出工具栏（复制代码 | 复制图片 | 放大），
 * 放大进 MermaidModal 全屏弹窗，右上角工具栏（复制代码 | 复制图片 | 缩小 | 百分比 | 放大 | 关闭）。
 * 复制图片：SVG 按 viewBox 2x 位图化成 PNG 写剪贴板（填主题背景色，防透明底粘到白底应用看不清）。
 * 弹窗布局：图小于视口时水平+垂直居中（flex + margin:auto 安全居中，溢出时正常滚动）。
 * 拖动平移：内容溢出时手型（grab）按住拖动滚动，步进缩放 25%，范围 20%–300%。
 * 弹窗内滚轮缩放（向上放大/向下缩小，每格 ±25%，以鼠标位置为锚点）。
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import mermaid from 'mermaid'
import { copyText, useCopyFeedback } from '@/utils/clipboard'
import { sendToJava, onMessage, isInJcef } from '@/ipc/bridge'
import type { JavaRequest } from '@/types/messages'
import '../styles/markdown.less'

interface Props {
  /** mermaid 源码（```mermaid 围栏内内容）*/
  code: string
  /** 是否在流式中（防抖渲染）*/
  streaming?: boolean
}

let renderSeq = 0

/** 复制成功/失败反馈保持时长（ms） */
const COPY_DONE_MS = 1500

/** 当前主题（html[data-theme]，缺省按暗色）*/
function currentTheme(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/** SVG 字符串 → PNG Blob。
 *  按 viewBox 取逻辑尺寸、2x 上采样保清晰（超大图降回 1x 防 canvas 尺寸超限）。
 *  位图化前去掉 max-width 并写死 width/height，否则 Image 加载可能按视口宽渲染。
 */
async function svgToPngBlob(svg: string, theme: 'dark' | 'light'): Promise<Blob> {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const svgEl = doc.documentElement
  // Image 加载 SVG 走 XML 严格模式：缺 xmlns 直接 onerror（mermaid 输出可能不带——
  // 直接嵌 HTML 渲染无感，位图化必炸，2026-09-01 实测踩中）
  if (!svgEl.getAttribute('xmlns')) {
    svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  }
  if (!svgEl.getAttribute('xmlns:xlink')) {
    svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
  }
  // 逻辑尺寸：优先 viewBox，缺省退 width/height 属性
  let w = 0
  let h = 0
  const vb = (svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    w = vb[2]
    h = vb[3]
  }
  if (!w || !h) {
    w = parseFloat(svgEl.getAttribute('width') || '') || 0
    h = parseFloat(svgEl.getAttribute('height') || '') || 0
  }
  if (!w || !h) throw new Error('mermaid svg has no size')
  const scale = w * 2 > 4096 || h * 2 > 4096 ? 1 : 2
  svgEl.removeAttribute('style')
  svgEl.setAttribute('width', String(Math.round(w * scale)))
  svgEl.setAttribute('height', String(Math.round(h * scale)))
  const svgStr = new XMLSerializer().serializeToString(svgEl)
  const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg to image failed'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    // 填主题背景色：暗色主题文字浅色，透明底粘到白底应用（微信/文档）会看不清
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--code-bg').trim()
    ctx.fillStyle = bg || (theme === 'dark' ? '#1e1e1e' : '#ffffff')
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 错误展开成可读文本（日志钩子 JSON.stringify(Error)={} 会丢 message，须先展平）*/
function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  try {
    return JSON.stringify(e) ?? String(e)
  } catch {
    return String(e)
  }
}

/** PNG Blob 写入剪贴板：优先浏览器原生 API，JCEF 里写图片不可靠 → 降级 Java 系统剪贴板桥 */
async function copyPngToClipboard(blob: Blob): Promise<boolean> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    } catch (e) {
      console.error(`[mermaid] navigator.clipboard.write 图片失败，走 Java 剪贴板降级: ${errText(e)}`)
    }
  }
  return isInJcef() ? copyImageViaJava(blob) : Promise.resolve(false)
}

/** Java 桥降级：PNG base64 → AWT 系统剪贴板，等 imageCopied 回执（超时 5s）*/
function copyImageViaJava(blob: Blob): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(ok)
    }
    const unsubscribe = onMessage((msg) => {
      if (msg.op === 'imageCopied') {
        if (!msg.ok) console.error(`[mermaid] Java 剪贴板写入失败: ${msg.error ?? '?'}`)
        done(msg.ok)
      }
    })
    const timer = window.setTimeout(() => done(false), 5000)
    const reader = new FileReader()
    reader.onload = () => {
      const b64 = String(reader.result).split(',')[1] ?? ''
      sendToJava({ op: 'copyImage', dataBase64: b64 } as JavaRequest)
    }
    reader.onerror = () => {
      console.error(`[mermaid] PNG 转 base64 失败: ${errText(reader.error)}`)
      done(false)
    }
    reader.readAsDataURL(blob)
  })
}

/** 复制图片一条龙（供主块/弹窗复用）：
 *  显示版 svg 含 foreignObject（htmlLabels），Image 加载后 canvas 必被 Chromium 判污染、
 *  toBlob 抛 SecurityError（2026-09-01 JCEF 实测）。改用顶层 htmlLabels:false 重渲染一份
 *  导出版（标签为纯 SVG text，文字完整），位图化不再污染。
 *  注意必须是顶层 htmlLabels:false——flowchart.htmlLabels 子键在 v11 实测无效仍产 foreignObject。
 */
async function copyCodeAsPng(code: string, theme: 'dark' | 'light'): Promise<boolean> {
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'dark' ? 'dark' : 'default',
      htmlLabels: false,
    })
    const { svg } = await mermaid.render(`mmd_export_${++renderSeq}`, code)
    return await copyPngToClipboard(await svgToPngBlob(svg, theme))
  } catch (e) {
    console.error(`[mermaid] 导出渲染/位图化失败: ${errText(e)}`)
    return false
  }
}

/**
 * 复制按钮：点击执行 doCopy，成功/失败图标反馈 1.5s（✓ 绿 / ✗ 红，类 mermaid-copy-ok/fail）
 */
function CopyButton({
  icon,
  title,
  doCopy,
  className,
}: {
  icon: string
  title: string
  doCopy: () => Promise<boolean>
  className?: string
}) {
  const { t } = useTranslation()
  const { state, showResult } = useCopyFeedback(COPY_DONE_MS)
  return (
    <button
      className={`${className ?? ''} mermaid-copy-${state}`.trim()}
      onClick={() => showResult(doCopy)}
      title={state === 'ok' ? t('chat.mermaid.copied') : state === 'fail' ? t('chat.mermaid.copyFailed') : title}
    >
      <span
        className={
          state === 'ok'
            ? 'codicon codicon-check'
            : state === 'fail'
              ? 'codicon codicon-error'
              : `codicon ${icon}`
        }
      />
    </button>
  )
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

  // 已渲染成功 → 显示图表 + 右上角工具栏（复制代码 | 复制图片 | 放大）
  if (svg) {
    return (
      <div className="mermaid-block">
        <div className="mermaid-toolbar">
          <CopyButton
            className="mermaid-tool-btn"
            icon="codicon-copy"
            title={t('chat.mermaid.copyCode')}
            doCopy={() => copyText(code)}
          />
          <CopyButton
            className="mermaid-tool-btn"
            icon="codicon-file-media"
            title={t('chat.mermaid.copyImage')}
            doCopy={() => copyCodeAsPng(code, theme)}
          />
          <button
            className="mermaid-tool-btn"
            onClick={() => setModalOpen(true)}
            title={t('chat.mermaid.zoomInView')}
          >
            <span className="codicon codicon-chrome-maximize" />
          </button>
        </div>
        <div dangerouslySetInnerHTML={{ __html: svg }} />
        {modalOpen && (
          <MermaidModal svg={svg} code={code} theme={theme} onClose={() => setModalOpen(false)} />
        )}
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
 * 右上角工具栏从左到右：复制代码 | 复制图片 | 缩小 | 百分比(点击重置100%) | 放大 | 关闭
 * 布局：flex + 子项 margin:auto——fit 时水平垂直居中，溢出时 auto 归零正常滚动
 *   （不用 align-items:center：溢出时它会裁掉顶部滚不到）。
 * 拖动：内容溢出时光标变手型（grab），按住拖动平移滚动（window 级监听，拖出窗口不断线）。
 * 缩放：svg 容器宽度百分比（zoom=1 铺满弹窗、≥聊天区宽度；放大后溢出可横向滚动）
 * 滚轮：向上放大/向下缩小（每格 ±25%），以鼠标位置为锚点（缩放后鼠标下的内容点不动）。
 *   注意 React 的 onWheel 是 passive 监听，preventDefault() 无效，须原生 addEventListener。
 */
function MermaidModal({
  svg,
  code,
  theme,
  onClose,
}: {
  svg: string
  code: string
  theme: 'dark' | 'light'
  onClose: () => void
}) {
  const { t } = useTranslation()
  const MIN = 0.2
  const MAX = 3
  const STEP = 0.1
  const [zoom, setZoom] = useState(1)
  const pct = Math.round(zoom * 100)
  const contentRef = useRef<HTMLDivElement>(null)
  // zoom 同步副本：滚轮 handler 里读当前值做锚点计算（state 异步更新读不到）
  const zoomRef = useRef(1)
  // 手型拖动：起点坐标 + 起点滚动位置，null=未在拖动
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // 内容是否溢出（溢出才可拖，手型光标才不误导）
  const [pannable, setPannable] = useState(false)
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

  // 溢出检测：svg 载入/zoom 变化/窗口缩放都可能改变，ResizeObserver 兜底
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const check = () =>
      setPannable(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [zoom])

  // 手型拖动平移：按住改写 scrollLeft/scrollTop
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      const el = contentRef.current
      if (!d || !el) return
      el.scrollLeft = d.sl - (e.clientX - d.x)
      el.scrollTop = d.st - (e.clientY - d.y)
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const onPanStart = (e: React.MouseEvent) => {
    const el = contentRef.current
    if (!el || e.button !== 0 || !pannable) return
    dragRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
    setDragging(true)
    e.preventDefault() // 防拖动时选中 svg 文本
  }

  // 滚轮缩放（原生监听，passive:false 才能 preventDefault 屏蔽内容滚动）
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // 鼠标滚轮一格 deltaY≈±100(pixel)，clamp 后每格 ±25%（快速缩放）；触控板小步距平滑缩放
      const raw = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      const d = Math.max(-100, Math.min(100, raw))
      const old = zoomRef.current
      const next = clamp(+(old - d * 0.0025).toFixed(3))
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
      {/* 右上角工具栏：复制代码 | 复制图片 | 缩小 | 百分比(点击重置) | 放大 | 关闭 */}
      <div className="mermaid-modal-toolbar" onClick={(e) => e.stopPropagation()}>
        <CopyButton
          className="mermaid-modal-btn"
          icon="codicon-copy"
          title={t('chat.mermaid.copyCode')}
          doCopy={() => copyText(code)}
        />
        <CopyButton
          className="mermaid-modal-btn"
          icon="codicon-file-media"
          title={t('chat.mermaid.copyImage')}
          doCopy={() => copyCodeAsPng(code, theme)}
        />
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
        className={`mermaid-modal-content${pannable ? ' mermaid-modal-content--pan' : ''}${dragging ? ' dragging' : ''}`}
        ref={contentRef}
        onMouseDown={onPanStart}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 宽度按 zoom 百分比：100% 铺满弹窗（不窄于聊天区），放大后超出可视区可拖动/滚动 */}
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
