/**
 * 工作流 A —— 桌宠模型导入器（全保真）
 *
 * 把 <model-dir>/ 下的源 FBX 变成 .import/ 下的四个文件：
 *   model.glb    全保真网格（8 网格 / 129 关节 / 29 形态键）+ 贴图外部引用
 *   clips.json   155 条 clip 的轨道索引
 *   clips.bin    float32 顺序拼接的 times + values（逐元素复制，不插值、不重采样）
 *   import.json  溯源 + 自证结果
 *
 * 自证：写出的 clips.bin 与 FBXLoader 内存里的 Float32Array 逐条 clip、逐条轨道
 * 逐元素 `===` 比对；model.glb 的每个顶点属性访问器也与内存原值逐元素比对。
 * 任何一处不等就非零退出。
 *
 * Usage:
 *   node --max-old-space-size=12288 tools/pet3d-import.mjs <model-dir> [--json]
 *     [--source <file.fbx>]      默认取 model-dir 下唯一的 .fbx
 *     [--force]                  忽略幂等检查，重新导入
 *     [--animations-in-glb]      额外把 155 条 clip 也写进 model.glb（默认不写，动作走 clips.bin）
 *     [--uv-keep]                不做 v'=1-v 换基：给"V 已经是 glTF 那一套"的资产用（见 UV_KEEP 注释）
 *     [--skip-node <名字>]       从场景里剔掉同名节点（可重复）；用于剔除导出时混进来的隐藏变体
 *     [--json]                   宿主子进程模式：stdout 只吐一个 JSON 对象，人看的走 stderr
 *
 * 数据驱动：模型名、骨骼名、clip 名、贴图名一律从源文件里读，代码里不写死任何模型。
 * 结构：逐网格复制的骨架副本会被折成唯一一份（折叠前证明各副本姿态逐元素相同）。
 * 新鲜度：import.json.sources 与宿主的 sourceStamps/staleSources 逐字同构，自证 0 条 stale。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 自带 three + 容错版 FBXLoader + GLTFExporter（tools/vendor/three-node.mjs）：
// 导入器是独立 Node 进程，必须能在**没有任何 npm 依赖**的安装形态下运行
// （`link:` 安装时 pnpm 不装依赖）。这份 bundle 用 tools/node_modules/three
// 0.171.0 + patch-fbxloader 生成的容错 loader 打成，和产出模型的版本一致。
// 重新生成：node tools/build-three-node.mjs
import { THREE, FBXLoader, GLTFExporter } from './vendor/three-node.mjs'

globalThis.self = globalThis

/** 产物格式版本；改了 `.import/` 的格式就要 +1（进 revision）。
 * v2：UV 的 V 轴按 glTF 约定换基（v' = 1 - v）。v1 的产物把 FBX 的 V 原样塞进 glTF 容器，
 *     两边的图像朝向约定相反 ⇒ 屏幕上贴图上下镜像（实测：脸的五官落到须/发区域）。 */
const IMPORTER_VERSION = 5

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2)
const BOOLEAN_FLAGS = new Set(['--json', '--force', '--animations-in-glb', '--keep-root-motion', '--tangents', '--uv-keep'])
const JSON_MODE = argv.includes('--json')
/**
 * 要不要给 UV 做 `v' = 1 - v` 换基。
 *
 * 默认要做（FBX 底行原点 → glTF 顶行原点，见 {@link flipUvVertical}）。
 * **但快照不是对所有资产都成立**：2026-10-18 的 Unity 重导版（夏日装）里，模组网格的
 * Texcoord 在 3DMigoto 阶段就是"不翻 V"直接塞进 Unity 的，于是这一批网格的 V 已经是
 * glTF 那一套；再翻一次就是双重翻转 —— 实测挂上去以后身体整片糊到图集别处（蓝衣服糊到
 * 手臂、机械贴图糊到肚子）。这种资产用 `--uv-keep` 原样保留，别翻。
 */
const UV_KEEP = argv.includes('--uv-keep')

/**
 * 只对**指定节点**的网格做 `v' = 1 - v`（配合 `--uv-keep` 使用）。
 *
 * 为什么需要：2026-10-19 10:55 那版交付把两种约定混在同一个文件里 —— 模组网格的 UV
 * 在场景资产里**已经翻过**（glTF 那套），而 `PanYinhu_Face` 与 4 个原版道具**没翻**。
 * 全翻 ⇒ 身体糊；全不翻 ⇒ 脸糊（实测：五官落到灰色图集空白上）。
 * 用法：`--uv-keep --uv-flip PanYinhu_Face,PanYinhu_Spoon_Mod,…`
 */
const UV_FLIP_NODES = (() => {
  const at = argv.indexOf('--uv-flip')
  const value = at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : ''
  return new Set(String(value).split(',').map((name) => name.trim()).filter((name) => name !== ''))
})()

const log = (...args) => { (JSON_MODE ? console.error : console.log)(...args) }
const fail = (message) => {
  console.error(`pet3d-import 失败：${message}`)
  if (JSON_MODE) console.error(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
}
process.on('unhandledRejection', (error) => fail(error?.stack ?? String(error)))
process.on('uncaughtException', (error) => fail(error?.stack ?? String(error)))

const flagValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
/** 可重复给的字符串参数（`--skip-node A --skip-node B`）。 */
const flagValues = (name) => {
  const out = []
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1])
  return out
}
const positionals = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg.startsWith('--')) { if (!BOOLEAN_FLAGS.has(arg)) i += 1; continue }
  positionals.push(arg)
}
const MODEL_DIR_ARG = positionals[0] ?? flagValue('model-dir', '')
if (MODEL_DIR_ARG === '') fail('未指定模型目录（用法：pet3d-import.mjs <model-dir> [--json]）')
const MODEL_DIR = resolve(MODEL_DIR_ARG)
const FORCE = argv.includes('--force')
const ANIMATIONS_IN_GLB = argv.includes('--animations-in-glb')
/**
 * 走位怎么处理：`inplace`（默认）／`pin`／`ramp`／`keep`。
 *
 * - `inplace`（默认）：平移**去净量**（逐轴减首末线性斜坡）+ 朝向**钉死**。
 *   跑一个循环不会累积漂移、朝向恒定（镜头永远对着正面），而起伏与摆动**全部保留**。
 *   为什么不是"全钉死"：钉死平移会把"跑起来"的起伏一起抹掉，实测骨盆竖直行程 20.9 → 0.0，
 *   看上去就成了"动画在跑、但人没劲"（用户原话：肌无力 / 跑不起来）。
 * - `pin`：平移和朝向都钉成常量（坐标绝对不变，代价是全身不动的僵硬感）。
 * - `ramp`：平移和朝向都只去净量（保留各 clip 自己的朝向）。
 * - `keep`（`--keep-root-motion`）：什么都不做。
 */
const KEEP_ROOT_MOTION = argv.includes('--keep-root-motion')
const ROOT_MOTION_MODE = KEEP_ROOT_MOTION
  ? 'keep'
  : (argv.find((a) => a.startsWith('--root-motion='))?.slice('--root-motion='.length) ?? 'inplace')
/**
 * 是否给 model.glb 写 TANGENT（默认**不写**）。
 *
 * 关掉的原因不是"切线不好"，而是**它会连带改变法线贴图的绿通道**：
 * three 的 GLTFLoader 只在 `useDerivativeTangents`（几何没有 TANGENT）时执行
 * `normalScale.y *= -1`（GLTFLoader.js:3561-3565）。补了 TANGENT 之后这句不再执行，
 * 同一张法线图就被按相反的手性解释 —— 实测在客户端那套渲染下**38% 的像素变了、14.6% 更暗**，
 * 观感是"白毛和衣服上糊了一层脏影子"（`_work/probe-normalgreen-live.mjs`、`green-plus-vs-minus-live.png`）。
 * 要开它就得同时决定绿通道怎么补（客户端 `normalScale.y` 取反 / 换手性），那是个**约定决策**，
 * 不该顺手带进来。切线生成的代码留着，`--tangents` 可以随时打开做实验。
 */
const WRITE_TANGENTS = argv.includes('--tangents')

const IMPORT_DIR = join(MODEL_DIR, '.import')
const OUT_GLB = join(IMPORT_DIR, 'model.glb')
const OUT_CLIPS_JSON = join(IMPORT_DIR, 'clips.json')
const OUT_CLIPS_BIN = join(IMPORT_DIR, 'clips.bin')
const OUT_IMPORT_JSON = join(IMPORT_DIR, 'import.json')
const TEXTURE_DIR = join(MODEL_DIR, 'textures')

const warnings = []
const warn = (message) => {
  if (!warnings.includes(message)) warnings.push(message)
  log(`  ! ${message}`)
}

/** Track property suffix -> glTF animation path. */
const PATH_BY_PROPERTY = new Map([
  ['quaternion', 'rotation'],
  ['position', 'translation'],
  ['scale', 'scale'],
  ['morphTargetInfluences', 'weights'],
])

/* --------------------------------------------------- FBXLoader 的 Node 桩 */

// 贴图是绝对路径外部引用；只记录引用，不真去读图（避免依赖绝对路径与解码器）。
const textureSourceByName = new Map()
THREE.TextureLoader.prototype.load = function load(url) {
  const texture = new THREE.Texture()
  texture.name = baseNameOf(url)
  texture.userData.sourceUrl = String(url)
  if (!textureSourceByName.has(texture.name)) textureSourceByName.set(texture.name, String(url))
  return texture
}

// GLTFExporter 的二进制分支用 FileReader 收尾；Node 没有这个全局。
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    constructor() { this.result = null; this.onload = null; this.onloadend = null; this.onerror = null }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((b) => { this.result = b; this.#done() }, (e) => this.#fail(e))
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((b) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(b).toString('base64')}`
        this.#done()
      }, (e) => this.#fail(e))
    }
    #done() { if (this.onload) this.onload({ target: this }); if (this.onloadend) this.onloadend({ target: this }) }
    #fail(error) { this.error = error; if (this.onerror) this.onerror(error); if (this.onloadend) this.onloadend({ target: this }) }
  }
}

/* --------------------------------------------------------------- 小工具 */

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const asArray = (value) => (Array.isArray(value) ? value : [value])
const baseNameOf = (url) => String(url).split(/[\\/]/).pop()
const toF64 = (array) => {
  const out = new Float64Array(array.length)
  for (let i = 0; i < array.length; i++) out[i] = array[i]
  return out
}
const sameExact = (a, b) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const COMPONENT_CTOR = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }
const ITEM_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546C67) throw new Error('不是 GLB 容器')
  let offset = 12
  let json = null
  let bin = null
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset)
    const type = buffer.readUInt32LE(offset + 4)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4E4F534A) json = JSON.parse(data.toString('utf8'))
    else if (type === 0x004E4942) bin = data
    offset += 8 + length
  }
  if (json === null) throw new Error('GLB 缺少 JSON 块')
  return { json, bin }
}

function buildGlb(json, bin) {
  const jsonText = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = (4 - (jsonText.length % 4)) % 4
  const jsonChunk = Buffer.concat([jsonText, Buffer.alloc(jsonPad, 0x20)])
  const binPad = (4 - (bin.length % 4)) % 4
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)])
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length
  const out = Buffer.alloc(total)
  out.writeUInt32LE(0x46546C67, 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonChunk.length, 12)
  out.writeUInt32LE(0x4E4F534A, 16)
  jsonChunk.copy(out, 20)
  const binHeader = 20 + jsonChunk.length
  out.writeUInt32LE(binChunk.length, binHeader)
  out.writeUInt32LE(0x004E4942, binHeader + 4)
  binChunk.copy(out, binHeader + 8)
  return out
}

/**
 * UV 的 V 轴换基：FBX 约定 → glTF 约定（`v' = 1 - v`）。
 *
 * 为什么必须换：两边的"v=0 在哪一行"相反，而 three 的两个加载器各自按自己那套来 ——
 * `FBXLoader.parseUVs` **原样复制** UV 数值、纹理走默认 `flipY = true`（v=0 在图像**底行**）；
 * `GLTFLoader` 把每张纹理强制设成 `flipY = false`（v=0 在**顶行**）。把 FBX 的数
 * 原样写进 glTF 容器，屏幕上的贴图就是**上下镜像**的（实测：脸上的五官落到须/发区域，
 * 见 `_work/probe-uv-convention.mjs` 的 A/B/C 对照）。
 *
 * 只动 TEXCOORD_n 的第二个分量；同一访问器被多个图元引用时只翻一次。
 * @param gltf - 导出的 glTF JSON（会被就地引用，不改结构）。
 * @param bin - glTF 的二进制块（**就地写入**）。
 * @returns 翻了多少个访问器、多少个 UV 元素。
 */
function flipUvVertical(gltf, bin, onlyNodes) {
  const indices = new Set()
  const wanted = onlyNodes === undefined ? null : new Set(onlyNodes)
  for (const node of gltf.nodes ?? []) {
    if (node.mesh === undefined) continue
    if (wanted !== null && !wanted.has(node.name)) continue
    const mesh = gltf.meshes[node.mesh]
    for (const primitive of mesh.primitives) {
      for (const [semantic, index] of Object.entries(primitive.attributes ?? {})) {
        if (semantic.startsWith('TEXCOORD')) indices.add(index)
      }
    }
  }
  let elements = 0
  for (const index of indices) {
    const accessor = gltf.accessors[index]
    if (accessor.componentType !== 5126 || accessor.type !== 'VEC2') {
      fail(`TEXCOORD 访问器 #${index} 不是 float VEC2（componentType=${accessor.componentType} type=${accessor.type}）`)
    }
    const view = gltf.bufferViews[accessor.bufferView]
    const stride = view.byteStride ?? 8
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    const dataView = new DataView(bin.buffer, bin.byteOffset, bin.length)
    for (let i = 0; i < accessor.count; i++) {
      const at = start + i * stride + 4
      dataView.setFloat32(at, 1 - dataView.getFloat32(at, true), true)
      elements += 1
    }
  }
  return { accessors: indices.size, elements }
}

/**
 * 逐顶点生成切线（TANGENT），三通道 + 手性 w。
 *
 * 为什么导入器来算：`model.glb` 本来没有 TANGENT，three 只能在片元里用屏幕导数现推切空间
 * —— 能用，但 UV 接缝处会抖、细节偏软。glTF 允许自带 TANGENT，自带就不必现推。
 *
 * 为什么不用 three 的 `computeMikkTSpaceTangents`：它内部把几何**去索引化**
 * （`geometry.toNonIndexed()` 后 `copy` 回去），会让 1 个顶点变 3 个：Body 网格
 * 67,608 -> 202,824 顶点，直接毁掉"唯一顶点 98,223"和索引恒等这两条不变式。
 *
 * 算法是 Lengyel 的标准做法（三角形上累加 dP/du、dP/dv，逐顶点对法线做 Gram-Schmidt，
 * w 取 `sign(dot(cross(N, T), B))`）。UV 用的是**导出后**的约定（v' = 1 - v），
 * 这样切线是照着文件里真实存在的那套 UV 算的，自洽。
 * @param geometry - 要补切线的几何（就地加 `tangent` 属性）。
 * @param flipV - 是否按 v' = 1 - v 取 UV（与 flipUvVertical 保持一致）。
 * @returns 顶点数与"UV 退化被跳过"的三角形数。
 */
function addVertexTangents(geometry, flipV) {
  const position = geometry.attributes.position
  const normal = geometry.attributes.normal
  const uv = geometry.attributes.uv
  if (position === undefined || normal === undefined || uv === undefined) return { vertices: 0, degenerate: 0 }
  const count = position.count
  const index = geometry.index
  const triangles = index === undefined || index === null ? Math.floor(count / 3) : Math.floor(index.count / 3)
  const at = (triangle, corner) => (index === undefined || index === null ? triangle * 3 + corner : index.getX(triangle * 3 + corner))
  const tan = new Float64Array(count * 3)
  const bitan = new Float64Array(count * 3)
  let degenerate = 0
  const vAt = (vertex) => (flipV ? 1 - uv.getY(vertex) : uv.getY(vertex))
  for (let triangle = 0; triangle < triangles; triangle++) {
    const a = at(triangle, 0)
    const b = at(triangle, 1)
    const c = at(triangle, 2)
    const e1 = [position.getX(b) - position.getX(a), position.getY(b) - position.getY(a), position.getZ(b) - position.getZ(a)]
    const e2 = [position.getX(c) - position.getX(a), position.getY(c) - position.getY(a), position.getZ(c) - position.getZ(a)]
    const du1 = uv.getX(b) - uv.getX(a)
    const dv1 = vAt(b) - vAt(a)
    const du2 = uv.getX(c) - uv.getX(a)
    const dv2 = vAt(c) - vAt(a)
    const det = du1 * dv2 - du2 * dv1
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) { degenerate += 1; continue }
    const r = 1 / det
    for (let k = 0; k < 3; k++) {
      const t = (dv2 * e1[k] - dv1 * e2[k]) * r
      const bt = (du1 * e2[k] - du2 * e1[k]) * r
      tan[a * 3 + k] += t; tan[b * 3 + k] += t; tan[c * 3 + k] += t
      bitan[a * 3 + k] += bt; bitan[b * 3 + k] += bt; bitan[c * 3 + k] += bt
    }
  }
  const out = new Float32Array(count * 4)
  for (let vertex = 0; vertex < count; vertex++) {
    const nx = normal.getX(vertex)
    const ny = normal.getY(vertex)
    const nz = normal.getZ(vertex)
    let tx = tan[vertex * 3]
    let ty = tan[vertex * 3 + 1]
    let tz = tan[vertex * 3 + 2]
    // Gram-Schmidt：切线与法线正交
    const dot = nx * tx + ny * ty + nz * tz
    tx -= nx * dot; ty -= ny * dot; tz -= nz * dot
    let length = Math.hypot(tx, ty, tz)
    if (!Number.isFinite(length) || length < 1e-8) {
      // 退化（UV 全等/零面积）：随便取一根与法线不平行的轴叉出来，方向无意义但必须是单位向量
      const axis = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0]
      tx = axis[1] * nz - axis[2] * ny
      ty = axis[2] * nx - axis[0] * nz
      tz = axis[0] * ny - axis[1] * nx
      length = Math.hypot(tx, ty, tz)
    }
    tx /= length; ty /= length; tz /= length
    const bx = bitan[vertex * 3]
    const by = bitan[vertex * 3 + 1]
    const bz = bitan[vertex * 3 + 2]
    // 手性：cross(N, T) 与累加出来的副切线同向则 +1
    const cx = ny * tz - nz * ty
    const cy = nz * tx - nx * tz
    const cz = nx * ty - ny * tx
    const w = cx * bx + cy * by + cz * bz < 0 ? -1 : 1
    out[vertex * 4] = tx; out[vertex * 4 + 1] = ty; out[vertex * 4 + 2] = tz; out[vertex * 4 + 3] = w
  }
  geometry.setAttribute('tangent', new THREE.BufferAttribute(out, 4))
  return { vertices: count, degenerate }
}

