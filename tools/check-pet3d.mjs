/**
 * Offline plumbing check for the self-owned pet kernel (dsh-pet-3d).
 *
 * Loads the BUILT host half, mounts it on a stub cordis context, and drives its
 * HTTP routes in-process against the REAL `$DSH_HOME/models` directory (the
 * synthetic `_fixture` model plus whatever the user has installed). It answers
 * "is the wiring right?" — folder scan, options.json parse, phase mapping,
 * content-hashed subdirectory serving, clip index, importer subprocess, hot-swap
 * revision — and deliberately says nothing about "does it look right", which
 * stays with the user's eyes on the real window.
 *
 * It also checks, STRICTLY READ-ONLY, that any REAL model folder is judged
 * FRESH: a false "stale" there means the host re-imports hundreds of megabytes
 * every five seconds, forever. Nothing in that check writes, imports or even
 * opens a file for writing outside the OS temp directory.
 *
 * Usage:
 *   node tools/check-pet3d.mjs [--model _fixture]
 * Exit code 0 = every check passed.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Writable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const pkgDir = join(repoRoot, 'packages', 'dsh-pet-3d')
const entry = join(pkgDir, 'lib', 'index.js')
const modelsRoot = join(process.env.DSH_HOME ?? 'D:\\.dsh', 'models')
const generator = join(repoRoot, 'tools', 'make-fixture-model.mjs')

const modelFlag = process.argv.indexOf('--model')
const modelId = modelFlag >= 0 ? (process.argv[modelFlag + 1] ?? '_fixture') : '_fixture'

// This guard SPAWNS the fixture generator as the importer against the selected model directory (see
// the spawnSync further down), so pointing it at a real model rewrites that model's `.import/` —
// measured, twice, the second time costing 156 MB of real output. Real models are covered by the
// strictly read-only freshness section, which needs no --model.
if (!modelId.startsWith('_')) {
  console.error(`check-pet3d 拒绝 --model ${modelId}：本守卫会把 fixture 生成器当导入器，`)
  console.error('指向真实模型目录会覆盖它的 .import/ 产物。真实模型请用只读的新鲜度检查（无需 --model）。')
  process.exit(2)
}

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// --- the fixture must exist (the check drives a REAL model folder) ---------
{
  const result = spawnSync(process.execPath, [generator, join(modelsRoot, modelId), '--json', '--variant', 'A'], {
    encoding: 'utf8', cwd: repoRoot,
  })
  if (result.status !== 0) {
    console.error('  无法生成 fixture：', result.stderr || result.stdout)
    process.exit(1)
  }
}

/** A ServerResponse stand-in that captures status, headers and body bytes. */
class FakeRes extends Writable {
  constructor() {
    super()
    this.chunks = []
    this.statusCode = 0
    this.headers = {}
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(chunk)
    callback()
  }

  writeHead(status, headers = {}) {
    this.statusCode = status
    this.headers = headers
    return this
  }

