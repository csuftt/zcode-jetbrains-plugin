/**
 * 通用 kv 持久化通道（配置类 localStorage 的统一替代）
 *
 * 背景：生产模式内置 server 端口随机 → origin 每次重启变化 → localStorage 按 origin
 * 隔离，所有配置（搜索开关/输入历史/模型记忆/思考级别/会话标题/上下文构成）重启即丢。
 * 与外观配置（utils/appearance.ts，结构化单独通道）同理，权威源迁到 IDE 侧
 * PropertiesComponent：
 *   - 启动时 Java 经 buildBridgeJs 注入 window.__ZCODE_KVSTORE__（string→string map），
 *     initPersist() 轮询等待后写回 localStorage（组件读取即得）；
 *   - 变更时去抖增量回存（op=kvSave，entries=本会话改过的 key + deletes=删过的 key），
 *     IDE 侧 merge upsert（不整体覆盖）；
 *   - localStorage 保留为会话内缓存 + 多标签 storage 事件实时同步（dev mock 下即权威源）。
 *
 * 存储域约定：key 以 `zcode.` 或 `zcode-` 开头（外观配置的 5 个 key 除外，走独立通道）。
 *
 * 增量提交语义（2026-08-17 修复：重装插件后存量被清空）：
 * 旧实现去抖后扫描 localStorage 全量、IDE 侧整体覆盖。重装/新 origin 下 localStorage
 * 为空，注入写回若未完成（或未到达）即触发全量 flush → 权威源被空快照覆盖，存量输入
 * 历史等全部丢失（实测复现：other.xml kvstore 只剩当日新写入的几个 key）。修复为：
 *   1. 只提交本会话实际修改/删除过的 key（脏集合），未触碰的 key 永不下发——结构上
 *      不可能把存量"冲掉"；
 *   2. 注入写回完成（hydration）前挂起 flush：超时未注入则本会话放弃持久化（宁丢增量，
 *      不清存量）；
 *   3. IDE 侧 handleKvSave 配套改为 merge upsert + 显式 deletes。
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

/* ============ 脏集合（本会话改动过的 key；增量提交的数据源） ============ */

const dirtyKeys = new Set<string>()
const deletedKeys = new Set<string>()

/** 写入：localStorage 立即生效 + 去抖增量回存 IDE */
export function setPersisted(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    return // localStorage 不可用：仅放弃持久化，内存态由调用方自理
  }
  if (inPersistDomain(key)) {
    dirtyKeys.add(key)
    deletedKeys.delete(key)
    scheduleKvFlush()
  }
}

/** 删除：localStorage 移除 + 去抖回存（IDE 侧显式删除该 key）*/
export function removePersisted(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    return
  }
  if (inPersistDomain(key)) {
    deletedKeys.add(key)
    dirtyKeys.delete(key)
    scheduleKvFlush()
  }
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

/* ============ IDE 回存（去抖增量 upsert + deletes） ============ */

let flushTimer: ReturnType<typeof setTimeout> | null = null

/** hydration 状态：注入写回完成前挂起 flush（防"空 localStorage 全量覆盖"清空存量）*/
let kvHydrated = false

function scheduleKvFlush(): void {
  if (!isInJcef()) return // mock/dev：localStorage 即权威源
  if (!kvHydrated) return // 注入未写回：本会话改动挂起，hydration 完成后补发
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      const entries: Record<string, string> = {}
      for (const k of dirtyKeys) {
        let v: string | null = null
        try {
          v = window.localStorage.getItem(k)
        } catch {
          /* 忽略单个 key 读取失败 */
        }
        if (v !== null) entries[k] = v // 已被删的跳过（deletes 携带）
      }
      const deletes = [...deletedKeys]
      if (!Object.keys(entries).length && !deletes.length) return
      sendToJava({ op: 'kvSave', entries, ...(deletes.length ? { deletes } : {}) })
      Object.keys(entries).forEach((k) => dirtyKeys.delete(k))
      deletes.forEach((k) => deletedKeys.delete(k))
    } catch {
      /* 回存失败静默：会话内不受影响，仅重启回退 */
    }
  }, 500)
}

/* ============ 启动恢复 ============ */

/**
 * 启动恢复（main.tsx render 前调用）：
 * JCEF 内等待注入的权威 kv（onLoadStart 注入通常早于本模块；executeJavaScript 时序
 * 不保证，轮询兜底 2s），到达后写回 localStorage（仅写注入中存在的 key），
 * 随后放行挂起的增量 flush。
 * 注入为权威源：与 localStorage 冲突时以 IDE 侧为准。
 * 超时未注入（异常场景）：不置 kvHydrated，本会话放弃回存——localStorage 不是权威
 * 快照，若放行 flush 会把 IDE 存量冲掉（重装清空事故的根因，宁丢增量不清存量）。
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
      kvHydrated = true
      if (flushTimer || dirtyKeys.size || deletedKeys.size) scheduleKvFlush()
      return
    }
    if (++retries <= 40) {
      setTimeout(poll, 50)
    } else {
      console.warn('[persist] __ZCODE_KVSTORE__ 注入 2s 未到达，本会话停用 kv 回存（防覆盖存量）')
    }
  }
  poll()
}
