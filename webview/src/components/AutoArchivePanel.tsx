/**
 * 自动归档面板（历史视图第三个 tab「自动归档」）
 *
 * 结构：
 *   配置卡：开关 + 保留天数下拉（天数常显，开关关闭也可预览/调整）—— 与 ZCode
 *          桌面客户端共享同一份 ~/.zcode/v2/setting.json
 *          （taskAutoArchiveEnabled/taskAutoArchiveOlderThanDays），两端任一处修改均同步生效
 *   手动触发：「立即扫描」提前触发一轮定时归档——受开关约束（用户定案：未启用时
 *          扫描不生效），按钮禁用并给提示；完成后显示本轮结果并静默刷新会话列表
 *   归档记录：仅归档数 >0 的轮次（何时/何种方式/多少条），点击展开看本轮归档了
 *          哪些会话（展开区限高滚动，防上百条撑爆面板）；数据源为 Kotlin 侧
 *          PropertiesComponent（project 级，上限 50 条）
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingToggle } from './SettingToggle'
import { useStore } from '@/store/useStore'
import '../styles/agent-select.less'
import '../styles/auto-archive-panel.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** 保留天数选项（客户端 schema：正整数 max 365；这里给常用档位，非档位值原样显示） */
const DAY_OPTIONS = [1, 3, 7, 14, 30]

