/**
 * AskUserQuestion 弹窗（逐问题模式，参考 cc-gui AskUserQuestionDialog）
 *
 * 当 LLM 调用 AskUserQuestion 工具时，服务器通过 interaction/requestUserInput
 * 反向请求询问用户。Java 端收到后推 {op:"askUser"} 给前端，此组件显示弹窗。
 *
 * 交互（2026-08-17 重构，修复多问题丢答案 bug——旧版平铺所有问题但 handleSubmit
 * 只回传 selected[0]，多问题答案全部丢失）：
 *   - 一次只显示一个问题，上一题/下一题导航 + 进度指示（n/N）
 *   - multiSelect 问题支持多选切换，单选问题点击即选中
 *   - 每题附「其他」选项 + 自定义输入框（选中后展开，提交时并入答案）
 *   - 提交组装 Record<问题, string|string[]>：单问题回传纯文本（兼容协议），
 *     多问题 JSON.stringify 整体回传（Kotlin completeUserInput 透传字符串）
 */

import { useMemo, useRef, useState } from 'react'
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

/** 「其他」选项内部标记（提交时滤掉并替换为自定义输入文本） */
const OTHER_MARKER = '__other__'
const MAX_CUSTOM_INPUT_LENGTH = 200

export function AskUserDialog({ requestId, toolName, questions, onClose }: Props) {
  const { t } = useTranslation()
  const [current, setCurrent] = useState(0)
  /** 问题文本 → 已选 option label 集合（含 OTHER_MARKER） */
  const [answers, setAnswers] = useState<Record<string, Set<string>>>({})
  /** 问题文本 → Other 自定义输入 */
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({})
  const customInputRef = useRef<HTMLInputElement>(null)

  const list = useMemo(() => questions, [questions])
  // questions 变化（服务端重试推送）时 current 可能越界，clamp 兜底（cc-gui 同款防御）
  const idx = Math.max(0, Math.min(current, list.length - 1))
  const q = list[idx]
  const isLast = idx === list.length - 1
  const selected = answers[q?.question ?? ''] ?? new Set<string>()
  const isOtherSelected = selected.has(OTHER_MARKER)
  const customText = customInputs[q?.question ?? ''] ?? ''

  const handleToggle = (label: string) => {
    if (!q) return
    setAnswers((prev) => {
      const set = new Set(prev[q.question] ?? [])
      if (q.multiSelect) {
        if (set.has(label)) set.delete(label)
        else set.add(label)
      } else {
        set.clear()
        set.add(label)
      }
      return { ...prev, [q.question]: set }
    })
    // 选中「其他」后聚焦输入框
    if (label === OTHER_MARKER) {
      setTimeout(() => customInputRef.current?.focus(), 0)
    }
  }

  const handleCustomChange = (v: string) => {
    if (!q) return
    setCustomInputs((prev) => ({ ...prev, [q.question]: v.slice(0, MAX_CUSTOM_INPUT_LENGTH) }))
  }

  const handleNext = () => {
    if (isLast) handleSubmitFinal()
    else setCurrent(idx + 1)
  }

  const handleBack = () => setCurrent(Math.max(0, idx - 1))

  /** 组装并回传全部答案 */
  const handleSubmitFinal = () => {
    if (!list.length) return
    const formatted: Record<string, string | string[]> = {}
    list.forEach((item) => {
      const set = answers[item.question] ?? new Set<string>()
      const labels = Array.from(set).filter((l) => l !== OTHER_MARKER)
      const text = (customInputs[item.question] ?? '').trim()
      if (set.has(OTHER_MARKER) && text) labels.push(text)
      if (!labels.length) return
      formatted[item.question] = item.multiSelect ? labels : labels[0]!
    })

    // 单问题保持纯文本（服务端按纯答案解析）；多问题整体 JSON（AI 侧可读结构）
    const answer =
      list.length === 1
        ? (Object.values(formatted)[0] as string | string[] | undefined)
        : JSON.stringify(formatted)

    sendToJava({
      op: 'askUserResponse',
      requestId,
      action: 'accept',
      answer: typeof answer === 'string' ? answer : JSON.stringify(answer),
    })
    onClose()
  }

  const handleDecline = () => {
    sendToJava({ op: 'askUserResponse', requestId, action: 'decline' })
    onClose()
  }

  // 可继续条件：有常规选择，或「其他」已输入非空文本
  const hasRegular = Array.from(selected).some((l) => l !== OTHER_MARKER)
  const canProceed = hasRegular || (isOtherSelected && customText.trim().length > 0)

  if (!q) return null

  return (
    <div className="ask-user-overlay" onClick={handleDecline}>
      {/* title=源工具名（悬停可见，便于区分请求来源；标题本体走国际化）*/}
      <div className="ask-user-dialog" onClick={(e) => e.stopPropagation()} title={toolName}>
        <div className="ask-user-dialog__header">
          <span className="ask-user-dialog__icon">❓</span>
          <span className="ask-user-dialog__title">{t('app.askUser.title')}</span>
          {list.length > 1 && (
            <span className="ask-user-dialog__progress">
              {t('app.askUser.progress', { current: idx + 1, total: list.length })}
            </span>
          )}
        </div>

        <div className="ask-user-dialog__body">
          <div className="ask-user-dialog__question">
            {q.header && <div className="ask-user-dialog__q-header">{q.header}</div>}
            <div className="ask-user-dialog__q-text">{q.question}</div>
            {q.multiSelect && (
              <div className="ask-user-dialog__multiselect-hint">{t('app.askUser.multiSelect')}</div>
            )}
            <div className="ask-user-dialog__options">
              {q.options.map((opt, oIdx) => (
                <button
                  key={oIdx}
                  type="button"
                  className={`ask-user-dialog__option ${selected.has(opt.label) ? 'active' : ''}`}
                  onClick={() => handleToggle(opt.label)}
                >
                  {q.multiSelect && (
                    <span className={`codicon codicon-${selected.has(opt.label) ? 'check' : 'blank'}`} />
                  )}
                  <span className="ask-user-dialog__opt-label">{opt.label}</span>
                  {opt.description && (
                    <span className="ask-user-dialog__opt-desc">{opt.description}</span>
                  )}
                </button>
              ))}
              {/* 「其他」选项：允许自定义答案 */}
              <button
                type="button"
                className={`ask-user-dialog__option ask-user-dialog__option--other ${isOtherSelected ? 'active' : ''}`}
                onClick={() => handleToggle(OTHER_MARKER)}
              >
                {q.multiSelect && (
                  <span className={`codicon codicon-${isOtherSelected ? 'check' : 'blank'}`} />
                )}
                <span className="ask-user-dialog__opt-label">{t('app.askUser.other')}</span>
              </button>
            </div>
            {isOtherSelected && (
              <input
                ref={customInputRef}
                type="text"
                className="ask-user-dialog__custom-input"
                value={customText}
                onChange={(e) => handleCustomChange(e.target.value)}
                placeholder={t('app.askUser.otherPlaceholder')}
                maxLength={MAX_CUSTOM_INPUT_LENGTH}
              />
            )}
          </div>
        </div>

        <div className="ask-user-dialog__footer">
          <button className="ask-user-dialog__btn ask-user-dialog__btn--cancel" onClick={handleDecline}>
            {t('app.askUser.cancel')}
          </button>
          {idx > 0 && (
            <button className="ask-user-dialog__btn ask-user-dialog__btn--back" onClick={handleBack}>
              {t('app.askUser.back')}
            </button>
          )}
          <button
            className="ask-user-dialog__btn ask-user-dialog__btn--submit"
            onClick={handleNext}
            disabled={!canProceed}
          >
            {isLast ? t('app.askUser.confirm') : t('app.askUser.next')}
          </button>
        </div>
      </div>
    </div>
  )
}
