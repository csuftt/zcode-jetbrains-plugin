/**
 * 模型选择下拉（cc-gui ModelSelect 简化版）
 *
 * - 按钮：当前模型名（超长省略）+ chevron-down，hover 变 --bg-hover
 * - 下拉：向上弹出（bottom:100%），按 provider 分组，项 = modelName + 次级 providerName
 * - 外部点击 / Escape 关闭；当前选中项高亮
 *
 * 数据来源：~/.zcode/v2/config.json 的 provider 注册表（setModel 只能切已注册 provider）
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import type { ModelOption } from '@/types/messages'
import { ModelIcon } from './ModelIcon'

interface Props {
  /** 当前会话模型（null 时回退到消息 footer 的 modelID）*/
  currentModel: { modelId: string; providerId: string } | null
  onSelect: (modelId: string, providerId: string) => void
  /** 无会话时禁用 */
  disabled?: boolean
}

export function ModelSelect({ currentModel, onSelect, disabled = false }: Props) {
  const { t } = useTranslation()
  const models = useStore((s) => s.models)
  const messages = useStore((s) => s.messages)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 展示名：currentModel 优先，回退消息推断的 modelID，再回退「模型」
  const displayName = useMemo(() => {
    if (currentModel) return currentModel.modelId
    // 从消息流推断：最后一条 assistant 消息的 modelID
    for (let i = messages.length - 1; i >= 0; i--) {
      const modelID = messages[i].info.modelID
      if (modelID) return modelID
    }
    return null
  }, [currentModel, messages])

  // 按 provider 分组（保持 config.json 顺序）
  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const m of models) {
      const list = map.get(m.providerId) ?? []
      list.push(m)
      map.set(m.providerId, list)
    }
    return [...map.entries()]
  }, [models])

  // 外部点击关闭
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

  const handleSelect = (modelId: string, providerId: string) => {
    onSelect(modelId, providerId)
    setOpen(false)
  }

  const isCurrent = (m: ModelOption) =>
    currentModel?.modelId === m.modelId && currentModel?.providerId === m.providerId

  // 是否有确定的模型（currentModel 或消息推断的 modelID）
  const hasModel = !!(currentModel || displayName)

  return (
    <div className="selector-button-wrap" ref={rootRef}>
      <button
        className="selector-button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || models.length === 0}
        title={displayName ?? t('input.model.selectModel')}
      >
        {hasModel && (
          <ModelIcon
            modelId={currentModel?.modelId ?? displayName ?? undefined}
            providerId={currentModel?.providerId}
            size={16}
          />
        )}
        <span className={`selector-button-text ${!hasModel ? 'selector-button-text--placeholder' : ''}`}>
          {displayName ?? t('input.model.selectModel')}
        </span>
        <span className="codicon codicon-chevron-down selector-button-chevron" />
      </button>

      {open && models.length > 0 && (
        <div className="selector-dropdown">
          {groups.map(([providerId, items]) => (
            <div key={providerId} className="selector-dropdown-group">
              <div className="selector-dropdown-group-title">{items[0]?.providerName ?? providerId}</div>
              {items.map((m) => (
                <div
                  key={m.modelId}
                  className={`selector-dropdown-item ${isCurrent(m) ? 'is-selected' : ''}`}
                  onClick={() => handleSelect(m.modelId, m.providerId)}
                >
                  <ModelIcon modelId={m.modelId} providerId={m.providerId} size={16} />
                  <div className="selector-dropdown-item-main">
                    <span className="selector-dropdown-item-name">{m.modelName}</span>
                    {isCurrent(m) && <span className="codicon codicon-check selector-dropdown-item-check" />}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
