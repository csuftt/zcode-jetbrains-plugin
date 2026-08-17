/**
 * AskUserQuestion 弹窗
 *
 * 当 LLM 调用 AskUserQuestion 工具时，服务器通过 interaction/requestUserInput
 * 反向请求询问用户。Java 端收到后推 {op:"askUser"} 给前端，此组件显示弹窗。
 *
 * 用户选择后，通过 sendToJava({op:"askUserResponse"}) 回传给 Java，
 * Java 应答服务器的反向请求。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AskUserQuestion } from '@/types/messages'
import { sendToJava } from '@/ipc/bridge'
import '../styles/ask-user-dialog.less'

interface Props {
  requestId: string
  toolName: string
  questions: AskUserQuestion[]
  onClose: () => void
}

export function AskUserDialog({ requestId, toolName, questions, onClose }: Props) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Record<number, string>>({})

  const handleSelect = (qIdx: number, label: string) => {
    setSelected((prev) => ({ ...prev, [qIdx]: label }))
  }

  const handleSubmit = () => {
    // 取第一个问题的选择（AskUserQuestion 通常只有一个问题）
    const answer = selected[0]
    sendToJava({
      op: 'askUserResponse',
      requestId,
      action: 'accept',
      answer: answer || '',
    })
    onClose()
  }

  const handleDecline = () => {
    sendToJava({
      op: 'askUserResponse',
      requestId,
      action: 'decline',
    })
    onClose()
  }

  const allAnswered = questions.every((_, i) => selected[i])

  return (
    <div className="ask-user-overlay" onClick={handleDecline}>
      <div className="ask-user-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ask-user-dialog__header">
          <span className="ask-user-dialog__icon">❓</span>
          <span className="ask-user-dialog__title">{toolName}</span>
        </div>

        <div className="ask-user-dialog__body">
          {questions.map((q, qIdx) => (
            <div key={qIdx} className="ask-user-dialog__question">
              {q.header && <div className="ask-user-dialog__q-header">{q.header}</div>}
              <div className="ask-user-dialog__q-text">{q.question}</div>
              <div className="ask-user-dialog__options">
                {q.options.map((opt, oIdx) => (
                  <button
                    key={oIdx}
                    className={`ask-user-dialog__option ${selected[qIdx] === opt.label ? 'active' : ''}`}
                    onClick={() => handleSelect(qIdx, opt.label)}
                  >
                    <span className="ask-user-dialog__opt-label">{opt.label}</span>
                    {opt.description && (
                      <span className="ask-user-dialog__opt-desc">{opt.description}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="ask-user-dialog__footer">
          <button className="ask-user-dialog__btn ask-user-dialog__btn--cancel" onClick={handleDecline}>
            {t('app.askUser.cancel')}
          </button>
          <button
            className="ask-user-dialog__btn ask-user-dialog__btn--submit"
            onClick={handleSubmit}
            disabled={!allAnswered}
          >
            {t('app.askUser.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
