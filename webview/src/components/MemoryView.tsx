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
 *       自动记忆目录行 → revealInFileManager（系统文件管理器定位；未命中时打开记忆根目录对比）
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useStore } from '@/store/useStore'
import { sendToJava } from '@/ipc/bridge'
import type { MemoryFileInfo, MemorySearchHitInfo } from '@/types/messages'
import { fmtResetTime, wsBasename } from '@/utils/format'
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

/** 条目说明：走前端 i18n（后端 description 是拼好的中文，不再直接渲染）*/
function localizedDesc(t: TFunction, file: MemoryFileInfo): string {
  if (file.kind === 'auto') {
    return file.name === 'MEMORY.md'
      ? t('memory.auto.indexDesc')
      : (file.title || t('memory.auto.factFallback'))
  }
  return file.scope === 'global' ? t('memory.global.hint') : t('memory.project.hint')
}

/** 命中片段高亮：按空格分词逐词包裹 <mark>（split 捕获组即命中词原文，大小写不敏感判断）*/
function highlightSnippet(snippet: string, query: string): ReactNode[] {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [snippet]
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi')
  return snippet.split(regex).map((part, i) =>
    terms.some((t) => part.toLowerCase() === t.toLowerCase())
      ? <mark key={i} className="memory-search-hit__mark">{part}</mark>
      : part,
  )
}

/** 全文搜索命中条目（搜索态替换原列表）：文件名 + 命中数徽标 + 片段高亮 */
function SearchHitItem({ hit, query }: { hit: MemorySearchHitInfo; query: string }) {
  const { t } = useTranslation()
  return (
    <div className="memory-item auto memory-search-hit">
      <span className="codicon codicon-search memory-item__icon" />
      <div className="memory-item__body">
        <div className="memory-item__name-row">
          <span className="memory-item__name">{hit.name}</span>
          <span className="memory-item__badge memory-item__badge--count">
            {t('memory.search.hitCount', { count: hit.matchCount })}
          </span>
        </div>
        <div className="memory-item__desc memory-search-hit__snippet" title={hit.snippet}>
          {highlightSnippet(hit.snippet, query)}
        </div>
      </div>
      <button
        className="memory-item__btn"
        onClick={() => sendToJava({ op: 'openFile', filePath: hit.path, findText: query })}
        title={t('memory.item.openTitle')}
      >
        <span className="codicon codicon-go-to-file" />
        {t('memory.item.open')}
      </button>
    </div>
  )
}

/** 自动记忆全文搜索框（300ms 防抖；空 query 退出搜索态恢复原列表）*/
function MemorySearchBox() {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const searchMemoryFiles = useStore((s) => s.searchMemoryFiles)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const onChange = (v: string) => {
    setValue(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => searchMemoryFiles(v), 300)
  }

  return (
    <div className="memory-search">
      <span className="codicon codicon-search memory-search__icon" />
      <input
        className="memory-search__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('memory.search.placeholder')}
      />
      {value ? (
        <button className="memory-search__clear" onClick={() => onChange('')} title={t('memory.search.clear')}>
          <span className="codicon codicon-close" />
        </button>
      ) : null}
    </div>
  )
}

/** 单条记忆文件条目 */
function MemoryItem({ file }: { file: MemoryFileInfo }) {
  const { t } = useTranslation()
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
          {file.orphaned ? <span className="memory-item__badge memory-item__badge--orphan">{t('memory.auto.orphanBadge')}</span> : null}
          {file.exists ? (
            <span className="memory-item__meta">
              {fmtSize(file.sizeBytes)} · {t('memory.item.modifiedAt', { time: fmtResetTime(file.lastModified) })}
            </span>
          ) : (
            <span className="memory-item__badge">{t('memory.item.notCreated')}</span>
          )}
        </div>
        <div className="memory-item__desc">{localizedDesc(t, file)}</div>
        {/* 自动记忆条目不显示路径行：目录位置已在「记忆目录」行给出，文件名即条目名——压两行高度 */}
        {isAuto ? null : (
          <div className="memory-item__path" title={file.path}>
            {file.path}
          </div>
        )}
      </div>
      {file.exists ? (
        <button
          className="memory-item__btn"
          onClick={() => sendToJava({ op: 'openFile', filePath: file.path })}
          title={t('memory.item.openTitle')}
        >
          <span className="codicon codicon-go-to-file" />
          {t('memory.item.open')}
        </button>
      ) : (
        <button
          className="memory-item__btn memory-item__btn--create"
          onClick={() => createMemoryFile(file.path)}
          disabled={creating}
          title={t('memory.item.createTitle')}
        >
          <span className={cx('codicon', creating ? 'codicon-loading spin' : 'codicon-add')} />
          {creating ? t('memory.item.creating') : t('memory.item.create')}
        </button>
      )}
    </div>
  )
}

