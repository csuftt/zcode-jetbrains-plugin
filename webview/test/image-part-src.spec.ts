/**
 * imagePartSrc 图片 src 解析回归（3.18.0 file part url 内联 data: 适配）
 *
 * 缺陷 HF 同日第三形态（2026-11-11 真机反馈）：重启 IDE 后历史带图用户消息图片
 * 全部消失。根因=3.18.0 服务端把 file part 的 url 从 zcode-artifact://（私有协议，
 * Java ImageArtifactMapper 换 /zcode-image/ http）改成直接内联完整
 * data:image/png;base64（artifact 引用挪进 metadata.artifactUri），前端
 * ^https?:// 白名单不认 data: → 返回空 → 静默不渲染（diag-image-file-part-3180.py 实测）。
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { imagePartSrc, collectImageParts } from '@/components/PartUnits'
import type { MessagePart } from '@/types/messages'

describe('imagePartSrc（3.18.0 data: 内联适配）', () => {
  it('3.18.0 file part：data:image URL 放行渲染', () => {
    expect(
      imagePartSrc({ type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }),
    ).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('旧形态 file part：zcode-artifact://（Java 转换失败残留）仍跳过', () => {
    expect(
      imagePartSrc({ type: 'file', mime: 'image/png', url: 'zcode-artifact://sess_x/tool-result-1' }),
    ).toBe('')
  })

  it('Java 转换后的 /zcode-image/ http URL 保持放行', () => {
    expect(
      imagePartSrc({ type: 'file', mime: 'image/png', url: 'http://127.0.0.1:12345/zcode-image/sess_x/image-abc.png' }),
    ).toBe('http://127.0.0.1:12345/zcode-image/sess_x/image-abc.png')
  })

  it('非图片 data:（防御）与空 url 跳过', () => {
    expect(imagePartSrc({ type: 'file', mime: 'image/png', url: 'data:text/html;base64,PGI+' })).toBe('')
    expect(imagePartSrc({ type: 'file', mime: 'image/png' })).toBe('')
  })

  it('image part（乐观消息）：dataUrl / 裸 base64 拼接不变', () => {
    expect(imagePartSrc({ type: 'image', dataUrl: 'data:image/jpeg;base64,AA' })).toBe('data:image/jpeg;base64,AA')
    expect(imagePartSrc({ type: 'image', dataBase64: 'AA', mediaType: 'image/jpeg' })).toBe('data:image/jpeg;base64,AA')
    expect(imagePartSrc({ type: 'image' })).toBe('')
  })
})

describe('collectImageParts（3.18.0 形态收集）', () => {
  it('file part 按 mime image/* 收集（data: 内联不漏收），非图片 file 不收', () => {
    const parts = [
      { type: 'text', text: '带图消息' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBOR' },
      { type: 'file', mime: 'application/pdf', url: 'data:application/pdf;base64,JVBER' },
    ] as unknown as MessagePart[]
    const imgs = collectImageParts(parts)
    expect(imgs).toHaveLength(1)
    expect((imgs[0] as { url?: string }).url).toBe('data:image/png;base64,iVBOR')
  })
})
