// Fictional demo data for the README recordings. Every project, title and
// number here is made up; nothing is read from the recording machine.

const MIN = 60_000
const HOUR = 60 * MIN

const emptyTokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }

function session(now, fields) {
  return {
    terminal: 'Windows Terminal',
    startedAt: now - 6 * MIN,
    duration: 0,
    tokens: emptyTokens,
    chatHistory: [],
    subagents: [],
    activeTools: [],
    lastActivityAt: now - 5_000,
    lastMainAgentAt: now - 5_000,
    ...fields,
  }
}

export function demoSessions(now) {
  return [
    session(now, {
      id: 'demo-claude',
      agentType: 'claude',
      project: 'weather-app',
      cwd: 'D:\\demo\\weather-app',
      phase: 'processing',
      sessionTitle: '给城市搜索加上拼音匹配',
      lastUserMessage: '给城市搜索加上拼音匹配',
      lastToolName: 'Edit',
      lastToolTarget: 'src/search/pinyin.ts',
      startedAt: now - 4 * MIN,
      lastUserMessageAt: now - 4 * MIN,
      activeTools: [{ toolUseId: 'demo-t1', toolName: 'Grep', status: 'running', startedAt: now - 3_000 }],
    }),
    session(now, {
      id: 'demo-codex',
      agentType: 'codex',
      engineLabel: 'Codex Desktop',
      terminal: 'Codex',
      termBundleId: 'com.openai.codex',
      project: 'shop-api',
      cwd: 'D:\\demo\\shop-api',
      phase: 'processing',
      sessionTitle: '修复订单分页返回重复数据',
      lastUserMessage: '修复订单分页返回重复数据',
      lastToolName: 'shell',
      startedAt: now - 11 * MIN,
      lastUserMessageAt: now - 11 * MIN,
    }),
    session(now, {
      id: 'demo-opencode',
      agentType: 'opencode',
      project: 'blog',
      cwd: 'D:\\demo\\blog',
      phase: 'idle',
      sessionTitle: '把首页图片换成 WebP',
      lastUserMessage: '把首页图片换成 WebP',
      responseText: '已把 12 张图片转成 WebP，首页体积从 3.1 MB 降到 0.9 MB。',
      taskCompletedAt: now - 40_000,
      idleSince: now - 40_000,
      startedAt: now - 9 * MIN,
    }),
  ]
}

function windowsOf(fiveHour, weekly, fiveReset, weekReset) {
  return [
    { id: 'five_hour', title: '5 小时', usedPercent: fiveHour, remainingPercent: 100 - fiveHour, remainingLabel: fiveReset, windowMinutes: 300 },
    { id: 'seven_day', title: '每周', usedPercent: weekly, remainingPercent: 100 - weekly, remainingLabel: weekReset, windowMinutes: 10080 },
  ]
}

export function demoRateLimits(now) {
  return [
    {
      provider: 'claude', providerLabel: 'Claude Code', source: 'network', updatedAt: now,
      fiveHourUsage: 38, fiveHourRemaining: '2h14m', sevenDayUsage: 61, sevenDayRemaining: '3d5h',
      windows: windowsOf(38, 61, '2h14m', '3d5h'),
    },
    {
      provider: 'codex', providerLabel: 'Codex', source: 'local', updatedAt: now,
      fiveHourUsage: 72, fiveHourRemaining: '1h02m', sevenDayUsage: 44, sevenDayRemaining: '4d20h',
      windows: windowsOf(72, 44, '1h02m', '4d20h'),
    },
    {
      provider: 'opencode', providerLabel: 'OpenCode', source: 'network', updatedAt: now,
      fiveHourUsage: 12, fiveHourRemaining: '4h31m', sevenDayUsage: 27, sevenDayRemaining: '6d1h',
      windows: windowsOf(12, 27, '4h31m', '6d1h'),
    },
  ]
}

export function demoAgentStatuses(now) {
  const limits = Object.fromEntries(demoRateLimits(now).map((limit) => [limit.provider, limit]))
  return [
    { agent: 'claude', label: 'Claude Code', online: true, lastSeenAt: now, tokens: emptyTokens, rateLimits: limits.claude },
    { agent: 'codex', label: 'Codex', online: true, lastSeenAt: now, tokens: emptyTokens, rateLimits: limits.codex },
    { agent: 'opencode', label: 'OpenCode', online: true, lastSeenAt: now, tokens: emptyTokens, rateLimits: limits.opencode },
  ]
}

