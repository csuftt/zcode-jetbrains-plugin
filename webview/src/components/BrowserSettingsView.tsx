/**
 * 浏览器设置视图（设置页「浏览器」条目；对齐 ZCode 客户端 设置→浏览器 能力）：
 *
 *   浏览器控制：**只读状态展示**（启用判据与 ZCode 客户端共用同一 data 目录；
 *              修改请去客户端操作——客户端侧禁用同样需要其后端配合，插件侧不再提供开关）
 *   浏览器数据：清除缓存（HTTP 缓存/Cache Storage/Service Worker，保留 Cookie 与本地
 *              站点数据）/ 清除全部（追加 Cookie/localStorage/IndexedDB，不可撤销）；
 *              每个条目旁「查看」按钮弹数据概览（按站点分组，占用与数量级）
 *
 *   （「安全→忽略证书校验」曾于 0.2.3 实现后移除：IntelliJ 的 JCEF 对证书错误有自带
 *    的"另存为可信站点"弹窗接管，开关开与不开都会弹，无实际意义。）
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { ConfirmDialog } from './ConfirmDialog'
import type { BrowserDataOverview, BrowserOverviewSite } from '@/types/messages'
import type { TFunction } from 'i18next'
import '../styles/browser-settings.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** 字节 → B/KB/MB/GB（概览行内联展示）*/
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** 单站点行的数据徽标（-1/0 不展示对应项）*/
function siteTags(t: TFunction, s: BrowserOverviewSite): string[] {
  const tags: string[] = []
  if (s.cookies > 0) tags.push(t('browser.overview.tagCookies', { count: s.cookies }))
  if (s.cacheStorages > 0) tags.push(t('browser.overview.tagCaches', { count: s.cacheStorages }))
  if (s.serviceWorkers > 0) tags.push(t('browser.overview.tagSw', { count: s.serviceWorkers }))
  if (s.localStorageEntries > 0) tags.push(t('browser.overview.tagLs', { count: s.localStorageEntries }))
  if (s.hasIndexedDb) tags.push(t('browser.overview.tagIdb', { size: fmtBytes(s.indexedDbBytes) }))
  if (!tags.length) tags.push(t('browser.overview.tagEmpty'))
  return tags
}

