/**
 * P0 GUARD 2 — the real-window live check.
 *
 * Loads the actual DSH GUI in a headless browser with a forged session cookie
 * and asserts the pet's browser half really mounts: the page-global root, the
 * stage box at the configured inset and size, the renderer's container, a
 * WebGL canvas inside it, no error node, and no uncaught exception. It captures
 * every request, every console line and a viewport screenshot from the first
 * byte, so "the host half is fine but nothing on screen" becomes a specific
 * fact instead of a debate.
 *
 * This is the check whose absence let two releases ship while the pet was
 * visibly wrong (handoff §7-P0): every offline criterion was green. Offline
 * checks answer "is the wiring right"; only this one answers "is it on screen".
 *
 * The cookie is minted from the persisted signing secret (see mint-cookie.mjs),
 * so no launch token is needed. A real window that is ALREADY OPEN is not
 * covered: this drives its own browser instance, and a running page only picks
 * up a new build through the shell's own reload.
 *
 * Usage:
 *   node tools/verify-live-window.mjs [--wait 18] [--pet panyinhu] [--out _probe/live]
 * Env: DSH_HOME, DSH_AUTHORITY, DSH_CHROME
 * Exit 0 = the pet mounted on screen.
 */
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePng } from './png-codec.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const DSH_HOME = process.env.DSH_HOME ?? 'D:\\.dsh'
const AUTHORITY = process.env.DSH_AUTHORITY ?? '127.0.0.1:19387'
const BASE = `http://${AUTHORITY}`
const WAIT_S = Number(flag('wait', 18))
/**
 * Pet id the stage is expected to bind, or '' to accept the host's selection.
 *
 * Empty by default on purpose: the pet is data, so it can be swapped for another
 * one at any time, and a guard that hardcodes an id reports a stale expectation as
 * a failure exactly when the swap worked.
 */
const PET = flag('pet', '')
const OUT = flag('out', '_probe/live')
const PORT = Number(flag('port', 9345))

const CHROME = [
  process.env.DSH_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => p !== undefined && existsSync(p))
if (CHROME === undefined) { console.error('no Chrome/Edge found (set DSH_CHROME)'); process.exit(1) }

const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const secret = Buffer.from(readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8').match(/secret:\s*([A-Za-z0-9_-]+)/)[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const now = Date.now()
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }), 'utf8'))
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(AUTHORITY).digest())
const cookieValue = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`

const profile = mkdtempSync(join(tmpdir(), 'petlive-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let page = null
for (let i = 0; i < 80 && page === null; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
  } catch { /* not up yet */ }
  if (page === null) await sleep(250)
}
if (page === null) { chrome.kill(); throw new Error('DevTools endpoint never came up') }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let id = 1
const pending = new Map()
const consoleLines = []
const exceptions = []
const petRequests = []
const pluginRequests = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300)}`)
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    exceptions.push(`${d.text} ${d.exception?.description ?? ''}`.replace(/\s+/g, ' ').slice(0, 300))
  } else if (m.method === 'Network.responseReceived') {
    const r = m.params.response
    if (/pet3d|\/pet\//i.test(r.url)) petRequests.push(`${r.status} ${r.headers['content-length'] ?? '?'}B ${r.url.slice(0, 120)}`)
    if (r.url.includes('/plugins/')) pluginRequests.push(`${r.status} ${r.headers['content-length'] ?? '?'}B ${r.url.replace(BASE, '').slice(0, 100)}`)
  }
  const p = pending.get(m.id)
  if (p === undefined) return
  pending.delete(m.id)
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = id++
  pending.set(n, { resolve, reject })
  ws.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '') }
  return r.result.value
}

