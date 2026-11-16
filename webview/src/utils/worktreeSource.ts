/**
 * 托管根副本目录 → 源工作区解析（缺陷HQ 待命落位归一，webview 侧）
 *
 * 数据源两路，按「同步优先、RPC 兜底」顺序：
 * 1. worktree 元数据映射（列表已注入的 worktreeRoot/cwd → sourceWorkspace）：纯本地、
 *    零延迟——副本作用域待命/新建会话时徽标不闪「worktree 目录 → 项目目录」；
 * 2. worktreeState 反解（Java git 反解 --git-common-dir 权威，带回显匹配键 resolvedFor，
 *    仅探测目录==当前落位目录时采信）：覆盖列表尚未加载/元数据缺失的桌面端副本。
 *
 * 归一比较：统一分隔符、去尾斜杠、Windows 大小写折叠（与 Java 侧 normalize 同口径）。
 */
import type { WorktreeMeta } from '@/types/messages'

export interface StandbySourceContext {
  activeWorkspacePath?: string
  projectPath?: string
  worktreeStandby?:
    | { supported: boolean; gitOk: boolean; sourceWorkspace?: string; resolvedFor?: string }
    | null
  worktreeMetaBySession?: Record<string, WorktreeMeta>
}

/** 路径归一比较键（分隔符/尾斜杠/大小写） */
export function normalizeWsPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 当前待命落位目录 → 源工作区（未命中返回 undefined=普通目录/关联目录原样）。
 * @param ws 候选落位目录（缺省取 activeWorkspacePath || projectPath）
 */
export function resolveWorktreeSource(st: StandbySourceContext | null | undefined, ws?: string): string | undefined {
  if (!st) return undefined
  const dir = ws || st.activeWorkspacePath || st.projectPath
  if (!dir) return undefined
  const dirNorm = normalizeWsPath(dir)
  // 1) 元数据映射（同步）：worktreeRoot 精确命中，或落位目录在某个副本根之下
  const metas = st.worktreeMetaBySession
  if (metas) {
    for (const meta of Object.values(metas)) {
      if (!meta?.sourceWorkspace || !meta.worktreeRoot) continue
      const rootNorm = normalizeWsPath(meta.worktreeRoot)
      if (dirNorm === rootNorm || dirNorm.startsWith(`${rootNorm}/`)) return meta.sourceWorkspace
    }
  }
  // 2) worktreeState 反解（匹配键守卫：探测回显目录==当前落位目录才采信，防切目录串台）
  const standby = st.worktreeStandby
  if (standby?.sourceWorkspace && standby.resolvedFor && normalizeWsPath(standby.resolvedFor) === dirNorm) {
    return standby.sourceWorkspace
  }
  return undefined
}