/**
 * 找出"把整个角色搬走"的那些节点（**数据驱动**，不写死任何骨名）。
 *
 * 判据：节点是某个蒙皮骨架根骨（没有骨骼祖先的那根骨）的**祖先或自身**，并且自己有
 * translation 轨道。这样的节点一动，整个身体跟着走 —— 它就是根位移（root motion）。
 * 手上的道具（`Bip001_Prop1`）、头饰、包子挂点都在骨下方，不是骨盆的祖先，自然被排除。
 * @param scene - 源场景（FBX 根对象）。
 * @param clips - 所有 clip。
 * @returns 走位节点名集合。
 */
function locomotionNodesOf(scene, clips) {
  const animated = new Map()
  for (const clip of clips) {
    for (const track of clip.tracks) {
      if (track.name.endsWith('.position')) animated.set(track.name.slice(0, -'.position'.length), track)
    }
  }
  const bones = new Set()
  const named = new Map()
  scene.traverse((object) => {
    if (object.isBone === true) bones.add(object)
    if (typeof object.name === 'string' && object.name !== '' && !named.has(object.name)) named.set(object.name, object)
  })
  // 每个蒙皮骨架的根骨（没有骨骼祖先的那根）
  const skeletonRoots = []
  scene.traverse((object) => {
    if (object.isSkinnedMesh !== true || object.skeleton === undefined) return
    const root = object.skeleton.bones.find((candidate) => {
      let parent = candidate.parent
      while (parent !== null) {
        if (parent.isBone === true) return false
        parent = parent.parent
      }
      return true
    })
    if (root !== undefined) skeletonRoots.push(root)
  })
  const isAncestorOfSkeleton = (node) => skeletonRoots.some((root) => {
    let walk = root
    while (walk !== null) { if (walk === node) return true; walk = walk.parent }
    return false
  })
  const locomotion = new Set()
  for (const name of animated.keys()) {
    const node = named.get(name)
    if (node === undefined) continue
    // 只认"骨链最上层"：骨下面那些骨自己的位移是动作内容（起伏、前倾），不是走位
    if (bones.has(node)) {
      let parent = node.parent
      let boneAncestor = false
      while (parent !== null) { if (bones.has(parent)) { boneAncestor = true; break } parent = parent.parent }
      if (boneAncestor) continue
    }
    if (!isAncestorOfSkeleton(node)) continue
    locomotion.add(name)
  }
  return locomotion
}

/**
 * 把根位移拿掉，让角色**原地**做动作（用户要求："固定在一个点上，原地跑"）。
 *
 * 为什么必须动数据：这些 take 是游戏里的走位动作，`Root.position` 的 z 是一根
 * 0 → 310（厘米）的**斜坡**：跑一个循环，人在世界坐标里前进 3.1 米，循环重启时又瞬移回起点。
 * 桌宠一直循环播它，就会"跑着跑着飘出画面、然后跳回来"（实测：MainCity_Run_Loop 一个循环
 * 骨盆水平移动 313 单位，约 1.3 个身高）。
 *
 * 做法是标准的"去根位移"：**逐轴减掉首末之间的线性斜坡**，只动斜坡、不动循环内的起伏与摆动：
 *   · 纯走位 take（首末差 310）⇒ 斜坡减掉后原地跑，"跳回起点"也消失；
 *   · 出手/受击这类"过去再回来"的 take（首末差 ≈ 0）⇒ 斜坡为 0，**原样保留**，压不上。
 * @param clips - 所有 clip（就地改写 track.values）。
 * @param locomotion - {@link locomotionNodesOf} 给出的走位节点名。
 * @returns 改了多少条轨道 / 多少条 clip / 单轴最大被减掉的量。
 */
function removeRootMotion(clips, locomotion) {
  let tracks = 0
  let touched = 0
  let maxRemovedPerAxis = 0
  let rotationTracks = 0
  let maxRemovedAngleDeg = 0
  const identity = new THREE.Quaternion()
  const correction = new THREE.Quaternion()
  const inverse = new THREE.Quaternion()
  const key = new THREE.Quaternion()
  for (const clip of clips) {
    let changedClip = false
    for (const track of clip.tracks) {
      // 旋转也要去根位移：骨盆离父节点原点有 ~58 单位，父节点转 25° 就把骨盆甩出 27 单位
      // （实测 MainCity_RunToWalk 每循环漂 26.75 就是这么来的）。做法同平移：
      // 把"首末之间的那一段旋转"按时间比例取反地左乘回去，端点对齐、循环内的摆动保留。
      if (track.name.endsWith('.quaternion')) {
        const node = track.name.slice(0, -'.quaternion'.length)
        if (!locomotion.has(node)) continue
        const values = track.values
        const times = track.times
        const keys = times.length
        if (keys < 2 || values === undefined) continue
        const first = new THREE.Quaternion(values[0], values[1], values[2], values[3])
        const last = new THREE.Quaternion(values[(keys - 1) * 4], values[(keys - 1) * 4 + 1], values[(keys - 1) * 4 + 2], values[(keys - 1) * 4 + 3])
        if (first.dot(last) < 0) last.set(-last.x, -last.y, -last.z, -last.w)
        const delta = last.clone().multiply(first.clone().invert())
        const angleDeg = 2 * Math.acos(Math.min(1, Math.abs(delta.w))) * 180 / Math.PI
        if (!Number.isFinite(angleDeg) || angleDeg < 0.05) continue
        const span = times[keys - 1] - times[0]
        for (let i = 0; i < keys; i++) {
          const at = span > 0 ? (times[i] - times[0]) / span : 0
          correction.copy(identity).slerp(delta, at)
          inverse.copy(correction).invert()
          key.set(values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3]).premultiply(inverse)
          values[i * 4] = key.x; values[i * 4 + 1] = key.y; values[i * 4 + 2] = key.z; values[i * 4 + 3] = key.w
        }
        rotationTracks += 1
        maxRemovedAngleDeg = Math.max(maxRemovedAngleDeg, angleDeg)
        changedClip = true
        continue
      }
      if (!track.name.endsWith('.position')) continue
      const node = track.name.slice(0, -'.position'.length)
      if (!locomotion.has(node)) continue
      const values = track.values
      const times = track.times
      const keys = times.length
      if (keys < 2 || values === undefined) continue
      const span = times[keys - 1] - times[0]
      let changedTrack = false
      for (let axis = 0; axis < 3; axis++) {
        const first = values[axis]
        const last = values[(keys - 1) * 3 + axis]
        const net = last - first
        if (!Number.isFinite(net) || Math.abs(net) < 1e-4) continue
        for (let i = 0; i < keys; i++) {
          const at = span > 0 ? (times[i] - times[0]) / span : 0
          values[i * 3 + axis] -= net * at
        }
        maxRemovedPerAxis = Math.max(maxRemovedPerAxis, Math.abs(net))
        changedTrack = true
      }
      if (changedTrack) { tracks += 1; changedClip = true }
    }
    if (changedClip) touched += 1
  }
  return { tracks, clips: touched, maxRemovedPerAxis, rotationTracks, maxRemovedAngleDeg }
}

/** 水平方向允许的行程上限（单位，身高 244）：约 1/4 身高，视觉上"身子在原地晃"，不会出画。 */
const HORIZONTAL_LIMIT = 60
/** 竖直方向允许的行程上限（约 1/3 身高）：够"跑/跳"的起伏，又不会飞出画面。 */
const VERTICAL_LIMIT = 90

/**
 * 把走位节点的**平移**约束在原地：先按每轴"围绕本 clip 均值"压缩超限的行程，再把起手一帧
 * 对齐到参考 clip（Idle_Loop）的同名节点 —— 这样
 *
 *  · 行程没超限的 clip（跑/走/待机/剧情这些，行程 4~35 单位）**一个字节都不改**；
 *  · 超限的 clip（冲刺、被击飞、切人这些"位移 take"，最大 1841 单位 ≈ 7.5 个身高）按比例压到上限内，
 *    动作形状保留（突进还是突进，只是没那么远），**不会甩出画面再瞬移回来**；
 *  · 起手对齐 ⇒ 切换 clip 时身体位置不会跳。
 *
 * 竖直方向同样处理但上限更宽松（跑起来的起伏 16.8 单位远低于 90，所以完全保留）。
 * @returns 压了多少条轨道 / 多少条 clip、压缩前后最大行程。
 */
function boundLocomotion(clips, locomotion, referenceFirstKey) {
  let tracks = 0
  let touched = 0
  let maxBefore = 0
  let maxAfter = 0
  let aligned = 0
  for (const clip of clips) {
    let changed = false
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.position')) continue
      const node = track.name.slice(0, -'.position'.length)
      if (!locomotion.has(node)) continue
      const values = track.values
      const keys = track.times.length
      if (values === undefined || keys < 1) continue
      const reference = referenceFirstKey.get(node)
      let scaled = false
      for (let axis = 0; axis < 3; axis++) {
        let min = Infinity
        let max = -Infinity
        let sum = 0
        for (let i = 0; i < keys; i++) {
          const v = values[i * 3 + axis]
          if (v < min) min = v
          if (v > max) max = v
          sum += v
        }
        const range = max - min
        const limit = axis === 1 ? VERTICAL_LIMIT : HORIZONTAL_LIMIT
        if (axis === 1) { if (range > maxBefore) maxBefore = range } else if (range > maxBefore) maxBefore = range
        const mean = sum / keys
        if (!Number.isFinite(range) || keys === 0) continue
        if (range > limit) {
          const factor = limit / range
          for (let i = 0; i < keys; i++) values[i * 3 + axis] = mean + (values[i * 3 + axis] - mean) * factor
          scaled = true
          changed = true
          tracks += 1
        }
        // 水平起手对齐到参考 clip：切换动作时身体不会横向跳一下。
        if (axis !== 1 && reference !== undefined) {
          const shift = reference[axis] - values[axis]
          if (Math.abs(shift) > 1e-4) {
            for (let i = 0; i < keys; i++) values[i * 3 + axis] += shift
            aligned += 1
            changed = true
          }
        }
      }
      if (scaled) { /* 计数已经在轴上累加 */ }
      for (let axis = 0; axis < 3; axis++) {
        let min = Infinity
        let max = -Infinity
        for (let i = 0; i < keys; i++) {
          const v = values[i * 3 + axis]
          if (v < min) min = v
          if (v > max) max = v
        }
        if (max - min > maxAfter) maxAfter = max - min
      }
    }
    if (changed) touched += 1
  }
  return { tracks, clips: touched, maxBefore, maxAfter, alignedAxes: aligned }
}

