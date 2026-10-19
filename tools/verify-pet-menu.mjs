/**
 * 悬浮菜单（宠物正中间的 🐻）验收守卫 —— 在**真实页面**上点，不看代码推断。
 *
 * 为什么要有它：这块 UI 全是"看起来对但可能什么都没做"的地方 ——
 *  - 菜单开出来了，但点开关只改了按钮颜色（渲染器没收到）；
 *  - 点了开关渲染器收到了，但 `visible` 设错了节点（画面没变）；
 *  - 画面变了，但**绘制调用数没降**（说明藏的是别的节点，或者壳还亮着）。
 * 所以每一项都落到可观测的证据上：DOM、`data-pet3d-hidden`、渲染器仪表的
 * `parts=`（藏了谁）、`dc=`/`tri=`（GPU 真的没画它）、以及刷新后的持久化。
 *
 * 用法：
 *   node tools/verify-pet-menu.mjs [--wait 20] [--port 9351] [--out _probe/menu]
 * Env: DSH_HOME, DSH_AUTHORITY, DSH_CHROME
 * 退出码：0 = 全过；1 = 有失败。
 */
import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const DSH_HOME = process.env.DSH_HOME ?? 'D:\\.dsh'
const AUTHORITY = process.env.DSH_AUTHORITY ?? '127.0.0.1:19387'
const BASE = `http://${AUTHORITY}`
const WAIT_S = Number(flag('wait', 20))
const PORT = Number(flag('port', 9351))
const OUT = flag('out', '_probe/menu')

const CHROME = [
  process.env.DSH_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => p !== undefined && existsSync(p))
if (CHROME === undefined) { console.error('no Chrome/Edge found (set DSH_CHROME)'); process.exit(1) }

mkdirSync(OUT, { recursive: true })

// --- auth cookie（和 verify-inspect-panel 同一套：本机 secret 签 HMAC） -------
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const secret = Buffer.from(
  readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8')
    .match(/secret:\s*([A-Za-z0-9_-]+)/)[1].replaceAll('-', '+').replaceAll('_', '/'),
  'base64',
)
const now = Date.now()
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }), 'utf8'))
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(AUTHORITY).digest())
const cookieValue = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`

const profile = mkdtempSync(join(tmpdir(), 'petmenu-'))
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
const exceptions = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const details = m.params.exceptionDetails
    const text = details?.exception?.description ?? details?.text ?? 'unknown'
    exceptions.push(String(text).slice(0, 600))
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
  if (r.exceptionDetails) return null
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.setCookie', { url: `${BASE}/`, name: cookieName, value: cookieValue, path: '/', httpOnly: true })
// 开发者模式：仪表（`parts=` / `dc=`）只在它打开时才挂在页面上，而这块 UI 的证据全靠仪表。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { window.localStorage.setItem('dshPet3dDebug', '1') } catch (e) {}`,
})
await send('Page.navigate', { url: `${BASE}/` })
await sleep(WAIT_S * 1000)

