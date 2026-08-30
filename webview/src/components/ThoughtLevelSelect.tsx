/**
 * 思考级别选择下拉（仿 ModelSelect，复用 selector-* 样式）
 *
 * - 数据源：session/read → settings.thoughtLevel.available（服务端权威，因模型而异：
 *   GLM-5.2/deepseek=off/high/max，GLM-4.x/qwen=enabled/off，kimi=low/high/max）
 * - 按钮显示当前级别中文；current 未设置时显示 defaultLevel（后缀「默认」）
 * - 模型不支持思考（enabled=false）或无级别数据时隐藏；无会话（待命态）也显示——
 *   级别集来自按模型缓存（hydrateThoughtLevelStandby 恢复），预选后建会话先于首条消息下发
 * - 外部点击 / Escape 关闭；当前选中项高亮
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useStore } from '@/store/useStore'
import '../styles/input-box.less'

/** 级别 value → 标签 i18n key（ZCode 客户端 UI 本地化同款，未知值原样显示）
 *  实测补充：部分模型用 disabled / nothink 表示关闭思考（与 off 同义）*/
const LEVEL_LABEL_KEYS: Record<string, string> = {
  off: 'input.thought.off',
  disabled: 'input.thought.disabled',
  nothink: 'input.thought.nothink',
  low: 'input.thought.low',
  medium: 'input.thought.medium',
  high: 'input.thought.high',
  max: 'input.thought.max',
  enabled: 'input.thought.enabled',
}

/** 级别图标（off/disabled/nothink=禁止圈 / low·enabled=灯泡 / medium·high=灯泡火花 / max=火箭）*/
const LEVEL_ICONS: Record<string, string> = {
  off: 'codicon-circle-slash',
  disabled: 'codicon-circle-slash',
  nothink: 'codicon-circle-slash',
  low: 'codicon-lightbulb',
  medium: 'codicon-lightbulb-sparkle',
  high: 'codicon-lightbulb-sparkle',
  max: 'codicon-rocket',
  enabled: 'codicon-lightbulb',
}
const levelIcon = (v: string) => LEVEL_ICONS[v] ?? 'codicon-lightbulb'

function levelLabel(value: string, t: TFunction): string {
  const key = LEVEL_LABEL_KEYS[value]
  return key ? t(key) : value
}

export function ThoughtLevelSelect() {
  const { t } = useTranslation()
  const thoughtLevel = useStore((s) => s.thoughtLevel)
  const setThoughtLevel = useStore((s) => s.setThoughtLevel)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 外部点击 / Escape 关闭（须在条件 return 之前，保证 hooks 调用顺序恒定）
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

  // 模型不支持思考级别 / 无数据时整个隐藏（待命态无缓存的新模型即此态，首个会话后补缓存）
  const levels = thoughtLevel?.available ?? []
  if (!thoughtLevel?.enabled || levels.length === 0) return null

  // 显示值：current → defaultLevel（标注默认）→ 兜底「思考」
  const current = thoughtLevel.current ?? thoughtLevel.defaultLevel
  const displayText = current ? levelLabel(current, t) : t('input.thought.enabled')
  const isDefault = !thoughtLevel.current && !!thoughtLevel.defaultLevel

  return (
    <div className="selector-button-wrap" ref={rootRef}>
      <button
        className="selector-button"
        onClick={() => setOpen((v) => !v)}
        title={isDefault ? t('input.thought.titleWithDefault', { level: displayText }) : t('input.thought.title')}
      >
        <span className={`codicon ${current ? levelIcon(current) : 'codicon-lightbulb'} thought-level-icon`} />
        <span className="selector-button-text">{displayText}</span>
        <span className="codicon codicon-chevron-down selector-button-chevron" />
      </button>

      {open && (
        <div className="selector-dropdown">
          {levels.map((l) => (
            <div
              key={l.value}
              className={`selector-dropdown-item ${current === l.value ? 'is-selected' : ''}`}
              onClick={() => {
                setThoughtLevel(l.value)
                setOpen(false)
              }}
            >
              <span className={`codicon ${levelIcon(l.value)} thought-level-icon`} />
              <div className="selector-dropdown-item-main">
                <span className="selector-dropdown-item-name">{levelLabel(l.value, t)}</span>
                {l.value === thoughtLevel.defaultLevel && (
                  <span className="selector-dropdown-item-sub">{t('input.thought.default')}</span>
                )}
                {current === l.value && <span className="codicon codicon-check selector-dropdown-item-check" />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
