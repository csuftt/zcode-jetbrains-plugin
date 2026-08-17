/**
 * 设置视图（对齐 cc-gui SettingsView 结构）
 *
 * 布局：
 *   ┌─────────────────────────────────────┐
 *   │ [←] 设置            （顶部标题栏）    │  ← 返回图标在标题栏左侧
 *   ├──────┬──────────────────────────────┤
 *   │  📊  │                              │  ← 窄边栏（纯图标，hover tooltip 文字）
 *   │      │      内容区（UsageView）      │
 *   └──────┴──────────────────────────────┘
 *
 * 左侧 nav：「用量查询」「记忆」（预留扩展：常规/模型/MCP…）。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BasicSettingsView } from './BasicSettingsView'
import { OtherSettingsView } from './OtherSettingsView'
import { UsageView } from './UsageView'
import { MemoryView } from './MemoryView'
import { SkillListView } from './SkillListView'
import { McpListView } from './McpListView'
import { isInJcef } from '@/ipc/bridge'
import '../styles/settings.less'

type SettingsTab = 'basic' | 'usage' | 'memory' | 'skills' | 'mcp' | 'other'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

interface Props {
  onBack: () => void
}

export function SettingsView({ onBack }: Props) {
  const { t } = useTranslation()
  // dev 辅助：浏览器 mock 验收可带 #basic / #skills / #mcp 直达页签（#mcp/<服务器名> 只取首段）；
  // JCEF 内 hash 恒空不影响生产
  const hashTab = window.location.hash.replace('#', '').split('/')[0] as SettingsTab
  const initialTab: SettingsTab =
    !isInJcef() && ['basic', 'usage', 'memory', 'skills', 'mcp', 'other'].includes(hashTab)
      ? hashTab
      : 'basic'
  const [tab, setTab] = useState<SettingsTab>(initialTab)

  const navItems: { key: SettingsTab; icon: string }[] = [
    { key: 'basic', icon: 'codicon-paintcan' },
    { key: 'usage', icon: 'codicon-graph' },
    { key: 'memory', icon: 'codicon-notebook' },
    { key: 'skills', icon: 'codicon-library' },
    { key: 'mcp', icon: 'codicon-plug' },
    { key: 'other', icon: 'codicon-ellipsis' },
  ]

  return (
    <div className="settings-view">
      {/* 顶部标题栏（对齐 cc-gui SettingsHeader）*/}
      <header className="settings-view__header">
        <div className="settings-view__header-left">
          <button className="settings-view__back" onClick={onBack} data-tooltip={t('settings.backToChat')}>
            <span className="codicon codicon-arrow-left" />
          </button>
          <h2 className="settings-view__title">{t('settings.title')}</h2>
        </div>
      </header>

      <div className="settings-view__main">
        {/* 左侧窄边栏：纯图标，hover CSS tooltip 显示文字（与主界面 icon-button 一致） */}
        <aside className="settings-view__sidebar">
          {navItems.map((it) => (
            <button
              key={it.key}
              className={cx('settings-view__nav-item', tab === it.key && 'active')}
              onClick={() => setTab(it.key)}
              data-tooltip={t(`settings.tabs.${it.key}`)}
            >
              <span className={cx('codicon', it.icon)} />
            </button>
          ))}
        </aside>

        {/* 右侧内容区 */}
        <main className="settings-view__content">
          {tab === 'basic' && <BasicSettingsView />}
          {tab === 'usage' && <UsageView />}
          {tab === 'memory' && <MemoryView />}
          {tab === 'skills' && <SkillListView />}
          {tab === 'mcp' && <McpListView />}
          {tab === 'other' && <OtherSettingsView />}
        </main>
      </div>
    </div>
  )
}
