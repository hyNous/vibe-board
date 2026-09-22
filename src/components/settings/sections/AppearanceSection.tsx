import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../../stores/configStore'
import { useThemeStore, COLOR_THEMES } from '../../../stores/themeStore'
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
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { Toggle } from '../Toggle'
import { Dropdown } from '../Dropdown'
import { Slider } from '../Slider'
import { GlassButton } from '../../shared'
import type { IslandSettingsView } from '../../../types/capability'

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

function persistWindowCloseBehavior(value: 'tray' | 'exit') {
  getConfig()
    .then((backendConfig) => updateBackendConfig({ ...backendConfig, windowCloseBehavior: value }))
    .catch((err) => console.error('Failed to persist window close behavior:', err))
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
  { id: 'display', labelKey: 'settings.island.tabs.display', labelDefault: 'Display' },
  { id: 'behavior', labelKey: 'settings.island.tabs.behavior', labelDefault: 'Behavior' },
  { id: 'advanced', labelKey: 'settings.island.tabs.advanced', labelDefault: 'Advanced' },
]

export function AppearanceSection({ activeView, onViewChange }: AppearanceSectionProps) {
  const { t } = useTranslation()

  return (
    <SettingSection className="setting-section--compact island-settings-section" title={t('settings.island.title')} description={t('settings.island.desc')}>
      <div className="island-view-tabs" role="tablist" aria-label={t('settings.island.title')}>
        {APPEARANCE_VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            className={`island-view-tab${activeView === view.id ? ' active' : ''}`}
            aria-pressed={activeView === view.id}
            title={t(view.labelKey, { defaultValue: view.labelDefault })}
            onClick={() => onViewChange(view.id)}
          >
            {t(view.labelKey, { defaultValue: view.labelDefault })}
          </button>
        ))}
      </div>
      {activeView === 'overview' && <OverviewTab />}
      {activeView === 'display' && <DisplayTab />}
      {activeView === 'behavior' && <BehaviorTab />}
      {activeView === 'advanced' && <AdvancedTab />}
    </SettingSection>
  )
}