const failures = []
const check = (ok, label, detail = '') => {
  if (!ok) failures.push(label)
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

await send('Runtime.enable')
await send('Network.enable')
await send('Page.enable')
await send('Network.setCookie', { url: `${BASE}/`, name: cookieName, value: cookieValue, path: '/', httpOnly: true })
console.log('cookie set; navigating...')
await send('Page.navigate', { url: `${BASE}/` })
await sleep(WAIT_S * 1000)

const dom = await evaluate(`(() => {
  const q = (s) => [...document.querySelectorAll(s)]
  const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) } }
  const err = q('[data-pet3d-model3d-error]')[0]
  const mount = q('[data-pet3d-model3d]')[0]
  const boot = window.__DSH_BOOT__
  return {
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    // Reported because a matched reduce is how the pet used to freeze into a
    // T-pose: this pet runs over remote sessions, where Windows reports reduce
    // because client-area animations are off. The guard must therefore pass
    // with it matched — headless Chrome reports reduce by default.
    reducedMotion: typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : null,
    bootEntryIds: boot === undefined ? null : boot.entries.length,
    bootHasPet: boot === undefined ? null : boot.entries.some((e) => e.id === 'dsh-pet-3d'),
    loaderMode: window.__ModuleLoader__ === undefined ? null : window.__ModuleLoader__.mode,
    roots: q('div[data-pet3d-root]').length,
    rootPluginAttr: q('div[data-pet3d-root]').map((el) => el.dataset.dshPlugin ?? null),
    stages: q('[data-pet3d-stage]').map((el) => ({ pet: el.getAttribute('data-pet3d-stage'), box: rect(el), children: el.children.length })),
    mounts: q('[data-pet3d-model3d]').map((el) => ({ renderer: el.getAttribute('data-pet3d-model3d'), box: rect(el) })),
    errorNode: err === undefined ? null : { text: err.textContent.slice(0, 200), box: rect(err) },
    mountHtml: mount === undefined ? null : mount.innerHTML.slice(0, 400),
    canvases: q('canvas').map((c) => ({ box: rect(c), parent: c.parentElement?.getAttribute('data-pet3d-model3d') ?? c.parentElement?.className ?? null })),
  }
})()`)
console.log('\n--- DOM ---')
console.log(JSON.stringify(dom, null, 2))
console.log(`  prefers-reduced-motion: reduce = ${dom.reducedMotion}`)

const state = await evaluate(`fetch('/api/pet3d/state', { headers: { accept: 'application/json' } }).then((r) => r.json()).then((d) => ({ ok: true, visible: d.display?.visible, size: d.display?.size, right: d.display?.right, bottom: d.display?.bottom, pet: (d.model ?? d.pet)?.id ?? null, modelUrl: (d.model ?? d.pet)?.model3d?.modelUrl ?? null, phase: d.phase })).catch((e) => ({ ok: false, error: String(e) }))`)
console.log('\n--- host state as the page sees it ---')
console.log(JSON.stringify(state, null, 2))

// --- is the renderer being torn down and rebuilt while it runs? ------------
// The host snapshot is re-parsed on every poll, so a mount effect keyed on the
// definition OBJECT would rebuild the renderer every second: the model drops to
// its bind pose on each rebuild, which reads on screen as a flickering T-pose.
// The React wrapper div survives a rebuild, so the CANVAS is the honest
// witness — a rebuilt activation creates a fresh canvas element.
await evaluate(`(() => {
  window.__canvasIds = []
  const tick = () => {
    const el = document.querySelector('[data-pet3d-model3d] canvas')
    window.__canvasIds.push(el === null ? 'none' : (el.__probeToken ??= Math.random().toString(36).slice(2)))
  }
  tick()
  window.__canvasTimer = setInterval(tick, 200)
  return true
})()`)
await sleep(3000)
const canvasIds = await evaluate(`(() => { clearInterval(window.__canvasTimer); return window.__canvasIds })()`)
const distinctCanvases = new Set(canvasIds).size
console.log(`\n--- mount stability ---\n  3 秒内采样 ${canvasIds.length} 次，不同 canvas 身份 ${distinctCanvases} 个`)
check(distinctCanvases === 1, '渲染器没有被反复重建（canvas 身份稳定）',
  `不同身份 ${distinctCanvases} 个；序列 ${canvasIds.slice(0, 10).join(',')}`)

let shot = null
try {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  shot = `${OUT}-viewport.png`
  writeFileSync(shot, Buffer.from(r.data, 'base64'))
  console.log(`\nscreenshot ${shot}`)
} catch (error) { console.log('screenshot failed: ' + String(error).slice(0, 120)) }

// --- is anything actually DRAWN there? ------------------------------------
// A mounted canvas proves the wiring; it proves nothing about pixels. Capturing
// the stage region twice — with the pet visible, then hidden — and diffing the
// two frames isolates the pet's own pixels from whatever wallpaper is behind
// it. This is the check that separates "the DOM says mounted" from "it is on
// screen", which is exactly the gap two releases fell through.
/** Share of pixels that differ beyond a small per-channel threshold, %. */
const diffPct = (pngA, pngB) => {
  const a = decodePng(pngA)
  const b = decodePng(pngB)
  const pixels = Math.min(a.width * a.height, b.width * b.height)
  if (pixels === 0) return 0
  let differing = 0
  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    const delta = Math.abs(a.rgba[o] - b.rgba[o])
      + Math.abs(a.rgba[o + 1] - b.rgba[o + 1])
      + Math.abs(a.rgba[o + 2] - b.rgba[o + 2])
    if (delta > 24) differing += 1
  }
  return (differing / pixels) * 100
}

