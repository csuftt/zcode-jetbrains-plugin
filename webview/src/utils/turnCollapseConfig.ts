/**
 * 完成轮自动折叠配置（设置→基础设置→行为）
 *
 * 开启（默认）：非流式的完整对话轮默认只渲染最终结论，执行过程折叠，
 * 点「执行过程」折叠栏展开；关闭：轮次完整展开，仍可点折叠栏手动收起。
 *
 * 存储走 persist kv 通道（key=zcode.turnCollapse.config）。消费方在消息
 * 渲染时读取——设置视图切换会卸载/重挂 ChatView，回到聊天页即应用新值；
 * KV_HYDRATED_EVENT / storage 事件兜底启动水合与多标签同步。
 */
import { getPersisted, setPersisted } from './persist'

export interface TurnCollapseConfig {
  /** 完成轮自动折叠执行过程（默认开启）*/
  autoCollapse: boolean
}

const KEY = 'zcode.turnCollapse.config'

export const DEFAULT_TURN_COLLAPSE_CONFIG: TurnCollapseConfig = {
  autoCollapse: true,
}

export function readTurnCollapseConfig(): TurnCollapseConfig {
  const raw = getPersisted(KEY)
  if (!raw) return { ...DEFAULT_TURN_COLLAPSE_CONFIG }
  try {
    const obj = JSON.parse(raw) as Partial<TurnCollapseConfig>
    return {
      autoCollapse:
        typeof obj.autoCollapse === 'boolean' ? obj.autoCollapse : DEFAULT_TURN_COLLAPSE_CONFIG.autoCollapse,
    }
  } catch {
    return { ...DEFAULT_TURN_COLLAPSE_CONFIG }
  }
}

export function writeTurnCollapseConfig(config: TurnCollapseConfig): void {
  setPersisted(KEY, JSON.stringify(config))
}
