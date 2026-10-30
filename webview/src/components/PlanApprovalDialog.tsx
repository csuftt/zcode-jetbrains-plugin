/**
 * ExitPlanMode 计划审批面板（底部停靠，对齐询问弹窗 dock 形态，issue #17）
 *
 * plan 模式下 AI 调用 ExitPlanMode 工具时，服务端通过 interaction/requestUserInput
 * 反向请求用户审批计划（params = {toolName:"ExitPlanMode", input:{plan:"markdown"}}）。
 * Java 端识别后推 {op:"exitPlanApproval", requestId, plan} 给前端。
 *
 * 0.3.7 起计划与审批分离：计划全文在消息流的 ExitPlanMode 工具卡（📖 弹窗可回看），
 * 本面板只承载审批操作，底部停靠非模态——不遮挡对话，用户可边回看计划边决定；
 * 无超时一直等待（Java 侧已取消 5 分钟自动 decline），header 显示「已等待」正计时。
 *
 * 应答复用 askUserResponse 通道（Java 端按 requestId 找 future 应答服务器）：
 * - 批准并执行 = {action:"accept", answer:"approve"} + 乐观退出计划模式
 * - 继续规划（意见式） = {action:"accept", answer:"用户意见文本"} —— answer 有值但
 *   ≠ "approve" 会被服务端判为反馈式拒绝（The plan was not approved by the user），
 *   AI 据此留在计划模式继续修改；因此「继续规划」要求先输入意见才可点击。
 * - 裸拒绝只走显式「拒绝」按钮（+ 回合终止 abort 兜底）。遮罩点击不响应：
 *   旧版遮罩=裸 decline，双击禁用按钮的第二击落在遮罩上会一击误拒（2026-08-20 实测）。
 *
 * ⚠️ answer 必须是小写 "approve"（zcode.cjs 常量 S7t，严格相等比较）：
 * 大写 "Approve" 会落入"有答案但≠approve"分支被判为反馈式拒绝。
 * AskUserQuestion 的 answer 只要求非空，两者不能复用同一应答值。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sendToJava } from '@/ipc/bridge'
import { useStore } from '@/store/useStore'
import { DialogCountdown, DialogElapsed } from './DialogCountdown'
import { MarkdownBlock } from './MarkdownBlock'
import '../styles/plan-approval-dialog.less'

/** 长计划阈值：超过即摘要限高渐隐（约 10 行），全文走「查看完整计划」弹窗 */
const PLAN_SUMMARY_LINE_LIMIT = 14
const PLAN_SUMMARY_CHAR_LIMIT = 500

interface Props {
  requestId: string
  plan: string
  /** Java 侧应答超时时刻（epoch 毫秒）。0.3.7 起审批无超时不再推送，仅旧链路/mock 兜底 */
  deadlineMs?: number
  /** 事件到达时刻（epoch 毫秒）：无超时等待下「已等待」正计时起点 */
  askedAt?: number
  onClose: () => void
}