let drawnPct = null
let petMotionPct = null
let motionShown = null
let motionHidden = null
let rafPerSecond = null
let drawnShot = null
let controlLive = false
let motionAttempts = 0
let footprintPct = null
if (dom.stages[0] !== undefined) {
  const box = dom.stages[0].box
  const clip = { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 }
  const shoot = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64')

  const withPet = await shoot()
  await evaluate(`document.querySelector('div[data-pet3d-root]').style.visibility = 'hidden'`)
  const withoutPet = await shoot()
  await evaluate(`document.querySelector('div[data-pet3d-root]').style.visibility = ''`)
  drawnPct = diffPct(withPet, withoutPet)
  drawnShot = `${OUT}-stage.png`
  writeFileSync(drawnShot, withPet)
  console.log(`\n--- drawn pixels ---\n  与"隐藏宠物"不同 = ${drawnPct.toFixed(1)}%（区域截图 ${drawnShot}）`)

  // "Is it moving?" must be measured over the pet's OWN pixels. Subtracting a
  // whole-region diff taken with the pet hidden is invalid: hiding the pet
  // replaces its pixels with wallpaper, so the two diffs are over different
  // content, and a live wallpaper then reports a NEGATIVE motion for a moving
  // pet (handoff §5.13 — the app's own background animates). Instead: take the
  // pet's footprint from a shown/hidden pair, then ask how many of THOSE pixels
  // changed across the interval. The non-footprint pixels give the wallpaper's
  // own rate in the very same frame pair, as context.
  await evaluate(`window.__rafProbe = 0; (function loop(){ window.__rafProbe++; requestAnimationFrame(loop) })(); true`)
  await sleep(1000)
  rafPerSecond = await evaluate('window.__rafProbe')

  const hide = () => evaluate(`document.querySelector('div[data-pet3d-root]').style.visibility = 'hidden'`)
  const show = () => evaluate(`document.querySelector('div[data-pet3d-root]').style.visibility = ''`)
  /** One shown/hidden capture pair at a single instant. */
  const sampleFrames = async () => {
    const visible = await shoot()
    await hide()
    const bare = await shoot()
    await show()
    return { visible, bare }
  }

  // The control is also the liveness probe: when the app's own wallpaper shows
  // ZERO change too, the capture pipeline produced no new frame (handoff §5.12 —
  // an occluded or throttled page keeps rendering the same image), and the run
  // cannot judge motion at all. Retry a couple of times, then decline to answer
  // rather than report a false "frozen".
  let attempt = 0
  while (attempt < 3 && !controlLive) {
    attempt += 1
    const first = await sampleFrames()
    await sleep(1200)
    const second = await sampleFrames()
    const frameA = decodePng(first.visible)
    const frameB = decodePng(second.visible)
    const bareA = decodePng(first.bare)
    const bareB = decodePng(second.bare)
    const count = Math.min(frameA.width * frameA.height, frameB.width * frameB.height, bareA.width * bareA.height)
    const differs = (x, y, o) => Math.abs(x.rgba[o] - y.rgba[o]) + Math.abs(x.rgba[o + 1] - y.rgba[o + 1]) + Math.abs(x.rgba[o + 2] - y.rgba[o + 2]) > 24
    let footprint = 0
    let petMoved = 0
    let barePixels = 0
    let bareMoved = 0
    for (let i = 0; i < count; i++) {
      const o = i * 4
      // A pixel counts as pet only when it differs from the bare frame at BOTH
      // ends, so a moving pet cannot inflate its own footprint.
      if (differs(frameA, bareA, o) && differs(frameB, bareB, o)) {
        footprint += 1
        if (differs(frameA, frameB, o)) petMoved += 1
      } else {
        barePixels += 1
        if (differs(frameA, frameB, o)) bareMoved += 1
      }
    }
    motionShown = footprint === 0 ? 0 : (petMoved / footprint) * 100
    motionHidden = barePixels === 0 ? 0 : (bareMoved / barePixels) * 100
    petMotionPct = motionShown
    footprintPct = (footprint / count) * 100
    controlLive = motionHidden > 0.2
    if (!controlLive && attempt < 3) {
      console.log(`  （第 ${attempt} 次采样：非宠物像素变化 ${motionHidden.toFixed(2)}% -> 截图管线未出帧，重试）`)
      await sleep(700)
    }
  }
  motionAttempts = attempt
  console.log(`\n--- motion ---\n  rAF ${rafPerSecond}/s；第 ${attempt} 次采样生效：宠物覆盖 ${footprintPct.toFixed(1)}%`
    + `，其中 ${motionShown.toFixed(2)}% 在 1.2s 内变化；非宠物像素同口径 ${motionHidden.toFixed(2)}%`
    + `${controlLive ? '' : '（对照也没变化 -> 本轮无法判断）'}`)
}

