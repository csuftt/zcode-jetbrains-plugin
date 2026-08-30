/**
 * 文件类型图标组件（SVG 内联渲染，对齐 cc-gui StatusPanel/FileIcon）
 *
 * SVG 来自 utils/fileIcons.ts 的预定义映射（内部可信来源），
 * dangerouslySetInnerHTML 仅渲染常量表内容，不涉及用户输入。
 * 文件夹路径（末尾带分隔符）渲染文件夹图标。
 */

import { memo, useMemo } from 'react'
import { getFileIcon, getFolderIcon } from '@/utils/fileIcons'
import '../styles/global.less'

interface Props {
  /** 文件或文件夹路径（文件夹末尾带 / 或 \）*/
  path: string
  className?: string
}

function FileIconInner({ path, className = 'file-type-icon' }: Props) {
  const svg = useMemo(() => (/[\\/]$/.test(path) ? getFolderIcon() : getFileIcon(path)), [path])
  return <span className={className} dangerouslySetInnerHTML={{ __html: svg }} aria-hidden="true" />
}

export const FileIcon = memo(FileIconInner)
