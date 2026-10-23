/**
 * 环境子页签 CDP 端口文件项回归：
 * - envStatus.cdpPortFile 同步进第三个路径输入框，已配置显示徽章
 * - 保存发 envSave 且只带 cdpPortFile（node/cli undefined 经 JSON.stringify 省略）；
 *   清空保存带 ''
 * - envStatus 刷新不覆盖编辑中的输入（快照 ref），未编辑的输入照常同步
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'

const sent: { op: string; [k: string]: unknown }[] = []
vi.mock('@/ipc/bridge', () => ({
  sendToJava: (req: { op: string }) => {
    sent.push(req)
  },
  isInJcef: () => false,
}))

import '@/i18n/config'
import i18n from '@/i18n/config'
import { BasicSettingsView } from '@/components/BasicSettingsView'
import { useStore } from '@/store/useStore'
import type { EnvStatus } from '@/types/messages'

// BasicSettingsView 挂载链（useTheme/appearance）读 localStorage，jsdom 无实现须垫
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
    clear: () => {}, get length() { return 0 }, key: () => null,
  },
  configurable: true,
  writable: true,
})

/** 切到环境子页签 */
function openEnvTab() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
  const target = tabs.find((t) => /环境|Environment|環境|환경/.test(t.textContent ?? ''))
  fireEvent.click(target!)
}

const INPUTS = () =>
  Array.from(document.querySelectorAll('.basic-settings__path-input')) as HTMLInputElement[]

function envWith(
  cdpPortFile?: string,
  nodePath = 'C:\\node\\node.exe',
  cdpActive?: { file: string; port: number },
): EnvStatus {
  return {
    node: { configured: false, path: nodePath, found: true, version: 'v20.11.1', versionTooLow: false, minVersion: 18 },
    cli: { configured: false, path: 'C:\\zcode\\zcode.cjs', found: true, version: '0.16.9' },
    allOk: true,
    ...(cdpPortFile !== undefined ? { cdpPortFile } : {}),
    ...(cdpActive ? { cdpActiveFile: cdpActive.file, cdpActivePort: cdpActive.port } : {}),
  } as EnvStatus
}

describe('环境设置 CDP 端口文件', () => {
  beforeEach(() => {
    sent.length = 0
    useStore.setState({ envStatus: null, envSaving: false })
  })
  afterEach(cleanup)

  it('已配置值同步进第三个输入框并显示徽章', async () => {
    render(<BasicSettingsView />)
    openEnvTab()
    useStore.setState({ envStatus: envWith('D:\\idea\\system\\jcef_cache\\DevToolsActivePort') })
    await waitFor(() => {
      const inputs = INPUTS()
      expect(inputs.length).toBeGreaterThanOrEqual(3)
      expect(inputs[2].value).toBe('D:\\idea\\system\\jcef_cache\\DevToolsActivePort')
    })
    expect(document.body.textContent).toContain(i18n.t('settings.env.cdp.badge'))
  })

  it('未配置且探针缺席时无徽章且输入框为空', async () => {
    render(<BasicSettingsView />)
    openEnvTab()
    useStore.setState({ envStatus: envWith() })
    await waitFor(() => {
      expect(INPUTS()[2].value).toBe('')
    })
    expect(document.body.textContent).not.toContain(i18n.t('settings.env.cdp.badge'))
  })

  it('未配置时回显实际生效文件与端口徽标，配置值优先', async () => {
    render(<BasicSettingsView />)
    openEnvTab()
    // 未配置 + 探针有值：输入框回显生效文件，徽标显示端口
    useStore.setState({
      envStatus: envWith(undefined, 'C:\\node\\node.exe', { file: 'C:\\idea\\jcef_cache\\DevToolsActivePort', port: 63520 }),
    })
    await waitFor(() => {
      expect(INPUTS()[2].value).toBe('C:\\idea\\jcef_cache\\DevToolsActivePort')
    })
    expect(document.body.textContent).toContain(i18n.t('settings.env.cdp.portBadge', { port: 63520 }))
    expect(document.body.textContent).not.toContain(i18n.t('settings.env.cdp.badge'))

    // 配置值优先于生效文件（已配置徽标回归，端口徽标退场）
    useStore.setState({
      envStatus: envWith('D:\\my\\DevToolsActivePort', 'C:\\node\\node.exe', { file: 'C:\\idea\\jcef_cache\\DevToolsActivePort', port: 63520 }),
    })
    await waitFor(() => {
      expect(INPUTS()[2].value).toBe('D:\\my\\DevToolsActivePort')
    })
    expect(document.body.textContent).toContain(i18n.t('settings.env.cdp.badge'))
    expect(document.body.textContent).not.toContain(i18n.t('settings.env.cdp.portBadge', { port: 63520 }))
  })

  it('保存只发 cdpPortFile 且 trim，node/cli 字段不入报文', () => {
    render(<BasicSettingsView />)
    openEnvTab()
    fireEvent.change(INPUTS()[2], { target: { value: '  D:\\cdp\\DevToolsActivePort  ' } })
    const saveBtn = INPUTS()[2].parentElement!.querySelector('button')!
    fireEvent.click(saveBtn)

    const req = sent.find((m) => m.op === 'envSave')
    expect(req).toBeTruthy()
    expect(req!.cdpPortFile).toBe('D:\\cdp\\DevToolsActivePort')
    // undefined 字段 JSON.stringify 省略 = 后端"不改该项"约定（wire 报文才是契约）
    expect(JSON.parse(JSON.stringify(req))).toEqual({
      op: 'envSave',
      cdpPortFile: 'D:\\cdp\\DevToolsActivePort',
    })
  })

  it('清空保存发空串（语义=清除回退自动检测）', () => {
    render(<BasicSettingsView />)
    openEnvTab()
    useStore.setState({ envStatus: envWith('D:\\old\\DevToolsActivePort') })
    const input = INPUTS()[2]
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(input.parentElement!.querySelector('button')!)
    const req = sent.find((m) => m.op === 'envSave')
    expect(req!.cdpPortFile).toBe('')
  })

  it('envStatus 刷新不覆盖编辑中输入，未编辑的 node 输入照常同步', async () => {
    render(<BasicSettingsView />)
    openEnvTab()
    useStore.setState({ envStatus: envWith('D:\\old\\DevToolsActivePort', 'C:\\old\\node.exe') })
    await waitFor(() => expect(INPUTS()[2].value).toBe('D:\\old\\DevToolsActivePort'))

    // 用户开始编辑 cdp 输入（未保存）
    fireEvent.change(INPUTS()[2], { target: { value: 'D:\\typing\\DevToolsActivePort' } })
    // 后台 envStatus 广播刷新（cdp 与 node 都变了）
    useStore.setState({ envStatus: envWith('D:\\broadcast\\DevToolsActivePort', 'C:\\new\\node.exe') })

    await waitFor(() => expect(INPUTS()[0].value).toBe('C:\\new\\node.exe'))
    expect(INPUTS()[2].value).toBe('D:\\typing\\DevToolsActivePort')
  })
})
