/**
 * 运行环境提醒条（主界面顶栏下方，仅异常时渲染）
 *
 * 两档：
 * - 阻断（allOk=false）：node / zcode.cjs 问题，插件暂不可用，warning 色；
 * - 建议（allOk=true 但有 advisory 项）：凭证降级（对话走 ZCode 客户端登录态）、
 *   AI 浏览器工具不可用等，均不影响对话，info 色。
 * 提供「去设置」（直达基础设置→环境子tab）与「重新检测」（后者会触发宿主自愈重探）。
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

/** 按优先级把异常环境转成可读问题列表（node → cli；凭证已降级为非阻断，不在此列） */
function collectProblems(status: EnvStatus): { key: string; code?: string; arg?: string; text: string }[] {
  const problems: { key: string; code?: string; arg?: string; text: string }[] = []
  if (!status.node.found) {
    problems.push({ key: 'node', code: status.node.code, arg: status.node.arg, text: status.node.error || '' })
  } else if (status.node.versionTooLow) {
    problems.push({ key: 'nodeLow', text: `${status.node.version || '?'}` })
  }
  if (!status.cli.found) {
    problems.push({ key: 'cli', code: status.cli.code, arg: status.cli.arg, text: status.cli.error || '' })
  }
  return problems
}

/** 凭证降级告警（oauth 登录无明文 key 时对话改走 app-server 自身凭证链）；健康为 null */
function credentialsAdvisory(status: EnvStatus): boolean {
  return !status.credentials.ok
}

/** browserHost 非阻断告警（未探测/健康时为 null）；渲染只按 code 选文案 */
function browserHostProblem(status: EnvStatus): { code?: string } | null {
  const bh = status.browserHost
  if (!bh || bh.ok) return null
  return { code: bh.code }
}

export function EnvBanner({ onGoSettings }: Props) {
  const { t } = useTranslation()
  const envStatus = useStore((s) => s.envStatus)
  const checkEnv = useStore((s) => s.checkEnv)
  const [checking, setChecking] = useState(false)
  // advisory 档（凭证降级/browserHost）会话内可手动关闭；阻断档（node/cli）不可关——
  // 那是真不可用，关了用户更困惑。不持久化：重启 IDE 再提示一次（凭证仍异常时）
  const [dismissed, setDismissed] = useState(false)

  if (!envStatus) return null
  const problems = envStatus.allOk ? [] : collectProblems(envStatus)
  const credAdvisory = envStatus.allOk && credentialsAdvisory(envStatus)
  const hostWarning = envStatus.allOk ? browserHostProblem(envStatus) : null
  if (problems.length === 0 && !credAdvisory && !hostWarning) return null

  // 阻断档沿用 warning 色；纯 advisory 档（凭证降级/browserHost）换 info 色（不吓用户，对话功能正常）
  const advisory = problems.length === 0
  if (advisory && dismissed) return null

  const handleRecheck = () => {
    if (checking) return
    setChecking(true)
    checkEnv()
    // envStatus 响应到达即结束转圈（checkEnv 有 30s 缓存，回包很快；兜底 3s）
    setTimeout(() => setChecking(false), 3000)
  }

  return (
    <div className={`env-banner${advisory ? ' env-banner--advisory' : ''}`} role="alert">
      <span className={`codicon ${advisory ? 'codicon-info' : 'codicon-warning'} env-banner__icon`} />
      <div className="env-banner__content">
        <div className="env-banner__title">
          {advisory ? t('app.envBanner.advisoryTitle') : t('app.envBanner.title')}
        </div>
        <ul className="env-banner__problems">
          {problems.map((p) => {
            // 详情按 Java 侧错误码走 i18n（英文环境不再露中文）；无码（旧包/未知）回退原文
            const detail = p.code
              ? t(`app.envErrors.${p.code}`, { arg: p.arg ?? '' })
              : p.text
            return (
              <li key={p.key} className="env-banner__problem">
                {p.key === 'node' && t('app.envBanner.nodeMissing', { detail })}
                {p.key === 'nodeLow' &&
                  t('app.envBanner.nodeTooLow', { version: p.text, min: envStatus.node.minVersion })}
                {p.key === 'cli' && t('app.envBanner.cliMissing', { detail })}
              </li>
            )
          })}
          {credAdvisory && (
            <li className="env-banner__problem">{t('app.envBanner.credsDegraded')}</li>
          )}
          {hostWarning && (
            <li className="env-banner__problem">
              {hostWarning.code === 'browserHostCefDown'
                ? t('app.envBanner.browserHostCefDown')
                : t('app.envBanner.browserHostHandlerMissing')}
            </li>
          )}
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
        {advisory && (
          <button
            type="button"
            className="env-banner__btn"
            onClick={() => setDismissed(true)}
            title={t('app.envBanner.dismiss')}
            aria-label={t('app.envBanner.dismiss')}
          >
            <span className="codicon codicon-close" />
          </button>
        )}
      </div>
    </div>
  )
}
