/**
 * 模型选择下拉（cc-gui ModelSelect 简化版）
 *
 * - 按钮：当前模型名（超长省略）+ chevron-down，hover 变 --bg-hover
 * - 下拉：向上弹出（bottom:100%），按 provider 分组，项 = modelName + 次级 providerName
 * - 外部点击 / Escape 关闭；当前选中项高亮
 *
 * 数据来源：~/.zcode/v2/config.json 的 provider 注册表（setModel 只能切已注册 provider）
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { fmtTokens } from '@/utils/format'
import type { ModelOption } from '@/types/messages'
import { ModelIcon } from './ModelIcon'
import { PlanBadge, VisionBadge } from './PlanBadge'
import '../styles/input-box.less'

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
  const refreshModels = useStore((s) => s.refreshModels)
  const modelsRefreshing = useStore((s) => s.modelsRefreshing)
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

  // 悬停信息卡：选中模型的三行详情（供应商/模型名/上下文窗口）。JCEF 不渲染原生
  // title 提示，走 createPortal + fixed（ContextRing 同款方案）；仅在选中且能匹配到
  // 模型条目时展示
  const [hovered, setHovered] = useState(false)
  const [tipPos, setTipPos] = useState<{ left: number; bottom: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  const currentOption = currentModel
    ? models.find((m) => m.modelId === currentModel.modelId && m.providerId === currentModel.providerId)
    : displayName
      ? models.find((m) => m.modelId === displayName)
      : undefined

  // useMemo 稳定引用：数组字面量每次渲染都是新引用，作 layout effect 依赖会无限重渲染
  const tipLines = useMemo(() => {
    if (!currentOption) return []
    return [
      `${t('input.model.provider')}${currentOption.providerName}`,
      `${t('input.model.model')}${currentOption.modelName}`,
      currentOption.contextWindow
        ? `${t('input.model.contextWindow')}${fmtTokens(currentOption.contextWindow)} tokens`
        : null,
    ].filter((l): l is string => l !== null)
  }, [currentOption, t])

  // 渲染后量宽定位：左对齐按钮、越界右移；弹上方（按钮在底部栏），与下拉同时打开时隐藏
  useLayoutEffect(() => {
    if (!hovered || tipLines.length === 0 || open) {
      setTipPos(null)
      return
    }
    const b = btnRef.current?.getBoundingClientRect()
    const tip = tipRef.current
    if (!b || !tip) return
    const left = Math.max(8, Math.min(b.left, window.innerWidth - tip.offsetWidth - 8))
    const bottom = window.innerHeight - b.top + 6
    // 值未变不重设：setState 新对象同样触发重渲染
    setTipPos((prev) => (prev && prev.left === left && prev.bottom === bottom ? prev : { left, bottom }))
  }, [hovered, open, tipLines])

  return (
    <div className="selector-button-wrap" ref={rootRef}>
      <button
        className="selector-button"
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        onMouseEnter={() => {
          if (!open) setHovered(true)
        }}
        onMouseLeave={() => setHovered(false)}
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

      {/* 悬停信息卡（先隐形渲染量宽，useLayoutEffect 定位后才可见）*/}
      {hovered && tipLines.length > 0 &&
        createPortal(
          <div
            ref={tipRef}
            className="model-info-tip"
            style={
              tipPos
                ? { position: 'fixed', left: tipPos.left, bottom: tipPos.bottom }
                : { position: 'fixed', visibility: 'hidden', top: 0, left: 0 }
            }
          >
            {tipLines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>,
          document.body,
        )}

      {open && (
        <div className="selector-dropdown">
          {groups.length === 0 && (
            /* 空态不可禁按钮/不渲染下拉：用户在 Zcode 客户端改完配置回来要能点
               刷新拉新（下拉是刷新入口，置灰会死锁——只能去设置页刷）*/
            <div className="selector-dropdown-empty">{t('models.emptyHint')}</div>
          )}
          {groups.map(([providerId, items]) => (
            <div key={providerId} className="selector-dropdown-group">
              <div className="selector-dropdown-group-title">
                {items[0]?.providerName ?? providerId}
                <PlanBadge plan={items[0]?.plan} />
              </div>
              {items.map((m) => (
                <div
                  key={m.modelId}
                  className={`selector-dropdown-item ${isCurrent(m) ? 'is-selected' : ''}`}
                  onClick={() => handleSelect(m.modelId, m.providerId)}
                >
                  <ModelIcon modelId={m.modelId} providerId={m.providerId} size={16} />
                  <div className="selector-dropdown-item-main">
                    <span className="selector-dropdown-item-name">{m.modelName}</span>
                    {m.supportsImages && <VisionBadge />}
                    {isCurrent(m) && <span className="codicon codicon-check selector-dropdown-item-check" />}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {/* 手动刷新：用户在 Zcode 客户端改了模型配置后无需切设置页即可拉新 */}
          <div
            className={`selector-dropdown-refresh ${modelsRefreshing ? 'is-refreshing' : ''}`}
            onClick={() => {
              if (!modelsRefreshing) refreshModels()
            }}
          >
            <span className="codicon codicon-refresh" />
            <span>{t('input.model.refresh')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
