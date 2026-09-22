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
  detected: boolean
  programPath: string | null
  version: string | null
  credentialFilePresent: boolean | null
}

export interface DispatchConnection {
  workerId: string
  displayName: string
  skillId: string
}

export interface DispatchAgentNode {
  agentId: string
  displayName: string
  /** Claude Code and Codex are verified; every other dispatcher shows a hint. */
  verified: boolean
  skillsDir: string
  connections: DispatchConnection[]
  addableWorkers: string[]
}

export interface DispatchTree {
  node: DispatchNodeStatus
  agents: DispatchAgentNode[]
  workers: DispatchWorkerStatus[]
  skillsReady: boolean
}

export interface DispatchPlanFile {
  skillId: string
  relativePath: string
  sourcePath: string
  targetPath: string
  /** create = new file, unchanged = identical file exists, overwrite = a different file will be replaced */
  change: 'create' | 'unchanged' | 'overwrite'
}

export interface DispatchConnectPlan {
  agentId: string
  agentDisplayName: string
  workerId: string
  workerDisplayName: string
  files: DispatchPlanFile[]
  blockers: string[]
  canApply: boolean
}

export interface DispatchConnectResult {
  writtenFiles: DispatchPlanFile[]
}

export interface DispatchRemoval {
  skillId: string
  targetPath: string
  /** remove = bundled copy, remove_link = link only, keep_modified = user-edited copy stays */
  action: 'remove' | 'remove_link' | 'keep_modified'
}

export interface DispatchDisconnectPlan {
  agentId: string
  agentDisplayName: string
  workerId: string
  workerDisplayName: string
  removals: DispatchRemoval[]
  kept: DispatchRemoval[]
  canApply: boolean
}

export interface DispatchDisconnectResult {
  removed: DispatchRemoval[]
  kept: DispatchRemoval[]
}

const emptyTree: DispatchTree = {
  node: { available: false, programPath: null, version: null },
  agents: [],
  workers: [],
  skillsReady: false,
}

const unavailable = () => Promise.reject(new Error('Dispatch setup is unavailable in browser preview'))

export const dispatchApi = {
  tree: () => isTauriRuntime()
    ? invoke<DispatchTree>('dispatch_tree')
    : Promise.resolve(emptyTree),

  connectPlan: (agentId: string, workerId: string) => isTauriRuntime()
    ? invoke<DispatchConnectPlan>('dispatch_connect_plan', { agentId, workerId })
    : unavailable(),

  connectApply: (agentId: string, workerId: string, confirm: boolean) => isTauriRuntime()
    ? invoke<DispatchConnectResult>('dispatch_connect_apply', { agentId, workerId, confirm })
    : unavailable(),

  disconnectPlan: (agentId: string, workerId: string) => isTauriRuntime()
    ? invoke<DispatchDisconnectPlan>('dispatch_disconnect_plan', { agentId, workerId })
    : unavailable(),

  disconnectApply: (agentId: string, workerId: string, confirm: boolean) => isTauriRuntime()
    ? invoke<DispatchDisconnectResult>('dispatch_disconnect_apply', { agentId, workerId, confirm })
    : unavailable(),
}
