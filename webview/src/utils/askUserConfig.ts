/**
 * 「提问自动继续」配置（插件自有配置，与 ZCode 客户端 setting.json 不同源）
 *
 * 开启后 Agent 提问 5 分钟未回答自动继续；默认关闭=一直等待回答（提问弹窗无
 * 倒计时、不会自动关闭）。存储走 persist kv 通道（key=zcode.askUser.config）：
 * localStorage 即时生效 + 去抖回存 IDE PropertiesComponent——Kotlin 侧
 * （ZCodeAskUserConfig）在反向请求与 requestRuntimePreferences 应答时即时读取，
 * 无需消息往返。
 */
import { getPersisted, setPersisted } from './persist'

export interface AskUserAutoConfig {
  /** 提问自动继续开关（默认关闭=一直等待）*/
  autoContinueEnabled: boolean
}

const KEY = 'zcode.askUser.config'

export const DEFAULT_ASK_USER_AUTO_CONFIG: AskUserAutoConfig = {
  autoContinueEnabled: false,
}

export function readAskUserAutoConfig(): AskUserAutoConfig {
  const raw = getPersisted(KEY)
  if (!raw) return { ...DEFAULT_ASK_USER_AUTO_CONFIG }
  try {
    const obj = JSON.parse(raw) as Partial<AskUserAutoConfig>
    return {
      autoContinueEnabled:
        typeof obj.autoContinueEnabled === 'boolean'
          ? obj.autoContinueEnabled
          : DEFAULT_ASK_USER_AUTO_CONFIG.autoContinueEnabled,
    }
  } catch {
    return { ...DEFAULT_ASK_USER_AUTO_CONFIG }
  }
}

export function writeAskUserAutoConfig(config: AskUserAutoConfig): void {
  setPersisted(KEY, JSON.stringify(config))
}
