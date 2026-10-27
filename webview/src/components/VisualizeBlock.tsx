/**
 * ::visualize 内联可视化块
 *
 * 由 MarkdownBlock 渲染前经 splitVisualizeDirectives 拦出指令后渲染（BlockSection
 * 的 mermaid 同族模式——DOMPurify 白名单无 iframe，必须走 React 组件而非 HTML 注入）。
 *
 * 加载链：vizOpen op → Java 校验白名单根（~/.zcode/(v2/)visualizations）登记 token
 * → 内置 server 的 /viz/<token> URL，**前端 fetch 该 URL 拿 html 后一律 srcdoc 渲染**。
 * iframe 直接 src 到 /viz/ 在 JCEF 里不可靠：frame 导航会被 openLinksInExternalBrowser
 * 层劫持转系统浏览器（真机实测：当前会话首次加载偶好、放大弹层与历史会话打开必转），
 * srcdoc 无导航请求，外转机制无从触发。singlefile 降级（内置 server 未启动）Java 直接
 * 回注入基线后的 html。
 *
 * 宿主基线（主题 CSS 变量/window.zcode shim/高度上报/body 留白）由 Java serve 期注入，这里负责：
 * - 子页 resize postMessage → iframe 高度自适应
 * - 主题跟随 html[data-theme]（MutationObserver）→ postMessage 推给子页
 * - 子页 open-external 转发 openExternalUrl（协议白名单双侧校验）
 * - 工具栏：复制图片（视口矩形上报 + Java Robot 截屏）| 在浏览器打开（复用 openExternalUrl，
 *   真机结论：缩放交互在沙箱 iframe 里不稳定已整体砍掉，放大需求=调大插件面板宽度）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sendToJava, onMessage, openExternalUrl } from '@/ipc/bridge'
import { useCopyFeedback } from '@/utils/clipboard'
import type { VizDirective } from '@/utils/visualizeDirective'
import type { JavaRequest } from '@/types/messages'
import '../styles/visualize-block.less'

interface Props {
  directive: VizDirective
}

/** vizOpen 回执等待超时 */
const VIZ_OPEN_TIMEOUT_MS = 8000
/** 高度自适应夹取范围（可视化宿主上限 10000px，这里取常用区间防异常值撑爆消息流） */
const MIN_HEIGHT = 120
const MAX_HEIGHT = 4000
/** 加载中骨架高度 */
const LOADING_HEIGHT = 200
/** onLoad 后无 resize 消息的兜底揭示时长（防子页脚本异常时骨架卡死） */
const LOADED_FALLBACK_MS = 1500
/** 复制反馈保持时长 */
const COPY_DONE_MS = 1500

/** 当前主题（html[data-theme]，缺省按暗色）——MermaidBlock 同款 */
function currentTheme(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/** vizOpen 请求-回执（onMessage 等回执 + 超时，copyImageViaJava 同款模式） */
function requestVizOpen(
  path: string,
  theme: 'dark' | 'light',
): Promise<{ ok: boolean; url?: string; html?: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (r: { ok: boolean; url?: string; html?: string; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(r)
    }
    const unsubscribe = onMessage((msg) => {
      if (msg.op === 'vizOpenResult' && msg.path === path) done(msg)
    })
    const timer = window.setTimeout(() => done({ ok: false, error: 'timeout' }), VIZ_OPEN_TIMEOUT_MS)
    sendToJava({ op: 'vizOpen', path, theme } as JavaRequest)
  })
}

/** 复制图片：上报 iframe 视口矩形，Java Robot 截屏写系统剪贴板（imageCopied 回执复用） */
function copyVizImageViaJava(iframe: HTMLIFrameElement | null): Promise<boolean> {
  if (!iframe) return Promise.resolve(false)
  const rect = iframe.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return Promise.resolve(false)
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
      if (msg.op === 'imageCopied') done(!!msg.ok)
    })
    const timer = window.setTimeout(() => done(false), VIZ_OPEN_TIMEOUT_MS)
    sendToJava({
      op: 'copyVizImage',
      x: rect.left,
      y: rect.top,
      w: rect.width,
      h: rect.height,
      vw: window.innerWidth,
      vh: window.innerHeight,
    } as JavaRequest)
  })
}

/** 工具栏 ghost 按钮：复制图片（反馈三态，MermaidBlock CopyButton 同款） */
function VizCopyButton({ doCopy }: { doCopy: () => Promise<boolean> }) {
  const { t } = useTranslation()
  const { state, showResult } = useCopyFeedback(COPY_DONE_MS)
  return (
    <button
      className={`viz-tool-btn viz-copy-${state}`}
      onClick={() => showResult(doCopy)}
      title={state === 'ok' ? t('chat.viz.copied') : state === 'fail' ? t('chat.viz.copyFailed') : t('chat.viz.copyImage')}
    >
      <span
        className={
          state === 'ok' ? 'codicon codicon-check' : state === 'fail' ? 'codicon codicon-error' : 'codicon codicon-copy'
        }
      />
    </button>
  )
}

