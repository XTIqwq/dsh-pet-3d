/**
 * Offline proof of the hot-fix / hot-update chain (spec §10.4), four steps:
 *
 *   1. boot the fixture model → record revision and the resource counters;
 *   2. change the SOURCE so only `clips.bin` differs → the host's freshness
 *      sweep re-imports by itself → the client swaps the ACTIONS and leaves the
 *      mesh alone;
 *   3. change the source again so `model.glb` differs → the mesh is rebuilt and
 *      position / size / camera do not move;
 *   4. 20 swaps in a row → print the geometry / texture counters before and
 *      after and fail if anything grew.
 *
 * The REAL client renderer runs here (imported as source, types stripped), with
 * three seams injected:
 *   - three.js itself, straight from the workspace (the vendor bundle's source);
 *   - a counting `WebGLRenderer` double whose `info.memory` reports the
 *     geometries / textures our code created and has NOT disposed — the exact
 *     quantity the leak check is about, and the same number a real WebGL
 *     context reports;
 *   - an `fs`-backed clip IO, so no HTTP server is needed.
 * The host half is the BUILT plugin, driven through its real routes, and its
 * importer subprocess is the fixture generator.
 *
 * Usage: node tools/check-pet3d-hotswap.mjs
 * Exit code 0 = every check passed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Writable } from 'node:stream'
import * as THREE from 'three'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const pkgDir = join(repoRoot, 'packages', 'dsh-pet-3d')
const modelsRoot = join(process.env.DSH_HOME ?? 'D:\\.dsh', 'models')
const modelDir = join(modelsRoot, '_fixture')
const imports = join(modelDir, '.import')
const generator = join(repoRoot, 'tools', 'make-fixture-model.mjs')

// Read the freshness window from the source of truth rather than hardcoding it:
// this guard has to move a file's mtime PAST that window to look like a real edit.
const { MTIME_TOLERANCE_MS } = await import(pathToFileURL(join(pkgDir, 'src', 'importer.ts')).href)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// --- 1. the fixture, at variant A ----------------------------------------
function writeSource(variant) {
  const file = join(modelDir, 'fixture.fbx')
  writeFileSync(file, `fixture-source variant=${variant} rev=${Date.now()}\n`, 'utf8')
  // The freshness window is SECONDS wide (MTIME_TOLERANCE_MS = 2000) because a
  // copied or unzipped model always drifts by tens of milliseconds, and treating
  // that as a change is what made every distributed model re-import forever.
  // A test that edits a file twice inside the same second therefore has to move
  // the mtime past that window — otherwise it is asserting that two writes in
  // the same second look different, which is not what the product promises.
  // `utimesSync` is how a real edit seconds apart looks to the sweep.
  const future = new Date(Date.now() + MTIME_TOLERANCE_MS + 1000)
  utimesSync(file, future, future)
}
function ensureFixture(variant) {
  const result = spawnSync(process.execPath, [generator, modelDir, '--json', '--variant', variant], {
    encoding: 'utf8', cwd: repoRoot,
  })
  if (result.status !== 0) {
    console.error('  无法生成 fixture：', result.stderr || result.stdout)
    process.exit(1)
  }
  return JSON.parse(result.stdout)
}

// --- 2. counting resource doubles ----------------------------------------
const live = { geometries: 0, textures: 0, materials: 0 }
const totals = { geometries: 0, textures: 0, materials: 0, disposed: { geometries: 0, textures: 0, materials: 0 } }

class CountingGeometry extends THREE.BufferGeometry {
  dispose() {
    if (this.__gone !== true) {
      this.__gone = true
      live.geometries -= 1
      totals.disposed.geometries += 1
    }
    super.dispose()
  }
}
class CountingTexture extends THREE.Texture {
  dispose() {
    if (this.__gone !== true) {
      this.__gone = true
      live.textures -= 1
      totals.disposed.textures += 1
    }
    super.dispose()
  }
}
class CountingToonMaterial extends THREE.MeshToonMaterial {
  constructor(parameters) {
    super(parameters)
    created('materials')
  }
  dispose() {
    if (this.__gone !== true) {
      this.__gone = true
      live.materials -= 1
      totals.disposed.materials += 1
    }
    super.dispose()
  }
}
class CountingBasicMaterial extends THREE.MeshBasicMaterial {
  constructor(parameters) {
    super(parameters)
    created('materials')
  }
  dispose() {
    if (this.__gone !== true) {
      this.__gone = true
      live.materials -= 1
      totals.disposed.materials += 1
    }
    super.dispose()
  }
}

const created = (kind) => {
  live[kind] += 1
  totals[kind] += 1
}

/** Parses the fixture's GLB (header + JSON chunk + BIN chunk). */
function parseGlb(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb')
  let offset = 12
  let json
  let bin
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset)
    const type = bytes.readUInt32LE(offset + 4)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'))
    if (type === 0x004e4942) bin = body
    offset += 8 + length
  }
  return { json, bin }
}