/** 「工作区记忆」开关卡（与 ZCode 客户端共用 ~/.zcode/v2/setting.json 的 memoryEnabled）*/
function MemoryToggle() {
  const { t } = useTranslation()
  const memoryEnabled = useStore((s) => s.memoryEnabled)
  const memoryToggling = useStore((s) => s.memoryToggling)
  const setMemoryEnabled = useStore((s) => s.setMemoryEnabled)
  const on = memoryEnabled === true

  return (
    <div className={cx('memory-toggle', on && 'on')}>
      <div className="memory-toggle__body">
        <div className="memory-toggle__name-row">
          <span className="codicon codicon-lightbulb memory-toggle__icon" />
          <span className="memory-toggle__name">{t('memory.auto.switchTitle')}</span>
        </div>
        <div className="memory-toggle__desc">{t('memory.auto.switchDesc')}</div>
      </div>
      <button
        className={cx('memory-toggle__switch', on && 'on')}
        onClick={() => memoryEnabled != null && setMemoryEnabled(!on)}
        disabled={memoryToggling || memoryEnabled == null}
        title={on ? t('memory.auto.switchOffHint') : t('memory.auto.switchOnHint')}
      >
        <span className={cx('codicon', memoryToggling ? 'codicon-loading spin' : 'memory-toggle__knob')} />
      </button>
    </div>
  )
}

/**
 * 记忆目录行（自动记忆区块）：显示插件实际读取的目录位置。
 * 未命中时展示按当前项目路径推算的期望目录（排查入口：与记忆根目录实际内容对比，
 * 目录名末尾 16 位哈希不一致 = CLI 写入时的路径不是当前项目根）。
 */
function MemoryDirRow() {
  const { t } = useTranslation()
  const memoryDir = useStore((s) => s.memoryDir)
  const memoryFiles = useStore((s) => s.memoryFiles)
  if (!memoryDir) return null
  const found = memoryDir.dir != null
  const autoCount = memoryFiles?.filter((f) => f.kind === 'auto').length ?? 0
  const displayPath = memoryDir.dir ?? memoryDir.expectedDir
  const revealPath = memoryDir.dir ?? memoryDir.projectsRoot

  return (
    <div className={cx('memory-dir-row', !found && 'missing')}>
      <span className="codicon codicon-folder memory-dir-row__icon" />
      <div className="memory-dir-row__body">
        <div className="memory-dir-row__name-row">
          <span className="memory-dir-row__label">{t('memory.auto.dirLabel')}</span>
          {found ? (
            <span className="memory-dir-row__meta">
              {t('memory.auto.dirFound', { count: autoCount })}
            </span>
          ) : (
            <span className="memory-dir-row__badge">{t('memory.auto.dirNotFound')}</span>
          )}
        </div>
        {!found ? <div className="memory-dir-row__desc">{t('memory.auto.dirMissHint')}</div> : null}
        <div className="memory-dir-row__path" title={displayPath}>
          {displayPath}
        </div>
      </div>
      <button
        className="memory-dir-row__btn"
        onClick={() => sendToJava({ op: 'revealInFileManager', path: revealPath })}
        title={found ? t('memory.auto.revealDirTitle') : t('memory.auto.revealRootTitle')}
      >
        <span className="codicon codicon-folder-opened" />
        {found ? t('memory.auto.revealDir') : t('memory.auto.revealRoot')}
      </button>
    </div>
  )
}