export function PlanApprovalDialog({ requestId, plan, deadlineMs, askedAt, onClose }: Props) {
  const { t } = useTranslation()
  const openMarkdownPreview = useStore((s) => s.openMarkdownPreview)
  const [feedback, setFeedback] = useState('')
  /** 收起态（最小化）：只留 header 一行（徽章/标题/正计时/展开按钮），不打扰消息区 */
  const [collapsed, setCollapsed] = useState(false)
  /** 收起横条悬浮位（对齐询问弹窗 issue#45-4.3）：输入框上沿 y + 水平中心 x（视口坐标）。
      null=测量未就绪，横条回落 dock 贴底原位 */
  const [dockPos, setDockPos] = useState<{ x: number; top: number } | null>(null)
  const feedbackRef = useRef<HTMLTextAreaElement>(null)

  // 收起横条悬浮到输入框顶部中间（对齐询问弹窗 #45-4.3）：fixed 定位需输入框实时
  // 位置——拖拽调高、排队卡增减行都会改变上沿，ResizeObserver + window resize 双跟随
  useEffect(() => {
    if (!collapsed) {
      setDockPos(null)
      return
    }
    const box = document.querySelector('.chat-input-box')
    if (!box || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const r = box.getBoundingClientRect()
      setDockPos({ x: r.left + r.width / 2, top: r.top })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(box)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [collapsed])

  // 长计划 → 摘要限高渐隐 + 悬浮全文按钮（对齐 zcode 客户端）；短计划完整显示
  const isLongPlan = plan.split('\n').length > PLAN_SUMMARY_LINE_LIMIT || plan.length > PLAN_SUMMARY_CHAR_LIMIT

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
    // planApprovalAnswer='approve'（缺陷CG）：batch 推断的唯一放行凭证，消费后由
    // applyModeEventToPatch 清除；agentPlanActive 一并终止（缺陷CG 真根因：此后
    // session 模式推送照旧同步指示器）
    useStore.setState({
      planApprovalAnswer: 'approve',
      agentPlanActive: false,
      currentMode: prePlanMode ?? 'yolo',
      prePlanMode: null,
    })
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
    // 意见立即可见于主 UI：interaction 应答只回传服务端，消息流重拉前用户输入无踪影。
    // 插入走 store 的 insertFeedbackMessage——反馈式拒绝不终止回合，AI 后续输出仍在
    // 同一 turn 流式，反馈须插在流式消息拆分处；append 尾部会钉在流式尾部直到回合
    // 结束重拉才归位（缺陷Q）
    useStore.getState().insertFeedbackMessage(text)
    // 不做模式切换：反馈路径仍留在 plan 模式（服务端未批准，currentMode 不变）。
    // planApprovalAnswer='feedback'（缺陷CG）：挡住 batch 对 v2 拒绝的误判（记 success）
    useStore.setState({ planApprovalAnswer: 'feedback' })
    onClose()
  }

  /** 显式裸拒绝：无意见直接回到规划，服务端继续 plan 模式（唯一 decline 入口，遮罩不响应）*/
  const handleDecline = () => {
    sendToJava({ op: 'askUserResponse', requestId, action: 'decline' })
    // planApprovalAnswer='decline'（缺陷CG）：v2 batch 对拒绝也记 success（errorCount=0），
    // 必须显式挡住 exit_plan 推断，UI 留在 plan 等权威值校正
    useStore.setState({ planApprovalAnswer: 'decline' })
    onClose()
  }

  return (
    // dock 变体：底部停靠非模态（透明遮罩、放行消息区交互）——计划全文在消息流工具卡，
    // 用户可边回看边决定（issue #17，对齐询问弹窗底部形态）
    <div className="plan-approval-overlay plan-approval-overlay--dock">
      {/* 遮罩不响应点击：裸拒绝只走显式「拒绝」按钮（见文件头注释） */}
      <div
        className={`plan-approval-dialog ${collapsed ? 'plan-approval-dialog--collapsed' : ''}`}
        style={
          collapsed && dockPos
            ? {
                position: 'fixed',
                left: dockPos.x,
                top: dockPos.top - 8,
                transform: 'translate(-50%, -100%)',
                // 横条只有 header 一行，全宽太压消息区，适度收窄居中悬浮（对齐询问弹窗）
                width: 'min(calc(100vw - 24px), 640px)',
              }
            : undefined
        }
      >
        <div
          className="plan-approval-dialog__header"
          onClick={collapsed ? () => setCollapsed(false) : undefined}
          role={collapsed ? 'button' : undefined}
        >
          <span className="plan-approval-dialog__badge">
            <span className="codicon codicon-shield" />
            {t('app.planApproval.badge')}
          </span>
          <span className="plan-approval-dialog__title">{t('app.planApproval.title')}</span>
          {/* 无超时=已等待正计时；deadlineMs 仅旧链路兜底 */}
          {deadlineMs != null ? <DialogCountdown deadlineMs={deadlineMs} /> : <DialogElapsed sinceMs={askedAt} />}
          <button
            type="button"
            className="plan-approval-dialog__collapse"
            aria-expanded={!collapsed}
            title={collapsed ? t('app.askUser.expand') : t('app.askUser.collapse')}
            onClick={(e) => {
              e.stopPropagation()
              setCollapsed((v) => !v)
            }}
          >
            {/* 弹窗贴底部：展开态点收起显 chevron-down，收起态点展开显 chevron-up（对齐询问弹窗） */}
            <span className={`codicon codicon-chevron-${collapsed ? 'up' : 'down'}`} />
          </button>
        </div>

        {!collapsed && (
          <>
            <div className="plan-approval-dialog__body">
              {/* 计划摘要预览（对齐 zcode 客户端：默认可见内容再决定，长计划限高渐隐）；
                  全文走全局预览弹窗（与消息流工具卡 📖 同层） */}
              <div
                className={`plan-approval-dialog__summary ${isLongPlan ? 'plan-approval-dialog__summary--clipped' : ''}`}
              >
                <MarkdownBlock markdown={plan || t('app.planApproval.emptyPlan')} />
                {isLongPlan && (
                  <button
                    type="button"
                    className="plan-approval-dialog__view-plan plan-approval-dialog__view-plan--overlay"
                    onClick={() => openMarkdownPreview({ title: t('tool.planTitle'), markdown: plan })}
                  >
                    <span className="codicon codicon-book" />
                    {t('app.planApproval.viewFull')}
                  </button>
                )}
              </div>
              {!isLongPlan && (
                <button
                  type="button"
                  className="plan-approval-dialog__view-plan"
                  onClick={() => openMarkdownPreview({ title: t('tool.planTitle'), markdown: plan })}
                >
                  <span className="codicon codicon-book" />
                  {t('app.planApproval.viewFull')}
                  <span className="codicon codicon-arrow-right plan-approval-dialog__view-arrow" />
                </button>
              )}
              <textarea
                ref={feedbackRef}
                className="plan-approval-dialog__feedback-input"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder={t('app.planApproval.feedbackPlaceholder')}
                maxLength={2000}
                rows={3}
                spellCheck={false}
                onKeyDown={(e) => {
                  // 多行输入：Ctrl/Cmd+Enter 提交意见，裸 Enter 换行
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    handleContinueWithFeedback()
                  }
                }}
              />
              {/* 行为说明（动态，消除「意见+批准」歧义）：意见随『继续规划』提交；
                  『批准执行』不带意见直接开始。独占整行可换行，不被按钮组挤压截断 */}
              <span className="plan-approval-dialog__tip">
                {feedback.trim()
                  ? t('app.planApproval.tipWithFeedback')
                  : t('app.planApproval.tip')}
              </span>
            </div>

            <div className="plan-approval-dialog__footer">
              <div className="plan-approval-dialog__actions">
                <button className="plan-approval-dialog__btn plan-approval-dialog__btn--decline" onClick={handleDecline}>
                  <span className="codicon codicon-close" />
                  {t('app.planApproval.decline')}
                </button>
                <button
                  className="plan-approval-dialog__btn plan-approval-dialog__btn--feedback"
                  onClick={handleContinueWithFeedback}
                  disabled={!feedback.trim()}
                  title={!feedback.trim() ? t('app.planApproval.feedbackRequired') : undefined}
                >
                  <span className="codicon codicon-comment" />
                  {t('app.planApproval.continuePlanning')}
                </button>
                <button className="plan-approval-dialog__btn plan-approval-dialog__btn--approve" onClick={handleApprove}>
                  <span className="codicon codicon-play" />
                  {t('app.planApproval.approveAndRun')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