/** Reads one glTF accessor out of the fixture's BIN chunk. */
function accessor(json, bin, at) {
  const acc = json.accessors[at]
  const view = json.bufferViews[acc.bufferView]
  const start = bin.byteOffset + (view.byteOffset ?? 0)
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type]
  if (acc.componentType === 5126) return { array: new Float32Array(bin.buffer, start, acc.count * components), components }
  if (acc.componentType === 5123) return { array: new Uint16Array(bin.buffer, start, acc.count * components), components }
  throw new Error(`fixture accessor ${at}: 不支持的 componentType ${acc.componentType}`)
}

/** Builds a REAL three scene graph from the fixture's glTF JSON. */
function buildScene(json, bin) {
  const nodes = json.nodes.map((def) => {
    if (def.mesh === undefined) {
      const group = new THREE.Group()
      group.name = def.name ?? ''
      return group
    }
    const primitive = json.meshes[def.mesh].primitives[0]
    const geometry = new CountingGeometry()
    created('geometries')
    const position = accessor(json, bin, primitive.attributes.POSITION)
    geometry.setAttribute('position', new THREE.BufferAttribute(position.array, position.components))
    const normal = accessor(json, bin, primitive.attributes.NORMAL)
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal.array, normal.components))
    const uv = accessor(json, bin, primitive.attributes.TEXCOORD_0)
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv.array, uv.components))
    const indices = accessor(json, bin, primitive.indices)
    geometry.setIndex(new THREE.BufferAttribute(indices.array, 1))
    const material = new CountingBasicMaterial()
    material.name = json.materials[primitive.material]?.name ?? ''
    const textureIndex = json.materials[primitive.material]?.pbrMetallicRoughness?.baseColorTexture?.index
    if (textureIndex !== undefined) {
      const uri = json.images[json.textures[textureIndex].source]?.uri ?? ''
      const texture = new CountingTexture()
      created('textures')
      texture.image = { width: 1, height: 1, src: uri }
      texture.name = uri
      material.map = texture
    }
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = def.name ?? ''
    return mesh
  })
  json.nodes.forEach((def, at) => {
    for (const child of def.children ?? []) nodes[at].add(nodes[child])
  })
  const sceneIndex = json.scenes?.[json.scene ?? 0]?.nodes?.[0] ?? 0
  return nodes[sceneIndex]
}

/** The GLTFLoader double: real scene, counted resources, counted loads. */
const loads = { count: 0, urls: [] }
class FakeGLTFLoader {
  setCrossOrigin() { return this }
  register() { return this }
  async loadAsync(url) {
    loads.count += 1
    loads.urls.push(String(url))
    const path = localPathOf(url)
    const bytes = readFileSync(path)
    const { json, bin } = parseGlb(bytes)
    return { scene: buildScene(json, bin), scenes: [], animations: [], userData: {}, parser: { json } }
  }
}

