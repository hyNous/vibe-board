export interface PixelPattern {
  activePixels: Array<{ row: number; col: number }>
  animation: 'wave' | 'pulse' | 'breath' | 'spin' | 'blink'
  fps?: number
}

export interface ThemeConfig {
  name: string
  version: string
  author: 'builtin' | 'user'
  provider?: 'vibeboard' | 'agent-island' | 'agentbro'
  displayName?: string
  description?: string
  _dir?: string
  pixelGrid: { cols: number; rows: number }
  priorityColors: Record<string, string>
  prioritySpeeds: Record<string, number>
  priorityPatterns: Record<string, PixelPattern>
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