/** 浏览器控制只读状态卡（状态与 ZCode 客户端共用，修改在客户端进行）*/
function ControlStatusCard({ enabled, installed, rdHost }: { enabled: boolean; installed: boolean; rdHost: boolean }) {
  const { t } = useTranslation()
  return (
    <div className={cx('browser-settings__readonly', enabled && 'on')}>
      <div className="browser-settings__action-body">
        <div className="browser-settings__name-row">
          <span className={cx('codicon', enabled ? 'codicon-remote' : 'codicon-circle-slash', 'browser-settings__ro-icon')} />
          <span className="browser-settings__action-name">{t('browser.control.switchTitle')}</span>
          <span className={cx('browser-settings__state', enabled && 'on')}>
            {installed
              ? enabled ? t('browser.control.stateOn') : t('browser.control.stateOff')
              : t('browser.control.notInstalledShort')}
          </span>
        </div>
        <div className="browser-settings__action-desc">{t('browser.control.switchDesc')}</div>
        {rdHost && (
          <div className="browser-settings__action-desc browser-settings__rd-note">
            <span className="codicon codicon-remote" />
            <span>{t('browser.control.rdUnavailable')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** 概览弹窗：全局占用行 + 按站点分组（缓存档只列有缓存类数据的站点；全部档列全部站点）*/
function OverviewDialog({ all, data, onClose }: { all: boolean; data: BrowserDataOverview; onClose: () => void }) {
  const { t } = useTranslation()

  const sites = all
    ? data.sites
    : data.sites.filter((s) => s.cacheStorages > 0 || s.serviceWorkers > 0)

  const globalRows: { label: string; value: string }[] = [
    {
      label: t('browser.overview.httpCache'),
      value: `${fmtBytes(data.httpCacheBytes)} · ${t('browser.overview.entries', { count: data.httpCacheEntries })}`,
    },
    { label: t('browser.overview.codeCache'), value: fmtBytes(data.codeCacheBytes) },
  ]
  if (all && data.cookieCount >= 0) {
    globalRows.push({
      label: t('browser.overview.cookies'),
      value: t('browser.overview.cookieCount', { count: data.cookieCount }),
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content browser-overview" onClick={(e) => e.stopPropagation()}>
        <h3 className="browser-overview__title">
          {t(all ? 'browser.data.clearAll' : 'browser.data.clearCache')}
        </h3>

        <div className="browser-overview__rows">
          {globalRows.map((r) => (
            <div className="browser-overview__row" key={r.label}>
              <span className="browser-overview__label">{r.label}</span>
              <span className="browser-overview__value">{r.value}</span>
            </div>
          ))}
        </div>

        <div className="browser-overview__site-head">{t('browser.overview.bySite')}</div>
        {sites.length === 0 ? (
          <div className="browser-overview__empty">{t('browser.overview.noSites')}</div>
        ) : (
          <div className="browser-overview__sites">
            {sites.map((s) => (
              <div className="browser-overview__site" key={s.origin}>
                <div className="browser-overview__site-origin">
                  <span className={cx('codicon', s.open ? 'codicon-browser' : 'codicon-circle-filled')} />
                  <span className="browser-overview__site-name" title={s.origin}>{s.origin}</span>
                  {s.open && <span className="browser-overview__badge">{t('browser.overview.openBadge')}</span>}
                </div>
                <div className="browser-overview__site-tags">
                  {siteTags(t, s).map((tag) => (
                    <span className="browser-overview__tag" key={tag}>{tag}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="browser-overview__note">{t('browser.overview.note')}</p>
        <div className="browser-overview__footer">
          <button className="browser-overview__close" onClick={onClose}>
            {t('common.confirm.ok')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function BrowserSettingsView() {
  const { t } = useTranslation()
  const config = useStore((s) => s.browserConfig)
  const busy = useStore((s) => s.browserBusy)
  const error = useStore((s) => s.browserError)
  const cleared = useStore((s) => s.browserCleared)
  const overview = useStore((s) => s.browserOverview)
  const rdHost = useStore((s) => s.envStatus?.rdHost === true)
  const loadBrowserConfig = useStore((s) => s.loadBrowserConfig)
  const clearBrowserData = useStore((s) => s.clearBrowserData)
  const loadBrowserOverview = useStore((s) => s.loadBrowserOverview)
  const clearBrowserError = useStore((s) => s.clearBrowserError)
  const [confirmAll, setConfirmAll] = useState(false)
  /** 概览弹窗档位（null=关闭；打开时每次重拉）*/
  const [overviewFor, setOverviewFor] = useState<'cache' | 'all' | null>(null)

  useEffect(() => {
    loadBrowserConfig()
  }, [loadBrowserConfig])

  // 清理结果提示几秒后自动消失
  const [clearedVisible, setClearedVisible] = useState(false)
  useEffect(() => {
    if (!cleared) return
    setClearedVisible(true)
    const timer = setTimeout(() => setClearedVisible(false), 8000)
    return () => clearTimeout(timer)
  }, [cleared])

  const openOverview = (mode: 'cache' | 'all') => {
    setOverviewFor(mode)
    loadBrowserOverview()
  }

  const loaded = config != null

  return (
    <div className="browser-settings">
      {/* 浏览器控制（只读，与 ZCode 客户端共用——修改在客户端进行） */}
      <section className="browser-settings__section">
        <h3 className="browser-settings__section-title">{t('browser.control.title')}</h3>
        {loaded ? (
          <ControlStatusCard
            enabled={config.browserControlEnabled}
            installed={config.pluginInstalled}
            rdHost={rdHost}
          />
        ) : (
          <div className="browser-settings__readonly">{t('browser.loading')}</div>
        )}
        <small className="browser-settings__hint">
          <span className="codicon codicon-info" />
          <span>{t('browser.control.readonlyHint')}</span>
        </small>
      </section>

      {/* 浏览器数据 */}
      <section className="browser-settings__section">
        <h3 className="browser-settings__section-title">{t('browser.data.title')}</h3>
        <div className="browser-settings__action-row">
          <div className="browser-settings__action-body">
            <div className="browser-settings__action-name">{t('browser.data.clearCache')}</div>
            <div className="browser-settings__action-desc">{t('browser.data.clearCacheDesc')}</div>
          </div>
          <div className="browser-settings__action-btns">
            <button
              className="browser-settings__action-btn browser-settings__action-btn--ghost"
              onClick={() => openOverview('cache')}
              disabled={busy != null}
              title={t('browser.overview.title')}
            >
              <span className={cx('codicon', busy === 'overview' && !overview ? 'codicon-loading spin' : 'codicon-eye')} />
              {t('browser.overview.btn')}
            </button>
            <button
              className="browser-settings__action-btn"
              onClick={() => clearBrowserData('cache')}
              disabled={busy != null}
            >
              <span className={cx('codicon', busy === 'cache' ? 'codicon-loading spin' : 'codicon-clear-all')} />
              {busy === 'cache' ? t('browser.data.clearing') : t('browser.data.clearCacheBtn')}
            </button>
          </div>
        </div>
        <div className="browser-settings__action-row">
          <div className="browser-settings__action-body">
            <div className="browser-settings__action-name">{t('browser.data.clearAll')}</div>
            <div className="browser-settings__action-desc">{t('browser.data.clearAllDesc')}</div>
          </div>
          <div className="browser-settings__action-btns">
            <button
              className="browser-settings__action-btn browser-settings__action-btn--ghost"
              onClick={() => openOverview('all')}
              disabled={busy != null}
              title={t('browser.overview.title')}
            >
              <span className={cx('codicon', busy === 'overview' && !overview ? 'codicon-loading spin' : 'codicon-eye')} />
              {t('browser.overview.btn')}
            </button>
            <button
              className="browser-settings__action-btn browser-settings__action-btn--danger"
              onClick={() => setConfirmAll(true)}
              disabled={busy != null}
            >
              <span className={cx('codicon', busy === 'all' ? 'codicon-loading spin' : 'codicon-trash')} />
              {busy === 'all' ? t('browser.data.clearing') : t('browser.data.clearAllBtn')}
            </button>
          </div>
        </div>
      </section>

      {error && (
        <div className="browser-settings__error" onClick={() => clearBrowserError()}>
          <span className="codicon codicon-error" />
          <span>{error}</span>
        </div>
      )}
      {clearedVisible && cleared && (
        <div className="browser-settings__cleared">
          <span className="codicon codicon-pass" />
          <span>
            {t('browser.data.cleared', {
              httpCache: cleared.httpCache ? t('browser.data.cachePart') : '',
              cookies: cleared.all && cleared.cookies ? t('browser.data.cookiesPart') : '',
              sites: cleared.sites.length,
            })}
          </span>
        </div>
      )}

      {confirmAll && (
        <ConfirmDialog
          title={t('browser.data.clearAll')}
          message={t('browser.data.clearAllDesc')}
          danger
          onConfirm={() => {
            setConfirmAll(false)
            clearBrowserData('all')
          }}
          onCancel={() => setConfirmAll(false)}
        />
      )}

      {overviewFor != null && overview && (
        <OverviewDialog
          all={overviewFor === 'all'}
          data={overview}
          onClose={() => setOverviewFor(null)}
        />
      )}
    </div>
  )
}
