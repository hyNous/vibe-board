import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(scriptDir, '..')
const config = JSON.stringify({ bundle: { createUpdaterArtifacts: false } })

const result = spawnSync(
  'cargo',
  ['tauri', 'build', '--bundles', 'nsis,msi', '--ci', '--config', config],
  {
    cwd: rootDir,
    stdio: 'inherit',
  },
)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

// Copy the installers out of the deep Cargo target tree into ./installers so
// they are easy to find. The folder is git-ignored.
const bundleDir = join(rootDir, 'src-tauri', 'target', 'release', 'bundle')
const outDir = join(rootDir, 'installers')
mkdirSync(outDir, { recursive: true })
for (const [kind, extension] of [['nsis', '.exe'], ['msi', '.msi']]) {
  const dir = join(bundleDir, kind)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(extension)) continue
    copyFileSync(join(dir, name), join(outDir, name))
    console.log(`Installer copied to ${join(outDir, name)}`)
  }
}