/** 极简 CSV 解析（带引号字段），够读名称对照表。 */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (ch === '\r') continue
    field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  if (rows.length === 0) return []
  const header = rows[0].map((name) => name.replace(/^\ufeff/u, '').trim())
  return rows.slice(1).filter((cells) => cells.some((cell) => cell !== '')).map((cells) => {
    const record = {}
    header.forEach((name, index) => { record[name] = (cells[index] ?? '').trim() })
    return record
  })
}

function readAccessor(json, bin, index) {
  const accessor = json.accessors[index]
  const view = json.bufferViews[accessor.bufferView]
  const itemSize = ITEM_SIZE[accessor.type]
  const Ctor = COMPONENT_CTOR[accessor.componentType]
  const stride = view.byteStride ?? itemSize * Ctor.BYTES_PER_ELEMENT
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const array = new Ctor(accessor.count * itemSize)
  const bytes = Ctor.BYTES_PER_ELEMENT
  const dataView = new DataView(bin.buffer, bin.byteOffset, bin.length)
  for (let i = 0; i < accessor.count; i++) {
    const row = start + i * stride
    for (let k = 0; k < itemSize; k++) {
      const at = row + k * bytes
      switch (accessor.componentType) {
        case 5120: array[i * itemSize + k] = dataView.getInt8(at); break
        case 5121: array[i * itemSize + k] = dataView.getUint8(at); break
        case 5122: array[i * itemSize + k] = dataView.getInt16(at, true); break
        case 5123: array[i * itemSize + k] = dataView.getUint16(at, true); break
        case 5125: array[i * itemSize + k] = dataView.getUint32(at, true); break
        default: array[i * itemSize + k] = dataView.getFloat32(at, true)
      }
    }
  }
  return { accessor, itemSize, array }
}

/**
 * 把走位节点**钉死成常量**：坐标绝对不变、朝向恒定（用户要求："任何动作都是在原地做的"）。
 *
 * 与 {@link removeRootMotion}（只减"净量"）的区别：这里把整条轨道压成一个值，
 * 循环内的摆动/转身也一起去掉 ⇒ 角色在世界坐标里**一动不动**，只有骨架自己在动。
 * - 平移钉到 **静止姿态的局部位移**：每条 clip、每一帧都同一个值 ⇒ 切 clip 也不跳。
 * - 旋转钉到**一个全局参考朝向**（默认取 Idle_Loop 首键，那是判据里"直立、面朝前"的那一帧）：
 *   实测各 clip 的根朝向彼此相差中位 82°、最大 170°，若按各自首键钉，切 clip 就会甩头。
 * @param clips - 所有 clip（就地改写 track.values）。
 * @param locomotion - 走位节点名。
 * @param restPosition - 节点名 -> 静止姿态局部位移 `[x,y,z]`。
 * @param referenceRotation - 节点名 -> 全局参考朝向 `[x,y,z,w]`。
 * @returns 钉了多少条轨道 / 多少条 clip。
 */
function pinLocomotion(clips, locomotion, restPosition, referenceRotation) {
  let translationTracks = 0
  const touchedClips = new Set()
  for (const clip of clips) {
    let touched = false
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.position')) continue
      const node = track.name.slice(0, -'.position'.length)
      if (!locomotion.has(node)) continue
      const values = track.values
      const keys = track.times.length
      if (values === undefined || keys < 1) continue
      const pinned = restPosition.get(node) ?? [values[0], values[1], values[2]]
      for (let i = 0; i < keys; i++) {
        values[i * 3] = pinned[0]
        values[i * 3 + 1] = pinned[1]
        values[i * 3 + 2] = pinned[2]
      }
      translationTracks += 1
      touched = true
    }
    if (touched) touchedClips.add(clip)
  }
  const rotation = pinLocomotionRotation(clips, locomotion, referenceRotation)
  for (const clip of rotation.touchedClips) touchedClips.add(clip)
  return { translationTracks, rotationTracks: rotation.rotationTracks, clipsTouched: touchedClips.size }
}

/**
 * 只钉**朝向**（平移不动）：把走位节点的旋转轨道压成同一个全局参考朝向。
 * 默认模式 `inplace` 用它 —— 坐标不再累积漂移（平移已去净量），朝向也恒定，
 * 但起伏/摆动这些"看着有劲"的东西全部保留。
 */
function pinLocomotionRotation(clips, locomotion, referenceRotation) {
  let rotationTracks = 0
  let clipsTouched = 0
  const touchedClips = new Set()
  for (const clip of clips) {
    let touched = false
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.quaternion')) continue
      const node = track.name.slice(0, -'.quaternion'.length)
      if (!locomotion.has(node)) continue
      const values = track.values
      const keys = track.times.length
      if (values === undefined || keys < 1) continue
      const pinned = referenceRotation.get(node) ?? [values[0], values[1], values[2], values[3]]
      for (let i = 0; i < keys; i++) {
        values[i * 4] = pinned[0]
        values[i * 4 + 1] = pinned[1]
        values[i * 4 + 2] = pinned[2]
        values[i * 4 + 3] = pinned[3]
      }
      rotationTracks += 1
      touched = true
    }
    if (touched) { clipsTouched += 1; touchedClips.add(clip) }
  }
  return { rotationTracks, clipsTouched, touchedClips }
}

/* ------------------------------------------------------------------ 入口 */

log(`模型目录 ${MODEL_DIR}`)
if (!existsSync(MODEL_DIR)) throw new Error(`模型目录不存在：${MODEL_DIR}`)

const sourceArg = flagValue('source', '')
const sourceFbx = sourceArg !== ''
  ? resolve(sourceArg)
  : (() => {
    const candidates = readdirSync(MODEL_DIR).filter((name) => name.toLowerCase().endsWith('.fbx'))
    if (candidates.length !== 1) throw new Error(`model-dir 下需要恰好一个 .fbx，实际 ${candidates.length} 个`)
    return join(MODEL_DIR, candidates[0])
  })()
if (!existsSync(sourceFbx)) throw new Error(`源 FBX 不存在：${sourceFbx}`)

const sourceBuffer = readFileSync(sourceFbx)
const sourceSha = sha256(sourceBuffer)
const sourceBytes = sourceBuffer.length
const sourceStat = statSync(sourceFbx)
log(`源 FBX   ${sourceFbx}`)
log(`         ${sourceBytes.toLocaleString()} B   mtime ${sourceStat.mtimeMs}   sha256 ${sourceSha}`)

/* ------------------------------------------------------------- 幂等检查 */

mkdirSync(IMPORT_DIR, { recursive: true })
const outputs = [OUT_GLB, OUT_CLIPS_JSON, OUT_CLIPS_BIN, OUT_IMPORT_JSON]
if (!FORCE && outputs.every((path) => existsSync(path) && statSync(path).size > 0)) {
  try {
    const previous = JSON.parse(readFileSync(OUT_IMPORT_JSON, 'utf8'))
    if (previous.sourceSha256 === sourceSha
      && previous.importerVersion === IMPORTER_VERSION
      && previous.verification !== undefined
      && previous.verification.clipMismatches === 0
      && previous.verification.meshAttributeMismatches === 0
      && previous.revision !== undefined) {
      log('up-to-date')
      if (JSON_MODE) {
        process.stdout.write(`${JSON.stringify({
          ok: true, status: 'up-to-date', modelDir: MODEL_DIR, modelId: basename(MODEL_DIR),
          importDir: IMPORT_DIR, sourceFbx, sourceBytes, sourceSha256: sourceSha,
          revision: previous.revision, artifacts: previous.artifacts,
          importerVersion: IMPORTER_VERSION, clipCount: previous.clipCount,
          meshVertexTotal: previous.meshVertexTotal, warnings: previous.warnings ?? [],
          verification: previous.verification,
          artifactsPath: { 'model.glb': OUT_GLB, 'clips.bin': OUT_CLIPS_BIN, 'clips.json': OUT_CLIPS_JSON, 'import.json': OUT_IMPORT_JSON },
        }, null, 2)}\n`)
      }
      process.exit(0)
    }
    log(`幂等检查未命中（sha256 ${previous.sourceSha256 === sourceSha ? '一致' : '已变'}）`)
  } catch (error) {
    log(`幂等检查未命中（import.json 不可读：${error.message}）`)
  }
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 内嵌贴图的桩（Unity 勾了 `EmbedTextures = true` 时走这条路）。
 *
 * three 的 FBXLoader 在二进制分支上执行 `window.URL.createObjectURL(new Blob(...))`：
 * Node 里没有 `window`，于是直接 `ReferenceError: window is not defined`；
 * 就算补上这个全局，它也**只留下一个 blob URL，原始文件名丢了** —— 而我们的产物要求
 * `textures/<原名>.png`，没有名字就等于没有贴图。
 *
 * 所以这里做两件事：
 *   1. 补一个最小桩接住 Blob，返回可回溯的 `blob:embedded/N`；
 *   2. 解析完按**内容哈希**，去兄弟目录 `<fbx>.fbm/`（FBX SDK 导出时落的贴图副本）
 *      和模型目录 `textures/` 里把文件名认回来 —— 靠哈希，不靠顺序猜。
 */
const embeddedBlobs = new Map()
globalThis.window = globalThis
{
  // Node 20+ 自带 URL.createObjectURL，返回 `blob:nodedata:<uuid>` —— 名字同样丢了，
  // 而且拿不回来。这里**无条件接管**（本进程里只有 FBXLoader 用它），换成可回溯的 URL。
  let blobSeq = 0
  globalThis.URL.createObjectURL = (blob) => {
    const url = `blob:embedded/${blobSeq++}`
    embeddedBlobs.set(url, blob)
    return url
  }
  globalThis.URL.revokeObjectURL = () => {}
}

/** 候选贴图文件（`<fbx>.fbm/` 递归 + `textures/`），按内容哈希索引，值 = { name, absolute }。 */
const hashToTexture = new Map()
/** 同一批候选，按「宽 x 高」索引 —— 内容哈希对不上时的兜底（同名图被重编码过的情况）。 */
const sizeToTexture = new Map()

/** 从 PNG 字节里读宽高（IHDR 紧跟签名）。不是 PNG 返回 undefined。 */
function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

{
  const roots = [`${sourceFbx}.fbm`, join(MODEL_DIR, 'textures')]
  const walk = (dir, depth) => {
    if (depth > 4) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) { walk(absolute, depth + 1); continue }
      if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) continue
      const bytes = readFileSync(absolute)
      const digest = sha256(bytes)
      if (!hashToTexture.has(digest)) hashToTexture.set(digest, { name: entry.name, absolute })
      const size = pngSize(bytes)
      if (size !== undefined) {
        const key = `${size.width}x${size.height}`
        const list = sizeToTexture.get(key) ?? []
        if (!list.some((item) => item.name === entry.name)) list.push({ name: entry.name, absolute })
        sizeToTexture.set(key, list)
      }
    }
  }
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue
    walk(root, 0)
  }
  log(`内嵌候选   ${hashToTexture.size} 张（查过：${roots.join(' / ')}）`)
}

const parseStart = Date.now()
const fbx = new FBXLoader().parse(
  sourceBuffer.buffer.slice(sourceBuffer.byteOffset, sourceBuffer.byteOffset + sourceBuffer.byteLength),
  '',
)
const parseSeconds = (Date.now() - parseStart) / 1000
const heapAfterParse = process.memoryUsage()
log(`解析     ${parseSeconds.toFixed(1)}s   解析后堆 ${(heapAfterParse.heapUsed / 1048576).toFixed(0)} MiB / RSS ${(heapAfterParse.rss / 1048576).toFixed(0)} MiB`)

const clips = fbx.animations ?? []

/**
 * 丢掉"没有面"的退化网格。
 *
 * 现实里真会遇到：2026-10-19 那版交付把 `body_top2`（"不戴面罩"的空状态）导成了
 * **3 个顶点、0 个多边形、没有法线**的占位。three 的 FBXLoader 能读（用容错版），但
 * 这种网格进 GLB 只会让自证长度对不上，而且它在画面上本来就不该存在 —— 桌宠那边
 * "不戴"就是"同组其它款全藏起来"，不需要一个实体。
 *
 * 行为：从场景里摘掉并**大声报出来**（静默丢网格比报错更糟）。
 */
const droppedDegenerate = []
const degenerateObjects = []
// 先收集、后摘除：遍历过程中改 children 会让 three 的 traverse 踩到 undefined。
fbx.traverse((object) => {
  if (object.isMesh !== true && object.isSkinnedMesh !== true) return
  const geometry = object.geometry
  const vertices = geometry?.attributes?.position?.count ?? 0
  const indices = geometry?.index?.count ?? 0
  // FBXLoader 出来的是**非索引**几何（index 为 null，position 每 3 个一个三角形）：
  // 之前只按 index 判三角形，会把所有正常网格都当成退化的。两种形态都要算。
  const triangles = indices > 0 ? indices / 3 : vertices / 3
  if (vertices > 0 && triangles >= 1) return
  droppedDegenerate.push({ name: object.name || '(noname)', vertices, indices })
  degenerateObjects.push(object)
})
for (const object of degenerateObjects) object.parent?.remove(object)
if (droppedDegenerate.length > 0) {
  for (const dropped of droppedDegenerate) {
    warn(`退化网格 ${dropped.name}：顶点 ${dropped.vertices} / 索引 ${dropped.indices} —— 没有面，已从模型里摘掉`)
  }
}

/** 内嵌贴图：blob URL -> 认回来的文件名；以及 文件名 -> 字节。 */
const embeddedNameByUrl = new Map()
const embeddedByName = new Map()
if (embeddedBlobs.size > 0) {
  for (const [url, blob] of embeddedBlobs) {
    const bytes = Buffer.from(await blob.arrayBuffer())
    const hit = hashToTexture.get(sha256(bytes))
    if (hit !== undefined) {
      embeddedNameByUrl.set(url, hit.name)
      embeddedByName.set(hit.name, bytes)
      continue
    }
    // 内容对不上时的兜底：同一张图被不同编码器重存过（2026-10-19 的交付里，身体贴图
    // 内嵌字节与 .fbm 里的 PNG 不是逐字节相同 ⇒ 按哈希永远认不回来，材质就变"无贴图"）。
    // 用 PNG 头里的宽高去找候选；只有**唯一**一张同尺寸图时才认，避免张冠李戴。
    const size = pngSize(bytes)
    const candidates = size === undefined ? undefined : sizeToTexture.get(`${size.width}x${size.height}`)
    const names = [...new Map((candidates ?? []).map(item => [item.name, item])).values()]
    if (names.length === 1) {
      const picked = names[0]
      embeddedNameByUrl.set(url, picked.name)
      if (!embeddedByName.has(picked.name)) embeddedByName.set(picked.name, readFileSync(picked.absolute))
      log(`内嵌贴图   ${url} 内容不同但尺寸 ${size.width}x${size.height} 唯一匹配 ${picked.name} —— 按尺寸认回`)
      continue
    }
    warn(`内嵌贴图 ${url} 在 <fbx>.fbm 与 textures/ 里都找不到同内容文件 —— 名字认不回来，跳过`)
  }
  log(`内嵌贴图   ${embeddedByName.size} 张认回文件名：${[...embeddedByName.keys()].join(', ') || '（一张都没认回）'}`)
}