// ── Overview Tab ──
function OverviewTab() {
  const { t, i18n } = useTranslation()
  const config = useConfigStore()
  const { colorTheme, setColorTheme } = useThemeStore()
  const isZh = i18n.language?.startsWith('zh')
  // Only midnight / frosted-glass are real choices on this page. Any other
  // persisted theme must not be reported as "midnight selected".
  const activeEffect = colorTheme === 'midnight' || colorTheme === 'frosted-glass' ? colorTheme : null
  const currentTheme = COLOR_THEMES.find((theme) => theme.id === colorTheme)
  const currentThemeLabel = currentTheme ? (isZh ? currentTheme.labelZh : currentTheme.label) : colorTheme
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

  const resetIslandDefaults = () => {
    config.resetIslandDefaults()
    setDisplayId('auto')
      .then(() => repositionNotch('auto', 0))
      .catch((e) => console.error('Failed to reset island position:', e))
  }

  return (
    <>
      <div className="island-effect-picker">
        <div className="island-effect-picker__head">
          <h3>{t('settings.island.effects.title', { defaultValue: '灵动岛外观效果' })}</h3>
          <p>{t('settings.island.effects.desc', { defaultValue: '选择一种外观效果，立即保存并应用到桌面灵动岛。空闲时只保留图标；运行时只显示正在工作的 Agent，不显示任务名，也不显示额度、数量或齿轮。' })}</p>
        </div>

        <div className="island-effect-cards" role="radiogroup" aria-label={t('settings.island.effects.groupLabel', { defaultValue: '灵动岛外观效果' })}>
          <button
            type="button"
            role="radio"
            aria-checked={activeEffect === 'midnight'}
            className={`island-effect-card${activeEffect === 'midnight' ? ' is--active' : ''}`}
            onClick={() => setColorTheme('midnight')}
          >
            <span className="island-effect-card__thumb island-effect-card__thumb--midnight" aria-hidden="true" />
            <span className="island-effect-card__text">
              <strong>{t('settings.island.effects.midnight', { defaultValue: '纯黑' })}</strong>
              <span>{t('settings.island.effects.midnightDesc', { defaultValue: '不透明黑色底，贴近屏幕边缘的默认效果。' })}</span>
            </span>
            <span className="island-effect-card__check" aria-hidden="true">✓</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={activeEffect === 'frosted-glass'}
            className={`island-effect-card${activeEffect === 'frosted-glass' ? ' is--active' : ''}`}
            onClick={() => setColorTheme('frosted-glass')}
          >
            <span className="island-effect-card__thumb island-effect-card__thumb--frosted-glass" aria-hidden="true" />
            <span className="island-effect-card__text">
              <strong>{t('settings.island.effects.frostedGlass', { defaultValue: '磨砂玻璃' })}</strong>
              <span>{t('settings.island.effects.frostedGlassDesc', { defaultValue: '半透明浅色玻璃，透出虚化的桌面背景。' })}</span>
            </span>
            <span className="island-effect-card__check" aria-hidden="true">✓</span>
          </button>
        </div>

        {!activeEffect && (
          <p className="island-effect-current" role="status">
            {t('settings.island.effects.currentOther', {
              name: currentThemeLabel,
              defaultValue: '当前使用其他配色主题「{{name}}」，不属于纯黑或磨砂玻璃；选择下方效果会立即切换。',
            })}
          </p>
        )}
      </div>

      <div className="overview-section-heading">
        <h3>{t('settings.island.overview.coreSwitches', { defaultValue: 'Core Switches' })}</h3>
        <p>{t('settings.island.overview.coreSwitchesDesc', { defaultValue: 'Primary controls for visibility, focus behavior, and suppression.' })}</p>
      </div>

      <div className="overview-mode-grid">
        <button
          aria-pressed={activeInteractionPreset === 'quiet'}
          className={`overview-mode-card ${activeInteractionPreset === 'quiet' ? 'overview-mode-card--active' : ''}`}
          type="button"
          onClick={() => applyInteractionPreset(QUIET_ASSISTANT_PRESET)}
        >
          <span className="overview-mode-card__island" />
          <strong>{t('settings.island.overview.quietAssistant', { defaultValue: 'Quiet Assistant' })}</strong>
          <span className="overview-mode-card__description">{t('settings.island.overview.quietAssistantDesc', { defaultValue: 'Hidden while agents run; appears for approvals, questions, failures, and completion notifications.' })}</span>
        </button>
        <button
          aria-pressed={activeInteractionPreset === 'persistent'}
          className={`overview-mode-card ${activeInteractionPreset === 'persistent' ? 'overview-mode-card--active' : ''}`}
          type="button"
          onClick={() => applyInteractionPreset(PERSISTENT_MONITOR_PRESET)}
        >
          <span className="overview-mode-card__island" />
          <strong>{t('settings.island.overview.persistentMonitor', { defaultValue: 'Persistent Monitor' })}</strong>
          <span className="overview-mode-card__description">{t('settings.island.overview.persistentMonitorDesc', { defaultValue: 'Keeps the island visible while agents run, then returns to a mini island when idle.' })}</span>
        </button>
        {activeInteractionPreset === 'custom' && (
          <div className="overview-mode-custom" role="status">
            <strong>{t('settings.island.overview.customPreset', { defaultValue: 'Custom visibility' })}</strong>
            <span>{t('settings.island.overview.customPresetDesc', { defaultValue: 'One or more visibility timing settings differ from the presets below.' })}</span>
          </div>
        )}
      </div>

      <SettingGroup>
        <SettingRow label={t('settings.islandResetDefaults')} description={t('settings.islandResetDefaultsDesc')}>
          <GlassButton variant="secondary" onClick={resetIslandDefaults}>
            {t('settings.reset')}
          </GlassButton>
        </SettingRow>
      </SettingGroup>

      <SettingGroup>
        <SettingRow label={t('settings.islandEnabled', { defaultValue: 'Enable Island' })} description={t('settings.islandEnabledDesc', { defaultValue: 'Show Vibe Board status, approvals, questions, and completions in the floating island.' })}>
          <Toggle checked={config.islandEnabled} onChange={(v) => {
            config.updateConfig('islandEnabled', v)
            if (v) {
              applyInteractionPreset(PERSISTENT_MONITOR_PRESET)
            }
          }} />
        </SettingRow>
        <SettingRow label={t('settings.islandMonitorSubagents', { defaultValue: 'Monitor subagents' })} description={t('settings.islandMonitorSubagentsDesc', { defaultValue: 'Surface subagent activity and completion history in the island.' })}>
          <Toggle checked={config.islandMonitorSubagents} onChange={(v) => config.updateConfig('islandMonitorSubagents', v)} />
        </SettingRow>
        <SettingRow label={t('settings.tipsEnabled')} description={t('settings.tipsEnabledDesc')}>
          <Toggle checked={config.tipsEnabled} onChange={(v) => {
            config.updateConfig('tipsEnabled', v)
            persistIslandFeatureFlags({ tipsEnabled: v })
          }} />
        </SettingRow>
        <SettingRow label={t('settings.smartSuppression')} description={t('settings.smartSuppressionDesc')}>
          <Toggle checked={config.smartSuppression} onChange={(v) => config.updateConfig('smartSuppression', v)} />
        </SettingRow>
        <SettingRow label={t('settings.autoHideNoSessions')} description={t('settings.autoHideNoSessionsDesc')}>
          <Toggle checked={config.autoHideNoSessions} onChange={(v) => config.updateConfig('autoHideNoSessions', v)} />
        </SettingRow>
      </SettingGroup>
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
      <SettingGroup label={t('settings.island.section.expand', { defaultValue: 'Expand' })}>
        <SettingRow label={t('settings.islandAnimationScale', { defaultValue: 'Animation Scale' })} description={t('settings.islandAnimationScaleDesc', { defaultValue: 'Adjust the speed of island open, close, and content motion.' })}>
          <Slider value={config.islandAnimationScale} min={0.25} max={6} step={0.25}
            onCommit={(v) => config.updateConfig('islandAnimationScale', v)} unit="x" />
        </SettingRow>
      </SettingGroup>

      <SettingGroup label={t('settings.island.section.hide', { defaultValue: 'Hide and Collapse' })}>
        <SettingRow label={t('settings.autoHideNoSessions')} description={t('settings.autoHideNoSessionsDesc')}>
          <Toggle checked={config.autoHideNoSessions} onChange={(v) => config.updateConfig('autoHideNoSessions', v)} />
        </SettingRow>
        <SettingRow label={t('settings.idleCompactDwell')} description={t('settings.idleCompactDwellDesc')}>
          <Slider value={config.idleCompactDwellSeconds} min={0} max={60} step={1}
            onCommit={(v) => config.updateConfig('idleCompactDwellSeconds', v)} unit="s" />
        </SettingRow>
        <SettingRow label={t('settings.noSessionsHideDelay')} description={t('settings.noSessionsHideDelayDesc')}>
          <Slider value={config.noSessionsHideDelay} min={1} max={30} step={1}
            onCommit={(v) => config.updateConfig('noSessionsHideDelay', v)} unit="min" />
        </SettingRow>
        <SettingRow label={t('settings.escSilenceDuration')} description={t('settings.escSilenceDurationDesc')}>
          <Slider value={config.escSilenceDuration} min={10} max={300} step={10}
            onCommit={(v) => config.updateConfig('escSilenceDuration', v)} unit="s" />
        </SettingRow>
      </SettingGroup>

      <SettingGroup label={t('settings.island.section.sessionHandling', { defaultValue: 'Session Handling' })}>
        <SettingRow label={t('settings.carouselInterval')} description={t('settings.carouselIntervalDesc')}>
          <Slider value={config.carouselIntervalMs} min={1000} max={10000} step={500}
            onCommit={(v) => config.updateConfig('carouselIntervalMs', v)} unit="ms" />
        </SettingRow>
        <SettingRow label={t('settings.idleTimeout')} description={t('settings.idleTimeoutDesc')}>
          <Dropdown value={String(config.idleTimeoutMinutes)} options={idleTimeoutOptions}
            onChange={(v) => config.updateConfig('idleTimeoutMinutes', Number(v))} minWidth={130} />
        </SettingRow>
        <SettingRow label={t('settings.idleInteractionRouting')} description={t('settings.idleInteractionRoutingDesc')}>
          <Toggle checked={config.idleInteractionRoutingEnabled} onChange={(v) => {
            config.updateConfig('idleInteractionRoutingEnabled', v)
            persistIdleInteractionRouting({ enabled: v })
          }} />
        </SettingRow>
        {config.idleInteractionRoutingEnabled && (
          <SettingRow label={t('settings.idleInteractionRoutingMinutes')} description={t('settings.idleInteractionRoutingMinutesDesc')}>
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
          </SettingRow>
        )}
        <SettingRow label={t('settings.sessionTimeout')} description={t('settings.sessionTimeoutDesc')}>
          <Slider value={config.sessionTimeoutMinutes} min={1} max={120} step={1}
            onCommit={(v) => config.updateConfig('sessionTimeoutMinutes', v)} unit="min" />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

// ── Display Tab ──
function DisplayTab() {
  const { t } = useTranslation()
  const config = useConfigStore()
  // 灵动岛配色只在总览页的两种效果中切换，Display 页不再重复提供配色入口。
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
  const hoverSpeedOptions = [
    { value: 'instant', label: t('settings.hoverSpeedInstant') },
    { value: 'normal', label: t('settings.hoverSpeedNormal') },
    { value: 'slow', label: t('settings.hoverSpeedSlow') },
  ]
  const sessionRefreshIntervalOptions = [1, 2, 3, 5, 10, 30].map((seconds) => ({
    value: String(seconds),
    label: `${seconds}s`,
  }))
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
      <SettingGroup label={t('settings.island.section.displayPlacement', { defaultValue: '显示器位置' })}>
          <SettingRow label={t('settings.displayMonitor')} description={t('settings.displayMonitorDesc')}>
            <Dropdown value={displayMonitorValue} options={monitorOptions}
              onChange={(v) => {
                config.updateConfig('displayMonitor', v)
                setDisplayId(v)
                  .then(() => repositionNotch(v))
                  .catch((e) => console.error('Failed to set display:', e))
              }} minWidth={180} />
          </SettingRow>
          <SettingRow label={t('settings.hostVisibilityMode', { defaultValue: 'Codex 最小化行为' })} description={t('settings.hostVisibilityModeDesc', { defaultValue: '选择 Codex 桌面窗口最小化时是否同步隐藏刘海。' })}>
            <Dropdown value={config.hostVisibilityMode} options={hostVisibilityOptions}
              onChange={(v) => {
                const hostVisibilityMode = v === 'follow' ? 'follow' : 'independent'
                config.updateConfig('hostVisibilityMode', hostVisibilityMode)
                getConfig()
                  .then((backendConfig) => updateBackendConfig({ ...backendConfig, hostVisibilityMode }))
                  .catch((e) => console.error('Failed to persist host visibility mode:', e))
              }} minWidth={220} />
          </SettingRow>
          <SettingRow label={t('settings.allowHorizontalDrag', { defaultValue: '允许拖动位置' })} description={t('settings.allowHorizontalDragDesc', { defaultValue: '直接拖动刘海；释放后会自动贴到顶部、左侧或右侧最近的屏幕边缘。' })}>
            <Toggle checked={config.allowHorizontalDrag} onChange={(v) => config.updateConfig('allowHorizontalDrag', v)} />
          </SettingRow>
          <SettingRow label={t('settings.resetIslandPosition', { defaultValue: 'Reset Island Position' })} description={islandPositionLabel}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="settings-mini-button" type="button" onClick={() => {
                config.updateConfig('notchPositionMode', 'top')
                config.updateConfig('panelHorizontalOffset', 0)
                config.updateConfig('notchVerticalOffset', 0)
                getConfig()
                  .then((backendConfig) => updateBackendConfig({ ...backendConfig, notchPositionMode: 'top', panelHorizontalOffset: 0, notchVerticalOffset: 0 }))
                  .then(() => repositionNotch())
                  .catch((e) => console.error('Failed to reset island position:', e))
              }}>
                {t('settings.resetCenter', { defaultValue: 'Reset to Center' })}
              </button>
            </div>
          </SettingRow>
      </SettingGroup>

      <SettingGroup label={t('settings.panelSize')}>
        <SettingRow label={t('settings.notchHeightMode')} description={t('settings.notchHeightModeDesc')}>
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
        </SettingRow>
        {config.notchHeightMode === 'custom' && (
          <SettingRow label={t('settings.customNotchHeight')} description={`${config.customNotchHeight}px`}>
            <Slider value={config.customNotchHeight} min={CUSTOM_NOTCH_HEIGHT_MIN} max={CUSTOM_NOTCH_HEIGHT_MAX} step={1}
              onChange={(v) => previewLayout('compact', { notchHeightMode: 'custom', customNotchHeight: v })}
              onCommit={(v) => config.updateConfig('customNotchHeight', v)} unit="px" />
          </SettingRow>
        )}
        <SettingRow label={t('settings.microPillWidth', { defaultValue: 'Micro Pill Width' })} description={`${config.microPillWidth}px`}>
          <Slider value={config.microPillWidth} min={84} max={180} step={4}
            onChange={(v) => previewLayout('micro', { microPillWidth: v })}
            onCommit={(v) => config.updateConfig('microPillWidth', v)} unit="px" />
        </SettingRow>
        <SettingRow label={t('settings.compactPillWidth', { defaultValue: 'Compact Pill Width' })} description={`${compactPillWidthValue}px`}>
          <Slider value={compactPillWidthValue} min={260} max={520} step={10}
            onChange={(v) => previewLayout('compact', { compactPillWidth: v, collapsedWidthScale: 100 })}
            onCommit={(v) => {
              config.updateConfig('compactPillWidth', v)
              config.updateConfig('collapsedWidthScale', 100)
            }} unit="px" />
        </SettingRow>
        <SettingRow label={t('settings.panelMaxWidth', { defaultValue: 'Expanded Panel Width' })} description={`${config.panelMaxWidth}px`}>
          <Slider value={config.panelMaxWidth} min={480} max={760} step={10}
            onChange={(v) => previewLayout('expanded', { panelMaxWidth: v })}
            onCommit={(v) => config.updateConfig('panelMaxWidth', v)} unit="px" />
        </SettingRow>
        <SettingRow
          label={t('settings.sideIslandSize', { defaultValue: 'Side Island Size' })}
          description={t('settings.sideIslandSizeDesc', {
            defaultValue: 'Size of the vertical strip docked to the left or right edge: {{value}}px. The top style is unchanged.',
            value: `${sideIslandSizeDimensions.shellWidth} × ${sideIslandSizeDimensions.panelHeight}`,
          })}
        >
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
        </SettingRow>
        <SettingRow label={t('settings.hoverSpeed')} description={t('settings.hoverSpeedDesc')}>
          <Dropdown value={config.hoverSpeed} options={hoverSpeedOptions}
            onChange={(v) => config.updateConfig('hoverSpeed', v as 'instant' | 'normal' | 'slow')} minWidth={160} />
        </SettingRow>
        <SettingRow
          label={t('settings.refreshRate', { defaultValue: '刷新频率' })}
          description={t('settings.refreshRateDesc', { defaultValue: '没有实时事件时，后台轮询会按此间隔补读会话状态。事件通知仍会立即更新。' })}
        >
          <Dropdown
            value={String(config.sessionRefreshIntervalSeconds)}
            options={sessionRefreshIntervalOptions}
            onChange={(v) => {
              const seconds = Number(v)
              config.updateConfig('sessionRefreshIntervalSeconds', seconds)
              persistSessionRefreshInterval(seconds)
            }}
            minWidth={120}
          />
        </SettingRow>
        <SettingRow
          label={t('settings.windowCloseBehavior', { defaultValue: '关闭窗口时' })}
          description={t('settings.windowCloseBehaviorDesc', { defaultValue: '点击桌面窗口右上角的叉时，选择隐藏到系统托盘或退出 Vibe Board。' })}
        >
          <Dropdown
            value={config.windowCloseBehavior}
            options={[
              { value: 'tray', label: t('settings.windowCloseToTray', { defaultValue: '最小化到托盘' }) },
              { value: 'exit', label: t('settings.windowCloseExit', { defaultValue: '直接退出程序' }) },
            ]}
            onChange={(value) => {
              const behavior = value === 'exit' ? 'exit' : 'tray'
              config.updateConfig('windowCloseBehavior', behavior)
              persistWindowCloseBehavior(behavior)
            }}
            minWidth={160}
          />
        </SettingRow>
        <SettingRow label={t('settings.contentFontSize')}>
          <Dropdown value={config.contentFontSize} options={fontSizeOptions}
            onChange={(v) => { config.updateConfig('contentFontSize', v); previewLayout('expanded', { contentFontSize: v }) }} minWidth={160} />
        </SettingRow>
        <SettingRow label={t('settings.showToolStatus')} description={t('settings.showToolStatusDesc')}>
          <Toggle checked={config.showToolStatus} onChange={(v) => config.updateConfig('showToolStatus', v)} />
        </SettingRow>
        <SettingRow label={t('settings.completionCardHeight')} description={`${config.completionCardHeight}px`}>
          <Slider value={config.completionCardHeight} min={80} max={420} step={10}
            onChange={(v) => previewLayout('completion', { completionCardHeight: v })}
            onCommit={(v) => config.updateConfig('completionCardHeight', v)} unit="px" />
        </SettingRow>
        <SettingRow label={t('settings.maxPanelHeight')} description={`${config.maxPanelHeight}px`}>
          <Slider value={config.maxPanelHeight} min={300} max={800} step={20}
            onChange={(v) => previewLayout('expanded', { maxPanelHeight: v })}
            onCommit={(v) => config.updateConfig('maxPanelHeight', v)} unit="px" />
        </SettingRow>
      </SettingGroup>

    </>
  )
}

// ── Advanced Tab ──
function AdvancedTab() {
  const { t } = useTranslation()
  const config = useConfigStore()

  return (
    <>
      <SettingGroup label={t('settings.island.section.visualSignals', { defaultValue: 'Visual Signals' })}>
        <SettingRow label={t('settings.agentActivity')} description={t('settings.agentActivityDesc')}>
          <Toggle checked={config.showAgentActivityDetails} onChange={(v) => config.updateConfig('showAgentActivityDetails', v)} />
        </SettingRow>
        <SettingRow label={t('settings.pixelCursor')} description={t('settings.pixelCursorDesc')}>
          <Toggle checked={config.pixelCursorEnabled} onChange={(v) => {
            config.updateConfig('pixelCursorEnabled', v)
            persistIslandFeatureFlags({ pixelCursorEnabled: v })
          }} />
        </SettingRow>
      </SettingGroup>

    </>
  )
}
