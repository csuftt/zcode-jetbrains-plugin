/**
 * 产物预览卡（B2 二期，对齐官方客户端「回合重要产物」）
 *
 * 数据链：轮文本六源提取（utils/previewArtifacts，纯函数已单测；六源=五源+环境变量
 * 占位符路径源，缺陷 GZ）→ md/html 必须命中
 * 本轮 fileChanges 路径集才出卡（复用 B2 turnFileChanges 查询懒拉明细，模块级缓存
 * 去重，重挂载不重发）→ 渲染前批量 checkFilesExist（防闪卡：settled 前不渲染，
 * 已删除文件直接滤掉）→ 轮尾渲染（后提及优先，候选 15 / 渲染 10 上限）。
 *
 * 已知边界（与 B2 更改条一致）：历史窗口外老轮 fileChanges 查询为空 → 重试窗口耗尽后
 * md/html 抑制（空/错先经退避重试自愈实时轮落库竞态，见 EMPTY_RETRY_DELAYS_MS）；
 * Office/PDF/音视频不受影响（stat 存在即出卡）。
 *
 * 点击路由：md → IDE 编辑器（openFile）；html → 系统浏览器（openFileSystem，Java 侧
 * BrowserUtil.browse 强制浏览器，图标同网站卡用地球）；Office/PDF/音视频 → 系统默认程序
 * （openFileSystem）；localhost 网站卡 → 系统浏览器（openExternal）。
 */