/* --------------------------------------------------- 动作名对照表（可选） */

/**
 * 名称对照表：把"人看得懂的中文名"接上"稳定的英文 id"。
 *
 * 用户那边导出过一版 take 名全是中文的 FBX（`PanYinhu_Refix3_Named_Full.fbx`），配套给了
 * `PanYinhu_Refix2_clip_names_zh.csv`（`clip_name,建议中文名,大类,子类,…,慎用,用途建议,建议文件夹`）。
 * 管线**内部一律用英文 id**：编排的三段约定（`_Start`/`_Loop`/`_End`）、相位挑选、面板守卫的断言
 * 都挂在它上面。所以：
 *   · 源文件是中文名 ⇒ 按对照表映射回英文 id（这样导出成什么样都能导）；
 *   · 中文名 / 用途 / 慎用 写进 `clips.json`，只服务面板显示（`displayName` / `usage` / `caution`）。
 * 默认读 `<模型目录>/clip-names.csv`（或 .json），也可以用 `--clip-names <文件>` 指定。
 */
const clipNamesArg = flagValue('clip-names', '')
const clipNamesPath = clipNamesArg !== ''
  ? resolve(clipNamesArg)
  : [join(MODEL_DIR, 'clip-names.csv'), join(MODEL_DIR, 'clip-names.json')].find((path) => existsSync(path)) ?? ''
const nameById = new Map()
const idByName = new Map()
const ambiguousNames = new Map()
let clipNamesSha = ''
let clipsRenamed = 0
let clipsMatchedByName = 0
if (clipNamesPath !== '' && existsSync(clipNamesPath)) {
  const raw = readFileSync(clipNamesPath, 'utf8')
  clipNamesSha = sha256(Buffer.from(raw, 'utf8'))
  const rows = clipNamesPath.toLowerCase().endsWith('.json')
    ? (() => {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([id, value]) => ({ clip_name: id, ...value }))
    })()
    : parseCsv(raw)
  for (const row of rows) {
    const id = row.clip_name ?? row.clipName ?? row.name ?? ''
    if (id === '') continue
    const zh = row['建议中文名'] ?? row.zh ?? row.displayName ?? ''
    const usage = row['用途建议'] ?? row.usage ?? ''
    const caution = row['慎用'] ?? row.caution ?? ''
    nameById.set(id, { displayName: zh === '' ? undefined : zh, usage: usage === '' ? undefined : usage, caution: caution === '' ? undefined : caution })
    if (zh !== '') {
      // 中文名映射回英文 id。**有重名**：对照表里 `Run_Loop` 与 `MainCity_Run_Loop` 都叫"跑·循环"，
      // `走·循环`/`走·起手`、几条 UI、几条"拖尾特效"也都重名。所以这里存**一列候选**，
      // 解析时用**时长**区分（实测 Run_Loop 0.633s vs MainCity_Run_Loop 0.867s，能分开）。
      const list = idByName.get(zh) ?? []
      list.push({ id, duration: Number(row['时长秒'] ?? row.duration ?? Number.NaN) })
      idByName.set(zh, list)
      if (list.length > 1) ambiguousNames.set(zh, list.map((item) => item.id))
    }
  }
  /**
   * 把一个 take 名解析回英文 id。
   *
   * 实测 Refix3 那版导出里三种写法混着：直接是英文 id、`跑·循环｜Avatar_…_Run_Loop` 这种复合名、
   * 以及纯中文名（重名的就靠**时长**挑）。顺序：英文 id → 复合名右侧英文 id → 复合名/整串中文名
   * （单个候选直接用；多个候选按时长最接近；都对不上就先算"没认出来"，保留原名不瞎猜）。
   */
  const pickByDuration = (candidates, duration) => {
    if (candidates.length === 1) return candidates[0].id
    let best = null
    let bestDelta = Infinity
    for (const candidate of candidates) {
      if (!Number.isFinite(candidate.duration) || !Number.isFinite(duration)) continue
      const delta = Math.abs(candidate.duration - duration)
      if (delta < bestDelta) { bestDelta = delta; best = candidate.id }
    }
    // 0.08s 容差：大于它就说明这条 take 跟候选都对不上（宁可保留原名，也不要张冠李戴）。
    return best !== null && bestDelta <= 0.08 ? best : null
  }
  const resolveClipName = (raw, duration) => {
    if (nameById.has(raw)) return { id: raw, how: 'english-id' }
    const parts = raw.split(/[｜|]/u).map((part) => part.trim()).filter((part) => part !== '')
    for (const part of [...parts].reverse()) {
      if (nameById.has(part)) return { id: part, how: 'composite-id' }
    }
    for (const part of [...parts.slice().reverse(), raw]) {
      const candidates = idByName.get(part)
      if (candidates === undefined) continue
      const picked = pickByDuration(candidates, duration)
      if (picked !== null) return { id: picked, how: candidates.length > 1 ? 'chinese-name+duration' : 'chinese-name' }
    }
    return { id: raw, how: 'unmapped' }
  }
  const howCounts = new Map()
  for (const clip of clips) {
    const resolved = resolveClipName(clip.name, clip.duration)
    howCounts.set(resolved.how, (howCounts.get(resolved.how) ?? 0) + 1)
    if (resolved.id !== clip.name) clipsRenamed += 1
    if (resolved.how !== 'unmapped') clipsMatchedByName += 1
    clip.name = resolved.id
  }
  const mapped = clips.filter((clip) => nameById.has(clip.name)).length
  const duplicates = (() => {
    const seen = new Map()
    for (const clip of clips) seen.set(clip.name, (seen.get(clip.name) ?? 0) + 1)
    return [...seen].filter(([, count]) => count > 1).map(([name]) => name)
  })()
  log(`名称表   ${clipNamesPath}`)
  log(`         ${rows.length} 行 / sha256 ${clipNamesSha.slice(0, 16)}；`
    + `改名 ${clipsRenamed} 条；按英文 id 命中 ${mapped}/${clips.length} 条 clip`
    + `（${[...howCounts].map(([how, count]) => `${how} ${count}`).join('，')}）`)
  if (duplicates.length > 0) warn(`名称表映射后有 ${duplicates.length} 条 clip 重名（会互相覆盖）：${duplicates.slice(0, 4).join(', ')}`)
  if (ambiguousNames.size > 0) {
    log(`         中文名有重名 ${ambiguousNames.size} 个（按时长挑，挑不出就保留原名不瞎猜）：`
      + [...ambiguousNames].slice(0, 3).map(([zh, ids]) => `${zh} -> ${ids.join(' / ')}`).join('；'))
  }
  const unmapped = clips.filter((clip) => !nameById.has(clip.name)).map((clip) => clip.name)
  if (unmapped.length > 0) log(`         对照表里没有的 clip ${unmapped.length} 条（保持原名）：${unmapped.slice(0, 5).join(', ')}${unmapped.length > 5 ? ' …' : ''}`)
} else {
  log('名称表   没有 clip-names.csv/json（可选）：面板会直接显示源文件里的名字')
}

/* --------------------------------------------------------- 场景清点 */

/**
 * 按名字从场景里剔节点（`--skip-node`，可重复）。
 *
 * 为什么要这一手：Unity 那边导出时把「下装款式」的另外两套变体（`body_low3`/`body_low4`）
 * 也一起写进了 FBX —— 它们在 Unity 里 `activeSelf = false`，但与 `body_low0` **完全共面**，
 * 一起渲染就是全身 z-fighting：截图上是一层橙/青相间的花斑，看着像"贴图糊了/黑块"，
 * 实际是两套几何在抢同一层深度。在导入这一层按名字剔掉，产物才干净，而且能从源文件重放。
 */
const SKIP_NODES = flagValues('skip-node')
if (SKIP_NODES.length > 0) {
  for (const name of SKIP_NODES) {
    const hits = []
    fbx.traverse((object) => { if (object.name === name) hits.push(object) })
    if (hits.length === 0) { warn(`--skip-node ${name}：场景里没有这个节点`); continue }
    for (const node of hits) node.removeFromParent()
    log(`剔除      ${name} × ${hits.length}`)
  }
}

const meshes = []
let boneCount = 0
let nodeCount = 0
fbx.traverse((object) => {
  nodeCount += 1
  if (object.isBone === true) boneCount += 1
  if (object.isMesh !== true) return
  meshes.push(object)
})

let meshVertexTotal = 0
let morphTargetTotal = 0
let skinJointCount = 0
let morphsRelative = true
for (const mesh of meshes) {
  const geometry = mesh.geometry
  meshVertexTotal += geometry.attributes.position.count
  morphTargetTotal += geometry.morphAttributes.position?.length ?? 0
  if (geometry.morphTargetsRelative !== true) morphsRelative = false
  if (mesh.isSkinnedMesh === true) skinJointCount = Math.max(skinJointCount, mesh.skeleton.bones.length)
}
log(`场景     ${nodeCount} 个对象 / 骨骼 ${boneCount} / 网格 ${meshes.length} / 蒙皮顶点合计 ${meshVertexTotal.toLocaleString()} / 形态键 ${morphTargetTotal} / 关节 ${skinJointCount}`)

// 原地化：走位 take 的根位移要么钉死（默认）、要么只减净量，否则桌宠会一路跑出盒子再瞬移回来。
const locomotion = locomotionNodesOf(fbx, clips)
/** 走位节点的静止姿态局部位移（钉死时用这个值，保证每条 clip、每一帧都一样）。 */
const locomotionRest = new Map()
for (const name of locomotion) {
  let node = null
  fbx.traverse((object) => { if (node === null && object.name === name) node = object })
  if (node !== null) locomotionRest.set(name, [node.position.x, node.position.y, node.position.z])
}
const rootMotion = (ROOT_MOTION_MODE === 'ramp' || ROOT_MOTION_MODE === 'inplace')
  ? removeRootMotion(clips, locomotion)
  : { tracks: 0, clips: 0, maxRemovedPerAxis: 0, rotationTracks: 0, maxRemovedAngleDeg: 0 }
/** 原地化第二步（只给 `inplace`）：把超限的平移行程压进画面、并把水平起手对齐。 */
let bounding = null
if (ROOT_MOTION_MODE === 'inplace') {
  const referenceClip = clips.find((clip) => /Idle_Loop/i.test(clip.name)) ?? clips[0]
  const referenceFirstKey = new Map()
  for (const name of locomotion) {
    const track = referenceClip?.tracks.find((candidate) => candidate.name === `${name}.position`)
    if (track !== undefined) referenceFirstKey.set(name, [track.values[0], track.values[1], track.values[2]])
  }
  bounding = boundLocomotion(clips, locomotion, referenceFirstKey)
  bounding.referenceClip = referenceClip?.name ?? ''
  log(`约束     平移行程上限 水平 ${HORIZONTAL_LIMIT} / 竖直 ${VERTICAL_LIMIT} 单位：压缩 ${bounding.tracks} 条轨道`
    + `（压缩前最大行程 ${bounding.maxBefore.toFixed(1)} -> 压缩后 ${bounding.maxAfter.toFixed(1)}）；`
    + `水平起手对齐 ${bounding.alignedAxes} 条（参考 ${bounding.referenceClip}）`)
}
if (ROOT_MOTION_MODE === 'keep') {
  log(`走位     --keep-root-motion：保留根位移（走位节点 ${locomotion.size} 个：${[...locomotion].join(', ')}）`)
} else if (ROOT_MOTION_MODE === 'ramp') {
  log(`走位     只去净量：走位节点 ${locomotion.size} 个（${[...locomotion].join(', ')}），`
    + `改写 translation ${rootMotion.tracks} 条（单轴最大 ${rootMotion.maxRemovedPerAxis.toFixed(1)} 单位）`
    + ` + rotation ${rootMotion.rotationTracks} 条（最大 ${rootMotion.maxRemovedAngleDeg.toFixed(1)}°）／共 ${rootMotion.clips} 条 clip`)
} else if (ROOT_MOTION_MODE === 'inplace') {
  log(`走位     原地（默认）：走位节点 ${locomotion.size} 个（${[...locomotion].join(', ')}）`
    + `，平移去净量 translation ${rootMotion.tracks} 条（单轴最大 ${rootMotion.maxRemovedPerAxis.toFixed(1)} 单位）`
    + `／共 ${rootMotion.clips} 条 clip；朝向随后钉死成同一参考（起伏与摆动保留）`)
} else {
  log(`走位     钉死（原地）：走位节点 ${locomotion.size} 个（${[...locomotion].join(', ')}），静止位移 `
    + [...locomotionRest].map(([n, p]) => `${n}=(${p.map((v) => v.toFixed(1)).join(',')})`).join(' / ')
    + '；平移与朝向都在导出前压成常量（朝向参考取 Idle_Loop 首键）')
}

// TANGENT：默认不写（见 WRITE_TANGENTS 的注释：它会连带翻掉法线图的绿通道）。
const tangentStats = { meshes: 0, vertices: 0, degenerate: 0 }
if (WRITE_TANGENTS) {
  for (const mesh of meshes) {
    const stat = addVertexTangents(mesh.geometry, true)
    if (stat.vertices === 0) continue
    tangentStats.meshes += 1
    tangentStats.vertices += stat.vertices
    tangentStats.degenerate += stat.degenerate
  }
  log(`切线     ${tangentStats.meshes} 个网格 / ${tangentStats.vertices.toLocaleString()} 个顶点（逐顶点 Lengyel，UV 用导出的 v'=1-v；UV 退化三角形跳过 ${tangentStats.degenerate} 个）`)
} else {
  log('切线     未写 TANGENT（默认）：three 走屏幕导数路径，法线图绿通道按它的约定处理；要打开用 --tangents')
}

/* ------------------------------------------- 材质 -> 贴图 记录（导出前） */

