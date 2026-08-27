/**
 * 凭证降级 EnvBanner 展示测试（issue #4）
 *
 * 背景：oauth 账号登录的凭证为加密存储，config.json 无明文 apiKey。凭证读取失败
 * 不再阻断启动（裸启走 app-server 自身凭证链），仅以 advisory（info 色）提示：
 * - node/cli 正常 + 凭证失败（allOk=true）→ advisory 档（advisoryTitle + credsDegraded），
 *   不显示阻断标题「插件暂不可用」
 * - node 失败 + 凭证失败（allOk=false）→ 阻断档只列 node，凭证不进阻断列表
 * - 全部健康 → 不渲染
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

let messageHandler: ((msg: unknown) => void) | null = null

vi.mock('@/ipc/bridge', () => ({
  initBridge: () => {},
  isInJcef: () => false,
  getWorkspacePath: () => 'G:\\mock',
  getInitialSessionId: () => '',
  onMessage: (fn: (msg: unknown) => void) => { messageHandler = fn },
  onStreamEvent: () => {},
  onStreamBatch: () => {},
  sendToJava: () => {},
}))

import { EnvBanner } from '@/components/EnvBanner'
import { useStore } from '@/store/useStore'
import type { EnvStatus } from '@/types/messages'

const okNode = {
  configured: false, found: true, path: 'C:\\node.exe',
  version: 'v20.11.1', versionTooLow: false, minVersion: 18,
}
const okCli = { configured: false, found: true, path: 'C:\\zcode.cjs' }
const badCred = { ok: false, error: 'config.json 没有找到 enabled 的 anthropic provider', code: 'credsInvalid', path: 'C:\\Users\\x\\.zcode\\v2\\config.json' }
const goodCred = { ok: true, model: 'GLM-5.3' }

const status = (over: Partial<EnvStatus>): EnvStatus => ({
  node: okNode as EnvStatus['node'],
  cli: okCli as EnvStatus['cli'],
  credentials: goodCred as EnvStatus['credentials'],
  allOk: true,
  ...over,
} as EnvStatus)

const noop = () => {}

beforeEach(() => {
  cleanup()
  useStore.getState().init()
  useStore.setState({ envStatus: null })
})

describe('EnvBanner 凭证降级（issue #4）', () => {
  it('凭证失败但 node/cli 正常：advisory 档提示，不显示阻断标题', () => {
    useStore.setState({ envStatus: status({ credentials: badCred as EnvStatus['credentials'], allOk: true }) })
    render(<EnvBanner onGoSettings={noop} />)
    expect(screen.getByText('运行环境提示（对话功能不受影响）')).toBeTruthy()
    expect(screen.getByText(/未找到可用的模型凭证/)).toBeTruthy()
    expect(screen.queryByText(/插件暂不可用/)).toBeNull()
  })

  it('node 失败 + 凭证失败：阻断档只列 node，凭证不进阻断列表', () => {
    useStore.setState({
      envStatus: status({
        node: { ...okNode, found: false, error: '未找到', code: 'nodeNotFound' } as EnvStatus['node'],
        credentials: badCred as EnvStatus['credentials'],
        allOk: false,
      }),
    })
    render(<EnvBanner onGoSettings={noop} />)
    expect(screen.getByText(/插件暂不可用/)).toBeTruthy()
    expect(screen.getByText(/Node.js 未找到/)).toBeTruthy()
    expect(screen.queryByText(/未找到可用的模型凭证/)).toBeNull()
  })

  it('全部健康：不渲染', () => {
    useStore.setState({ envStatus: status({}) })
    const { container } = render(<EnvBanner onGoSettings={noop} />)
    expect(container.querySelector('.env-banner')).toBeNull()
  })
})
