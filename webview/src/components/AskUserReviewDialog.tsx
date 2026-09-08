/**
 * AskUserQuestion 回看弹窗（只读）
 *
 * 入口：消息流里「询问用户」工具卡点击。复用实时提问弹窗（AskUserDialog）的
 * ask-user-dialog 样式回看历史：全部问题平铺（滚动），已选选项高亮 + ✓，
 * 自定义答案以「其他」块展示；拒绝/异常回执原文兜底展示。
 *
 * 与实时弹窗的差异：无倒计时/无导航按钮/遮罩可点关（只读无误触风险——实时弹窗
 * 当年禁遮罩是防双击提交误触）。数据为打开瞬间的快照（store 传值）。
 */

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { matchAnswerToOptions } from '@/utils/askUserAnswer'
import '../styles/ask-user-dialog.less'

export function AskUserReviewDialog() {
  const { t } = useTranslation()
  const review = useStore((s) => s.askUserReview)
  const closeAskUserReview = useStore((s) => s.closeAskUserReview)

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
  return (
    <div className="ask-user-overlay" onClick={closeAskUserReview}>
      <div className="ask-user-dialog ask-user-dialog--review" onClick={(e) => e.stopPropagation()}>
        <div className="ask-user-dialog__header">
          <span className="ask-user-dialog__icon">❓</span>
          <span className="ask-user-dialog__title">{t('tool.askUserReview.title')}</span>
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
          {questions.map((q, qIdx) => {
            const answer = answers[q.question]
            const { matched, extra } = answer !== undefined
              ? matchAnswerToOptions(answer, q.options ?? [])
              : { matched: [], extra: null }
            const answered = matched.length > 0 || !!extra
            return (
              <div className="ask-user-dialog__question" key={qIdx}>
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
                        {selected && <span className="codicon codicon-check ask-user-dialog__opt-check" />}
                        <span className="ask-user-dialog__opt-body">
                          <span className="ask-user-dialog__opt-label">{opt.label}</span>
                          {opt.description && (
                            <span className="ask-user-dialog__opt-desc">{opt.description}</span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                  {/* 自定义答案（「其他」）：不匹配任何选项的剩余文本 */}
                  {extra && (
                    <div className="ask-user-dialog__option ask-user-dialog__option--other active">
                      <span className="codicon codicon-check ask-user-dialog__opt-check" />
                      <span className="ask-user-dialog__opt-body">
                        <span className="ask-user-dialog__opt-label">{t('tool.askUserReview.customAnswer')}</span>
                        <span className="ask-user-dialog__opt-desc">{extra}</span>
                      </span>
                    </div>
                  )}
                </div>
                {/* 未回答标注：仅服务端回执确认跳过时显示。实时刚答完但轮末重拉
                    未到（output 未落库/recognized=false）时不下结论，防误标 */}
                {!answered && recognized && (
                  <div className="ask-user-dialog__notanswered">{t('tool.askUserReview.notAnswered')}</div>
                )}
              </div>
            )
          })}
          {/* 拒绝/异常路径：识别不出答案，原文回执兜底 */}
          {raw && !recognized && (
            <div className="ask-user-dialog__receipt">
              <div className="ask-user-dialog__receipt-label">{t('tool.askUserReview.receipt')}</div>
              <pre className="ask-user-dialog__receipt-text">{raw.slice(0, 400)}</pre>
            </div>
          )}
        </div>

        <div className="ask-user-dialog__footer">
          <button
            type="button"
            className="ask-user-dialog__btn ask-user-dialog__btn--submit"
            onClick={closeAskUserReview}
          >
            {t('tool.askUserReview.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
