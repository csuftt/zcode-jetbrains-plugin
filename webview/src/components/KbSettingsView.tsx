/**
 * 知识库设置视图（设置页「知识库」条目，issue#54）：只留主开关 + 只读库状态。
 *
 * 缺陷HW-3/4 收敛（2026-11-21 用户拍板）：库位置修改点击无效已移除（固定默认
 * ~/.zcgui/knowledge）、重建索引与模块管理是库级/数据动作全部归 ToolWindow，
 * 设置页不再是第二个操作面。
 *
 * 桥接自包含（不入 zustand store）：sendToJava({op:getKbSettings}) + onMessage
 * 过滤 kbSettings（开关应答经 kbSettingsChanged→Java 侧 load 前置，此处只收快照）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { onMessage, sendToJava } from '@/ipc/bridge'
import { SettingToggle } from './SettingToggle'
import '../styles/computer-settings.less'

interface KbSettings {
  enabled: boolean
  root: string
  entryCount: number
  storageBytes: number
  /** 目录展示路径列表（`信创适配/中间件`），快照只读保留，设置页不渲染 */
  folders: string[]
  tags: string[]
  projects: string[]
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}

export function KbSettingsView() {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<KbSettings | null>(null)
  const [toggling, setToggling] = useState(false)

  const load = useCallback(() => {
    sendToJava({ op: 'getKbSettings' } as never)
  }, [])

  useEffect(() => {
    load()
    const off = onMessage((msg) => {
      const op = (msg as { op?: string }).op
      if (op === 'kbSettings') {
        setSettings(msg as unknown as KbSettings)
        setToggling(false)
      }
    })
    return off
  }, [load])

  return (
    <div className="computer-settings kb-settings">
      <h3 className="computer-settings__section">{t('kb.title')}</h3>
      <SettingToggle
        icon="codicon-library"
        title={t('kb.switchTitle')}
        desc={t('kb.switchDesc')}
        on={settings?.enabled === true}
        busy={toggling}
        disabled={settings == null}
        onHint={t('kb.onHint')}
        offHint={t('kb.offHint')}
        onToggle={() => {
          if (settings == null || toggling) return
          setToggling(true)
          sendToJava({ op: 'setKbEnabled', enabled: !settings.enabled } as never)
        }}
      />

      {/* 库状态（只读展示；重建索引/模块管理/库位置等库级动作已收敛到知识库 ToolWindow——缺陷HW-3/4） */}
      <h3 className="computer-settings__section">{t('kb.statsTitle')}</h3>
      <div className="computer-settings__notes">
        <div className="computer-settings__note">
          <span className="codicon codicon-book computer-settings__note-icon" />
          {t('kb.entryCount')}: {settings?.entryCount ?? '-'} ｜ {t('kb.storage')}: {settings ? fmtBytes(settings.storageBytes) : '-'}
        </div>
        <div className="computer-settings__note">
          <span className="codicon codicon-info computer-settings__note-icon" />
          {t('kb.noteRedline')}
        </div>
      </div>
    </div>
  )
}
