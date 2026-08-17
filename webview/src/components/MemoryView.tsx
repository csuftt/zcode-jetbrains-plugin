/**
 * 记忆文件面板（设置页「记忆」条目）
 *
 * 两类记忆（文档：zcode.z.ai/cn/docs/memory）：
 *   指令记忆  ~/.zcode/AGENTS.md（全局）+ 项目根 AGENTS.md —— 手工维护，缺失可创建
 *   自动记忆  ~/.zcode/cli/memories/projects/<key>/memory/ —— ZCode 从已完成对话
 *             自动提炼的事实（MEMORY.md 索引 + 单条 .md），只读展示
 *
 * 数据：listMemoryFiles（Kotlin 端 MemoryFileScanner，指令记忆缺失项也返回）
 * 交互：存在 → openFile（IDEA 编辑器打开）；指令记忆缺失 → createMemoryFile（写模板后自动打开）
 */

import { useEffect } from 'react'
import { useStore } from '@/store/useStore'
import { sendToJava } from '@/ipc/bridge'
import type { MemoryFileInfo } from '@/types/messages'
import { fmtResetTime } from '@/utils/format'
import '../styles/memory-view.less'

/** 条件 className 拼接 */
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** 文件大小 → B/KB/MB */
function fmtSize(bytes?: number): string {
  if (bytes == null) return ''
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** 单条记忆文件条目 */
function MemoryItem({ file }: { file: MemoryFileInfo }) {
  const memoryCreatingPath = useStore((s) => s.memoryCreatingPath)
  const createMemoryFile = useStore((s) => s.createMemoryFile)
  const creating = memoryCreatingPath === file.path
  const isAuto = file.kind === 'auto'

  return (
    <div className={cx('memory-item', !file.exists && 'missing', isAuto && 'auto')}>
      <span
        className={cx(
          'codicon memory-item__icon',
          isAuto ? (file.name === 'MEMORY.md' ? 'codicon-list-tree' : 'codicon-lightbulb') : file.exists ? 'codicon-notebook' : 'codicon-new-file',
        )}
      />
      <div className="memory-item__body">
        <div className="memory-item__name-row">
          <span className="memory-item__name">{file.name}</span>
          {file.exists ? (
            <span className="memory-item__meta">
              {fmtSize(file.sizeBytes)} · 修改于 {fmtResetTime(file.lastModified)}
            </span>
          ) : (
            <span className="memory-item__badge">未创建</span>
          )}
        </div>
        <div className="memory-item__desc">{file.description}</div>
        <div className="memory-item__path" title={file.path}>
          {file.path}
        </div>
      </div>
      {file.exists ? (
        <button
          className="memory-item__btn"
          onClick={() => sendToJava({ op: 'openFile', filePath: file.path })}
          title="在编辑器中打开"
        >
          <span className="codicon codicon-go-to-file" />
          打开
        </button>
      ) : (
        <button
          className="memory-item__btn memory-item__btn--create"
          onClick={() => createMemoryFile(file.path)}
          disabled={creating}
          title="创建默认模板并在编辑器中打开"
        >
          <span className={cx('codicon', creating ? 'codicon-loading spin' : 'codicon-add')} />
          {creating ? '创建中…' : '创建'}
        </button>
      )}
    </div>
  )
}

export function MemoryView() {
  const memoryFiles = useStore((s) => s.memoryFiles)
  const memoryLoading = useStore((s) => s.memoryLoading)
  const memoryError = useStore((s) => s.memoryError)
  const loadMemoryFiles = useStore((s) => s.loadMemoryFiles)

  useEffect(() => {
    loadMemoryFiles()
  }, [loadMemoryFiles])

  const globalFiles = memoryFiles?.filter((f) => f.scope === 'global') ?? []
  const projectFiles = memoryFiles?.filter((f) => f.scope === 'project' && f.kind === 'instructions') ?? []
  const autoFiles = memoryFiles?.filter((f) => f.kind === 'auto') ?? []

  return (
    <div className="memory-view">
      <section className="memory-view__section">
        <div className="memory-view__section-head">
          <h3 className="memory-view__section-title">全局记忆</h3>
          <span className="memory-view__hint">所有项目的 ZCode 会话自动读取</span>
          <button
            className="memory-view__icon-btn"
            onClick={() => loadMemoryFiles()}
            disabled={memoryLoading}
            title="刷新"
          >
            <span className={cx('codicon codicon-refresh', memoryLoading && 'spin')} />
          </button>
        </div>
        {memoryError ? <div className="memory-view__error">{memoryError}</div> : null}
        {memoryLoading && !memoryFiles ? (
          <div className="memory-view__loading">加载中…</div>
        ) : (
          globalFiles.map((f) => <MemoryItem key={f.path} file={f} />)
        )}
      </section>

      <section className="memory-view__section">
        <div className="memory-view__section-head">
          <h3 className="memory-view__section-title">项目记忆</h3>
          <span className="memory-view__hint">仅当前项目的 ZCode 会话自动读取</span>
        </div>
        {projectFiles.length > 0 ? (
          projectFiles.map((f) => <MemoryItem key={f.path} file={f} />)
        ) : (
          <div className="memory-view__loading">未检测到打开的项目</div>
        )}
      </section>

      <section className="memory-view__section">
        <div className="memory-view__section-head">
          <h3 className="memory-view__section-title">ZCode 自动记忆</h3>
          <span className="memory-view__hint">
            从已完成对话中自动提炼，后续会话自动带入（ZCode 客户端 设置 → 常规 开启）
          </span>
        </div>
        {autoFiles.length > 0 ? (
          autoFiles.map((f) => <MemoryItem key={f.path} file={f} />)
        ) : (
          <div className="memory-view__loading">
            暂无自动记忆——在 ZCode 客户端开启 Memory 功能并完成几轮对话后，提炼的事实会出现在这里
          </div>
        )}
      </section>
    </div>
  )
}
