/**
 * 其他设置视图（对齐 cc-gui OtherSettingsSection）
 *
 * 设置项：
 *   - 历史记录补全：开关（控制输入框前缀幽灵补全；↑↓ 历史回溯不受影响）
 *   - 管理历史记录：展开列表（重要度/文本/相对时间），添加/编辑/删除单条、
 *     清除低重要度、清空全部（后两者经 ConfirmDialog 二次确认）
 *
 * 数据流经 hooks/useInputHistory.ts 的管理 API（persist 通道持久化）；
 * 增删立即同步模块级内存历史，输入框 ArrowUp 导航无感刷新。
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  loadHistoryWithImportance,
  deleteHistoryItem,
  clearAllHistory,
  addHistoryItem,
  updateHistoryItem,
  clearLowImportanceHistory,
  isHistoryCompletionEnabled,
  setHistoryCompletionEnabled,
  type HistoryItem,
} from '@/hooks/useInputHistory'
import { ConfirmDialog } from './ConfirmDialog'
import { StarSupportSection } from './StarSupportSection'
import { useStore } from '@/store/useStore'
import { APP_VERSION } from '@/version/version'
import '../styles/other-settings.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** 相对时间：刚刚 / n分钟前 / …（cc-gui 同款分档；文案经 i18n 插值）*/
function formatRelativeTime(timestamp: string | undefined, t: TFunction): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (isNaN(date.getTime())) return ''
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  const units: [number, string][] = [
    [31536000, 'common.relativeTime.yearsAgo'],
    [2592000, 'common.relativeTime.monthsAgo'],
    [86400, 'common.relativeTime.daysAgo'],
    [3600, 'common.relativeTime.hoursAgo'],
    [60, 'common.relativeTime.minutesAgo'],
  ]
  for (const [unitSeconds, key] of units) {
    const interval = Math.floor(seconds / unitSeconds)
    if (interval >= 1) return t(key, { count: interval })
  }
  return t('common.relativeTime.justNow')
}

interface EditorState {
  isOpen: boolean
  mode: 'add' | 'edit'
  item?: HistoryItem
}

/** 二次确认弹窗状态（批量破坏性操作）*/
type PendingConfirm = { type: 'clearAll' } | { type: 'clearLow'; count: number } | null

/* ============ 历史条目编辑弹窗（cc-gui HistoryItemEditor 对齐） ============ */

interface HistoryItemEditorProps {
  mode: 'add' | 'edit'
  initialText?: string
  initialImportance?: number
  onSave: (text: string, importance: number) => void
  onClose: () => void
}