/** The WebGLRenderer double: `info.memory` is the live-object count. */
const renders = { frames: 0, geometries: 0, textures: 0 }
/** The scene of the last frame, so the test can inspect the LIVE mesh. */
let renderedScene = null
class FakeRenderer {
  constructor() {
    this.domElement = new FakeElement('canvas')
    this.info = {
      memory: {
        get geometries() { return live.geometries },
        get textures() { return live.textures },
      },
    }
  }
  setSize() {}
  setPixelRatio() {}
  setClearColor() {}
  render(scene) {
    renders.frames += 1
    renderedScene = scene
    const geometries = new Set()
    const textures = new Set()
    scene.traverse((child) => {
      if (child.geometry !== undefined) geometries.add(child.geometry)
      const materials = Array.isArray(child.material) ? child.material : (child.material === undefined ? [] : [child.material])
      for (const material of materials) if (material.map !== undefined) textures.add(material.map)
    })
    renders.geometries = geometries.size
    renders.textures = textures.size
  }
  dispose() { this.disposed = true }
}

// --- 3. the DOM surface the renderer touches -------------------------------
class FakeElement {
  constructor(tag) {
    this.tagName = tag
    this.style = {}
    this.children = []
    this.parentNode = null
    this.clientWidth = 348
    this.clientHeight = 348
  }
  appendChild(child) {
    this.children.push(child)
    child.parentNode = this
    return child
  }
  removeChild(child) {
    const at = this.children.indexOf(child)
    if (at >= 0) this.children.splice(at, 1)
    child.parentNode = null
    return child
  }
  getBoundingClientRect() {
    return { width: this.clientWidth, height: this.clientHeight, top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight }
  }
  setAttribute() {}
  /** 加载遮罩/转圈用到的 `el.append(...)`（多参数，和 DOM 的 append 一样）。 */
  append(...children) {
    for (const child of children) this.appendChild(child)
  }
  /** 遮罩淡出后 `el.remove()`。 */
  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this)
  }
}

globalThis.window = globalThis
globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  createElement: (tag) => new FakeElement(tag),
  /** 加载遮罩的转圈 keyframes 用 `getElementById` 判"注入过没有"。 */
  getElementById: () => null,
  createTextNode: (text) => ({ nodeType: 3, textContent: text }),
  head: new FakeElement('head'),
  addEventListener() {},
  removeEventListener() {},
}
globalThis.devicePixelRatio = 2
let rafId = 0
const rafTimers = new Map()
globalThis.requestAnimationFrame = (callback) => {
  const id = ++rafId
  rafTimers.set(id, setTimeout(() => { rafTimers.delete(id); callback(performance.now()) }, 16))
  return id
}
globalThis.cancelAnimationFrame = (id) => {
  const timer = rafTimers.get(id)
  if (timer !== undefined) { clearTimeout(timer); rafTimers.delete(id) }
}
globalThis.IntersectionObserver = class { observe() {} disconnect() {} }
globalThis.ResizeObserver = class { observe() {} disconnect() {} }

/** A served URL (`/pet3d/_fixture/...`) back to a file on disk. */
function localPathOf(url) {
  const pathname = new URL(String(url), 'http://pet.local').pathname
  const relative = pathname.replace(`/pet3d/_fixture/`, '').split('/').join(sep)
  return join(modelDir, relative)
}

// --- 4. the host half ------------------------------------------------------
class FakeRes extends Writable {
  constructor() {
    super()
    this.chunks = []
    this.statusCode = 0
    this.headers = {}
  }
  _write(chunk, _encoding, callback) { this.chunks.push(chunk); callback() }
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this }
  get body() { return Buffer.concat(this.chunks).toString('utf8') }
}

