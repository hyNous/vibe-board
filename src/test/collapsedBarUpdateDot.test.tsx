import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollapsedBar } from '../components/notch/CollapsedBar'
import { useUpdateStore } from '../stores/updateStore'

vi.mock('../services/tauriApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tauriApi')>()
  return {
    ...actual,
    openSettingsWindow: vi.fn(() => Promise.resolve()),
    setSoundEnabled: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; version?: string }) => {
      if (key === 'notch.updateAvailable') return `Update available v${options?.version}`
      const translations: Record<string, string> = { 'notch.settings': 'Settings' }
      return translations[key] ?? options?.defaultValue ?? key
    },
  }),
}))

describe('collapsed bar update dot', () => {
  afterEach(() => {
    useUpdateStore.setState({ availableVersion: null })
  })

  it('shows no update dot on the expanded gear when no version is available and omits gear in collapsed state', () => {
    useUpdateStore.setState({ availableVersion: null })
    const { container: expandedContainer } = render(
      <CollapsedBar sessions={[]} panelState="expanded" onCollapse={vi.fn()} />,
    )
    expect(expandedContainer.querySelector('.collapsed-bar__update-dot')).toBeNull()
    const expandedGear = expandedContainer.querySelector('.collapsed-bar__icon-btn')
    expect(expandedGear).toHaveAttribute('title', 'Settings')

    const { container: collapsedContainer } = render(
      <CollapsedBar sessions={[]} panelState="collapsed" onCollapse={vi.fn()} />,
    )
    expect(collapsedContainer.querySelector('.collapsed-bar__icon-btn')).toBeNull()
    expect(collapsedContainer.querySelector('.collapsed-bar__update-dot')).toBeNull()
  })

  it('shows the update dot and version tooltip on the expanded gear when a newer version is available', () => {
    useUpdateStore.setState({ availableVersion: '0.3.0' })
    const { container } = render(
      <CollapsedBar sessions={[]} panelState="expanded" onCollapse={vi.fn()} />,
    )
    expect(container.querySelector('.collapsed-bar__update-dot')).toBeInTheDocument()
    const gear = container.querySelector('.collapsed-bar__icon-btn')
    expect(gear).toHaveAttribute('title', 'Update available v0.3.0')
  })
})
