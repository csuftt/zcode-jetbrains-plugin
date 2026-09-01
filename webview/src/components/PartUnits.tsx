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
import { ImagePreview } from './ImagePreview'
import type { PartRenderUnit } from '@/utils/groupParts'

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
 */
export function MessageImage({ src, title }: { src: string; title?: string }) {
  const [preview, setPreview] = useState(false)
  return (
    <>
      <img className="msg__image" src={src} alt={title ?? ''} title={title} onClick={() => setPreview(true)} />
      {preview && <ImagePreview src={src} title={title} onClose={() => setPreview(false)} />}
    </>
  )
}

/** 单个 part 的渲染分发 */
export function PartRenderer({
  part,
  autoExpandReasoning,
  streaming,
}: {
  part: MessagePart
  autoExpandReasoning: boolean
  streaming: boolean
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
      return <ToolCallCard part={part} />

    case 'step-start':
    case 'step-finish':
      return null

    default:
      return null
  }
}

/** 渲染分组单元列表（组卡与单卡全覆盖）。units 通常来自 groupParts(parts)。
 *  softenError：子代理弹窗活动 running 期间传 true——组卡 error 工具降级为
 *  「↻ 重试中」中性样式（中间失败重试是常态，红色 ✗ 误导）；主聊天不传保持 ✗。 */
export function renderPartUnits(
  units: PartRenderUnit[],
  parts: MessagePart[],
  streaming?: boolean,
  softenError?: boolean,
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

  return units.map((unit) =>
    unit.kind === 'toolGroup' ? (
      unit.group === 'bash' ? (
        <BashCommandGroupCard key={`bash-${unit.startIndex}`} parts={unit.parts} softenError={softenError} />
      ) : (
        <FileToolGroupCard key={`${unit.group}-${unit.startIndex}`} kind={unit.group} parts={unit.parts} softenError={softenError} />
      )
    ) : (
      <PartRenderer
        key={unit.index}
        part={unit.part}
        autoExpandReasoning={unit.index === lastReasoningIdx && !hasTextAfterLastReasoning}
        streaming={!!streaming && unit.index === lastPartIdx}
      />
    ),
  )
}