console.log(`\n--- pet/plugin network (${petRequests.length} pet, ${pluginRequests.length} plugin) ---`)
for (const line of [...new Set(pluginRequests)].slice(0, 12)) console.log('  ' + line)
for (const line of [...new Set(petRequests)].slice(0, 20)) console.log('  ' + line)
console.log(`\n--- console (${consoleLines.length}) ---`)
for (const line of consoleLines.slice(0, 40)) console.log('  ' + line)
console.log(`\n--- exceptions (${exceptions.length}) ---`)
for (const line of exceptions.slice(0, 20)) console.log('  ' + line)

// --- assertions: is it actually on screen? --------------------------------
console.log('\n--- verdict ---')
check(dom.bootHasPet === true, '启动图里有 dsh-pet-3d')
check(dom.roots === 1, '页面全局挂载点恰好 1 个', `roots=${dom.roots}`)
check(dom.rootPluginAttr?.every(a => a === 'pet3d') === true, '挂载点标记为 pet3d', JSON.stringify(dom.rootPluginAttr))
check(dom.stages.length === 1, '宠物舞台恰好 1 个', `stages=${dom.stages.length}`)
// The selected pet is whatever the HOST says it is — asserting a hardcoded id
// only tells you the guard is stale when the pet is legitimately swapped, which
// is exactly what a replaced model looks like.
const expectedPet = PET === '' ? state.pet : PET
check(dom.stages[0]?.pet === expectedPet, `舞台绑定宿主选中的宠物（${expectedPet}）`, String(dom.stages[0]?.pet))
check((dom.stages[0]?.box.w ?? 0) > 100, '舞台有实际面积', JSON.stringify(dom.stages[0]?.box))
check(dom.mounts.length === 1, 'model3d 容器恰好 1 个', `mounts=${dom.mounts.length}`)
check(dom.canvases.length >= 1, '容器里存在 WebGL canvas', `canvases=${dom.canvases.length}`)
check(dom.errorNode === null, '没有渲染器错误节点', JSON.stringify(dom.errorNode))
check(exceptions.length === 0, '没有未捕获异常', exceptions.slice(0, 2).join(' | '))
check(state.ok === true && state.pet !== null, '页面能读到宿主快照', JSON.stringify(state))
check(petRequests.some(r => r.startsWith('200') && r.includes('.glb')), '模型 glb 返回 200', petRequests.find(r => r.includes('.glb')) ?? '(none)')
check(drawnPct !== null && drawnPct > 1, '宠物区域确实画出了东西（隐藏前后逐像素差 >1%）',
  drawnPct === null ? '未取到区域截图' : `${drawnPct.toFixed(1)}%`)
