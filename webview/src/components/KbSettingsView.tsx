/**
 * 知识库设置视图（设置页「知识库」条目，issue#54 / #56）：主开关 + 只读库状态 + 库位置 +
 * 同步与版本历史（远端地址）+ 重建索引。
 *
 * 设置页不做第二个操作面：目录/标签管理归树右键与「管理标签」弹窗，同步按钮在工具窗
 * 工具条（那里看得到「待同步」角标）；这里只放库级配置与数据动作。
 *
 * 库位置：整个知识库（目录、标签、条目信息、文档快照、版本历史）所在目录可迁到其他本地
 * 磁盘，系统盘的入口路径不变——修改走 changeKbLocation（Java 侧弹目录选择框 + 确认框，
 * 后台迁移），完成回整包 kbSettings（失败 error=细化原因，行内展示）；恢复默认走
 * restoreKbLocation。
 *
 * 同步：远端地址就是知识库仓库的 origin，保存走 setKbRemote。换一台电脑接入也只走这里：
 * 填同一个远端地址保存，再点工具条的「同步」——本地库为空而远端有历史时同步直接取回整个库。
 *
 * 桥接自包含（收发不入 zustand store）：sendToJava({op:getKbSettings}) + onMessage
 * 过滤 kbSettings / kbLocationChanging / kbRemoteChanging / kbReindexDone。唯一用到 store 的是
 * 设置页跳转意图 pendingSettingsSection='kb'：工具条「同步」没配远端时被带到这里，挂载后把
 * 焦点落到远端地址输入框再清掉意图。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { onMessage, sendToJava } from '@/ipc/bridge'
import { useStore } from '@/store/useStore'
import { SettingToggle } from './SettingToggle'
import '../styles/computer-settings.less'
import '../styles/browser-settings.less' // 卡片按钮复用 browser-settings__action-btn 同款视觉
import '../styles/basic-settings.less' // 远端地址输入行复用 basic-settings__path-input 同款视觉

interface KbSettings {
  enabled: boolean
  /** 固定入口路径（系统盘；库位置自定义后是指向库目录的联接） */
  entryPath: string
  /** 库目录所在位置 */
  locationDir: string
  /** 是否自定义态（恢复默认按钮显隐；由 Java 侧判定，前端不比较路径字符串） */
  locationCustom?: boolean
  /** 远端地址（空串 = 未配置） */
  remoteUrl?: string
  entryCount: number
  storageBytes: number
  /** 文档快照占用 */
  snapshotBytes?: number
  /** 库级操作失败提示（整包应答附带，行内红字展示） */
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
  const [remoteInput, setRemoteInput] = useState('')
  const [savingRemote, setSavingRemote] = useState(false)
  const remoteInputRef = useRef<HTMLInputElement>(null)
  const pendingSection = useStore((s) => s.pendingSettingsSection)
  const setPendingSection = useStore((s) => s.setPendingSettingsSection)

  // 被带到这里时（工具条「同步知识库」没配远端）：焦点落到远端地址输入框，一眼看到该在哪填；
  // 意图消费后清掉，之后自己点进设置页不再抢焦点
  useEffect(() => {
    if (pendingSection !== 'kb') return
    remoteInputRef.current?.focus()
    setPendingSection(null)
  }, [pendingSection, setPendingSection])

  const load = useCallback(() => {
    sendToJava({ op: 'getKbSettings' } as never)
  }, [])

  useEffect(() => {
    load()
    const off = onMessage((msg) => {
      const op = (msg as { op?: string }).op
      if (op === 'kbSettings') {
        const snap = msg as unknown as KbSettings
        setSettings(snap)
        // 远端地址以落盘值为准回填（保存成功/被别处改过都跟得上）
        setRemoteInput(snap.remoteUrl ?? '')
        setToggling(false)
        setMoving(false)
        setSavingRemote(false)
      } else if (op === 'kbLocationChanging') {
        setMoving(true) // 弹框/迁移期间按钮置 busy，防重复触发
      } else if (op === 'kbRemoteChanging') {
        setSavingRemote(true)
      } else if (op === 'kbReindexDone') {
        const n = (msg as { reindexed?: number }).reindexed
        setReindexing(false)
        setReindexNote(n != null && n >= 0 ? t('kb.reindexDone', { n }) : t('kb.reindexFailed'))
        window.setTimeout(() => setReindexNote(''), 8000) // 行内回执 8s 自清
      }
    })
    return off
  }, [load, t])

  const remote = remoteInput.trim()

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

      {/* 库状态（只读条目数/总占用）+ 库级配置与动作卡片（卡片结构对齐浏览器设置页
          action-row：左侧标题+说明，右侧按钮组） */}
      <h3 className="computer-settings__section">{t('kb.statsTitle')}</h3>
      <div className="computer-settings__note" style={{ marginBottom: 8 }}>
        <span className="codicon codicon-book computer-settings__note-icon" />
        {t('kb.entryCount')}: {settings?.entryCount ?? '-'} ｜ {t('kb.storage')}:{' '}
        {settings ? fmtBytes(settings.storageBytes) : '-'}
      </div>

      {/* 库位置：整个库可迁到其他本地磁盘，系统盘入口路径不变 */}
      <section className="browser-settings__section">
        <div className="browser-settings__action-row">
          <div className="browser-settings__action-body">
            <div className="browser-settings__action-name">{t('kb.locationTitle')}</div>
            <div className="browser-settings__action-desc">
              {t('kb.locationDesc')}
              <br />
              {t('kb.snapshotBytes')}: {settings?.snapshotBytes != null ? fmtBytes(settings.snapshotBytes) : '-'}
              ｜{' '}
              <span style={{ wordBreak: 'break-all', fontFamily: 'var(--font-mono, monospace)' }}>
                {settings?.locationDir ?? '-'}
              </span>
            </div>
          </div>
          <div className="browser-settings__action-btns">
            <button
              className="browser-settings__action-btn"
              disabled={moving}
              onClick={() => {
                if (moving) return
                setMoving(true)
                sendToJava({ op: 'changeKbLocation' } as never)
              }}
            >
              <span className={moving ? 'codicon codicon-loading spin' : 'codicon codicon-folder-opened'} />
              {moving ? '…' : t('kb.locationChange')}
            </button>
            {settings?.locationCustom === true && (
              <button
                className="browser-settings__action-btn browser-settings__action-btn--ghost"
                disabled={moving}
                onClick={() => {
                  if (moving) return
                  setMoving(true)
                  sendToJava({ op: 'restoreKbLocation' } as never)
                }}
              >
                <span className="codicon codicon-discard" />
                {t('kb.locationRestore')}
              </button>
            )}
          </div>
        </div>

        {/* 同步与版本历史：远端地址（仓库的 origin）。换电脑接入不设单独入口——填同一个地址保存后，
            工具条的「同步」见本地库为空而远端有历史，会直接把整个库取回来（KbSync.sync） */}
        <div className="browser-settings__action-row">
          <div className="browser-settings__action-body">
            <div className="browser-settings__action-name">{t('kb.syncTitle')}</div>
            <div className="browser-settings__action-desc">{t('kb.syncDesc')}</div>
            <div className="basic-settings__path-row" style={{ marginTop: 8 }}>
              <input
                ref={remoteInputRef}
                type="text"
                className="basic-settings__path-input"
                aria-label={t('kb.remoteLabel')}
                value={remoteInput}
                onChange={(e) => setRemoteInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !savingRemote) {
                    setSavingRemote(true)
                    sendToJava({ op: 'setKbRemote', url: remote } as never)
                  }
                }}
                placeholder={t('kb.remotePlaceholder')}
                spellCheck={false}
                disabled={moving}
              />
              <button
                type="button"
                className="basic-settings__save-btn"
                disabled={savingRemote || moving}
                onClick={() => {
                  if (savingRemote) return
                  setSavingRemote(true)
                  sendToJava({ op: 'setKbRemote', url: remote } as never)
                }}
              >
                <span className={savingRemote ? 'codicon codicon-loading spin' : 'codicon codicon-save'} />
                {savingRemote ? '…' : t('kb.remoteSave')}
              </button>
            </div>
          </div>
        </div>

        {/* 重建索引：清检索缓存，按当前内容全量重提取（源文件不在的条目从文档快照重建） */}
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
