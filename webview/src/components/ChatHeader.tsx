/**
 * ChatHeader（照抄 cc-gui ChatHeader.tsx 结构）
 *
 * - chat 视图：左侧会话标题（hover 铅笔可编辑）+ 右侧 icon 按钮组
 * - history 视图：左侧返回按钮，右侧按钮组隐藏
 * - settings 视图：返回 null（设置视图自带关闭）
 *
 * 按钮取舍（后端无能力 → 点击 toast「暂未支持」）：
 *   新会话(plus) ✓ / 新Tab(split-horizontal) ✗ / 搜索(search) ✗ / 历史(history) ✓ / 设置(settings-gear) ✗
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import '../styles/header.less'
import { useStore } from '@/store/useStore'
import { ConfirmDialog } from './ConfirmDialog'

/** 返回箭头（cc-gui Icons.tsx BackIcon 简化版）*/
function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10 3L5 8L10 13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface Props {
  currentView: 'chat' | 'history' | 'settings'
  sessionTitle: string
  /** 空会话（无对话历史）时置灰新会话按钮——再建只会堆空会话 */
  newSessionDisabled?: boolean
  onBack: () => void
  onNewSession: () => void
  onNewTab: () => void
  /** 浏览器开关：展开/收起本会话内嵌浏览器分栏（AI browser-use 也用它）*/
  onOpenBrowser: () => void
  /** 模型调用轨迹弹窗（读 CLI 落盘 model-io，需已有会话）*/
  onOpenTrajectory: () => void
  /** 无会话时置灰调用轨迹按钮 */
  trajectoryDisabled?: boolean
  onSearch: () => void
  onHistory: () => void
  onSettings: () => void
  onTitleChange: (newTitle: string) => void
  /** AI 重新生成会话标题（有对话内容才可点；确认弹窗在组件内）*/
  onRegenerateTitle: () => void
  /** 当前会话是否具备生成条件（存在真实用户消息）*/
  canRegenerateTitle: boolean
  /** 标题生成进行中（按钮转圈，全局单飞）*/
  regeneratingTitle: boolean
  /** 目录徽标（多目录会话·变体A，2026-10-28 方案A 定稿）：标题下方紧凑徽标。
   *  语义两态由 App 算好传入：有会话=会话归属目录；待命=落位目录；唯一目录（或空）=null 不显示。
   *  isProject=true 走金黄（2026-11-02：有其他目录时本项目也显示；金黄专属语义
   *  2026-11-06 终审保留）；colorIndex=统一配色色板序号（非本项目目录，Java 轮询
   *  分配），null 回落默认主题色 */
  wsBadge?: { dir: string; isProject: boolean; colorIndex: number | null } | null
}

