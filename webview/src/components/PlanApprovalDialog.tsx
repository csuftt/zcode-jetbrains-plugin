/**
 * ExitPlanMode 计划审批弹窗
 *
 * plan 模式下 AI 调用 ExitPlanMode 工具时，服务端通过 interaction/requestUserInput
 * 反向请求用户审批计划（params = {toolName:"ExitPlanMode", input:{plan:"markdown"}}）。
 * Java 端识别后推 {op:"exitPlanApproval", requestId, plan} 给前端，此组件渲染计划全文。
 *
 * 应答复用 askUserResponse 通道（Java 端按 requestId 找 future 应答服务器）：
 * - 批准并执行 = {action:"accept", answer:"approve"} + 乐观退出计划模式
 * - 继续规划（意见式） = {action:"accept", answer:"用户意见文本"} —— answer 有值但
 *   ≠ "approve" 会被服务端判为反馈式拒绝（The plan was not approved by the user），
 *   AI 据此留在计划模式继续修改；因此「继续规划」要求先输入意见才可点击。
 * - 裸 decline 仅保留兜底（点遮罩关闭 / Java 侧 5 分钟超时）。
 *
 * ⚠️ answer 必须是小写 "approve"（zcode.cjs 常量 S7t，严格相等比较）：
 * 大写 "Approve" 会落入"有答案但≠approve"分支被判为反馈式拒绝。
 * AskUserQuestion 的 answer 只要求非空，两者不能复用同一应答值。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sendToJava } from '@/ipc/bridge'
import { useStore } from '@/store/useStore'
import { MarkdownBlock } from './MarkdownBlock'
import '../styles/plan-approval-dialog.less'

interface Props {
  requestId: string
  plan: string
  onClose: () => void
}

export function PlanApprovalDialog({ requestId, plan, onClose }: Props) {
  const { t } = useTranslation()
  const [feedback, setFeedback] = useState('')

  const handleApprove = () => {
    sendToJava({
      op: 'askUserResponse',
      requestId,
      action: 'accept',
      answer: 'approve',
    })
    // 乐观退出计划模式：ExitPlanMode 的 batch 收尾事件不可靠/常迟到，等它会把
    // ModeSelect 的"计划模式"挂到回合结束的 loadSettings 校正才变。批准瞬间即恢复
    // 进 plan 前记忆的模式（无记忆则 yolo，同 applyModeEventToPatch 的 exit_plan），
    // 权威值由后续 state.updated / loadSettings 校正；迟到的 batch 推断有幂等保护不会覆盖
    const { prePlanMode } = useStore.getState()
    useStore.setState({ currentMode: prePlanMode ?? 'yolo', prePlanMode: null })
    onClose()
  }

  /** 意见式继续规划：answer=意见文本 ≠ "approve" → 服务端反馈式拒绝，留在计划模式修改 */
  const handleContinueWithFeedback = () => {
    const text = feedback.trim()
    if (!text) return
    sendToJava({
      op: 'askUserResponse',
      requestId,
      action: 'accept',
      answer: text,
    })
    // 不做模式切换：反馈路径仍留在 plan 模式（服务端未批准，currentMode 不变）
    onClose()
  }

  /** 兜底裸拒绝（遮罩误点）：无意见直接回到规划，服务端继续 plan 模式 */
  const handleDecline = () => {
    sendToJava({ op: 'askUserResponse', requestId, action: 'decline' })
    onClose()
  }

  return (
    <div className="plan-approval-overlay" onClick={handleDecline}>
      <div className="plan-approval-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="plan-approval-dialog__header">
          <span className="plan-approval-dialog__icon codicon codicon-tasklist" />
          <span className="plan-approval-dialog__title">{t('app.planApproval.title')}</span>
          <span className="plan-approval-dialog__hint">{t('app.planApproval.hint')}</span>
        </div>

        <div className="plan-approval-dialog__body">
          <MarkdownBlock markdown={plan || t('app.planApproval.emptyPlan')} />
        </div>

        <div className="plan-approval-dialog__footer">
          {/* 一行两组：批准主按钮在左（主操作优先），竖线分隔，输入组（框+继续规划）居右 */}
          <div className="plan-approval-dialog__actions">
            <button className="plan-approval-dialog__btn plan-approval-dialog__btn--approve" onClick={handleApprove}>
              <span className="codicon codicon-play" />
              {t('app.planApproval.approveAndRun')}
            </button>
            <span className="plan-approval-dialog__divider" />
            <div className="plan-approval-dialog__feedback-group">
              <textarea
                className="plan-approval-dialog__feedback-input"
                rows={2}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder={t('app.planApproval.feedbackPlaceholder')}
                maxLength={500}
                spellCheck={false}
                onKeyDown={(e) => {
                  // Enter 提交（Shift+Enter 换行，聊天输入惯例）
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    handleContinueWithFeedback()
                  }
                }}
              />
              <button
                className="plan-approval-dialog__feedback-submit"
                onClick={handleContinueWithFeedback}
                disabled={!feedback.trim()}
                title={!feedback.trim() ? t('app.planApproval.feedbackRequired') : undefined}
              >
                <span className="codicon codicon-arrow-right" />
                {t('app.planApproval.continuePlanning')}
              </button>
            </div>
          </div>
          <span className="plan-approval-dialog__tip">{t('app.planApproval.tip')}</span>
        </div>
      </div>
    </div>
  )
}