const materialRecords = new Map()
const seenMaterials = new Set()
const TEXTURE_SLOTS = [
  'map', 'normalMap', 'bumpMap', 'displacementMap', 'emissiveMap', 'aoMap',
  'specularMap', 'alphaMap', 'lightMap', 'envMap', 'metalnessMap', 'roughnessMap',
]
const textureFileOf = (texture) => {
  if (texture === null || texture === undefined) return null
  const url = String(texture.userData?.sourceUrl ?? '')
  // 内嵌贴图：名字已在解析后按内容哈希认回（见 embeddedNameByUrl）
  if (url.startsWith('blob:embedded/')) {
    const name = embeddedNameByUrl.get(url)
    if (name === undefined) { warn(`内嵌贴图 ${url} 认不出文件名，按无贴图处理`); return null }
    return name
  }
  if (url === '') { warn(`贴图对象 ${texture.name || '(无名)'} 没有源路径，按无贴图处理`); return null }
  return baseNameOf(url)
}
for (const mesh of meshes) {
  for (const material of asArray(mesh.material)) {
    if (seenMaterials.has(material.uuid)) continue
    seenMaterials.add(material.uuid)
    const record = {
      name: material.name ?? '',
      color: `#${(material.color ?? new THREE.Color(0xffffff)).getHexString()}`,
      transparent: material.transparent === true,
      doubleSided: material.side === THREE.DoubleSide,
      base: textureFileOf(material.map),
      normal: textureFileOf(material.normalMap),
    }
    const previous = materialRecords.get(record.name)
    if (previous === undefined) materialRecords.set(record.name, record)
    else if (previous.base !== record.base || previous.normal !== record.normal) {
      warn(`材质名 ${record.name} 对应了不同的贴图：${previous.base}/${previous.normal} 与 ${record.base}/${record.normal}`)
    }
    // 这张图由本导入器按外部引用补回，绝不能落进 GLTFExporter 的 canvas 重编码路径。
    for (const slot of TEXTURE_SLOTS) if (material[slot] !== null && material[slot] !== undefined) material[slot] = null
  }
}

const referencedTextures = new Set()
for (const record of materialRecords.values()) {
  if (record.base !== null) referencedTextures.add(record.base)
  if (record.normal !== null) referencedTextures.add(record.normal)
}

/* ------------------------------------------------------------------ 贴图 */

mkdirSync(TEXTURE_DIR, { recursive: true })
const textureReport = []
let textureBytes = 0
for (const fileName of [...referencedTextures].sort()) {
  const target = join(TEXTURE_DIR, fileName)
  // 内嵌贴图：字节就在 FBX 里（解析后已接住），直接落盘，不依赖任何外部路径
  const embeddedBytes = embeddedByName.get(fileName)
  if (embeddedBytes !== undefined) {
    const same = existsSync(target) && sha256(readFileSync(target)) === sha256(embeddedBytes)
    if (!same) writeFileSync(target, embeddedBytes)
    const bytes = statSync(target).size
    textureBytes += bytes
    textureReport.push({ file: fileName, bytes, mtimeMs: statSync(target).mtimeMs, sha256: sha256(embeddedBytes), origin: 'embedded' })
    continue
  }
  const declared = textureSourceByName.get(fileName) ?? ''
  let origin = existsSync(declared) ? declared : ''
  if (origin === '') {
    if (!existsSync(target)) { warn(`贴图 ${fileName} 既不在源路径也不在 textures/，跳过`); continue }
    origin = target
  } else if (origin !== target) {
    copyFileSync(origin, target)
  }
  const sourceHash = sha256(readFileSync(origin))
  const targetHash = existsSync(target) ? sha256(readFileSync(target)) : ''
  // 字节已经一致就不重写：少一次写盘，也让 textures/ 的 mtime 保持稳定。
  if (origin !== target && sourceHash !== targetHash) copyFileSync(origin, target)
  if (sha256(readFileSync(target)) !== sourceHash) throw new Error(`贴图字节不一致：${fileName}`)
  const bytes = statSync(target).size
  textureBytes += bytes
  textureReport.push({ file: fileName, bytes, mtimeMs: statSync(target).mtimeMs, sha256: targetHash })
}
log(`贴图     ${textureReport.length} 张 / ${textureBytes.toLocaleString()} B（原样复制，字节校验一致）`)

/* ------------------------------------------------- 旋转轨道换基（同基不变式） */

/**
 * 候选常量基差（不写死任何节点名）：
 *   对每个被旋转轨道驱动的节点，逐 clip 取 C_k = 静止四元数 × 该 clip 首帧四元数的逆。
 *   若该节点是"常量基差"，则 track_k(t) = E · A_k(t)，于是 C_k = A_k(0)^-1 · E^-1 —— 只要大部分
 *   clip 的首帧接近静止姿态，C_k 就会在 E^-1 附近聚成一簇（少数真正从别的姿态起手的 clip 是噪点）。
 *   因此取"邻居最多"的那一簇的均值作为候选，簇太小的直接丢掉。
 * 候选是否真的成立，**由漂移不变式实测裁决**（见下面的贪心验证）：只有能把骨盆→头漂移明显压下来
 * 的候选才会被采用 —— 理论推导在这里不算证据。
 */
const REBASE_CLUSTER_DEG = 2.0
const REBASE_MIN_DEG = 5.0

function rebaseCandidates(scene, clipList) {
  const perNode = new Map()
  for (const clip of clipList) {
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.quaternion') || track.times.length === 0) continue
      const node = track.name.slice(0, track.name.lastIndexOf('.'))
      const object = scene.getObjectByName(node)
      if (object === undefined) continue
      if (!perNode.has(node)) perNode.set(node, { rest: object.quaternion.clone(), candidates: [] })
      const first = new THREE.Quaternion(track.values[0], track.values[1], track.values[2], track.values[3])
      if (!Number.isFinite(first.x) || !Number.isFinite(first.w) || first.lengthSq() < 1e-12) continue
      perNode.get(node).candidates.push(first.clone().invert().premultiply(object.quaternion).normalize())
    }
  }

  const angleBetween = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180 / Math.PI
  const candidates = []
  const rejected = []
  for (const [node, entry] of perNode) {
    const list = entry.candidates
    if (list.length === 0) continue
    let best = { index: 0, count: 0 }
    for (let i = 0; i < list.length; i++) {
      let count = 0
      for (const other of list) if (angleBetween(list[i], other) <= REBASE_CLUSTER_DEG) count += 1
      if (count > best.count) best = { index: i, count }
    }
    const reference = list[best.index]
    const cluster = list.filter((item) => angleBetween(reference, item) <= REBASE_CLUSTER_DEG)
    const angle = angleBetween(new THREE.Quaternion(), reference)
    const enough = cluster.length >= Math.max(2, Math.ceil(list.length * 0.2))
    if (!enough || angle <= REBASE_MIN_DEG) {
      if (angle > REBASE_MIN_DEG) rejected.push({ node, angle, cluster: cluster.length, clips: list.length })
      continue
    }
    let x = 0
    let y = 0
    let z = 0
    let w = 0
    for (const item of cluster) {
      const sign = item.dot(reference) < 0 ? -1 : 1
      x += item.x * sign
      y += item.y * sign
      z += item.z * sign
      w += item.w * sign
    }
    let spread = 0
    for (const item of cluster) spread = Math.max(spread, angleBetween(reference, item))
    const mean = new THREE.Quaternion(x, y, z, w).normalize()
    const info = { cluster: cluster.length, clips: list.length, spread }
    // 左乘、右乘两种单边解释都能解释"单条 clip"的观测；另外如果轨道值来自 Z-up(Maya 世界系)
    // 而骨架是 Y-up，正确的换算是**共轭** q' = Q·q·Q⁻¹（Q 为 up 轴换算）。三种都当候选交上去，
    // 由多 clip 的漂移实测裁决。
    candidates.push({ node, left: mean, right: null, side: 'left', angle, ...info })
    candidates.push({ node, left: null, right: mean.clone(), side: 'right', angle, ...info })
    const AXES = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) }
    for (const [axisName, axis] of Object.entries(AXES)) {
      for (const sign of [1, -1]) {
        const q = new THREE.Quaternion().setFromAxisAngle(axis, sign * Math.PI / 2)
        candidates.push({ node, left: q, right: q.clone().conjugate(), side: `conj${sign > 0 ? '+' : '-'}${axisName}`, angle: 90, ...info })
      }
    }
  }
  return { candidates, rejected }
}

/** 把修正写进轨道值（q' = left · q · right）；返回可回滚的原始数组。 */
function applyRotationRebase(clipList, corrections) {
  const originals = []
  let rewritten = 0
  for (const clip of clipList) {
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.quaternion')) continue
      const node = track.name.slice(0, track.name.lastIndexOf('.'))
      const correction = corrections.get(node)
      if (correction === undefined) continue
      const original = track.values
      const rebased = new Float32Array(original.length)
      const quaternion = new THREE.Quaternion()
      for (let i = 0; i < track.times.length; i++) {
        quaternion.set(original[i * 4], original[i * 4 + 1], original[i * 4 + 2], original[i * 4 + 3])
        if (correction.left !== null && correction.left !== undefined) quaternion.premultiply(correction.left)
        if (correction.right !== null && correction.right !== undefined) quaternion.multiply(correction.right)
        rebased[i * 4] = quaternion.x
        rebased[i * 4 + 1] = quaternion.y
        rebased[i * 4 + 2] = quaternion.z
        rebased[i * 4 + 3] = quaternion.w
      }
      track.values = rebased
      originals.push([track, original])
      rewritten += 1
    }
  }
  return { originals, rewritten }
}

/** 骨盆→头 相对静止姿态的漂移（度）。静止姿态必须在建 mixer 之前取。 */
function measureBodyDrift(scene, clipList, restorePose, steps = 9) {
  restorePose()
  const bones = []
  scene.traverse((object) => { if (object.isBone === true) bones.push(object) })
  const pelvis = bones.find((bone) => /Pelvis|Hips|下半身/i.test(bone.name))
  const headBone = bones.find((bone) => /Head|頭/i.test(bone.name))
  if (pelvis === undefined || headBone === undefined) return null
  const upAt = () => headBone.getWorldPosition(new THREE.Vector3()).sub(pelvis.getWorldPosition(new THREE.Vector3())).normalize()
  const restUp = upAt()
  const perClip = []
  for (const clip of clipList) {
    const mixer = new THREE.AnimationMixer(scene)
    mixer.clipAction(clip).play()
    let worst = 0
    let worstAt = 0
    for (let i = 0; i <= steps; i++) {
      const time = clip.duration * i / steps
      mixer.setTime(time)
      scene.updateMatrixWorld(true)
      const drift = restUp.angleTo(upAt()) * 180 / Math.PI
      if (drift > worst) { worst = drift; worstAt = time }
    }
    mixer.stopAllAction()
    mixer.uncacheRoot(scene)
    perClip.push({ name: clip.name, drift: worst, at: worstAt })
  }
  restorePose()
  perClip.sort((a, b) => b.drift - a.drift)
  const median = perClip.length === 0 ? 0 : perClip[Math.floor(perClip.length / 2)].drift
  return {
    perClip,
    worst: perClip[0]?.drift ?? 0,
    worstName: perClip[0]?.name ?? '',
    median,
    upright: perClip.filter((item) => item.drift < 15).length,
    total: perClip.length,
  }
}

/* ------------------------------------------------------ clips.bin / .json */

// 静止姿态快照：measureBodyDrift 会驱动骨骼，测完必须还原，否则"静止"会变成上一次的姿态。
const poseSnapshot = []
fbx.traverse((object) => poseSnapshot.push([object, object.position.clone(), object.quaternion.clone(), object.scale.clone()]))
const restorePose = () => {
  for (const [object, position, quaternion, scale] of poseSnapshot) {
    object.position.copy(position)
    object.quaternion.copy(quaternion)
    object.scale.copy(scale)
  }
  fbx.updateMatrixWorld(true)
}

const driftBefore = measureBodyDrift(fbx, clips, restorePose)
const rebase = rebaseCandidates(fbx, clips)

// 贪心验证：按修正角从大到小试，只有"实测漂移确实变小"的候选才留下。
// 采样测漂移用间隔抽样的子集，最终判定用全部 clip。
const driftSample = (count) => {
  if (clips.length <= count) return clips
  const step = clips.length / count
  return Array.from({ length: count }, (_, i) => clips[Math.min(clips.length - 1, Math.floor(i * step))])
}
const applied = new Map()
const appliedLog = []
let rebasedTracks = 0
if (driftBefore !== null) {
  const clusterCandidates = rebase.candidates.filter((item) => item.side === 'left' || item.side === 'right')
  const conjugationCandidates = rebase.candidates.filter((item) => item.side.startsWith('conj'))
  // 按"节点"去重后再排序，否则同一个节点的左右两条会把切片名额占满（根节点就是这样被挤掉的）。
  const byNode = new Map()
  for (const item of clusterCandidates) {
    if (!byNode.has(item.node)) byNode.set(item.node, { angle: item.angle, left: null, right: null })
    const entry = byNode.get(item.node)
    if (item.side === 'left') entry.left = item
    else entry.right = item
  }
  const nodeOrder = [...byNode].sort((a, b) => b[1].angle - a[1].angle).slice(0, 5)
  const tried = []
  for (const [, entry] of nodeOrder) {
    if (entry.left !== null) tried.push(entry.left)
    if (entry.right !== null) tried.push(entry.right)
  }
  for (const item of conjugationCandidates) {
    if (item.node === nodeOrder[0]?.[0]) tried.push(item)
  }
  // 判据用"站直的 clip 条数"（< 15°）：少数 clip 本来就是翻滚/倒地动作，用"最大漂移"看不见对
  // 大多数 clip 的修正。每轮都从当前状态重新试所有候选，取**实测最好**的那个，避免顺序依赖。
  const probeSet = driftSample(16)
  const baseline = measureBodyDrift(fbx, probeSet, restorePose, 5)
  let current = baseline
  log(`         候选试算基准（${probeSet.length} 条采样 clip）：站直 ${current.upright}/${current.total}，中位漂移 ${current.median.toFixed(2)}°，最大 ${current.worst.toFixed(2)}°`)
  for (let round = 0; round < 2; round++) {
    let best = null
    for (const candidate of tried) {
      if (applied.has(candidate.node)) continue
      const trial = applyRotationRebase(clips, new Map([[candidate.node, candidate]]))
      const measured = measureBodyDrift(fbx, probeSet, restorePose, 5)
      for (const [track, original] of trial.originals) track.values = original
      if (measured === null) continue
      const score = measured.upright * 1000 - measured.median
      if (best === null || score > best.score) best = { candidate, measured, score }
    }
    if (best === null) break
    const improves = best.measured.upright > current.upright
      || (best.measured.upright === current.upright && best.measured.median < current.median - 5)
    if (!improves) break
    const candidate = best.candidate
    const trial = applyRotationRebase(clips, new Map([[candidate.node, candidate]]))
    applied.set(candidate.node, candidate)
    rebasedTracks += trial.rewritten
    appliedLog.push({ node: candidate.node, side: candidate.side, angle: candidate.angle, cluster: candidate.cluster, clips: candidate.clips, uprightBefore: current.upright, uprightAfter: best.measured.upright, medianAfter: best.measured.median })
    log(`         采用修正 ${candidate.node} [${candidate.side}]  ${candidate.angle.toFixed(2)}°（${candidate.cluster}/${candidate.clips} 条 clip 聚簇）  站直 ${current.upright}/${current.total} -> ${best.measured.upright}/${best.measured.total}，中位 ${current.median.toFixed(2)}° -> ${best.measured.median.toFixed(2)}°`)
    current = best.measured
  }
}
const driftAfter = measureBodyDrift(fbx, clips, restorePose)

