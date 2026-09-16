import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { filterSkillsByQuery, useSkillStoreV2 } from '../../stores/skillStoreV2'
import { skillApiV2 } from '../../services/skillApiV2'
import type { GitHubSkillUpdatePreview, SkillSummary } from '../../services/skillApiV2'
import { AgentIconBadge } from './AgentIconBadge'
import { DistributeDialog } from './DistributeDialog'
import { PreviewDialog } from './PreviewDialog'
import { SkillDetailSlider } from './SkillDetailSlider'
import { skillSourceTypeLabel, skillStatusLabel } from './skillLabels'

const SHARED_SKILLS_AGENT_ID = 'agents'
const ALL_CATEGORY_ID = 'all'

type CheckStatus = 'update' | 'current' | 'error'

interface UpdateCheckResult {
  skillId: string
  name: string
  sourceUri: string
  status: CheckStatus
  message?: string
  preview?: GitHubSkillUpdatePreview
}

function isGitHubSource(skill: SkillSummary): boolean {
  const sourceType = skill.sourceType?.toLowerCase()
  const sourceUri = skill.sourceUri ?? ''
  return sourceType === 'github' || sourceUri.startsWith('github:') || sourceUri.includes('github.com/')
}

function shortHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash
}

export function SkillOverviewPage({ onOpenAdvanced }: { onOpenAdvanced?: () => void }) {
  const { t } = useTranslation()
  const state = useSkillStoreV2()
  const [categoryId, setCategoryId] = useState<string>(ALL_CATEGORY_ID)
  const [sliderSkillId, setSliderSkillId] = useState<string | null>(null)
  const [distributeFor, setDistributeFor] = useState<SkillSummary[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)
  const [results, setResults] = useState<UpdateCheckResult[]>([])
  const [syncTarget, setSyncTarget] = useState<UpdateCheckResult | null>(null)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)

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
  const agentCategories = useMemo(
    () => state.agents.filter((agent) => agent.id !== SHARED_SKILLS_AGENT_ID && agent.installed),
    [state.agents],
  )
  const activeAgent = agentCategories.find((agent) => agent.id === categoryId)
  const categorySkills = useMemo(() => {
    if (categoryId === ALL_CATEGORY_ID) return skills
    return skills.filter((skill) => skill.installedAgents.some((agent) => agent.agentId === categoryId))
  }, [categoryId, skills])
  const unassignedCount = useMemo(
    () => skills.filter((skill) => skill.installedAgents.length === 0).length,
    [skills],
  )
  const githubSkills = useMemo(() => skills.filter(isGitHubSource), [skills])
  const githubSkillCount = githubSkills.length

  const resultGroups = useMemo(() => {
    const groups = new Map<string, UpdateCheckResult[]>()
    for (const result of results) {
      const key = result.sourceUri || t('settings.skillsOverview.noSource', { defaultValue: '（未记录来源地址）' })
      const list = groups.get(key)
      if (list) list.push(result)
      else groups.set(key, [result])
    }
    return Array.from(groups.entries())
  }, [results, t])

  const checkUpdates = async () => {
    setChecking(true)
    setChecked(true)
    setResults([])
    const collected: UpdateCheckResult[] = []
    for (const skill of githubSkills) {
      try {
        const preview = await skillApiV2.checkGitHubSkillUpdate(skill.id)
        collected.push({
          skillId: skill.id,
          name: skill.name,
          sourceUri: preview.sourceUri || skill.sourceUri || '',
          status: preview.updateAvailable ? 'update' : 'current',
          preview,
        })
      } catch (error) {
        collected.push({
          skillId: skill.id,
          name: skill.name,
          sourceUri: skill.sourceUri || '',
          status: 'error',
          message: String(error),
        })
      }
      setResults([...collected])
    }
    setChecking(false)
  }

  const openSyncConfirm = (result: UpdateCheckResult) => {
    setSyncError(null)
    setSyncTarget(result)
  }

  const confirmSync = async () => {
    if (!syncTarget) return
    const skillId = syncTarget.skillId
    setSyncingId(skillId)
    setSyncError(null)
    try {
      await skillApiV2.syncGitHubSkill(skillId)
      setResults((current) => current.map((result) => (
        result.skillId === skillId
          ? {
              ...result,
              status: 'current',
              message: t('settings.skillsOverview.statusSynced', { defaultValue: '已同步到中心库' }),
            }
          : result
      )))
      setSyncTarget(null)
      await state.refresh()
    } catch (error) {
      setSyncError(String(error))
    } finally {
      setSyncingId(null)
    }
  }

  return (
    <div className="vb-skills-page">
      <header className="island-effect-picker__head">
        <h3>{t('settings.skillsOverview.title', { defaultValue: 'Skills' })}</h3>
        <p>{t('settings.skillsOverview.subtitle', { defaultValue: '只管理用户级 Skills，并按真实数据展示当前的分发情况。' })}</p>
      </header>

      <section className="vb-skills-scope">
        <span aria-hidden="true">ⓘ</span>
        <p>
          <strong>{t('settings.skillsOverview.scopeTitle', { defaultValue: '仅用户级 Skills' })}</strong>
          {t('settings.skillsOverview.scope', {
            centerPath: state.settings?.centerPath ?? '~/.agents/skills',
            defaultValue: '（中心库 {{centerPath}} 与各 Agent 用户目录），不扫描项目级 .skills。GitHub 来源的更新会先展示预览，确认后才覆盖中心库。',
          })}
        </p>
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
              defaultValue: '共 {{total}} 个用户级 Skill · {{github}} 个 GitHub 来源可检查',
            })}
          </span>
          <button
            type="button"
            className="vb-skills-btn vb-skills-btn--primary"
            disabled={checking || githubSkillCount === 0}
            onClick={() => void checkUpdates()}
          >
            {checking
              ? t('settings.skillsOverview.checking', { defaultValue: '检查中…' })
              : t('settings.skillsOverview.checkUpdates', { defaultValue: '检查更新' })}
          </button>
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
              {t('settings.skillsOverview.categoryAgent', { name: agent.displayName, defaultValue: '已分发到 {{name}}' })}
              <span className="vb-skills-chip__count">{count}</span>
            </button>
          )
        })}
      </div>

      <div className="vb-skills-note">
        {categoryId === ALL_CATEGORY_ID
          ? t('settings.skillsOverview.noteAll', {
              defaultValue: '中心库 Skill 默认处于未分类状态，不会自动作用于所有 Agent；Vibe Board 目前没有「通用 / 专属」自动分配能力，也不会自动覆盖未来新安装的 Agent。未显示 Agent 图标的 Skill（未分发）只存在于中心库，需在「完整管理」中手动分发。',
            })
          : t('settings.skillsOverview.noteAgent', {
              name: activeAgent?.displayName ?? categoryId,
              defaultValue: '以下 Skill 当前已分发到 {{name}}，部分可能同时分发到其他 Agent。这是真实的分发记录，不是「专属」绑定；安装或取消安装都要在「完整管理」中手动操作。',
            })}
      </div>

      <div className="vb-skills-note vb-skills-note--muted">
        {t('settings.skillsOverview.unassignedSummary', {
          n: unassignedCount,
          defaultValue: '当前有 {{n}} 个 Skill 尚未分发到任何 Agent。',
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
                    {t('settings.skillsOverview.unassigned', { defaultValue: '未分发' })}
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

      {checked && (
        <section className="vb-skills-updates" aria-live="polite">
          <div className="vb-skills-updates__head">
            <h3>{t('settings.skillsOverview.updatesTitle', { defaultValue: '更新检查' })}</h3>
            <span className="vb-skills-updates__status">
              {checking
                ? t('settings.skillsOverview.updatesChecking', { done: results.length, total: githubSkillCount, defaultValue: '检查中…（{{done}}/{{total}}）' })
                : t('settings.skillsOverview.updatesDone', { n: results.length, defaultValue: '已检查 {{n}} 个 GitHub 来源 Skill' })}
            </span>
          </div>
          {githubSkillCount === 0 && (
            <p className="vb-skills-updates__status">
              {t('settings.skillsOverview.noGithub', { defaultValue: '中心库当前没有 GitHub 来源的 Skill，无法检查远端更新；本地 / 手动导入 / 内置来源暂不支持远端更新检查。' })}
            </p>
          )}
          {resultGroups.map(([sourceUri, group]) => (
            <div key={sourceUri} className="vb-skills-updates__group">
              <span className="vb-skills-updates__source">{sourceUri}</span>
              {group.map((result) => (
                <div key={result.skillId} className="vb-skills-updates__row">
                  <span>{result.name}</span>
                  <span
                    className={`vb-skills-updates__status${result.status === 'update' ? ' vb-skills-updates__status--update' : ''}${result.status === 'error' ? ' vb-skills-updates__status--error' : ''}`}
                  >
                    {result.status === 'update'
                      ? t('settings.skillsOverview.statusUpdate', { defaultValue: '发现远端更新' })
                      : result.status === 'current'
                        ? (result.message ?? t('settings.skillsOverview.statusCurrent', { defaultValue: '已是最新' }))
                        : t('settings.skillsOverview.statusCheckFailed', { message: result.message ?? '', defaultValue: '检查失败：{{message}}' })}
                  </span>
                  {result.status === 'update' && (
                    <button
                      type="button"
                      className="vb-skills-btn"
                      disabled={syncingId !== null}
                      onClick={() => openSyncConfirm(result)}
                    >
                      {t('settings.skillsOverview.syncButton', { defaultValue: '同步到中心库' })}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </section>
      )}

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

      {syncTarget && (
        <PreviewDialog
          title={t('settings.skillsOverview.syncDialogTitle', { name: syncTarget.name, defaultValue: '同步「{{name}}」到中心库？' })}
          confirmLabel={t('settings.skillsOverview.syncConfirm', { defaultValue: '覆盖并同步' })}
          cancelLabel={t('settings.skillsOverview.syncCancel', { defaultValue: '取消' })}
          busyLabel={t('settings.skillsOverview.syncing', { defaultValue: '同步中…' })}
          destructive
          busy={syncingId === syncTarget.skillId}
          onConfirm={() => void confirmSync()}
          onCancel={() => {
            if (syncingId !== null) return
            setSyncTarget(null)
            setSyncError(null)
          }}
        >
          <div className="vb-skills-sync-preview">
            <p>{t('settings.skillsOverview.syncDialogIntro', { defaultValue: '同步会用 GitHub 远端内容替换中心库中的本地副本。' })}</p>
            <p className="vb-skills-sync-preview__warning">
              {t('settings.skillsOverview.syncDialogWarning', { defaultValue: '如果这个 Skill 在中心库中被本地修改过，这些修改会被远端版本覆盖，且无法从 Vibe Board 恢复。' })}
            </p>
            <dl className="vb-skills-sync-preview__facts">
              <div>
                <dt>{t('settings.skillsOverview.syncDialogSource', { defaultValue: '来源' })}</dt>
                <dd><code className="selectable">{syncTarget.sourceUri || t('settings.skillsOverview.noSource', { defaultValue: '（未记录来源地址）' })}</code></dd>
              </div>
              {syncTarget.preview && (
                <>
                  <div>
                    <dt>{t('settings.skillsOverview.syncDialogLocalHash', { defaultValue: '中心库当前 Hash' })}</dt>
                    <dd><code>{shortHash(syncTarget.preview.localHash)}</code></dd>
                  </div>
                  <div>
                    <dt>{t('settings.skillsOverview.syncDialogRemoteHash', { defaultValue: '远端 Hash' })}</dt>
                    <dd><code>{shortHash(syncTarget.preview.remoteHash)}</code></dd>
                  </div>
                  <div>
                    <dt>{t('settings.skillsOverview.syncDialogCheckedAt', { defaultValue: '检查时间' })}</dt>
                    <dd>{syncTarget.preview.checkedAt}</dd>
                  </div>
                </>
              )}
            </dl>
            {syncError && <p className="vb-skills-sync-preview__error" role="alert">{syncError}</p>}
          </div>
        </PreviewDialog>
      )}
    </div>
  )
}
