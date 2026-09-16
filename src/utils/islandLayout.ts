export const MATCH_MENU_BAR_HEIGHT = 38
export const MATCH_NOTCH_HEIGHT = 40
export const CUSTOM_NOTCH_HEIGHT_DEFAULT = MATCH_NOTCH_HEIGHT
export const CUSTOM_NOTCH_HEIGHT_MIN = 32
export const CUSTOM_NOTCH_HEIGHT_MAX = 72

export type NotchHeightMode = 'matchNotch' | 'matchMenuBar' | 'custom'

export function getCollapsedIslandHeight(mode: NotchHeightMode, customHeight: number): number {
  if (mode === 'custom') return customHeight
  if (mode === 'matchMenuBar') return MATCH_MENU_BAR_HEIGHT
  return MATCH_NOTCH_HEIGHT
}

export type SideIslandSize = 'narrow' | 'standard' | 'wide'

export const SIDE_ISLAND_SIZE_DEFAULT: SideIslandSize = 'narrow'
export const NOTCH_SHELL_SIDE_EXTENSION = 14

export interface SideIslandDimensions {
  contentWidth: number
  shellWidth: number
  panelHeight: number
}

const SIDE_ISLAND_SIZE_PRESETS: Record<SideIslandSize, { contentWidth: number; panelHeight: number }> = {
  narrow: { contentWidth: 36, panelHeight: 132 },
  standard: { contentWidth: 44, panelHeight: 148 },
  wide: { contentWidth: 52, panelHeight: 168 },
}

export function getSideIslandDimensions(size: SideIslandSize): SideIslandDimensions {
  const preset = SIDE_ISLAND_SIZE_PRESETS[size] ?? SIDE_ISLAND_SIZE_PRESETS[SIDE_ISLAND_SIZE_DEFAULT]
  return {
    contentWidth: preset.contentWidth,
    shellWidth: preset.contentWidth + NOTCH_SHELL_SIDE_EXTENSION * 2,
    panelHeight: preset.panelHeight,
  }
}

export type NotchPositionMode = 'top' | 'left' | 'right'

export interface IslandDragAnchor {
  visibleWidth: number
  visibleHeight: number
  offsetX: number
  offsetY: number
}

/**
 * Locate the visible island shell inside the (often larger) transparent native
 * host. The native drag clamp must follow this rect, not the host, so the
 * strip can actually reach the monitor edges.
 */
export function getIslandDragAnchor(input: {
  positionMode: NotchPositionMode
  hostWidth: number
  hostHeight: number
  shellWidth: number
  shellHeight: number
  hitboxHeight: number
  shellAnchorOffsetX: number
}): IslandDragAnchor {
  const sideDocked = input.positionMode === 'left' || input.positionMode === 'right'
  return {
    visibleWidth: input.shellWidth,
    visibleHeight: input.shellHeight,
    offsetX: sideDocked
      ? (input.positionMode === 'right' ? input.hostWidth - input.shellWidth : 0)
      : Math.max(0, (input.hostWidth - input.shellWidth) / 2) + input.shellAnchorOffsetX,
    offsetY: sideDocked ? Math.max(0, (input.hostHeight - input.hitboxHeight) / 2) : 0,
  }
}
