/**
 * 运行环境提醒条（主界面顶栏下方，仅异常时渲染）
 *
 * 只保留阻断档（allOk=false）：node / zcode.cjs 问题，插件暂不可用，warning 色。
 * browserHost 等非阻断项不再上横幅（用户反馈：对话功能不受影响却每次启动都弹，
 * 很扰民）——降级状态收敛到 设置→浏览器 的控制卡片内常驻提示，左侧浏览器图标同步置灰。
 * 提供「去设置」（直达基础设置→环境子tab）与「重新检测」（触发宿主自愈重探）。
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

export function EnvBanner({ onGoSettings }: Props) {
  const { t } = useTranslation()
  const envStatus = useStore((s) => s.envStatus)
  const checkEnv = useStore((s) => s.checkEnv)
  const [checking, setChecking] = useState(false)

  if (!envStatus) return null
  const problems = envStatus.allOk ? [] : collectProblems(envStatus)
  if (problems.length === 0) return null

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
