/**
 * 子智能体选择下拉（输入框左下区，ModelSelect 同款交互）
 *
 * - 按钮：robot 图标 + 「智能体」/选中名称 + chevron-down
 * - 下拉：颜色点 + name + description；点已选中项 = 取消选择；
 *   底部「管理」入口跳设置页「子智能体」tab（onManage 回调由 App 切视图）
 * - 数据：store.agents（磁盘扫描 ~/.zcode/agents + <项目>/.zcode/agents，
 *   与 ZCode 客户端数据共用）；下拉打开时懒加载一次
 * - 选中效果：InputBox 发送时消息前置 `@<name> `（主 Agent 调度该子智能体，
 *   2026-08-23 协议实测）
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import type { AgentDef } from '@/types/messages'
import '../styles/agent-select.less'
import '../styles/input-box.less'

interface Props {
  /** 打开设置页「子智能体」管理（App 层切视图 + 定位 tab）*/
  onManage?: () => void
  disabled?: boolean
}

/** 颜色标记 → 色点色值（ZCode 预设色，zcode.cjs 实测枚举）*/
export const AGENT_COLORS: Record<string, string> = {
  blue: '#4a90e2',
  green: '#4caf50',
  red: '#e06c75',
  orange: '#e5a05a',
  yellow: '#e5c07b',
  purple: '#b39ddb',
  pink: '#e78fb3',
  cyan: '#56b6c2',
}

/** 色点（无色配置时回退灰）*/
export function AgentColorDot({ color, className }: { color?: string; className?: string }) {
  return (
    <span
      className={`agent-color-dot ${className ?? ''}`}
      style={{ background: (color && AGENT_COLORS[color]) || '#9e9e9e' }}
    />
  )
}

export function AgentSelect({ onManage, disabled = false }: Props) {
  const { t } = useTranslation()
  const agents = useStore((s) => s.subagentDefs)
  const selectedAgent = useStore((s) => s.selectedAgent)
  const loadAgents = useStore((s) => s.loadAgents)
  const selectAgent = useStore((s) => s.selectAgent)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 下拉打开时懒加载（首次）+ 刷新（ZCode 客户端可能改过文件）
  useEffect(() => {
    if (open) loadAgents()
  }, [open, loadAgents])

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

  const handleSelect = (agent: AgentDef) => {
    // 点已选中项 = 取消；选其他 = 切换
    selectAgent(selectedAgent?.name === agent.name ? null : agent)
    setOpen(false)
  }

  const count = agents?.length ?? 0

  return (
    <div className="selector-button-wrap" ref={rootRef}>
      <button
        className="selector-button agent-select-button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={selectedAgent?.description ?? t('input.agent.select')}
      >
        {selectedAgent ? (
          <AgentColorDot color={selectedAgent.color} className="agent-select-button__dot" />
        ) : (
          <span className="codicon codicon-robot agent-select-button__icon" />
        )}
        <span
          className={`selector-button-text ${!selectedAgent ? 'selector-button-text--placeholder' : ''}`}
        >
          {selectedAgent?.name ?? t('input.agent.select')}
        </span>
        <span className="codicon codicon-chevron-down selector-button-chevron" />
      </button>

      {open && (
        <div className="selector-dropdown agent-select-dropdown">
          {count === 0 ? (
            <div className="agent-select-empty">
              <span>{agents === null ? t('common.actions.loading') : t('input.agent.empty')}</span>
            </div>
          ) : (
            <>
              {agents!.map((a) => (
                <div
                  key={`${a.scope}:${a.name}`}
                  className={`selector-dropdown-item ${selectedAgent?.name === a.name ? 'is-selected' : ''}`}
                  onClick={() => handleSelect(a)}
                >
                  <AgentColorDot color={a.color} />
                  <div className="selector-dropdown-item-main">
                    <span className="selector-dropdown-item-name">{a.name}</span>
                    <span className="selector-dropdown-item-desc">{a.description}</span>
                  </div>
                  {selectedAgent?.name === a.name && (
                    <span className="codicon codicon-check selector-dropdown-item-check" />
                  )}
                </div>
              ))}
            </>
          )}
          {onManage && (
            <div className="agent-select-manage" onClick={() => { setOpen(false); onManage() }}>
              <span className="codicon codicon-settings-gear" />
              <span>{t('input.agent.manage')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