export function MemoryView() {
  const { t } = useTranslation()
  const memoryFiles = useStore((s) => s.memoryFiles)
  const memoryLoading = useStore((s) => s.memoryLoading)
  const memoryError = useStore((s) => s.memoryError)
  const loadMemoryFiles = useStore((s) => s.loadMemoryFiles)
  const searchMemoryFiles = useStore((s) => s.searchMemoryFiles)
  const memorySearchResults = useStore((s) => s.memorySearchResults)
  const memorySearchActiveQuery = useStore((s) => s.memorySearchActiveQuery)
  const memorySearching = useStore((s) => s.memorySearching)
  // 多目录会话：浏览目录下拉（''=本项目；关联目录时才显示）
  const linkedWorkspaces = useStore((s) => s.linkedWorkspaces)
  const projectPath = useStore((s) => s.projectPath)
  const memoryWorkspace = useStore((s) => s.memoryWorkspace)

  useEffect(() => {
    loadMemoryFiles()
    // 搜索框输入值是组件本地 state（切页卸载即清），store 里的搜索结果却持久——
    // 挂载时清掉残留搜索态，避免「框空但列表仍是搜索结果」（空 query 不发请求）
    searchMemoryFiles('')
  }, [loadMemoryFiles, searchMemoryFiles])

  const globalFiles = memoryFiles?.filter((f) => f.scope === 'global') ?? []
  const projectFiles = memoryFiles?.filter((f) => f.scope === 'project' && f.kind === 'instructions') ?? []
  const autoFiles = memoryFiles?.filter((f) => f.kind === 'auto') ?? []
  const searching = memorySearchResults != null

  return (
    <div className="memory-view">
      {/* 浏览目录下拉（多目录会话）：切目录重拉清单；同时退出搜索态防旧命中残留 */}
      {linkedWorkspaces.length > 0 && (
        <div className="memory-view__ws-row">
          <span className="memory-view__ws-label">{t('history.wsChips.workspace')}</span>
          <select
            className="memory-view__ws-select"
            value={memoryWorkspace || projectPath}
            onChange={(e) => {
              const v = e.target.value
              loadMemoryFiles(v === projectPath ? '' : v)
              searchMemoryFiles('')
            }}
          >
            <option value={projectPath} title={projectPath}>{t('history.wsChips.project')}</option>
            {linkedWorkspaces.map((w) => (
              <option key={w} value={w} title={w}>{wsBasename(w)}</option>
            ))}
          </select>
        </div>
      )}
      <section className="memory-view__section">
        <div className="memory-view__section-head">
          <h3 className="memory-view__section-title">{t('memory.global.title')}</h3>
          <span className="memory-view__hint">{t('memory.global.hint')}</span>
          <button
            className="memory-view__icon-btn"
            onClick={() => loadMemoryFiles()}
            disabled={memoryLoading}
            title={t('memory.refresh')}
          >
            <span className={cx('codicon codicon-refresh', memoryLoading && 'spin')} />
          </button>
        </div>
        {memoryError ? <div className="memory-view__error">{memoryError}</div> : null}
        {memoryLoading && !memoryFiles ? (
          <div className="memory-view__loading">{t('memory.loading')}</div>
        ) : (
          globalFiles.map((f) => <MemoryItem key={f.path} file={f} />)
        )}
      </section>

      <section className="memory-view__section">
        <div className="memory-view__section-head">
          <h3 className="memory-view__section-title">{t('memory.project.title')}</h3>
          <span className="memory-view__hint">{t('memory.project.hint')}</span>
        </div>
        {projectFiles.length > 0 ? (
          projectFiles.map((f) => <MemoryItem key={f.path} file={f} />)
        ) : (
          <div className="memory-view__loading">{t('memory.project.empty')}</div>
        )}
      </section>

      <section className="memory-view__section">
        <div className="memory-view__section-head">
          <h3 className="memory-view__section-title">{t('memory.auto.title')}</h3>
          <span className="memory-view__hint">{t('memory.auto.hint')}</span>
        </div>
        <MemoryToggle />
        <MemoryDirRow />
        <MemorySearchBox />
        {searching ? (
          memorySearchResults.length > 0 ? (
            memorySearchResults.map((h) => <SearchHitItem key={h.path} hit={h} query={memorySearchActiveQuery} />)
          ) : (
            <div className="memory-view__loading">
              {memorySearching ? t('memory.search.searching') : t('memory.search.noMatch')}
            </div>
          )
        ) : autoFiles.length > 0 ? (
          autoFiles.map((f) => <MemoryItem key={f.path} file={f} />)
        ) : (
          <div className="memory-view__loading">{t('memory.auto.empty')}</div>
        )}
      </section>
    </div>
  )
}
