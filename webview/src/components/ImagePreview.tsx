/**
 * 图片大图预览 overlay（cc-gui image-preview-overlay 同款）
 *
 * 输入框附件缩略图与消息区图片点击共用：portal 挂 body（脱离
 * messages-container / input-area 的 overflow 裁剪），Esc 或点遮罩关闭。
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import '../styles/input-box.less'

export function ImagePreview({
  src,
  title,
  onClose,
}: {
  src: string
  title?: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="image-preview-overlay" role="presentation" onClick={onClose}>
      <div
        className="image-preview-content"
        role="dialog"
        aria-label={title ?? 'image preview'}
        onClick={(e) => e.stopPropagation()}
      >
        <img src={src} alt={title ?? ''} />
        {title && <div className="image-preview-title">{title}</div>}
      </div>
    </div>,
    document.body,
  )
}
