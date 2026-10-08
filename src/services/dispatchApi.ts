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

export interface DispatchReadDir {
  path: string
  /** The shared ~/.agents/skills root, read by several Agents. */
  shared: boolean
}

export interface DispatchConnection {
  workerId: string
  displayName: string
  skillId: string
  /** The read directory that contains the worker Skill. */
  dir: string
  /** Other Agents that see the same worker through a shared directory. */
  sharedWith: string[]
}

export interface DispatchAgentNode {
  agentId: string
  displayName: string
  /** Claude Code and Codex are verified; every other dispatcher shows a hint. */
  verified: boolean
  readDirs: DispatchReadDir[]
  connections: DispatchConnection[]
  addableWorkers: string[]
}

export interface DispatchTree {
  node: DispatchNodeStatus
  agents: DispatchAgentNode[]
  workers: DispatchWorkerStatus[]
  /** The hyNous/agent-dispatch Skills are installed under ~/.agents/skills. */
  toolInstalled: boolean
}

export interface DispatchInstallResult {
  toolInstalled: boolean
  /** ~/.agents/.skill-lock.json records the GitHub source. */
  sourceRecorded: boolean
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
  /**
   * remove = installed copy, remove_link = link only, keep_modified = user-edited copy stays,
   * keep_shared = the one copy in the shared Skill folder stays (other Agents use it)
   */
  action: 'remove' | 'remove_link' | 'keep_modified' | 'keep_shared'
  /** Other Agents that share this directory and are affected too. */
  sharedWith: string[]
}

export interface DispatchDisconnectPlan {
  agentId: string
  agentDisplayName: string
  workerId: string
  workerDisplayName: string
  removals: DispatchRemoval[]
  kept: DispatchRemoval[]
  /** Other Agents affected because a removal happens in a shared directory. */
  affectedAgents: string[]
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
  toolInstalled: false,
}

const unavailable = () => Promise.reject(new Error('Dispatch setup is unavailable in browser preview'))

export const dispatchApi = {
  tree: () => isTauriRuntime()
    ? invoke<DispatchTree>('dispatch_tree')
    : Promise.resolve(emptyTree),

  install: (confirm: boolean) => isTauriRuntime()
    ? invoke<DispatchInstallResult>('dispatch_install_tool', { confirm })
    : unavailable(),

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
