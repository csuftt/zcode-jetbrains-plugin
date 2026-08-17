/**
 * 技能列表面板（设置页「技能」条目，对齐 cc-gui SkillsSettingsSection 交互）
 *
 * 数据：listSkills（Kotlin 端 SkillScanner：全局 ~/.zcode|~/.agents + 项目 .zcode|.agents
 *       + 插件贡献三来源，junction 真实路径去重）
 * 交互：scope 过滤 Tab + 搜索；卡片头部行内启用/禁用（写 config skill 节点）；
 *       展开看详情，「在编辑器中打开」跳 SKILL.md（openFile）
 */

import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/store/useStore'
import { sendToJava } from '@/ipc/bridge'
import type { SkillInfo } from '@/types/messages'
import '../styles/skill-list-view.less'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

type ScopeFilter = 'all' | 'user' | 'project' | 'plugin'

const SCOPE_LABEL: Record<string, string> = {
  user: '全局',
  project: '项目',
  plugin: '插件',
}

/** scope 徽章配色（对齐 cc-gui：全局蓝 / 项目绿 / 插件紫）*/
const SCOPE_CLASS: Record<string, string> = {
  user: 'global',
  project: 'local',
  plugin: 'plugin',
}

/** 单张技能卡片（手风琴展开）*/
function SkillCard({ skill, expanded, onToggleExpand }: { skill: SkillInfo; expanded: boolean; onToggleExpand: () => void }) {
  const skillTogglingPath = useStore((s) => s.skillTogglingPath)
  const toggleSkill = useStore((s) => s.toggleSkill)
  const toggling = skillTogglingPath === skill.path

  return (
    <div className={cx('skill-card', !skill.enabled && 'disabled', expanded && 'expanded')}>
      <div className="skill-card__header" onClick={onToggleExpand}>
        <button
          className={cx('skill-card__toggle', skill.enabled && 'on')}
          onClick={(e) => {
            e.stopPropagation()
            if (!toggling) toggleSkill(skill.path, !skill.enabled)
          }}
          disabled={toggling}
          title={skill.enabled ? '点击禁用（写入 config skill 节点）' : '点击启用'}
        >
          <span className={cx('codicon', toggling ? 'codicon-loading spin' : skill.enabled ? 'codicon-check' : 'codicon-circle-slash')} />
        </button>
        <span className={cx('codicon skill-card__icon', skill.enabled ? 'codicon-folder-library' : 'codicon-folder')} />
        <span className="skill-card__name">{skill.name}</span>
        <span className={cx('skill-card__scope', SCOPE_CLASS[skill.scope])}>
          <span className={cx('codicon', skill.scope === 'user' ? 'codicon-globe' : skill.scope === 'project' ? 'codicon-device-desktop' : 'codicon-extensions')} />
          {SCOPE_LABEL[skill.scope] ?? skill.scope}
        </span>
        {!skill.enabled && <span className="skill-card__badge-off">已禁用</span>}
        {skill.pluginName && <span className="skill-card__plugin" title={`插件 ${skill.pluginName} 贡献`}>{skill.pluginName}</span>}
        <span className="skill-card__path" title={skill.path}>
          {skill.path}
        </span>
        <span className={cx('codicon skill-card__chevron', expanded && 'open', 'codicon-chevron-right')} />
      </div>

      {expanded && (
        <div className="skill-card__body">
          {skill.description && (
            <div className="skill-card__row">
              <span className="skill-card__row-label">描述</span>
              <span className="skill-card__row-value">{skill.description}</span>
            </div>
          )}
          {skill.whenToUse && (
            <div className="skill-card__row">
              <span className="skill-card__row-label">触发时机</span>
              <span className="skill-card__row-value">{skill.whenToUse}</span>
            </div>
          )}
          <div className="skill-card__row">
            <span className="skill-card__row-label">来源</span>
            <span className="skill-card__row-value">
              {SCOPE_LABEL[skill.scope] ?? skill.scope} · {skill.source}
              {skill.pluginName ? ` · 插件 ${skill.pluginName}` : ''}
            </span>
          </div>
          <div className="skill-card__actions">
            <button
              className="skill-card__action"
              onClick={() => sendToJava({ op: 'openFile', filePath: skill.path, line: 1 })}
              title="在 IDEA 编辑器中打开 SKILL.md（查看或编辑）"
            >
              <span className="codicon codicon-go-to-file" />
              在编辑器中打开
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function SkillListView() {
  const skills = useStore((s) => s.skills)
  const skillsLoading = useStore((s) => s.skillsLoading)
  const skillsError = useStore((s) => s.skillsError)
  const loadSkills = useStore((s) => s.loadSkills)

  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [query, setQuery] = useState('')
  const [expandedPath, setExpandedPath] = useState<string | null>(null)

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  const counts = useMemo(() => {
    const c = { all: skills?.length ?? 0, user: 0, project: 0, plugin: 0 }
    skills?.forEach((s) => {
      c[s.scope] = (c[s.scope] ?? 0) + 1
    })
    return c
  }, [skills])

  const visible = useMemo(() => {
    let list = skills ?? []
    if (scopeFilter !== 'all') list = list.filter((s) => s.scope === scopeFilter)
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.path.toLowerCase().includes(q) ||
          (s.description ?? '').toLowerCase().includes(q),
      )
    }
    // 启用在前，同级名称不区分大小写排序
    return [...list].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    })
  }, [skills, scopeFilter, query])

  const filters: { key: ScopeFilter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'user', label: '全局' },
    { key: 'project', label: '项目' },
    { key: 'plugin', label: '插件' },
  ]

  return (
    <div className="skill-list-view">
      <div className="skill-list-view__toolbar">
        <div className="skill-list-view__tabs">
          {filters.map((f) => (
            <button
              key={f.key}
              className={cx('skill-list-view__tab', scopeFilter === f.key && 'active')}
              onClick={() => setScopeFilter(f.key)}
            >
              {f.label}
              <span className="skill-list-view__count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="skill-list-view__search">
          <span className="codicon codicon-search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称 / 描述 / 路径"
            spellCheck={false}
          />
          {query && (
            <button className="skill-list-view__search-clear" onClick={() => setQuery('')} title="清空">
              <span className="codicon codicon-close" />
            </button>
          )}
        </div>
        <button
          className="skill-list-view__refresh"
          onClick={() => loadSkills()}
          disabled={skillsLoading}
          title="重新扫描"
        >
          <span className={cx('codicon', skillsLoading ? 'codicon-loading spin' : 'codicon-refresh')} />
        </button>
      </div>

      {skillsError && <div className="skill-list-view__error">{skillsError}</div>}

      {skillsLoading && !skills ? (
        <div className="skill-list-view__loading">
          <span className="codicon codicon-loading spin" /> 正在扫描技能…
        </div>
      ) : visible.length === 0 ? (
        <div className="skill-list-view__empty">
          <span className="codicon codicon-lightbulb" />
          {query || scopeFilter !== 'all' ? '没有匹配的技能' : '未发现任何技能'}
        </div>
      ) : (
        <div className="skill-list-view__list">
          {visible.map((s) => (
            <SkillCard
              key={s.path}
              skill={s}
              expanded={expandedPath === s.path}
              onToggleExpand={() => setExpandedPath(expandedPath === s.path ? null : s.path)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
