import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  dispatchApi,
  type DispatchAgentNode,
  type DispatchConnectPlan,
  type DispatchConnection,
  type DispatchDisconnectPlan,
  type DispatchPlanFile,
  type DispatchRemoval,
  type DispatchTree,
} from '../../../services/dispatchApi'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { PlatformIcon } from '../../platform/PlatformIcon'
import './DispatchSection.css'

const BLOCKER_KEYS: Record<string, string> = {
  node_missing: 'settings.dispatch.blockerNodeMissing',
  tool_missing: 'settings.dispatch.blockerToolMissing',
}

function installErrorMessage(t: TFunction, error: unknown) {
  const message = String(error)
  if (message.includes('NODE_MISSING')) {
    return t('settings.dispatch.installNodeMissing', {
      defaultValue: 'Node.js was not found. The install needs Node, so install it yourself and reopen this page.',
    })
  }
  const failed = message.match(/INSTALL_FAILED:\s*([\s\S]*)/)
  if (failed) {
    return t('settings.dispatch.installFailed', {
      detail: failed[1].trim(),
      defaultValue: 'The install did not finish: {{detail}}',
    })
  }
  if (message.includes('INSTALL_INCOMPLETE')) {
    return t('settings.dispatch.installIncomplete', {
      defaultValue: 'The install command finished but the tool files are incomplete. Try again, or install it manually following the tutorial.',
    })
  }
  return message
}


type PendingChange =
  | { kind: 'connect'; plan: DispatchConnectPlan }
  | { kind: 'disconnect'; plan: DispatchDisconnectPlan }

