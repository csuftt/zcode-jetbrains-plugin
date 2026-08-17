/**
 * 通用 kv 持久化通道（配置类 localStorage 的统一替代）
 *
 * 背景：生产模式内置 server 端口随机 → origin 每次重启变化 → localStorage 按 origin
 * 隔离，所有配置（搜索开关/输入历史/模型记忆/思考级别/会话标题/上下文构成）重启即丢。
 * 与外观配置（utils/appearance.ts，结构化单独通道）同理，权威源迁到 IDE 侧
 * PropertiesComponent：
 *   - 启动时 Java 经 buildBridgeJs 注入 window.__ZCODE_KVSTORE__（string→string map），
 *     initPersist() 轮询等待后写回 localStorage（组件读取即得）；
 *   - 变更时去抖全量回存（op=kvSave），IDE 侧整体覆盖；
 *   - localStorage 保留为会话内缓存 + 多标签 storage 事件实时同步（dev mock 下即权威源）。
 *
 * 存储域约定：key 以 `zcode.` 或 `zcode-` 开头（外观配置的 5 个 key 除外，走独立通道）。
 */

import { sendToJava, isInJcef } from '@/ipc/bridge'

/** 外观配置专用 key（由 appearance.ts 通道管理，kv 回存时排除）*/
const APPEARANCE_KEYS = new Set([
  'zcode-theme-pref',
  'zcode.fontScale',
  'zcode.chatBgColor',
  'zcode.userMsgColor',
  'zcode.chatBarColor',
])

/** 注入的权威 kv（buildBridgeJs 生成；无配置为 null）*/
declare global {
  interface Window {
    __ZCODE_KVSTORE__?: Record<string, string> | null
  }
}

function inPersistDomain(key: string): boolean {
  return (key.startsWith('zcode.') || key.startsWith('zcode-')) && !APPEARANCE_KEYS.has(key)
}

/** 读取（localStorage 即注入写回后的缓存；不可用时返回 null）*/
export function getPersisted(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 写入：localStorage 立即生效 + JCEF 内去抖全量回存 IDE */
export function setPersisted(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    return // localStorage 不可用：仅放弃持久化，内存态由调用方自理
  }
  scheduleKvFlush()
}

/** 删除：localStorage 移除 + 去抖回存 */
export function removePersisted(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    return
  }
  scheduleKvFlush()
}

/** 枚举 persist 域内指定前缀的条目（LRU 淘汰扫描等用）*/
export function entriesWithPrefix(prefix: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (!k || !k.startsWith(prefix) || !inPersistDomain(k)) continue
      out.push({ key: k, value: window.localStorage.getItem(k) ?? '' })
    }
  } catch {
    /* localStorage 不可用：返回已收集部分 */
  }
  return out
}

/* ============ IDE 回存（去抖全量） ============ */

let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleKvFlush(): void {
  if (!isInJcef()) return // mock/dev：localStorage 即权威源
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      const entries: Record<string, string> = {}
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i)
        if (!k || !inPersistDomain(k)) continue
        entries[k] = window.localStorage.getItem(k) ?? ''
      }
      sendToJava({ op: 'kvSave', entries })
    } catch {
      /* 回存失败静默：会话内不受影响，仅重启回退 */
    }
  }, 500)
}

/* ============ 启动恢复 ============ */

/**
 * 启动恢复（main.tsx render 前调用）：
 * JCEF 内等待注入的权威 kv（onLoadStart 注入通常早于本模块；executeJavaScript 时序
 * 不保证，轮询兜底 2s），到达后写回 localStorage（仅写注入中存在的 key）。
 * 注入为权威源：与 localStorage 冲突时以 IDE 侧为准。
 */
export function initPersist(): void {
  if (!isInJcef()) return
  let retries = 0
  const poll = () => {
    const kv = window.__ZCODE_KVSTORE__
    if (kv) {
      try {
        Object.entries(kv).forEach(([k, v]) => {
          if (typeof v === 'string') window.localStorage.setItem(k, v)
        })
      } catch {
        /* localStorage 不可用：保持现状 */
      }
      return
    }
    if (++retries <= 40) setTimeout(poll, 50)
  }
  poll()
}
