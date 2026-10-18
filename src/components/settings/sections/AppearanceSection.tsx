import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../../stores/configStore'
import { useThemeStore, COLOR_THEMES } from '../../../stores/themeStore'
import { useSessionStore, selectSessionList } from '../../../stores/sessionStore'
import { useSettingsToast } from '../../../stores/settingsToastStore'
import { isPassiveSession } from '../../../utils/sessionDisplay'
import { CUSTOM_NOTCH_HEIGHT_MAX, CUSTOM_NOTCH_HEIGHT_MIN, getSideIslandDimensions, type SideIslandSize } from '../../../utils/islandLayout'
import {
  listDisplays, isTauri,
  setDisplayId, repositionNotch,
  previewIslandLayout, clearIslandLayoutPreview,
  setIslandFeatureFlags,
  getConfig, updateConfig as updateBackendConfig,
} from '../../../services/tauriApi'
import type { BackendDisplayInfo } from '../../../services/tauriApi'
import type { IslandLayoutPreviewMode, IslandLayoutPreviewOptions } from '../../../services/tauriApi'
import { Segmented } from '../Segmented'
import { Toggle } from '../Toggle'
import { Dropdown } from '../Dropdown'
import { Slider } from '../Slider'
import type { IslandSettingsView } from '../../../types/capability'
import './AppearanceSection.css'

function displayMatchesConfiguredValue(display: BackendDisplayInfo, value: string): boolean {
  return display.id === value || display.name === value || display.label === value
}

function normalizeDisplayMonitorValue(value: string, displays: BackendDisplayInfo[]): string {
  const normalizedValue = value.trim()
  if (normalizedValue === 'primary' || normalizedValue === 'auto' || !normalizedValue) return normalizedValue
  const display = displays.find((d) => displayMatchesConfiguredValue(d, normalizedValue))
  if (!display) {
    return displays.some((d) => d.isPrimary) && displays.every((d) => d.isPrimary) ? 'primary' : normalizedValue
  }
  return display.isPrimary ? 'primary' : display.id
}

type IslandFeatureFlag = 'tipsEnabled' | 'pixelCursorEnabled' | 'confettiEnabled' | 'followFocus'

const QUIET_ASSISTANT_PRESET = {
  interactionMode: 'minimal' as const,
  smartSuppression: true,
  autoHideNoSessions: true,
  idleCompactDwellSeconds: 8,
  noSessionsHideDelay: 10,
}
const PERSISTENT_MONITOR_PRESET = {
  interactionMode: 'persistent' as const,
  smartSuppression: true,
  autoHideNoSessions: false,
  idleCompactDwellSeconds: 8,
  noSessionsHideDelay: 10,
}

// 预览里的名字直接读会话，只有大小写拼不出来的产品名在这里写全。
const PREVIEW_AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'gemini-cli': 'Gemini CLI',
  'cursor-cli': 'Cursor CLI',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  codebuddy: 'CodeBuddy',
  codebuddycn: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
}

function previewAgentName(agentType: string) {
  return PREVIEW_AGENT_NAMES[agentType]
    ?? agentType
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
}

function persistIslandFeatureFlags(next: Partial<Record<IslandFeatureFlag, boolean>>) {
  const state = useConfigStore.getState()
  setIslandFeatureFlags({
    tipsEnabled: next.tipsEnabled ?? state.tipsEnabled,
    pixelCursorEnabled: next.pixelCursorEnabled ?? state.pixelCursorEnabled,
    confettiEnabled: next.confettiEnabled ?? state.confettiEnabled,
    followFocus: next.followFocus ?? state.followFocus,
  }).catch((err) => console.error('Failed to persist island feature flags:', err))
}

function persistIdleInteractionRouting(next: Partial<{ enabled: boolean; minutes: number }>) {
  const state = useConfigStore.getState()
  getConfig()
    .then((backendConfig) => updateBackendConfig({
      ...backendConfig,
      idleInteractionRoutingEnabled: next.enabled ?? state.idleInteractionRoutingEnabled,
      idleInteractionRoutingMinutes: next.minutes ?? state.idleInteractionRoutingMinutes,
    }))
    .catch((err) => console.error('Failed to persist idle interaction routing:', err))
}

function persistSessionRefreshInterval(seconds: number) {
  const value = Math.max(1, Math.min(30, Math.round(seconds)))
  getConfig()
    .then((backendConfig) => updateBackendConfig({ ...backendConfig, sessionRefreshIntervalSeconds: value }))
    .catch((err) => console.error('Failed to persist session refresh interval:', err))
}

// ═══════════════════════════════════════════════
// Appearance section — visual and position settings only
// ═══════════════════════════════════════════════

