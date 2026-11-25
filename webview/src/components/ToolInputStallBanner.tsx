/**
 * 工具参数流停不下来的提示条（输入框上方）
 *
 * 模型生成某个工具调用的参数时陷入循环（推理和正文都结束了，参数一直往外吐，tool_call
 * 永远不来）：工具不会被执行，界面上只是转圈。这是模型侧的问题，插件治不了本，只负责
 * 说清「卡在哪」并给出停止入口——参数流满 60 秒出现，参数流结束或回合停止即消失。
 * 不自动停止：写很大的文件时参数流也会很长，停不停由用户判断。判定见 utils/toolInputStall。
 */

import { useTranslation } from 'react-i18next'
import { useToolInputStall } from '@/hooks/useToolInputStall'
import { toolDisplayName } from '@/components/ToolCallCard'
import '../styles/tool-input-stall-banner.less'

export function ToolInputStallBanner({ onStop }: { onStop: () => void }) {
  const { t } = useTranslation()
  const stall = useToolInputStall()
  if (!stall) return null

  return (
    <div className="tool-input-stall-banner" role="note">
      <span className="codicon codicon-warning tool-input-stall-banner__icon" />
      <span className="tool-input-stall-banner__text">
        {t('app.toolInputStall.banner', { tool: toolDisplayName(stall.tool, t), seconds: stall.seconds })}
      </span>
      <button type="button" className="tool-input-stall-banner__stop-btn" onClick={onStop}>
        {t('app.toolInputStall.stop')}
      </button>
    </div>
  )
}