function formatTs(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function AutoArchivePanel() {
  const { t } = useTranslation()
  const configLoaded = useStore((s) => s.autoArchiveConfigLoaded)
  const enabled = useStore((s) => s.autoArchiveEnabled)
  const days = useStore((s) => s.autoArchiveDays)
  const records = useStore((s) => s.autoArchiveRecords)
  const running = useStore((s) => s.autoArchiveRunning)
  const lastRunCount = useStore((s) => s.autoArchiveLastRunCount)
  const lastRunSkipped = useStore((s) => s.autoArchiveLastRunSkipped)
  const lastSweepAt = useStore((s) => s.autoArchiveLastSweepAt)
  const loadAutoArchiveData = useStore((s) => s.loadAutoArchiveData)
  const setAutoArchiveConfig = useStore((s) => s.setAutoArchiveConfig)
  const runAutoArchiveNow = useStore((s) => s.runAutoArchiveNow)

  // 进面板拉配置+记录（每次挂载都拉，保证记录新鲜）
  useEffect(() => {
    loadAutoArchiveData()
  }, [loadAutoArchiveData])

  // 展开的记录（ts 唯一标识一轮）
  const [expanded, setExpanded] = useState<number | null>(null)
  const [daysOpen, setDaysOpen] = useState(false)

  return (
    <div className="auto-archive-panel">
      {/* 配置卡 */}
      <section className="auto-archive-panel__section">
        <div className="auto-archive-panel__section-header">
          <span className="codicon codicon-archive" />
          <span>{t('history.autoArchive.configTitle')}</span>
        </div>
        <SettingToggle
          icon="codicon-archive"
          title={t('history.autoArchive.toggleTitle')}
          desc={t('history.autoArchive.toggleDesc')}
          on={enabled}
          disabled={!configLoaded}
          onToggle={() => setAutoArchiveConfig(!enabled, days)}
        />
        {/* 开启时显示最近一次成功扫描时间（无论有无归档；手动/定时共用一行） */}
        {enabled && lastSweepAt != null && (
          <small className="auto-archive-panel__hint auto-archive-panel__last-sweep">
            <span className="codicon codicon-clock" />
            <span>{t('history.autoArchive.lastSweep', { time: formatTs(lastSweepAt) })}</span>
          </small>
        )}
        {/* 保留天数常显：开关关着也能预览当前档位/调整（与客户端一致——时长独立于开关） */}
        <div className="selector-button-wrap auto-archive-panel__days">
          <span className="auto-archive-panel__days-label">{t('history.autoArchive.daysLabel')}</span>
          <button type="button" className="selector-button" onClick={() => setDaysOpen((v) => !v)}>
            {t('history.autoArchive.daysValue', { count: days })}
            <span className="codicon codicon-chevron-down selector-button-chevron" />
          </button>
          {daysOpen && (
            <div className="selector-dropdown auto-archive-panel__days-dropdown">
              <div className="selector-dropdown-group">
                {DAY_OPTIONS.map((d) => (
                  <div
                    key={d}
                    className={cx('selector-dropdown-item', d === days && 'is-selected')}
                    onClick={() => {
                      setAutoArchiveConfig(enabled, d)
                      setDaysOpen(false)
                    }}
                  >
                    {t('history.autoArchive.daysValue', { count: d })}
                  </div>
                ))}
                {!DAY_OPTIONS.includes(days) && (
                  <div className="selector-dropdown-item is-selected">
                    {t('history.autoArchive.daysValue', { count: days })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <small className="auto-archive-panel__hint">
          <span className="codicon codicon-info" />
          <span>{t('history.autoArchive.sharedHint')}</span>
        </small>
      </section>

      {/* 手动触发（受开关约束：未启用=扫描不生效） */}
      <section className="auto-archive-panel__section">
        <div className="auto-archive-panel__section-header">
          <span className="codicon codicon-play" />
          <span>{t('history.autoArchive.runTitle')}</span>
        </div>
        <button
          type="button"
          className="auto-archive-panel__run-btn"
          disabled={running || !enabled}
          title={!enabled && configLoaded ? t('history.autoArchive.runDisabledHint') : undefined}
          onClick={runAutoArchiveNow}
        >
          <span className={cx('codicon', running ? 'codicon-loading spin' : 'codicon-sync')} />
          <span>{running ? t('history.autoArchive.running') : t('history.autoArchive.runNow')}</span>
        </button>
        {!enabled && configLoaded && (
          <small className="auto-archive-panel__hint">
            <span className="codicon codicon-info" />
            <span>{t('history.autoArchive.runDisabledHint')}</span>
          </small>
        )}
        {lastRunSkipped && (
          <small className="auto-archive-panel__hint auto-archive-panel__hint--warn">
            <span className="codicon codicon-warning" />
            <span>{t('history.autoArchive.skippedDisabled')}</span>
          </small>
        )}
        {lastRunCount != null && !running && (
          <small
            className={cx(
              'auto-archive-panel__hint',
              lastRunCount > 0 && 'auto-archive-panel__hint--ok',
            )}
          >
            <span className={cx('codicon', lastRunCount > 0 ? 'codicon-check-all' : 'codicon-dash')} />
            <span>
              {lastRunCount > 0
                ? t('history.autoArchive.lastRunDone', { count: lastRunCount })
                : t('history.autoArchive.lastRunEmpty')}
            </span>
          </small>
        )}
      </section>

      {/* 归档记录（仅 >0 轮次，新→旧；点击展开详情） */}
      <section className="auto-archive-panel__section">
        <div className="auto-archive-panel__section-header">
          <span className="codicon codicon-history" />
          <span>{t('history.autoArchive.recordsTitle')}</span>
          {records.length > 0 && <span className="auto-archive-panel__section-badge">{records.length}</span>}
        </div>
        {records.length === 0 ? (
          <div className="auto-archive-panel__empty">{t('history.autoArchive.recordsEmpty')}</div>
        ) : (
          <ul className="auto-archive-panel__records">
            {records.map((r) => {
              const open = expanded === r.ts
              return (
                <li key={r.ts} className="auto-archive-panel__record">
                  <button
                    type="button"
                    className="auto-archive-panel__record-row"
                    onClick={() => setExpanded(open ? null : r.ts)}
                  >
                    <span className={cx('codicon', open ? 'codicon-chevron-down' : 'codicon-chevron-right')} />
                    <span className="auto-archive-panel__record-ts">{formatTs(r.ts)}</span>
                    <span
                      className={cx(
                        'auto-archive-panel__record-mode',
                        r.mode === 'manual' && 'auto-archive-panel__record-mode--manual',
                      )}
                    >
                      {t(r.mode === 'manual' ? 'history.autoArchive.modeManual' : 'history.autoArchive.modeAuto')}
                    </span>
                    <span className="auto-archive-panel__record-days">
                      {t('history.autoArchive.daysValueShort', { count: r.days })}
                    </span>
                    <span className="auto-archive-panel__record-count">
                      {t('history.autoArchive.recordCount', { count: r.count })}
                    </span>
                  </button>
                  {open && (
                    <ul className="auto-archive-panel__record-sessions">
                      {r.sessions.map((s) => (
                        <li key={s.sessionId} className="auto-archive-panel__record-session" title={s.sessionId}>
                          <span className="codicon codicon-comment-discussion" />
                          <span className="auto-archive-panel__record-session-title">{s.title}</span>
                        </li>
                      ))}
                      {r.count > r.sessions.length && (
                        <li className="auto-archive-panel__record-session auto-archive-panel__record-session--more">
                          {t('history.autoArchive.sessionsTruncated', { count: r.count - r.sessions.length })}
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