function HistoryItemEditor({
  mode,
  initialText = '',
  initialImportance = 1,
  onSave,
  onClose,
}: HistoryItemEditorProps) {
  const { t } = useTranslation()
  const [text, setText] = useState(initialText)
  const [importance, setImportance] = useState(initialImportance)
  // 每次打开由父组件重新挂载（条件渲染），initial* 即当前编辑值

  const handleSave = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSave(trimmed, Math.max(1, Math.floor(importance) || 1))
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
  }

  return (
    <div className="other-settings__editor-overlay" onClick={onClose}>
      <div
        className="other-settings__editor-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="other-settings__editor-header">
          <h4 className="other-settings__editor-title">
            {mode === 'add' ? t('settings.other.editorTitleAdd') : t('settings.other.editorTitleEdit')}
          </h4>
          <button
            type="button"
            className="other-settings__editor-close"
            onClick={onClose}
            title={t('settings.other.close')}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className="other-settings__editor-body">
          <div className="other-settings__editor-field">
            <label className="other-settings__editor-label">{t('settings.other.content')}</label>
            <textarea
              className="other-settings__editor-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('settings.other.contentPlaceholder')}
              rows={3}
              autoFocus
            />
          </div>

          <div className="other-settings__editor-field">
            <label className="other-settings__editor-label">{t('settings.other.importance')}</label>
            <div className="other-settings__importance-control">
              <button
                type="button"
                className="other-settings__importance-btn"
                onClick={() => setImportance((v) => Math.max(1, v - 1))}
                disabled={importance <= 1}
              >
                <span className="codicon codicon-remove" />
              </button>
              <input
                type="number"
                className="other-settings__importance-input"
                value={importance}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 1) setImportance(v)
                }}
                min={1}
              />
              <button
                type="button"
                className="other-settings__importance-btn"
                onClick={() => setImportance((v) => v + 1)}
              >
                <span className="codicon codicon-add" />
              </button>
            </div>
            <small className="other-settings__hint">
              <span className="codicon codicon-info" />
              <span>{t('settings.other.importanceHint')}</span>
            </small>
          </div>
        </div>

        <div className="other-settings__editor-footer">
          <button type="button" className="other-settings__btn" onClick={onClose}>
            {t('settings.other.cancel')}
          </button>
          <button
            type="button"
            className="other-settings__btn other-settings__btn--primary"
            onClick={handleSave}
            disabled={!text.trim()}
          >
            {t('settings.other.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============ 主视图 ============ */

export function OtherSettingsView() {
  const { t } = useTranslation()
  const openChangelog = useStore((s) => s.openChangelog)
  const [completionEnabled, setCompletionEnabled] = useState(() => isHistoryCompletionEnabled())
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [showHistoryList, setShowHistoryList] = useState(false)
  const [editorState, setEditorState] = useState<EditorState>({ isOpen: false, mode: 'add' })
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null)

  const reloadHistory = useCallback(() => {
    try {
      setHistoryItems(loadHistoryWithImportance())
    } catch {
      setHistoryItems([])
    }
  }, [])

  // 展开时加载；其他标签页改动（storage 事件）时刷新开关与已展开的列表
  useEffect(() => {
    if (showHistoryList) reloadHistory()
  }, [showHistoryList, reloadHistory])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'zcode-history-completion-enabled') setCompletionEnabled(isHistoryCompletionEnabled())
      else if (showHistoryList && (e.key === 'zcode-input-history' || e.key === null)) reloadHistory()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [showHistoryList, reloadHistory])

  const handleToggle = (enabled: boolean) => {
    setHistoryCompletionEnabled(enabled)
    setCompletionEnabled(enabled)
  }

  const handleDeleteItem = (item: HistoryItem) => {
    deleteHistoryItem(item.text)
    setHistoryItems((prev) => prev.filter((i) => i.text !== item.text))
  }

  const handleSaveEditor = (text: string, importance: number) => {
    if (editorState.mode === 'add') {
      addHistoryItem(text, importance)
    } else if (editorState.item) {
      updateHistoryItem(editorState.item.text, text, importance)
    }
    reloadHistory()
  }

  const handleConfirm = () => {
    if (pendingConfirm?.type === 'clearAll') clearAllHistory()
    else if (pendingConfirm?.type === 'clearLow') clearLowImportanceHistory(1)
    setPendingConfirm(null)
    reloadHistory()
  }

  const lowImportanceCount = historyItems.filter((item) => item.importance <= 1).length

  return (
    <div className="other-settings">
      <section className="other-settings__section">
        <h3 className="other-settings__title">{t('settings.other.title')}</h3>
        <p className="other-settings__desc">{t('settings.other.desc')}</p>

        {/* 历史记录补全开关 */}
        <div className="other-settings__field-header">
          <span className="codicon codicon-history" />
          <span className="other-settings__field-label">{t('settings.other.completionLabel')}</span>
        </div>
        <label className="other-settings__toggle">
          <input
            type="checkbox"
            className="other-settings__toggle-input"
            checked={completionEnabled}
            onChange={(e) => handleToggle(e.target.checked)}
          />
          <span className="other-settings__toggle-slider" />
          <span className="other-settings__toggle-label">
            {completionEnabled ? t('settings.other.on') : t('settings.other.off')}
          </span>
        </label>
        <small className="other-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.other.completionHint')}</span>
        </small>

        {/* 历史记录管理 */}
        <div className="other-settings__management">
          <button
            type="button"
            className="other-settings__expand-btn"
            onClick={() => setShowHistoryList(!showHistoryList)}
          >
            <span className={cx('codicon', showHistoryList ? 'codicon-chevron-down' : 'codicon-chevron-right')} />
            <span>{t('settings.other.manageHistory')}</span>
            {showHistoryList && historyItems.length > 0 && (
              <span className="other-settings__count">({historyItems.length})</span>
            )}
          </button>

          {showHistoryList && (
            <div className="other-settings__list-container">
              {historyItems.length === 0 ? (
                <div className="other-settings__empty">
                  <span className="codicon codicon-inbox" />
                  <span>{t('settings.other.empty')}</span>
                  <button
                    type="button"
                    className="other-settings__action-btn other-settings__action-btn--add"
                    onClick={() => setEditorState({ isOpen: true, mode: 'add' })}
                  >
                    <span className="codicon codicon-add" />
                    <span>{t('settings.other.add')}</span>
                  </button>
                </div>
              ) : (
                <>
                  <div className="other-settings__actions">
                    <button
                      type="button"
                      className="other-settings__action-btn other-settings__action-btn--add"
                      onClick={() => setEditorState({ isOpen: true, mode: 'add' })}
                    >
                      <span className="codicon codicon-add" />
                      <span>{t('settings.other.add')}</span>
                    </button>
                    <div className="other-settings__actions-spacer" />
                    {lowImportanceCount > 0 && (
                      <button
                        type="button"
                        className="other-settings__action-btn other-settings__action-btn--warn"
                        onClick={() => setPendingConfirm({ type: 'clearLow', count: lowImportanceCount })}
                        title={t('settings.other.clearLowTooltip')}
                      >
                        <span className="codicon codicon-filter" />
                        <span>{t('settings.other.clearLow', { count: lowImportanceCount })}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="other-settings__action-btn other-settings__action-btn--danger"
                      onClick={() => setPendingConfirm({ type: 'clearAll' })}
                    >
                      <span className="codicon codicon-trash" />
                      <span>{t('settings.other.clearAll')}</span>
                    </button>
                  </div>
                  <ul className="other-settings__list">
                    {historyItems.map((item, index) => (
                      <li key={`${item.text}-${index}`} className="other-settings__item">
                        <span className="other-settings__importance" title={t('settings.other.importanceTooltip')}>
                          [{item.importance}]
                        </span>
                        <span className="other-settings__item-text" title={item.text}>
                          {item.text}
                        </span>
                        {item.timestamp && (
                          <span
                            className="other-settings__item-time"
                            title={new Date(item.timestamp).toLocaleString()}
                          >
                            {formatRelativeTime(item.timestamp, t)}
                          </span>
                        )}
                        <div className="other-settings__item-actions">
                          <button
                            type="button"
                            className="other-settings__icon-btn other-settings__icon-btn--edit"
                            onClick={() => setEditorState({ isOpen: true, mode: 'edit', item })}
                            title={t('settings.other.edit')}
                          >
                            <span className="codicon codicon-edit" />
                          </button>
                          <button
                            type="button"
                            className="other-settings__icon-btn other-settings__icon-btn--delete"
                            onClick={() => handleDeleteItem(item)}
                            title={t('settings.other.delete')}
                          >
                            <span className="codicon codicon-close" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
        {/* 版本记录（What's New 弹窗手动入口）：标签右侧展示当前版本号 */}
        <div className="other-settings__field-header other-settings__field-header--divider">
          <span className="codicon codicon-tag" />
          <span className="other-settings__field-label">{t('settings.other.versionHistory')}</span>
          <span className="other-settings__version-now">v{APP_VERSION}</span>
          <div className="other-settings__actions-spacer" />
          <button
            type="button"
            className="other-settings__action-btn other-settings__action-btn--add"
            onClick={openChangelog}
            title={t('settings.other.versionHistoryHint')}
          >
            <span className="codicon codicon-history" />
            <span>{t('settings.other.versionHistoryView')}</span>
          </button>
        </div>
        <small className="other-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('settings.other.versionHistoryHint')}</span>
        </small>

        {/* 开源与支持：GitHub Star 引导（主按钮经 openExternal 桥直达仓库页） */}
        <StarSupportSection />
      </section>

      {/* 条目编辑弹窗（条件渲染保证每次打开重置初始值）*/}
      {editorState.isOpen && (
        <HistoryItemEditor
          mode={editorState.mode}
          initialText={editorState.item?.text}
          initialImportance={editorState.item?.importance}
          onSave={handleSaveEditor}
          onClose={() => setEditorState((prev) => ({ ...prev, isOpen: false }))}
        />
      )}

      {/* 批量破坏性操作二次确认 */}
      {pendingConfirm && (
        <ConfirmDialog
          title={pendingConfirm.type === 'clearAll' ? t('settings.other.confirmClearAllTitle') : t('settings.other.confirmClearLowTitle')}
          message={
            pendingConfirm.type === 'clearAll'
              ? t('settings.other.confirmClearAllMsg', { count: historyItems.length })
              : t('settings.other.confirmClearLowMsg', { count: pendingConfirm.count })
          }
          confirmText={t('settings.other.delete')}
          danger
          onConfirm={handleConfirm}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  )
}
