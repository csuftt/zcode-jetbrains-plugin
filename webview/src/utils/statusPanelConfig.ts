/**
 * 底部状态栏折叠态持久化（用户定稿：跨标签共享 + 重启恢复）
 *
 * 存储走 persist kv 通道（key=zcode.statusPanel.config）：权威源在 IDE
 * PropertiesComponent，localStorage 为缓存（生产 origin 每次重启变化，
 * 水合前 localStorage 为空/旧值——store 初值可能不准，须等 KV_HYDRATED
 * 事件重读校正，同 steerMarkers/enhanceConfig 的迟水合模式）。
 * 新标签打开时经 initPersist 水合读 PropertiesComponent 最新值。
 */
import { getPersisted, setPersisted } from './persist'

export interface StatusPanelConfig {
  /** 底部状态栏（任务/子代理/文件）是否折叠（默认展开）*/
  collapsed: boolean
}

const KEY = 'zcode.statusPanel.config'

export const DEFAULT_STATUS_PANEL_CONFIG: StatusPanelConfig = {
  collapsed: false,
}

export function readStatusPanelConfig(): StatusPanelConfig {
  const raw = getPersisted(KEY)
  if (!raw) return { ...DEFAULT_STATUS_PANEL_CONFIG }
  try {
    const obj = JSON.parse(raw) as Partial<StatusPanelConfig>
    return {
      collapsed: typeof obj.collapsed === 'boolean' ? obj.collapsed : DEFAULT_STATUS_PANEL_CONFIG.collapsed,
    }
  } catch {
    return { ...DEFAULT_STATUS_PANEL_CONFIG }
  }
}

export function writeStatusPanelConfig(config: StatusPanelConfig): void {
  setPersisted(KEY, JSON.stringify(config))
}
