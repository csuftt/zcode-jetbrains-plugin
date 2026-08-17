/**
 * 粘贴文本 chip（长文本粘贴折叠，类附件）
 *
 * 粘贴超过阈值（≥10 行或 ≥500 字符，见 InputBox PASTE_* 常量）的文本时，
 * 不进输入框正文（撑爆编辑区影响阅读），而是折叠为顶部 chips 区的一个块：
 *   [📝 粘贴文本 · 1234 字]  ✕
 * 点击 chip 弹预览 modal（全文 + 字符数），✕ 移除（内容不再发送）。
 * 发送时由 InputBox 把各段原文拼到正文末尾（CLI 收到完整文本）。
 *
 * 中性灰色调，区别于文件引用（蓝）/技能（紫）。
 */

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import '../styles/pasted-text-ref.less'

export interface PastedTextItem {
  id: string
  text: string
  chars: number
}

interface Props {
  item: PastedTextItem
  onPreview: () => void
  onRemove: () => void
}

function PastedTextRefInner({ item, onPreview, onRemove }: Props) {
  const { t } = useTranslation()
  return (
    <span
      className="pasted-text-ref"
      data-tip={t('input.pasted.clickToPreview')}
      onClick={(e) => {
        e.stopPropagation()
        onPreview()
      }}
    >
      <span className="codicon codicon-note pasted-text-ref__icon" />
      <span className="pasted-text-ref__name">{t('input.pasted.label', { count: item.chars })}</span>
      <button
        className="pasted-text-ref__remove"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        title={t('input.pasted.remove')}
        type="button"
      >
        ✕
      </button>
    </span>
  )
}

export const PastedTextRef = memo(PastedTextRefInner)

/** 预览弹窗（复用全局 .modal-overlay/.modal-content；Escape 在 InputBox 全局监听关闭）*/
export function PastedTextPreview({ item, onClose }: { item: PastedTextItem; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-content pasted-text-preview"
        role="dialog"
        aria-label={t('input.pasted.previewAriaLabel')}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t('input.pasted.previewTitle', { count: item.chars })}</h3>
        <pre className="pasted-text-preview__body">{item.text}</pre>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-primary" onClick={onClose} type="button">
            {t('input.pasted.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
