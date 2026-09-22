import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { isTauri as isTauriRuntime } from './tauriApi'

async function invoke<T = void>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(command, args)
}

export interface DispatchNodeStatus {
  available: boolean
  programPath: string | null
  version: string | null
}

export interface DispatchWorkerStatus {
  id: string
  displayName: string
  command: string
  detected: boolean
  programPath: string | null
  version: string | null
  credentialFilePresent: boolean | null
}

export interface DispatchTargetStatus {
  agentId: string
  displayName: string
  programDetected: boolean
  skillsDir: string
  installedSkills: string[]
}

export interface DispatchSkillStatus {
  id: string
  present: boolean
  fileCount: number
}

export interface DispatchDetection {
  node: DispatchNodeStatus
  workers: DispatchWorkerStatus[]
  targets: DispatchTargetStatus[]
  skills: DispatchSkillStatus[]
  resourcesRoot: string | null
}

export interface DispatchPlanFile {
  skillId: string
  agentId: string
  relativePath: string
  sourcePath: string
  targetPath: string
  /** create = new file, unchanged = identical file exists, overwrite = a different file will be replaced */
  change: 'create' | 'unchanged' | 'overwrite'
}

export interface DispatchPlan {
  detection: DispatchDetection
  files: DispatchPlanFile[]
  blockers: string[]
  canApply: boolean
}

export interface DispatchApplyResult {
  writtenFiles: DispatchPlanFile[]
  targets: string[]
}

const emptyDetection: DispatchDetection = {
  node: { available: false, programPath: null, version: null },
  workers: [],
  targets: [],
  skills: [],
  resourcesRoot: null,
}

export const dispatchApi = {
  detect: () => isTauriRuntime()
    ? invoke<DispatchDetection>('dispatch_detect')
    : Promise.resolve(emptyDetection),

  plan: () => isTauriRuntime()
    ? invoke<DispatchPlan>('dispatch_plan')
    : Promise.resolve<DispatchPlan>({
      detection: emptyDetection,
      files: [],
      blockers: ['skills_missing'],
      canApply: false,
    }),

  apply: (confirm: boolean) => isTauriRuntime()
    ? invoke<DispatchApplyResult>('dispatch_apply', { confirm })
    : Promise.reject(new Error('Dispatch setup is unavailable in browser preview')),
}
