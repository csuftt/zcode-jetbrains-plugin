/**
 * 运行环境提醒条（主界面顶栏下方，仅异常时渲染）
 *
 * envStatus.allOk=false 时显示：逐条列出 node / zcode.cjs / 凭证的问题与修复提示，
 * 提供「去设置」（直达基础设置→环境子tab）与「重新检测」。
 * 数据源：store envStatus（init checkEnv / envSave 重检 / IDE 广播 onEnvStatusChanged / error 附带）。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import type { EnvStatus } from '@/types/messages'
import '../styles/env-banner.less'

interface Props {
  /** 点击「去设置」：App 切 settings 视图（跳转意图经 store.pendingSettingsSection 传递）*/
  onGoSettings: () => void
}

/** 按优先级把异常环境转成可读问题列表（node → cli → 凭证） */
function collectProblems(status: EnvStatus): { key: string; text: string }[] {
  const problems: { key: string; text: string }[] = []
  if (!status.node.found) {
    problems.push({ key: 'node', text: status.node.error || '' })
  } else if (status.node.versionTooLow) {
    problems.push({ key: 'nodeLow', text: `${status.node.version || '?'}` })
  }
  if (!status.cli.found) {
    problems.push({ key: 'cli', text: status.cli.error || '' })
  }
  if (!status.credentials.ok) {
    problems.push({ key: 'credentials', text: status.credentials.error || '' })
  }
  return problems
}

export function EnvBanner({ onGoSettings }: Props) {
  const { t } = useTranslation()
  const envStatus = useStore((s) => s.envStatus)
  const checkEnv = useStore((s) => s.checkEnv)
  const [checking, setChecking] = useState(false)

  if (!envStatus || envStatus.allOk) return null

  const problems = collectProblems(envStatus)

  const handleRecheck = () => {
    if (checking) return
    setChecking(true)
    checkEnv()
    // envStatus 响应到达即结束转圈（checkEnv 有 30s 缓存，回包很快；兜底 3s）
    setTimeout(() => setChecking(false), 3000)
  }

  return (
    <div className="env-banner" role="alert">
      <span className="codicon codicon-warning env-banner__icon" />
      <div className="env-banner__content">
        <div className="env-banner__title">{t('app.envBanner.title')}</div>
        <ul className="env-banner__problems">
          {problems.map((p) => (
            <li key={p.key} className="env-banner__problem">
              {p.key === 'node' && t('app.envBanner.nodeMissing', { detail: p.text })}
              {p.key === 'nodeLow' &&
                t('app.envBanner.nodeTooLow', { version: p.text, min: envStatus.node.minVersion })}
              {p.key === 'cli' && t('app.envBanner.cliMissing', { detail: p.text })}
              {p.key === 'credentials' && t('app.envBanner.credentialsInvalid', { detail: p.text })}
            </li>
          ))}
        </ul>
      </div>
      <div className="env-banner__actions">
        <button type="button" className="env-banner__btn" onClick={handleRecheck} disabled={checking}>
          <span className={`codicon codicon-refresh${checking ? ' codicon-modifier-spin' : ''}`} />
          {t('app.envBanner.recheck')}
        </button>
        <button type="button" className="env-banner__btn env-banner__btn--primary" onClick={onGoSettings}>
          <span className="codicon codicon-settings-gear" />
          {t('app.envBanner.goSettings')}
        </button>
      </div>
    </div>
  )
}