// A frozen pet is the exact failure two releases shipped, so this is asserted
// rather than reported — but only when the browser is actually producing
// frames. A suspended rAF makes the measurement meaningless, not failing.
// The threshold is a "not frozen" floor, not a quality bar: a genuinely frozen
// pet re-renders identical pixels, so anything above noise clears it. The
// measured value is the interesting number — it is the same quantity the action
// work has to raise (an early run measured 0.7% against 22% for the wallpaper
// behind it, which is the quantified form of "it looks frozen").
if (rafPerSecond === null || rafPerSecond < 10) {
  console.log(`  SKIP 宠物是否在动 —— 无头环境 rAF 只有 ${rafPerSecond}/s，测不到运动（不代表没在播）`)
} else if (!controlLive) {
  console.log(`  SKIP 宠物是否在动 —— ${motionAttempts} 次采样里非宠物像素都没有变化，截图管线未出帧，本轮无法判断`)
} else {
  check(petMotionPct > 0.2, '宠物自己的像素在动（1.2s 内 >0.2%）',
    `宠物覆盖区 ${petMotionPct.toFixed(2)}% 在变（占框 ${footprintPct.toFixed(1)}%），同口径非宠物像素 ${motionHidden.toFixed(2)}%，rAF ${rafPerSecond}/s`)
}
if (state.ok === true && state.size !== undefined && dom.stages[0] !== undefined) {
  check(dom.stages[0].box.w === state.size, '舞台尺寸与配置一致', `${dom.stages[0].box.w} vs ${state.size}`)
}
if (state.ok === true && state.right !== undefined && dom.stages[0] !== undefined) {
  // The stage is position:fixed, so its x is measured against the real viewport
  // — not the --window-size launch parameter, which is wider than the layout
  // viewport once chrome and the scrollbar are taken out.
  const expectedX = dom.viewport.w - state.right - state.size
  check(Math.abs(dom.stages[0].box.x - expectedX) <= 2, '舞台位置与配置一致',
    `x=${dom.stages[0].box.x} 期望≈${expectedX}（视口宽 ${dom.viewport.w}）`)
}

ws.close()
chrome.kill()
await sleep(500)
// Chrome may still hold its profile directory when the kill lands; a failed
// cleanup is cosmetic and must never mask the verdict above.
try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp dir */ }

console.log(failures.length === 0
  ? `\nverify-live-window: 宠物在真实浏览器里已挂载${shot === null ? '' : `（截图 ${shot}）`}`
  : `\nverify-live-window: ${failures.length} 项失败 -> ${failures.join('; ')}`)
process.exit(failures.length === 0 ? 0 : 1)
