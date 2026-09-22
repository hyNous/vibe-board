import { getConfig, updateConfig as updateBackendConfig } from '../services/tauriApi'
import { useConfigStore } from '../stores/configStore'

/** Reopen the first-run wizard by clearing its completion flag. */
export async function reopenSetupWizard(): Promise<void> {
  const backend = await getConfig()
  await updateBackendConfig({ ...backend, setupWizardCompleted: false })
  useConfigStore.getState().updateConfig('setupWizardCompleted', false)
}
