/**
 * 知识库设置视图（设置页「知识库」条目，issue#54）：主开关 + 只读库状态 + 快照存储位置。
 *
 * 缺陷HW-3/4 收敛（2026-11-21 用户拍板）：库位置修改点击无效已移除（元数据固定默认
 * ~/.zcgui/knowledge）、重建索引与模块管理是库级/数据动作全部归 ToolWindow，
 * 设置页不再是第二个操作面。
 *
 * 快照位置（2026-11-22）：text/restored 可迁出 C 盘（占用大头），元数据仍固定——
 * 修改位置走 changeKbSnapshotDir（Java 侧弹目录选择框+确认框，后台迁移），
 * 完成回整包 kbSettings（失败 error=细化原因行内展示）；恢复默认走 restoreKbSnapshotDir。
 * 重建索引同日从工具窗挪入（rebuildKbIndex op 已有，kbReindexDone 回执行内展示）。
 *
 * 桥接自包含（不入 zustand store）：sendToJava({op:getKbSettings}) + onMessage
 * 过滤 kbSettings / kbSnapshotChanging / kbReindexDone（开关应答经 kbSettingsChanged→
 * Java 侧 load 前置）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { onMessage, sendToJava } from '@/ipc/bridge'
import { SettingToggle } from './SettingToggle'
import '../styles/computer-settings.less'
import '../styles/browser-settings.less' // 快照行按钮复用 browser-settings__action-btn 同款视觉

interface KbSettings {
  enabled: boolean
  root: string
  /** 快照根（text/restored 所在；默认=元数据根） */
  snapshotDir?: string
  /** 是否自定义态（恢复默认按钮显隐） */
  snapshotCustom?: boolean
  entryCount: number
  storageBytes: number
  /** 快照占用（text/restored，快照根下） */
  snapshotBytes?: number
  /** changeSnapshotRoot 失败提示（整包应答附带，行内红字展示） */
  error?: string
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
  const [moving, setMoving] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [reindexNote, setReindexNote] = useState('')

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
        setMoving(false)
      } else if (op === 'kbSnapshotChanging') {
        setMoving(true) // 弹框/迁移期间按钮置 busy，防重复触发
      } else if (op === 'kbReindexDone') {
        const n = (msg as { reindexed?: number }).reindexed
        setReindexing(false)
        setReindexNote(n != null && n >= 0 ? t('kb.reindexDone', { n }) : t('kb.reindexFailed'))
        window.setTimeout(() => setReindexNote(''), 8000) // 行内回执 8s 自清
      }
    })
    return off
  }, [load, t])

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

      {/* 库状态（只读条目数/总占用）+ 库级动作卡片（快照位置/重建索引——自工具窗挪入，
          卡片结构对齐浏览器设置页 action-row：左侧标题+说明，右侧按钮组，2026-11-22） */}
      <h3 className="computer-settings__section">{t('kb.statsTitle')}</h3>
      <div className="computer-settings__note">
        <span className="codicon codicon-book computer-settings__note-icon" />
        {t('kb.entryCount')}: {settings?.entryCount ?? '-'} ｜ {t('kb.storage')}: {settings ? fmtBytes(settings.storageBytes) : '-'}
      </div>

      {/* 快照存储位置：text/restored 可迁出 C 盘，元数据固定默认根 */}
      <section className="browser-settings__section">
        <div className="browser-settings__action-row">
          <div className="browser-settings__action-body">
            <div className="browser-settings__action-name">{t('kb.snapshotLocation')}</div>
            <div className="browser-settings__action-desc">
              {t('kb.snapshotDesc')}
              <br />
              {t('kb.snapshotBytes')}: {settings?.snapshotBytes != null ? fmtBytes(settings.snapshotBytes) : '-'}
              ｜ <span style={{ wordBreak: 'break-all' }}>{settings?.snapshotDir ?? '-'}</span>
            </div>
          </div>
          <div className="browser-settings__action-btns">
            <button
              className="browser-settings__action-btn"
              disabled={moving}
              onClick={() => sendToJava({ op: 'changeKbSnapshotDir' } as never)}
            >
              <span className={moving ? 'codicon codicon-loading spin' : 'codicon codicon-folder-opened'} />
              {moving ? '…' : t('kb.snapshotChange')}
            </button>
            {settings?.snapshotCustom === true && (
              <button
                className="browser-settings__action-btn browser-settings__action-btn--ghost"
                disabled={moving}
                onClick={() => sendToJava({ op: 'restoreKbSnapshotDir' } as never)}
              >
                <span className="codicon codicon-discard" />
                {t('kb.snapshotRestore')}
              </button>
            )}
          </div>
        </div>
        {/* 重建索引：清缓存全量重提取（自工具窗挪入——库级数据动作与库状态同区） */}
        <div className="browser-settings__action-row">
          <div className="browser-settings__action-body">
            <div className="browser-settings__action-name">{t('kb.reindexTitle')}</div>
            <div className="browser-settings__action-desc">{t('kb.reindexDesc')}</div>
          </div>
          <div className="browser-settings__action-btns">
            <button
              className="browser-settings__action-btn"
              disabled={reindexing}
              onClick={() => {
                setReindexing(true)
                setReindexNote('')
                sendToJava({ op: 'rebuildKbIndex' } as never)
              }}
            >
              <span className={reindexing ? 'codicon codicon-loading spin' : 'codicon codicon-sync'} />
              {reindexing ? '…' : t('kb.reindexBtn')}
            </button>
          </div>
        </div>
        {reindexNote && (
          <div className="computer-settings__note" style={{ marginTop: -2 }}>
            <span className="codicon codicon-check computer-settings__note-icon" />
            {reindexNote}
          </div>
        )}
      </section>

      <div className="computer-settings__notes">
        <div className="computer-settings__note">
          <span className="codicon codicon-info computer-settings__note-icon" />
          {t('kb.noteRedline')}
        </div>
        {settings?.error && (
          <div className="computer-settings__note" style={{ color: 'var(--zc-danger, #e05f65)' }}>
            <span className="codicon codicon-error computer-settings__note-icon" />
            {settings.error}
          </div>
        )}
      </div>
    </div>
  )
}