const routes = []
const ctx = {
  effect(fn) {
    const disposer = fn()
    return () => { if (typeof disposer === 'function') disposer() }
  },
  on() { return () => {} },
  get() { return undefined },
  webServer: { register(route) { routes.push(route); return () => {} } },
}

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
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk },
  }
  await route.handler(req, res)
  await Promise.race([finished, sleep(30000)])
  return res
}

const stateRoute = () => {
  const route = routes.find(candidate => candidate.path === '/api/pet3d/state')
  return call(route, 'GET', '/api/pet3d/state').then(res => JSON.parse(res.body))
}

async function reimport() {
  const route = routes.find(candidate => candidate.path === '/api/pet3d/reimport')
  const res = await call(route, 'POST', '/api/pet3d/reimport', { modelId: '_fixture' })
  const data = JSON.parse(res.body)
  if (res.statusCode !== 200) throw new Error(`reimport failed: ${res.statusCode} ${JSON.stringify(data)}`)
  return data
}

// --- run ------------------------------------------------------------------
ensureFixture('A')

const entry = join(pkgDir, 'lib', 'index.js')
if (!existsSync(entry)) {
  console.error('构建产物不存在，先跑一次 tsdown')
  process.exit(1)
}
const host = await import(pathToFileURL(entry).href)
host.apply(ctx, {
  visible: true,
  size: 348,
  right: 24,
  bottom: 20,
  petId: '_fixture',
  importerScript: generator,
})
check(routes.some(route => route.path === '/api/pet3d/reimport'), '宿主注册了 POST /api/pet3d/reimport')

const rendererModule = await import(pathToFileURL(join(pkgDir, 'src', 'client', 'renderers', 'model3d.ts')).href)
const { mountModel3d } = rendererModule

const container = new FakeElement('div')
const snapshot0 = await stateRoute()
const view0 = snapshot0.model.model3d
console.log(`check-pet3d-hotswap: fixture ${modelDir}`)
console.log(`  宿主 revision ${snapshot0.modelRevision}  ·  view.revision ${view0.revision}  ·  clip 数 ${view0.clipCount}`)
check(snapshot0.model.id === '_fixture', '选中了 fixture 模型', String(snapshot0.model.id))
check(snapshot0.modelRevision === view0.revision, '/state 的 modelRevision 与 view.revision 一致')
check(view0.revision.length >= 8, 'modelRevision 有内容（来自 import.json.revision）', view0.revision)

const vendor = {
  Scene: THREE.Scene,
  PerspectiveCamera: THREE.PerspectiveCamera,
  WebGLRenderer: FakeRenderer,
  Group: THREE.Group,
  AnimationMixer: THREE.AnimationMixer,
  AnimationClip: THREE.AnimationClip,
  QuaternionKeyframeTrack: THREE.QuaternionKeyframeTrack,
  VectorKeyframeTrack: THREE.VectorKeyframeTrack,
  NumberKeyframeTrack: THREE.NumberKeyframeTrack,
  Box3: THREE.Box3,
  Vector3: THREE.Vector3,
  Color: THREE.Color,
  MeshToonMaterial: CountingToonMaterial,
  MeshBasicMaterial: CountingBasicMaterial,
  Mesh: THREE.Mesh,
  SkinnedMesh: THREE.SkinnedMesh,
  AmbientLight: THREE.AmbientLight,
  DirectionalLight: THREE.DirectionalLight,
  HemisphereLight: THREE.HemisphereLight,
  Clock: THREE.Clock,
  LoopOnce: THREE.LoopOnce,
  LoopRepeat: THREE.LoopRepeat,
  SRGBColorSpace: THREE.SRGBColorSpace,
  BackSide: THREE.BackSide,
  FrontSide: THREE.FrontSide,
  DoubleSide: THREE.DoubleSide,
  GLTFLoader: FakeGLTFLoader,
  VRMLoaderPlugin: class {},
  VRMUtils: {},
}