// 钉死（默认模式）：放在换基**之后** —— 参考朝向要取换基后的 Idle_Loop 首键，
// 那一帧是判据里"直立、面朝前"的姿态；若取静止姿态的四元数，会把换基修掉的 112° 常量又放回来。
let pinning = null
let driftPinned = null
if (ROOT_MOTION_MODE === 'pin' || ROOT_MOTION_MODE === 'inplace') {
  const referenceRotation = new Map()
  const idle = clips.find((clip) => /Idle_Loop/i.test(clip.name)) ?? clips[0]
  for (const name of locomotion) {
    const track = idle?.tracks.find((candidate) => candidate.name === `${name}.quaternion`)
    if (track !== undefined) referenceRotation.set(name, [track.values[0], track.values[1], track.values[2], track.values[3]])
  }
  // `inplace`（默认）**只钉朝向**：平移已经去过净量了，钉死平移会把"跑起来的起伏与摆动"一起抹掉 ——
  // 表现就是"动画在跑、但看着像没力气"（实测钉死平移后骨盆竖直行程 20.9 -> 0.0）。
  pinning = ROOT_MOTION_MODE === 'pin'
    ? pinLocomotion(clips, locomotion, locomotionRest, referenceRotation)
    : pinLocomotionRotation(clips, locomotion, referenceRotation)
  pinning.mode = ROOT_MOTION_MODE
  pinning.referenceClip = idle?.name ?? ''
  pinning.reference = [...referenceRotation].map(([n, q]) => ({ node: n, quaternion: q.map((v) => Number(v.toFixed(6))) }))
  driftPinned = measureBodyDrift(fbx, clips, restorePose)
  log(ROOT_MOTION_MODE === 'pin'
    ? `钉死     平移 ${pinning.translationTracks} 条 / 朝向 ${pinning.rotationTracks} 条｜共 ${pinning.clipsTouched} 条 clip（朝向参考 ${pinning.referenceClip} 的首键）`
    : `原地     朝向钉死 ${pinning.rotationTracks} 条（参考 ${pinning.referenceClip} 首键）；平移保留去过净量的起伏与摆动`)
  if (driftPinned !== null) {
    log(`         处理后 骨盆→头 漂移：${driftPinned.upright}/${driftPinned.total} 条站直（中位 ${driftPinned.median.toFixed(2)}°），最大 ${driftPinned.worst.toFixed(2)}°`)
  }
}

log(`换基     候选常量基差节点 ${new Set(rebase.candidates.map((c) => c.node)).size} 个 -> 实测采用 ${applied.size} 个，重写旋转轨道 ${rebasedTracks} 条`)
for (const item of appliedLog) {
  log(`         · ${item.node} [${item.side}]  常量 ${item.angle.toFixed(2)}°（${item.cluster}/${item.clips} 条 clip 聚簇）`)
}
const rejectedTop = rebase.rejected.sort((a, b) => b.angle - a.angle).slice(0, 3)
for (const item of rejectedTop) {
  log(`         · 候选被丢弃（不聚簇，属真实姿态数据）：${item.node} ${item.angle.toFixed(1)}°（最大簇 ${item.cluster}/${item.clips}）`)
}
log(`         骨盆→头 漂移：${driftBefore === null ? '无骨盆/头骨，跳过' : `${driftBefore.upright}/${driftBefore.total} 条站直（中位 ${driftBefore.median.toFixed(2)}°）-> ${driftAfter.upright}/${driftAfter.total} 条站直（中位 ${driftAfter.median.toFixed(2)}°），最大 ${driftAfter.worst.toFixed(2)}°`}`)
if (driftAfter !== null) {
  log(`         漂移最大的 5 条 clip（全 ${driftAfter.total} 条都量了）：`)
  for (const item of driftAfter.perClip.slice(0, 5)) log(`           ${item.drift.toFixed(2).padStart(6)}°  ${item.name}`)
}

const trackTotal = clips.reduce((sum, clip) => sum + clip.tracks.length, 0)
let keyframeTotal = 0
let floatTotal = 0
let nonFiniteTotal = 0
for (const clip of clips) {
  for (const track of clip.tracks) {
    keyframeTotal += track.times.length
    floatTotal += track.times.length + track.values.length
    for (let i = 0; i < track.values.length; i++) if (!Number.isFinite(track.values[i])) nonFiniteTotal += 1
  }
}
if (nonFiniteTotal !== 0) throw new Error(`关键帧里有 ${nonFiniteTotal} 个非有限值`)

const clipsBin = Buffer.alloc(floatTotal * 4)
const clipsJson = { version: 1, clips: [] }
let cursor = 0
for (const clip of clips) {
  const meta = nameById.get(clip.name)
  const entry = {
    name: clip.name,
    duration: clip.duration,
    tracks: [],
    // 显示用：内部一律用英文 id（见上面名称表的注释）。
    ...(meta?.displayName === undefined ? {} : { displayName: meta.displayName }),
    ...(meta?.usage === undefined ? {} : { usage: meta.usage }),
    ...(meta?.caution === undefined ? {} : { caution: meta.caution }),
  }
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.')
    const node = dot >= 0 ? track.name.slice(0, dot) : track.name
    const property = dot >= 0 ? track.name.slice(dot + 1) : ''
    const path = PATH_BY_PROPERTY.get(property)
    if (path === undefined) warn(`未识别的轨道属性 "${property}"（轨道 ${track.name}），原样写入`)
    const count = track.times.length
    const components = count === 0 ? 0 : track.values.length / count
    const timeOffset = cursor
    for (let i = 0; i < track.times.length; i++) clipsBin.writeFloatLE(track.times[i], (cursor + i) * 4)
    cursor += track.times.length
    const valueOffset = cursor
    for (let i = 0; i < track.values.length; i++) clipsBin.writeFloatLE(track.values[i], (cursor + i) * 4)
    cursor += track.values.length
    const trackEntry = { node, path: path ?? property, count, components, timeOffset, valueOffset }
    if (track.getInterpolation() !== 'linear') trackEntry.interpolation = track.getInterpolation()
    entry.tracks.push(trackEntry)
  }
  clipsJson.clips.push(entry)
}
if (cursor !== floatTotal) throw new Error(`写入浮点数 ${cursor} != 预期 ${floatTotal}`)

writeFileSync(OUT_CLIPS_BIN, clipsBin)
const clipsJsonBuffer = Buffer.from(JSON.stringify(clipsJson), 'utf8')
writeFileSync(OUT_CLIPS_JSON, clipsJsonBuffer)
log(`clips    ${clips.length} 条 / ${trackTotal.toLocaleString()} 轨道 / ${keyframeTotal.toLocaleString()} 关键帧 / ${floatTotal.toLocaleString()} float32 -> clips.bin ${(clipsBin.length / 1048576).toFixed(1)} MiB`)

/* ------------------------------------------------ 自证 1：clips.bin 逐元素 */

const readBack = new Uint8Array(readFileSync(OUT_CLIPS_BIN))
if (readBack.length !== clipsBin.length) throw new Error('clips.bin 读回长度不一致')
const readBackFloats = new Float32Array(readBack.buffer, 0, floatTotal)

let clipMismatches = 0
let firstMismatch = ''
let packedCursor = 0
for (let ci = 0; ci < clips.length; ci++) {
  const clip = clips[ci]
  const entry = clipsJson.clips[ci]
  if (entry.name !== clip.name) clipMismatches += 1
  if (entry.tracks.length !== clip.tracks.length) clipMismatches += 1
  for (let ti = 0; ti < clip.tracks.length; ti++) {
    const track = clip.tracks[ti]
    const meta = entry.tracks[ti]
    const expectedValues = track.values.length / (track.times.length === 0 ? 1 : track.times.length)
    if (meta.timeOffset + track.times.length !== meta.valueOffset
      || meta.timeOffset !== packedCursor
      || meta.count !== track.times.length
      || meta.components !== expectedValues) {
      clipMismatches += 1
      if (firstMismatch === '') firstMismatch = `元数据 ${clip.name} / ${track.name}`
    }
    packedCursor = meta.valueOffset + track.values.length
    for (let i = 0; i < track.times.length; i++) {
      if (readBackFloats[meta.timeOffset + i] !== track.times[i]) {
        clipMismatches += 1
        if (firstMismatch === '') firstMismatch = `时间 ${clip.name} / ${track.name} @${i}`
      }
    }
    for (let i = 0; i < track.values.length; i++) {
      if (readBackFloats[meta.valueOffset + i] !== track.values[i]) {
        clipMismatches += 1
        if (firstMismatch === '') firstMismatch = `数值 ${clip.name} / ${track.name} @${i}`
      }
    }
  }
}
log(`自证 1   clips.bin 逐元素比对：clip ${clips.length} / 轨道 ${trackTotal.toLocaleString()} / 浮点 ${floatTotal.toLocaleString()} -> 误差 ${clipMismatches}${firstMismatch === '' ? '' : ` (首个 ${firstMismatch})`}；顺序拼接游标收尾 ${packedCursor === floatTotal ? '一致' : `不一致 ${packedCursor}`}`)
if (clipMismatches !== 0 || packedCursor !== floatTotal) {
  fail(`clips.bin 与 FBXLoader 内存原值不一致 ${clipMismatches} 处（首个 ${firstMismatch || '元数据'}）`)
}

/**
 * 把"每个蒙皮网格各带一份"的骨架副本折成唯一一份。
 *
 * three 的动作绑定是按名字找节点（`getObjectByName`，取第一个命中）：留着副本，155 条 clip
 * 只会驱动第一份，另外几份永远停在绑定姿态 —— 身体在动、帽子/脸/道具不动，而静止姿态渲染
 * 因为各副本本来一致，根本看不出来。
 *
 * 折叠前先证明各副本的绑定姿态世界矩阵逐元素相同（不同就报错，绝不硬折），折叠后所有蒙皮
 * 共享同一批关节节点，节点名唯一。
 */
function foldSkeletonCopies(gltf) {
  const nodes = gltf.nodes ?? []
  const parents = new Array(nodes.length).fill(-1)
  for (const [index, node] of nodes.entries()) {
    for (const child of node.children ?? []) {
      if (parents[child] !== -1) throw new Error(`节点 ${child} 被多个父节点引用`)
      parents[child] = index
    }
  }
  const depthOf = (index) => {
    let depth = 0
    for (let at = parents[index]; at >= 0; at = parents[at]) depth += 1
    return depth
  }
  const worldCache = new Array(nodes.length).fill(null)
  const worldOf = (index) => {
    if (worldCache[index] !== null) return worldCache[index]
    const node = nodes[index]
    const matrix = new THREE.Matrix4()
    if (node.matrix !== undefined) matrix.fromArray(node.matrix)
    else {
      matrix.compose(
        new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
        new THREE.Quaternion().fromArray(node.quaternion ?? [0, 0, 0, 1]),
        new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]),
      )
    }
    if (parents[index] >= 0) matrix.premultiply(worldOf(parents[index]))
    worldCache[index] = matrix
    return matrix
  }

  const byName = new Map()
  for (const [index, node] of nodes.entries()) {
    const name = node.name ?? `#${index}`
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(index)
  }

  const canonical = new Map()
  const deleted = new Array(nodes.length).fill(false)
  let restPoseMaxDelta = 0
  let copiesRemoved = 0
  for (const [name, list] of byName) {
    if (list.length === 1) continue
    // 副本是嵌套的：留最浅的那一份，其余整棵子树都在它里面。
    const keep = list.reduce((best, index) => (depthOf(index) < depthOf(best) ? index : best), list[0])
    canonical.set(name, keep)
    const base = worldOf(keep).elements
    for (const index of list) {
      if (index === keep) continue
      const other = worldOf(index).elements
      for (let k = 0; k < 16; k++) restPoseMaxDelta = Math.max(restPoseMaxDelta, Math.abs(base[k] - other[k]))
      deleted[index] = true
      copiesRemoved += 1
    }
  }
  if (copiesRemoved === 0) return { nodeCountBefore: nodes.length, nodeCountAfter: nodes.length, copiesRemoved: 0, restPoseMaxDelta: 0, jointSetCount: 0, skinsOnWidestSkeleton: 0, widestJointCount: 0 }
  if (restPoseMaxDelta > 1e-6) throw new Error(`骨架副本的绑定姿态不一致（最大元素差 ${restPoseMaxDelta}），拒绝折叠`)
  if (restPoseMaxDelta !== 0) warn(`骨架副本的绑定姿态有 ${restPoseMaxDelta.toExponential(2)} 的差（已按最浅副本归一）`)

  // 副本的后代（更深的那几份副本）一起删掉，保证被删节点的父节点也一定被删。
  let propagated = 0
  for (let index = 0; index < nodes.length; index++) {
    if (parents[index] >= 0 && deleted[parents[index]] && !deleted[index]) { deleted[index] = true; propagated += 1 }
  }
  if (propagated !== 0) warn(`折叠时连带删除 ${propagated} 个副本后代节点`)

  const newIndex = new Array(nodes.length).fill(-1)
  const kept = []
  for (let index = 0; index < nodes.length; index++) {
    if (deleted[index]) continue
    newIndex[index] = kept.length
    kept.push(index)
  }
  for (const index of kept) {
    const node = nodes[index]
    if (node.children === undefined) continue
    node.children = node.children.filter((child) => newIndex[child] >= 0).map((child) => newIndex[child])
  }
  const remap = (index) => {
    if (newIndex[index] === undefined || newIndex[index] < 0) throw new Error(`被删除的节点 ${index} 仍被引用`)
    return newIndex[index]
  }
  // 关节/骨架根/动画通道要先按"名字"折到保留下来的那一份，再换算成新下标。
  const canonicalOf = (index) => canonical.get(nodes[index].name ?? `#${index}`) ?? index
  for (const scene of gltf.scenes ?? []) scene.nodes = (scene.nodes ?? []).map(remap)
  for (const skin of gltf.skins ?? []) {
    skin.joints = skin.joints.map((joint) => remap(canonicalOf(joint)))
    if (skin.skeleton !== undefined) skin.skeleton = remap(canonicalOf(skin.skeleton))
  }
  for (const animation of gltf.animations ?? []) {
    for (const channel of animation.channels) channel.target.node = remap(canonicalOf(channel.target.node))
  }
  gltf.nodes = kept.map((index) => nodes[index])

  const namesAfter = new Set(gltf.nodes.map((node) => node.name))
  if (namesAfter.size !== gltf.nodes.length) {
    throw new Error(`折叠后仍有重名节点：${gltf.nodes.length} 个节点只有 ${namesAfter.size} 个不重名`)
  }

  const jointSets = new Set((gltf.skins ?? []).map((skin) => skin.joints.join(',')))
  const widest = Math.max(0, ...(gltf.skins ?? []).map((skin) => skin.joints.length))
  return {
    nodeCountBefore: nodes.length,
    nodeCountAfter: gltf.nodes.length,
    copiesRemoved,
    restPoseMaxDelta,
    jointSetCount: jointSets.size,
    skinsOnWidestSkeleton: (gltf.skins ?? []).filter((skin) => skin.joints.length === widest).length,
    widestJointCount: widest,
  }
}

