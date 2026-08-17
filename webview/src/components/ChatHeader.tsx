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
import '../styles/header.less'

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
  onSearch: () => void
  onHistory: () => void
  onSettings: () => void
  onTitleChange: (newTitle: string) => void
}

export function ChatHeader({
  currentView,
  sessionTitle,
  newSessionDisabled = false,
  onBack,
  onNewSession,
  onNewTab,
  onOpenBrowser,
  onSearch,
  onHistory,
  onSettings,
  onTitleChange,
}: Props) {
  // settings 视图不渲染（SettingsView 自带关闭入口）
  if (currentView === 'settings') return null

  return (
    <div className="header">
      <div className="header-left">
        {currentView === 'history' ? (
          <button className="back-button" onClick={onBack} data-tooltip="返回">
            <BackIcon /> 返回
          </button>
        ) : (
          <SessionTitle title={sessionTitle} onTitleChange={onTitleChange} />
        )}
      </div>
      <div className="header-right">
        {currentView === 'chat' && (
          <>
            <button
              className="icon-button"
              onClick={onNewSession}
              disabled={newSessionDisabled}
              data-tooltip={newSessionDisabled ? '当前会话为空，无需新建' : '新会话'}
            >
              <span className="codicon codicon-plus" />
            </button>
            <button className="icon-button" onClick={onNewTab} data-tooltip="新标签页">
              <span className="codicon codicon-split-horizontal" />
            </button>
            <button className="icon-button" onClick={onOpenBrowser} data-tooltip="浏览器（展开/收起）">
              <span className="codicon codicon-browser" />
            </button>
            <button className="icon-button" onClick={onSearch} data-tooltip="搜索会话">
              <span className="codicon codicon-search" />
            </button>
            <button className="icon-button" onClick={onHistory} data-tooltip="历史记录">
              <span className="codicon codicon-history" />
            </button>
            <button className="icon-button" onClick={onSettings} data-tooltip="设置">
              <span className="codicon codicon-settings-gear" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** 会话标题：hover 铅笔 → 编辑态 input + check/close（照抄 cc-gui 编辑逻辑）*/
function SessionTitle({
  title,
  onTitleChange,
}: {
  title: string
  onTitleChange: (t: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
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
          aria-label="会话标题"
        />
        <button className="session-title-save-btn" onClick={commitEdit} aria-label="保存标题">
          <span className="codicon codicon-check" />
        </button>
        <button className="session-title-cancel-btn" onClick={cancelEdit} aria-label="取消编辑">
          <span className="codicon codicon-close" />
        </button>
      </div>
    )
  }

  return (
    <div className="session-title-wrapper">
      <div className="session-title" title={title}>
        {title || '新会话'}
      </div>
      <button className="session-title-edit-btn" onClick={startEditing} aria-label="编辑会话标题">
        <span className="codicon codicon-edit" />
      </button>
    </div>
  )
}
