import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ask } from '@tauri-apps/plugin-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { SettingsIslandNav } from './SettingsIslandNav'
import { SettingsToast } from './SettingsToast'
import { UpdateDialog } from './UpdateDialog'
import { GeneralSection } from './sections/GeneralSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { ShortcutsSection } from './sections/ShortcutsSection'
import { UnifiedUsageSection } from './sections/UnifiedUsageSection'
import { AgentMonitorSection } from './sections/AgentMonitorSection'
import { DispatchSection } from './sections/DispatchSection'
import { TutorialSection } from './sections/TutorialSection'
import { AboutSection } from './sections/AboutSection'
import { SkillSection } from '../skills-v2/SkillSection'
import { SetupWizard } from './SetupWizard'
import { useUpdater } from '../../hooks/useUpdater'
import { useConfigStore } from '../../stores/configStore'
import { getConfig, isTauri } from '../../services/tauriApi'
import type { IslandSettingsView } from '../../types/capability'
import '../../styles/settings.css'
import '../../styles/settings-island.css'

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
  const [updateMinimized, setUpdateMinimized] = useState(false)
  const contentClassName = `settings-content settings-scroll${activeSection === 'skills' ? ' settings-content--skills' : ''}`
  // Guard the native close event while an update is downloading. The native
  // handler applies tray/exit behavior.
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
      <div className="settings-app settings-app--island">
        {/* Finishing, skipping or closing the wizard marks it completed; the
            settings page then renders in place instead of closing the window. */}
        <SetupWizard onClose={() => {}} />
      </div>
    )
  }

  return (
    <div className="settings-app settings-app--island">
      <header className="settings-topbar">
        <SettingsIslandNav activeSection={activeSection} onSelect={setActiveSection} />
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
      </header>
      <SettingsToast />
      <div className="settings-body">
      <div className={contentClassName}>
        <AnimatePresence mode="wait">
          <motion.div
            key={activeSection}
            // Skill 页自己分区滚动，需要这一层把窗口高度传下去。
            className={activeSection === 'skills' ? 'settings-page settings-page--fill' : 'settings-page'}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
          >
            {activeSection === 'tasks' ? (
              <AgentMonitorSection onOpenUsage={() => setActiveSection('usage')} />
            ) : activeSection === 'usage' ? (
              <UnifiedUsageSection />
            ) : activeSection === 'skills' ? (
              <SkillSection />
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
              <GeneralSection />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
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
