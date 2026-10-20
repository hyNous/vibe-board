// Records the README animations from the real UI running in a browser with
// fictional demo data (see demo-data.mjs). Nothing from this machine is shown.
//
// Usage (with `pnpm dev` running on :1423):
//   node scripts/readme-demo/record.mjs [island|usage|skills ...]
//
// Needs Chrome and playwright-core (set PLAYWRIGHT_CORE to its path if it is not
// resolvable from here) plus ffmpeg on PATH. Output: assets/readme/*.gif
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const outDir = join(root, 'assets/readme')
const workDir = join(root, 'tmp/readme-demo')
const baseUrl = process.env.DEMO_URL ?? 'http://localhost:1423/'
const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

// ── In-page helpers ──────────────────────────────────────────────

async function seed(page) {
  await page.evaluate(async () => {
    const module = await import('/scripts/readme-demo/seed.mjs')
    await module.seedDemo()
  })
}

/** Draws a visible pointer (screen recordings do not include the real one). */
async function installPointer(page) {
  await page.evaluate(() => {
    const pointer = document.createElement('div')
    pointer.id = 'demo-pointer'
    pointer.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.4-6.8L4 20z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>`
    Object.assign(pointer.style, {
      position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
      transform: 'translate(-100px,-100px)', transition: 'transform 0.7s cubic-bezier(.3,.7,.2,1)',
      filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.5))',
    })
    const ring = document.createElement('div')
    ring.id = 'demo-pointer-ring'
    Object.assign(ring.style, {
      position: 'fixed', left: '0', top: '0', width: '34px', height: '34px', margin: '-17px 0 0 -17px',
      borderRadius: '50%', border: '2px solid rgba(255,255,255,.85)', zIndex: '2147483646',
      pointerEvents: 'none', opacity: '0',
    })
    document.body.append(ring, pointer)
  })
}

async function pointTo(page, x, y, ms = 700) {
  await page.evaluate(([x, y, ms]) => {
    const pointer = document.getElementById('demo-pointer')
    pointer.style.transition = `transform ${ms}ms cubic-bezier(.3,.7,.2,1)`
    pointer.style.transform = `translate(${x - 4}px,${y - 2}px)`
  }, [x, y, ms])
  await page.mouse.move(x, y, { steps: 8 })
  await page.waitForTimeout(ms)
}

async function pointAt(page, locator, ms = 700) {
  const box = await locator.boundingBox()
  await pointTo(page, box.x + box.width / 2, box.y + box.height / 2, ms)
}

async function clickHere(page, locator) {
  const box = await locator.boundingBox()
  await page.evaluate(([x, y]) => {
    const ring = document.getElementById('demo-pointer-ring')
    ring.style.transition = 'none'
    ring.style.transform = `translate(${x}px,${y}px) scale(.4)`
    ring.style.opacity = '1'
    requestAnimationFrame(() => {
      ring.style.transition = 'transform .45s ease-out, opacity .45s ease-out'
      ring.style.transform = `translate(${x}px,${y}px) scale(1.3)`
      ring.style.opacity = '0'
    })
  }, [box.x + box.width / 2, box.y + box.height / 2])
  await locator.click()
}

const DONE = '拼音匹配已加好，北京可以用 bj、beijing 搜到。'

async function setSessions(page, mutate) {
  await page.evaluate(async ([mutate, DONE]) => {
    const data = await import('/scripts/readme-demo/demo-data.mjs')
    const { useSessionStore } = await import('/src/stores/sessionStore.ts')
    const now = Date.now()
    const list = new Function('now', 'list', 'MIN', 'DONE', mutate)(now, data.demoSessions(now), data.MIN, DONE)
    useSessionStore.getState().replaceAllSessions(list)
  }, [mutate, DONE])
}

async function setPanel(page, state) {
  await page.evaluate(async (state) => {
    const { useSessionStore } = await import('/src/stores/sessionStore.ts')
    useSessionStore.getState().setPanelState(state)
  }, state)
}

/** A plain desktop behind the island: wallpaper and a code editor window. */
async function installDesktop(page) {
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('background')
    document.body.style.removeProperty('background')
    const desk = document.createElement('div')
    desk.id = 'demo-desktop'
    const lines = [
      ['#7f8ea3', '// src/search/pinyin.ts'],
      ['#c792ea', 'export function', '#82aaff', ' matchCity', '#d6deeb', '(query: string, city: City) {'],
      ['#d6deeb', '  const key = ', '#82aaff', 'toPinyin', '#d6deeb', '(city.name)'],
      ['#c792ea', '  return', '#d6deeb', ' key.startsWith(query.toLowerCase())'],
      ['#d6deeb', '}'],
      ['#d6deeb', ''],
      ['#7f8ea3', '// 城市列表按拼音首字母分组'],
      ['#c792ea', 'export const', '#d6deeb', ' groups = ', '#82aaff', 'groupBy', '#d6deeb', '(cities, initialOf)'],
    ]
    const code = lines.map((parts) => {
      let html = ''
      for (let i = 0; i < parts.length; i += 2) html += `<span style="color:${parts[i]}">${parts[i + 1].replace(/</g, '&lt;')}</span>`
      return `<div>${html || '&nbsp;'}</div>`
    }).join('')
    desk.innerHTML = `
      <div class="demo-window">
        <div class="demo-window__bar"><i></i><i></i><i></i><span>weather-app — pinyin.ts</span></div>
        <div class="demo-window__body">${code}</div>
      </div>`
    const style = document.createElement('style')
    style.textContent = `
      #demo-desktop { position: fixed; inset: 0; z-index: -1; overflow: hidden;
        background: radial-gradient(120% 90% at 20% 110%, #1b2a6b 0%, transparent 55%),
                    radial-gradient(90% 80% at 95% 0%, #4a1f8f 0%, transparent 50%), #0b0d18; }
      .demo-window { position: absolute; left: 50%; top: 150px; width: 640px; transform: translateX(-50%);
        border-radius: 12px; background: #11141f; border: 1px solid rgba(255,255,255,.08);
        box-shadow: 0 30px 80px rgba(0,0,0,.55); font: 13px/1.75 Consolas, 'Cascadia Mono', monospace; }
      .demo-window__bar { display: flex; align-items: center; gap: 7px; padding: 10px 14px; color: #7f8ea3;
        border-bottom: 1px solid rgba(255,255,255,.06); font-family: 'Microsoft YaHei', sans-serif; font-size: 12px; }
      .demo-window__bar i { width: 11px; height: 11px; border-radius: 50%; background: #2a3042; }
      .demo-window__bar span { margin-left: 8px; }
      .demo-window__body { padding: 14px 20px 20px; white-space: pre; }`
    document.head.append(style)
    document.body.prepend(desk)
  })
}

// ── Scenes ───────────────────────────────────────────────────────

const scenes = {
  island: {
    viewport: { width: 860, height: 470 },
    url: baseUrl,
    async setup(page) {
      await installDesktop(page)
      await seed(page)
      await setSessions(page, `return list.filter((s) => s.id !== 'demo-opencode')`)
    },
    async play(page) {
      await page.waitForTimeout(1600)
      // A second Agent starts while the island is collapsed.
      await setSessions(page, `return list`)
      await page.waitForTimeout(1400)
      await pointTo(page, 430, 14, 800)
      await setPanel(page, 'hover')
      await page.waitForTimeout(2600)
      // OpenCode picks up a new task.
      await setSessions(page, `
        const oc = list.find((s) => s.id === 'demo-opencode')
        Object.assign(oc, { phase: 'processing', sessionTitle: '写 README 的安装说明', lastUserMessage: '写 README 的安装说明',
          responseText: undefined, taskCompletedAt: undefined, idleSince: undefined, lastUserMessageAt: now, lastActivityAt: now })
        return list`)
      await page.waitForTimeout(2200)
      // Claude finishes its task.
      await setSessions(page, `
        const oc = list.find((s) => s.id === 'demo-opencode')
        Object.assign(oc, { phase: 'processing', sessionTitle: '写 README 的安装说明', lastUserMessage: '写 README 的安装说明',
          responseText: undefined, taskCompletedAt: undefined, idleSince: undefined, lastUserMessageAt: now - 2200, lastActivityAt: now })
        const claude = list.find((s) => s.id === 'demo-claude')
        Object.assign(claude, { phase: 'done', taskCompletedAt: now, idleSince: now, activeTools: [],
          description: DONE, responseText: DONE })
        return list`)
      // The same completion reminder a real task-finished event raises.
      await page.evaluate(async (summary) => {
        const { useSessionStore } = await import('/src/stores/sessionStore.ts')
        useSessionStore.getState().pushOverlay({
          id: `completion-demo-claude-${Date.now()}`, sessionId: 'demo-claude', type: 'completion',
          data: { summary }, createdAt: Date.now(),
        })
      }, DONE)
      await page.waitForTimeout(2600)
      await pointTo(page, 700, 380, 700)
      await setPanel(page, 'collapsed')
      await page.waitForTimeout(1600)
    },
  },
  usage: {
    viewport: { width: 1000, height: 640 },
    url: `${baseUrl}#settings`,
    async setup(page) {
      await seed(page)
    },
    async play(page) {
      await page.waitForTimeout(1600)
      const tab = page.locator('[data-section="usage"]')
      await pointAt(page, tab)
      await clickHere(page, tab)
      await seed(page)
      await page.waitForTimeout(2600)
      await pointTo(page, 620, 420, 600)
      await page.mouse.wheel(0, 330)
      await page.waitForTimeout(2400)
      await page.mouse.wheel(0, -330)
      await page.waitForTimeout(1200)
      const back = page.locator('[data-section="tasks"]')
      await pointAt(page, back)
      await clickHere(page, back)
      await page.waitForTimeout(1600)
    },
  },
  skills: {
    viewport: { width: 1000, height: 640 },
    url: `${baseUrl}#settings`,
    async setup(page) {
      await seed(page)
      await page.locator('[data-section="skills"]').click()
      await page.waitForTimeout(800)
      await seed(page)
    },
    async play(page) {
      await page.waitForTimeout(1400)
      await pointTo(page, 520, 400, 600)
      await page.mouse.wheel(0, 420)
      await page.waitForTimeout(1600)
      for (const name of ['生效于 Codex', '生效于 Gemini CLI', '全部（中心库）']) {
        const chip = page.locator('button', { hasText: name }).first()
        await pointAt(page, chip)
        await clickHere(page, chip)
        await page.waitForTimeout(1500)
      }
      await page.mouse.wheel(0, -420)
      await page.waitForTimeout(1200)
    },
  },
}

// ── Recording ────────────────────────────────────────────────────

async function record(name) {
  const scene = scenes[name]
  const frameDir = join(workDir, name)
  rmSync(frameDir, { recursive: true, force: true })
  mkdirSync(frameDir, { recursive: true })

  const scale = 2
  // The screencast only delivers device-pixel frames when Chrome itself runs at
  // 2x; the context's deviceScaleFactor alone yields 1x frames.
  const browser = await chromium.launch({ executablePath: chrome, args: [`--force-device-scale-factor=${scale}`] })
  const context = await browser.newContext({ viewport: scene.viewport, deviceScaleFactor: scale, locale: 'zh-CN' })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.warn(`[${name}] page error:`, error.message))
  await page.goto(scene.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await scene.setup(page)
  await installPointer(page)
  await page.waitForTimeout(600)

  // Chrome's screencast delivers device-pixel frames only when the page changes;
  // each frame is held until the next one.
  const frames = []
  const cdp = await context.newCDPSession(page)
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, at: metadata.timestamp })
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', {
    format: 'png',
    maxWidth: scene.viewport.width * scale,
    maxHeight: scene.viewport.height * scale,
    everyNthFrame: 1,
  })
  await page.waitForTimeout(200)
  await scene.play(page)
  const end = Date.now() / 1000
  await cdp.send('Page.stopScreencast')
  await browser.close()

  const list = []
  frames.forEach((frame, index) => {
    const file = join(frameDir, `${String(index).padStart(5, '0')}.png`)
    writeFileSync(file, Buffer.from(frame.data, 'base64'))
    const next = frames[index + 1]?.at ?? end
    list.push(`file '${file.replaceAll('\\', '/')}'`, `duration ${Math.max(next - frame.at, 0.001).toFixed(3)}`)
  })
  list.push(list[list.length - 2])
  const listFile = join(frameDir, 'frames.txt')
  writeFileSync(listFile, list.join('\n'))

  const gif = join(outDir, `demo-${name}.gif`)
  const width = Math.min(scene.viewport.width, 960)
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-filter_complex', `fps=15,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0', gif,
  ])
  const seconds = (end - frames[0].at).toFixed(1)
  console.log(`${name}: ${gif} (${frames.length} frames, ${seconds}s)`)
}

mkdirSync(outDir, { recursive: true })
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes)
for (const name of names) await record(name)
