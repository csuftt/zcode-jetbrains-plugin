/**
 * 通用 Markdown 预览弹窗（工具卡输出全文阅读）
 *
 * 入口：工具卡头部按钮（如 Skill 技能加载卡的 📖 按钮、网页工具卡的 📖 按钮）。
 * 内容为打开时从工具 part.state.output 取的快照。与子代理详情弹窗分层叠开
 * （2026-09-02 起，见 store openMarkdownPreview）：从详情里开预览，关预览后
 * 详情仍在。复用子代理弹窗的 overlay/dialog 样式结构。
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { MarkdownBlock } from './MarkdownBlock'
import { ScrollJumpButton } from './ScrollJumpButton'
import '../styles/subagent-detail.less'

export function MarkdownPreviewDialog() {
  const { t } = useTranslation()
  const preview = useStore((s) => s.markdownPreview)
  const closeMarkdownPreview = useStore((s) => s.closeMarkdownPreview)
  // 叠在详情弹窗之上时遮罩透明（下层已有遮罩；z-index 同层，本组件在 App
  // 中最后挂载，天然盖住详情/报告弹窗）
  const stacked = useStore((s) => !!s.subagentDetail)

  const bodyRef = useRef<HTMLDivElement>(null)

  // Escape 关闭（预览是最上层阅读弹窗，无让位对象）
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMarkdownPreview()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [preview, closeMarkdownPreview])

  if (!preview) return null

  return (
    <div className={`subagent-detail-overlay${stacked ? ' subagent-detail-overlay--stacked' : ''}`} onClick={closeMarkdownPreview}>
      <div className="subagent-detail-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="subagent-detail-header">
          <span className="codicon codicon-wand subagent-detail-header__icon" />
          <div className="subagent-detail-header__main">
            <span className="subagent-detail-header__title" title={preview.title}>
              {preview.title}
            </span>
            <div className="subagent-detail-header__meta">
              <span className="subagent-detail-meta-item">{preview.meta ?? t('chat.preview.defaultMeta')}</span>
            </div>
          </div>
          <button className="subagent-detail-icon-btn" data-tip={t('chat.preview.close')} onClick={closeMarkdownPreview}>
            <span className="codicon codicon-chrome-close" />
          </button>
        </div>
        <div className="subagent-detail-body subagent-report-body" ref={bodyRef}>
          <MarkdownBlock markdown={preview.markdown} />
        </div>
        {/* 滚动跳转按钮（↑置顶/↓置底，对齐主界面）：长文快速回顶/到底 */}
        <ScrollJumpButton containerRef={bodyRef} />
      </div>
    </div>
  )
}
