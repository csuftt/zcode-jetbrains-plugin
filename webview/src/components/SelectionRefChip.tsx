/**
 * 划词引用条 pill（调研 ⑩，官方 WR/KO 组件的插件版）：
 * 图标 + 「N 条对话引用」+ hover 显影的"移除全部"圆钮；点开 popover 逐条列
 * （正文 line-clamp-3 预览 + 脚注 类型 · #rowId + hover 显影的单条移除钮）。
 * 同款 pill 体系在官方还被 codeComments/webElements/pptxElements 复用——
 * 插件只做 conversation selections 一种引用源。
 *
 * 两态复用：输入框引用条传 onRemove/onClear（完整可管理）；发送后用户气泡的
 * 回读卡（MessageBubble）不传回调=只读态——序列化只保留 {text}，无来源行元
 * 数据可显示、更无移除语义，pill 点击看原文是唯一交互。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SelectionContentType } from '@/utils/conversationSelections'

/** 引用条目：完整引用（输入框）与回读引用（消息卡只回读出 text）的最小公共面 */
export interface SelectionRefItem {
  id?: string
  text: string
  contentType?: SelectionContentType
  rowId?: string
}

export function SelectionRefChip({
  selections,
  onRemove,
  onClear,
}: {
  selections: SelectionRefItem[]
  /** 不传=只读态（消息回读卡）：无移除全部钮 */
  onClear?: () => void
  /** 不传=只读态：无单条移除钮与来源脚注 */
  onRemove?: (id: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // 弹层方向自适应（打开瞬间按 pill 视口位置定，开合逻辑不放进 setState updater）：
  // - 纵向：pill 在视口下部（剩余空间装不下 ~270px 的 popover）且上方足够时朝上弹。
  //   输入框引用条恒在最底部 → 向下（现状不变）；消息里的引用 pill 常在滚动底部。
  // - 横向：右侧放不下 320px 弹层 → 右缘对齐 pill 右缘向左展开。消息里 pill 右对齐
  //   （气泡同侧），left:0 向右展开必伸出 webview 右缘（真机 2026-11-11 截图实锤）。
  const [up, setUp] = useState(false)
  const [alignRight, setAlignRight] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  const togglePop = () => {
    const next = !open
    if (next && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect()
      setUp(r.bottom + 270 > window.innerHeight && r.top > 270)
      setAlignRight(r.right + 326 > window.innerWidth) // 320 弹层 + 6px 间隙
    }
    setOpen(next)
  }

  // 点击外部收起 popover（避免吃全局 blur 逻辑，mousedown 捕获即可）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <span className="convsel-chip" ref={rootRef} data-selection-reference-count={selections.length}>
      <button
        type="button"
        className={`convsel-chip__main${open ? ' convsel-chip__main--open' : ''}`}
        onClick={togglePop}
        title={t('chat.selections.count', { count: selections.length })}
      >
        <span className="codicon codicon-quote" />
        <span className="convsel-chip__count">{t('chat.selections.count', { count: selections.length })}</span>
        <span className={`codicon codicon-chevron-${open ? 'up' : 'down'} convsel-chip__caret`} />
      </button>
      {/* hover 显影的移除全部圆钮（官方同款交互；只读态不渲染） */}
      {onClear && (
        <button
          type="button"
          className="convsel-chip__clear"
          onClick={() => {
            setOpen(false)
            onClear()
          }}
          title={t('chat.selections.remove')}
          aria-label={t('chat.selections.remove')}
        >
          ✕
        </button>
      )}
      {open && (
        <div className={`convsel-pop${up ? ' convsel-pop--up' : ''}${alignRight ? ' convsel-pop--right' : ''}`} role="dialog">
          <div className="convsel-pop__list">
            {selections.map((s, i) => {
              const meta = [
                s.contentType ? t(`chat.selections.type.${s.contentType}`) : '',
                s.rowId ? `#${s.rowId}` : '',
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <div key={s.id ?? i} className="convsel-pop__item">
                  <div className="convsel-pop__text">{s.text}</div>
                  {(meta || onRemove) && (
                    <div className="convsel-pop__foot">
                      {meta && <span className="convsel-pop__meta">{meta}</span>}
                      {onRemove && s.id && (
                        <button
                          type="button"
                          className="convsel-pop__remove"
                          onClick={() => onRemove(s.id!)}
                          title={t('chat.selections.removeOne')}
                          aria-label={t('chat.selections.removeOne')}
                        >
                          <span className="codicon codicon-close" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </span>
  )
}