interface AppearanceSectionProps {
  activeView: IslandSettingsView
  onViewChange: (view: IslandSettingsView) => void
}

const APPEARANCE_VIEWS: Array<{ id: IslandSettingsView; labelKey: string; labelDefault: string }> = [
  { id: 'overview', labelKey: 'settings.island.tabs.overview', labelDefault: 'Overview' },
  { id: 'display', labelKey: 'settings.island.tabs.display', labelDefault: 'Position and size' },
  { id: 'behavior', labelKey: 'settings.island.tabs.behavior', labelDefault: 'Collapse and hide' },
  { id: 'advanced', labelKey: 'settings.island.tabs.advanced', labelDefault: 'Advanced' },
]

export function AppearanceSection({ activeView, onViewChange }: AppearanceSectionProps) {
  const { t, i18n } = useTranslation()
  const config = useConfigStore()
  const { colorTheme } = useThemeStore()
  const showToast = useSettingsToast((state) => state.show)
  const isZh = i18n.language?.startsWith('zh') ?? false
  // Only midnight / frosted-glass are real choices on this page. Any other
  // persisted theme must not be reported as "midnight selected".
  const activeEffect = colorTheme === 'midnight' || colorTheme === 'frosted-glass' ? colorTheme : null
  const currentTheme = COLOR_THEMES.find((theme) => theme.id === colorTheme)
  const currentThemeLabel = currentTheme ? (isZh ? currentTheme.labelZh : currentTheme.label) : colorTheme
  const [previewState, setPreviewState] = useState<'idle' | 'run'>('idle')
  const liveSessions = useSessionStore(selectSessionList)
  const previewAgents = useMemo(() => {
    const names = liveSessions
      .filter((session) => !isPassiveSession(session))
      .map((session) => previewAgentName(session.agentType))
    return Array.from(new Set(names)).slice(0, 2)
  }, [liveSessions])

  const resetIslandDefaults = () => {
    config.resetIslandDefaults()
    setDisplayId('auto')
      .then(() => repositionNotch('auto', 0))
      .catch((e) => console.error('Failed to reset island position:', e))
    showToast(t('settings.island.resetDone', { defaultValue: '灵动岛设置已恢复默认' }))
  }

  return (
    <section className="island-look">
      <header className="island-look__head">
        <div>
          <h1>{t('settings.island.title')}</h1>
          <p>{t('settings.island.desc')}</p>
        </div>
        <div className="island-look__acts">
          <button type="button" className="vb-btn" onClick={resetIslandDefaults}>
            {t('settings.island.resetAction', { defaultValue: '恢复默认' })}
          </button>
        </div>
      </header>

      <div className="island-look__stage">
        <div
          className={`island-look__island${activeEffect === 'frosted-glass' ? ' island-look__island--glass' : ''}`}
          style={{ width: previewState === 'run' ? 296 : 92 }}
        >
          <img src="/vibe-board-app-icon.png" alt="" aria-hidden="true" />
          {previewState === 'run' && (
            previewAgents.length > 0 ? (
              <span className="island-look__agents">
                {previewAgents.map((name) => (
                  <span className="island-look__agent" key={name}>
                    <i aria-hidden="true" />
                    {name}
                  </span>
                ))}
              </span>
            ) : (
              <span className="island-look__idle">
                {t('settings.island.preview.noAgents', { defaultValue: '现在没有 Agent 在运行' })}
              </span>
            )
          )}
        </div>
        <span className="island-look__cap">
          {activeEffect === 'frosted-glass'
            ? t('settings.island.effects.frostedGlass', { defaultValue: '磨砂玻璃' })
            : t('settings.island.effects.midnight', { defaultValue: '纯黑' })}
        </span>
        <div className="island-look__preview-state">
          <Segmented
            value={previewState}
            ariaLabel={t('settings.island.preview.label', { defaultValue: '灵动岛预览' })}
            options={[
              { value: 'idle', label: t('settings.island.preview.idle', { defaultValue: '空闲' }) },
              { value: 'run', label: t('settings.island.preview.run', { defaultValue: '运行中' }) },
            ]}
            onChange={setPreviewState}
          />
        </div>
      </div>

      <div className="island-look__tabs">
        <Segmented
          value={activeView}
          ariaLabel={t('settings.island.title')}
          options={APPEARANCE_VIEWS.map((view) => ({
            value: view.id,
            label: t(view.labelKey, { defaultValue: view.labelDefault }),
          }))}
          onChange={onViewChange}
        />
      </div>

      {activeView === 'overview' && (
        <OverviewTab
          activeEffect={activeEffect}
          currentThemeLabel={currentThemeLabel}
        />
      )}
      {activeView === 'display' && <DisplayTab />}
      {activeView === 'behavior' && <BehaviorTab />}
      {activeView === 'advanced' && <AdvancedTab />}
    </section>
  )
}

