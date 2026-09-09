import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

const source = valueAfter('--source')
const host = valueAfter('--host')
if (!source || !host) process.exit(0)

const bridge = join(
  homedir(),
  '.agent-island',
  'bin',
  process.platform === 'win32' ? 'agent-island-bridge.exe' : 'agent-island-bridge',
)
if (!existsSync(bridge)) process.exit(0)

const child = spawn(bridge, ['--source', source, '--host', host], {
  stdio: ['pipe', 'ignore', 'ignore'],
  windowsHide: true,
})

process.stdin.pipe(child.stdin)
child.stdin.on('error', () => {})
child.on('error', () => process.exit(0))
child.on('close', () => process.exit(0))
