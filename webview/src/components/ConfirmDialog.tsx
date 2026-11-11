/**
 * 通用二次确认弹窗
 *
 * 壳复用全局 .modal-overlay/.modal-content/.modal-actions/.modal-btn* 样式
 * （定义在 history-view.less，pasted-text-ref.less 已同样跨文件复用）。
 * 点遮罩 = 取消；danger 时确认按钮红色（删除类），否则主题色（切换/新建类）。
 */

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  title: string
  /** 正文（可传 string / JSX）*/
  message: ReactNode
  /** 确认按钮文案（缺省取 common.confirm.ok）*/
  confirmText?: string
  /** 取消按钮文案（缺省取 common.confirm.cancel）*/
  cancelText?: string
  /** 第三选项按钮文案（如「新标签页打开」）：渲染在取消与确认之间，中性样式 */
  extraText?: string
  /** 危险操作（确认按钮红色）*/
  danger?: boolean
  /** 纯提示模式：不渲染取消按钮（信息提醒弹窗，确认即关闭）*/
  cancelable?: boolean
  /** 顶部锚定（Header 工具排按钮触发的确认弹窗）：贴顶栏下方渲染，缩短与触发按钮的距离 */
  topAligned?: boolean
  onConfirm: () => void
  onExtra?: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmText,
  cancelText,
  extraText,
  danger = false,
  cancelable = true,
  topAligned = false,
  onConfirm,
  onExtra,
  onCancel,
}: Props) {
  const { t } = useTranslation()
  return (
    <div
      className={`modal-overlay${topAligned ? ' modal-overlay--top' : ''}`}
      onClick={cancelable ? onCancel : onConfirm}
      role="presentation"
    >
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="modal-actions">
          {cancelable && (
            <button className="modal-btn modal-btn-cancel" onClick={onCancel}>
              {cancelText ?? t('common.confirm.cancel')}
            </button>
          )}
          {extraText && onExtra && (
            <button className="modal-btn modal-btn-cancel" onClick={onExtra}>
              {extraText}
            </button>
          )}
          <button
            className={`modal-btn ${danger ? 'modal-btn-danger' : 'modal-btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmText ?? t('common.confirm.ok')}
          </button>
        </div>
      </div>
    </div>
  )
}
