/**
 * ExitPlanMode 计划审批弹窗
 *
 * plan 模式下 AI 调用 ExitPlanMode 工具时，服务端通过 interaction/requestUserInput
 * 反向请求用户审批计划（params = {toolName:"ExitPlanMode", input:{plan:"markdown"}}）。
 * Java 端识别后推 {op:"exitPlanApproval", requestId, plan} 给前端，此组件渲染计划全文，
 * 用户批准（accept）或拒绝（decline）后通过 {op:"askUserResponse"} 回传。
 *
 * 应答复用 askUserResponse 通道（Java 端按 requestId 找 future 应答服务器）：
 * 批准 = {action:"accept", answer:"approve"}，拒绝 = {action:"decline"}。
 *
 * ⚠️ answer 必须是小写 "approve"（zcode.cjs 常量 S7t，严格相等比较）：
 * 大写 "Approve" 会落入"有答案但≠approve"分支被判为反馈式拒绝
 * （The plan was not approved by the user.）。AskUserQuestion 的 answer 只要求非空，
 * 两者不能复用同一应答值。
 */

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
          <span className="plan-approval-dialog__tip">{t('app.planApproval.tip')}</span>
          <button className="plan-approval-dialog__btn plan-approval-dialog__btn--decline" onClick={handleDecline}>
            {t('app.planApproval.continuePlanning')}
          </button>
          <button className="plan-approval-dialog__btn plan-approval-dialog__btn--approve" onClick={handleApprove}>
            {t('app.planApproval.approveAndRun')}
          </button>
        </div>
      </div>
    </div>
  )
}
