import { useEffect } from 'react'
import { useConfigStore } from '../stores/configStore'
import { useUpdateStore } from '../stores/updateStore'
import { useUpdater } from '../hooks/useUpdater'

// Mounted in the always-on notch window so a newer version is
// discovered even when Settings is closed. Each window runs its own check and
// writes its own `updateStore`, which the surrounding surface reads to show a
// dot. Gated on autoCheckUpdate; auto-download/restart stay gated separately
// inside useUpdater by autoInstallUpdate.
export function BackgroundUpdater() {
  const autoCheckUpdate = useConfigStore((s) => s.autoCheckUpdate)
  if (!autoCheckUpdate) return null
  return <BackgroundUpdaterLoop />
}

function BackgroundUpdaterLoop() {
  const { status, version } = useUpdater({ background: true })
  const setAvailableVersion = useUpdateStore((s) => s.setAvailableVersion)
  useEffect(() => {
    setAvailableVersion(status === 'available' || status === 'ready' ? version : null)
  }, [status, version, setAvailableVersion])
  return null
}