export function ChatHeader({
  currentView,
  sessionTitle,
  newSessionDisabled = false,
  onBack,
  onNewSession,
  onNewTab,
  onOpenBrowser,
  onOpenTrajectory,
  trajectoryDisabled = false,
  onSearch,
  onHistory,
  onSettings,
  onTitleChange,
  onRegenerateTitle,
  canRegenerateTitle,
  regeneratingTitle,
  wsBadge = null,
}: Props) {
  const { t } = useTranslation()
  // 会话弹窗态（调研 ⑧）：弹窗期 Header 挂置顶按钮（默认置顶，Java 弹出时已开），
  // 搬回主窗由 Java 推 detached=false 收起；面板级 store 态，切会话不清
  const detachWindow = useStore((s) => s.detachWindow)
  const toggleDetachPin = useStore((s) => s.toggleDetachPin)
  // settings 视图不渲染（SettingsView 自带关闭入口）
  if (currentView === 'settings') return null

  return (
    <div className="header">
      <div className="header-left">
        {currentView === 'history' ? (
          <>
            <button className="back-button" onClick={onBack} data-tooltip={t('chat.header.back')}>
              <BackIcon /> {t('chat.header.back')}
            </button>
            {/* 色块图例（2026-11-03 用户定稿）：并入返回行右侧空白区，固定两行，
                单行超宽省略号截断（不自动换行）。第一行=形态/颜色轴，第二行=文字轴
                + 目录 chips 可拖动排序提示（2026-11-07 拖拽上线并入，两行配平不扩高）。
                标签色块是原生 Swing 图标无 tooltip 通道，说明统一收口在这条 */}
            <div className="header-legend">
              <span className="codicon codicon-info" aria-hidden />
              <span className="header-legend__lines">
                <span className="header-legend__line">{t('history.legend.line1')}</span>
                <span className="header-legend__line">{t('history.legend.line2')}</span>
              </span>
            </div>
          </>
        ) : (
          <SessionTitle
            title={sessionTitle}
            onTitleChange={onTitleChange}
            onRegenerate={onRegenerateTitle}
            canRegenerate={canRegenerateTitle}
            regenerating={regeneratingTitle}
          />
        )}
        {/* 目录徽标（多目录会话·变体A·方案A 定稿 2026-10-28）：紧凑徽标挂标题下方，
            header 仅增高 ~17px。两态语义（会话归属/待命落位）由 App 算好传入，
            唯一目录不显示；本项目=金黄（2026-11-06 同步压暗），关联目录=统一配色色板
            （colorIndex 由 Java 轮询分配，null 回落默认主题色），悬浮 title 完整路径。
            外层 row 占满一行触发换行（无背景），徽标本体自适应内容宽度（背景不拉满） */}
        {wsBadge && currentView === 'chat' && (
          <span className="ws-header-badge-row">
            <span
              className={[
                'ws-header-badge',
                wsBadge.isProject ? 'ws-header-badge--project' : '',
                // -1=金黄（项目色改选后金黄降入目录序列的目录项，2026-11-07）
                wsBadge.colorIndex === -1 ? 'ws-header-badge--gold' : '',
                wsBadge.colorIndex != null && wsBadge.colorIndex >= 0
                  ? `ws-header-badge--dir${wsBadge.colorIndex + 1}`
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-tooltip={wsBadge.dir}
            >
              <span className="ws-header-badge__name">
                {wsBadge.dir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop()}
              </span>
            </span>
          </span>
        )}
      </div>
      <div className="header-right">
        {currentView === 'chat' && (
          <>
            {/* 弹窗置顶（调研 ⑧，2026-11-11 用户定稿默认置顶）：仅弹窗态渲染；
                态样式区分钉住/未钉，点击切 Java 侧 setAlwaysOnTop */}
            {detachWindow.detached && (
              <button
                className={`icon-button${detachWindow.pinned ? ' icon-button--pinned' : ''}`}
                onClick={toggleDetachPin}
                data-tooltip={detachWindow.pinned ? t('chat.header.detachPinOff') : t('chat.header.detachPin')}
                aria-label={detachWindow.pinned ? t('chat.header.detachPinOff') : t('chat.header.detachPin')}
              >
                <span className="codicon codicon-pin" />
              </button>
            )}
            <button
              className="icon-button"
              onClick={onNewSession}
              disabled={newSessionDisabled}
              data-tooltip={newSessionDisabled ? t('chat.header.newSessionDisabled') : t('chat.header.newSession')}
            >
              <span className="codicon codicon-plus" />
            </button>
            <button className="icon-button" onClick={onNewTab} data-tooltip={t('chat.header.newTab')}>
              <span className="codicon codicon-split-horizontal" />
            </button>
            <button className="icon-button" onClick={onOpenBrowser} data-tooltip={t('chat.header.browser')}>
              <span className="codicon codicon-browser" />
            </button>
            <button
              className="icon-button"
              onClick={onOpenTrajectory}
              disabled={trajectoryDisabled}
              data-tooltip={t('trajectory.title')}
            >
              <span className="codicon codicon-circuit-board" />
            </button>
            <button className="icon-button" onClick={onSearch} data-tooltip={t('chat.header.searchSession')}>
              <span className="codicon codicon-search" />
            </button>
            <button className="icon-button" onClick={onHistory} data-tooltip={t('chat.header.history')}>
              <span className="codicon codicon-history" />
            </button>
            <button className="icon-button" onClick={onSettings} data-tooltip={t('chat.header.settings')}>
              <span className="codicon codicon-settings-gear" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** 会话标题：hover 铅笔（编辑）/ 刷新（AI 重新生成，带二次确认）*/
function SessionTitle({
  title,
  onTitleChange,
  onRegenerate,
  canRegenerate,
  regenerating,
}: {
  title: string
  onTitleChange: (t: string) => void
  onRegenerate: () => void
  canRegenerate: boolean
  regenerating: boolean
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [confirmRegen, setConfirmRegen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 进入编辑态：填入当前标题并自动聚焦全选
  useEffect(() => {
    if (editing) {
      setEditValue(title)
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing, title])

  const startEditing = () => setEditing(true)

  const commitEdit = () => {
    setEditing(false)
    const next = editValue.trim().slice(0, 50)
    if (next && next !== title) onTitleChange(next)
  }

  const cancelEdit = () => setEditing(false)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  /** blur 时若焦点移入编辑区内部按钮（保存/取消），交给按钮处理，不重复提交 */
  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const related = e.relatedTarget as HTMLElement | null
    if (related?.closest('.session-title-edit-mode')) return
    commitEdit()
  }

  if (editing) {
    return (
      <div className="session-title-edit-mode" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="session-title-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          maxLength={50}
          spellCheck={false}
          aria-label={t('chat.header.sessionTitleAria')}
        />
        <button className="session-title-save-btn" onClick={commitEdit} aria-label={t('chat.header.saveTitleAria')}>
          <span className="codicon codicon-check" />
        </button>
        <button className="session-title-cancel-btn" onClick={cancelEdit} aria-label={t('chat.header.cancelEditAria')}>
          <span className="codicon codicon-close" />
        </button>
      </div>
    )
  }

  return (
    <div className="session-title-wrapper">
      <div className="session-title" title={title}>
        {title || t('chat.header.untitled')}
      </div>
      <button
        className={`session-title-edit-btn session-title-regen-btn${regenerating ? ' session-title-regen-btn--active' : ''}`}
        onClick={() => setConfirmRegen(true)}
        disabled={!canRegenerate || regenerating}
        aria-label={t('chat.header.regenTitleAria')}
        data-tooltip={canRegenerate ? t('chat.header.regenTitle') : t('chat.header.regenNoContent')}
      >
        <span className="codicon codicon-refresh" />
      </button>
      <button className="session-title-edit-btn" onClick={startEditing} aria-label={t('chat.header.editTitleAria')}>
        <span className="codicon codicon-edit" />
      </button>
      {/* AI 重新生成标题二次确认（覆盖当前标题属破坏性替换，且消耗一次模型调用）*/}
      {confirmRegen && (
        <ConfirmDialog
          title={t('chat.header.regenConfirmTitle')}
          message={t('chat.header.regenConfirmMessage')}
          confirmText={t('chat.header.regenConfirmOk')}
          onConfirm={() => {
            setConfirmRegen(false)
            onRegenerate()
          }}
          onCancel={() => setConfirmRegen(false)}
        />
      )}
    </div>
  )
}