/* ------------------------------------------------------ model.glb（网格） */

const exporter = new GLTFExporter()
const exportStart = Date.now()
const exported = await new Promise((resolvePromise, rejectPromise) => {
  exporter.parse(fbx, resolvePromise, rejectPromise, {
    binary: true,
    onlyVisible: false,
    trs: true,
    animations: ANIMATIONS_IN_GLB ? clips : [],
  })
})
const { json: gltf, bin: gltfBin } = parseGlb(Buffer.from(exported))
log(`导出     ${((Date.now() - exportStart) / 1000).toFixed(1)}s   model.glb 原始 ${(exported.byteLength / 1048576).toFixed(1)} MiB`)

// 容器换了，UV 的 V 轴约定也必须跟着换（FBX: v=0 在图像底行 → glTF: v=0 在顶行）。
// 这一步不是"复制的部分"，它会如实记进 import.json 的 verification.uvRebase 与 verbatim.uv=false。
// 三种模式：
//   · 默认            → 全部网格 v' = 1 - v
//   · --uv-keep       → 全部不翻（资产已经是 glTF 约定）
//   · --uv-keep + --uv-flip A,B → 只翻 A/B（同一文件里混了两种约定的情况）
const uvFlipMode = UV_KEEP
  ? (UV_FLIP_NODES.size > 0 ? 'nodes' : 'keep')
  : 'all'
const uvFlip = uvFlipMode === 'keep'
  ? { accessors: 0, elements: 0 }
  : flipUvVertical(gltf, gltfBin, uvFlipMode === 'nodes' ? [...UV_FLIP_NODES] : undefined)
log(uvFlipMode === 'keep'
  ? 'UV 换基  跳过（--uv-keep）：源资产的 V 已经是 glTF 那一套'
  : `UV 换基  ${uvFlipMode === 'nodes' ? `只翻 ${[...UV_FLIP_NODES].join(', ')}：` : ''}TEXCOORD_0 访问器 ${uvFlip.accessors} 个 / UV 元素 ${uvFlip.elements.toLocaleString()} 个：v' = 1 - v（FBX 底行原点 -> glTF 顶行原点）`)

// GLTFExporter 拿不到图片字节（Node 里没有 canvas），材质里的贴图引用在这里补：
// 外部引用，不内嵌、不重编码。
gltf.images = []
gltf.textures = []
const textureIndex = new Map()
const ensureTexture = (fileName) => {
  if (textureIndex.has(fileName)) return textureIndex.get(fileName)
  const imageIndex = gltf.images.push({ uri: `../textures/${fileName}`, name: fileName }) - 1
  const index = gltf.textures.push({ source: imageIndex, name: fileName }) - 1
  textureIndex.set(fileName, index)
  return index
}
for (const material of gltf.materials ?? []) {
  const record = materialRecords.get(material.name ?? '')
  if (record === undefined) { warn(`glTF 材质 ${material.name ?? '(无名)'} 在源场景里找不到对应材质`); continue }
  material.pbrMetallicRoughness = material.pbrMetallicRoughness ?? {}
  if (material.pbrMetallicRoughness.baseColorFactor === undefined) {
    const color = new THREE.Color(record.color)
    material.pbrMetallicRoughness.baseColorFactor = [color.r, color.g, color.b, 1]
  }
  if (record.base !== null) material.pbrMetallicRoughness.baseColorTexture = { index: ensureTexture(record.base) }
  if (record.normal !== null) material.normalTexture = { index: ensureTexture(record.normal) }
  if (record.transparent === true) material.alphaMode = 'BLEND'
  material.doubleSided = record.doubleSided
}
for (const record of materialRecords.values()) {
  if (!(gltf.materials ?? []).some((material) => (material.name ?? '') === record.name)) {
    warn(`源材质 ${record.name} 没有出现在 model.glb 里`)
  }
}
// 网格与骨架在这里定稿：把逐网格复制的骨架副本折成唯一一份（折叠前先证明各副本姿态逐元素
// 相同，见 foldSkeletonCopies）。节点 539 -> 148，且所有节点名唯一。
const fold = foldSkeletonCopies(gltf)
log(`骨架     ${fold.nodeCountBefore} 节点 -> ${fold.nodeCountAfter}（折叠副本 ${fold.copiesRemoved}，副本姿态差 ${fold.restPoseMaxDelta.toExponential(2)}）`)
log(`         蒙皮 ${(gltf.skins ?? []).length} 个 / ${fold.jointSetCount} 套关节表`)
const glbBuffer = buildGlb(gltf, gltfBin)
writeFileSync(OUT_GLB, glbBuffer)
log(`model.glb ${(glbBuffer.length / 1048576).toFixed(1)} MiB   节点 ${gltf.nodes.length} / 网格 ${gltf.meshes.length} / 蒙皮 ${(gltf.skins ?? []).length} / 材质 ${(gltf.materials ?? []).length} / 图片 ${gltf.images.length} / 动画 ${(gltf.animations ?? []).length}`)
const meshNodeName = new Map()
for (const node of gltf.nodes) if (node.mesh !== undefined && !meshNodeName.has(node.mesh)) meshNodeName.set(node.mesh, node.name ?? '(无名)')
for (const [index, mesh] of gltf.meshes.entries()) {
  const primitive = mesh.primitives[0]
  const position = gltf.accessors[primitive.attributes.POSITION]
  log(`  网格 ${index} ${meshNodeName.get(index) ?? '(无名)'}  图元 ${mesh.primitives.length}  顶点 ${position.count.toLocaleString()}  属性 ${Object.keys(primitive.attributes).join(',')}  形态键 ${primitive.targets?.length ?? 0}  索引 ${primitive.indices === undefined ? '无（非索引）' : '有'}  材质 ${mesh.primitives.map((p) => p.material).join('/')}`)
}
for (const [index, skin] of (gltf.skins ?? []).entries()) {
  log(`  蒙皮 ${index}  关节 ${skin.joints.length}  inverseBindMatrices ${gltf.accessors[skin.inverseBindMatrices].count} 组`)
}

/* ---------------------------------- 自证 2：model.glb 顶点属性逐元素比对 */

const glbAccessors = []
const usedBySemantic = new Map()
for (const mesh of gltf.meshes) {
  for (const primitive of mesh.primitives) {
    for (const [semantic, index] of Object.entries(primitive.attributes)) usedBySemantic.set(index, semantic)
    for (const target of primitive.targets ?? []) {
      for (const [semantic, index] of Object.entries(target)) usedBySemantic.set(index, `MORPH_${semantic}`)
    }
    if (primitive.indices !== undefined) usedBySemantic.set(primitive.indices, 'INDICES')
  }
}
for (const skin of gltf.skins ?? []) usedBySemantic.set(skin.inverseBindMatrices, 'IBM')

const attributeMismatches = []
const consumed = new Set()
const describeCandidates = (semantic, sourceFloats) => [...usedBySemantic]
  .filter(([, candidateSemantic]) => candidateSemantic === semantic)
  .map(([index]) => {
    const entry = glbAccessors.find((candidate) => candidate.index === index)
    if (entry === undefined || entry.floats === null) return `#${index} 不可比`
    let first = -1
    const limit = Math.min(entry.floats.length, sourceFloats.length)
    for (let k = 0; k < limit; k++) if (entry.floats[k] !== sourceFloats[k]) { first = k; break }
    return `#${index} 长度 ${entry.floats.length}/${sourceFloats.length} 首差 @${first}`
      + (first >= 0 ? ` 期望 ${sourceFloats[first]} 实际 ${entry.floats[first]}` : '')
  })
  .join('; ')
const compare = (label, semantic, sourceFloats, detail = '') => {
  let matched = null
  for (const [index, candidateSemantic] of usedBySemantic) {
    if (consumed.has(index) || candidateSemantic !== semantic) continue
    const candidate = glbAccessors.find((entry) => entry.index === index)
    if (candidate !== undefined && candidate.floats !== null && sameExact(candidate.floats, sourceFloats)) { matched = index; break }
  }
  if (matched === null) {
    attributeMismatches.push(`${label} ${semantic}${detail} [${describeCandidates(semantic, sourceFloats)}]`)
    return false
  }
  consumed.add(matched)
  return true
}
for (const [index] of usedBySemantic) {
  const { accessor, array, itemSize } = readAccessor(gltf, gltfBin, index)
  glbAccessors.push({ index, itemSize, componentType: accessor.componentType, count: accessor.count, array, floats: toF64(array) })
}

let attributeChecks = 0
// UV 是要换基的那一项：导出值应当是源值翻 V 之后的结果，比对时按同一条算式换算
// （`Math.fround(1 - v)` 与 `DataView.setFloat32` 的舍入一致，仍然要求逐元素 `===`）。
// 逐网格判断：`--uv-keep --uv-flip A,B` 时只有 A/B 翻，其余原样。
const flipsV = (name) => !UV_KEEP || UV_FLIP_NODES.has(name)
const flipVOf = (floats) => {
  const out = new Float64Array(floats.length)
  for (let i = 0; i + 1 < floats.length; i += 2) {
    out[i] = floats[i]
    out[i + 1] = Math.fround(1 - floats[i + 1])
  }
  return out
}
for (const mesh of meshes) {
  const geometry = mesh.geometry
  const label = mesh.name
  const uvExpect = flipsV(label) ? flipVOf : toF64
  const checks = [
    ['POSITION', geometry.attributes.position, toF64, ''],
    ['NORMAL', geometry.attributes.normal, toF64, ''],
    ['TEXCOORD_0', geometry.attributes.uv, uvExpect, flipsV(label) ? ' [V 换基 1-v]' : ' [V 原样保留]'],
    ['TANGENT', geometry.attributes.tangent, toF64, ' [导入器生成]'],
    ['JOINTS_0', geometry.attributes.skinIndex, toF64, ''],
    ['WEIGHTS_0', geometry.attributes.skinWeight, toF64, ''],
  ]
  for (const [semantic, attribute, expect, detail] of checks) {
    if (attribute === undefined) continue
    attributeChecks += 1
    compare(label, semantic, expect(attribute.array), detail)
  }
  // glTF 的形态键只能是"相对基形的偏移"，three 这边可能是绝对值；换算方式与 GLTFExporter
  // 完全一致（先在双精度里相减，再存成 float32），所以仍然可以逐元素 === 比对。
  const relative = geometry.morphTargetsRelative === true
  const expectedFloats = (attribute, baseAttribute) => {
    if (relative) return toF64(attribute.array)
    const out = new Float32Array(attribute.array.length)
    for (let i = 0; i < out.length; i++) out[i] = attribute.array[i] - baseAttribute.array[i]
    return toF64(out)
  }
  for (let i = 0; i < (geometry.morphAttributes.position?.length ?? 0); i++) {
    attributeChecks += 1
    compare(`${label} 形态键#${i}`, 'MORPH_POSITION',
      expectedFloats(geometry.morphAttributes.position[i], geometry.attributes.position), relative ? ' [绝对]' : ' [减基形]')
  }
  for (let i = 0; i < (geometry.morphAttributes.normal?.length ?? 0); i++) {
    attributeChecks += 1
    compare(`${label} 形态键#${i}`, 'MORPH_NORMAL',
      expectedFloats(geometry.morphAttributes.normal[i], geometry.attributes.normal), relative ? ' [绝对]' : ' [减基形]')
  }
}

// 多材质网格被 GLTFExporter 切成图元时用的是几何体自带的 group 区间，所以每个图元的
// 索引是 [start, start+count)，把同一网格的所有图元按序拼起来必须正好是 0..n-1。
let indexMismatches = 0
let indexedVertices = 0
for (const mesh of gltf.meshes) {
  const concatenated = []
  for (const primitive of mesh.primitives) {
    if (primitive.indices === undefined) continue
    const indices = readAccessor(gltf, gltfBin, primitive.indices)
    for (let i = 0; i < indices.array.length; i++) concatenated.push(indices.array[i])
  }
  if (concatenated.length === 0) continue
  const positions = gltf.accessors[mesh.primitives[0].attributes.POSITION]
  indexedVertices += concatenated.length
  if (concatenated.length !== positions.count) { indexMismatches += 1; continue }
  for (let i = 0; i < concatenated.length; i++) if (concatenated[i] !== i) indexMismatches += 1
}

// GLTFExporter 把 IBM 换成了 glTF 约定的"相对网格节点"：boneInverses[i] * bindMatrix，
// 并存成 float32。这里按同一条算式重算，仍然要求逐元素 === 相同。
let ibmMaxDelta = 0
let ibmCompared = 0
let ibmMismatches = 0
const sourceMeshByName = new Map(meshes.map((mesh) => [mesh.name, mesh]))
const temporaryBoneInverse = new THREE.Matrix4()
for (const node of gltf.nodes) {
  if (node.skin === undefined) continue
  const source = sourceMeshByName.get(node.name)
  if (source === undefined || source.isSkinnedMesh !== true) continue
  const read = readAccessor(gltf, gltfBin, gltf.skins[node.skin].inverseBindMatrices)
  const boneCount = source.skeleton.bones.length
  if (read.array.length !== boneCount * 16) { ibmMismatches += 1; continue }
  const expected = new Float32Array(boneCount * 16)
  for (let b = 0; b < boneCount; b++) {
    temporaryBoneInverse.copy(source.skeleton.boneInverses[b])
    temporaryBoneInverse.multiply(source.bindMatrix)
    temporaryBoneInverse.toArray(expected, b * 16)
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== read.array[i]) {
      ibmMismatches += 1
      const delta = Math.abs(expected[i] - read.array[i])
      if (delta > ibmMaxDelta) ibmMaxDelta = delta
    }
  }
  ibmCompared += 1
}
if (ibmCompared !== meshes.filter((mesh) => mesh.isSkinnedMesh === true).length) {
  warn(`只有 ${ibmCompared} 个蒙皮网格比对了 inverseBindMatrices`)
}

log(`自证 2   model.glb 顶点属性逐元素比对：${attributeChecks} 项 -> 不等 ${attributeMismatches.length}`)
log(`         索引拼接恒等（0..n-1）违例 ${indexMismatches}（已核对 ${indexedVertices.toLocaleString()} 个索引）；inverseBindMatrices ${ibmCompared} 个蒙皮 -> 不等 ${ibmMismatches}（最大绝对差 ${ibmMaxDelta.toExponential(2)}）`)
if (attributeMismatches.length !== 0) {
  for (const mismatch of attributeMismatches.slice(0, 4)) log(`         · ${mismatch}`)
}
if (attributeMismatches.length !== 0 || indexMismatches !== 0 || ibmMismatches !== 0) {
  fail(`model.glb 顶点数据与 FBXLoader 内存原值不一致（属性 ${attributeMismatches.length} 项 + 索引 ${indexMismatches} 处 + IBM ${ibmMismatches} 处）`)
}