/** 沙箱属性：不给 allow-same-origin——AI 生成的可视化内容与 webview 主页面保持隔离 */
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'

export function VisualizeBlock({ directive }: Props) {
  const { t } = useTranslation()
  const [theme, setTheme] = useState<'dark' | 'light'>(() => currentTheme())
  // srcdoc 内容（唯一渲染形态；url 模式经 fetch 取得，singlefile 降级直接回 html）
  const [html, setHtml] = useState<string | null>(null)
  // vizOpen 原始 url（singlefile 降级为空；「在浏览器打开」按钮仅 url 模式可用）
  const [vizUrl, setVizUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // 子页文档高
  const [height, setHeight] = useState(LOADING_HEIGHT)
  const [loaded, setLoaded] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // 打开：vizOpen 换 url/html → fetch 成 srcdoc 内容（无 frame 导航请求）
  useEffect(() => {
    let cancelled = false
    setHtml(null)
    setVizUrl(null)
    setFailed(null)
    setLoaded(false)
    setHeight(LOADING_HEIGHT)
    requestVizOpen(directive.path, currentTheme())
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          setFailed(res.error || 'unknown')
          return
        }
        setVizUrl(res.url ?? null)
        if (res.html) {
          setHtml(res.html)
          return
        }
        if (!res.url) {
          setFailed('unknown')
          return
        }
        try {
          const r = await fetch(res.url)
          if (cancelled) return
          if (!r.ok) {
            setFailed(`HTTP ${r.status}`)
            return
          }
          const text = await r.text()
          if (!cancelled) setHtml(text)
        } catch (e) {
          if (!cancelled) setFailed(e instanceof Error ? e.message : 'fetch')
        }
      })
      .catch(() => {
        if (!cancelled) setFailed('bridge')
      })
    return () => {
      cancelled = true
    }
  }, [directive.path])

  // 子页消息：resize 高度自适应 / open-external 外链转发（校验来源是本组件 iframe）
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const data = ev.data as { source?: string; type?: string; height?: number; href?: string } | null
      if (!data || data.source !== 'zcode-viz') return
      if (ev.source !== iframeRef.current?.contentWindow) return
      if (data.type === 'resize' && typeof data.height === 'number') {
        setLoaded(true)
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(data.height))))
      } else if (data.type === 'open-external' && typeof data.href === 'string') {
        openExternalUrl(data.href)
      }
      // follow-up：官方宿主的追问通道，v1 不接线
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // 主题跟随 html[data-theme] → 推给子页（iframe onLoad 后再推一次，覆盖加载窗口期错过的事件）
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(currentTheme()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  const pushTheme = useCallback(
    (th: 'dark' | 'light') => {
      const win = iframeRef.current?.contentWindow
      if (!win) return
      try {
        win.postMessage({ source: 'zcode-viz-host', type: 'theme', theme: th }, '*')
      } catch {
        // postMessage 是沙箱下唯一通道，不会抛；防御性吞掉
      }
    },
    [],
  )

  useEffect(() => {
    pushTheme(theme)
  }, [theme, html, loaded, pushTheme])

  // 复制图片：主卡 iframe 屏幕截取
  const doCopyImage = useCallback((): Promise<boolean> => copyVizImageViaJava(iframeRef.current), [])

  if (failed) {
    return (
      <div className="viz-block viz-block--error" role="figure" aria-label={directive.title || t('chat.viz.title')}>
        <div className="viz-block__error">
          <span className="codicon codicon-error" aria-hidden="true" />
          <span>{failed === 'timeout' ? t('chat.viz.timeout') : t('chat.viz.loadFailed')}</span>
          <code>{directive.path}</code>
        </div>
      </div>
    )
  }

  const ariaLabel = directive.title || t('chat.viz.title')
  return (
    <div className="viz-block" role="figure" aria-label={ariaLabel}>
      <div className="viz-block__body" style={{ height }}>
        {!html && (
          <div className="viz-block__loading">
            <span className="viz-block__spinner" aria-hidden="true" />
            <span>{t('chat.viz.loading')}</span>
          </div>
        )}
        {html && (
          <iframe
            ref={iframeRef}
            srcDoc={html}
            title={ariaLabel}
            sandbox={SANDBOX}
            onLoad={() => {
              pushTheme(theme)
              window.setTimeout(() => setLoaded(true), LOADED_FALLBACK_MS)
            }}
          />
        )}
      </div>
      <div className="viz-block__toolbar">
        <VizCopyButton doCopy={doCopyImage} />
        {/* singlefile 降级（内置 server 未启动）无 URL，浏览器打开不可用 → 不显示 */}
        {vizUrl && (
          <button
            className="viz-tool-btn"
            onClick={() => openExternalUrl(vizUrl)}
            title={t('chat.viz.openInBrowser')}
          >
            {/* globe（网页工具卡同款）：codicon 无 external-link 字形，用错名会渲染空白 */}
            <span className="codicon codicon-globe" />
          </button>
        )}
      </div>
    </div>
  )
}