import { memo, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store/useStore'
import { onMessage, sendToJava } from '@/ipc/bridge'
import { FileIcon } from './FileIcon'
import {
  buildPreviewCards,
  extractPreviewFileReferences,
  getPreviewCardFilePath,
  PREVIEW_CARD_VISIBLE_LIMIT,
  PREVIEW_KIND_I18N,
  type PreviewCard,
} from '@/utils/previewArtifacts'
import '../styles/preview-cards.less'

/** turnFileChanges 明细路径缓存（key=回复消息 id）：二段出卡/重挂载不重发查询 */
const changedPathsCache = new Map<string, string[]>()
const CHANGED_PATHS_CACHE_MAX = 400

/**
 * 空结果退避重试（实时轮落库竞态修复，2026-10-08）：轮尾气泡挂卡即发查询，而服务端
 * 该轮 fileChanges 记录（checkpoint 落库/回合头行提交）与最后一个流帧之间有时间差，
 * 首查常拿到空/错——旧实现把空结果与命中同等缓存且无重试，卡在本 webview 生命周期内
 * 永不出现（真机实锤：实时对话不出卡、重启重载才补出）。现对空/错在窗口内退避重试，
 * 耗尽才按空固化（此时缓存空=保留「历史窗口外老轮查空即抑制」的既有边界，重挂载不重烧）。
 */
const EMPTY_RETRY_DELAYS_MS = [2000, 5000, 10000]
const EMPTY_RETRY_WINDOW_MS = 15000

let statRequestSeq = 0

function normPath(p: string): string {
  return p.replace(/\\/g, '/')
}

function cardKey(card: PreviewCard): string {
  return card.type === 'file' ? `file:${normPath(card.path)}` : `url:${card.url}`
}

export const AssistantPreviewCards = memo(function AssistantPreviewCards({
  messageId,
  text,
}: {
  messageId: string
  text: string
}) {
  const { t } = useTranslation()
  const workspacePath = useStore((s) => s.projectPath)
  const sessionId = useStore((s) => s.currentSessionId)
  // 占位符路径展开白名单（缺陷 GZ）：null=未到达，占位符引用暂解析不出（env 到达后本
  // 组件经依赖重算二段补出，与 changedPaths 的二段出卡同构）
  const pathEnv = useStore((s) => s.pathEnv)
  // reverted 由服务端事件权威回推（撤销后 md/html 立即抑制，不等查询）
  const fcState = useStore((s) => s.turnFileChanges[messageId]?.state)

  const references = useMemo(
    () => extractPreviewFileReferences(text, workspacePath, pathEnv),
    [text, workspacePath, pathEnv],
  )
  const needsChanges = useMemo(
    () => references.some((r) => r.kind === 'markdown' || r.kind === 'html'),
    [references],
  )

  // md/html 门控数据：本轮 fileChanges 明细路径（懒拉一次；空/错在退避窗口内重试，
  // 耗尽才按空固化并缓存——见 EMPTY_RETRY_DELAYS_MS 注释）
  const [changedPaths, setChangedPaths] = useState<string[] | null>(null)
  useEffect(() => {
    if (!needsChanges) return
    if (fcState === 'reverted') {
      setChangedPaths([])
      return
    }
    const cached = changedPathsCache.get(messageId)
    if (cached) {
      setChangedPaths(cached)
      return
    }
    if (!sessionId) return
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryCount = 0
    const startedAt = Date.now()
    const cachePaths = (paths: string[]) => {
      if (changedPathsCache.size >= CHANGED_PATHS_CACHE_MAX) {
        const first = changedPathsCache.keys().next().value
        if (first !== undefined) changedPathsCache.delete(first)
      }
      changedPathsCache.set(messageId, paths)
    }
    // 空/错统一处理：窗口内退避重试（轮末落库竞态自愈）；耗尽→固化空并缓存
    const handleUnavailable = () => {
      if (disposed) return
      if (retryCount < EMPTY_RETRY_DELAYS_MS.length && Date.now() - startedAt < EMPTY_RETRY_WINDOW_MS) {
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          retryCount++
          if (!disposed) sendToJava({ op: 'turnFileChanges', sessionId, messageId })
        }, EMPTY_RETRY_DELAYS_MS[retryCount])
        return
      }
      cachePaths([])
      setChangedPaths([])
    }
    const off = onMessage((msg) => {
      if (msg.op === 'turnFileChangesResult' && msg.messageId === messageId) {
        const paths = msg.data.state === 'reverted' ? [] : msg.data.items.map((it) => it.path)
        if (paths.length > 0) {
          cachePaths(paths)
          setChangedPaths(paths)
        } else {
          handleUnavailable()
        }
      } else if (msg.op === 'turnFileChangesError') {
        handleUnavailable()
      }
    })
    sendToJava({ op: 'turnFileChanges', sessionId, messageId })
    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      off()
    }
  }, [needsChanges, fcState, messageId, sessionId])

  // 组卡：md/html 在明细未到前不产卡（null），明细到达后重算二段出卡
  const cards = useMemo(
    () => buildPreviewCards(text, workspacePath, needsChanges ? changedPaths : [], pathEnv),
    [text, workspacePath, needsChanges, changedPaths, pathEnv],
  )

  // 渲染前批量 stat：文件卡全量校验（官方同源防闪卡语义）
  const statPaths = useMemo(
    () => Array.from(new Set(cards.map(getPreviewCardFilePath).filter((p): p is string => !!p))),
    [cards],
  )
  const statSig = statPaths.map(normPath).join('\n')
  const [statExists, setStatExists] = useState<Record<string, boolean> | null>(null)
  useEffect(() => {
    if (statPaths.length === 0) {
      setStatExists({})
      return
    }
    let disposed = false
    const requestId = `apc_${++statRequestSeq}`
    const off = onMessage((msg) => {
      if (msg.op === 'checkFilesExistResult' && msg.requestId === requestId) {
        if (disposed) return
        const map: Record<string, boolean> = {}
        for (const r of msg.results) map[normPath(r.path)] = r.exists
        setStatExists(map)
      }
    })
    sendToJava({ op: 'checkFilesExist', requestId, paths: statPaths })
    return () => {
      disposed = true
      off()
    }
    // 路径集签名不变不重查（cards 引用变化但 stat 集相同）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statSig, messageId])

  const settled = statExists !== null
  const visible = settled
    ? cards
        .filter((c) => {
          const p = getPreviewCardFilePath(c)
          return p === null || statExists![normPath(p)] === true
        })
        .slice(0, PREVIEW_CARD_VISIBLE_LIMIT)
    : []

  if (!settled || visible.length === 0) return null

  const openCard = (card: PreviewCard) => {
    if (card.type === 'website') {
      sendToJava({ op: 'openExternal', url: card.url })
      return
    }
    if (card.kind === 'markdown') {
      // md 产物 IDE 编辑器直开（自带预览）
      sendToJava({ op: 'openFile', filePath: card.path })
    } else {
      // html/Office/PDF/音视频交系统程序：html 走浏览器看渲染效果（Java 侧
      // BrowserUtil.browse 强制系统浏览器，不进 IDE 编辑器——用户定案），其余系统默认程序
      sendToJava({ op: 'openFileSystem', filePath: card.path })
    }
  }

  return (
    <div className="apc">
      {visible.map((card) => (
        <div
          key={cardKey(card)}
          className="apc__row"
          role="button"
          tabIndex={0}
          onClick={() => openCard(card)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') openCard(card)
          }}
        >
          {card.type === 'website' || card.kind === 'html' ? (
            // 网站卡与 html 产物用浏览器地球图标（html 点击即浏览器打开，图标随行为；
            // FileIcon 的 H5 盾牌语义是「源码文件」，与浏览器直开不符——用户定案）。
            // 图标必须与徽标容器分层：同元素挂 codicon 时字形按 inline 基线摆放，
            // flex 居中管不到自身字形（真机实锤偏上）。
            <span className="apc__badge">
              <span className="codicon codicon-globe apc__badge-icon" aria-hidden="true" />
            </span>
          ) : (
            <span className="apc__badge">
              <FileIcon path={card.path} className="apc__badge-icon" />
            </span>
          )}
          <div className="apc__meta">
            <div className="apc__title">{card.title}</div>
            <div className="apc__subtitle">
              {card.type === 'website' ? t('chat.previewCards.website') : t(PREVIEW_KIND_I18N[card.kind])}
            </div>
          </div>
          <span className="codicon codicon-link-external apc__open" aria-hidden="true" />
        </div>
      ))}
    </div>
  )
})
