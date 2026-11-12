/**
 * 工具权限审批弹窗（「变更前询问」/default 模式）
 *
 * 服务端 interaction/requestPermission 反向请求：文件写入/命令执行前 app-server
 * 请求宿主批准（issue #2：旧版插件未实现该协议，请求被回 -32601 → AI 的操作
 * 全部被拒 → 反复重试后会话停止）。Java 端推 {op:"permissionRequest"}，
 * 本组件渲染选项，应答走 askUserResponse 通道（answer = optionId）。
 *
 * 选项由服务端生成（zcode.cjs t5()：allow_once / allow_project / deny），
 * 本组件只渲染 kind/name/description，不硬编码选项语义——服务端加选项自动生效。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PermissionOption } from '@/types/messages'
import { sendToJava } from '@/ipc/bridge'
import { DialogCountdown } from './DialogCountdown'
import '../styles/permission-dialog.less'

interface Props {
  requestId: string
  toolName: string
  reason: string
  options: PermissionOption[]
  /** 工具输入（Write 的 file_path/content、Bash 的 command 等）*/
  input?: unknown
  riskLevel?: string
  /** Java 侧应答超时时刻（epoch 毫秒）*/
  deadlineMs?: number
  onClose: () => void
}

/** 输入摘要单行上限：超长截断（弹窗信息密度控制，全文在工具卡可见）*/
const VALUE_LIMIT = 300
/** 摘要最多展示字段数（其余折叠进「更多参数」计数）*/
const MAX_FIELDS = 6
/** 优先展示的常见字段（顺序即展示顺序）*/
const PRIORITY_FIELDS = ['file_path', 'filePath', 'path', 'command', 'cmd', 'pattern', 'url', 'query', 'content']

interface InputRow {
  label: string
  value: string
  priority: number
}

/** 从工具输入提取人可读摘要行：常见字段优先，其余字符串/数值字段次之 */
function summarizeInput(input: unknown): InputRow[] {
  if (typeof input !== 'object' || input === null) {
    if (input == null) return []
    return [{ label: 'input', value: String(input).slice(0, VALUE_LIMIT), priority: 99 }]
  }
  const rows: InputRow[] = []
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    let value: string
    if (typeof v === 'string') value = v
    else if (typeof v === 'number' || typeof v === 'boolean') value = String(v)
    else continue // 嵌套结构（数组/对象）不进摘要，避免弹窗膨胀
    if (!value) continue
    rows.push({
      label: k,
      value: value.length > VALUE_LIMIT ? value.slice(0, VALUE_LIMIT) + '…' : value,
      priority: PRIORITY_FIELDS.indexOf(k) >= 0 ? PRIORITY_FIELDS.indexOf(k) : 50,
    })
  }
  return rows.sort((a, b) => a.priority - b.priority)
}

/**
 * 服务端 reason → 本地化。服务端只发英文：常量精确匹配 + 两个带插值的模板
 * （zcode.cjs mode.build.* 规则层取值集，2026-08-26 定案）；未匹配显示原文
 * （规则配置自定义 reason 等扩展场景，保真优先）。
 */
function localizeReason(reason: string, t: ReturnType<typeof useTranslation>['t']): string {
  if (reason === 'Critical risk tools require explicit approval')
    return t('app.permissionApproval.reasons.criticalRisk')
  if (reason === 'High risk tools require explicit approval')
    return t('app.permissionApproval.reasons.highRisk')
  if (reason === 'Tool has side effects and requires approval')
    return t('app.permissionApproval.reasons.sideEffect')
  let m = reason.match(/^Tool (\S+) requires approval$/)
  if (m) return t('app.permissionApproval.reasons.toolRequires', { tool: m[1] })
  m = reason.match(/^MCP tool (\S+) executes through an external server$/)
  if (m) return t('app.permissionApproval.reasons.mcpExternal', { tool: m[1] })
  return reason
}

