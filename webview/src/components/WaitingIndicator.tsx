/**
 * 等待指示器
 *
 * 规划文档第四节：
 *   ⊙ GLM-5.2 正在生成响应...（已 12 秒）
 *   - CSS 旋转圆环 spinner
 *   - 三个跳动省略号（500ms 切换 . → .. → ...）
 *   - 计时器用绝对时间差算（跨视图切换不重置）
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { elapsedDesc } from '@/utils/time'
import '../styles/waiting-indicator.less'

interface Props {
  /** 开始等待的时间戳（毫秒）。不传则不显示计时 */
  since?: number
}

export function WaitingIndicator({ since }: Props) {
  const { t } = useTranslation()
  const currentModel = useStore((s) => s.currentModel)
  const messages = useStore((s) => s.messages)
  const [, force] = useState(0)

  // 每 500ms 重渲染（更新省略号 + 计时）
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [])

  // 模型名优先取 currentModel，回退最后一条 assistant 消息的 modelID
  const modelName = currentModel?.modelId
    ?? (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i].info.modelID
        if (m) return m
      }
      return null
    })()

  const dots = '.'.repeat(Math.floor(Date.now() / 500) % 3 + 1)
  const elapsed = since ? elapsedDesc(since) : ''

  return (
    <div className="waiting">
      <div className="waiting__spinner" />
      <span className="waiting__text">
        {(modelName ? t('common.waiting.generatingWithModel', { model: modelName }) : t('common.waiting.generating'))}{dots}
      </span>
      {elapsed && <span className="waiting__time">{t('common.waiting.elapsed', { time: elapsed })}</span>}
    </div>
  )
}