const phaseModule = await import(pathToFileURL(join(pkgDir, 'src', 'client', 'phase-stream.ts')).href)
const io = {
  async fetchJson(url) { return JSON.parse(readFileSync(localPathOf(url), 'utf8')) },
  async fetchPayload(url) {
    const bytes = readFileSync(localPathOf(url))
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  },
}

const handle = mountModel3d({
  container,
  view: view0,
  phase: phaseModule.createPhaseStream('idle'),
  vendor: () => Promise.resolve(vendor),
  io,
})

// STEP 1 — boot and record.
async function waitFor(label, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  check(false, label, `等超时（${timeoutMs}ms）`)
  return false
}

await waitFor('模型 + 动作装载完成', () => handle.clipsReady())
check(handle.stage() === 'ready', 'STEP 1 阶段 ready', handle.stageDetail())
check(handle.clipNames().length === 2, 'STEP 1 动作清单 2 条', handle.clipNames().join(', '))
await sleep(300)

// The panel's instrument. The browser guard reads these exact fields off
// `[data-pet3d-debug]`; asserting them here keeps the contract from quietly
// changing shape between the two.
{
  const fieldsOf = (line) => {
    const fields = {}
    for (const part of line.split(' ')) {
      const eq = part.indexOf('=')
      if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1)
    }
    return fields
  }
  const fields = fieldsOf(handle.debug())
  const required = ['clips', 'cur', 'os', 'mt', 'ph', 'mplay', 'fr', 'err', 'wd']
  check(required.every(name => fields[name] !== undefined), '仪表字段齐全（clips/cur/os/mt/ph/mplay/fr/err/wd）',
    required.filter(name => fields[name] === undefined).join(', '))
  check(Number(fields.clips) === 2, 'clips= 是已注册 clip 数', fields.clips)
  check(['idle', 'walk', 'run', 'think', 'done', 'failed'].includes(fields.ph), 'ph= 是 6 状态之一', fields.ph)
  check(Number.isFinite(Number(fields.fr)) && Number(fields.fr) > 0, 'fr= 帧数在推进', fields.fr)
  check(Number.isFinite(Number(fields.mt)), 'mt= mixer 时钟可读', fields.mt)
  check(fields.os === '0' || fields.os === '1', 'os= 是一名一次性动作标志', fields.os)
  check(Number.isFinite(Number(fields.wd)), 'wd= 是循环重启计数（可判定）', fields.wd)
  check(fields.mplay === '-', 'mplay= 只有面板请求才写（此刻面板没点过）', fields.mplay)
  check(handle.playNamed(handle.clipNames()[0], false), '播一次能成功', handle.clipNames()[0])
  await sleep(50)
  const afterPlay = fieldsOf(handle.debug())
  check(afterPlay.mplay === handle.clipNames()[0] && afterPlay.os === '1',
    '播一次后 mplay= 记下这次请求、os=1', `${afterPlay.mplay} / os=${afterPlay.os}`)
  handle.clearManual()
}

/** The live mesh node, read off the last rendered scene. */
const armOf = () => renderedScene?.getObjectByName('FixtureArm')

/** The VIEW part of a camera reading (the derived distance is not a view). */
const viewOf = (camera) => ({ yaw: camera.yaw, pitch: camera.pitch, framing: camera.framing })

const camera0 = handle.camera()
const geom0 = armOf()?.geometry
const map0 = armOf()?.material?.map
const mem0 = handle.memory()
console.log(`  STEP 1  revision=${handle.loadedRevision()}  geometries=${mem0.geometries} textures=${mem0.textures}`
  + `  referenced g=${renders.geometries} t=${renders.textures}  glbLoads=${loads.count}`)
check(mem0.geometries >= 1 && mem0.textures >= 1, 'STEP 1 计数非零（真的有资源被创建）', `g=${mem0.geometries} t=${mem0.textures}`)
check(geom0 !== undefined, 'STEP 1 场景里能找到 FixtureArm 网格')

