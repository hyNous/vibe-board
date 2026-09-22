import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentApi, type AgentProgramInfo } from '../../../services/agentApi'
import {
  dispatchApi,
  type DispatchDetection,
  type DispatchPlan,
  type DispatchPlanFile,
} from '../../../services/dispatchApi'
import { isAgentProgramInstalled } from '../../../utils/agentPrograms'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { PlatformIcon } from '../../platform/PlatformIcon'
import './DispatchSection.css'

const BLOCKER_KEYS: Record<string, string> = {
  node_missing: 'settings.dispatch.blockerNodeMissing',
  skills_missing: 'settings.dispatch.blockerSkillsMissing',
  catalog_invalid: 'settings.dispatch.blockerCatalogInvalid',
}

function groupPlanFiles(files: DispatchPlanFile[]) {
  const groups: { agentId: string; files: DispatchPlanFile[] }[] = []
  for (const file of files) {
    let group = groups.find((candidate) => candidate.agentId === file.agentId)
    if (!group) {
      group = { agentId: file.agentId, files: [] }
      groups.push(group)
    }
    group.files.push(file)
  }
  return groups
}

async function writeClipboardText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Fall through to the WebView-compatible copy command.
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('clipboard unavailable')
}

export function DispatchSection() {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<AgentProgramInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detection, setDetection] = useState<DispatchDetection | null>(null)
  const [plan, setPlan] = useState<DispatchPlan | null>(null)
  const [installedCount, setInstalledCount] = useState<number | null>(null)
  const overwriteCount = plan?.files.filter((file) => file.change === 'overwrite').length ?? 0
  const [busy, setBusy] = useState<'detect' | 'plan' | 'apply' | null>(null)
  const [wizardError, setWizardError] = useState('')
  const [copied, setCopied] = useState(false)

  const loadDetection = useCallback(async () => {
    setBusy('detect')
    setWizardError('')
    try {
      setDetection(await dispatchApi.detect())
    } catch (err) {
      setWizardError(String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    agentApi.list()
      .then((items) => {
        if (!cancelled) setAgents(items)
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    void loadDetection()
    return () => { cancelled = true }
  }, [loadDetection])

  const installedAgents = agents.filter(isAgentProgramInstalled)

  const handlePreview = async () => {
    setBusy('plan')
    setWizardError('')
    setInstalledCount(null)
    try {
      const next = await dispatchApi.plan()
      setPlan(next)
      setDetection(next.detection)
    } catch (err) {
      setWizardError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleInstall = async () => {
    if (!plan) return
    setBusy('apply')
    setWizardError('')
    try {
      const result = await dispatchApi.apply(true)
      setInstalledCount(result.writtenFiles.length)
      try {
        setDetection(await dispatchApi.detect())
      } catch {
        // The install already succeeded; a failed detection refresh must not hide it.
      }
    } catch (err) {
      setWizardError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleCopyRules = async () => {
    try {
      await writeClipboardText(t('settings.dispatch.rulesExample'))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const skillCount = detection?.skills.length ?? 0

  return (
    <SettingSection
      title={t('settings.dispatch.title', { defaultValue: '派发框架' })}
      description={t('settings.dispatch.desc', {
        defaultValue: '把派发 Skill 装进 Claude Code 与 Codex 的用户级 Skill 目录。装好后派发由你的主 Agent 直接完成，不再经过 Vibe Board。',
      })}
    >
      <SettingGroup label={t('settings.dispatch.installedAgents', { defaultValue: '已安装 Agent' })}>
        {loading && <div className="hook-empty">{t('settings.dispatch.loading', { defaultValue: '正在读取本机 Agent…' })}</div>}
        {error && <div className="hook-error-card" role="alert">{error}</div>}
        {!loading && !error && installedAgents.length === 0 && (
          <div className="hook-empty">{t('settings.dispatch.empty', { defaultValue: '没有检测到已安装的 Agent。' })}</div>
        )}
        {installedAgents.map((agent) => {
          const programPath = agent.binaryPath || agent.appPath
          return (
            <div className="dispatch-agent-row" key={agent.id} data-testid={`dispatch-agent-${agent.id}`}>
              <PlatformIcon agentId={agent.id} displayName={agent.displayName} size={30} />
              <div className="dispatch-agent-row__info">
                <div className="dispatch-agent-row__name">{agent.displayName}</div>
                <div className="dispatch-agent-row__path" title={programPath ?? ''}>
                  {programPath || t('settings.dispatch.noPath', { defaultValue: '未提供程序路径' })}
                </div>
              </div>
              <div className="dispatch-agent-row__version">
                <span>{t('settings.dispatch.version', { defaultValue: '版本' })}</span>
                <strong>{agent.installedVersion || 'Unknown'}</strong>
              </div>
            </div>
          )
        })}
      </SettingGroup>

      <SettingGroup label={t('settings.dispatch.wizard', { defaultValue: '搭建向导' })}>
        {busy === 'detect' && (
          <div className="hook-empty">{t('settings.dispatch.checking', { defaultValue: '正在检测…' })}</div>
        )}
        {wizardError && <div className="hook-error-card" role="alert">{wizardError}</div>}
        {detection && (
          <div className="dispatch-wizard">
            <div className="dispatch-status" data-testid="dispatch-node">
              <div className="dispatch-status__head">
                <strong>Node.js</strong>
                <span className={`dispatch-badge${detection.node.available ? ' dispatch-badge--on' : ' dispatch-badge--off'}`}>
                  {detection.node.available
                    ? t('settings.dispatch.available', { defaultValue: '可用' })
                    : t('settings.dispatch.unavailable', { defaultValue: '不可用' })}
                </span>
              </div>
              <div className="dispatch-status__row">
                <span>{t('settings.dispatch.path', { defaultValue: '程序路径' })}</span>
                <code>{detection.node.programPath || t('settings.dispatch.noPath', { defaultValue: '未提供程序路径' })}</code>
              </div>
              <div className="dispatch-status__row">
                <span>{t('settings.dispatch.version', { defaultValue: '版本' })}</span>
                <strong>{detection.node.version || 'Unknown'}</strong>
              </div>
            </div>

            {!detection.node.available && (
              <div className="dispatch-warning" data-testid="dispatch-node-missing" role="status">
                {t('settings.dispatch.nodeMissing', {
                  defaultValue: '未检测到 Node.js。派发 Skill 依赖 Node 运行；请先自行安装 Node.js，本向导不会自动安装。',
                })}
              </div>
            )}

            <div className="dispatch-subtitle">{t('settings.dispatch.workers', { defaultValue: '外部 CLI 工人（检测）' })}</div>
            {detection.workers.length === 0 && (
              <div className="hook-empty">{t('settings.dispatch.noWorkers', { defaultValue: '没有读取到工人配置。' })}</div>
            )}
            {detection.workers.map((worker) => (
              <div className="dispatch-status" key={worker.id} data-testid={`dispatch-worker-${worker.id}`}>
                <div className="dispatch-status__head">
                  <strong>{worker.displayName}</strong>
                  <span className={`dispatch-badge${worker.detected ? ' dispatch-badge--on' : ' dispatch-badge--off'}`}>
                    {worker.detected
                      ? t('settings.dispatch.workerDetected', { defaultValue: '已检测到' })
                      : t('settings.dispatch.workerMissing', { defaultValue: '未检测到' })}
                  </span>
                </div>
                <div className="dispatch-status__row">
                  <span>{t('settings.dispatch.path', { defaultValue: '程序路径' })}</span>
                  <code>{worker.programPath || t('settings.dispatch.noPath', { defaultValue: '未提供程序路径' })}</code>
                </div>
                <div className="dispatch-status__row">
                  <span>{t('settings.dispatch.version', { defaultValue: '版本' })}</span>
                  <strong>{worker.version || 'Unknown'}</strong>
                </div>
                <div className="dispatch-status__row">
                  <span>{t('settings.dispatch.credentialFile', { defaultValue: '凭据文件' })}</span>
                  <strong>
                    {worker.credentialFilePresent === null
                      ? t('settings.dispatch.credentialFileNone', { defaultValue: '不适用' })
                      : worker.credentialFilePresent
                        ? t('settings.dispatch.credentialFilePresent', { defaultValue: '存在（不读取内容）' })
                        : t('settings.dispatch.credentialFileAbsent', { defaultValue: '未找到' })}
                  </strong>
                </div>
              </div>
            ))}

            <div className="dispatch-subtitle">{t('settings.dispatch.targets', { defaultValue: '安装目标（主 Agent 用户级 Skill 目录）' })}</div>
            {detection.targets.map((target) => (
              <div className="dispatch-target" key={target.agentId} data-testid={`dispatch-target-${target.agentId}`}>
                <div className="dispatch-target__head">
                  <strong>{target.displayName}</strong>
                  <span className={`dispatch-badge${target.programDetected ? ' dispatch-badge--on' : ' dispatch-badge--off'}`}>
                    {target.programDetected
                      ? t('settings.dispatch.workerDetected', { defaultValue: '已检测到' })
                      : t('settings.dispatch.workerMissing', { defaultValue: '未检测到' })}
                  </span>
                  <span className="dispatch-target__count">
                    {t('settings.dispatch.installedSkills', {
                      count: target.installedSkills.length,
                      total: skillCount,
                      defaultValue: '已安装 {{count}}/{{total}}',
                    })}
                  </span>
                </div>
                <code>{target.skillsDir}</code>
              </div>
            ))}

            <p className="dispatch-hint" data-testid="dispatch-unknown-tools">
              {t('settings.dispatch.unknownTools', {
                defaultValue: '其它 CLI 工具：本向导不提供配置表单，请在你的 Agent 中运行 external-agent-setup 来接入。',
              })}
            </p>

            <div className="dispatch-actions">
              <button
                type="button"
                data-testid="dispatch-preview"
                onClick={() => void handlePreview()}
                disabled={busy !== null}
              >
                {busy === 'plan'
                  ? t('settings.dispatch.planning', { defaultValue: '正在生成预览…' })
                  : t('settings.dispatch.preview', { defaultValue: '预览将写入的文件' })}
              </button>
              <button
                type="button"
                className="dispatch-actions__primary"
                data-testid="dispatch-install"
                onClick={() => void handleInstall()}
                disabled={!plan?.canApply || busy !== null}
              >
                {busy === 'apply'
                  ? t('settings.dispatch.installing', { defaultValue: '正在安装…' })
                  : t('settings.dispatch.install', { defaultValue: '确认安装' })}
              </button>
            </div>

            {plan && plan.blockers.length > 0 && (
              <ul className="dispatch-blockers" data-testid="dispatch-blockers">
                {plan.blockers.map((blocker) => (
                  <li key={blocker}>
                    {t(BLOCKER_KEYS[blocker] ?? 'settings.dispatch.blockerOther', {
                      code: blocker,
                      defaultValue: blocker,
                    })}
                  </li>
                ))}
              </ul>
            )}

            {plan && plan.files.length > 0 && (
              <div className="dispatch-preview" data-testid="dispatch-preview-files">
                <div className="dispatch-preview__count">
                  {t('settings.dispatch.fileCount', { count: plan.files.length, defaultValue: '共 {{count}} 个文件' })}
                </div>
                {overwriteCount > 0 && (
                  <div className="hook-error-card" role="alert" data-testid="dispatch-overwrite-warning">
                    {t('settings.dispatch.overwriteWarning', {
                      count: overwriteCount,
                      defaultValue: '其中 {{count}} 个文件已存在且内容不同（可能是你自己改过的版本），确认后会被随包版本覆盖。',
                    })}
                  </div>
                )}
                {groupPlanFiles(plan.files).map((group) => (
                  <div className="dispatch-preview__group" key={group.agentId}>
                    <div className="dispatch-preview__group-title">
                      {t('settings.dispatch.targetAgent', { agent: group.agentId, defaultValue: '写入 {{agent}}' })}
                    </div>
                    <ul>
                      {group.files.map((file) => (
                        <li key={file.targetPath} data-testid="dispatch-file" data-change={file.change}>
                          <code>{file.targetPath}</code>
                          {file.change !== 'create' && (
                            <span className={`dispatch-preview__change dispatch-preview__change--${file.change}`}>
                              {file.change === 'overwrite'
                                ? t('settings.dispatch.changeOverwrite', { defaultValue: '将覆盖' })
                                : t('settings.dispatch.changeUnchanged', { defaultValue: '已是最新' })}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {installedCount !== null && (
              <div className="dispatch-success" data-testid="dispatch-installed" role="status">
                {t('settings.dispatch.installed', { count: installedCount, defaultValue: '已写入 {{count}} 个文件。' })}
              </div>
            )}
          </div>
        )}
      </SettingGroup>

      <SettingGroup label={t('settings.dispatch.rulesTitle', { defaultValue: '派发规则需要你自己写' })}>
        <div className="dispatch-rules">
          <p data-testid="dispatch-rules-desc">
            {t('settings.dispatch.rulesDesc', {
              defaultValue: '本向导只安装 Skill，不写入你的全局指令文件（如 ~/.claude/CLAUDE.md、~/.codex/AGENTS.md、~/AGENTS.md），也不代写派发规则。何时派、派给谁，请自行写入全局指令文件。下面是示例文本，可复制后修改：',
            })}
          </p>
          <pre className="dispatch-rules__example" data-testid="dispatch-rules-example">
            {t('settings.dispatch.rulesExample')}
          </pre>
          <button type="button" data-testid="dispatch-copy-rules" onClick={() => void handleCopyRules()}>
            {copied
              ? t('settings.dispatch.copied', { defaultValue: '已复制' })
              : t('settings.dispatch.copy', { defaultValue: '复制示例' })}
          </button>
        </div>
      </SettingGroup>
    </SettingSection>
  )
}