const failures = []
/** 一件没脱时的绘制调用数（第 4 步量，第 6 步"全脱"拿它做基准）。 */
let baselineDrawCalls = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures.push(label)
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 渲染器仪表（只在开发者模式打开时存在）。 */
const instrument = async () => {
  const line = await evaluate(`(document.querySelector('[data-pet3d-debug]')?.textContent ?? null)`)
  const out = {}
  for (const part of (line ?? '').split(' ')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return out
}
const stageBox = () => evaluate(`(() => {
  const el = document.querySelector('[data-pet3d-stage]')
  if (el === null) return null
  const r = el.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top), id: el.getAttribute('data-pet3d-stage'), hidden: el.getAttribute('data-pet3d-hidden') }
})()`)
const hostState = () => evaluate(`fetch('/api/pet3d/state', { headers: { accept: 'application/json' } }).then(r => r.json()).then(d => ({ model: d.model?.id ?? null, models: (d.models ?? []).map(m => m.id), size: d.display?.size ?? null })).catch(() => null)`)
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
}
/** 把指针挪到某点（小熊只在指针进入方框时浮现，所以"挪过去"是必要的一步）。 */
const moveTo = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await sleep(180)
}
const clickSelector = async (selector) => {
  const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return false; el.click(); return true })()`)
  return ok === true
}
/** 截图（整页），写到 _probe 里给人看。 */
const shoot = async (name, clip) => {
  const params = { format: 'png' }
  if (clip !== undefined) params.clip = { ...clip, scale: 1 }
  const shot = await send('Page.captureScreenshot', params)
  const file = join(OUT, name)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  return file
}
const menuRect = () => evaluate(`(() => {
  const el = document.querySelector('[data-pet3d-menu]')
  if (el === null) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
})()`)
const pressEscape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await sleep(40)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
}

/** 模型目录里的配饰表（Node 侧读，作为"菜单应该显示什么"的独立基准）。 */
const readAppearance = (modelId) => {
  const file = join(DSH_HOME, 'models', modelId, 'appearance.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 模型目录里的互动表（Node 侧读，作为"有几个按钮/该播哪条"的独立基准）。 */
const readInteractions = (modelId) => {
  const file = join(DSH_HOME, 'models', modelId, 'interactions.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 仪表里的 `owner=`/`cur=` 用短名（去掉多数族共有的前缀），这里按同一条规则算。 */
const shortClipName = (name) => String(name).replace(/^Avatar_Male_Size\d+_[A-Za-z]+_Ani_/u, '')

const state0 = await hostState()
if (state0 === null) { chrome.kill(); throw new Error('宿主 /api/pet3d/state 不可用') }
const originModel = state0.model
const appearance = readAppearance(originModel)
console.log(`\n模型 ${originModel} · 配饰表 ${appearance === null ? '无' : `${(appearance.pieces ?? []).length} 件配饰 / ${(appearance.groups ?? []).length} 组款式`}`)

/** 这份配饰表的"默认状态"会藏哪些节点（和客户端 defaultHidden 同一条规则）。 */
const defaultHiddenOf = (table) => {
  if (table === null) return []
  const set = new Set(table.hide ?? [])
  for (const group of table.groups ?? []) {
    const chosen = group.options.find((option) => option.default) ?? group.options.find((option) => option.nodes.length > 0)
    for (const option of group.options) {
      if (option === chosen) continue
      for (const name of option.nodes) set.add(name)
    }
  }
  for (const piece of table.pieces ?? []) {
    if (piece.defaultHidden) for (const name of piece.nodes) set.add(name)
  }
  return [...set]
}
const expectedHidden = defaultHiddenOf(appearance)
const sameSet = (list, expected) => {
  const a = String(list ?? '').split(',').filter(Boolean).sort().join(',')
  return a === [...expected].sort().join(',')
}

/* ------------------------------------------------------------ 1. 小熊入口 */
console.log('\n--- 1. 小熊平时不出现，指针进入方框才浮现（且在正中心） ---')
const stage = await stageBox()
check(stage !== null, '宠物在画面上')
if (stage === null) {
  console.log('  页面标题:', await evaluate('document.title'))
  console.log('  页面文本:', String(await evaluate('document.body.innerText')).slice(0, 200).replace(/\n/gu, ' '))
  console.log('  未捕获异常:', exceptions.slice(0, 5).join(' | ') || '（无）')
  console.log('  /api/pet3d/state 状态码:', await evaluate(`fetch('/api/pet3d/state').then(r => r.status).catch(e => String(e))`))
  chrome.kill()
  process.exit(1)
}
// 指针先放到方框外（页面左上角），确认小熊是藏的。
await moveTo(5, 5)
const hiddenState = await evaluate(`document.querySelector('[data-pet3d-menu-toggle]')?.getAttribute('data-pet3d-menu-toggle-visible') ?? null`)
check(hiddenState === '0', '指针在方框外时小熊是藏的', String(hiddenState))
check(await evaluate(`document.querySelector('[data-pet3d-stage]')?.getAttribute('data-pet3d-hover') === '0'`), '舞台报告指针不在框内')
check(await evaluate(`getComputedStyle(document.querySelector('[data-pet3d-menu-toggle]')).pointerEvents === 'none'`),
  '藏起来时也不吃掉点击（pointer-events: none）')

const stageCenter = { x: stage.x + stage.w / 2, y: stage.y + stage.h / 2 }
await moveTo(stageCenter.x, stageCenter.y)
const bear = await evaluate(`(() => {
  const el = document.querySelector('[data-pet3d-menu-toggle]')
  if (el === null) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), text: el.textContent, visible: el.getAttribute('data-pet3d-menu-toggle-visible') }
})()`)
check(bear !== null, '有小熊按钮', bear === null ? '' : `「${bear.text}」`)
if (bear === null) { chrome.kill(); process.exit(1) }
check(bear.visible === '1', '指针进入方框后小熊浮现', String(bear.visible))
check(await evaluate(`getComputedStyle(document.querySelector('[data-pet3d-menu-toggle]')).opacity !== '0'`), '浮现后不透明可点')
check(bear.text.includes('🐻'), '按钮上就是小熊 emoji', bear.text)
const bearCenter = { x: bear.x + bear.w / 2, y: bear.y + bear.h / 2 }
check(Math.abs(bearCenter.x - stageCenter.x) <= 2 && Math.abs(bearCenter.y - stageCenter.y) <= 2,
  '小熊在宠物方框的正中心', `bear=(${bearCenter.x},${bearCenter.y}) stage=(${stageCenter.x},${stageCenter.y})`)
check(await evaluate(`document.querySelector('[data-pet3d-menu]') === null`), '菜单初始没开')

/* -------------------------------------------------------- 2. 点小熊开菜单 */
console.log('\n--- 2. 点小熊 -> 菜单贴边弹出，不盖住宠物 ---')
await clickAt(bearCenter.x, bearCenter.y)
await sleep(500)
check(await evaluate(`document.querySelector('[data-pet3d-menu]') !== null`), '点小熊后菜单出现')
const rect = await menuRect()
check(rect !== null, '菜单有布局盒子')
const petRight = stage.x + stage.w
const disjoint = rect !== null && (rect.x + rect.w <= stage.x || rect.x >= petRight || rect.y + rect.h <= stage.y || rect.y >= stage.y + stage.h)
check(disjoint, '菜单不压在宠物方框上（贴边）', rect === null ? '' : `menu=(${rect.x},${rect.y}) 宠物=(${stage.x},${stage.y}) ${stage.w}px`)
const viewport = await evaluate(`({ w: innerWidth, h: innerHeight })`)
check(rect !== null && rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= viewport.w && rect.y + rect.h <= viewport.h,
  '菜单整个都在视口内', rect === null ? '' : `x=${rect.x}..${rect.x + rect.w} y=${rect.y}..${rect.y + rect.h} / ${viewport.w}x${viewport.h}`)
await shoot('menu-open.png')

/* ---------------------------------------------------------- 3. 数据驱动内容 */
console.log('\n--- 3. 菜单内容是模型目录里的配饰表，不是写死的 ---')
const rowCount = Number(await evaluate(`document.querySelectorAll('[data-pet3d-piece]').length`))
const expected = appearance === null ? 0 : appearance.pieces.length
check(rowCount === expected, '配饰行数与 appearance.json 一致', `菜单 ${rowCount} / 文件 ${expected}`)
const rowLabels = await evaluate(`[...document.querySelectorAll('[data-pet3d-piece]')].map(el => el.textContent.trim())`)
const labelsOk = appearance === null || appearance.pieces.every((piece, index) => String(rowLabels[index] ?? '').includes(piece.label))
check(labelsOk, '每行的名字来自配饰表', JSON.stringify(rowLabels))
const activeChip = await evaluate(`document.querySelector('[data-pet3d-menu-model-active="1"]')?.getAttribute('data-pet3d-menu-model') ?? null`)
check(activeChip === originModel, '「整套外观」标出了当前穿着', String(activeChip))

/* ------------------------------------------------- 3b. 互斥款式（多选一） */
const groups = appearance?.groups ?? []
if (groups.length === 0) {
  console.log('\n--- 3b. 这个模型没有款式组，跳过 ---')
} else {
  console.log('\n--- 3b. 款式组：同一组只穿一件 ---')
  const expectedOptions = groups.reduce((sum, group) => sum + group.options.length, 0)
  const optionCount = Number(await evaluate(`document.querySelectorAll('[data-pet3d-group-option]').length`))
  check(optionCount === expectedOptions, '款式选项数量与文件一致', `菜单 ${optionCount} / 文件 ${expectedOptions}`)
  const group = groups[0]
  const defaultOption = group.options.find(option => option.default) ?? group.options.find(option => option.nodes.length > 0)
  const activeOption = await evaluate(`document.querySelector('[data-pet3d-group="${group.id}"] [data-pet3d-group-option-active="1"]')?.getAttribute('data-pet3d-group-option') ?? null`)
  check(activeOption === defaultOption.id, `「${group.label}」默认穿的是 ${defaultOption.id}`, String(activeOption))
  // 换到同组另一个有几何的款
  const other = group.options.find(option => option.id !== defaultOption.id && option.nodes.length > 0)
  if (other === undefined) {
    check(false, `「${group.label}」没有第二个有几何的款可测`)
  } else {
    await clickSelector(`[data-pet3d-group="${group.id}"] [data-pet3d-group-option="${other.id}"]`)
    await sleep(700)
    const hiddenNow = (await stageBox())?.hidden ?? ''
    const nowActive = await evaluate(`document.querySelector('[data-pet3d-group="${group.id}"] [data-pet3d-group-option-active="1"]')?.getAttribute('data-pet3d-group-option') ?? null`)
    check(nowActive === other.id, `点「${other.label}」之后它变成选中款`, String(nowActive))
    check(other.nodes.every(name => !hiddenNow.split(',').includes(name)), '新选中的款显示了', `${other.label} @${other.nodes.join(',')}`)
    const oldHidden = defaultOption.nodes.every(name => hiddenNow.split(',').includes(name))
    check(oldHidden || defaultOption.nodes.length === 0, '同组的旧款被藏起来了', `hidden=${hiddenNow}`)
    const instNow = await instrument()
    check(String(instNow.parts ?? '') !== 'all' || defaultOption.nodes.length === 0, '渲染器收到了换款（parts 里有被藏的旧款）', `parts=${instNow.parts}`)
    // 换回默认款
    await clickSelector(`[data-pet3d-group="${group.id}"] [data-pet3d-group-option="${defaultOption.id}"]`)
    await sleep(700)
    check(sameSet((await stageBox())?.hidden, expectedHidden), '换回默认款后隐藏表回到默认', String((await stageBox())?.hidden))
  }
}

/* ------------------------------------------------------ 4. 穿脱一件配饰 */
console.log('\n--- 4. 脱一件配饰：DOM + 场景图 + 绘制调用数三条都要动 ---')
const firstPiece = appearance?.pieces?.[0] ?? null
if (firstPiece === null) {
  console.log('  （这个模型没有配饰表，跳过穿脱检查）')
} else {
  const beforeInst = await instrument()
  const beforeDc = Number(beforeInst.dc)
  const beforeTri = Number(beforeInst.tri)
  baselineDrawCalls = beforeDc
  check(sameSet(beforeInst.parts, expectedHidden) || (expectedHidden.length === 0 && beforeInst.parts === 'all'),
    '一开始就是默认状态（没多脱）',
    `parts=${beforeInst.parts} 期望=${expectedHidden.join(',') || 'all'}`)
  await clickSelector(`[data-pet3d-piece="${firstPiece.id}"] [role="switch"]`)
  await sleep(700)
  const after = await stageBox()
  check(after?.hidden?.includes(firstPiece.nodes[0]) === true, 'stage 上记录了被脱的节点', String(after?.hidden))
  const off = await evaluate(`document.querySelector('[data-pet3d-piece="${firstPiece.id}"]')?.getAttribute('data-pet3d-piece-on')`)
  check(off === '0', '开关显示为"已脱下"', String(off))
  const inst = await instrument()
  check(String(inst.parts ?? '').includes(firstPiece.nodes[0]), '渲染器仪表承认藏了它（部件名）', `parts=${inst.parts}`)
  check(Number(inst.dc) < beforeDc, '绘制调用数下降（GPU 真的没画它）', `${beforeDc} -> ${inst.dc}`)
  check(Number(inst.tri) < beforeTri, '三角形数下降', `${beforeTri} -> ${inst.tri}`)
  await shoot('menu-piece-off.png', { x: stage.x - 10, y: stage.y - 10, width: stage.w + 20, height: stage.h + 20 })

  console.log('\n--- 5. 耐久：刷新页面后还是脱着的（本地持久化） ---')
  await send('Page.reload')
  await sleep(WAIT_S * 1000)
  const reloaded = await stageBox()
  check(reloaded?.hidden?.includes(firstPiece.nodes[0]) === true, '刷新后仍然是脱着的', String(reloaded?.hidden))
  const reloadedInst = await instrument()
  check(String(reloadedInst.parts ?? '').includes(firstPiece.nodes[0]), '刷新后渲染器也重放了状态', `parts=${reloadedInst.parts}`)
  check(Number(reloadedInst.dc) < beforeDc, '刷新后绘制调用数仍然更低', `${beforeDc} -> ${reloadedInst.dc}`)

  // 回到菜单，把这件穿回去（后面的检查需要一个干净状态）。
  // 刷新之后指针状态是"不在框内"（小熊藏着），所以先挪进去再点。
  const stageAfterReload = await stageBox()
  await moveTo(stageAfterReload.x + stageAfterReload.w / 2, stageAfterReload.y + stageAfterReload.h / 2)
  const bear2 = await evaluate(`(() => { const r = document.querySelector('[data-pet3d-menu-toggle]')?.getBoundingClientRect(); return r === undefined ? null : { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await clickAt(bear2.x, bear2.y)
  await sleep(400)
  await clickSelector(`[data-pet3d-piece="${firstPiece.id}"] [role="switch"]`)
  await sleep(600)
  check(sameSet((await stageBox())?.hidden, expectedHidden), '穿回去之后没有多余的隐藏节点', String((await stageBox())?.hidden))
  check(sameSet((await instrument()).parts, expectedHidden) || (expectedHidden.length === 0 && (await instrument()).parts === 'all'), '渲染器也回到默认状态')
}

/* ---------------------------------------------------- 6. 全部穿上/全部脱下 */
console.log('\n--- 6. 全部脱下 / 全部穿上 ---')
if (appearance !== null && appearance.pieces.length > 0) {
  await clickSelector('[data-pet3d-strip-all]')
  await sleep(800)
  const allOff = await stageBox()
  const declaredNodes = appearance.pieces.flatMap(piece => piece.nodes)
  check(declaredNodes.every(name => (allOff?.hidden ?? '').split(',').includes(name)), '全部脱下：每个声明过的节点都被藏了', allOff?.hidden)
  const strippedInst = await instrument()
  check(Number(strippedInst.dc) < baselineDrawCalls, '全部脱下后绘制调用数明显下降（只剩身体/脸/道具）',
    `${baselineDrawCalls} -> ${strippedInst.dc}`)
  await shoot('menu-all-off.png', { x: stage.x - 10, y: stage.y - 10, width: stage.w + 20, height: stage.h + 20 })

  await clickSelector('[data-pet3d-wear-all]')
  await sleep(800)
  check(sameSet((await stageBox())?.hidden, expectedHidden), '全部穿上：隐藏表回到默认')
}

/* ------------------------------------------------------------ 7. 整套换装 */
console.log('\n--- 7. 整套外观：换一个模型，菜单留在原地，配饰表跟着换 ---')
const others = state0.models.filter(id => id !== originModel)
if (others.length === 0) {
  console.log('  （只装了一个模型，跳过）')
} else {
  const other = others[0]
  await clickSelector(`[data-pet3d-menu-model="${other}"]`)
  await sleep(2500)
  const switched = await hostState()
  check(switched?.model === other, `点「${other}」之后宿主换过去了`, `现在是 ${switched?.model}`)
  check(await evaluate(`document.querySelector('[data-pet3d-menu]') !== null`), '换模型时菜单没被关掉')
  const otherTable = readAppearance(other)
  const otherRows = Number(await evaluate(`document.querySelectorAll('[data-pet3d-piece]').length`))
  check(otherRows === (otherTable === null ? 0 : otherTable.pieces.length),
    '配饰行数跟着新模型的表变', `${otherRows} / 文件 ${otherTable === null ? 0 : otherTable.pieces.length}`)
  // 换回去：用户的选中状态必须复原。
  await clickSelector(`[data-pet3d-menu-model="${originModel}"]`)
  await sleep(2500)
  const back = await hostState()
  check(back?.model === originModel, '换回原来的模型', `现在是 ${back?.model}`)
}

/* --------------------------------------------------- 7b. 互动面板（数据驱动） */
console.log('\n--- 7b. 互动面板：按钮/动作/台词/好感度四条都要成立 ---')
const interactions = readInteractions(originModel)
/** 菜单里的好感度读数（`null` = 菜单没开或没配互动）。 */
const affinityNow = () => evaluate(`(() => {
  const el = document.querySelector('[data-pet3d-affinity]')
  if (el === null) return null
  return { value: Number(el.getAttribute('data-pet3d-affinity')), max: Number(el.getAttribute('data-pet3d-affinity-max')) }
})()`)
/** 点小熊把菜单打开（刷新之后指针状态归零，必须先挪进方框）。 */
const reopenMenu = async () => {
  const box = await stageBox()
  await moveTo(box.x + box.w / 2, box.y + box.h / 2)
  const point = await evaluate(`(() => {
    const r = document.querySelector('[data-pet3d-menu-toggle]')?.getBoundingClientRect()
    return r === undefined ? null : { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (point !== null) await clickAt(point.x, point.y)
  await sleep(500)
}
/** 等互动表拉回来、按钮渲染出来。 */
const waitForInteractionButtons = async (count) => {
  for (let i = 0; i < 24; i++) {
    const n = Number(await evaluate(`document.querySelectorAll('[data-pet3d-interaction]').length`))
    if (n === count) return true
    await sleep(250)
  }
  return false
}

if (interactions === null) {
  // 没配也要"说清楚"：不报错、不空白、不放假按钮。
  await sleep(600)
  check(Number(await evaluate(`document.querySelectorAll('[data-pet3d-interaction]').length`)) === 0,
    '没有 interactions.json 时不放假按钮')
  check(await evaluate(`document.querySelector('[data-pet3d-interactions-empty]') !== null`),
    '「互动」显示“这个模型还没配互动”')
} else {
  const actions = Array.isArray(interactions.actions) ? interactions.actions : []
  const clips = JSON.parse(readFileSync(join(DSH_HOME, 'models', originModel, '.import', 'clips.json'), 'utf8'))
  const clipNames = new Set((Array.isArray(clips) ? clips : clips.clips ?? []).map(clip => clip.name))
  check(actions.length > 0 && actions.every(action => clipNames.has(action.clip)),
    '表里的 clip 全是动作表里的真名', actions.map(action => action.clip).join(' | '))

  // 好感度是本地存的：先清掉，测出来的数字才可重复（本项验收自己从 0 开始）。
  await evaluate(`localStorage.removeItem(${JSON.stringify(`pet3d:affinity:${originModel}`)})`)
  await send('Page.reload')
  await sleep(WAIT_S * 1000)
  await reopenMenu()
  check(await waitForInteractionButtons(actions.length), '刷新后互动按钮重新出现', String(actions.length))

  const ids = await evaluate(`[...document.querySelectorAll('[data-pet3d-interaction]')].map(el => el.getAttribute('data-pet3d-interaction'))`)
  check(JSON.stringify(ids) === JSON.stringify(actions.map(action => action.id)),
    '按钮与 interactions.json 一一对应', JSON.stringify(ids))
  const start = await affinityNow()
  check(start !== null && start.value === 0, '好感度从 0 开始', JSON.stringify(start))
  if (start !== null) {
    check(start.max === (interactions.affinity?.max ?? 10),
      '进度条上限来自互动表', `${start.max} / 文件 ${interactions.affinity?.max ?? 10}`)
  }

  const first = actions[0]
  await clickSelector(`[data-pet3d-interaction="${first.id}"]`)
  await sleep(700)
  const afterFirst = await instrument()
  check(String(afterFirst.mplay ?? '').includes(first.clip)
    || String(afterFirst.owner ?? '').includes(shortClipName(first.clip)),
  `点「${first.label}」动作真的切了`, `mplay=${afterFirst.mplay} owner=${afterFirst.owner}`)
  const bubbleText = await evaluate(`document.querySelector('[data-pet3d-interaction-line]')?.textContent ?? null`)
  check(bubbleText !== null && bubbleText.includes(first.line), '台词气泡出现', String(bubbleText))
  const afterValue = await affinityNow()
  const expectedValue = Math.min(interactions.affinity?.max ?? 10, (first.affinity ?? 1))
  check(afterValue?.value === expectedValue, '好感度按 affinity 增加', `${start?.value} -> ${afterValue?.value}（期望 ${expectedValue}）`)
  check(await evaluate(`document.querySelector('[data-pet3d-interaction="${first.id}"]')?.getAttribute('data-pet3d-interaction-cooling')`) === '1',
    '点过的按钮进入 2 秒冷却')

  await clickSelector(`[data-pet3d-interaction="${first.id}"]`)
  await sleep(250)
  const stillValue = await affinityNow()
  check(stillValue?.value === afterValue?.value, '冷却期内重复点不会重复加', `${afterValue?.value} -> ${stillValue?.value}`)

  for (const action of actions.slice(1)) {
    await clickSelector(`[data-pet3d-interaction="${action.id}"]`)
    await sleep(650)
    const inst = await instrument()
    check(String(inst.mplay ?? '').includes(action.clip)
      || String(inst.owner ?? '').includes(shortClipName(action.clip)),
    `「${action.label}」也能播`, `mplay=${inst.mplay}`)
    const bubble = await evaluate(`document.querySelector('[data-pet3d-interaction-line]')?.textContent ?? null`)
    check(bubble !== null && bubble.includes(action.line), `「${action.label}」的台词出现`, String(bubble))
  }

  const max = Number(interactions.affinity?.max ?? 10)
  const before = await affinityNow()
  const expectedTotal = Math.min(max, actions.reduce((sum, action) => sum + (action.affinity ?? 1), 0))
  check(before?.value === expectedTotal, '连点下来好感度累计正确', `${before?.value}（期望 ${expectedTotal}）`)

  await send('Page.reload')
  await sleep(WAIT_S * 1000)
  await reopenMenu()
  await waitForInteractionButtons(actions.length)
  const persisted = await affinityNow()
  check(persisted?.value === before?.value, '刷新页面后好感度还在（localStorage）', `${before?.value} -> ${persisted?.value}`)
  check(await evaluate(`document.querySelector('[data-pet3d-interaction-line]') === null`), '刷新后没有残留气泡')
  await shoot('menu-interactions.png')
}

/* ------------------------------------------------------------ 8. Esc / 边界 */
console.log('\n--- 8. Esc 关菜单；开发者 UI 不在互动面板里 ---')
await pressEscape()
await sleep(400)
check(await evaluate(`document.querySelector('[data-pet3d-menu]') === null`), 'Esc 把菜单关掉了')
const stageFinal = await stageBox()
await moveTo(stageFinal.x + stageFinal.w / 2, stageFinal.y + stageFinal.h / 2)
const bear3 = await evaluate(`(() => { const r = document.querySelector('[data-pet3d-menu-toggle]')?.getBoundingClientRect(); return r === undefined ? null : { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
await clickAt(bear3.x, bear3.y)
await sleep(400)
check(await evaluate(`document.querySelector('[data-pet3d-menu]') !== null`), '再点小熊能重新打开')
check(await evaluate(`document.querySelector('[data-pet3d-menu-dev]') === null`), '互动面板里没有开发者入口（用户明确要求分开）')
// 开发者面板仍然走"开发者模式 + 点宠物"那条老路。
await clickAt(stageFinal.x + Math.round(stageFinal.w * 0.3), stageFinal.y + Math.round(stageFinal.h * 0.3))
await sleep(700)
check(await evaluate(`document.querySelector('[data-pet3d-panel]') !== null`), '点宠物（开发者模式）仍然打开检查面板')
await pressEscape()   // 第一次 Esc：先关菜单
await sleep(250)
await pressEscape()   // 第二次 Esc：关检查面板
await sleep(400)
check(await evaluate(`document.querySelector('[data-pet3d-panel]') === null`), '再按 Esc 关掉检查面板')

/* ------------------------------------------------------------------ 收尾 */
console.log('\n--- 9. 收尾：没有遗留状态/异常 ---')
const finalState = await hostState()
check(finalState?.model === originModel, '选中的模型复原', String(finalState?.model))
if (appearance !== null && appearance.pieces.length > 0) {
  check(sameSet((await stageBox())?.hidden, expectedHidden), '配饰状态复原（回到默认）', String((await stageBox())?.hidden))
}
check(exceptions.length === 0, '页面没有未捕获异常', exceptions.slice(0, 3).join(' | '))

console.log(`\n截图：${OUT}`)
if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  - ${failure}`)
} else {
  console.log('\n全部通过')
}
try { ws.close() } catch { /* ignore */ }
chrome.kill()
await sleep(300)
try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp dir */ }
process.exit(failures.length === 0 ? 0 : 1)
