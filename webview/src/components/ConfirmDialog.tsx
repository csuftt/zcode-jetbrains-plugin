/**
 * 通用二次确认弹窗
 *
 * 壳复用全局 .modal-overlay/.modal-content/.modal-actions/.modal-btn* 样式
 * （定义在 history-view.less，pasted-text-ref.less 已同样跨文件复用）。
 * 点遮罩 = 取消；danger 时确认按钮红色（删除类），否则主题色（切换/新建类）。
 */

import type { ReactNode } from 'react'

interface Props {
  title: string
  /** 正文（可传 string / JSX）*/
  message: ReactNode
  confirmText?: string
  cancelText?: string
  /** 危险操作（确认按钮红色）*/
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div className="modal-overlay" onClick={onCancel} role="presentation">
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            className={`modal-btn ${danger ? 'modal-btn-danger' : 'modal-btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