// ── Overview Tab ──
function OverviewTab({ activeEffect, currentThemeLabel }: { activeEffect: string | null; currentThemeLabel: string }) {
  const { t } = useTranslation()
  const config = useConfigStore()
  const { setColorTheme } = useThemeStore()
  const activeInteractionPreset = (
    config.interactionMode === QUIET_ASSISTANT_PRESET.interactionMode
    && config.smartSuppression === QUIET_ASSISTANT_PRESET.smartSuppression
    && config.autoHideNoSessions === QUIET_ASSISTANT_PRESET.autoHideNoSessions
    && config.idleCompactDwellSeconds === QUIET_ASSISTANT_PRESET.idleCompactDwellSeconds
    && config.noSessionsHideDelay === QUIET_ASSISTANT_PRESET.noSessionsHideDelay
  ) ? 'quiet' : (
    config.interactionMode === PERSISTENT_MONITOR_PRESET.interactionMode
    && config.smartSuppression === PERSISTENT_MONITOR_PRESET.smartSuppression
    && config.autoHideNoSessions === PERSISTENT_MONITOR_PRESET.autoHideNoSessions
    && config.idleCompactDwellSeconds === PERSISTENT_MONITOR_PRESET.idleCompactDwellSeconds
    && config.noSessionsHideDelay === PERSISTENT_MONITOR_PRESET.noSessionsHideDelay
  ) ? 'persistent' : 'custom'

  const applyInteractionPreset = (preset: typeof QUIET_ASSISTANT_PRESET | typeof PERSISTENT_MONITOR_PRESET) => {
    config.updateConfig('interactionMode', preset.interactionMode)
    config.updateConfig('smartSuppression', preset.smartSuppression)
    config.updateConfig('autoHideNoSessions', preset.autoHideNoSessions)
    config.updateConfig('idleCompactDwellSeconds', preset.idleCompactDwellSeconds)
    config.updateConfig('noSessionsHideDelay', preset.noSessionsHideDelay)
  }

  const presetDescription = activeInteractionPreset === 'quiet'
    ? t('settings.island.overview.quietAssistantDesc', { defaultValue: 'Hidden while agents run; appears for approvals, questions, failures, and completion notifications.' })
    : activeInteractionPreset === 'persistent'
      ? t('settings.island.overview.persistentMonitorDesc', { defaultValue: 'Keeps the island visible while agents run, then returns to a mini island when idle.' })
      : t('settings.island.overview.customPresetDesc', { defaultValue: 'One or more visibility timing settings differ from the presets below.' })

  return (
    <>
      <div className="island-look__group-title">
        {t('settings.island.groups.look', { defaultValue: '外观' })}
      </div>
      <div className="island-look__choices" role="radiogroup" aria-label={t('settings.island.effects.groupLabel', { defaultValue: '灵动岛外观效果' })}>
        <button
          type="button"
          role="radio"
          aria-checked={activeEffect === 'midnight'}
          className={`island-look__choice${activeEffect === 'midnight' ? ' island-look__choice--on' : ''}`}
          onClick={() => setColorTheme('midnight')}
        >
          <span className="island-look__swatch island-look__swatch--black" aria-hidden="true" />
          <span className="island-look__choice-text">
            <b>{t('settings.island.effects.midnight', { defaultValue: '纯黑' })}</b>
            <small>{t('settings.island.effects.midnightDesc', { defaultValue: '不透明黑色底，贴近屏幕边缘的默认效果。' })}</small>
          </span>
          <span className="island-look__tick" aria-hidden="true">✓</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={activeEffect === 'frosted-glass'}
          className={`island-look__choice${activeEffect === 'frosted-glass' ? ' island-look__choice--on' : ''}`}
          onClick={() => setColorTheme('frosted-glass')}
        >
          <span className="island-look__swatch island-look__swatch--glass" aria-hidden="true" />
          <span className="island-look__choice-text">
            <b>{t('settings.island.effects.frostedGlass', { defaultValue: '磨砂玻璃' })}</b>
            <small>{t('settings.island.effects.frostedGlassDesc', { defaultValue: '半透明浅色玻璃，透出虚化的桌面背景。' })}</small>
          </span>
          <span className="island-look__tick" aria-hidden="true">✓</span>
        </button>
      </div>

      {!activeEffect && (
        <p className="island-look__current" role="status">
          {t('settings.island.effects.currentOther', {
            name: currentThemeLabel,
            defaultValue: '当前使用其他配色主题「{{name}}」，不属于纯黑或磨砂玻璃；选择下方效果会立即切换。',
          })}
        </p>
      )}

      <div className="island-look__group-title">
        {t('settings.island.groups.content', { defaultValue: '显示内容' })}
      </div>
      <div className="island-look__panel">
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">
              {t('settings.island.appearWhen', { defaultValue: '什么时候出现' })}
            </div>
            <div className="island-look__row-description">{presetDescription}</div>
          </div>
          <div className="island-look__row-control">
            <Segmented
              value={activeInteractionPreset as 'quiet' | 'persistent' | 'custom'}
              ariaLabel={t('settings.island.overview.coreSwitches', { defaultValue: 'Core Switches' })}
              options={[
                { value: 'quiet', label: t('settings.island.overview.quietAssistant', { defaultValue: 'Quiet Assistant' }) },
                { value: 'persistent', label: t('settings.island.overview.persistentMonitor', { defaultValue: 'Persistent Monitor' }) },
              ]}
              onChange={(value) => applyInteractionPreset(value === 'quiet' ? QUIET_ASSISTANT_PRESET : PERSISTENT_MONITOR_PRESET)}
            />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.islandEnabled', { defaultValue: 'Enable Island' })}</div>
            <div className="island-look__row-description">{t('settings.islandEnabledDesc', { defaultValue: 'Show Vibe Board status, approvals, questions, and completions in the floating island.' })}</div>
          </div>
          <div className="island-look__row-control">
            <Toggle checked={config.islandEnabled} onChange={(v) => {
              config.updateConfig('islandEnabled', v)
              if (v) {
                applyInteractionPreset(PERSISTENT_MONITOR_PRESET)
              }
            }} />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.islandMonitorSubagents', { defaultValue: 'Monitor subagents' })}</div>
            <div className="island-look__row-description">{t('settings.islandMonitorSubagentsDesc', { defaultValue: 'Surface subagent activity and completion history in the island.' })}</div>
          </div>
          <div className="island-look__row-control">
            <Toggle checked={config.islandMonitorSubagents} onChange={(v) => config.updateConfig('islandMonitorSubagents', v)} />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.smartSuppression')}</div>
            <div className="island-look__row-description">{t('settings.smartSuppressionDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Toggle checked={config.smartSuppression} onChange={(v) => config.updateConfig('smartSuppression', v)} />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.tipsEnabled')}</div>
            <div className="island-look__row-description">{t('settings.tipsEnabledDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Toggle checked={config.tipsEnabled} onChange={(v) => {
              config.updateConfig('tipsEnabled', v)
              persistIslandFeatureFlags({ tipsEnabled: v })
            }} />
          </div>
        </div>
      </div>

      {activeInteractionPreset === 'custom' && (
        <div className="island-look__note" role="status">
          <b>{t('settings.island.overview.customPreset', { defaultValue: 'Custom visibility' })}</b>
          <span>{t('settings.island.overview.customPresetDesc', { defaultValue: 'One or more visibility timing settings differ from the presets below.' })}</span>
        </div>
      )}
    </>
  )
}