// STEP 2 — a source change that only moves clips.bin, picked up AUTOMATICALLY.
{
  const beforeRevision = (await stateRoute()).modelRevision
  writeSource('B')
  const deadline = Date.now() + 12000
  let now = beforeRevision
  while (Date.now() < deadline) {
    await sleep(500)
    now = (await stateRoute()).modelRevision
    if (now !== beforeRevision) break
  }
  check(now !== beforeRevision, 'STEP 2 源文件改动后宿主自动重导入（≤5s 扫描 + 导入）', `${beforeRevision} -> ${now}`)
  const view = (await stateRoute()).model.model3d
  const kind = await handle.update(view)
  check(kind === 'clips', 'STEP 2 热换类型 = clips（只换动作）', kind)
  check(loads.count === 1, 'STEP 2 网格没有被重新加载（glb 只读过 1 次）', String(loads.count))
  check(armOf()?.geometry === geom0, 'STEP 2 网格对象是同一个（未重建）')
  check(armOf()?.material?.map === map0, 'STEP 2 贴图对象是同一个（未重载）')
  await sleep(400)
  const pose = armOf()?.quaternion
  // Variant B holds a constant 45° rotation on Z (the payload's [x,y,z,w]).
  const swing = pose === undefined ? 0 : Math.hypot(pose.y, pose.z)
  check(swing > 0.3, 'STEP 2 新动作真的在驱动骨架（B 变体 45°）', `${pose?.x},${pose?.y},${pose?.z},${pose?.w}`)
  check(JSON.stringify(viewOf(handle.camera())) === JSON.stringify(viewOf(camera0)), 'STEP 2 视角未变（yaw/pitch/framing）')
}

// STEP 3 — a source change that moves model.glb.
{
  writeSource('C')
  const res = await reimport()
  const view = (await stateRoute()).model.model3d
  const kind = await handle.update(view)
  check(kind === 'mesh', 'STEP 3 热换类型 = mesh（重建网格）', kind)
  check(loads.count === 2, 'STEP 3 glb 被重新加载一次', String(loads.count))
  check(armOf()?.geometry !== geom0, 'STEP 3 网格对象换了新的')
  const camera3 = handle.camera()
  check(
    JSON.stringify(viewOf(camera3)) === JSON.stringify(viewOf(camera0)),
    'STEP 3 视角未变（yaw/pitch/framing；相机距离随新包围盒重算）',
    `${JSON.stringify(viewOf(camera3))} 位置 ${camera3.position.x.toFixed(3)},${camera3.position.y.toFixed(3)},${camera3.position.z.toFixed(3)}`,
  )
  check(container.clientWidth === 348 && container.clientHeight === 348, 'STEP 3 宠物位置 / 尺寸未变（容器与 display 都不动）')
  check(res.revision === view.revision, 'STEP 3 /reimport 返回的 revision 与 /state 一致', String(res.revision))
  await sleep(300)
}

// STEP 3b — a source change that moves ONLY the texture.
{
  // Back to A first (its glTF is byte-identical to T's, so the next swap is
  // forced to be a texture-only change rather than a mesh rebuild).
  writeSource('A')
  await reimport()
  const viewA = (await stateRoute()).model.model3d
  const kindA = await handle.update(viewA)
  check(kindA === 'mesh', 'STEP 3b 回到 A（mesh 热换）', kindA)
  const geomA = armOf()?.geometry
  const mapA = armOf()?.material?.map
  const loadsA = loads.count

  writeSource('T')
  await reimport()
  const viewT = (await stateRoute()).model.model3d
  const kindT = await handle.update(viewT)
  check(kindT === 'textures', 'STEP 3b 热换类型 = textures（只换贴图）', kindT)
  check(armOf()?.geometry === geomA, 'STEP 3b 几何没换')
  check(armOf()?.material?.map !== mapA, 'STEP 3b 贴图对象换成新的')
  check(loads.count === loadsA + 1, 'STEP 3b 只为贴图重解析了一次 glb', `${loadsA} -> ${loads.count}`)
  check(JSON.stringify(viewOf(handle.camera())) === JSON.stringify(viewOf(camera0)), 'STEP 3b 视角未变')
  await sleep(200)
}