export { HOUR, MIN }

// Settings window → 任务 page.
export function demoMonitorSessions(now) {
  return demoSessions(now).map((s) => ({
    id: s.id,
    agentType: s.agentType,
    engineLabel: s.engineLabel ?? null,
    project: s.project,
    cwd: s.cwd,
    terminal: s.terminal,
    phase: s.phase,
    startedAt: s.startedAt,
    duration: now - s.startedAt,
    tokenTotal: 0,
    lastToolName: s.lastToolName ?? null,
    lastToolTarget: s.lastToolTarget ?? null,
    lastToolStatus: s.phase === 'processing' ? 'running' : null,
    subagentCount: s.id === 'demo-codex' ? 2 : 0,
    activeToolCount: s.phase === 'processing' ? 1 : 0,
    title: s.sessionTitle ?? null,
  }))
}

// Settings window → 额度 page.
export function demoUsageProviders(now) {
  const base = {
    state: 'ok', detail: '', fetchedAt: now,
    history: { available: false, source: null, detail: '', sessionsScanned: null, tokenEvents: null, pricingEffectiveDate: null, periods: [] },
    enabled: true, catalogSupported: true, implementationStatus: 'active', authStatus: 'authorized', authPath: null,
    canAuthorize: true, networkUnsupportedReason: null, detected: true, loginExpiresAt: null,
  }
  return demoRateLimits(now).map((limit, index) => ({
    ...base,
    provider: limit.provider,
    label: limit.providerLabel,
    source: limit.source,
    windows: limit.windows,
    settingsOrder: index,
    networkSupported: limit.provider !== 'codex',
    networkAuthorized: limit.provider !== 'codex',
    networkKind: limit.provider === 'codex' ? null : 'http',
    networkTarget: null,
    networkCredential: null,
  }))
}

// Settings window → Skill page.
const AGENTS = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
  ['gemini', 'Gemini CLI'],
  ['antigravity', 'Antigravity'],
]

const SKILLS = [
  ['code-review', '按团队规范审查改动，列出问题和修改建议', 'github', ['claude', 'codex', 'opencode']],
  ['write-tests', '为改动的函数补单元测试，并先确认测试会失败', 'github', ['claude', 'codex']],
  ['commit-message', '根据暂存区改动写一条约定式提交说明', 'local', ['claude', 'codex', 'opencode', 'gemini']],
  ['frontend-design', '按设计规范搭页面：配色、间距、组件状态', 'github', ['claude', 'antigravity']],
  ['api-docs', '从路由代码生成接口文档和调用示例', 'local', ['codex']],
  ['translate-docs', '中英文档互译，保留代码块和链接', 'github', ['opencode', 'gemini']],
]

export function demoSkillOverview() {
  const name = Object.fromEntries(AGENTS)
  const skills = SKILLS.map(([id, description, sourceType, agents]) => ({
    id,
    name: id,
    description,
    skillType: 'skill',
    sourceType,
    sourceUri: sourceType === 'github' ? `https://github.com/example/skills/tree/main/${id}` : null,
    centerPath: `~/.agents/skills/${id}`,
    currentHash: id,
    status: 'ok',
    installedAgents: agents.map((agentId) => ({ agentId, displayName: name[agentId], iconKey: agentId, mode: 'link', status: 'ok' })),
  }))
  const agents = AGENTS.map(([id, displayName]) => ({
    id,
    displayName,
    iconKey: id,
    enabled: true,
    skillsDir: `~/.${id}/skills`,
    version: null,
    latestVersion: null,
    installed: true,
    programInstalled: true,
    managedSkillCount: skills.filter((skill) => skill.installedAgents.some((agent) => agent.agentId === id)).length,
    unmanagedSkillCount: 0,
  }))
  return {
    metrics: { centerSkillCount: skills.length, targetCount: skills.reduce((n, s) => n + s.installedAgents.length, 0), unmanagedCount: 0, issueCount: 0 },
    skills,
    agents,
    issues: [],
    settings: {
      centerPath: '~/.agents/skills',
      sqlitePath: '~/.vibeboard/skill-manager/skill-manager.db',
      defaultDistributeMode: 'link',
      linkFailPolicy: 'ask',
      startupScan: true,
      showUnmanaged: true,
    },
  }
}