// ── Behavior Tab ──
function BehaviorTab() {
  const { t } = useTranslation()
  const config = useConfigStore()

  const idleTimeoutOptions = [
    { value: '0', label: t('settings.idleTimeoutDisabled') },
    { value: '1', label: t('settings.idleTimeoutMinutes', { minutes: 1 }) },
    { value: '5', label: t('settings.idleTimeoutMinutes', { minutes: 5 }) },
    { value: '10', label: t('settings.idleTimeoutMinutes', { minutes: 10 }) },
    { value: '15', label: t('settings.idleTimeoutMinutes', { minutes: 15 }) },
    { value: '30', label: t('settings.idleTimeoutMinutes', { minutes: 30 }) },
  ]
  const idleInteractionRoutingOptions = [
    { value: '1', label: t('settings.idleTimeoutMinutes', { minutes: 1 }) },
    { value: '5', label: t('settings.idleTimeoutMinutes', { minutes: 5 }) },
    { value: '10', label: t('settings.idleTimeoutMinutes', { minutes: 10 }) },
    { value: '15', label: t('settings.idleTimeoutMinutes', { minutes: 15 }) },
    { value: '30', label: t('settings.idleTimeoutMinutes', { minutes: 30 }) },
  ]

  return (
    <>
      <div className="island-look__group-title">{t('settings.island.section.hide', { defaultValue: 'Hide and Collapse' })}</div>
      <div className="island-look__panel">
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.autoHideNoSessions')}</div>
            <div className="island-look__row-description">{t('settings.autoHideNoSessionsDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Toggle checked={config.autoHideNoSessions} onChange={(v) => config.updateConfig('autoHideNoSessions', v)} />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.idleCompactDwell')}</div>
            <div className="island-look__row-description">{t('settings.idleCompactDwellDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={config.idleCompactDwellSeconds} min={0} max={60} step={1}
              onCommit={(v) => config.updateConfig('idleCompactDwellSeconds', v)} unit="s" />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.noSessionsHideDelay')}</div>
            <div className="island-look__row-description">{t('settings.noSessionsHideDelayDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={config.noSessionsHideDelay} min={1} max={30} step={1}
              onCommit={(v) => config.updateConfig('noSessionsHideDelay', v)} unit="min" />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.escSilenceDuration')}</div>
            <div className="island-look__row-description">{t('settings.escSilenceDurationDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={config.escSilenceDuration} min={10} max={300} step={10}
              onCommit={(v) => config.updateConfig('escSilenceDuration', v)} unit="s" />
          </div>
        </div>
      </div>

      <div className="island-look__group-title">{t('settings.island.section.sessionHandling', { defaultValue: 'Session Handling' })}</div>
      <div className="island-look__panel">
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.refreshRate', { defaultValue: '刷新频率' })}</div>
            <div className="island-look__row-description">{t('settings.refreshRateDesc', { defaultValue: '没有实时事件时，后台轮询会按此间隔补读会话状态。事件通知仍会立即更新。' })}</div>
          </div>
          <div className="island-look__row-control">
            <Dropdown
              value={String(config.sessionRefreshIntervalSeconds)}
              options={[1, 2, 3, 5, 10, 30].map((seconds) => ({ value: String(seconds), label: `${seconds}s` }))}
              onChange={(v) => {
                const seconds = Number(v)
                config.updateConfig('sessionRefreshIntervalSeconds', seconds)
                persistSessionRefreshInterval(seconds)
              }}
              minWidth={120}
            />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.carouselInterval')}</div>
            <div className="island-look__row-description">{t('settings.carouselIntervalDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={config.carouselIntervalMs} min={1000} max={10000} step={500}
              onCommit={(v) => config.updateConfig('carouselIntervalMs', v)} unit="ms" />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.idleTimeout')}</div>
            <div className="island-look__row-description">{t('settings.idleTimeoutDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Dropdown value={String(config.idleTimeoutMinutes)} options={idleTimeoutOptions}
              onChange={(v) => config.updateConfig('idleTimeoutMinutes', Number(v))} minWidth={130} />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.idleInteractionRouting')}</div>
            <div className="island-look__row-description">{t('settings.idleInteractionRoutingDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Toggle checked={config.idleInteractionRoutingEnabled} onChange={(v) => {
              config.updateConfig('idleInteractionRoutingEnabled', v)
              persistIdleInteractionRouting({ enabled: v })
            }} />
          </div>
        </div>
        {config.idleInteractionRoutingEnabled && (
          <div className="island-look__row">
            <div className="island-look__row-info">
              <div className="island-look__row-label">{t('settings.idleInteractionRoutingMinutes')}</div>
              <div className="island-look__row-description">{t('settings.idleInteractionRoutingMinutesDesc')}</div>
            </div>
            <div className="island-look__row-control">
              <Dropdown
                value={String(config.idleInteractionRoutingMinutes)}
                options={idleInteractionRoutingOptions}
                onChange={(v) => {
                  const minutes = Number(v)
                  config.updateConfig('idleInteractionRoutingMinutes', minutes)
                  persistIdleInteractionRouting({ minutes })
                }}
                minWidth={130}
              />
            </div>
          </div>
        )}
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.sessionTimeout')}</div>
            <div className="island-look__row-description">{t('settings.sessionTimeoutDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={config.sessionTimeoutMinutes} min={1} max={120} step={1}
              onCommit={(v) => config.updateConfig('sessionTimeoutMinutes', v)} unit="min" />
          </div>
        </div>
      </div>
    </>
  )
}

// ── Display Tab ──
function DisplayTab() {
  const { t } = useTranslation()
  const config = useConfigStore()
  const showToast = useSettingsToast((state) => state.show)
  // 灵动岛配色只在总览页的两种效果中切换，位置与尺寸页不再重复提供配色入口。
  const [displays, setDisplays] = useState<BackendDisplayInfo[]>([])
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const compactPillWidthValue = Math.round(config.compactPillWidth * (config.collapsedWidthScale / 100))

  useEffect(() => {
    listDisplays().then(setDisplays)
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<BackendDisplayInfo[]>('display-changed', (e) => { setDisplays(e.payload) }).then((fn) => { unlisten = fn })
    })
    return () => { unlisten?.() }
  }, [])

  const previewLayout = useCallback((mode: IslandLayoutPreviewMode, overrides: IslandLayoutPreviewOptions = {}) => {
    const state = useConfigStore.getState()
    previewIslandLayout(mode, {
      collapsedWidthScale: state.collapsedWidthScale,
      microPillWidth: state.microPillWidth,
      compactPillWidth: state.compactPillWidth,
      panelMaxWidth: state.panelMaxWidth,
      notchHeightMode: state.notchHeightMode,
      customNotchHeight: state.customNotchHeight,
      contentFontSize: state.contentFontSize,
      completionCardHeight: state.completionCardHeight,
      maxPanelHeight: state.maxPanelHeight,
      detailPanelMaxHeight: state.detailPanelMaxHeight,
      sideIslandSize: state.sideIslandSize,
      ...overrides,
    }).catch((e) => console.error('Failed to preview island layout:', e))
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(() => {
      clearIslandLayoutPreview().catch(() => {})
      previewTimerRef.current = undefined
    }, 1800)
  }, [])

  useEffect(() => () => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    clearIslandLayoutPreview().catch(() => {})
  }, [])

  const fontSizeOptions = [
    { value: '11px', label: `11px - ${t('settings.fontSizeSmall', { defaultValue: 'Small' })}` },
    { value: '12px', label: `12px - ${t('settings.fontSizeCompact', { defaultValue: 'Compact' })}` },
    { value: '13px', label: `13px - ${t('settings.fontSizeDefault', { defaultValue: 'Default' })}` },
    { value: '14px', label: `14px - ${t('settings.fontSizeMedium', { defaultValue: 'Medium' })}` },
    { value: '16px', label: `16px - ${t('settings.fontSizeLarge', { defaultValue: 'Large' })}` },
  ]
  const sideIslandSizeOptions = [
    { value: 'narrow', label: t('settings.sideIslandSizeNarrow', { defaultValue: 'Narrow' }) },
    { value: 'standard', label: t('settings.sideIslandSizeStandard', { defaultValue: 'Standard' }) },
    { value: 'wide', label: t('settings.sideIslandSizeWide', { defaultValue: 'Wide' }) },
  ]
  const sideIslandSizeDimensions = getSideIslandDimensions(config.sideIslandSize)
  const monitorOptions = [
    {
      value: 'primary',
      label: displays.find((d) => d.isPrimary)?.label
        ? `${t('settings.mainDisplay')} · ${displays.find((d) => d.isPrimary)?.label}`
        : t('settings.mainDisplay'),
    },
    { value: 'auto', label: t('settings.autoFollowFocus') },
    ...displays
      .filter((d) => !d.isPrimary)
      .map((d) => ({ value: d.id, label: d.label })),
  ]
  const displayMonitorValue = normalizeDisplayMonitorValue(config.displayMonitor, displays)

  const hostVisibilityOptions = [
    { value: 'independent', label: t('settings.hostVisibilityIndependent', { defaultValue: 'Codex 最小化时保持显示' }) },
    { value: 'follow', label: t('settings.hostVisibilityFollow', { defaultValue: 'Codex 最小化时一起隐藏' }) },
  ]
  const islandPositionLabel = config.notchPositionMode === 'left'
    ? t('settings.notchPositionLeft', { defaultValue: '贴靠左侧' })
    : config.notchPositionMode === 'right'
      ? t('settings.notchPositionRight', { defaultValue: '贴靠右侧' })
      : config.panelHorizontalOffset === 0
        ? t('settings.islandPositionCenter', { defaultValue: 'Centered' })
        : config.panelHorizontalOffset < 0
          ? t('settings.islandPositionLeft', { defaultValue: '{{value}}px left', value: Math.abs(config.panelHorizontalOffset) })
          : t('settings.islandPositionRight', { defaultValue: '{{value}}px right', value: config.panelHorizontalOffset })

  return (
    <>
      <div className="island-look__group-title">{t('settings.island.section.displayPlacement', { defaultValue: 'Display Placement' })}</div>
      <div className="island-look__panel">
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.displayMonitor')}</div>
            <div className="island-look__row-description">{t('settings.displayMonitorDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Dropdown value={displayMonitorValue} options={monitorOptions}
              onChange={(v) => {
                config.updateConfig('displayMonitor', v)
                setDisplayId(v)
                  .then(() => repositionNotch(v))
                  .catch((e) => console.error('Failed to set display:', e))
              }} minWidth={180} />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.hostVisibilityMode', { defaultValue: 'Codex 最小化行为' })}</div>
            <div className="island-look__row-description">{t('settings.hostVisibilityModeDesc', { defaultValue: '选择 Codex 桌面窗口最小化时是否同步隐藏刘海。' })}</div>
          </div>
          <div className="island-look__row-control">
            <Dropdown value={config.hostVisibilityMode} options={hostVisibilityOptions}
              onChange={(v) => {
                const hostVisibilityMode = v === 'follow' ? 'follow' : 'independent'
                config.updateConfig('hostVisibilityMode', hostVisibilityMode)
                getConfig()
                  .then((backendConfig) => updateBackendConfig({ ...backendConfig, hostVisibilityMode }))
                  .catch((e) => console.error('Failed to persist host visibility mode:', e))
              }} minWidth={220} />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.allowHorizontalDrag', { defaultValue: '允许拖动位置' })}</div>
            <div className="island-look__row-description">{t('settings.allowHorizontalDragDesc', { defaultValue: '直接拖动刘海；释放后会自动贴到顶部、左侧或右侧最近的屏幕边缘。' })}</div>
          </div>
          <div className="island-look__row-control">
            <Toggle checked={config.allowHorizontalDrag} onChange={(v) => config.updateConfig('allowHorizontalDrag', v)} />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.resetIslandPosition', { defaultValue: 'Reset Island Position' })}</div>
            <div className="island-look__row-description">{islandPositionLabel}</div>
          </div>
          <div className="island-look__row-control">
            <button className="vb-btn" type="button" onClick={() => {
              config.updateConfig('notchPositionMode', 'top')
              config.updateConfig('panelHorizontalOffset', 0)
              config.updateConfig('notchVerticalOffset', 0)
              getConfig()
                .then((backendConfig) => updateBackendConfig({ ...backendConfig, notchPositionMode: 'top', panelHorizontalOffset: 0, notchVerticalOffset: 0 }))
                .then(() => repositionNotch())
                .catch((e) => console.error('Failed to reset island position:', e))
              showToast(t('settings.island.positionResetDone', { defaultValue: '灵动岛已回到正中间' }))
            }}>
              {t('settings.resetCenter', { defaultValue: 'Reset to Center' })}
            </button>
          </div>
        </div>
      </div>

      <div className="island-look__group-title">{t('settings.island.groups.size', { defaultValue: '尺寸' })}</div>
      <div className="island-look__panel">
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.notchHeightMode')}</div>
            <div className="island-look__row-description">{t('settings.notchHeightModeDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Dropdown value={config.notchHeightMode}
              options={[
                { value: 'matchNotch', label: t('settings.heightMatchNotch') },
                { value: 'matchMenuBar', label: t('settings.heightMatchMenuBar') },
                { value: 'custom', label: t('settings.heightCustom') },
              ]}
              onChange={(v) => {
                const notchHeightMode = v as 'matchNotch' | 'matchMenuBar' | 'custom'
                config.updateConfig('notchHeightMode', notchHeightMode)
                previewLayout('compact', { notchHeightMode })
              }} minWidth={160} />
          </div>
        </div>
        {config.notchHeightMode === 'custom' && (
          <div className="island-look__row">
            <div className="island-look__row-info">
              <div className="island-look__row-label">{t('settings.customNotchHeight')}</div>
              <div className="island-look__row-description">{`${config.customNotchHeight}px`}</div>
            </div>
            <div className="island-look__row-control">
              <Slider value={config.customNotchHeight} min={CUSTOM_NOTCH_HEIGHT_MIN} max={CUSTOM_NOTCH_HEIGHT_MAX} step={1}
                onChange={(v) => previewLayout('compact', { notchHeightMode: 'custom', customNotchHeight: v })}
                onCommit={(v) => config.updateConfig('customNotchHeight', v)} unit="px" />
            </div>
          </div>
        )}
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.microPillWidth', { defaultValue: 'Micro Pill Width' })}</div>
            <div className="island-look__row-description">{`${config.microPillWidth}px`}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={config.microPillWidth} min={84} max={180} step={4}
              onChange={(v) => previewLayout('micro', { microPillWidth: v })}
              onCommit={(v) => config.updateConfig('microPillWidth', v)} unit="px" />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.compactPillWidth', { defaultValue: 'Compact Pill Width' })}</div>
            <div className="island-look__row-description">{`${compactPillWidthValue}px`}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={compactPillWidthValue} min={260} max={520} step={10}
              onChange={(v) => previewLayout('compact', { compactPillWidth: v, collapsedWidthScale: 100 })}
              onCommit={(v) => {
                config.updateConfig('compactPillWidth', v)
                config.updateConfig('collapsedWidthScale', 100)
              }} unit="px" />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.panelMaxWidth', { defaultValue: 'Expanded Panel Width' })}</div>
            <div className="island-look__row-description">{`${config.panelMaxWidth}px`}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={config.panelMaxWidth} min={480} max={760} step={10}
              onChange={(v) => previewLayout('expanded', { panelMaxWidth: v })}
              onCommit={(v) => config.updateConfig('panelMaxWidth', v)} unit="px" />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.maxPanelHeight')}</div>
            <div className="island-look__row-description">{`${config.maxPanelHeight}px`}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={config.maxPanelHeight} min={300} max={800} step={20}
              onChange={(v) => previewLayout('expanded', { maxPanelHeight: v })}
              onCommit={(v) => config.updateConfig('maxPanelHeight', v)} unit="px" />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.completionCardHeight')}</div>
            <div className="island-look__row-description">{`${config.completionCardHeight}px`}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={config.completionCardHeight} min={80} max={420} step={10}
              onChange={(v) => previewLayout('completion', { completionCardHeight: v })}
              onCommit={(v) => config.updateConfig('completionCardHeight', v)} unit="px" />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.sideIslandSize', { defaultValue: 'Side Island Size' })}</div>
            <div className="island-look__row-description">
              {t('settings.sideIslandSizeDesc', {
                defaultValue: 'Size of the vertical strip docked to the left or right edge: {{value}}px. The top style is unchanged.',
                value: `${sideIslandSizeDimensions.shellWidth} × ${sideIslandSizeDimensions.panelHeight}`,
              })}
            </div>
          </div>
          <div className="island-look__row-control">
            <Dropdown
              value={config.sideIslandSize}
              options={sideIslandSizeOptions}
              onChange={(v) => {
                const sideIslandSize = v as SideIslandSize
                config.updateConfig('sideIslandSize', sideIslandSize)
                previewLayout('compact', { sideIslandSize })
              }}
              minWidth={140}
            />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.contentFontSize')}</div>
          </div>
          <div className="island-look__row-control">
            <Dropdown value={config.contentFontSize} options={fontSizeOptions}
              onChange={(v) => { config.updateConfig('contentFontSize', v); previewLayout('expanded', { contentFontSize: v }) }} minWidth={160} />
          </div>
        </div>
      </div>
    </>
  )
}

// ── Advanced Tab ──
function AdvancedTab() {
  const { t } = useTranslation()
  const config = useConfigStore()
  const hoverSpeedOptions = [
    { value: 'instant', label: t('settings.hoverSpeedInstant') },
    { value: 'normal', label: t('settings.hoverSpeedNormal') },
    { value: 'slow', label: t('settings.hoverSpeedSlow') },
  ]

  return (
    <>
      <div className="island-look__group-title">{t('settings.island.section.expand', { defaultValue: 'Animation' })}</div>
      <div className="island-look__panel">
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.islandAnimationScale', { defaultValue: 'Animation Scale' })}</div>
            <div className="island-look__row-description">{t('settings.islandAnimationScaleDesc', { defaultValue: 'Adjust the speed of island open, close, and content motion.' })}</div>
          </div>
          <div className="island-look__row-control">
            <Slider value={config.islandAnimationScale} min={0.25} max={6} step={0.25}
              onCommit={(v) => config.updateConfig('islandAnimationScale', v)} unit="x" />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.hoverSpeed')}</div>
            <div className="island-look__row-description">{t('settings.hoverSpeedDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Dropdown value={config.hoverSpeed} options={hoverSpeedOptions}
              onChange={(v) => config.updateConfig('hoverSpeed', v as 'instant' | 'normal' | 'slow')} minWidth={160} />
          </div>
        </div>
      </div>

      <div className="island-look__group-title">{t('settings.island.section.visualSignals', { defaultValue: 'Visual Signals' })}</div>
      <div className="island-look__panel">
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.showToolStatus')}</div>
            <div className="island-look__row-description">{t('settings.showToolStatusDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Toggle checked={config.showToolStatus} onChange={(v) => config.updateConfig('showToolStatus', v)} />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.agentActivity')}</div>
            <div className="island-look__row-description">{t('settings.agentActivityDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Toggle checked={config.showAgentActivityDetails} onChange={(v) => config.updateConfig('showAgentActivityDetails', v)} />
          </div>
        </div>
        <div className="island-look__row">
          <div className="island-look__row-info">
            <div className="island-look__row-label">{t('settings.pixelCursor')}</div>
            <div className="island-look__row-description">{t('settings.pixelCursorDesc')}</div>
          </div>
          <div className="island-look__row-control">
            <Toggle checked={config.pixelCursorEnabled} onChange={(v) => {
              config.updateConfig('pixelCursorEnabled', v)
              persistIslandFeatureFlags({ pixelCursorEnabled: v })
            }} />
          </div>
        </div>
      </div>
    </>
  )
}