/* --------------------------------------------- 宿主同构的新鲜度戳（§10.2.2） */

/**
 * 逐字对齐宿主 `packages/dsh-pet-3d/src/importer.ts` 的 `sourceStamps`：
 * modelDir 顶层所有 `.fbx` + `textures/` 递归下所有文件，键 = 相对路径（`/` 分隔），
 * 值至少含 `{ size, mtimeMs }`，且 `mtimeMs` 必须取整。
 *
 * 形状、字段名、取整方式任一处不同，宿主的 `staleSources` 就会每 5 秒判一次 stale，
 * 从而对这份 330MB FBX 无限重导入。
 */
function hostSourceStamps() {
  const stamps = {}
  const add = (absolute, relative) => {
    const info = statSync(absolute)
    stamps[relative] = {
      size: info.size,
      mtimeMs: Math.round(info.mtimeMs),
      sha256: absolute === sourceFbx ? sourceSha : sha256(readFileSync(absolute)),
    }
  }
  for (const name of readdirSync(MODEL_DIR)) {
    if (!name.toLowerCase().endsWith('.fbx')) continue
    const absolute = join(MODEL_DIR, name)
    if (!statSync(absolute).isFile()) continue
    add(absolute, name)
  }
  const walk = (relative) => {
    const absolute = join(MODEL_DIR, relative)
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return
    for (const name of readdirSync(absolute)) {
      const child = `${relative}/${name}`
      if (statSync(join(MODEL_DIR, child)).isDirectory()) walk(child)
      else add(join(MODEL_DIR, child), child)
    }
  }
  walk('textures')
  return stamps
}

/** 宿主 `staleSources` 的判据：键缺失/大小/取整 mtime 不等，或多出没记录的键。 */
function staleSourceKeys(recorded, current) {
  const stale = []
  for (const [key, stamp] of Object.entries(recorded)) {
    const now = current[key]
    if (now === undefined || now.size !== stamp.size || now.mtimeMs !== stamp.mtimeMs) stale.push(key)
  }
  for (const key of Object.keys(current)) if (!(key in recorded)) stale.push(key)
  return stale
}

/* ------------------------------------------------------------ import.json */

// 动作能不能绑上，取决于轨道名在 model.glb 里既存在又唯一（three 按名字取节点）。
const glbNodeNameCount = new Map()
for (const node of gltf.nodes) glbNodeNameCount.set(node.name, (glbNodeNameCount.get(node.name) ?? 0) + 1)
const drivenNames = new Set()
for (const clip of clipsJson.clips) for (const track of clip.tracks) drivenNames.add(track.node)
const missingDriven = [...drivenNames].filter((name) => !glbNodeNameCount.has(name))
const ambiguousDriven = [...drivenNames].filter((name) => glbNodeNameCount.get(name) > 1)
log(`绑定     轨道节点名 ${drivenNames.size} 个 -> 缺失 ${missingDriven.length} / 重名 ${ambiguousDriven.length}；model.glb 节点 ${gltf.nodes.length} 个全部不重名`)

const verification = {
  clipCount: clips.length,
  trackCount: trackTotal,
  keyframeTotal,
  clipFloatTotal: floatTotal,
  clipMismatches,
  meshVertexTotal,
  meshAttributeChecks: attributeChecks,
  meshAttributeMismatches: attributeMismatches.length,
  indexMismatches,
  ibmCompared,
  ibmMaxDelta,
  ibmMismatches,
  morphTargetTotal,
  morphsRelative,
  textureBytes,
  glbAnimations: (gltf.animations ?? []).length,
  glbAnimationsIncluded: ANIMATIONS_IN_GLB,
  // 逐元素复制的部分 vs 换基的部分，必须分开讲清楚。
  verbatim: {
    time: true,
    translation: rootMotion.tracks === 0,
    scale: true,
    rotation: rebasedTracks === 0,
    uv: uvFlip.elements === 0,
  },
  // 走位 take 的处理：inplace = 平移去净量 + 朝向钉死（默认），pin = 全钉死，
  // ramp = 平移朝向都只去净量，keep = 不动。
  rootMotion: {
    mode: ROOT_MOTION_MODE,
    locomotionNodes: [...locomotion],
    restPosition: [...locomotionRest].map(([node, p]) => ({ node, position: p.map((v) => Number(v.toFixed(6))) })),
    ...(pinning === null ? {} : {
      pinned: {
        translationTracks: pinning.translationTracks,
        rotationTracks: pinning.rotationTracks,
        clipsTouched: pinning.clipsTouched,
        rotationReferenceClip: pinning.referenceClip,
        rotationReference: pinning.reference,
        driftAfterPinMaxDeg: driftPinned === null ? null : Number(driftPinned.worst.toFixed(3)),
        driftAfterPinUpright: driftPinned === null ? null : `${driftPinned.upright}/${driftPinned.total}`,
      },
    }),
    ...(ROOT_MOTION_MODE === 'ramp' || ROOT_MOTION_MODE === 'inplace' ? {
      netRemoved: {
        translationTracks: rootMotion.tracks,
        rotationTracks: rootMotion.rotationTracks,
        clipsTouched: rootMotion.clips,
        maxRemovedPerAxis: Number(rootMotion.maxRemovedPerAxis.toFixed(3)),
        maxRemovedAngleDeg: Number(rootMotion.maxRemovedAngleDeg.toFixed(3)),
      },
    } : {}),
    ...(bounding === null ? {} : {
      bounded: {
        horizontalLimit: HORIZONTAL_LIMIT,
        verticalLimit: VERTICAL_LIMIT,
        referenceClip: bounding.referenceClip,
        tracksScaled: bounding.tracks,
        clipsTouched: bounding.clips,
        horizontalStartAlignedAxes: bounding.alignedAxes,
        maxExcursionBefore: Number(bounding.maxBefore.toFixed(3)),
        maxExcursionAfter: Number(bounding.maxAfter.toFixed(3)),
      },
    }),
    why: '这些 take 是游戏里的走位动作：Root.position 的 z 是 0→310 的斜坡、模型根还会转 25°，'
      + '循环播就会一路跑出画面再瞬移回来（实测 MainCity_Run_Loop 每循环漂 287 单位）。'
      + 'inplace 去掉平移的净量（不累积漂移）再把朝向钉成同一参考（面朝同一方向），'
      + '但保留循环内的起伏与摆动 —— 全钉死会把"跑起来"的起伏一起抹掉，看着没劲（实测骨盆竖直行程 20.9→0.0）。',
  },
  // 动作名对照表（显示用；内部一律用英文 id）。
  clipNames: clipNamesPath === '' ? null : {
    file: clipNamesPath,
    sha256: clipNamesSha,
    entries: nameById.size,
    renamedToEnglishId: clipsRenamed,
    matched: clips.filter((clip) => nameById.has(clip.name)).length,
    total: clips.length,
    ambiguousChineseNames: [...ambiguousNames].map(([zh, ids]) => ({ zh, ids })),
    note: '中文名/用途/慎用只写进 clips.json 供面板显示；编排与相位挑选一律按英文 id。',
  },
  uvRebase: {
    flippedSemantics: UV_KEEP ? [] : ['TEXCOORD_0'],
    accessors: uvFlip.accessors,
    elements: uvFlip.elements,
    transform: UV_KEEP ? '无（--uv-keep）' : 'v\' = 1 - v',
    from: 'FBX：v=0 在图像底行（three 的 FBXLoader 原样复制 UV，纹理 flipY=true）',
    to: 'glTF：v=0 在图像顶行（three 的 GLTFLoader 强制 flipY=false）',
    reason: UV_KEEP
      ? '这批网格的 Texcoord 在 3DMigoto 阶段就是"不翻 V"塞进 Unity 的，V 已经是 glTF 那一套；再翻会双重翻转（实测：身体整片糊到图集别处）'
      : '容器换了，V 轴约定必须跟着换；不换则屏幕上贴图上下镜像（实测对照见 _work/probe-uv-convention.mjs）',
  },
  // 生成的量要和"逐元素复制"的部分分开讲：切线是导入器算的，源文件里没有。
  tangentGeneration: {
    enabled: WRITE_TANGENTS,
    method: 'per-vertex Lengyel（累加 dP/du、dP/dv → Gram-Schmidt → w = sign(cross(N,T)·B)）',
    uvConvention: 'v\' = 1 - v（与 uvRebase 同一套，切线照着文件里真实的 UV 算）',
    meshes: tangentStats.meshes,
    vertices: tangentStats.vertices,
    degenerateTriangles: tangentStats.degenerate,
    reason: '没有 TANGENT 时 three 只能用屏幕导数现推切空间：能用，但接缝处偏软/偏噪',
    whyDisabledByDefault: '写了 TANGENT 会让 three 的 GLTFLoader 不再执行 normalScale.y *= -1（GLTFLoader.js:3561），同一张法线图的绿通道被按相反手性解释：实测 38% 像素变化、14.6% 更暗，观感是"糊了一层脏影子"。要开就得同时把绿通道补偿定下来（客户端取反或换手性），这是约定决策，默认不开。',
  },
  rotationRebase: {
    candidateNodes: rebase.candidates.size,
    appliedNodes: [...applied.keys()],
    appliedDetail: appliedLog.map((item) => ({ node: item.node, angleDeg: item.angle, cluster: item.cluster, clips: item.clips, driftBefore: item.driftBefore, driftAfter: item.driftAfter })),
    correctedTracks: rebasedTracks,
    maxCorrectionAngleDeg: applied.size === 0 ? 0 : Math.max(...[...applied.values()].map((c) => c.angle)),
    clusterDeg: REBASE_CLUSTER_DEG,
    minCorrectionDeg: REBASE_MIN_DEG,
    rejectedCandidates: rebase.rejected.length,
    driftBeforeMaxDeg: driftBefore === null ? null : driftBefore.worst,
    driftAfterMaxDeg: driftAfter === null ? null : driftAfter.worst,
    driftCriterionDeg: 15,
    driftCheckedClips: driftAfter === null ? 0 : driftAfter.perClip.length,
    worstClips: driftAfter === null ? [] : driftAfter.perClip.slice(0, 5).map((item) => ({ name: item.name, drift: item.drift })),
  },
  nodeCountBeforeFold: fold.nodeCountBefore,
  nodeCountAfterFold: fold.nodeCountAfter,
  duplicateNodesFolded: fold.copiesRemoved,
  restPoseMaxDelta: fold.restPoseMaxDelta,
  jointSetCount: fold.jointSetCount,
  skinsOnWidestSkeleton: fold.skinsOnWidestSkeleton,
  widestJointCount: fold.widestJointCount,
  drivenNodeNames: drivenNames.size,
  drivenNodeNamesMissing: missingDriven.length,
  drivenNodeNamesAmbiguous: ambiguousDriven.length,
}
if (missingDriven.length !== 0 || ambiguousDriven.length !== 0) {
  fail(`动作绑定会失败：${missingDriven.length} 个轨道节点名不存在，${ambiguousDriven.length} 个重名（例：${[...missingDriven, ...ambiguousDriven].slice(0, 5).join(', ')}）`)
}

// artifacts 的键就是客户端热换的粒度：除三个产物外，每张贴图单列一条
// （键用与 sources 同一套相对路径约定），这样"只改一张贴图"可以只换贴图。
const artifacts = {
  'model.glb': sha256(glbBuffer),
  'clips.bin': sha256(clipsBin),
  'clips.json': sha256(clipsJsonBuffer),
}
const sourceStampsForImport = hostSourceStamps()
for (const [key, stamp] of Object.entries(sourceStampsForImport)) {
  if (key.startsWith('textures/')) artifacts[key] = stamp.sha256
}
const revision = sha256([
  `importerVersion=${IMPORTER_VERSION}`,
  `source=${sourceSha}`,
  ...Object.keys(artifacts).sort().map((key) => `${key}=${artifacts[key]}`),
].join('\n'))

const importJson = {
  sourceFbx,
  sourceBytes,
  sourceSha256: sourceSha,
  importedAt: new Date().toISOString(),
  clipCount: clips.length,
  meshVertexTotal,
  warnings,
  revision,
  artifacts,
  importerVersion: IMPORTER_VERSION,
  importerScript: fileURLToPath(import.meta.url),
  // 宿主的新鲜度检查（mtime + size，≤5 秒一次）用这一块，不必每次算哈希。
  sources: sourceStampsForImport,
  verification,
  textures: textureReport,
  materials: [...materialRecords.values()],
}
writeFileSync(OUT_IMPORT_JSON, JSON.stringify(importJson, null, 2))

// 自证 3：拿宿主的判据当场跑一遍，必须 0 条 stale（否则宿主会永远重导入）。
const stale = staleSourceKeys(importJson.sources, hostSourceStamps())
log(`新鲜度   sources ${Object.keys(importJson.sources).length} 条 -> stale ${stale.length}${stale.length === 0 ? '（宿主判据，0 条 → 不会反复重导入）' : ` ！${stale.slice(0, 5).join(', ')}`}`)
if (stale.length !== 0) fail(`import.json.sources 与磁盘不一致（宿主会判定 stale）：${stale.join(', ')}`)

log('---- 汇总 ----')
log(`  model.glb      ${(glbBuffer.length / 1048576).toFixed(2)} MiB`)
log(`  clips.bin      ${(clipsBin.length / 1048576).toFixed(2)} MiB`)
log(`  clips          ${clips.length} 条 / 轨道 ${trackTotal.toLocaleString()} / 关键帧 ${keyframeTotal.toLocaleString()}`)
log(`  顶点合计       ${meshVertexTotal.toLocaleString()}`)
log(`  贴图字节       ${textureBytes.toLocaleString()}`)
log(`  逐元素误差     ${clipMismatches}（clips.bin）+ ${attributeMismatches.length}（model.glb 顶点属性）`)
log(`  revision       ${revision}`)
log('import.json 已写出')

if (JSON_MODE) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'imported',
    modelDir: MODEL_DIR,
    modelId: basename(MODEL_DIR),
    importDir: IMPORT_DIR,
    sourceFbx,
    sourceBytes,
    sourceSha256: sourceSha,
    revision,
    artifacts,
    importerVersion: IMPORTER_VERSION,
    clipCount: clips.length,
    meshVertexTotal,
    warnings,
    verification,
    artifactsPath: {
      'model.glb': OUT_GLB,
      'clips.bin': OUT_CLIPS_BIN,
      'clips.json': OUT_CLIPS_JSON,
      'import.json': OUT_IMPORT_JSON,
    },
  }, null, 2)}\n`)
}
process.exit(0)
