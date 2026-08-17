/**
 * 文件引用 chip（@文件 / @文件夹）
 *
 * 文件类型 SVG 图标 + 文件名，可删除。
 * 文件夹路径末尾带 /（SendFileToInputAction 标记），据此切换文件夹图标。
 * 支持行号引用显示：`path#L10-20` → basename + 灰色 `:L10-20` 后缀。
 * tooltip 用 CSS ::after（JCEF 原生 title 经常不显示）。
 *
 * 同款视觉的内联变体（.file-ref--inline）用于 contenteditable 输入框内，
 * 由 InputBox 的 buildFileChipHTML 以纯 DOM 生成（React 不管编辑器内部）。
 */

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n/config'
import { FileIcon } from './FileIcon'
import '../styles/file-ref.less'

interface Props {
  path: string
  onRemove: () => void
}

/** 从引用拆出文件路径和行号（@path#L10-20 → { file, lines }）*/
export function splitReference(path: string): { file: string; lines: string | null } {
  const m = path.match(/^(.*?)#L(\d+(?:-\d+)?)$/)
  if (m) return { file: m[1], lines: `L${m[2]}` }
  return { file: path, lines: null }
}

/** 是否为文件夹（SendFileToInputAction 给文件夹路径末尾加了 /）*/
export function isDirectory(path: string): boolean {
  return /[\\/]$/.test(path)
}

/** 从路径提取文件名（去掉末尾分隔符后取 basename）*/
export function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const parts = clean.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || clean || path
}

/** tooltip 友好格式（内联/顶部 chip 共用；非 React 上下文也调用，走 i18n 实例而非 hook）*/
export function refTooltip(path: string): string {
  const { file, lines } = splitReference(path)
  return lines
    ? `${file.replace(/[\\/]+$/, '')}${i18n.t('input.fileRef.lines', { lines: lines.replace('L', '').replace('-', '–') })}`
    : file.replace(/[\\/]+$/, '')
}

function FileRefInner({ path, onRemove }: Props) {
  const { t } = useTranslation()
  const { file, lines } = splitReference(path)
  const displayName = basename(file)
  return (
    <span className="file-ref" data-tip={refTooltip(path)}>
      <FileIcon path={file} className="file-ref__icon file-type-icon" />
      <span className="file-ref__name">{displayName}</span>
      {lines && <span className="file-ref__lines">:{lines}</span>}
      <button
        className="file-ref__remove"
        onClick={onRemove}
        title={t('input.fileRef.remove')}
        type="button"
      >
        ✕
      </button>
    </span>
  )
}

export const FileRef = memo(FileRefInner)
