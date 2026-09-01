/**
 * 开源与支持区块（其他设置页底部）
 *
 * 参考 cc-gui 设置页 CommunitySection 的 GitHub 引导；主按钮升级为经 openExternal
 * 桥一键调起系统浏览器直达仓库页（cc-gui 仅复制 URL 手动粘贴），次按钮复制地址。
 * 复制反馈走按钮内联状态（文案短暂切换，不引全局 toast——设置页无 toast 通道）。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sendToJava } from '@/ipc/bridge'
import { copyText } from '@/utils/clipboard'

/** 复制与展示用（「打开」走 Java 侧硬编码常量，不由前端传参，零注入面） */
export const GITHUB_REPO_URL = 'https://github.com/csuftt/zcode-jetbrains-plugin'

/** 复制反馈文案停留时长（超时回弹默认文案） */
const COPY_FEEDBACK_MS = 1500

export function StarSupportSection() {
  const { t } = useTranslation()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const restoreTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(restoreTimer.current), [])

  const handleCopy = async () => {
    const ok = await copyText(GITHUB_REPO_URL)
    setCopyState(ok ? 'copied' : 'failed')
    window.clearTimeout(restoreTimer.current)
    restoreTimer.current = window.setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS)
  }

  return (
    <>
      <div className="other-settings__field-header other-settings__field-header--divider">
        <span className="codicon codicon-heart" />
        <span className="other-settings__field-label">{t('settings.other.support.title')}</span>
      </div>
      <p className="other-settings__support-desc">{t('settings.other.support.desc')}</p>
      <div className="other-settings__support-actions">
        <button
          type="button"
          className="other-settings__support-btn other-settings__support-btn--star"
          onClick={() => sendToJava({ op: 'openExternal' })}
        >
          <span className="codicon codicon-github" />
          <span>{t('settings.other.support.starBtn')}</span>
        </button>
        <button type="button" className="other-settings__support-btn" onClick={handleCopy}>
          <span className={`codicon ${copyState === 'copied' ? 'codicon-check' : 'codicon-copy'}`} />
          <span>
            {copyState === 'copied'
              ? t('settings.other.support.copied')
              : copyState === 'failed'
                ? t('settings.other.support.copyFailed')
                : t('settings.other.support.copyBtn')}
          </span>
        </button>
      </div>
    </>
  )
}
