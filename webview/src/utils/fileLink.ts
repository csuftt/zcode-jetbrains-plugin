/**
 * .md-file-link 点击 → openFile op（MarkdownBlock / ThinkingBlock 事件委托共用）。
 *
 * 通道与 ToolCallCard/FileToolGroupCard 同款（Kotlin handleOpenFile 零改动）：
 * filePath 必传（linkifyFilePaths 已解析成绝对路径），line 有则带（1 基，
 * Kotlin 侧超界自动 clamp）。
 *
 * 返回 true = 命中并已处理（调用方不再走其它点击分支）。
 */

import type { MouseEvent } from 'react'
import { sendToJava } from '@/ipc/bridge'
import { getPreviewFileKind } from '@/utils/previewArtifacts'

export function openFileLinkFromEvent(e: MouseEvent<HTMLElement>): boolean {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('.md-file-link')
  if (!el) return false
  e.preventDefault()
  const filePath = el.dataset.filePath
  if (!filePath) return true
  // 音视频路径（0.4.6）：IDE 编辑器打不开，改走系统默认程序（与产物卡同路由；
  // Java 侧无关联应用时降级为资源管理器定位并提示，不再静默）
  const kind = getPreviewFileKind(filePath)
  if (kind === 'video' || kind === 'audio') {
    sendToJava({ op: 'openFileSystem', filePath })
    return true
  }
  const line = Number(el.dataset.fileLine)
  sendToJava(line > 0 ? { op: 'openFile', filePath, line } : { op: 'openFile', filePath })
  return true
}
