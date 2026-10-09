/**
 * 对话结束提醒配置（前端镜像；Kotlin 侧 ZCodeNotifyService 同源解析）
 *
 * 仅系统通知，无提示音、无焦点门控（开启即始终弹）。存储走 persist kv 通道
 * （key=zcode.notify.config）：localStorage 即时生效 + 去抖回存 IDE
 * PropertiesComponent——Kotlin 触发通知时即时读取，无需消息往返。
 *
 * 默认关闭（不弹）；首次改动才落盘。旧配置里的 notifyOnlyUnfocused 字段已废弃，
 * 解析时直接忽略。
 */
import { getPersisted, setPersisted } from './persist'

/** 悬浮弹窗位置（右上角距顶 50px；右下角贴系统 toast 位）*/
export type PopupPosition = 'TOP_RIGHT' | 'BOTTOM_RIGHT'

export interface NotifyConfig {
  /** 对话结束系统通知开关——IDE 内气泡（默认关闭，切走窗口不可见）*/
  notifyEnabled: boolean
  /** 自绘悬浮提醒弹窗开关（默认关闭，全局置顶，全平台可用，仅 IDE 非激活时弹）*/
  popupNotifyEnabled: boolean
  /** 悬浮弹窗时长（秒；0=常驻直到点击/关闭；默认 10）*/
  popupDurationSec: number
  /** 悬浮弹窗位置（默认右上角）*/
  popupPosition: PopupPosition
}

const KEY = 'zcode.notify.config'

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  notifyEnabled: false,
  popupNotifyEnabled: false,
  popupDurationSec: 10,
  popupPosition: 'TOP_RIGHT',
}

export function readNotifyConfig(): NotifyConfig {
  const raw = getPersisted(KEY)
  if (!raw) return { ...DEFAULT_NOTIFY_CONFIG }
  try {
    const obj = JSON.parse(raw) as Partial<NotifyConfig>
    return {
      notifyEnabled:
        typeof obj.notifyEnabled === 'boolean' ? obj.notifyEnabled : DEFAULT_NOTIFY_CONFIG.notifyEnabled,
      popupNotifyEnabled:
        typeof obj.popupNotifyEnabled === 'boolean' ? obj.popupNotifyEnabled : DEFAULT_NOTIFY_CONFIG.popupNotifyEnabled,
      popupDurationSec:
        typeof obj.popupDurationSec === 'number' && Number.isFinite(obj.popupDurationSec) && obj.popupDurationSec >= 0
          ? Math.floor(obj.popupDurationSec)
          : DEFAULT_NOTIFY_CONFIG.popupDurationSec,
      popupPosition:
        obj.popupPosition === 'TOP_RIGHT' || obj.popupPosition === 'BOTTOM_RIGHT'
          ? obj.popupPosition
          : DEFAULT_NOTIFY_CONFIG.popupPosition,
    }
  } catch {
    return { ...DEFAULT_NOTIFY_CONFIG }
  }
}

export function writeNotifyConfig(config: NotifyConfig): void {
  setPersisted(KEY, JSON.stringify(config))
}
