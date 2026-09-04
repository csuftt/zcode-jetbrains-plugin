/**
 * /goal 命令文本解析（goalCommand.ts）——手动输入与定时消息共用的拦截语义
 */

import { describe, it, expect } from 'vitest'
import { parseGoalCommand } from '@/utils/goalCommand'

describe('parseGoalCommand', () => {
  it('无参 /goal → show', () => {
    expect(parseGoalCommand('/goal')).toEqual({ action: 'show' })
    expect(parseGoalCommand('/goal ')).toEqual({ action: 'show' })
    expect(parseGoalCommand('/goal\n')).toEqual({ action: 'show' })
  })

  it('子命令（大小写不敏感）→ pause/resume/clear', () => {
    expect(parseGoalCommand('/goal pause')).toEqual({ action: 'pause' })
    expect(parseGoalCommand('/goal PAUSE')).toEqual({ action: 'pause' })
    expect(parseGoalCommand('/goal Resume')).toEqual({ action: 'resume' })
    expect(parseGoalCommand('/goal clear')).toEqual({ action: 'clear' })
  })

  it('其余文本 → set + objective（多行/前后空白容忍）', () => {
    expect(parseGoalCommand('/goal 修复登录页崩溃')).toEqual({ action: 'set', objective: '修复登录页崩溃' })
    expect(parseGoalCommand('/goal  第一行\n第二行 ')).toEqual({ action: 'set', objective: '第一行\n第二行' })
  })

  it('非命令文本 → null（含前缀混入/近似词，不误伤）', () => {
    expect(parseGoalCommand('早安摘要')).toBeNull()
    expect(parseGoalCommand('/goal和别的')).toBeNull()
    expect(parseGoalCommand('先跑 /goal')).toBeNull()
    expect(parseGoalCommand('/goals')).toBeNull()
    expect(parseGoalCommand('')).toBeNull()
    expect(parseGoalCommand('/compact')).toBeNull()
    // 粘贴折叠形态：长目标提示词拼在正文后（InputBox pastedTexts 拼接形态），
    // 只要整条消息是 goal 命令就拦截（0.3.2 真机反馈的行为保持）
    expect(parseGoalCommand('/goal 长目标\n\n[附图说明：本消息附带 1 张图片。]')).toEqual({
      action: 'set',
      objective: '长目标\n\n[附图说明：本消息附带 1 张图片。]',
    })
  })
})