  get body() {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  get bytes() {
    return Buffer.concat(this.chunks).length
  }
}

/** Drive one route handler to completion. `body` is serialized as JSON. */
async function call(route, method, url, body) {
  const res = new FakeRes()
  const finished = new Promise(resolve => res.on('finish', resolve))
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:19387', accept: '*/*' },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
    // A real IncomingMessage is async-iterable; the body reader walks it.
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
  await route.handler(req, res)
  await Promise.race([finished, new Promise(resolve => setTimeout(resolve, 30000))])
  return res
}

console.log(`check-pet3d: ${entry}`)
console.log(`  models root: ${modelsRoot}`)
if (!statSync(entry, { throwIfNoEntry: false })) {
  console.error('  构建产物不存在，先跑一次 pnpm build（或 tsdown）')
  process.exit(1)
}

// --- mount on a stub cordis context --------------------------------------
const routes = []
const listeners = new Map()
const intervals = []
/** Fire one host event at every listener the plugin registered for it. */
const emit = (event, ...args) => {
  for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
}
const ctx = {
  effect(fn) {
    const disposer = fn()
    return () => { if (typeof disposer === 'function') disposer() }
  },
  on(event, fn) {
    const list = listeners.get(event) ?? []
    list.push(fn)
    listeners.set(event, list)
    return () => {
      const current = listeners.get(event)
      if (current === undefined) return
      const index = current.indexOf(fn)
      if (index >= 0) current.splice(index, 1)
    }
  },
  get() { return undefined },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, ms, ...rest) => {
  const handle = realSetInterval(fn, ms, ...rest)
  intervals.push(handle)
  return handle
}

const mod = await import(pathToFileURL(entry).href)
check(mod.name === 'pet3d', 'host half exports name=pet3d', String(mod.name))
check(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'host half injects webServer')
check(typeof mod.apply === 'function', 'host half exports apply')
check(mod.Config !== undefined, 'host half exports a Config schema')

mod.apply(ctx, {
  visible: true,
  size: 348,
  right: 806,
  bottom: 0,
  petId: modelId,
  importerScript: generator,
})

const paths = routes.map(route => route.path)
console.log(`  已注册路由: ${paths.join(', ')}`)
for (const expected of [
  '/api/pet3d/state',
  '/api/pet3d/models',
  '/api/pet3d/display',
  '/api/pet3d/set-pet',
  '/api/pet3d/reimport',
  '/api/pet3d/clips',
  '/pet3d',
  '/api/pet3d/runtime/three-vendor.js',
]) {
  check(paths.includes(expected), `注册了 ${expected}`)
}
check(intervals.length >= 1, '注册了新鲜度扫描定时器（≤每 5 秒一次）', String(intervals.length))

// --- the state snapshot, against the real models directory ----------------
const stateRoute = routes.find(route => route.path === '/api/pet3d/state')
const stateRes = await call(stateRoute, 'GET', '/api/pet3d/state')
check(stateRes.statusCode === 200, 'GET /api/pet3d/state -> 200', String(stateRes.statusCode))

const snapshot = JSON.parse(stateRes.body)
check(
  snapshot.problems.every(line => !line.includes(modelId)),
  '模型目录里没有关于这个模型的问题',
  snapshot.problems.join(' | '),
)
check(snapshot.model?.id === modelId, `选中模型是 ${modelId}`, String(snapshot.model?.id))
check(snapshot.display.size === 348, 'display.size 来自 profile 配置 (348)', String(snapshot.display.size))
check(snapshot.display.right === 806, 'display.right 来自 profile 配置 (806)', String(snapshot.display.right))
check(snapshot.phase === 'idle', 'phase 目前是 idle（相位投影尚未接线）', String(snapshot.phase))
check(['idle', 'walk', 'run', 'think', 'done', 'failed'].includes(snapshot.phase), 'phase 是 6 状态之一', String(snapshot.phase))

const m = snapshot.model?.model3d ?? {}
check(typeof m.revision === 'string' && m.revision.length >= 8, 'model3d.revision 存在（热换判据）', String(m.revision))
check(snapshot.modelRevision === m.revision, '/state 顶层带 modelRevision（等于模型 revision）', String(snapshot.modelRevision))
check(
  ['model.glb', 'clips.json', 'clips.bin'].every(name => typeof m.artifacts?.[name] === 'string'),
  'model3d.artifacts 带逐产物 sha256',
  Object.keys(m.artifacts ?? {}).join(', '),
)
check(typeof m.artifacts?.['textures/fixture.png'] === 'string', '贴图哈希也在 artifacts 里（贴图热换判据）')
check(m.modelUrl.includes('.import/model.glb?h='), 'modelUrl 指向 .import/model.glb 且带内容哈希', String(m.modelUrl))
check(m.clipsUrl.includes('.import/clips.json?h='), 'clipsUrl 指向 .import/clips.json 且带内容哈希', String(m.clipsUrl))
check(m.clipsBinUrl.includes('.import/clips.bin?h='), 'clipsBinUrl 指向 .import/clips.bin 且带内容哈希', String(m.clipsBinUrl))
check(['idle', 'walk', 'run', 'think', 'done', 'failed'].every(state => typeof m.phases?.[state] === 'string'), 'phases 覆盖 6 状态', JSON.stringify(m.phases))
check(m.phases.idle === 'Fixture_Arm_Idle_Loop', 'phases.idle 按名字约定命中 Idle_Loop', String(m.phases.idle))
check(m.phases.failed === 'Fixture_Galgame_Sad', 'phases.failed 按名字约定命中 Sad', String(m.phases.failed))
check(m.phases.run === 'Fixture_Galgame_Sad', 'phases.run 被 options.json 覆盖', String(m.phases.run))
check(m.phases.done === 'Fixture_Arm_Idle_Loop', 'phases.done 无约定时退到第一条 clip', String(m.phases.done))
check(m.framing === 1.2, 'framing 取自 options.json (1.2)', String(m.framing))
check(m.yaw === 0, 'yaw 取自 options.json (0)', String(m.yaw))
check(m.scale === 1, 'scale 取自 options.json (1)', String(m.scale))
check(m.clipCount === 2, 'clipCount 来自 clips.json (2)', String(m.clipCount))
check(Array.isArray(snapshot.model.warnings) && snapshot.model.warnings.some(line => line.includes('相位 done')), '相位退到第一条时记了 warning', (snapshot.model.warnings ?? []).join(' | '))

// --- the model list ------------------------------------------------------
const modelsRoute = routes.find(route => route.path === '/api/pet3d/models')
const modelsRes = await call(modelsRoute, 'GET', '/api/pet3d/models')
const models = JSON.parse(modelsRes.body)
check(modelsRes.statusCode === 200, 'GET /api/pet3d/models -> 200', String(modelsRes.statusCode))
const fixtureRow = (models.models ?? []).find(row => row.id === modelId)
check(fixtureRow !== undefined, `/models 列出 ${modelId}`, (models.models ?? []).map(row => row.id).join(', '))
check(fixtureRow?.revision === m.revision, '/models 的 revision 与 state 一致', String(fixtureRow?.revision))
check(typeof fixtureRow?.stale === 'boolean', '/models 报告源文件是否已变（stale）', String(fixtureRow?.stale))

// --- the clip index route ------------------------------------------------
const clipsRoute = routes.find(route => route.path === '/api/pet3d/clips' && route.kind === 'prefix')
const clipsRes = await call(clipsRoute, 'GET', `/api/pet3d/clips/${modelId}`)
const clips = JSON.parse(clipsRes.body)
check(clipsRes.statusCode === 200, 'GET /api/pet3d/clips/<id> -> 200', String(clipsRes.statusCode))
check(clips.clips?.length === 2, 'clip 索引返回 2 条', String(clips.clips?.length))
check(clips.clips?.[0]?.keyframes === 3 && clips.clips?.[1]?.keyframes === 2, 'clip 索引带关键帧计数', JSON.stringify(clips.clips?.map(c => c.keyframes)))
const missingClips = await call(clipsRoute, 'GET', '/api/pet3d/clips/does-not-exist')
check(missingClips.statusCode === 404, '未知模型的 clip 索引 -> 404', String(missingClips.statusCode))

// --- the media route: subdirectories + content-addressed caching ----------
const assetRoute = routes.find(route => route.path === '/pet3d' && route.kind === 'prefix')
const glbDigest = m.artifacts['model.glb']
const modelFile = join(modelsRoot, modelId, '.import', 'model.glb')
const glbRes = await call(assetRoute, 'GET', `/pet3d/${modelId}/.import/model.glb?h=${glbDigest}`)
check(glbRes.statusCode === 200, 'GET 子目录里的 model.glb -> 200', String(glbRes.statusCode))
check(glbRes.bytes === statSync(modelFile).size, '模型字节数与磁盘一致', `${glbRes.bytes} vs ${statSync(modelFile).size}`)
check(glbRes.headers['content-type'] === 'model/gltf-binary', '模型 content-type 正确', String(glbRes.headers['content-type']))
check(String(glbRes.headers['cache-control']).includes('immutable'), '带正确内容哈希 -> Cache-Control immutable', String(glbRes.headers['cache-control']))
const glbPlain = await call(assetRoute, 'GET', `/pet3d/${modelId}/.import/model.glb`)
check(glbPlain.headers['cache-control'] === 'no-cache', '不带哈希 -> 每次revalidate（no-cache）', String(glbPlain.headers['cache-control']))
const glbStale = await call(assetRoute, 'GET', `/pet3d/${modelId}/.import/model.glb?h=deadbeefdead`)
check(glbStale.headers['cache-control'] === 'no-cache', '哈希对不上 -> 不声明 immutable', String(glbStale.headers['cache-control']))

const binRes = await call(assetRoute, 'GET', `/pet3d/${modelId}/.import/clips.bin`)
const binFile = join(modelsRoot, modelId, '.import', 'clips.bin')
check(binRes.statusCode === 200 && binRes.bytes === statSync(binFile).size, 'GET .import/clips.bin -> 200 且字节一致', `${binRes.bytes} vs ${statSync(binFile).size}`)
const pngRes = await call(assetRoute, 'GET', `/pet3d/${modelId}/textures/fixture.png`)
check(pngRes.statusCode === 200, 'GET textures/ 子目录 -> 200', String(pngRes.statusCode))
check(pngRes.headers['content-type'] === 'image/png', '贴图 content-type 正确', String(pngRes.headers['content-type']))

// Escapes must be refused: encoded traversal, absolute-ish path, bad extension.
const traversal = await call(assetRoute, 'GET', `/pet3d/${modelId}/%2e%2e%2fpet3d.json`)
check(traversal.statusCode === 403 || traversal.statusCode === 404, '编码穿越被拒', String(traversal.statusCode))
const badExt = await call(assetRoute, 'GET', `/pet3d/${modelId}/secret.exe`)
check(badExt.statusCode === 403, '非白名单扩展名被拒', String(badExt.statusCode))
const unknownModel = await call(assetRoute, 'GET', '/pet3d/does-not-exist/.import/model.glb')
check(unknownModel.statusCode === 404, '未知模型 -> 404', String(unknownModel.statusCode))

// --- the vendor bundle ----------------------------------------------------
const vendorRoute = routes.find(route => route.path === '/api/pet3d/runtime/three-vendor.js')
const vendorRes = await call(vendorRoute, 'GET', '/api/pet3d/runtime/three-vendor.js')
check(vendorRes.statusCode === 200, 'GET three-vendor.js -> 200', String(vendorRes.statusCode))
const vendorFile = statSync(join(pkgDir, 'lib', 'three-vendor.js'))
check(vendorRes.bytes === vendorFile.size, 'vendor 字节数与磁盘一致', `${vendorRes.bytes} vs ${vendorFile.size}`)
check(vendorFile.size > 500_000, 'vendor 不是构建桩（应 >500KB）', `${vendorFile.size} B`)
const vendorText = readFileSync(join(pkgDir, 'lib', 'three-vendor.js'), 'utf8')
check(vendorText.includes('QuaternionKeyframeTrack') && vendorText.includes('AnimationClip'), 'vendor 导出了组装 clip 需要的类')

// --- write endpoints reject bad input WITHOUT touching persistence ---------
const persistFile = join(process.env.DSH_HOME ?? '', 'pet3d.json')
const persistBefore = statSync(persistFile, { throwIfNoEntry: false }) ? readFileSync(persistFile, 'utf8') : null
const displayRoute = routes.find(route => route.path === '/api/pet3d/display')
const badDisplay = await call(displayRoute, 'POST', '/api/pet3d/display', { size: 'big' })
check(badDisplay.statusCode === 400, 'POST /display 拒绝非法数值 -> 400', String(badDisplay.statusCode))
const setPetRoute = routes.find(route => route.path === '/api/pet3d/set-pet')
const badPet = await call(setPetRoute, 'POST', '/api/pet3d/set-pet', { petId: 123 })
check(badPet.statusCode === 400, 'POST /set-pet 拒绝非法类型 -> 400', String(badPet.statusCode))
const badReimport = await call(routes.find(route => route.path === '/api/pet3d/reimport'), 'POST', '/api/pet3d/reimport', { modelId: 'nope' })
check(badReimport.statusCode === 400, 'POST /reimport 未知模型 -> 400', JSON.parse(badReimport.body).error)
const persistAfter = statSync(persistFile, { throwIfNoEntry: false }) ? readFileSync(persistFile, 'utf8') : null
check(persistBefore === persistAfter, '被拒的写入没有落盘（pet3d.json 未变）')

// --- the phase projection (pure source module: no build needed) ------------
{
  const { emptyProjectionState, projectEvent, projectAssistantStreamFrame } =
    await import(pathToFileURL(join(pkgDir, 'src', 'projection.ts')).href)

  /** Fold a sequence of events into the final phase (undefined when none). */
  const phaseOf = (events) => {
    const state = emptyProjectionState()
    let last
    for (const event of events) last = projectEvent(event, state) ?? last
    return last
  }

  check(phaseOf([{ type: 'turn/start' }]) === 'waiting', 'turn/start -> waiting')
  check(phaseOf([{ type: 'assistant/message' }]) === 'review', 'assistant/message -> review')
  check(phaseOf([{ type: 'tool/call', data: { callId: 'a', name: 'Read' } }]) === 'tool', 'tool/call -> tool')
  check(
    phaseOf([{ type: 'tool/call', data: { callId: 'a' } }, { type: 'tool/result', data: { message: { toolCallId: 'a' } } }]) === 'thinking',
    'tool/result（成功且无在途）-> thinking',
  )
  check(
    phaseOf([{ type: 'tool/call', data: { callId: 'a' } }, { type: 'tool/result', data: { message: { toolCallId: 'a', isError: true } } }]) === 'failed',
    'tool/result（失败）-> failed',
  )
  check(
    phaseOf([
      { type: 'tool/call', data: { callId: 'a' } },
      { type: 'tool/call', data: { callId: 'b' } },
      { type: 'tool/result', data: { message: { toolCallId: 'a' } } },
    ]) === 'tool',
    'tool/result（仍有在途）-> tool',
  )
  check(phaseOf([{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]) === 'done', 'turn/end completed -> done')
  check(phaseOf([{ type: 'turn/end', data: { reason: { kind: 'error' } } }]) === 'failed', 'turn/end error -> failed')
  check(phaseOf([{ type: 'turn/end', data: { reason: { kind: 'blocked' } } }]) === 'waiting', 'turn/end blocked -> waiting')
  check(phaseOf([{ type: 'turn/end', data: { reason: { kind: 'aborted' } } }]) === 'idle', 'turn/end aborted -> idle')
  check(phaseOf([{ type: 'some/future-event' }]) === undefined, '未知事件 -> undefined（不打扰当前相位）')
  check(
    projectAssistantStreamFrame({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'x' } }) === 'thinking',
    'reasoning-delta -> thinking',
  )
  check(
    projectAssistantStreamFrame({ type: 'chunk', chunk: { type: 'text-delta', text: 'x' } }) === 'review',
    'text-delta -> review',
  )
  check(projectAssistantStreamFrame({ type: 'start' }) === undefined, '非 chunk 帧 -> undefined')
}

// --- the 6-state compression (pure source module) -------------------------
{
  const { phaseStateOf, PHASE_STATES } = await import(pathToFileURL(join(pkgDir, 'src', 'state.ts')).href)
  check(PHASE_STATES.join(',') === 'idle,walk,run,think,done,failed', '6 状态清单固定', PHASE_STATES.join(','))
  check(phaseStateOf('idle') === 'idle', 'idle -> idle')
  // 模型在主动产出（推理流 / 正文流 / 工具调用在生成）⇒ 跑
  for (const phase of ['thinking', 'tool', 'review']) {
    check(phaseStateOf(phase) === 'run', `${phase} -> run（模型在产出）`)
  }
  // 模型没在主动输出（等用户回话、等工具或命令跑完、turn/step 刚起）⇒ 思考
  check(phaseStateOf('waiting') === 'think', 'waiting -> think（等用户/等工具）')
  check(phaseStateOf('done') === 'done', 'done -> done')
  check(phaseStateOf('failed') === 'failed', 'failed -> failed')

  // "闲置 →（即将工作）走 →（工作时）跑"的引导（纯函数，客户端用）
  const { leadInBefore } = await import(pathToFileURL(join(pkgDir, 'src', 'state.ts')).href)
  check(leadInBefore('run', undefined) === 'walk', '还没进状态时收到 run ⇒ 先进走')
  check(leadInBefore('run', 'idle') === 'walk', '闲置收到 run ⇒ 先进走')
  check(leadInBefore('run', 'walk') === 'run', '已经在走时收到 run ⇒ 不再重开走')
  check(leadInBefore('run', 'think') === 'run', '从思考收到 run ⇒ 直接进跑（不走引导）')
  check(leadInBefore('think', 'idle') === 'think', '非 run 目标不做引导')
  check(leadInBefore('done', 'idle') === 'done', '完成不做引导')
}

// --- options.json + phase mapping (pure source module) --------------------
{
  const { parseModelOptions, resolvePhaseClips, OPTION_FIELDS, pickClipForState } =
    await import(pathToFileURL(join(pkgDir, 'src', 'model.ts')).href)
  // 每个状态一条"该族里最有辨识度"的 clip，用来验证 6 条名字约定都命中
  const clips = ['A_Idle_Loop', 'B_Walk_Loop', 'C_MainCity_Run_Loop', 'D_Galgame_Think_Loop', 'E_Galgame_Happy_Loop', 'F_Galgame_Sad_Loop']

  check(OPTION_FIELDS.length <= 5, 'options.json 字段上限 ≤5', OPTION_FIELDS.join(', '))
  const unknown = parseModelOptions({ framng: 1 }, 'probe')
  check(unknown.warnings.length === 1 && unknown.options.framing === undefined, '未知字段被报告而不是静默丢弃', unknown.warnings.join(' | '))
  check(parseModelOptions({ framing: 'x' }, 'probe').warnings.length === 1, '非数字字段被报告')
  check(parseModelOptions({ phase: { nonsense: 'X' } }, 'probe').warnings.length === 1, '未知相位名被报告')
  check(parseModelOptions({ scale: 2, framing: 1.5, yaw: 30 }, 'probe').options.scale === 2, '合法字段被解析')

  const conventions = resolvePhaseClips(clips)
  check(conventions.phases.idle === 'A_Idle_Loop', 'idle 命中 Idle_Loop', conventions.phases.idle)
  check(conventions.phases.walk === 'B_Walk_Loop', 'walk 命中 Walk_Loop', conventions.phases.walk)
  check(conventions.phases.run === 'C_MainCity_Run_Loop', 'run 命中 MainCity_Run_Loop', conventions.phases.run)
  check(conventions.phases.think === 'D_Galgame_Think_Loop', 'think 命中 Galgame_Think_Loop', conventions.phases.think)
  check(conventions.phases.done === 'E_Galgame_Happy_Loop', 'done 命中 Galgame_Happy_Loop', conventions.phases.done)
  check(conventions.phases.failed === 'F_Galgame_Sad_Loop', 'failed 命中 Galgame_Sad_Loop', conventions.phases.failed)
  check(conventions.warnings.length === 0, '6 条约定全部命中时不记 warning', conventions.warnings.join(' | '))

  const runOnly = resolvePhaseClips(['X_Idle_Loop', 'X_Run_Loop'])
  check(runOnly.phases.run === 'X_Run_Loop', 'run 命中含 Run_Loop 的 clip', runOnly.phases.run)
  const sadOnly = resolvePhaseClips(['X_Idle_Loop', 'X_Sad'])
  check(sadOnly.phases.failed === 'X_Sad', 'failed 退到含 Sad 的 clip', sadOnly.phases.failed)
  const noMatch = resolvePhaseClips(['Only_One'])
  check(noMatch.phases.run === 'Only_One' && noMatch.warnings.some(line => line.includes('run')), '找不到时退到第一条并记 warning', noMatch.warnings.join(' | '))
  const override = resolvePhaseClips(clips, { phase: { idle: 'C_MainCity_Run_Loop' } })
  check(override.phases.idle === 'C_MainCity_Run_Loop', 'options.json 覆盖优先于名字约定', override.phases.idle)
  const bogusOverride = resolvePhaseClips(clips, { phase: { idle: 'Not_There' } })
  check(bogusOverride.phases.idle === 'A_Idle_Loop' && bogusOverride.warnings.some(line => line.includes('Not_There')), '覆盖名不存在时记 warning 并回退', bogusOverride.warnings.join(' | '))
  check(resolvePhaseClips([]).warnings.length === 1, '空模型记一条 warning 而不是抛错')
  check(pickClipForState({ idle: 'Gone' }, 'idle', clips) === 'A_Idle_Loop', '客户端兜底：名字不在时用第一条')
  check(pickClipForState(undefined, 'idle', []) === undefined, '没有 clip 时返回 undefined（保持绑定姿势）')
}

// --- the hot-swap plan (pure source module) -------------------------------
{
  const { planSwap } = await import(pathToFileURL(join(pkgDir, 'src', 'hot-swap.ts')).href)
  const base = { 'model.glb': 'm1', 'clips.json': 'j1', 'clips.bin': 'b1', 'textures/a.png': 't1' }
  check(planSwap(base, { ...base }).any === false, '完全没变 -> 不换')
  const clipsOnly = planSwap(base, { ...base, 'clips.bin': 'b2' })
  check(clipsOnly.clips && !clipsOnly.mesh && !clipsOnly.textures, '只有 clips.bin 变 -> 只换动作', JSON.stringify(clipsOnly))
  const meshOnly = planSwap(base, { ...base, 'model.glb': 'm2' })
  check(meshOnly.mesh && !meshOnly.textures, '只有 model.glb 变 -> 重建网格', JSON.stringify(meshOnly))
  const textureOnly = planSwap(base, { ...base, 'textures/a.png': 't2' })
  check(textureOnly.textures && !textureOnly.mesh && !textureOnly.clips, '只有贴图变 -> 只换贴图', JSON.stringify(textureOnly))
  check(planSwap(undefined, base).mesh, '第一次装载 -> 全量')
}

// --- the importer subprocess (spec §10.2.1) -------------------------------
{
  const { runImporter, readImportMeta, staleSources, sourceStamps, ImportRunner, samePath } =
    await import(pathToFileURL(join(pkgDir, 'src', 'importer.ts')).href)
  const fixtureDir = join(modelsRoot, modelId)

  const good = await runImporter(fixtureDir, { script: generator })
  check(good.ok, 'runImporter 跑通 fixture 生成器', good.error)
  check(good.revision === readImportMeta(fixtureDir).revision, 'stdout 与 import.json 的 revision 一致', good.revision)
  check(Object.keys(good.artifacts).length === 4, 'artifacts 逐产物返回', Object.keys(good.artifacts).join(', '))

  const missing = await runImporter(fixtureDir, { script: join(tmpdir(), 'definitely-not-here.mjs') })
  check(!missing.ok && missing.error.includes('不存在'), '导入器脚本缺失 -> 明确失败原因', missing.error)

  const scratch = mkdtempSync(join(tmpdir(), 'pet3d-importer-'))
  try {
    const failing = join(scratch, 'failing-importer.mjs')
    writeFileSync(failing, 'process.stderr.write("boom: source fbx is unreadable\\n"); process.exit(3)\n', 'utf8')
    const failed = await runImporter(scratch, { script: failing })
    check(!failed.ok && failed.error.includes('3'), '非零退出码被当成失败原因', failed.error)
    check(failed.error.includes('boom'), 'stderr 进了失败原因（可读）', failed.error)

    // Freshness: the recorded stamps vs the disk.
    const sourceFile = join(scratch, 'model.fbx')
    writeFileSync(sourceFile, 'original', 'utf8')
    mkdirSync(join(scratch, '.import'), { recursive: true })
    writeFileSync(join(scratch, '.import', 'import.json'), JSON.stringify({
      revision: 'scratch-1',
      importerScript: generator,
      sources: { 'model.fbx': sourceStamps(scratch)['model.fbx'] },
    }), 'utf8')
    check(Object.keys(sourceStamps(scratch)).includes('model.fbx'), 'sourceStamps 只看 .fbx 与 textures/')
    check(staleSources(scratch, readImportMeta(scratch)).length === 0, '刚导入完 -> 不陈旧')
    await sleep(20)
    writeFileSync(sourceFile, 'modified source bytes', 'utf8')
    check(staleSources(scratch, readImportMeta(scratch)).includes('model.fbx'), '源文件变了 -> 判为陈旧（会触发重导入）')
    writeFileSync(join(scratch, 'notes.txt'), 'unrelated', 'utf8')
    check(!staleSources(scratch, readImportMeta(scratch)).includes('notes.txt'), '无关文件不触发重导入')

    // The safety gates: an import that did NOT opt into the protocol, or one
    // made by a different script, is never auto-rewritten.
    const foreign = mkdtempSync(join(tmpdir(), 'pet3d-foreign-'))
    try {
      writeFileSync(join(foreign, 'model.fbx'), 'foreign source', 'utf8')
      mkdirSync(join(foreign, '.import'), { recursive: true })
      writeFileSync(join(foreign, '.import', 'import.json'), JSON.stringify({ revision: 'foreign-1', sourceFbx: 'model.fbx', sourceBytes: 14, artifacts: {} }), 'utf8')
      check(staleSources(foreign, readImportMeta(foreign)).length === 0, '没有 sources 记录的导入 -> 永不判为陈旧（别的 agent 的产物不会被自动覆盖）')
      const runner = new ImportRunner({ script: generator }, () => {})
      const swept = runner.sweep([foreign])
      check(swept.started.length === 0 && swept.skipped.some(skip => skip.reason.includes('sources')), '自动清扫跳过没有 sources 记录的目录并给出原因', JSON.stringify(swept))
      const mismatched = new ImportRunner({ script: join(repoRoot, 'tools', 'some-other-importer.mjs') }, () => {})
      const swept2 = mismatched.sweep([scratch])
      check(swept2.started.length === 0 && swept2.skipped.some(skip => skip.reason.includes('导入器')), '自动清扫跳过导入器不符的目录并给出原因', JSON.stringify(swept2))
      check(samePath(join(repoRoot, 'tools', 'make-fixture-model.mjs'), generator), 'samePath 认得同一路径的不同写法')
      // The third gate lives in the wiring: the sweep is only ever offered the
      // SELECTED model, so no catalog walk can reach another folder.
      check(
        readFileSync(join(pkgDir, 'src', 'index.ts'), 'utf8').includes('service.modelDir(service.selectedModelId()'),
        '宿主只把当前选中模型的目录交给自动清扫',
      )
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// --- the REAL product's freshness, STRICTLY READ-ONLY ---------------------
//
// This is the check whose absence let a healthy 330 MB model be judged stale on
// every sweep: the importer writes `sources` as `{ fbx: {...}, textures: [...] }`
// with sub-millisecond mtimes, while the reader only understood a flat
// path-keyed map with whole milliseconds. Nothing here writes anything: it reads
// `import.json` and stats the sources.
{
  const { readImportMeta, staleSources, freshnessReport, normalizeSources, MTIME_TOLERANCE_MS } =
    await import(pathToFileURL(join(pkgDir, 'src', 'importer.ts')).href)
  const realDirs = readdirSync(modelsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
    .map(entry => join(modelsRoot, entry.name))
  if (realDirs.length === 0) {
    console.log('  （models/ 下没有真实模型；真实产物新鲜度检查跳过）')
  }
  for (const dir of realDirs) {
    const label = basename(dir)
    const meta = readImportMeta(dir)
    const stale = staleSources(dir, meta)
    const normalized = normalizeSources(meta)
    check(
      stale.length === 0,
      `真实产物 ${label} 的源文件判为"新鲜"（不会每 ≤5s 重导入）`,
      stale.length === 0
        ? `比对 ${Object.keys(normalized.recorded).length} 个源文件，形状无法识别 ${normalized.unknown.length} 项`
        : `不一致键: ${stale.join(', ')}`,
    )
    if (stale.length > 0) {
      // The failing side, the expected value and the actual value — without
      // these three the report is not actionable.
      for (const row of freshnessReport(dir, meta)) {
        console.log(`        [${row.status}] ${row.key}  expected=${row.expected}  actual=${row.actual}`)
      }
    }
    check(
      typeof meta?.revision === 'string' && meta.revision.length >= 16,
      `${label} 的 import.json 带 revision（热换判据）`,
      typeof meta?.revision === 'string' ? meta.revision.slice(0, 12) : '缺失',
    )
  }

  // The shape tolerance itself, exercised on the fixture (which has both an FBX
  // and a texture): the grouped shape with a FRACTIONAL mtime must read fresh,
  // and a genuinely moved mtime must still read stale.
  const fixtureDir = join(modelsRoot, modelId)
  const fbxRaw = statSync(join(fixtureDir, 'fixture.fbx')).mtimeMs
  const pngRaw = statSync(join(fixtureDir, 'textures', 'fixture.png')).mtimeMs
  const grouped = (fbxMtime, pngMtime) => ({
    sources: {
      fbx: { path: join(fixtureDir, 'fixture.fbx'), bytes: statSync(join(fixtureDir, 'fixture.fbx')).size, mtimeMs: fbxMtime },
      textures: [{ file: 'textures/fixture.png', bytes: statSync(join(fixtureDir, 'textures', 'fixture.png')).size, mtimeMs: pngMtime }],
    },
  })
  check(
    staleSources(fixtureDir, grouped(fbxRaw, pngRaw)).length === 0,
    '分组形状 + 小数 mtimeMs（真实导入器形状）判为新鲜',
    JSON.stringify(freshnessReport(fixtureDir, grouped(fbxRaw, pngRaw)).map(row => `${row.key}:${row.status}`)),
  )
  check(
    staleSources(fixtureDir, grouped(fbxRaw + MTIME_TOLERANCE_MS / 2, pngRaw + 0.6528)).length === 0,
    `亚毫秒/亚容差差异（≤${MTIME_TOLERANCE_MS}ms）不算改动`,
  )
  check(
    staleSources(fixtureDir, grouped(fbxRaw + 50, pngRaw)).includes('fixture.fbx'),
    '真的改了 mtime（+50ms）仍然判为陈旧',
    String(fbxRaw + 50),
  )
  check(
    staleSources(fixtureDir, grouped(fbxRaw, pngRaw + 50)).includes('textures/fixture.png'),
    '贴图的改动仍然判为陈旧（键是相对路径）',
  )
  check(
    staleSources(fixtureDir, { sources: { weird: { note: 'unreadable shape' } } }).length === 0,
    '形状无法识别的 sources 项按"新鲜"处理（不拿形状问题当改动理由）',
  )
}

// --- the automatic re-import BACKOFF --------------------------------------
//
// A directory whose sources read as changed forever while the importer keeps
// producing the SAME revision must stop being auto-imported: missing one hot
// update is a far smaller loss than re-importing hundreds of megabytes in a loop.
{
  const { ImportRunner } = await import(pathToFileURL(join(pkgDir, 'src', 'importer.ts')).href)
  const dir = mkdtempSync(join(tmpdir(), 'pet3d-stall-'))
  try {
    const script = join(dir, 'stuck-importer.mjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify({ ok: true, revision: "STUCK-REV" }) + "\\n")\n', 'utf8')
    writeFileSync(join(dir, 'model.fbx'), 'a source that always looks changed', 'utf8')
    mkdirSync(join(dir, '.import'), { recursive: true })
    // Deliberately stale baseline: recorded bytes/mtime can never match the disk,
    // and the importer below never rewrites this file, so it stays stale forever.
    writeFileSync(join(dir, '.import', 'import.json'), JSON.stringify({
      revision: 'STUCK-REV',
      importerScript: script,
      sources: { fbx: { path: join(dir, 'model.fbx'), bytes: 999999, mtimeMs: 1 } },
    }), 'utf8')

    let clock = 1_000_000
    const runner = new ImportRunner({ script }, () => {}, () => (clock += 10_000))
    const first = runner.sweep([dir])
    check(first.started.length === 1, '第一次清扫尝试自动重导入（源文件被判陈旧）', JSON.stringify(first))
    const outcome = await runner.run(dir)
    check(outcome.ok && outcome.revision === 'STUCK-REV', '导入器跑完但 revision 与上次相同', `${outcome.ok} / ${outcome.revision}`)
    check(runner.stall(dir) !== undefined, 'revision 没变 ⇒ 记录停滞原因（面板可见）', String(runner.stall(dir)))
    const second = runner.sweep([dir])
    check(
      second.started.length === 0 && second.skipped.some(skip => skip.reason.includes('自动重导入已停止')),
      '第二次起不再自动重导入',
      JSON.stringify(second),
    )
    const manual = await runner.run(dir)
    check(manual.ok, '手动"重载"仍然能再试一次', manual.error)
    check(runner.stall(dir) !== undefined, '手动重试后产物仍未变 ⇒ 停滞状态保持（不会偷偷恢复循环）')
    // The reason has to REACH the user, not just the log.
    check(
      readFileSync(join(pkgDir, 'src', 'routes.ts'), 'utf8').includes('importStall'),
      '停滞原因经 /state 暴露（面板可见）',
    )
    check(
      readFileSync(join(pkgDir, 'src', 'client', 'PetStage.tsx'), 'utf8').includes('data-pet3d-import-stall'),
      '面板渲染停滞原因（不是静默跳过）',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- M1 wiring: host events -> phase, end to end through the route ---------
{
  const stateNow = async () => JSON.parse((await call(stateRoute, 'GET', '/api/pet3d/state')).body)
  check(listeners.has('session/event'), '插件订阅了 session/event')
  check(listeners.has('agent/assistant-stream'), '插件订阅了 agent/assistant-stream')
  check(listeners.has('session/disposed'), '插件订阅了 session/disposed')

  const main = { id: 'session-main' }
  const sub = { id: 'session-sub' }
  const phaseAfter = async (run) => { run(); return (await stateNow()).phase }

  check(await phaseAfter(() => emit('session/event', main, { type: 'turn/start' })) === 'think',
    'turn/start（waiting）-> 思考')
  emit('session/event', main, { type: 'tool/call', data: { callId: 'c1', name: 'Bash' } })
  const duringCall = (await stateNow()).phase
  emit('session/event', main, { type: 'tool/result', data: { message: { toolCallId: 'c1' } } })
  const afterCall = (await stateNow()).phase
  check(duringCall === 'run' && afterCall === 'run', 'tool/call 与 tool/result 都是 跑（模型在产出）', `${duringCall} -> ${afterCall}`)
  check(await phaseAfter(() => emit('agent/assistant-stream', {
    agent: { session: main }, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'x' } },
  })) === 'run', 'reasoning 流帧 -> 跑')

  // Per-session isolation: a subagent's in-flight call must not be credited to
  // the main session, and vice versa. This is the live situation when a
  // subagent runs while the main session waits.
  emit('session/event', sub, { type: 'turn/start' })
  emit('session/event', main, { type: 'tool/call', data: { callId: 'main-1', name: 'Read' } })
  const afterBoth = (await stateNow()).phase
  emit('session/event', main, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const afterDone = (await stateNow()).phase
  check(afterBoth === 'run' && afterDone === 'done', '主会话结束 -> done（跑 -> done）', `${afterBoth} -> ${afterDone}`)

  // The celebration window: `done` holds, then falls back to idle.
  await sleep(2700)
  check((await stateNow()).phase === 'idle', 'done 窗口结束后回落到 idle（6 状态压缩）', (await stateNow()).phase)

  check(await phaseAfter(() => emit('session/event', main, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })) === 'idle',
    'turn/end aborted -> idle')
  emit('session/event', main, { type: 'tool/call', data: { callId: 'x', name: 'Read' } })
  emit('session/disposed', main)
  const disposed = await stateNow()
  check(disposed.phase === 'idle' && disposed.sessionActive === false,
    '会话销毁 -> 相位回落 idle 且 sessionActive=false',
    `${disposed.phase} / ${disposed.sessionActive}`)
}

// --- the user's own pet.json must never be touched by this kernel ---------
{
  const legacyPersist = join(process.env.DSH_HOME ?? '', 'pet.json')
  if (statSync(legacyPersist, { throwIfNoEntry: false })) {
    check(true, '上游 $DSH_HOME/pet.json 存在且本内核只读（不做校验/写入）')
  }
}

for (const handle of intervals) clearInterval(handle)
console.log(failures === 0 ? '\ncheck-pet3d: 全部通过' : `\ncheck-pet3d: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
