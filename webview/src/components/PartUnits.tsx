/**
 * 消息 part 渲染共享管线（主聊天 AssistantBubble 与子代理详情弹窗共用）
 *
 * 抽取自 MessageBubble（2026-08-31 子代理页面 UI 对齐主界面改造）：单 part 分发
 * （text→MarkdownBlock、reasoning→ThinkingBlock 可折叠、tool→ToolCallCard、
 * image/file→MessageImage）+ 连续同类工具聚组（Bash→BashCommandGroupCard、
 * Read/Edit/Write/Grep/Glob→FileToolGroupCard）+ reasoning 自动展开推导，集中一处
 * 防两套管线漂移（聚组双路径坑：组卡与单卡在此全覆盖）。
 *
 * 子代理弹窗按产品决策**不做完成轮折叠**（保持完整过程展开），searchActive 联动
 * 也不引入——那些语义留在 MessageBubble。
 */

import type { ReactNode } from 'react'
import type { MessagePart, ImagePart, FilePart } from '@/types/messages'
import { useState } from 'react'
import { MarkdownBlock } from './MarkdownBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'
import { BashCommandGroupCard } from './BashCommandGroupCard'
import { FileToolGroupCard } from './FileToolGroupCard'
import { CuaActionGroupCard } from './CuaActionGroupCard'
import { ImagePreview } from './ImagePreview'
import type { PartRenderUnit } from '@/utils/groupParts'
import { isCuaTool, cuaIconKeyFromOutput } from '@/utils/cuaTools'
import { selectionMark } from '@/utils/conversationSelections'
import type { SelectionContentType } from '@/utils/conversationSelections'

/**
 * user 消息的图片 part 收集：乐观消息（type:'image'）与服务端读回
 * （type:'file' + mime image/*，2026-08-26 RPC 实测形态）两种形态统一收集。
 */
export function collectImageParts(parts: MessagePart[]): Array<ImagePart | FilePart> {
  return parts.filter((p): p is ImagePart | FilePart =>
    p.type === 'image' || (p.type === 'file' && (p.mime ?? '').startsWith('image/')),
  )
}

/** 图片 part → 可渲染 src：image 用 dataUrl/拼 base64；file 用 url（Java 已换成 http）*/
export function imagePartSrc(img: ImagePart | FilePart): string {
  if (img.type === 'image') {
    if (img.dataUrl) return img.dataUrl
    if (img.dataBase64) return `data:${img.mediaType || 'image/png'};base64,${img.dataBase64}`
    return ''
  }
  // file part：zcode-artifact://（Java 未转换/转换失败）不可渲染，返回空跳过
  return img.url && /^https?:\/\//.test(img.url) ? img.url : ''
}

/** 图片 part 的展示标题（hover/大图预览）*/
export function imagePartTitle(img: ImagePart | FilePart): string | undefined {
  if (img.type === 'image') return img.source?.filename ?? img.source?.placeholder
  return img.filename ?? (img.metadata?.image as Record<string, unknown> | undefined)?.filename as string | undefined
}

/**
 * 消息内图片（限宽圆角，点击大图预览）。主聊天 user 气泡与 part 渲染共用。
 * onOpen：多图场景由父组件接管打开动作（在整个图片组内左右切换），不传走单图预览。
 */
export function MessageImage({
  src,
  title,
  onOpen,
}: {
  src: string
  title?: string
  onOpen?: () => void
}) {
  const [preview, setPreview] = useState(false)
  return (
    <>
      <img
        className="msg__image"
        src={src}
        alt={title ?? ''}
        title={title}
        onClick={() => (onOpen ? onOpen() : setPreview(true))}
      />
      {preview && <ImagePreview src={src} title={title} onClose={() => setPreview(false)} />}
    </>
  )
}

/** 单个 part 的渲染分发 */
export function PartRenderer({
  part,
  autoExpandReasoning,
  streaming,
  cuaIconKey,
}: {
  part: MessagePart
  autoExpandReasoning: boolean
  streaming: boolean
  /** 会话内最近一次解析到的 CUA 应用图标 key（动作类工具卡自身无 app 信号时兜底）*/
  cuaIconKey?: string | null
}) {
  switch (part.type) {
    case 'text':
      return <MarkdownBlock markdown={part.text} streaming={streaming} />

    case 'image':
    case 'file': {
      // file part：仅 image/* 是图片（Java 已把 url 换成 http；非图片/未转换返回 null）
      if (part.type === 'file' && !(part.mime ?? '').startsWith('image/')) return null
      const src = imagePartSrc(part)
      if (!src) return null
      return <MessageImage src={src} title={imagePartTitle(part)} />
    }

    case 'reasoning':
      // 自动展开：思考还在进行中或刚结束还没正文。正文出现后自动折叠。
      // streaming（本 part 是流式中最后一个 part）驱动思考耗时跳动计时
      return <ThinkingBlock part={part} autoExpand={autoExpandReasoning} streaming={streaming} />

    case 'tool':
      return <ToolCallCard part={part} cuaIconKey={cuaIconKey} />

    case 'step-start':
    case 'step-finish':
      return null

    default:
      return null
  }
}

