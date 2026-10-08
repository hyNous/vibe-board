import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { filterSkillsByQuery, isGitHubSkillSource, splitAgentsByProgram, useSkillStoreV2 } from '../../stores/skillStoreV2'
import type { SkillSummary } from '../../services/skillApiV2'
import { AgentIconBadge } from './AgentIconBadge'
import { SettingDetails } from '../settings/SettingDetails'
import { DistributeDialog } from './DistributeDialog'
import { SkillDetailSlider } from './SkillDetailSlider'
import { SkillUpdatePanel } from './SkillUpdatePanel'
import { skillSourceTypeLabel, skillStatusLabel } from './skillLabels'

const SHARED_SKILLS_AGENT_ID = 'agents'
const ALL_CATEGORY_ID = 'all'

export function SkillOverviewPage({ onOpenAdvanced }: { onOpenAdvanced?: () => void }) {
  const { t } = useTranslation()
  const state = useSkillStoreV2()
  const [categoryId, setCategoryId] = useState<string>(ALL_CATEGORY_ID)
  const [sliderSkillId, setSliderSkillId] = useState<string | null>(null)
  const [distributeFor, setDistributeFor] = useState<SkillSummary[] | null>(null)
  const [showHiddenAgents, setShowHiddenAgents] = useState(false)

  useEffect(() => {
    void state.init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Overview only reacts to filters the page can see (search + Agent tab);
  // source/status/type filters belong to the full manager and must stay untouched.
  const skills = useMemo(
    () => filterSkillsByQuery(state.skills, state.filters.query),
    [state.skills, state.filters.query],
  )
  // Only Agents whose own program was detected are listed by default; the rest
  // (config-only directories, not installed) stay behind the "+" control.
  const knownAgents = useMemo(
    () => state.agents.filter((agent) => agent.id !== SHARED_SKILLS_AGENT_ID),
    [state.agents],
  )
  const { detected: detectedAgents, hidden: hiddenAgents } = useMemo(
    () => splitAgentsByProgram(knownAgents),
    [knownAgents],
  )
  const agentCategories = showHiddenAgents ? [...detectedAgents, ...hiddenAgents] : detectedAgents
  const activeAgent = agentCategories.find((agent) => agent.id === categoryId)
  const categorySkills = useMemo(() => {
    if (categoryId === ALL_CATEGORY_ID) return skills
    return skills.filter((skill) => skill.installedAgents.some((agent) => agent.agentId === categoryId))
  }, [categoryId, skills])
  const unassignedCount = useMemo(
    () => skills.filter((skill) => skill.installedAgents.length === 0).length,
    [skills],
  )
  const githubSkillCount = useMemo(
    () => skills.filter(isGitHubSkillSource).length,
    [skills],
  )

  return (
    <div className="vb-skills-page">
      <header className="island-effect-picker__head">
        <h3>{t('settings.skillsOverview.title', { defaultValue: 'Skill 库' })}</h3>
        <p>{t('settings.skillsOverview.subtitle', { defaultValue: '看看每个 Skill 正在被哪些 Agent 使用；想改的时候，点开卡片就能让它生效或取消。' })}</p>
      </header>

      <section className="vb-skills-scope">
        <span aria-hidden="true">ⓘ</span>
        <div>
          <p>
            <strong>{t('settings.skillsOverview.scopeTitle', { defaultValue: '只显示你自己安装的 Skill' })}</strong>
            {t('settings.skillsOverview.scope', {
              defaultValue: '项目文件夹里自带的 Skill 不在这里显示。来自 GitHub 的更新会先给你看改动，确认后才会替换。',
            })}
          </p>
          <SettingDetails testId="skills-overview-scope-details" label={t('settings.details', { defaultValue: '详情' })}>
            <div className="setting-details__row">
              <span>{t('settings.skillsOverview.centerPath', { defaultValue: 'Skill 库位置' })}</span>
              <code>{state.settings?.centerPath ?? '~/.agents/skills'}</code>
            </div>
          </SettingDetails>
        </div>
      </section>

      <div className="vb-skills-toolbar">
        <label className="vb-skills-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder={t('settings.skillsOverview.searchPlaceholder', { defaultValue: '搜索 Skill 名称或描述' })}
            value={state.filters.query}
            onChange={(event) => state.setFilter('query', event.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="vb-skills-toolbar__meta">
          <span>
            {t('settings.skillsOverview.count', {
              total: skills.length,
              github: githubSkillCount,
              defaultValue: '共 {{total}} 个 Skill · {{github}} 个可检查更新',
            })}
          </span>
          {onOpenAdvanced && (
            <button type="button" className="vb-skills-btn" onClick={onOpenAdvanced}>
              {t('settings.skillsOverview.openAdvanced', { defaultValue: '完整管理' })}
            </button>
          )}
        </div>
      </div>

      <div className="vb-skills-chips" role="tablist" aria-label={t('settings.skillsOverview.categoriesLabel', { defaultValue: 'Skill 分类' })}>
        <button
          type="button"
          role="tab"
          aria-selected={categoryId === ALL_CATEGORY_ID}
          className={`vb-skills-chip${categoryId === ALL_CATEGORY_ID ? ' is--active' : ''}`}
          onClick={() => setCategoryId(ALL_CATEGORY_ID)}
        >
          {t('settings.skillsOverview.categoryAll', { defaultValue: '全部（中心库）' })}
          <span className="vb-skills-chip__count">{skills.length}</span>
        </button>
        {agentCategories.map((agent) => {
          const count = skills.filter((skill) => skill.installedAgents.some((installed) => installed.agentId === agent.id)).length
          return (
            <button
              key={agent.id}
              type="button"
              role="tab"
              aria-selected={categoryId === agent.id}
              className={`vb-skills-chip${categoryId === agent.id ? ' is--active' : ''}`}
              onClick={() => setCategoryId(agent.id)}
            >
              <AgentIconBadge iconKey={agent.iconKey} title={agent.displayName} size={16} />
              {t('settings.skillsOverview.categoryAgent', { name: agent.displayName, defaultValue: '生效于 {{name}}' })}
              <span className="vb-skills-chip__count">{count}</span>
            </button>
          )
        })}
        {hiddenAgents.length > 0 && (
          <button
            type="button"
            className={`vb-skills-chip vb-skills-chip--more${showHiddenAgents ? ' is--active' : ''}`}
            aria-expanded={showHiddenAgents}
            title={t('settings.skillsOverview.moreAgentsHint', { defaultValue: '未检测到可执行程序的 Agent 收在这里' })}
            onClick={() => {
              const next = !showHiddenAgents
              setShowHiddenAgents(next)
              if (!next && hiddenAgents.some((agent) => agent.id === categoryId)) setCategoryId(ALL_CATEGORY_ID)
            }}
          >
            +
            <span className="vb-skills-chip__count">{hiddenAgents.length}</span>
          </button>
        )}
      </div>

      <div className="vb-skills-note">
        {categoryId === ALL_CATEGORY_ID
          ? t('settings.skillsOverview.noteAll', {
              defaultValue: '中心库 Skill 默认不对任何 Agent 生效；Vibe Board 不会自动让它们作用于所有 Agent，也不会自动覆盖未来新安装的 Agent，没有「通用 / 专属」自动分配。未显示 Agent 图标的 Skill（尚未生效于任何 Agent）只存在于中心库，需在「完整管理」中手动让它生效。',
            })
          : t('settings.skillsOverview.noteAgent', {
              name: activeAgent?.displayName ?? categoryId,
              defaultValue: '以下 Skill 当前生效于 {{name}}，部分可能同时对其他 Agent 生效。这是真实的生效记录，不是「专属」绑定；安装或取消安装都要在「完整管理」中手动操作。',
            })}
      </div>

      <div className="vb-skills-note vb-skills-note--muted">
        {t('settings.skillsOverview.unassignedSummary', {
          n: unassignedCount,
          defaultValue: '当前有 {{n}} 个 Skill 尚未对任何 Agent 生效。',
        })}
      </div>

      {state.error && <div className="vb-skills-note" role="alert">{state.error}</div>}

      {categorySkills.length === 0 ? (
        <div className="vb-skills-empty">
          {state.loading
            ? t('settings.skillsOverview.loading', { defaultValue: '加载 Skill 库…' })
            : t('settings.skillsOverview.empty', { defaultValue: '当前分类还没有 Skill。可在「完整管理」中从本地、Git 或 Agent 目录导入。' })}
        </div>
      ) : (
        <div className="vb-skills-grid">
          {categorySkills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className="vb-skills-card"
              onClick={() => setSliderSkillId(skill.id)}
            >
              <div className="vb-skills-card__head">
                <span className="vb-skills-card__name">{skill.name}</span>
                <span className={`vb-skills-badge${skill.status === 'updateAvailable' || skill.status === 'conflict' ? ' vb-skills-badge--warn' : ' vb-skills-badge--muted'}`}>
                  {skillStatusLabel(t, skill.status)}
                </span>
              </div>
              {skill.description && <span className="vb-skills-card__desc">{skill.description}</span>}
              <div className="vb-skills-card__meta">
                <span>{skillSourceTypeLabel(t, skill.sourceType)}</span>
                {skill.installedAgents.length === 0 ? (
                  <span className="vb-skills-badge vb-skills-badge--muted">
                    {t('settings.skillsOverview.unassigned', { defaultValue: '尚未生效' })}
                  </span>
                ) : (
                  <span className="vb-skills-card__agents">
                    {skill.installedAgents.map((agent) => (
                      <AgentIconBadge key={`${skill.id}-${agent.agentId}`} iconKey={agent.iconKey} mode={agent.mode} title={agent.displayName} size={16} />
                    ))}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      <SkillUpdatePanel />

      <SkillDetailSlider
        skillId={sliderSkillId}
        open={Boolean(sliderSkillId)}
        onClose={() => setSliderSkillId(null)}
        onDistribute={(skill) => {
          setSliderSkillId(null)
          setDistributeFor([skill])
        }}
      />

      {distributeFor && state.settings && (
        <DistributeDialog
          skills={distributeFor}
          agents={state.agents}
          defaultMode={state.settings.defaultDistributeMode}
          onClose={() => setDistributeFor(null)}
          onDone={() => {
            setDistributeFor(null)
            void state.refresh()
          }}
        />
      )}

    </div>
  )
}
