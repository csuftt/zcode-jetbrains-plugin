/**
 * 剪贴板工具
 *
 * navigator.clipboard 优先（内置 server 走 localhost，属 secure context，API 可用）；
 * 不可用/被拒时降级 document.execCommand('copy'）（隐藏 textarea 方案）。
 */

import { useEffect, useRef, useState } from 'react'

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* 权限拒绝或 CEF 实现异常，走降级 */
    }
  }
  return copyViaExecCommand(text)
}

/**
 * 复制带图用户消息：text/plain + image/png（首图）一次写入——外部应用粘贴也能
 * 图+文一起出。系统剪贴板图片槽只装得下一张，多图的完整还原靠
 * copiedMessageClipboard 网页内备份（粘贴侧按文本命中取回）。
 * clipboard.write 不可用/被拒（JCEF 版本差异）→ 降级纯文本（原行为，不劣化）。
 */
export async function copyTextWithImages(text: string, imageSrcs: string[]): Promise<boolean> {
  const src = imageSrcs[0]
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined' || !src) {
    return copyText(text)
  }
  try {
    const png = await toPngBlob(src)
    if (!png) return copyText(text)
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'image/png': png,
      }),
    ])
    return true
  } catch {
    /* write 失败（权限/实现差异）：降级纯文本，图片还原靠网页内备份通道 */
    return copyText(text)
  }
}

/**
 * 图片 src（data URL / 内置 server 同源 http URL）→ PNG blob。
 * 已是 png 直取；jpeg/webp 等 canvas 重编码（Chromium 剪贴板 image 槽只认 png）。
 */
async function toPngBlob(src: string): Promise<Blob | null> {
  try {
    const blob = await (await fetch(src)).blob()
    if (blob.type === 'image/png') return blob
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('image decode failed'))
      el.src = src
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0)
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  } catch {
    return null
  }
}

function copyViaExecCommand(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  // fixed + 透明：不触发页面滚动、不产生视觉闪烁
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  return ok
}

/**
 * 复制反馈状态机（MermaidBlock 工具栏 / StarSupportSection 共享形状）：
 * showResult(复制动作) → 三态 ok/fail → durationMs 后回弹 idle（定时器含卸载清理）。
 * 展示层（图标/文案）由调用方按 state 自定。
 */
export function useCopyFeedback(durationMs = 1500) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timerRef = useRef(0)
  useEffect(() => () => window.clearTimeout(timerRef.current), [])
  const showResult = async (doCopy: () => Promise<boolean>) => {
    const ok = await doCopy()
    setState(ok ? 'ok' : 'fail')
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setState('idle'), durationMs)
  }
  return { state, showResult }
}
