/**
 * copiedMessageClipboard 备份通道测试（纯函数/模块态，无 DOM 依赖）
 *
 * 覆盖：文本全等命中取回全部图片 src / 文本不同或空文本不命中 /
 *       纯图消息（空文本）不登记 / 后复制覆盖前一份 / 多次粘贴不清空
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  stashCopiedMessage,
  matchCopiedMessageImages,
  resetCopiedMessageStash,
} from '../src/utils/copiedMessageClipboard'

describe('copiedMessageClipboard', () => {
  beforeEach(() => resetCopiedMessageStash())

  it('文本全等命中时取回全部图片 src（多图保序）', () => {
    const text = '帮我看看这个报错'
    const srcs = ['data:image/png;base64,AAA', 'http://127.0.0.1:1234/zcode-image/b.png']
    stashCopiedMessage(text, srcs)
    expect(matchCopiedMessageImages(text)).toEqual(srcs)
  })

  it('文本不同不命中（外部复制的内容不误还原）', () => {
    stashCopiedMessage('消息原文', ['data:image/png;base64,AAA'])
    expect(matchCopiedMessageImages('另一段文本')).toBeNull()
  })

  it('空文本不命中（纯图消息不登记，外部截图粘贴不被陈年备份误命中）', () => {
    stashCopiedMessage('', ['data:image/png;base64,AAA'])
    expect(matchCopiedMessageImages('')).toBeNull()
    // 空文本粘贴对任何已登记备份也不命中
    stashCopiedMessage('有文本的消息', ['data:image/png;base64,AAA'])
    expect(matchCopiedMessageImages('')).toBeNull()
  })

  it('无图片 src 不登记（普通文本复制不留备份）', () => {
    stashCopiedMessage('纯文本消息', [])
    expect(matchCopiedMessageImages('纯文本消息')).toBeNull()
  })

  it('后复制覆盖前一份（同文本取最新一组图）', () => {
    stashCopiedMessage('同文本', ['data:image/png;base64,OLD'])
    stashCopiedMessage('同文本', ['data:image/png;base64,NEW1', 'data:image/png;base64,NEW2'])
    expect(matchCopiedMessageImages('同文本')).toEqual([
      'data:image/png;base64,NEW1',
      'data:image/png;base64,NEW2',
    ])
  })

  it('命中不清空备份：同一段内容可连续粘贴多次', () => {
    const srcs = ['data:image/png;base64,AAA']
    stashCopiedMessage('重复贴', srcs)
    expect(matchCopiedMessageImages('重复贴')).toEqual(srcs)
    expect(matchCopiedMessageImages('重复贴')).toEqual(srcs)
  })
})
