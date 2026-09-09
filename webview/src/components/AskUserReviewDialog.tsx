/**
 * AskUserQuestion 回看弹窗（只读）
 *
 * 入口：消息流里「询问用户」工具卡点击。复用实时提问弹窗（AskUserDialog）的
 * ask-user-dialog 样式回看历史：多问题按实时弹窗同款翻页（第 X/Y 题 + 上一题/
 * 下一题），已选选项高亮（与实时一致不再放 ✓ 图标），自定义答案以「其他」块
 * 展示；拒绝/异常回执原文兜底展示在末页。
 *
 * 与实时弹窗的差异：无倒计时/无取消确认语义（末页按钮=关闭）/遮罩可点关
 * （只读无误触风险——实时弹窗当年禁遮罩是防双击提交误触）。数据为打开瞬间的
 * 快照（store 传值）。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { matchAnswerToOptions } from '@/utils/askUserAnswer'
import '../styles/ask-user-dialog.less'

export function AskUserReviewDialog() {
  const { t } = useTranslation()
  const review = useStore((s) => s.askUserReview)
  const closeAskUserReview = useStore((s) => s.closeAskUserReview)
  // 翻页态；重开另一张卡（review 换引用）时回到第一页
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    setCurrent(0)
  }, [review])

  useEffect(() => {
    if (!review) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAskUserReview()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [review, closeAskUserReview])

  if (!review) return null
  const { questions, answers, recognized, raw } = review
  const idx = Math.max(0, Math.min(current, questions.length - 1))
  const q = questions[idx]
  const isLast = idx >= questions.length - 1

  const answer = q ? answers[q.question] : undefined
  const { matched, extra } = answer !== undefined && q
    ? matchAnswerToOptions(answer, q.options ?? [])
    : { matched: [], extra: null }
  const answered = matched.length > 0 || !!extra

  return (
    <div className="ask-user-overlay" onClick={closeAskUserReview}>
      <div className="ask-user-dialog ask-user-dialog--review" onClick={(e) => e.stopPropagation()}>
        <div className="ask-user-dialog__header">
          <span className="codicon codicon-question ask-user-dialog__icon" />
          <span className="ask-user-dialog__title">{t('tool.askUserReview.title')}</span>
          {questions.length > 1 && (
            <span className="ask-user-dialog__progress">
              {t('app.askUser.progress', { current: idx + 1, total: questions.length })}
            </span>
          )}
          <button
            type="button"
            className="ask-user-dialog__close"
            aria-label={t('tool.askUserReview.close')}
            onClick={closeAskUserReview}
          >
            <span className="codicon codicon-chrome-close" />
          </button>
        </div>

        <div className="ask-user-dialog__body">
          {q && (
            <div className="ask-user-dialog__question">
              {q.header && <div className="ask-user-dialog__q-header">{q.header}</div>}
              <div className="ask-user-dialog__q-text">{q.question}</div>
              {q.multiSelect && (
                <div className="ask-user-dialog__multiselect-hint">{t('app.askUser.multiSelect')}</div>
              )}
              <div className="ask-user-dialog__options">
                {(q.options ?? []).map((opt, oIdx) => {
                  const selected = matched.includes(opt.label)
                  return (
                    <div
                      key={oIdx}
                      className={`ask-user-dialog__option${selected ? ' active' : ''}`}
                    >
                      <span className="ask-user-dialog__opt-label">{opt.label}</span>
                      {opt.description && (
                        <span className="ask-user-dialog__opt-desc">{opt.description}</span>
                      )}
                    </div>
                  )
                })}
                {/* 自定义答案（「其他」）：不匹配任何选项的剩余文本 */}
                {extra && (
                  <div className="ask-user-dialog__option ask-user-dialog__option--other active">
                    <span className="ask-user-dialog__opt-label">{t('tool.askUserReview.customAnswer')}</span>
                    <span className="ask-user-dialog__opt-desc">{extra}</span>
                  </div>
                )}
              </div>
              {/* 未回答标注：仅服务端回执确认跳过时显示。实时刚答完但轮末重拉
                  未到（output 未落库/recognized=false）时不下结论，防误标 */}
              {!answered && recognized && (
                <div className="ask-user-dialog__notanswered">{t('tool.askUserReview.notAnswered')}</div>
              )}
            </div>
          )}
          {/* 拒绝/异常路径：识别不出答案，原文回执兜底（末页展示，问题为空时独占） */}
          {raw && !recognized && (isLast || !q) && (
            <div className="ask-user-dialog__receipt">
              <div className="ask-user-dialog__receipt-label">{t('tool.askUserReview.receipt')}</div>
              <pre className="ask-user-dialog__receipt-text">{raw.slice(0, 400)}</pre>
            </div>
          )}
        </div>

        <div className="ask-user-dialog__footer">
          {idx > 0 && (
            <button
              type="button"
              className="ask-user-dialog__btn ask-user-dialog__btn--back"
              onClick={() => setCurrent(idx - 1)}
            >
              {t('app.askUser.back')}
            </button>
          )}
          <button
            type="button"
            className="ask-user-dialog__btn ask-user-dialog__btn--submit"
            onClick={isLast ? closeAskUserReview : () => setCurrent(idx + 1)}
          >
            {isLast ? t('tool.askUserReview.close') : t('app.askUser.next')}
          </button>
        </div>
      </div>
    </div>
  )
}
