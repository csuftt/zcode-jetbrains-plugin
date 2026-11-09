/**
 * Markdown 注入 HTML 的链接点击接管（事件委托共用）：
 *   - .md-file-link 文件路径链接 → openFile op（IDE 打开并跳行，命中即短路）
 *   - 其余 <a href> → preventDefault + openExternalUrl（协议白名单 + Java 侧二次校验）
 *
 * 为什么必须接管：renderMarkdown / renderInline 产出 <a target=_blank>，JCEF
 * 没挂 onBeforePopup 拦截层，原生点击会把 webview 顶帧导航走——目标不可达
 * （内网地址）时整页空白，React 应用直接被换掉（缺陷 GW：ThinkingBlock /
 * ChangelogDialog 漏挂委托，2026-11-09 用户点思考块链接白屏实证）。
 *
 * 返回 true = 命中并已处理（调用方不再走其它点击分支）。
 */

import type { MouseEvent } from 'react'
import { openExternalUrl } from '@/ipc/bridge'
import { openFileLinkFromEvent } from './fileLink'

export function handleMarkdownLinkClick(e: MouseEvent<HTMLElement>): boolean {
  if (openFileLinkFromEvent(e)) return true
  const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]')
  if (!anchor) return false
  e.preventDefault()
  const href = anchor.getAttribute('href') || ''
  if (href) openExternalUrl(href)
  return true
}
