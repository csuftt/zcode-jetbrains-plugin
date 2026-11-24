/**
 * 知识库工具的展开区（单卡与批量组卡的成员行共用）：参数与结果按工具语义友好展示，
 * 替代裸 JSON。
 *   - 参数：中文字段名 + 值（检索词 / 目录 / 标签 …），只列传了的
 *   - 结果：检索与浏览 → 条目列表（标题、目录、标签、状态、命中片段）；目录结构 →
 *     缩进的目录树 + 标签；读全文 → 头信息 + 正文（长文走 📖 弹窗）；整理类 → 一句回执。
 *     条目一次放全，列表 / 目录树 / 正文都限高（kb-scroll），超出的在卡片里滚，不把消息区拉长
 *   - 输出形状对不上（流式半截、工具输出改了）回退原文；随时可切到「原始数据」看 JSON——
 *     切换按钮挂在展开区第一个区块标签行的右端，不单独占一行
 *
 * 文案与知识库卡片标题一样是写死的中文（对齐 utils/kbTools 的先例）；区块标签沿用
 * 工具卡通用的「输入 / 输出 / 错误」。
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolPart } from '@/types/messages'
import { toolErrorText } from '@/utils/parseStatus'
import { useStore } from '@/store/useStore'
import {
  kbOutputError,
  kbParams,
  kbParseRead,
  kbParseRows,
  kbParseTree,
  kbReadStateLabel,
  kbReceipt,
  kbStateLabel,
  kbToolShortName,
} from '@/utils/kbTools'
import type { KbNote, KbReadDoc, KbRow, KbTree } from '@/utils/kbTools'
import '../styles/tool-call-card.less'

/** 结果是一句话回执的工具（其余是列表、树或正文）*/
const RECEIPT_TOOLS = new Set(['kb_folder', 'kb_entry', 'kb_tag', 'kb_add'])

