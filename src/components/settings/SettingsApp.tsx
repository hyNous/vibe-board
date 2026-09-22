import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ask } from '@tauri-apps/plugin-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { SettingsSidebar } from './SettingsSidebar'
import { UpdateDialog } from './UpdateDialog'
import { GeneralSection } from './sections/GeneralSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { ShortcutsSection } from './sections/ShortcutsSection'
import { UnifiedUsageSection } from './sections/UnifiedUsageSection'
import { AgentMonitorSection } from './sections/AgentMonitorSection'
import { DispatchSection } from './sections/DispatchSection'
import { TutorialSection } from './sections/TutorialSection'
import { AboutSection } from './sections/AboutSection'
import { SkillManagerSection } from '../skills-v2/SkillManagerSection'
import { SkillOverviewPage } from '../skills-v2/SkillOverviewPage'
import { SetupWizard } from './SetupWizard'
import { useUpdater } from '../../hooks/useUpdater'
import { useConfigStore } from '../../stores/configStore'
import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import { getConfig, isTauri } from '../../services/tauriApi'
import type { IslandSettingsView } from '../../types/capability'
import '../../styles/settings.css'

const sections: Record<string, () => ReactNode> = {
  'general': GeneralSection,
  'skill-manager-v2': SkillManagerSection,
}

interface SettingsAppProps {
  onClose: () => void
}

export function SettingsApp({ onClose }: SettingsAppProps) {
  const { t } = useTranslation()
  const updater = useUpdater()
  const autoInstallUpdate = useConfigStore((s) => s.autoInstallUpdate)
  const setupWizardCompleted = useConfigStore((s) => s.setupWizardCompleted)
  const [setupConfigLoaded, setSetupConfigLoaded] = useState(() => !isTauri())
  const [activeSection, setActiveSection] = useState('tasks')
  const [activeIslandView, setActiveIslandView] = useState<IslandSettingsView>('overview')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [updateMinimized, setUpdateMinimized] = useState(false)
  const SectionComponent = sections[activeSection] ?? GeneralSection
  const isSkillManager = activeSection === 'skill-manager-v2'
  const contentClassName = `settings-content settings-scroll${isSkillManager ? ' settings-content--skill-manager' : ''}`
  // Guard both the in-app close button and the native close event while an
  // update is downloading. The native handler applies tray/exit behavior.
  const downloadingRef = useRef(false)
  const closingRef = useRef(false)
  useEffect(() => {
    downloadingRef.current = updater.status === 'downloading'
  }, [updater.status])

  const confirmCloseWhileDownloading = async (): Promise<boolean> => {
    if (!downloadingRef.current) return true
    return ask(t('update.closeWhileDownloading'), {
      title: t('update.availableTitle'),
      kind: 'warning',
      okLabel: t('update.closeAnyway'),
      cancelLabel: t('update.keepDownloading'),
    })
  }

  const handleCloseRequest = async () => {
    if (await confirmCloseWhileDownloading()) {
      closingRef.current = true
      onClose()
    }
  }

  useEffect(() => {
    if (!isTauri()) return
    const unlistenPromise = (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return getCurrentWindow().onCloseRequested(async (event) => {
        if (closingRef.current) return
        if (!downloadingRef.current) return
        event.preventDefault()
        if (await confirmCloseWhileDownloading()) {
          closingRef.current = true
          onClose()
        }
      })
    })()
    return () => {
      unlistenPromise.then((unlisten) => unlisten())
    }
    // onClose is stable for the window's lifetime; t is read at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    getConfig()
      .then((config) => {
        if (cancelled) return
        useConfigStore.setState({
          setupWizardCompleted: config.setupWizardCompleted ?? false,
          autoLaunchAgents: Array.isArray(config.autoLaunchAgents) ? config.autoLaunchAgents : [],
        })
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSetupConfigLoaded(true)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('settings-window-opened', () => { closingRef.current = false }))
      .then((cleanup) => { unlisten = cleanup })
      .catch(() => {})
    return () => unlisten?.()
  }, [])

  if (isTauri() && setupConfigLoaded && !setupWizardCompleted) {
    return (
      <div className="settings-app">
        <SetupWizard onClose={handleCloseRequest} />
      </div>
    )
  }

  return (
    <div className="settings-app">
      <SettingsSidebar
        activeSection={activeSection}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        onSelect={setActiveSection}
      />
      <div className={contentClassName}>
        {activeSection !== 'skill-manager-v2' && (
          <div className="settings-window-brand" aria-hidden="true">
            <span className="settings-window-brand__mark">
              <img src="/vibe-board-app-icon.png" alt="" />
            </span>
            <span className="settings-window-brand__copy">
              <span className="settings-window-brand__name">Vibe Board</span>
              <span className="settings-window-brand__slogan">{t('notch.slogan')}</span>
            </span>
          </div>
        )}
        <button
          className="settings-close-btn"
          onClick={handleCloseRequest}
        >
          {t('settings.close')}
        </button>
        {!autoInstallUpdate && (updater.status === 'available' || updater.status === 'ready') && updater.version && (
          <button
            className="settings-update-pill"
            type="button"
            title={t('settings.installNow', { defaultValue: 'Install Now' }) + ` v${updater.version}`}
            onClick={() => updater.installUpdate()}
          >
            <span aria-hidden="true">↑</span>
            <span>{t('settings.installNow', { defaultValue: 'Install' })}</span>
            <em>v{updater.version}</em>
          </button>
        )}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeSection}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
          >
            {activeSection === 'tasks' ? (
              <AgentMonitorSection />
            ) : activeSection === 'usage' ? (
              <UnifiedUsageSection />
            ) : activeSection === 'skills' ? (
              <SkillOverviewPage
                onOpenAdvanced={() => {
                  useSkillStoreV2.getState().setTab('library')
                  setActiveSection('skill-manager-v2')
                }}
              />
            ) : activeSection === 'dispatch' ? (
              <DispatchSection />
            ) : activeSection === 'island' ? (
              <AppearanceSection activeView={activeIslandView} onViewChange={setActiveIslandView} />
            ) : activeSection === 'shortcuts' ? (
              <ShortcutsSection />
            ) : activeSection === 'tutorial' ? (
              <TutorialSection />
            ) : activeSection === 'about' ? (
              <AboutSection
                updateStatus={updater.status}
                updateVersion={updater.version}
                updateError={updater.error}
                updateRestartPending={updater.restartPending}
                updateRestartBlockedByActivity={updater.restartBlockedByActivity}
                updateBlockingSessionCount={updater.blockingSessionCount}
                onCheckForUpdate={updater.checkForUpdate}
              />
            ) : (
              <SectionComponent />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {(updater.status === 'available' || updater.status === 'downloading' || updater.status === 'ready') && updater.version && (
        <UpdateDialog
          version={updater.version}
          notes={updater.notes}
          date={updater.date}
          status={updater.status}
          manualDownloadUrl={updater.manualDownloadUrl}
          downloadProgress={updater.downloadProgress}
          restartPending={updater.restartPending}
          restartBlockedByActivity={updater.restartBlockedByActivity}
          blockingSessionCount={updater.blockingSessionCount}
          minimized={updateMinimized}
          onMinimize={() => setUpdateMinimized(true)}
          onExpand={() => setUpdateMinimized(false)}
          onInstall={updater.installUpdate}
          onDismiss={() => {
            setUpdateMinimized(false)
            updater.dismissUpdate()
          }}
        />
      )}
    </div>
  )
}
