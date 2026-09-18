export interface PixelPattern {
  activePixels: Array<{ row: number; col: number }>
  animation: 'wave' | 'pulse' | 'breath' | 'spin' | 'blink'
  fps?: number
}

export interface SpriteAnimation {
  row: number
  frames: number
  fps: number
}

export interface ThemeConfig {
  name: string
  version: string
  author: 'builtin' | 'user'
  provider?: 'vibeboard' | 'agent-island' | 'agentbro' | 'codex'
  isCodexPet?: boolean
  displayName?: string
  description?: string
  _dir?: string
  pixelGrid: { cols: number; rows: number }
  priorityColors: Record<string, string>
  prioritySpeeds: Record<string, number>
  priorityPatterns: Record<string, PixelPattern>
  character?: {
    /**
     * Absolute filesystem path to the sprite atlas (or, for legacy callers,
     * a `data:` URL). The frontend wraps non-data values in `convertFileSrc`
     * to get an `asset://` URL — see SpriteCanvas::themeToPet.
     */
    spriteSheet: string
    /** Synonym of `spriteSheet`; kept for forward compat with future callers. */
    spriteSheetUrl?: string
    /** @deprecated Backend no longer emits this; data-URL embedding caused 80+ MB JS heap regressions. */
    spriteSheetDataUrl?: string
    frameSize: { width: number; height: number }
    scale: number
    animations: Record<string, SpriteAnimation>
  }
  stateMapping?: Record<string, string>
  sounds: {
    pack: 'synth' | '8bit' | 'system' | 'none'
    overrides?: Record<string, string>
  }
  statusLabels?: Record<string, string>
  alertColors?: { permission?: string; question?: string; plan?: string; feedback?: string }
  compactHeight?: number
  pixelCursor?: { enabled: boolean; color: string }
}