function Details({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="dispatch-details">
      <button
        type="button"
        className="dispatch-details__toggle"
        data-testid={testId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open && (
        <div className="dispatch-details__body" data-testid={`${testId}-body`}>
          {children}
        </div>
      )}
    </div>
  )
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
  const [tree, setTree] = useState<DispatchTree | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pickerAgent, setPickerAgent] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingChange | null>(null)
  const [notice, setNotice] = useState('')
  const [appliedFiles, setAppliedFiles] = useState<DispatchPlanFile[]>([])
  const [kept, setKept] = useState<DispatchRemoval[]>([])
  const [copied, setCopied] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [installing, setInstalling] = useState(false)

  const loadTree = useCallback(async () => {
    try {
      setTree(await dispatchApi.tree())
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  const addDisabled = busy || !tree?.node.available || !tree?.toolInstalled

  const installTool = async () => {
    setInstalling(true)
    setError('')
    setNotice('')
    try {
      const result = await dispatchApi.install(true)
      if (result.sourceRecorded) {
        setNotice(t('settings.dispatch.installDone', { defaultValue: 'The handoff tool is installed.' }))
      } else {
        setError(t('settings.dispatch.installSourceMissing', {
          defaultValue: 'The tool is installed, but its GitHub source record is missing, so the Skill update check cannot take over. Reinstall with GitHub available.',
        }))
      }
      setInstallOpen(false)
      await loadTree()
    } catch (err) {
      setError(installErrorMessage(t, err))
    } finally {
      setInstalling(false)
    }
  }

  const beginConnect = async (agentId: string, workerId: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    setAppliedFiles([])
    setKept([])
    try {
      const plan = await dispatchApi.connectPlan(agentId, workerId)
      setPending({ kind: 'connect', plan })
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmConnect = async (plan: DispatchConnectPlan) => {
    setBusy(true)
    setError('')
    try {
      const result = await dispatchApi.connectApply(plan.agentId, plan.workerId, true)
      setAppliedFiles(result.writtenFiles)
      setNotice(t('settings.dispatch.connected', {
        agent: plan.agentDisplayName,
        worker: plan.workerDisplayName,
        defaultValue: '已让 {{agent}} 可以把任务派给 {{worker}}。',
      }))
      setPending(null)
      setPickerAgent(null)
      await loadTree()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const beginDisconnect = async (agent: DispatchAgentNode, connection: DispatchConnection) => {
    setBusy(true)
    setError('')
    setNotice('')
    setAppliedFiles([])
    setKept([])
    try {
      const plan = await dispatchApi.disconnectPlan(agent.agentId, connection.workerId)
      setPending({ kind: 'disconnect', plan })
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const confirmDisconnect = async (plan: DispatchDisconnectPlan) => {
    setBusy(true)
    setError('')
    try {
      const result = await dispatchApi.disconnectApply(plan.agentId, plan.workerId, true)
      setKept(result.kept)
      setAppliedFiles([])
      setNotice(t('settings.dispatch.disconnected', {
        agent: plan.agentDisplayName,
        worker: plan.workerDisplayName,
        defaultValue: '已断开：{{agent}} 不能再把任务派给 {{worker}}。',
      }))
      setPending(null)
      await loadTree()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
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

  const workerName = (workerId: string) =>
    tree?.workers.find((worker) => worker.id === workerId)?.displayName ?? workerId

  const renderRemovalList = (removals: DispatchRemoval[], testId: string) => (
    <ul className="dispatch-details__list" data-testid={testId}>
      {removals.map((removal) => (
        <li key={removal.targetPath} data-testid="dispatch-removal" data-action={removal.action}>
          <span>{removal.skillId}</span>
          <code>{removal.targetPath}</code>
        </li>
      ))}
    </ul>
  )

  const renderPending = (agent: DispatchAgentNode) => {
    if (!pending || pending.plan.agentId !== agent.agentId) return null
    if (pending.kind === 'connect') {
      const plan = pending.plan
      const overwriteCount = plan.files.filter((file) => file.change === 'overwrite').length
      return (
        <div className="dispatch-confirm" data-testid={`dispatch-confirm-${agent.agentId}-${plan.workerId}`}>
          <p className="dispatch-confirm__sentence">
            {t('settings.dispatch.confirmConnect', {
              agent: plan.agentDisplayName,
              worker: plan.workerDisplayName,
              defaultValue: '让 {{agent}} 可以把任务派给 {{worker}}。',
            })}
          </p>
          {plan.blockers.map((blocker) => (
            <div className="hook-error-card" role="alert" key={blocker} data-testid="dispatch-blocker">
              {t(BLOCKER_KEYS[blocker] ?? 'settings.dispatch.blockerOther', { defaultValue: blocker })}
            </div>
          ))}
          {overwriteCount > 0 && (
            <div className="dispatch-warning" role="alert" data-testid="dispatch-overwrite-warning">
              {t('settings.dispatch.overwriteWarning', {
                count: overwriteCount,
                defaultValue: '其中 {{count}} 个文件已存在且内容不同（可能是你自己改过的版本），确认后会被已安装版本覆盖。',
              })}
            </div>
          )}
          <Details
            label={t('settings.dispatch.details')}
            testId={`dispatch-files-${agent.agentId}-${plan.workerId}`}
          >
            <div className="dispatch-details__count">
              {t('settings.dispatch.filesToWrite', {
                count: plan.files.length,
                defaultValue: '将写入以下文件（{{count}} 个）',
              })}
            </div>
            <ul className="dispatch-details__list">
              {plan.files.map((file) => (
                <li key={file.targetPath} data-testid="dispatch-file" data-change={file.change}>
                  <code>{file.targetPath}</code>
                  <span className={`dispatch-change dispatch-change--${file.change}`}>
                    {file.change === 'create'
                      ? t('settings.dispatch.changeCreate', { defaultValue: '新建' })
                      : file.change === 'overwrite'
                        ? t('settings.dispatch.changeOverwrite', { defaultValue: '将覆盖' })
                        : t('settings.dispatch.changeUnchanged', { defaultValue: '已是最新' })}
                  </span>
                </li>
              ))}
            </ul>
          </Details>
          <div className="dispatch-actions">
            <button
              type="button"
              className="dispatch-actions__primary"
              data-testid="dispatch-confirm-apply"
              disabled={busy || !plan.canApply}
              onClick={() => void confirmConnect(plan)}
            >
              {busy
                ? t('settings.dispatch.working', { defaultValue: '正在处理…' })
                : t('settings.dispatch.confirmAdd', { defaultValue: '确认添加' })}
            </button>
            <button
              type="button"
              data-testid="dispatch-confirm-cancel"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              {t('settings.dispatch.cancel', { defaultValue: '取消' })}
            </button>
          </div>
        </div>
      )
    }

    const plan = pending.plan
    return (
      <div className="dispatch-confirm" data-testid={`dispatch-disconnect-confirm-${agent.agentId}-${plan.workerId}`}>
        <p className="dispatch-confirm__sentence">
          {t('settings.dispatch.confirmDisconnect', {
            agent: plan.agentDisplayName,
            worker: plan.workerDisplayName,
            defaultValue: '断开后，{{agent}} 就不能把任务派给 {{worker}} 了。',
          })}
        </p>
        {plan.affectedAgents.length > 0 && (
          <div className="dispatch-warning" role="alert" data-testid="dispatch-shared-warning">
            {t('settings.dispatch.disconnectSharedWarning', {
              agents: plan.affectedAgents.join(t('settings.dispatch.listSeparator', { defaultValue: '、' })),
              defaultValue: '这个工人装在共用目录里。断开后，同样读取该目录的 {{agents}} 也会一起失去它。',
            })}
          </div>
        )}
        <Details
          label={t('settings.dispatch.details')}
          testId={`dispatch-removals-${agent.agentId}-${plan.workerId}`}
        >
          {plan.removals.length > 0 && (
            <>
              <div className="dispatch-details__count">
                {t('settings.dispatch.filesToRemove', {
                  count: plan.removals.length,
                  defaultValue: '将移除以下文件（{{count}} 个）',
                })}
              </div>
              {renderRemovalList(plan.removals, 'dispatch-removals')}
            </>
          )}
          {plan.kept.some((entry) => entry.action === 'keep_modified') && (
            <>
              <div className="dispatch-details__count">
                {t('settings.dispatch.keptHint', {
                  defaultValue: '以下内容与已安装版本不同（你自己改过），已保留：',
                })}
              </div>
              {renderRemovalList(plan.kept.filter((entry) => entry.action === 'keep_modified'), 'dispatch-kept')}
            </>
          )}
        </Details>
        {plan.kept.some((entry) => entry.action === 'keep_shared') && (
          <div className="dispatch-warning" data-testid="dispatch-shared-kept" role="status">
            {t('settings.dispatch.keptSharedHint', {
              defaultValue: '这个工人放在多个 Agent 共用的 Skill 文件夹里，断开不会删除它，其他 Agent 仍可使用。如需彻底停用，请到 Skill 页面卸载。',
            })}
          </div>
        )}
        <div className="dispatch-actions">
          <button
            type="button"
            className="dispatch-actions__primary"
            data-testid="dispatch-disconnect-apply"
            disabled={busy || !plan.canApply}
            onClick={() => void confirmDisconnect(plan)}
          >
            {busy
              ? t('settings.dispatch.working', { defaultValue: '正在处理…' })
              : t('settings.dispatch.confirmDisconnectAction', { defaultValue: '确认断开' })}
          </button>
          <button
            type="button"
            data-testid="dispatch-disconnect-cancel"
            disabled={busy}
            onClick={() => setPending(null)}
          >
            {t('settings.dispatch.cancel', { defaultValue: '取消' })}
          </button>
        </div>
      </div>
    )
  }

  return (
    <SettingSection
      title={t('settings.dispatch.title', { defaultValue: '让 Agent 互相派活' })}
      description={t('settings.dispatch.desc', {
        defaultValue: '让一个 Agent 把任务派给另一个 Agent。点「＋ 添加工人」建立关系，点「断开」解除关系；装好之后派活由主 Agent 直接完成，不经过 Vibe Board。',
      })}
    >
      {loading && (
        <div className="hook-empty" data-testid="dispatch-loading">
          {t('settings.dispatch.loading', { defaultValue: '正在读取本机 Agent…' })}
        </div>
      )}
      {error && (
        <div className="hook-error-card" role="alert" data-testid="dispatch-error">
          {error}
        </div>
      )}

      {tree && !tree.node.available && (
        <div className="dispatch-warning" data-testid="dispatch-node-missing" role="status">
          {t('settings.dispatch.nodeMissing', {
            defaultValue: '没有找到 Node.js。派发功能需要 Node 运行，请先自行安装，然后重新打开这一页。',
          })}
        </div>
      )}

      {tree && !tree.toolInstalled && (
        <SettingGroup label={t('settings.dispatch.installTitle', { defaultValue: '先安装派活工具' })}>
          <p className="dispatch-install__desc" data-testid="dispatch-install-desc">
            {t('settings.dispatch.installDesc', {
              defaultValue: '这套工具不在 Vibe Board 安装包里，只在你确认后从 GitHub 下载安装一次，之后没有 Vibe Board 也能单独使用。',
            })}
          </p>
          {!installOpen ? (
            <div className="dispatch-actions">
              <button
                type="button"
                className="dispatch-actions__primary"
                data-testid="dispatch-install-start"
                disabled={busy || installing || !tree.node.available}
                onClick={() => {
                  setError('')
                  setInstallOpen(true)
                }}
              >
                {t('settings.dispatch.installButton', { defaultValue: '从 GitHub 安装（hyNous/agent-dispatch）' })}
              </button>
            </div>
          ) : (
            <div className="dispatch-confirm" data-testid="dispatch-install-confirm">
              <p className="dispatch-confirm__sentence">
                {t('settings.dispatch.installConfirmDesc', {
                  defaultValue: '会访问 GitHub 下载 hyNous/agent-dispatch，安装到本机用户目录，并留下来源记录，之后 Vibe Board 的 Skill 更新检查可以接手。确定现在安装吗？',
                })}
              </p>
              <Details label={t('settings.dispatch.details', { defaultValue: '详情' })} testId="dispatch-install-details">
                <div className="dispatch-details__row">
                  <span>{t('settings.dispatch.installTarget', { defaultValue: '安装目录' })}</span>
                  <code>~/.agents/skills</code>
                </div>
                <div className="dispatch-details__row">
                  <span>{t('settings.dispatch.installSourceRecord', { defaultValue: '来源记录' })}</span>
                  <code>~/.agents/.skill-lock.json</code>
                </div>
              </Details>
              <div className="dispatch-actions">
                <button
                  type="button"
                  className="dispatch-actions__primary"
                  data-testid="dispatch-install-apply"
                  disabled={installing}
                  onClick={() => void installTool()}
                >
                  {installing
                    ? t('settings.dispatch.installWorking', { defaultValue: '正在从 GitHub 安装…' })
                    : t('settings.dispatch.installApply', { defaultValue: '确认安装' })}
                </button>
                <button
                  type="button"
                  data-testid="dispatch-install-cancel"
                  disabled={installing}
                  onClick={() => setInstallOpen(false)}
                >
                  {t('settings.dispatch.cancel', { defaultValue: '取消' })}
                </button>
              </div>
            </div>
          )}
        </SettingGroup>
      )}

      <SettingGroup label={t('settings.dispatch.treeTitle', { defaultValue: '谁可以把任务派给谁' })}>
        {tree && tree.agents.length === 0 && (
          <div className="hook-empty" data-testid="dispatch-empty-agents">
            {t('settings.dispatch.emptyAgents', { defaultValue: '没有检测到已安装的 Agent。' })}
          </div>
        )}
        {tree?.agents.map((agent) => (
          <div className="dispatch-node" key={agent.agentId} data-testid={`dispatch-agent-${agent.agentId}`}>
            <div className="dispatch-node__head">
              <PlatformIcon agentId={agent.agentId} displayName={agent.displayName} size={30} />
              <strong className="dispatch-node__name">{agent.displayName}</strong>
              {!agent.verified && (
                <span className="dispatch-badge dispatch-badge--muted" data-testid={`dispatch-unverified-${agent.agentId}`}>
                  {t('settings.dispatch.unverified', { defaultValue: '未验证' })}
                </span>
              )}
            </div>

            <div className="dispatch-node__workers">
              {agent.connections.length === 0 && (
                <p className="dispatch-node__empty">
                  {t('settings.dispatch.noConnections', {
                    agent: agent.displayName,
                    defaultValue: '{{agent}} 还没有可以派活的工人。',
                  })}
                </p>
              )}
              {agent.connections.map((connection) => (
                <div
                  className="dispatch-worker"
                  key={connection.workerId}
                  data-testid={`dispatch-connection-${agent.agentId}-${connection.workerId}`}
                >
                  <span className="dispatch-worker__arrow" aria-hidden="true">→</span>
                  <span className="dispatch-worker__name">{connection.displayName}</span>
                  {connection.sharedWith.length > 0 && (
                    <span
                      className="dispatch-worker__shared"
                      data-testid={`dispatch-shared-${agent.agentId}-${connection.workerId}`}
                    >
                      {t('settings.dispatch.sharedWith', {
                        agents: connection.sharedWith.join(t('settings.dispatch.listSeparator', { defaultValue: '、' })),
                        defaultValue: '与 {{agents}} 共用',
                      })}
                    </span>
                  )}
                  <button
                    type="button"
                    data-testid={`dispatch-disconnect-${agent.agentId}-${connection.workerId}`}
                    disabled={busy}
                    onClick={() => void beginDisconnect(agent, connection)}
                  >
                    {t('settings.dispatch.disconnect', { defaultValue: '断开' })}
                  </button>
                </div>
              ))}
            </div>

            <Details label={t('settings.dispatch.details', { defaultValue: '详情' })} testId={`dispatch-agent-details-${agent.agentId}`}>
              {agent.readDirs.map((dir) => (
                <div className="dispatch-details__row" key={dir.path}>
                  <span>
                    {dir.shared
                      ? t('settings.dispatch.sharedDirectory', { defaultValue: '共用目录' })
                      : t('settings.dispatch.readDirs', { defaultValue: '读取目录' })}
                  </span>
                  <code>{dir.path}</code>
                </div>
              ))}
            </Details>

            <div className="dispatch-actions">
              <button
                type="button"
                data-testid={`dispatch-add-${agent.agentId}`}
                disabled={addDisabled}
                aria-expanded={pickerAgent === agent.agentId}
                onClick={() => {
                  setPending(null)
                  setPickerAgent(pickerAgent === agent.agentId ? null : agent.agentId)
                }}
              >
                {t('settings.dispatch.addWorker', { defaultValue: '＋ 添加工人' })}
              </button>
            </div>

            {pickerAgent === agent.agentId && tree && (
              <div className="dispatch-picker" data-testid={`dispatch-picker-${agent.agentId}`}>
                {agent.addableWorkers.length === 0 && (
                  <p className="dispatch-picker__empty">
                    {tree.workers.some((worker) => worker.detected)
                      ? t('settings.dispatch.noAddableWorkers', {
                        defaultValue: '本机检测到的工人都已经连上了。',
                      })
                      : t('settings.dispatch.noWorkersDetected', {
                        defaultValue: '本机没有检测到 OpenCode 或 Antigravity。先安装其中之一，再回到这一页。',
                      })}
                  </p>
                )}
                {agent.addableWorkers.map((workerId) => (
                  <button
                    type="button"
                    key={workerId}
                    className="dispatch-picker__worker"
                    data-testid={`dispatch-add-worker-${agent.agentId}-${workerId}`}
                    disabled={busy || !tree.toolInstalled}
                    onClick={() => void beginConnect(agent.agentId, workerId)}
                  >
                    {workerName(workerId)}
                  </button>
                ))}
                <div className="dispatch-picker__other" data-testid={`dispatch-other-tools-${agent.agentId}`}>
                  <strong>{t('settings.dispatch.otherTools', { defaultValue: '其他工具' })}</strong>
                  <p>
                    {t('settings.dispatch.otherToolsHint', {
                      agent: agent.displayName,
                      defaultValue: '在你的 {{agent}} 里运行 $external-agent-setup，它会按同一套规则生成新的具名工人。这里不提供配置表单。',
                    })}
                  </p>
                </div>
              </div>
            )}

            {renderPending(agent)}
          </div>
        ))}
      </SettingGroup>

      {notice && (
        <div className="dispatch-success" data-testid="dispatch-notice" role="status">
          {notice}
        </div>
      )}
      {appliedFiles.length > 0 && (
        <Details label={t('settings.dispatch.details', { defaultValue: '详情' })} testId="dispatch-applied-files">
          <div className="dispatch-details__count">
            {t('settings.dispatch.writtenFiles', {
              count: appliedFiles.length,
              defaultValue: '已写入以下文件（{{count}} 个）',
            })}
          </div>
          <ul className="dispatch-details__list">
            {appliedFiles.map((file) => (
              <li key={file.targetPath} data-testid="dispatch-applied-file">
                <code>{file.targetPath}</code>
              </li>
            ))}
          </ul>
        </Details>
      )}
      {kept.some((entry) => entry.action === 'keep_shared') && (
        <div className="dispatch-warning" data-testid="dispatch-shared-kept-result" role="status">
          {t('settings.dispatch.keptSharedHint', {
            defaultValue: '这个工人放在多个 Agent 共用的 Skill 文件夹里，断开不会删除它，其他 Agent 仍可使用。如需彻底停用，请到 Skill 页面卸载。',
          })}
        </div>
      )}
      {kept.some((entry) => entry.action === 'keep_modified') && (
        <div className="dispatch-warning" data-testid="dispatch-kept-warning" role="status">
          <div>{t('settings.dispatch.keptHint', { defaultValue: '以下内容与已安装版本不同（你自己改过），已保留：' })}</div>
          <ul className="dispatch-details__list">
            {kept.filter((entry) => entry.action === 'keep_modified').map((removal) => (
              <li key={removal.targetPath} data-testid="dispatch-kept-item">
                <span>{removal.skillId}</span>
                <code>{removal.targetPath}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <SettingGroup label={t('settings.dispatch.detailsDetect', { defaultValue: '检测详情' })}>
        <Details label={t('settings.dispatch.details', { defaultValue: '详情' })} testId="dispatch-detection-details">
          {tree && (
            <>
              <div className="dispatch-details__row">
                <span>Node.js</span>
                <strong>
                  {tree.node.available
                    ? t('settings.dispatch.available', { defaultValue: '可用' })
                    : t('settings.dispatch.unavailable', { defaultValue: '不可用' })}
                </strong>
              </div>
              <div className="dispatch-details__row">
                <span>{t('settings.dispatch.path', { defaultValue: '程序路径' })}</span>
                <code>{tree.node.programPath ?? t('settings.dispatch.noPath', { defaultValue: '未提供程序路径' })}</code>
              </div>
              <div className="dispatch-details__row">
                <span>{t('settings.dispatch.version', { defaultValue: '版本' })}</span>
                <strong>{tree.node.version ?? 'Unknown'}</strong>
              </div>
              {tree.workers.map((worker) => (
                <div className="dispatch-details__worker" key={worker.id} data-testid={`dispatch-worker-${worker.id}`}>
                  <div className="dispatch-details__row">
                    <span>{worker.displayName}</span>
                    <strong>
                      {worker.detected
                        ? t('settings.dispatch.workerDetected', { defaultValue: '已检测到' })
                        : t('settings.dispatch.workerMissing', { defaultValue: '未检测到' })}
                    </strong>
                  </div>
                  <div className="dispatch-details__row">
                    <span>{t('settings.dispatch.path', { defaultValue: '程序路径' })}</span>
                    <code>{worker.programPath ?? t('settings.dispatch.noPath', { defaultValue: '未提供程序路径' })}</code>
                  </div>
                  <div className="dispatch-details__row">
                    <span>{t('settings.dispatch.version', { defaultValue: '版本' })}</span>
                    <strong>{worker.version ?? 'Unknown'}</strong>
                  </div>
                  <div className="dispatch-details__row">
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
            </>
          )}
        </Details>
      </SettingGroup>

      <SettingGroup label={t('settings.dispatch.rulesTitle', { defaultValue: '派发规则需要你自己写' })}>
        <Details label={t('settings.dispatch.details', { defaultValue: '详情' })} testId="dispatch-rules-details">
          <div className="dispatch-rules">
            <p data-testid="dispatch-rules-desc">
              {t('settings.dispatch.rulesDesc', {
                defaultValue: '这里只写入派发需要的文件，不写入你的全局指令文件（如 ~/.claude/CLAUDE.md、~/.codex/AGENTS.md、~/AGENTS.md），也不代写派发规则。何时派、派给谁，请自行写入全局指令文件。下面是示例文本，可复制后修改：',
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
        </Details>
      </SettingGroup>
    </SettingSection>
  )
}
