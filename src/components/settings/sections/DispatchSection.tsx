import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentApi, type AgentProgramInfo } from '../../../services/agentApi'
import { isAgentProgramInstalled } from '../../../utils/agentPrograms'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { PlatformIcon } from '../../platform/PlatformIcon'

export function DispatchSection() {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<AgentProgramInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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
    return () => { cancelled = true }
  }, [])

  const installedAgents = agents.filter(isAgentProgramInstalled)

  return (
    <SettingSection
      title={t('settings.dispatch.title', { defaultValue: '派发框架' })}
      description={t('settings.dispatch.desc', { defaultValue: '查看本机已安装的 Agent。搭建向导将在后续里程碑提供，本页暂为只读。' })}
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
    </SettingSection>
  )
}