/**
 * 渲染分组单元列表（组卡与单卡全覆盖）。units 通常来自 groupParts(parts)。
 * softenError：子代理弹窗活动 running 期间传 true——组卡 error 工具降级为
 * 「↻ 重试中」中性样式（中间失败重试是常态，红色 ✗ 误导）；主聊天不传保持 ✗。
 * selectionCtx：划词引用行标记（调研 ⑩，主聊天传 { messageId }，子代理弹窗不传）——
 * 每个可引用单元包一层 display:contents 的标记层（零布局影响，纯 DOM 归属锚点）：
 * data-selection-id=`{messageId}-{unitIndex}`、data-selection-type 按 part kind
 * 映射（text→assistant / reasoning→reasoning / tool→tool，图片不可引用不打标）。
 * 聚组渲染双路径：组卡与单卡都进标记（项目老坑，两路径同拍处理）。
 */
export function renderPartUnits(
  units: PartRenderUnit[],
  parts: MessagePart[],
  streaming?: boolean,
  softenError?: boolean,
  selectionCtx?: { messageId: string },
): ReactNode[] {
  // 最后一个 reasoning 的自动展开推导：其后尚无正文（思考进行中/刚结束）才展开
  let lastReasoningIdx = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'reasoning') { lastReasoningIdx = i; break }
  }
  const hasTextAfterLastReasoning = lastReasoningIdx >= 0
    ? parts.slice(lastReasoningIdx + 1).some((p) => p.type === 'text')
    : false
  const lastPartIdx = parts.length - 1

  // CUA 应用图标顺扫：icon key 只在 list_apps/get_app_state/list_windows 的结果里
  // 出现，动作类工具（click/type/...）卡自身无 app 信号——同消息内「最近一次解析
  // 到的 key」兜底（text/reasoning 不打断继承；每 part 记录的是它之前的继承值，
  // 自带 key 的卡由 ToolCallCard 自行优先取 own）
  const cuaIconByIndex = new Map<number, string | null>()
  let curCuaIcon: string | null = null
  parts.forEach((p, idx) => {
    cuaIconByIndex.set(idx, curCuaIcon)
    if (p.type === 'tool' && isCuaTool(p.tool)) {
      const own = cuaIconKeyFromOutput(p.state.output)
      if (own) curCuaIcon = own
    }
  })

  return units.map((unit) => {
    const node =
      unit.kind === 'toolGroup' ? (
        unit.group === 'bash' ? (
          <BashCommandGroupCard key={`bash-${unit.startIndex}`} parts={unit.parts} softenError={softenError} />
        ) : unit.group === 'cua' ? (
          <CuaActionGroupCard
            key={`cua-${unit.startIndex}`}
            parts={unit.parts}
            softenError={softenError}
            cuaIconKey={cuaIconByIndex.get(unit.startIndex) ?? null}
          />
        ) : (
          <FileToolGroupCard key={`${unit.group}-${unit.startIndex}`} kind={unit.group} parts={unit.parts} softenError={softenError} />
        )
      ) : (
        <PartRenderer
          key={unit.index}
          part={unit.part}
          autoExpandReasoning={unit.index === lastReasoningIdx && !hasTextAfterLastReasoning}
          streaming={!!streaming && unit.index === lastPartIdx}
          cuaIconKey={unit.part.type === 'tool' && isCuaTool(unit.part.tool) ? cuaIconByIndex.get(unit.index) ?? null : null}
        />
      )
    if (!selectionCtx) return node
    // 划词行标记层：display:contents 对布局零影响（子元素直接参与父级排版），
    // 只承担 DOM 归属（hook 的 closest 反查）。图片/file part 不可引用不打标。
    const idx = unit.kind === 'toolGroup' ? unit.startIndex : unit.index
    const contentType: SelectionContentType | null =
      unit.kind === 'toolGroup'
        ? 'tool'
        : unit.part.type === 'text'
          ? 'assistant'
          : unit.part.type === 'reasoning'
            ? 'reasoning'
            : unit.part.type === 'tool'
              ? 'tool'
              : null
    if (!contentType) return node
    return (
      <div
        key={`selrow-${idx}`}
        style={{ display: 'contents' }}
        {...selectionMark(`${selectionCtx.messageId}-${idx}`, contentType)}
      >
        {node}
      </div>
    )
  })
}
