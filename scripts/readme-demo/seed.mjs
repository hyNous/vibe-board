// Runs inside the page (via page.evaluate): fills the real UI's stores with the
// fictional demo data and stops the background refreshes that would replace it
// with this machine's state.
export async function seedDemo() {
  const data = await import('/scripts/readme-demo/demo-data.mjs')
  const { useSessionStore } = await import('/src/stores/sessionStore.ts')
  const { useSettingsLive } = await import('/src/stores/settingsLiveStore.ts')
  const { useSkillStoreV2 } = await import('/src/stores/skillStoreV2.ts')
  const now = Date.now()

  const sessions = useSessionStore.getState()
  sessions.replaceAllSessions(data.demoSessions(now))
  sessions.replaceUsageSnapshots(data.demoRateLimits(now))
  sessions.setAgentStatuses(data.demoAgentStatuses(now))

  const providers = data.demoUsageProviders(now)
  const noop = async () => {}
  useSettingsLive.setState({
    monitorSessions: data.demoMonitorSessions(now),
    monitorLoaded: true,
    usageProviders: providers,
    usageDashboard: { providers, computedAt: now, pricingEffectiveDate: null },
    refreshMonitor: noop,
    refreshUsage: noop,
    refreshProviders: noop,
  })

  const overview = data.demoSkillOverview()
  useSkillStoreV2.setState({
    overview,
    skills: overview.skills,
    agents: overview.agents,
    issues: [],
    settings: overview.settings,
    initialized: true,
    loading: false,
    init: noop,
    refresh: noop,
    loadOverview: noop,
  })
}