// STEP 4 — repeated swaps, no monotonic growth.
{
  const before = handle.memory()
  const beforeReferenced = { geometries: renders.geometries, textures: renders.textures }
  console.log(`  STEP 4 热换前  geometries=${before.geometries} textures=${before.textures}`
    + `  referenced g=${beforeReferenced.geometries} t=${beforeReferenced.textures}`)

  /** One round trip: change the source, re-import, let the client swap. */
  const swapRound = async (variant) => {
    writeSource(variant)
    await reimport()
    const view = (await stateRoute()).model.model3d
    return handle.update(view)
  }

  // A ↔ B differ only in clips.bin: the common hot-fix path, run 20 times.
  const clipTrace = []
  for (let i = 0; i < 20; i++) {
    const kind = await swapRound(i % 2 === 0 ? 'B' : 'A')
    if (i % 5 === 0 || i === 19) {
      const mem = handle.memory()
      clipTrace.push(`${i + 1}:${kind} g=${mem.geometries} t=${mem.textures}`)
    }
  }
  // A ↔ C differ in model.glb too: the mesh path, run 5 times.
  const meshTrace = []
  for (let i = 0; i < 5; i++) {
    const kind = await swapRound(i % 2 === 0 ? 'C' : 'A')
    const mem = handle.memory()
    meshTrace.push(`${i + 1}:${kind} g=${mem.geometries} t=${mem.textures}`)
  }
  await sleep(300)

  const after = handle.memory()
  console.log(`  STEP 4 热换后  geometries=${after.geometries} textures=${after.textures}`
    + `  referenced g=${renders.geometries} t=${renders.textures}`)
  console.log(`  STEP 4 动作热换轨迹  ${clipTrace.join('  ')}`)
  console.log(`  STEP 4 网格热换轨迹  ${meshTrace.join('  ')}`)
  console.log(`  STEP 4 创建/销毁  created g=${totals.geometries} t=${totals.textures} m=${totals.materials}`
    + `  disposed g=${totals.disposed.geometries} t=${totals.disposed.textures} m=${totals.disposed.materials}`)
  check(after.geometries <= before.geometries, 'STEP 4 geometry 计数没有增长', `${before.geometries} -> ${after.geometries}`)
  check(after.textures <= before.textures, 'STEP 4 texture 计数没有增长', `${before.textures} -> ${after.textures}`)
  check(
    renders.geometries <= beforeReferenced.geometries && renders.textures <= beforeReferenced.textures,
    'STEP 4 场景里引用的资源也没增长（旧世代都摘掉了）',
    `g ${beforeReferenced.geometries}->${renders.geometries}, t ${beforeReferenced.textures}->${renders.textures}`,
  )
  check(totals.disposed.geometries >= 6, 'STEP 4 每次网格热换都真的 dispose 了旧几何', String(totals.disposed.geometries))
  check(totals.disposed.materials >= 11, 'STEP 4 材质也逐次释放', String(totals.disposed.materials))
  check(handle.swapError() === undefined, 'STEP 4 25 次热换没有失败', String(handle.swapError()))
}

// --- teardown --------------------------------------------------------------
handle.dispose()
await sleep(200)
console.log(`  释放后  geometries=${live.geometries} textures=${live.textures} materials=${live.materials}`)
check(live.geometries === 0 && live.textures === 0, 'dispose 之后没有残留几何 / 贴图', `g=${live.geometries} t=${live.textures}`)

console.log(`\ncheck-pet3d-hotswap: ${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
