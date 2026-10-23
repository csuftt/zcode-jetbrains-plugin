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

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { BasicSettingsView } from './BasicSettingsView'
import { OtherSettingsView } from './OtherSettingsView'
import { UsageView } from './UsageView'
import { MemoryView } from './MemoryView'
import { SkillListView } from './SkillListView'
import { McpListView } from './McpListView'
import { ModelListView } from './ModelListView'
import { BrowserSettingsView } from './BrowserSettingsView'
import { ComputerSettingsView } from './ComputerSettingsView'
import { AgentListView } from './AgentListView'
import { HookListView } from './HookListView'
import { ProcessSettingsView } from './ProcessSettingsView'
import { isInJcef } from '@/ipc/bridge'
import '../styles/settings.less'

type SettingsTab = 'basic' | 'models' | 'usage' | 'memory' | 'skills' | 'agents' | 'mcp' | 'hooks' | 'browser' | 'computer' | 'processes' | 'other'

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
    !isInJcef() && ['basic', 'models', 'usage', 'memory', 'skills', 'agents', 'mcp', 'hooks', 'browser', 'computer', 'processes', 'other'].includes(hashTab)
      ? hashTab
      : 'basic'
  const [tab, setTab] = useState<SettingsTab>(initialTab)

  // 浏览器调试通道降级（browserHost 探针报异常）：左栏浏览器图标置灰提示，
  // 详情在 设置→浏览器 的控制卡内常驻展示（不再上主界面横幅，用户反馈扰民）
  const browserDown = useStore((s) => {
    const bh = s.envStatus?.browserHost
    return !!bh && !bh.ok
  })

  // 跳转意图消费：AgentSelect 下拉「管理」入口（env 由 BasicSettingsView 消费；
  // 挂载时消费一次即清，避免切走再回重复跳转）
  const pendingSection = useStore((s) => s.pendingSettingsSection)
  const setPendingSection = useStore((s) => s.setPendingSettingsSection)
  useEffect(() => {
    if (pendingSection === 'agents' || pendingSection === 'models' || pendingSection === 'hooks') {
      setTab(pendingSection)
      setPendingSection(null)
    }
  }, [pendingSection, setPendingSection])

  // glyph = Unicode 字形（codicon 字体无锚形；不用官方图标素材，避免版权问题）
  const navItems: { key: SettingsTab; icon?: string; glyph?: string }[] = [
    { key: 'basic', icon: 'codicon-paintcan' },
    { key: 'models', icon: 'codicon-server-process' },
    { key: 'usage', icon: 'codicon-graph' },
    { key: 'memory', icon: 'codicon-notebook' },
    { key: 'skills', icon: 'codicon-library' },
    { key: 'agents', icon: 'codicon-robot' },
    { key: 'mcp', icon: 'codicon-plug' },
    // U+2693 + U+FE0E：锚形强制文本呈现（单色，跟随按钮颜色而非彩色 emoji）
    { key: 'hooks', glyph: '⚓\uFE0E' },
    { key: 'browser', icon: 'codicon-globe' },
    { key: 'computer', icon: 'codicon-device-desktop' },
    { key: 'processes', icon: 'codicon-pulse' },
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
              className={cx('settings-view__nav-item', tab === it.key && 'active', it.key === 'browser' && browserDown && 'down')}
              onClick={() => setTab(it.key)}
              data-tooltip={
                it.key === 'browser' && browserDown
                  ? t('settings.tabs.browserDown')
                  : t(`settings.tabs.${it.key}`)
              }
            >
              {it.glyph
                ? <span className="settings-view__nav-glyph">{it.glyph}</span>
                : <span className={cx('codicon', it.icon)} />}
            </button>
          ))}
        </aside>

        {/* 右侧内容区 */}
        <main className="settings-view__content">
          {tab === 'basic' && <BasicSettingsView />}
          {tab === 'models' && <ModelListView />}
          {tab === 'usage' && <UsageView />}
          {tab === 'memory' && <MemoryView />}
          {tab === 'skills' && <SkillListView />}
          {tab === 'agents' && <AgentListView />}
          {tab === 'mcp' && <McpListView />}
          {tab === 'hooks' && <HookListView />}
          {tab === 'browser' && <BrowserSettingsView />}
          {tab === 'computer' && <ComputerSettingsView />}
          {tab === 'processes' && <ProcessSettingsView />}
          {tab === 'other' && <OtherSettingsView />}
        </main>
      </div>
    </div>
  )
}