export function PermissionApprovalDialog({
  requestId,
  toolName,
  reason,
  options,
  input,
  riskLevel,
  deadlineMs,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const rows = summarizeInput(input)
  const shown = rows.slice(0, MAX_FIELDS)
  const restCount = rows.length - shown.length
  /** 收起态（最小化）：只留 header 一行（徽章/标题/工具/风险/倒计时/展开按钮），
      对齐询问/计划审批弹窗（issue#45-4.3 同款交互） */
  const [collapsed, setCollapsed] = useState(false)
  /** 收起横条悬浮位：输入框上沿 y + 水平中心 x（视口坐标）。null=测量未就绪，
      横条回落 dock 贴底原位 */
  const [dockPos, setDockPos] = useState<{ x: number; top: number } | null>(null)

  // 收起横条悬浮到输入框顶部中间（同计划审批弹窗）：拖拽调高、排队卡增减行都会
  // 改变输入框上沿，ResizeObserver + window resize 双跟随
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

  /** 服务端 optionId → 本地化按钮文案（allow_once/allow_project/deny 为稳定枚举；
   *  未知 optionId（服务端扩展选项）fallback 服务端原文）*/
  const optionName = (opt: PermissionOption): string =>
    t(`app.permissionApproval.options.${opt.optionId}`, { defaultValue: opt.name })
  const optionDesc = (opt: PermissionOption): string =>
    t(`app.permissionApproval.optionDesc.${opt.optionId}`, { defaultValue: opt.description || opt.name })
  /** 输入字段名 → 常见字段本地化，协议字段名 fallback 原文 */
  const fieldLabel = (label: string): string =>
    t(`app.permissionApproval.fields.${label}`, { defaultValue: label })

  /** 选项按钮样式：允许类绿色、拒绝红色、其余中性 */
  const btnClass = (opt: PermissionOption): string => {
    if (opt.kind === 'deny' || opt.optionId === 'deny') return 'perm-dialog__btn--deny'
    if (opt.kind.startsWith('allow')) return 'perm-dialog__btn--allow'
    return 'perm-dialog__btn--neutral'
  }

  /** 主选项（允许一次）放大为主按钮；拒绝类排最后 */
  const sorted = [...options].sort((a, b) => {
    const rank = (o: PermissionOption): number => {
      if (o.optionId === 'allow_once' || o.kind === 'allow_once') return 0
      if (o.kind === 'deny' || o.optionId === 'deny') return 2
      return 1
    }
    return rank(a) - rank(b)
  })

  const handleChoose = (opt: PermissionOption) => {
    sendToJava({ op: 'askUserResponse', requestId, action: 'accept', answer: opt.optionId })
    onClose()
  }

  const riskLabel = riskLevel === 'critical'
    ? t('app.permissionApproval.riskCritical')
    : riskLevel === 'high' ? t('app.permissionApproval.riskHigh') : null

  return (
    // dock 形态：底部停靠非模态（对齐询问/计划审批弹窗）——放行消息区交互，
    // 用户可回看工具卡上下文再决定；倒计时与应答逻辑不变
    <div className="ask-user-overlay ask-user-overlay--dock">
      {/* 遮罩不响应点击（与 AskUserDialog 同款纪律）：审批是显式决策，误触遮罩不得改变语义 */}
      <div
        className={`perm-dialog ${collapsed ? 'perm-dialog--collapsed' : ''}`}
        title={toolName}
        style={
          collapsed && dockPos
            ? {
                position: 'fixed',
                left: dockPos.x,
                top: dockPos.top - 8,
                transform: 'translate(-50%, -100%)',
                // 横条宽度跟随主界面：与展开 dock 态同口径（overlay 左右 12px 边距内撑满）
                width: 'calc(100vw - 24px)',
              }
            : undefined
        }
      >
        <div
          className="perm-dialog__header"
          onClick={collapsed ? () => setCollapsed(false) : undefined}
          role={collapsed ? 'button' : undefined}
        >
          <span className="perm-dialog__icon">🛡️</span>
          <span className="perm-dialog__title">{t('app.permissionApproval.title')}</span>
          <span className="perm-dialog__tool">{toolName}</span>
          {riskLabel && <span className="perm-dialog__risk">{riskLabel}</span>}
          <DialogCountdown deadlineMs={deadlineMs} />
          <button
            type="button"
            className="perm-dialog__collapse"
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
            <div className="perm-dialog__body">
              {reason && <div className="perm-dialog__reason">{localizeReason(reason, t)}</div>}
              {shown.length > 0 && (
                <div className="perm-dialog__input">
                  {shown.map((row) => (
                    <div key={row.label} className="perm-dialog__input-row">
                      <span className="perm-dialog__input-label">{fieldLabel(row.label)}</span>
                      <span className="perm-dialog__input-value">{row.value}</span>
                    </div>
                  ))}
                  {restCount > 0 && (
                    <div className="perm-dialog__input-more">{t('app.permissionApproval.moreFields', { count: restCount })}</div>
                  )}
                </div>
              )}
            </div>

            <div className="perm-dialog__footer">
              {sorted.map((opt) => (
                <button
                  key={opt.optionId}
                  type="button"
                  className={`perm-dialog__btn ${btnClass(opt)} ${opt.optionId === 'allow_once' ? 'perm-dialog__btn--primary' : ''}`}
                  onClick={() => handleChoose(opt)}
                  title={optionDesc(opt)}
                >
                  {optionName(opt)}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
