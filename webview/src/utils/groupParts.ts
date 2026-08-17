/**
 * 连续同类工具 part 聚组（cc-gui groupBlocks 移植，见 MessageItem.tsx）
 *
 * 规则：
 *   - 相邻的同类别工具 part 聚成一组（组内 ≥2 个才合并，单个仍走原单卡渲染）
 *   - 类别：bash（Bash）/ read（Read）/ edit（Edit+Write）/ search（Grep+Glob），
 *     对齐 cc-gui toolConstants 的 READ/EDIT/BASH/SEARCH_TOOL_NAMES 分组
 *   - step-start / step-finish 是服务端的步骤边界标记（不渲染），
 *     跳过而不打断连续性——一轮 turn 里每个工具调用都被 step 标记包围，
 *     若不跳过则永远无法成组
 *   - 遇 text / reasoning / 其他类别工具 → 断开当前组（对齐 cc-gui：非同类块 flush）
 *
 * 纯结构规则：流式增量与历史重载对同一 parts 数组产出相同分组。
 */

import type { MessagePart, ToolPart } from '@/types/messages'

export type ToolGroupKind = 'bash' | 'read' | 'edit' | 'search'

/** 工具名 → 分组类别；null = 不参与聚组（TodoWrite/Agent/mcp__* 等走单卡）*/
export function toolGroupKind(tool: string): ToolGroupKind | null {
  switch (tool) {
    case 'Bash': return 'bash'
    case 'Read': return 'read'
    case 'Edit':
    case 'Write': return 'edit'
    case 'Grep':
    case 'Glob': return 'search'
    default: return null
  }
}

export interface ToolGroupUnit {
  kind: 'toolGroup'
  group: ToolGroupKind
  parts: ToolPart[]
  /** 组内首个 part 的原始下标（作 React key，稳定）*/
  startIndex: number
}

export interface SingleUnit {
  kind: 'single'
  part: MessagePart
  index: number
}

export type PartRenderUnit = ToolGroupUnit | SingleUnit

export function groupParts(parts: MessagePart[]): PartRenderUnit[] {
  const units: PartRenderUnit[] = []
  let group: ToolGroupKind | null = null
  let bucket: ToolPart[] = []
  let bucketStart = -1

  const flush = () => {
    if (bucket.length >= 2 && group) {
      units.push({ kind: 'toolGroup', group, parts: [...bucket], startIndex: bucketStart })
    } else if (bucket.length === 1) {
      units.push({ kind: 'single', part: bucket[0], index: bucketStart })
    }
    group = null
    bucket = []
    bucketStart = -1
  }

  parts.forEach((part, idx) => {
    // 步骤边界标记不渲染，不构成内容分隔
    if (part.type === 'step-start' || part.type === 'step-finish') return
    if (part.type === 'tool') {
      const kind = toolGroupKind(part.tool)
      if (kind) {
        // 同类别追加；不同类别 → 收掉旧组再开新组
        if (kind === group) {
          bucket.push(part)
          return
        }
        flush()
        group = kind
        bucket = [part]
        bucketStart = idx
        return
      }
    }
    // 非可组内容（text/reasoning/其他工具）→ 断开当前组，单卡直出
    flush()
    units.push({ kind: 'single', part, index: idx })
  })
  flush()
  return units
}