export function KbToolBody({ part, compact = false }: { part: ToolPart; compact?: boolean }) {
  const { t } = useTranslation()
  const openMarkdownPreview = useStore((s) => s.openMarkdownPreview)
  const [raw, setRaw] = useState(false)
  const { tool, state } = part
  const input = state.input as Record<string, unknown> | undefined
  const output = state.output
  const short = kbToolShortName(tool)

  const params = useMemo(() => kbParams(tool, input), [tool, input])
  const outError = useMemo(() => kbOutputError(output), [output])
  const rows = useMemo(
    () => ((short === 'kb_search' || short === 'kb_list') && !outError ? kbParseRows(output) : null),
    [short, outError, output],
  )
  const tree = useMemo(
    () => (short === 'kb_tree' && !outError ? kbParseTree(output) : null),
    [short, outError, output],
  )
  const doc = useMemo(
    () => (short === 'kb_read' && !outError ? kbParseRead(output) : null),
    [short, outError, output],
  )
  const receipt = useMemo(
    () => (RECEIPT_TOOLS.has(short) && !outError ? kbReceipt(tool, input, output) : null),
    [short, outError, tool, input, output],
  )

  const errorText = toolErrorText(state.error)
  // 出错文本有两处来路：结果是 {"error": …}（工具给的业务性拒绝，友好回执里带原因）或 state.error
  // （工具自身报错，如入参不合 schema 被拒——没有结果只有错误）。两处都有时以回执为准，它说得更具体。
  const showStateError = !!errorText && !outError
  const showResult = !!output && (!!outError || !errorText)
  const waiting = !errorText && !output && (state.status === 'running' || state.status === 'pending')
  const hasInput = !!state.input && Object.keys(state.input).length > 0
  // 结果还没回来时没有可看的原始输出，不出切换按钮
  const hasResult = !!output || !!errorText
  const showToggle = hasInput && hasResult

  const openFull = () => {
    if (!output) return
    openMarkdownPreview({
      title: doc?.title || t('tool.output'),
      meta: doc?.source || undefined,
      markdown: output,
    })
  }

  // 区块标签行。「原始数据」切换只挂在这一行（first = 展开区的第一个区块），放右端与标签同行，
  // 不在展开区底部单独占一行
  const label = (text: string, first: boolean, action?: ReactNode) => {
    const toggle = first && showToggle
    return (
      <div className={`tool-card__label${toggle || action ? ' tool-card__label--with-action' : ''}`}>
        {text}
        {(toggle || action) && (
          <span className="kb-label-actions">
            {action}
            {toggle && <RawToggle raw={raw} onToggle={() => setRaw(!raw)} />}
          </span>
        )}
      </div>
    )
  }

  if (raw) {
    return (
      <div className={`kb-body${compact ? ' kb-body--compact' : ''}`}>
        {hasInput && (
          <div className="tool-card__section">
            {label(t('tool.input'), true)}
            <pre className="tool-card__code">{JSON.stringify(state.input, null, 2)}</pre>
          </div>
        )}
        {output && (
          <div className="tool-card__section">
            {label(t('tool.output'), !hasInput)}
            <pre className="tool-card__code">{output}</pre>
          </div>
        )}
        {errorText && (
          <div className="tool-card__section tool-card__section--err">
            {label(t('tool.error'), !hasInput && !output)}
            <pre className="tool-card__code">{errorText}</pre>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`kb-body${compact ? ' kb-body--compact' : ''}`}>
      {params.length > 0 && (
        <div className="tool-card__section">
          {label(t('tool.input'), true)}
          <div className="kb-params">
            {params.map((p, i) => (
              <span key={`${p.label}-${i}`} className="kb-param" title={p.title}>
                <span className="kb-param__label">{p.label}</span>
                {p.swatch && <i className="kb-swatch" style={{ background: p.swatch }} />}
                <span className="kb-param__value">{p.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {showStateError && (
        <div className="tool-card__section tool-card__section--err">
          {label(t('tool.error'), params.length === 0)}
          <pre className="tool-card__code">{errorText}</pre>
        </div>
      )}

      {showResult && (
        <div className="tool-card__section">
          {label(
            t('tool.output'),
            params.length === 0 && !showStateError,
            doc ? (
              <button className="tool-card__full-btn" onClick={openFull}>
                {t('tool.viewFullResult')}
                <span className="codicon codicon-book" />
              </button>
            ) : undefined,
          )}
          {outError ? (
            <ReceiptView note={{ text: '未成功', detail: outError }} />
          ) : rows ? (
            <RowsView rows={rows} search={short === 'kb_search'} />
          ) : tree ? (
            <TreeView tree={tree} />
          ) : doc ? (
            <ReadView doc={doc} />
          ) : receipt ? (
            <ReceiptView note={receipt} />
          ) : (
            <pre className="tool-card__code">{output}</pre>
          )}
        </div>
      )}

      {waiting && (
        <div className="tool-card__section">
          {label(t('tool.output'), false)}
          <div className="kb-empty"><span className="codicon codicon-loading kb-empty__spin" />等待结果…</div>
        </div>
      )}
    </div>
  )
}

function RawToggle({ raw, onToggle }: { raw: boolean; onToggle: () => void }) {
  return (
    <button className="kb-raw__btn" onClick={onToggle}>{raw ? '友好视图' : '原始数据'}</button>
  )
}

function RowsView({ rows, search }: { rows: KbRow[]; search: boolean }) {
  // 都在同一个目录下时目录只说一次，不在每行重复
  const sameFolder = rows.length > 0 && rows.every((r) => r.folder === rows[0].folder)
  const caption = rows.length === 0
    ? (search ? '没有命中的条目' : '没有条目')
    : `${search ? `命中 ${rows.length} 条` : `共 ${rows.length} 条`}${sameFolder && rows[0].folder ? ` · ${rows[0].folder}` : ''}`
  return (
    <>
      <div className="kb-caption">{caption}</div>
      {rows.length > 0 && (
        <ul className="kb-rows kb-scroll">
          {rows.map((r) => {
            const stateLabel = kbStateLabel(r.status)
            return (
              <li key={r.id} className="kb-row" title={r.sourcePath || r.title}>
                <div className="kb-row__line">
                  <span className="kb-row__title">{r.title}</span>
                  {!sameFolder && <span className="kb-row__folder">{r.folder || '根级'}</span>}
                </div>
                {(r.tags.length > 0 || stateLabel) && (
                  <div className="kb-row__meta">
                    {r.tags.map((tag) => (
                      <span key={tag} className="kb-row__tag">{tag}</span>
                    ))}
                    {stateLabel && (
                      <span className={`kb-row__state${r.status === 'missing' ? ' kb-row__state--err' : ''}`}>
                        {stateLabel}
                      </span>
                    )}
                  </div>
                )}
                {r.snippet && (
                  <div className="kb-row__snippet" title={r.snippet}>{r.snippet}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

function TreeView({ tree }: { tree: KbTree }) {
  return (
    <>
      <div className="kb-caption">全库 {tree.total} 条 · {tree.folders.length} 个目录</div>
      <div className="kb-scroll">
        <ul className="kb-tree">
          <li className="kb-tree__row">
            <span className="kb-tree__name">根级</span>
            <span className="kb-tree__count">{tree.rootCount} 条</span>
          </li>
          {tree.folders.map((f) => {
            const segments = f.path.split('/')
            const depth = segments.length - 1
            const name = segments[segments.length - 1]
            const hasChildren = f.count !== f.subtreeCount
            return (
              <li
                key={f.id || f.path}
                className="kb-tree__row"
                style={{ paddingLeft: `${depth * 14}px` }}
                title={`直接挂载 ${f.count} 条，含下级共 ${f.subtreeCount} 条`}
              >
                <span className="kb-tree__name">{name}</span>
                {/* 有下级目录的报含下级的总数，直接挂载数在悬浮提示里 */}
                <span className={`kb-tree__count${hasChildren ? ' kb-tree__count--sum' : ''}`}>
                  {f.subtreeCount} 条
                </span>
              </li>
            )
          })}
        </ul>
        {tree.tags.length > 0 && (
          <>
            <div className="kb-caption kb-caption--tags">标签 {tree.tags.length} 个</div>
            <div className="kb-tags">
              {tree.tags.map((tag) => (
                <span key={tag.name} className="kb-tagchip" title={`${tag.count} 条条目`}>
                  <i
                    className="kb-tagchip__dot"
                    style={tag.color ? { background: tag.color } : undefined}
                  />
                  {tag.name}
                  <span className="kb-tagchip__count">{tag.count}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  )
}

function ReadView({ doc }: { doc: KbReadDoc }) {
  const stateLabel = kbReadStateLabel(doc.status)
  return (
    <div className="kb-read">
      <div className="kb-read__title">{doc.title}</div>
      <div className="kb-read__meta">
        <span className="kb-row__tag">{doc.folder || '根级'}</span>
        {doc.tags.map((tag) => (
          <span key={tag} className="kb-row__tag">{tag}</span>
        ))}
        {doc.project && <span className="kb-read__project">{doc.project}</span>}
        {stateLabel && (
          <span className={`kb-row__state${doc.status === 'missing' ? ' kb-row__state--err' : ''}`}>
            {stateLabel}
          </span>
        )}
      </div>
      {doc.source && (
        <div className="kb-read__source" title={doc.source}>{doc.source}</div>
      )}
      <pre className="tool-card__code kb-read__text">{doc.body}</pre>
    </div>
  )
}

function ReceiptView({ note }: { note: KbNote }) {
  const failed = !!note.detail
  return (
    <>
      <div className={`kb-receipt${failed ? ' kb-receipt--err' : ''}`}>
        <span className={`codicon ${failed ? 'codicon-error' : 'codicon-check'}`} />
        {note.swatch && <i className="kb-swatch" style={{ background: note.swatch }} />}
        <span className="kb-receipt__text">{note.text}</span>
      </div>
      {note.detail && <pre className="tool-card__code kb-receipt__detail">{note.detail}</pre>}
    </>
  )
}
