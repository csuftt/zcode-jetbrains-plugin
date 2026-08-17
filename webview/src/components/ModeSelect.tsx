/**
 * 权限模式选择下拉（仿 ModelSelect，复用 selector-* 样式）
 *
 * - 固定 4 项 build/edit/plan/yolo，与 ZCode 客户端 UI 选择器一致
 *   （协议还有 auto，但不可经切换路径设置，不暴露）
 * - 当前值：store currentMode（settings 权威 / setMode 乐观更新）→ 消息流 info.mode 兜底
 * - 切换 = session/setMode；不做 localStorage 记忆（模式是即时意图，新会话默认 yolo）
 * - 外部点击 / Escape 关闭；当前选中项高亮；仅「完全控制」按钮着警示色，其余模式原版
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'

/** 协议 4 模式（value 与服务端一致；label/title 文案经 i18n：input.mode.<value>.label/.title）*/
const MODES = [{ value: 'build' }, { value: 'edit' }, { value: 'plan' }, { value: 'yolo' }] as const

/** 模式图标（build=对话气泡 / edit=盾牌 / plan=任务清单 / yolo=闪电）*/const MODE_ICONS: Record<string, string> = {
  build: 'codicon-comment-discussion',
  edit: 'codicon-shield',
  plan: 'codicon-tasklist',
  yolo: 'codicon-zap',
}
const modeIcon = (v: string) => MODE_ICONS[v] ?? 'codicon-shield'

export function ModeSelect() {
  const { t } = useTranslation()
  const currentMode = useStore((s) => s.currentMode)
  const messages = useStore((s) => s.messages)
  const sessionId = useStore((s) => s.currentSessionId)
  const setMode = useStore((s) => s.setMode)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 显示值：currentMode → 消息流推断（settings 拉取前）→ 兜底「完全控制」（新会话默认 yolo）
  const displayValue = useMemo(() => {
    if (currentMode) return currentMode
    for (let i = messages.length - 1; i >= 0; i--) {
      const mode = messages[i].info.mode
      if (mode) return mode
    }
    return 'yolo'
  }, [currentMode, messages])

  const displayLabel = t(`input.mode.${displayValue}.label`, { defaultValue: displayValue })
  const activeMode = MODES.find((m) => m.value === displayValue)
  // 激活色 class：仅完全控制（yolo）着橙金警示色，其余模式用原版按钮色
  const activeClass = displayValue === 'yolo' ? 'mode-active-yolo' : ''

  // 外部点击 / Escape 关闭
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="selector-button-wrap" ref={rootRef}>
      <button
        className={`selector-button ${activeClass}`}
        onClick={() => setOpen((v) => !v)}
        disabled={!sessionId}
        title={activeMode ? t(`input.mode.${activeMode.value}.title`) : t('input.mode.title')}
      >
        <span className={`codicon ${modeIcon(displayValue)}`} />
        <span className="selector-button-text">{displayLabel}</span>
        <span className="codicon codicon-chevron-down selector-button-chevron" />
      </button>

      {open && (
        <div className="selector-dropdown">
          {MODES.map((m) => (
            <div
              key={m.value}
              className={`selector-dropdown-item ${displayValue === m.value ? 'is-selected' : ''}`}
              title={t(`input.mode.${m.value}.title`)}
              onClick={() => {
                setMode(m.value)
                setOpen(false)
              }}
            >
              <span className={`codicon ${modeIcon(m.value)}`} />
              <div className="selector-dropdown-item-main">
                <span className="selector-dropdown-item-name">{t(`input.mode.${m.value}.label`)}</span>
                {displayValue === m.value && <span className="codicon codicon-check selector-dropdown-item-check" />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
