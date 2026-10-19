/**
 * model3d renderer — mounts one fully-imported model folder into the
 * stage-owned container through the lazy three.js vendor stack.
 *
 * The mount call is synchronous; the boot runs asynchronously and reports fatal
 * failures through the handle's error sink so the React bridge can render
 * localized guidance, and disposing mid-boot is race-safe.
 *
 * LOADING ORDER IS THE DESIGN (a 150 MB payload is involved):
 *
 *   1. `.import/model.glb`  → the character is on screen immediately;
 *   2. `.import/clips.json` → the action list lights up (buttons still dead);
 *   3. `.import/clips.bin`  → in the BACKGROUND; when it lands, every clip is
 *                             assembled and registered with the mixer, and the
 *                             buttons come alive.
 *
 * HOT SWAP is the other half of the design (`update`): a new `revision` from the
 * host's poll is applied IN PLACE, with the granularity the artifact hashes ask
 * for — actions only when just the clips moved, mesh when the glTF moved,
 * textures when only the images did. The new generation is built beside the old
 * one and adopted only once it is ready, so the pet never goes blank; the old
 * generation is then retired (mixer uncached, clip payload released, geometry /
 * material / texture disposed). Nothing is rebound, so the pet keeps its
 * position, size, panel state and camera across a swap.
 *
 * Phase mapping: the host resolves the four phase states onto clip NAMES
 * (`model.ts`), so this renderer only has to look the name up and loop it. A
 * name the payload does not carry falls back to the model's first clip — a
 * fresh import must never be able to freeze the pet or throw.
 *
 * Cost discipline (this is the only renderer holding a persistent WebGL
 * context): the frameloop is capped by maxFps, suspended when the container
 * leaves the viewport or the document is hidden, and never allocated at all
 * when the container has no area.
 * @module dsh-pet-3d/client/renderers/model3d
 */

import {
  buildClipBundle,
  loadClipIndex,
  loadClipPayload,
  releaseClipBundle,
  type ClipBundle,
  type ClipFactory,
  type ClipIo,
} from '../../clips.ts'
import { planSwap, type SwapPlan } from '../../hot-swap.ts'
import { DEFAULT_CHOREOGRAPHY, bridgeFor, expandPattern, parseChoreography, shortClipName, type Choreography, type PetPerformanceStep } from '../../choreography.ts'
import { pickClipForState, type PetModel3dToonView, type PetModel3dView } from '../../model.ts'
import { leadInBefore, type PhaseState } from '../../state.ts'
import { planBeat, triggerDelayMs } from '../../timeline.ts'
import type { PhaseStream } from '../phase-stream.ts'
import {
  ensureModel3dVendor,
  type Model3dVendor,
  type ThreeAnimationAction,
  type ThreeAnimationClip,
  type ThreeAnimationFinishedEvent,
  type ThreeAnimationMixer,
  type ThreeCamera,
  type ThreeGeometry,
  type ThreeMaterial,
  type ThreeMesh,
  type ThreeObject3D,
  type ThreeRenderTarget,
  type ThreeRenderer,
  type ThreeScene,
  type ThreeTexture,
  type ThreeVector2,
} from './model3d/runtime.ts'

/** Fatal mount failure codes the bridge localizes. */
export type Model3dErrorCode = 'vendor-missing' | 'load-failed'

/**
 * How far the activation has got.
 *
 * `model` — the character is on screen (bind pose, no action yet);
 * `index` — the clip list is known, the payload is still loading;
 * `ready` — every clip is registered and playable;
 * `failed` — the activation is dead (see the error sink).
 */
export type Model3dStage = 'boot' | 'model' | 'index' | 'ready' | 'failed'

/** What one hot swap actually did. */
export type SwapKindName = 'none' | 'clips' | 'textures' | 'mesh'

/** The model3d activation handle. */
export interface Model3dHandle {
  /** Tear the activation down; idempotent. */
  dispose(): void
  /** How far the load got. */
  stage(): Model3dStage
  /** One human-readable line about the current stage. */
  stageDetail(): string
  /** Clip names the index declares (empty until stage `index`). */
  clipNames(): string[]
  /** The clip the mixer is on right now, when there is one. */
  currentClip(): string | undefined
  /** True once the payload is assembled and the buttons should work. */
  clipsReady(): boolean
  /** Non-fatal clip problems (a malformed track, a failed payload fetch). */
  clipsProblems(): string[]
  /**
   * Names of the clips the mixer actually holds.
   *
   * A clip the index lists can still be unplayable: an EFFECT take (trail / dust /
   * aura / bullet fade) animates material or particle properties, so the FBX
   * carries no bone tracks for it and there is nothing to hand a mixer. The panel
   * compares this against {@link clipNames} to say which buttons can do anything,
   * instead of failing silently on click.
   */
  registeredClipNames(): string[]
  /**
   * 面板显示用的名字与说明（导入时由名称对照表带进来）。
   *
   * 只给显示：内部仍然用英文 id 做一切判断（编排三段、相位挑选、守卫断言）。
   * 没有对照表条目的 clip 返回 undefined，面板就退回显示英文名。
   */
  clipMeta(name: string): { displayName?: string; usage?: string; caution?: string } | undefined
  /**
   * 换一套"什么时候做什么动作"（用户在编排器里改的）。
   *
   * 立刻生效：下一次切状态/下一次点它/下一次彩蛋就用新配置。传 `undefined` 回到内置缺省。
   * @param raw - `choreography.json` 的原始内容（未校验的也行，坏字段会被忽略并回报）。
   * @returns 校验发现的问题（面板显示用）。
   */
  setChoreography(raw: unknown): string[]
  /** The revision currently on screen. */
  loadedRevision(): string
  /**
   * Adopt a new view of the same model, swapping only what changed.
   * @param next - the freshly polled view (its `revision` / `artifacts` decide).
   * @returns what was swapped.
   */
  update(next: PetModel3dView): Promise<SwapKindName>
  /** True while a hot swap is in flight (the old generation keeps rendering). */
  swapping(): boolean
  /** The last hot-swap failure, if any — shown on the panel, never swallowed. */
  swapError(): string | undefined
  /** GPU-side resource counters, read straight off the renderer. */
  memory(): { geometries: number; textures: number }
  /**
   * 开发者调试：把画布底色换成不透明纯色（默认 `#ff0000`），用来"找漏"。
   *
   * 怎么用：涂红之后，模型上任何**破洞 / 缝隙 / 没缝上**的地方都会透出红色；
   * 模型贴合完整时，红色只出现在轮廓之外。传 `null` 恢复透明底色。
   * 只影响渲染器的 clear color，不动任何网格与材质。
   * @param color - 不透明底色；`null` = 恢复透明。
   */
  setBackdrop(color: string | null): void
  /**
   * Play one clip by name right now.
   * @param loop - hold it (until `回常态`) instead of playing it once and
   *   handing the mixer back to the phase clip.
   * @returns whether the clip is registered and the mixer took it.
   */
  playNamed(name: string, loop?: boolean): boolean
  /** Hand the mixer back to the clip the current phase state maps to. */
  clearManual(): void
  /**
   * 演一套"演出"（`choreography.json` 的 `performances`）：按顺序连播，演完回当前相位。
   *
   * 与 `playNamed` 的区别：`playNamed` 是单条试播（放完就回相位），演出是**一整段**，
   * 期间相位变化被屏蔽 —— 这正是"一瞬间演完一整套曲子"要的语义。
   * @param request - 演出 id（只用于显示）与步骤。
   * @returns 是否真的开演；步骤全部解析不到 clip 时返回 false。
   */
  playPerformance(request: { id: string; steps: readonly PetPerformanceStep[] }): boolean
  /** 停下正在演的演出并回当前相位；没有演出时无操作。 */
  stopPerformance(): void
  /** 此刻正在演的演出 id（没有则 undefined）。 */
  performanceId(): string | undefined
  /** Freeze / resume the animation clock (the scene keeps rendering). */
  setPaused(paused: boolean): void
  paused(): boolean
  /** Playback rate for every action. */
  setSpeed(speed: number): void
  speed(): number
  /** Aim the camera: yaw / pitch in degrees, `framing` as the height fraction. */
  setView(view: { yaw?: number; pitch?: number; framing?: number }): void
  /**
   * 按节点名隐藏/显示部件（配饰穿脱）。
   *
   * 名字是 glTF 节点名（`body_acc3`、`PanYinhu_ModHat`…），**模型自带的**，不是渲染器编的；
   * 传进来的整张表就是"要藏起来的那些节点"，没在表里的恢复可见。隐含三条语义：
   *  - 隐式连带：描边壳叫 `<网格名>__outline`，藏网格时必须一起藏，否则会剩一圈黑边；
   *  - 幂等 & 可重放：热换模型会换掉整棵场景图，所以这张表**记在句柄上**，换完自动重放；
   *  - 不动相机：相机在装载时按**整个模型**拟合，藏一件配饰不该让镜头突然推近。
   * @param names - 要隐藏的节点名；不认识的忽略（数据可以比模型新）。
   */
  setHiddenNodes(names: readonly string[]): void
  /**
   * The camera as it stands.
   *
   * Read back after a hot swap by the offline guard: "位置 / 大小 / 视角不变" is
   * only a claim until something compares the numbers.
   */
  camera(): { yaw: number; pitch: number; framing: number; position: { x: number; y: number; z: number } }
  /** Subscribe to load-stage changes (fired once per transition). */
  onStage(listener: (stage: Model3dStage, detail: string) => void): void
  /** Subscribe to fatal mount errors (at most one fires per activation). */
  onError(listener: (code: Model3dErrorCode) => void): void
  /** One line of runtime state, rendered on screen by the panel. */
  debug(): string
}

/** What a mount needs. */
export interface Model3dMountOptions {
  container: HTMLElement
  /** The host-resolved view of the model folder. */
  view: PetModel3dView
  /** The host's phase stream (change-only). */
  phase: PhaseStream
  /** Test seam: the vendor loader (defaults to the runtime bundle). */
  vendor?: () => Promise<Model3dVendor | undefined>
  /** Test seam: the clip-IO (defaults to same-origin fetch). */
  io?: ClipIo
}

interface Size {
  width: number
  height: number
}

/**
 * One loaded generation of the model.
 *
 * Ownership is per generation on purpose: a hot swap builds the next generation
 * beside the current one, and retiring the old one must release exactly what the
 * old one created — no more (the new one is live) and no less (that is the leak).
 */
interface Generation {
  revision: string
  artifacts: Record<string, string>
  root?: ThreeObject3D
  wrapper?: ThreeObject3D
  rigSize?: Size
  mixer?: ThreeAnimationMixer
  bundle?: ClipBundle
  clipNames: string[]
  currentAction?: ThreeAnimationAction
  currentClipName?: string
  geometries: ThreeGeometry[]
  materials: ThreeMaterial[]
  textures: ThreeTexture[]
}

/**
 * The cel-shading pass: replace every mesh material and, when the outline is on,
 * add a back-face shell.
 *
 * WHAT IS PRESERVED FROM THE SOURCE MATERIAL MATTERS. This pass used to keep only
 * `color` and `map`, throwing away exactly the maps that carry a character's
 * surface detail — the normal map first of all. The result reads as "the
 * textures are broken": flat blotchy limbs and blocky shading, because no detail
 * was left to shade. Every surface map is therefore carried over, and the colour
 * spaces come with them (base colour is sRGB, normal/roughness/AO are linear;
 * swapping them is the classic washed-out or over-dark texture bug).
 *
 * The outline shell is an inverted hull. A NODE-SCALE trick cannot build one for
 * a skinned mesh: `bindMode: 'attached'` makes the shader cancel the mesh's own
 * world matrix, so `shell.scale` is a no-op and the shell lands EXACTLY on the
 * body — z-fighting, i.e. black speckle and grid-like patches. The shell is
 * therefore expanded in the vertex shader, along the SKINNED normal, by an amount
 * converted from world units into the mesh's local units.
 * @param vendor - the three surface.
 * @param root - the loaded model root.
 * @param config - resolved toon options.
 * @param owned - collects every material created here, for the owner to dispose.
 */
export function applyToonPass(
  vendor: Model3dVendor,
  root: ThreeObject3D,
  config: PetModel3dToonView,
  owned: ThreeMaterial[],
): void {
  if (!config.enabled) return
  const meshes: ThreeMesh[] = []
  root.traverse((child) => {
    const mesh = child as ThreeMesh
    if (mesh.isMesh === true || mesh.isSkinnedMesh === true) meshes.push(mesh)
  })
  for (const mesh of meshes) {
    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    if (source === undefined) continue
    const toonMaterial = new vendor.MeshToonMaterial({
      color: source.color === undefined ? 0xffffff : source.color.clone(),
      transparent: source.transparent === true,
      opacity: source.opacity ?? 1,
      vertexColors: source.vertexColors === true,
      side: source.side ?? vendor.FrontSide,
      ...(source.map === undefined ? {} : { map: source.map }),
      // The normal map is the whole point: without it a smooth limb has no
      // surface detail left to shade, and a cel ramp turns it into flat patches.
      // three derives the tangent frame from screen-space derivatives when the
      // geometry has no TANGENT attribute, so this works on this asset as-is.
      ...(source.normalMap === undefined ? {} : { normalMap: source.normalMap }),
      ...(source.normalScale === undefined ? {} : { normalScale: source.normalScale }),
      ...(source.aoMap === undefined ? {} : { aoMap: source.aoMap }),
      ...(source.alphaMap === undefined ? {} : { alphaMap: source.alphaMap }),
      ...(source.emissiveMap === undefined ? {} : { emissiveMap: source.emissiveMap }),
      ...(source.emissive === undefined ? {} : { emissive: source.emissive.clone() }),
    })
    owned.push(toonMaterial)
    mesh.material = toonMaterial
    if (config.outlineWidth <= 0) continue
    const worldScale = worldScaleOf(mesh)
    const localWidth = config.outlineWidth / worldScale
    const outlineMaterial = new vendor.MeshBasicMaterial({ color: config.outlineColor, side: vendor.BackSide })
    owned.push(outlineMaterial)
    expandAlongNormal(outlineMaterial, localWidth)
    if (mesh.isSkinnedMesh === true && mesh.skeleton !== undefined) {
      // A skinned shell must share the original skeleton or it detaches from the
      // animation; its own node scale is cancelled by attached-mode skinning, so
      // the expansion has to happen in the shader (see expandAlongNormal).
      const bind = mesh.bind
      if (bind === undefined) continue
      const shell = new vendor.SkinnedMesh(mesh.geometry, outlineMaterial)
      bind.call(shell, mesh.skeleton, mesh.bindMatrix)
      shell.name = mesh.name + '__outline'
      mesh.parent?.add(shell)
    } else {
      const shell = new vendor.Mesh(mesh.geometry, outlineMaterial)
      shell.name = mesh.name + '__outline'
      mesh.parent?.add(shell)
    }
  }
}

/** The uniform world scale of one object, read off its world matrix. */
export function worldScaleOf(object: ThreeObject3D): number {
  const elements = object.matrixWorld?.elements
  if (elements === undefined) return 1
  const sx = Math.hypot(elements[0], elements[1], elements[2])
  return Number.isFinite(sx) && sx > 0 ? sx : 1
}

/**
 * Make an inverted hull grow along its normals, in the vertex shader.
 *
 * `localWidth` is the thickness in the mesh's LOCAL units, applied after three's
 * skinning chunk so the offset follows the animated pose and is unaffected by
 * the node's own (possibly 100x) unit conversion.
 * @param material - the shell's material, patched in place.
 * @param localWidth - thickness in local units.
 */
export function expandAlongNormal(material: ThreeMaterial, localWidth: number): void {
  if (material.onBeforeCompile === undefined || !Number.isFinite(localWidth) || localWidth <= 0) return
  material.onBeforeCompile = (shader) => {
    const amount = localWidth.toFixed(6)
    shader.vertexShader = shader.vertexShader.replace(
      '#include <skinning_vertex>',
      `#include <skinning_vertex>\n\ttransformed += objectNormal * float(${amount});`,
    )
  }
  material.needsUpdate = true
}

/** Cross-fade length between clips, ms（给我们自己看的单位；three 要的是**秒**）。 */
const FADE_MS = 220
/**
 * 交给 three 的那个数。
 *
 * ★ 这里踩过一个**持续很久都没被发现的**大坑：three 的 `fadeIn/fadeOut/crossFadeTo`
 * 第二个参数是**秒**，`AnimationMixer.time` 也是秒。直接把 `FADE_MS`（220）传进去，
 * 得到的是一次 **220 秒**的交叉淡入淡出 —— 于是每次换动作，上一条全身动作会在接下来
 * 三分钟里以 0.99 → 0.6 的权重继续和新的那条**一起驱动同一批 138 根骨骼**，画面上就是
 * 用户反复报的"角色像在同时做两套动作、很别扭、有时像卡住"。
 *
 * 佐证（`tools/probe-acts.mjs`，按帧读 `acts=`）：修之前换一次状态能同时留下 2~4 条
 * 权重 ≈1 的全身动作、且 8 秒都不回落；把单位换成秒之后，多动作窗口收敛到 ~220ms。
 */
const FADE_SECONDS = FADE_MS / 1000

/**
 * 过桥用的淡出时长（秒），比常规交替换短。
 *
 * 为什么单独一条：桥的每一步只有 0.32~0.42s（`Trans_XXtoYY`），而常规淡出是 220ms
 * —— 一步的淡出还没走完，下一步就开始淡入，相邻两步天然叠在一起。链上有 3 步时
 * （`run>done` 就是 3 步），`probe-acts` 会量到 0.8s 的"两个动作同时在动"。
 * 120ms 让每一步的淡出在下一步结束前收干净，同时仍然看得见"过渡"而不是硬切。
 */
const BRIDGE_FADE_SECONDS = 0.12

/**
 * 哪些相位状态是**"一拍"**（起手 → 动作 → 收招，然后回待机），而不是持续状态。
 *
 * 用户定的编排：
 *   · 常态 = **待机 ↔ 待机**（一直待在 idle，偶尔换一条待机动作）；
 *   · 要做别的动作时：**先起手** → 做动作 → **回归平静（收招）** → **回到待机**。
 * 所以 `busy` 是持续状态（干活期间一直跑），而 `done`/`failed` 是**一拍**：
 * 高兴/难过各演一遍（起手→循环一遍→收招）就回待机，不会把情绪循环一直挂着。
 */
const BEAT_STATES: readonly PhaseState[] = ['done', 'failed']
const isBeatState = (state: PhaseState): boolean => BEAT_STATES.includes(state)

/** 一段"剧情演出"（点一下宠物 / 闲置彩蛋叫出来的）。 */
interface GuestSequence {
  /** 循环片名（三段里的中间那段）。 */
  name: string
  sequence: { enter?: string; loop?: string; exit?: string }
  step: 'enter' | 'loop' | 'exit'
  /** 循环段放几遍再收尾。 */
  loops: number
}
/** Field of view the camera is framed with; 30° reads as a portrait lens. */
const FOV_DEGREES = 30
/** Speed range the panel may ask for. */
const SPEED_MIN = 0.1
const SPEED_MAX = 2

/**
 * The height every model is normalized to, in world units.
 *
 * One number standing for "how big a pet is": the camera frames this height, so
 * models authored in centimetres, metres or toy units all look the same size on
 * screen, and `options.json.scale` is a fine-tune rather than a mandatory unit
 * conversion — which is exactly the hand-tuning the user asked not to need.
 */
export const CANONICAL_MODEL_HEIGHT = 1

/**
 * How far a per-model `scale` may deviate from the canonical size.
 *
 * Clamped because a factor written for the old absolute-units meaning (this
 * project's own `panyinhu/options.json` briefly carried `0.0134`) would
 * otherwise shrink the pet into an invisible speck.
 */
const SCALE_MIN = 0.25
const SCALE_MAX = 4

/** What one measured fit produced. */
export interface RigFit {
  /** Multiplier applied to the loaded root's own scale. */
  applied: number
  /** Where the root moved so the measured centre lands on the render origin. */
  position: { x: number; y: number; z: number }
  /** The fitted size, which the camera frames. */
  size: { width: number; height: number; depth: number }
  /** The measured world size before the fit, for diagnostics. */
  measured: { width: number; height: number; depth: number }
  /** Set when the measurement was unusable, so the fit was skipped. */
  warning?: string
}

/**
 * Measure a loaded model and fit it to {@link CANONICAL_MODEL_HEIGHT}.
 *
 * THREE THINGS HERE ARE LOAD-BEARING, and each of them was a blank pet once:
 *
 *  1. `updateMatrixWorld(true)` FIRST. A `SkinnedMesh`'s bounding box is
 *     computed through `bindMatrixInverse`, and only
 *     `SkinnedMesh.updateMatrixWorld()` refreshes that (it is derived from the
 *     mesh's own world matrix). Measuring straight after the loader — or after
 *     `VRMUtils` rewrote the meshes — therefore reads a STALE cache and reports
 *     the model in a pre-node-scale space: on an asset whose mesh nodes carry a
 *     100x unit conversion, that measurement is 100x too big.
 *  2. `setFromObject(root, true)`: the precise path walks real vertex positions
 *     through `getVertexPosition`, i.e. the very skinning math the vertex shader
 *     runs, so the box describes what gets drawn instead of what a cached
 *     bind-pose box claims.
 *  3. Normalize to a canonical HEIGHT, so the camera distance is always a sane
 *     number of world units. A camera parked 100x too far sits outside its own
 *     far plane, and three then culls every mesh: no pixels, no error.
 * @param vendor - the three surface (Box3 / Vector3).
 * @param root - the loaded model root.
 * @param options - `scale`, a fine-tune multiplier on the canonical size.
 * @returns the fit, which the caller applies to the root.
 */
export function fitRig(
  vendor: Model3dVendor,
  root: ThreeObject3D,
  options: { scale?: number } = {},
): RigFit {
  root.updateMatrixWorld(true)
  const box = new vendor.Box3().setFromObject(root, true)
  const measured = box.getSize(new vendor.Vector3())
  const center = box.getCenter(new vendor.Vector3())
  const identity: RigFit = {
    applied: 1,
    position: { x: root.position.x, y: root.position.y, z: root.position.z },
    size: { width: 1, height: 1, depth: 1 },
    measured: { width: measured.x, height: measured.y, depth: measured.z },
  }
  const finite = [measured.x, measured.y, measured.z, center.x, center.y, center.z]
    .every(value => Number.isFinite(value))
  if (!finite || measured.y <= 0) {
    // Never let an unmeasurable model poison the camera: keep the asset as it
    // loaded and say so, instead of moving the camera to a NaN distance.
    return { ...identity, warning: '模型尺寸无法测量（非有限值或高度为 0），已跳过缩放居中' }
  }
  const multiplier = clamp(options.scale ?? 1, SCALE_MIN, SCALE_MAX, 1)
  const applied = (CANONICAL_MODEL_HEIGHT / measured.y) * multiplier
  const pivot = { x: root.position.x, y: root.position.y, z: root.position.z }
  root.scale.multiplyScalar(applied)
  // World positions are `pivot + scale * local`, so scaling moves the measured
  // centre to `pivot + applied * (center - pivot)`; this cancels exactly that.
  root.position.set(
    pivot.x - applied * (center.x - pivot.x),
    pivot.y - applied * (center.y - pivot.y),
    pivot.z - applied * (center.z - pivot.z),
  )
  return {
    applied,
    position: { x: root.position.x, y: root.position.y, z: root.position.z },
    size: { width: measured.x * applied, height: measured.y * applied, depth: measured.z * applied },
    measured: { width: measured.x, height: measured.y, depth: measured.z },
  }
}

/** Clamp a finite number into [min, max], falling back when not finite. */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return value < min ? min : value > max ? max : value
}

/** Ignore hidden/zero boxes; a zero-area container never allocates a context. */
function normalizeSize(width: number, height: number): Size | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
}

/** An empty generation with identity fields filled in. */
function newGeneration(view: PetModel3dView): Generation {
  return {
    revision: view.revision,
    artifacts: { ...view.artifacts },
    clipNames: [],
    geometries: [],
    materials: [],
    textures: [],
  }
}

/** The same-origin clip IO the browser half uses. */
export function browserClipIo(): ClipIo {
  return {
    async fetchJson(url: string): Promise<unknown> {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${response.status} ${url}`)
      return response.json()
    },
    async fetchPayload(url: string): Promise<Float32Array> {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${response.status} ${url}`)
      const buffer = await response.arrayBuffer()
      // Float32Array over the fetched buffer is the payload as the importer
      // wrote it: little-endian float32, no conversion, no copy beyond the one
      // the network already made.
      return new Float32Array(buffer)
    },
  }
}

/**
 * Mount one model activation.
 * @param options - the container, the view, the phase stream and the seams.
 * @returns the handle the stage and the panel drive.
 */
export function mountModel3d(options: Model3dMountOptions): Model3dHandle {
  const { container, phase: phaseStream } = options
  const io = options.io ?? browserClipIo()
  const loadVendor = options.vendor ?? (() => ensureModel3dVendor())
  let view = options.view
  let framing = clamp(view.framing, 0.05, 4, 1)
  let yawDegrees = view.yaw ?? 0
  /** Vertical orbit for the inspection panel. 0 keeps the shipped straight-on view. */
  let pitchDegrees = 0
  const maxFps = Math.round(clamp(view.maxFps, 1, 60, 30))

  let disposed = false

  /**
   * 加载遮罩（用户要求）：从"模型上屏"到"第一次真正摆好姿势"之间，画面上是 **T-pose**，
   * 太难看了。这段时间用一块"正在加载模型…"把它盖住；姿势一到位就淡出摘掉。
   *
   * 判据是**有动作真的在驱动骨架**（权重 > 0.5），而不是 `stage === 'ready'`：
   * `ready` 只说明网格和动作数据都就位了，之后还要等第一次 `enterState` 把权重抬起来，
   * 那之间正是 T-pose 露出来的时间。
   */
  let loadingOverlay: HTMLDivElement | undefined
  let posedOnce = false

  /** 盖上加载遮罩（幂等）：直接在容器上挂一块纯 DOM，不经过 React。 */
  const showLoading = (): void => {
    if (loadingOverlay !== undefined || disposed) return
    // 转圈动画的 keyframes 只注入一次（侧栏可能同时挂多个宠物实例）。
    if (document.getElementById('dsh-pet3d-spin') === null) {
      const keyframes = document.createElement('style')
      keyframes.id = 'dsh-pet3d-spin'
      keyframes.textContent = '@keyframes dshPet3dSpin{to{transform:rotate(360deg)}}'
      document.head.append(keyframes)
    }
    const el = document.createElement('div')
    el.setAttribute('data-pet3d-loading', '')
    const spinner = document.createElement('span')
    Object.assign(spinner.style, {
      width: '12px', height: '12px', borderRadius: '50%',
      border: '2px solid #3a4453', borderTopColor: '#9fb3c8',
      animation: 'dshPet3dSpin .8s linear infinite',
    })
    el.append(spinner, document.createTextNode('正在加载模型…'))
    Object.assign(el.style, {
      position: 'absolute', inset: '0', display: 'flex', alignItems: 'center',
      justifyContent: 'center', gap: '8px', borderRadius: '10px',
      background: 'rgba(6, 7, 9, 0.99)',
      color: '#c8d2e0', font: '12px/1.4 system-ui, sans-serif', letterSpacing: '0.3px',
      transition: 'opacity .2s ease', pointerEvents: 'none', zIndex: '1',
    })
    container.append(el)
    loadingOverlay = el
  }

  /** 淡出并摘掉遮罩（幂等）。 */
  const hideLoading = (): void => {
    const el = loadingOverlay
    loadingOverlay = undefined
    if (el === undefined) return
    el.style.opacity = '0'
    window.setTimeout(() => el.remove(), 220)
  }

  showLoading()

  let vendor: Model3dVendor | undefined
  let renderer: ThreeRenderer | undefined
  let scene: ThreeScene | undefined
  let camera: ThreeCamera | undefined
  /**
   * 可调的两盏灯（2026-10-18）：`render.ambient` / `render.fill`。
   *
   * 为什么需要：toon 分级把**背光面**压进最暗档，下巴、腋下、裙摆内侧这些朝下的面就成一团黑，
   * 看起来像"贴图黑块"、其实是阴影。抬环境光或加一盏前下方补光能把暗部托起来 ——
   * 比改贴图安全（不动美术资产），而且能实时调。
   */
  let ambientLight: (ThreeObject3D & { intensity: number }) | undefined
  let fillLight: (ThreeObject3D & { intensity: number }) | undefined
  /** 环境光基准（`render.ambient = 1` 时用这个值）。 */
  const BASE_AMBIENT = 0.62
  /** 补光基准（`render.fill = 1` 时用这个值；缺省 0 = 不补）。 */
  const BASE_FILL = 0.8
  let clock: { getDelta(): number } | undefined
  /** The generation on screen. */
  let live = newGeneration(view)
  let manualLoop: string | undefined
  /** 调试底色（`setBackdrop` 设的），`null` = 透明。只给仪表回读用。 */
  let backdropColor: string | null = null
  /**
   * True while a LoopOnce action owns the mixer.
   *
   * A phase update must not cut a one-shot in half: the action is short, and its
   * `finished` handler re-applies the resting phase. Reported as `os=` on the
   * panel's instrument, where "is a one-shot in flight?" decides whether a
   * surprise clip name is a bug or just the panel's own request.
   */
  let oneShotActive = false
  /**
   * 编排状态：当前正在执行哪个相位状态、走到三段式的哪一段、退出段放完要去哪。
   *
   * `sequenceStep` 是 `idle`（还没编排）／`enter`（进入段在放）／`loop`（循环段在跑）／
   * `exit`（退出段在放）。面板的仪表把它打成 `seq=<state>:<step>`，守卫据此验证
   * "跑开始→跑循环→跑结束"真的按顺序发生了。
   */
  let currentState: PhaseState | undefined
  let sequenceStep: 'idle' | 'enter' | 'loop' | 'exit' = 'idle'
  let pendingState: PhaseState | undefined
  /** 正在放谁家的"退出段"：退出期间 `currentState` 已经清空，但仪表要能报出是哪个状态在收尾。 */
  let exitingFrom: PhaseState | undefined
  /** 正在放的"桥"（跨状态过渡）：一串依次播一次的 clip，`index` 是游标。 */
  let bridge: { chain: string[]; index: number } | undefined
  /** 上一次真正"在播"的状态，用来选桥的起点。 */
  let lastPlayedState: PhaseState | undefined
  /** 动作总闸：上一次"触发一个动作"的时刻，以及"延后触发"的定时器。 */
  let lastTriggerMs: number | undefined
  let triggerTimer: number | undefined
  /** `finished` 事件收了多少个、多少个因为"不是当前 action"被忽略（排查编排卡住用）。 */
  let finishedEvents = 0
  let finishedSkipped = 0
  /** 正在演的"剧情"（点一下宠物 / 闲置彩蛋）；非空期间相位更新不打断。 */
  let guest: GuestSequence | undefined
  /** 正在演"一拍"（done/failed 的 起手→循环→收招）；期间不打断。 */
  let beatActive = false
  /** 哪个"一拍"已经演过一轮了（相位不变就不重演，避免情绪循环刷屏）。 */
  let beatPlayed: PhaseState | undefined
  /**
   * 用户排的"什么时候做什么动作"（`choreography.json`）。
   *
   * 缺省就是内置约定；配置里写了的优先。这样"改数据就能改编排"，不用动代码、不用重启。
   */
  let choreography: Choreography = DEFAULT_CHOREOGRAPHY
  /** 当前配置的内容签名（避免"每 2 秒重来一遍"）。 */
  let choreographySignature = ''
  /** 被"关掉形态键"摘掉形态键的几何个数（仪表报数用）。 */
  let morphsStripped = 0
  /** Times the frameloop had to be restarted after it had been parked. */
  let loopRescues = 0
  let paused = false
  let rate = 1
  let lastState: PhaseState = 'idle'
  let stage: Model3dStage = 'boot'
  let stageDetail = '启动中'
  let swapping = false
  let swapError: string | undefined
  let swaps = 0
  let lastSwap: SwapKindName = 'none'
  let stageListener: ((stage: Model3dStage, detail: string) => void) | undefined
  let errorListener: ((code: Model3dErrorCode) => void) | undefined
  let manualPlay: string | undefined
  /** 显示用元数据（中文名 / 用途 / 慎用），按英文 id 索引；只服务面板。 */
  const clipMeta = new Map<string, { displayName?: string; usage?: string; caution?: string }>()
  const clipProblems: string[] = []
  let phaseUnsubscribe: (() => void) | undefined
  let frameHandle: number | undefined
  let inViewport = true
  let pageHidden = typeof document !== 'undefined' && document.hidden
  let lastFrameAt = 0
  let onDocumentVisibility: (() => void) | undefined
  let intersectionObserver: IntersectionObserver | undefined
  let resizeObserver: ResizeObserver | undefined
  /** Frames actually rendered, and frame-body errors swallowed. */
  let frames = 0
  let frameErrors = 0
  let lastFrameError: string | undefined

  /** Release the frameloop exactly once. */
  const stopLoop = (): void => {
    if (frameHandle !== undefined) window.cancelAnimationFrame(frameHandle)
    frameHandle = undefined
  }

  /** Move to a new load stage, announcing it once. */
  const setStage = (next: Model3dStage, detail: string): void => {
    // 失败时把加载遮罩撤掉，否则错误提示会被它盖住（用户会一直看到"正在加载模型…"）。
    if (next === 'failed') {
      posedOnce = true
      hideLoading()
    }
    stage = next
    stageDetail = detail
    stageListener?.(next, detail)
  }

  /** Fit the camera to the container and the model's measured height. */
  const layout = (): void => {
    if (disposed || renderer === undefined || camera === undefined) return
    const size = normalizeSize(container.clientWidth, container.clientHeight)
    if (size === undefined) return
    const aspect = size.width / size.height
    renderer.setSize(size.width, size.height, false)
    renderer.setPixelRatio(Math.min(2, Math.max(1, window.devicePixelRatio || 1)))
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    // The model is centered on the rig origin, so the camera is a plain orbit:
    // `framing` says how much of the model's height should fill the container
    // (1 = the whole model, higher crops in toward a portrait).
    const modelHeight = live.rigSize?.height ?? 1
    const modelWidth = live.rigSize?.width ?? 1
    const visibleHeight = modelHeight / framing
    const visibleWidth = visibleHeight * aspect
    const halfFov = Math.tan((FOV_DEGREES * Math.PI / 180) / 2)
    const distanceForHeight = (visibleHeight / 2) / halfFov
    const distanceForWidth = (Math.max(modelWidth, visibleWidth) / 2) / (halfFov * aspect)
    const distance = Math.max(distanceForHeight, distanceForWidth) * 1.04
    const radians = (yawDegrees * Math.PI) / 180
    // Pitch tilts the orbit: the horizontal radius shrinks as the camera rises,
    // so the model stays the same distance away at every angle.
    const tilt = (pitchDegrees * Math.PI) / 180
    const flat = Math.cos(tilt) * distance
    camera.position.set(Math.sin(radians) * flat, Math.sin(tilt) * distance, Math.cos(radians) * flat)
    camera.lookAt(0, 0, 0)
    // Clip planes derived from the fit, never a fixed pair: a hardcoded far plane
    // silently swallows a model that is merely bigger than its author expected,
    // and three reports that as "culled" — a blank pet with no error.
    const extent = Math.hypot(modelWidth, modelHeight)
    camera.near = Math.max(0.001, distance / 1000)
    camera.far = distance * 4 + extent * 2
    camera.updateProjectionMatrix()
  }

  /**
   * One mixer step plus one render, self-rescheduling while eligible.
   *
   * The two halves are guarded separately on purpose: a throw from the mixer
   * must not also cost the render, and neither may cost the reschedule.
   */
  const tick = (): void => {
    frameHandle = undefined
    if (disposed || renderer === undefined || scene === undefined || camera === undefined) return
    pageHidden = typeof document !== 'undefined' && document.hidden
    if (!inViewport || pageHidden) return
    const now = performance.now()
    if (now - lastFrameAt < 1000 / maxFps) {
      frameHandle = window.requestAnimationFrame(tick)
      return
    }
    /**
     * ★ 帧率上限要**累加对齐**，不能把 `lastFrameAt` 直接设成 `now`。
     *
     * `requestAnimationFrame` 只能落在显示器的一拍上，所以实际帧间隔会被**向上取整到整拍**：
     * 165Hz 的屏幕上 30fps 需要 5.5 拍，取整成 6 拍就是 36.36ms ⇒ **只有 27.5fps**
     * （这台机器的屏就是 165Hz，实测就是 27.5，一直以为是"漏帧 bug"，其实是取整）。
     * 改成累加 `lastFrameAt += 间隔`，误差会**结转到下一帧**：5 拍、6 拍交替 ⇒ 平均正好 30fps。
     * 代价是帧间隔有 ±1 拍（≈6ms）的抖动，比稳定掉到 27.5 更看不出来。
     *
     * 另外要防"追帧"：页面被挂起很久再回来时，累加值会落在过去很远，
     * 于是连续补帧 —— 这里一旦落后超过一个间隔就直接对齐到 now。
     */
    lastFrameAt += 1000 / maxFps
    if (now - lastFrameAt > 1000 / maxFps) lastFrameAt = now
    try {
      // `dt` 取一次就够：混音器和演出用同一个帧间隔（分开取会把这一帧的时间算两遍，
      // 演出的限时步骤会比实际快一倍）。
      const loopSecondsDelta = clock === undefined ? 0 : clock.getDelta()
      if (!paused && live.mixer !== undefined) live.mixer.update(loopSecondsDelta)
      if (!paused) {
        advancePerformance(loopSecondsDelta)
        // 诊断：记录"两个以上动作同时有权重"的最长连续时长（`worst2=` 字段）
        trackOverlap(loopSecondsDelta)
        // 兜底：把停在满权重、又不是当前动作的残留淡掉（见 sweepStrayActions 的注释）。
        sweepStrayActions(loopSecondsDelta)
      }
    } catch (error) {
      frameErrors++
      lastFrameError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    /**
     * 姿势到位的判据：**有动作真的在驱动骨架**（权重过半）。
     * 一旦成立就摘遮罩，之后再也不会盖回去（除非热换模型）。
     */
    if (!posedOnce) {
      const driven = live.currentAction as unknown as { getEffectiveWeight?: () => number } | undefined
      if ((driven?.getEffectiveWeight?.() ?? 0) > 0.5) {
        posedOnce = true
        hideLoading()
      }
    }
    try {
      renderFrame()
      frames++
    } catch (error) {
      frameErrors++
      lastFrameError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    frameHandle = window.requestAnimationFrame(tick)
  }

  /** (Re)start the frameloop when eligible, park it otherwise. */
  const syncLoop = (): void => {
    const eligible = !disposed && inViewport && !pageHidden && renderer !== undefined
    if (eligible && frameHandle === undefined) {
      // Restarting a loop that had already drawn frames is the closest thing this
      // kernel has to the old watchdog's "the loop needed help" counter.
      if (frames > 0) loopRescues++
      // Drop the time spent parked so the first frame after resuming does not
      // advance the animation by the whole idle gap.
      clock?.getDelta()
      frameHandle = window.requestAnimationFrame(tick)
    } else if (!eligible) {
      stopLoop()
    }
  }

  /**
   * ★ 描边方式（2026-10-18）：`shell`（反向壳，缺省）/ `edge`（屏幕空间边缘检测）/ `off`。
   *
   * 为什么要有 `edge`：反向壳是"同一份几何沿法线外扩一圈纯黑、只画背面"。在**层叠薄片**
   * 上它必然翻车 —— 每片薄片都自带一圈黑壳，相邻薄片的黑壳从缝里露出来，于是夏日装的
   * 白毛上出现"黑块"、关节处出现"黑圈"（实测关掉描边立刻消失；原版 panyinhu 因为皮毛是
   * 实体几何所以干净）。这不是贴图问题，也不是分辨率问题，换多少张图都不会好。
   *
   * `edge` 把描边挪到屏幕空间：场景先渲进一个带 depthTexture 的 RT，再用全屏四边形按
   * 邻域深度差画 1~2px 的线。黑壳不再存在于几何里，薄片之间自然扎不出黑边。
   * 代价是多一个深度 pass（本机体量：59k 三角，30fps 上限下实测无感）。
   */
  type OutlineMode = 'shell' | 'edge' | 'off'
  const outlineMode = (): OutlineMode => {
    const mode = choreography.render?.outlineMode
    return mode === 'edge' || mode === 'off' ? mode : 'shell'
  }

  /** 反向壳只属于 `shell`：切走时把它们藏起来（不销毁，切回来还在，省一次重建）。 */
  let shellsFor: OutlineMode | undefined
  const OUTLINE_SUFFIX = '__outline'
  const syncOutlineShells = (mode: OutlineMode, force = false): void => {
    if (!force && shellsFor === mode) return
    shellsFor = mode
    const show = mode === 'shell'
    live.root?.traverse((child) => {
      if (typeof child.name !== 'string' || !child.name.endsWith(OUTLINE_SUFFIX)) return
      // 配饰被脱掉时它的壳也得跟着下线：只按模式打开壳，会让脱掉的帽子剩一圈黑边。
      const base = child.name.slice(0, -OUTLINE_SUFFIX.length)
      child.visible = show && !hiddenNodes.has(base)
    })
  }

  /** 用户脱下来的部件（按节点名）—— 句柄级状态，热换后要重放（见 setHiddenNodes）。 */
  let hiddenNodes = new Set<string>()
  /** 我们已经强制隐藏过的节点；恢复时只动这些，不去碰模型自己设的可见性。 */
  const forcedHidden = new Set<string>()

  /**
   * 把 {@link hiddenNodes} 应用到当前场景图（幂等，可在每次装载/热换后重放）。
   *
   * 只做"藏"，不做"显"：显示由 {@link setHiddenNodes} 里的恢复分支负责 —— 因为
   * "没设过就是模型原样"，一刀切成 visible=true 会把模型本身想做隐藏的节点也点亮。
   */
  const applyHidden = (): void => {
    const root = live.root
    if (root === undefined) return
    for (const name of hiddenNodes) {
      const node = root.getObjectByName(name)
      // 数据可以比模型新（表里写了、这一版模型没有这个节点）：跳过，别把"没找到"
      // 记成"我们藏过" —— 否则恢复时会把一个本来就想隐身的节点强行点亮。
      if (node === undefined) continue
      node.visible = false
      const shell = root.getObjectByName(name + OUTLINE_SUFFIX)
      if (shell !== undefined) shell.visible = false
      forcedHidden.add(name)
    }
  }

  /**
   * 边缘检测的两支着色器。
   *
   * 深度怎么来：**不依赖 depthTexture**（这里踩过坑：RT 的 depthTexture 在采样端读回来
   * 恒等于 1.0，也就是"远平面"，而同一张 RT 的**颜色**是好的 ⇒ 预渲染确实画了，是深度
   * 附件没生效）。改成老办法：预渲染时用一支"把线性深度打包进 RGBA"的材质，颜色缓冲就是
   * 深度图，32 位精度、不依赖任何扩展，也不再碰 depthTexture。
   *
   * 预渲染材质必须自己补齐 three 的顶点链（<begin_vertex> / <morphtarget_vertex> /
   * <skinning_vertex>）：这是 `scene.overrideMaterial`，不补的话蒙皮和表情就不会动，
   * 深度会和画面对不上（脸上有 29 个 morph）。
   *
   * 背景用**全零**当哨兵（清屏色本来就是 rgba(0,0,0,0)）；packDepthToRGBA 把 1.0 打包成
   * 0，所以不能用"白色=远"这种约定，必须显式判空。
   */
  const DEPTH_VERTEX_SHADER = `#include <common>
#include <morphinstance_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
varying float vViewZ;
void main() {
  // ★ <skinbase_vertex> 不能省：three 这一版的 <skinning_vertex> 用的是 boneMatX..W，
  //   而那几个 mat4 是由 <skinbase_vertex> 用 getBoneMatrix(skinIndex.*) 现算出来的。
  //   只 include <skinning_vertex> 会报 "'boneMatX' : undeclared identifier"（已踩）。
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  vViewZ = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}`
  const DEPTH_FRAGMENT_SHADER = `#include <packing>
uniform vec2 clip;      // (near, far)
varying float vViewZ;
void main() {
  float t = clamp((vViewZ - clip.x) / (clip.y - clip.x), 0.0, 1.0);
  gl_FragColor = packDepthToRGBA(t);
}`
  const EDGE_QUAD_VERTEX_SHADER = `varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`
  const EDGE_FRAGMENT_SHADER = `#include <packing>
uniform sampler2D tDepth;
uniform vec2 texel;
uniform vec2 clip;      // (near, far)
uniform float thickness;
uniform float threshold;
uniform vec3 lineColor;
varying vec2 vUv;

/** 该像素的视图距离（世界单位）；没有几何时返回远平面。 */
float distAt(vec2 uv) {
  vec4 packed = texture2D(tDepth, uv);
  // 清屏是 rgba(0,0,0,0)，而 packDepthToRGBA 把 1.0 也打包成 0 ⇒ 必须判空，
  // 不能拿"白=远"当约定（那样背景会被当成近处，整张画面全是边）
  if (packed.r + packed.g + packed.b + packed.a <= 0.0) return clip.y;
  return clip.x + unpackRGBAToDepth(packed) * (clip.y - clip.x);
}

void main() {
  vec4 here = texture2D(tDepth, vUv);
  if (here.r + here.g + here.b + here.a <= 0.0) discard;   // 背景上不画
  float center = distAt(vUv);
  vec2 o = texel * thickness;
  float d = max(max(abs(distAt(vUv + vec2(0.0, o.y)) - center), abs(distAt(vUv - vec2(0.0, o.y)) - center)),
                max(abs(distAt(vUv + vec2(o.x, 0.0)) - center), abs(distAt(vUv - vec2(o.x, 0.0)) - center)));
  // 斜向补一遍：只取 4 邻域时 45° 的轮廓会断成虚线
  d = max(d, max(max(abs(distAt(vUv + o) - center), abs(distAt(vUv + vec2(-o.x, o.y)) - center)),
                 max(abs(distAt(vUv + vec2(o.x, -o.y)) - center), abs(distAt(vUv - o) - center))));
  // 软边：硬 discard 会在斜轮廓上留下锯齿（实测一眼能看出来），这里按覆盖率给 alpha
  float alpha = smoothstep(threshold * 0.75, threshold, d);
  if (alpha <= 0.02) discard;
  gl_FragColor = vec4(lineColor, alpha);
}`

  interface OutlineOverlay {
    target: ThreeRenderTarget
    depthMaterial: ThreeMaterial
    material: ThreeMaterial
    uniforms: { [name: string]: { value: unknown } }
    scene: ThreeScene
    camera: ThreeCamera
    geometry: ThreeGeometry
    width: number
    height: number
  }
  let overlay: OutlineOverlay | undefined

  const disposeOverlay = (): void => {
    if (overlay === undefined) return
    overlay.target.dispose()
    overlay.depthMaterial.dispose()
    overlay.material.dispose()
    overlay.geometry.dispose()
    overlay = undefined
  }

  /** 建/换边缘检测的 RT、深度材质与全屏四边形（尺寸随画布走）。 */
  const ensureOverlay = (vendor3: Model3dVendor, width: number, height: number): OutlineOverlay | undefined => {
    if (overlay !== undefined && overlay.width === width && overlay.height === height) return overlay
    disposeOverlay()
    try {
      const target = new vendor3.WebGLRenderTarget(width, height, {
        depthBuffer: true,
        stencilBuffer: false,
        minFilter: vendor3.NearestFilter,
        magFilter: vendor3.NearestFilter,
        format: vendor3.RGBAFormat,
        type: vendor3.UnsignedByteType,
      })
      const clip = new vendor3.Vector2(0.01, 200)
      const depthMaterial = new vendor3.ShaderMaterial({
        uniforms: { clip: { value: clip } },
        vertexShader: DEPTH_VERTEX_SHADER,
        fragmentShader: DEPTH_FRAGMENT_SHADER,
        // body 是双面材质（薄片），深度材质也跟它一致，否则薄片背面不写深度、轮廓会缺一段
        side: vendor3.DoubleSide,
      })
      const material = new vendor3.ShaderMaterial({
        uniforms: {
          tDepth: { value: target.texture },
          texel: { value: new vendor3.Vector2(1 / width, 1 / height) },
          clip: { value: clip },
          // 线宽按**像素**算：1.35 在 348~500px 的舞台上大约是 1~2px
          thickness: { value: 1.6 },
          // 阈值是**世界单位**（宠物被归一化到高度 1）⇒ 0.012 ≈ 身高的 1.2%
          threshold: { value: 0.035 },
          lineColor: { value: new vendor3.Color(0x000000) },
        },
        vertexShader: EDGE_QUAD_VERTEX_SHADER,
        fragmentShader: EDGE_FRAGMENT_SHADER,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
      const geometry = new vendor3.PlaneGeometry(2, 2)
      const quad = new vendor3.Mesh(geometry, material)
      // 全屏四边形必须自己关剔除：它在相机近平面里，包围球算出来会判成"在视锥外"
      quad.frustumCulled = false
      const scene = new vendor3.Scene()
      scene.add(quad)
      const camera = new vendor3.OrthographicCamera(-1, 1, 1, -1, 0, 1)
      overlay = {
        target,
        depthMaterial,
        material,
        uniforms: material.uniforms,
        scene,
        camera,
        geometry,
        width,
        height,
      }
      return overlay
    } catch (error) {
      // 少了任何一样（老版本 vendor）就退回反向壳，绝不因为描边把宠物画没
      lastFrameError = error instanceof Error ? `edge-outline: ${error.message}` : String(error)
      return undefined
    }
  }

  /**
   * 画一帧（含可切换的描边）。
   *
   * 三趟：深度预渲染（overrideMaterial 打包深度）→ 正常上屏 → 叠全屏边缘。
   * 正常上屏那一次会把画布清成透明（宠物背景必须透明），所以叠加之前要关掉 autoClear。
   */
  const renderFrame = (): void => {
    if (renderer === undefined || scene === undefined || camera === undefined) return
    // 灯光旋钮：每帧读 choreography.json ⇒ 改文件 2 秒内生效（`ambient` 1 = 基准，`fill` 0 = 不补）
    const ambientScale = choreography.render?.ambient
    const fillScale = choreography.render?.fill
    if (ambientLight !== undefined && ambientScale !== undefined) ambientLight.intensity = BASE_AMBIENT * ambientScale
    if (fillLight !== undefined) fillLight.intensity = fillScale === undefined ? 0 : BASE_FILL * fillScale
    const mode = outlineMode()
    syncOutlineShells(mode)
    if (mode !== 'edge' || vendor === undefined) {
      renderer.render(scene, camera)
      return
    }
    const width = renderer.domElement.width
    const height = renderer.domElement.height
    const edge = ensureOverlay(vendor, width, height)
    if (edge === undefined) {
      renderer.render(scene, camera)
      return
    }
    const clip = edge.uniforms.clip?.value as ThreeVector2 | undefined
    if (clip !== undefined) {
      clip.x = camera.near
      clip.y = camera.far
    }
    // 手感旋钮走 choreography.json（每帧读 ⇒ 改文件 2 秒内生效，不用重载模型）
    const tunedThickness = choreography.render?.edgeThickness
    const tunedThreshold = choreography.render?.edgeThreshold
    if (tunedThickness !== undefined && edge.uniforms.thickness !== undefined) edge.uniforms.thickness.value = tunedThickness
    if (tunedThreshold !== undefined && edge.uniforms.threshold !== undefined) edge.uniforms.threshold.value = tunedThreshold
    // 1) 深度预渲染：用打包深度的材质覆盖整个场景
    const wasOverride = scene.overrideMaterial
    scene.overrideMaterial = edge.depthMaterial
    renderer.setRenderTarget(edge.target)
    try {
      renderer.render(scene, camera)
    } finally {
      renderer.setRenderTarget(null)
      scene.overrideMaterial = wasOverride
    }
    // 2) 正常上屏
    renderer.render(scene, camera)
    // 3) 叠描边（不能清屏，否则把刚画的宠物擦掉）
    renderer.autoClear = false
    try {
      renderer.render(edge.scene, edge.camera)
    } finally {
      renderer.autoClear = true
    }
  }

  /**
   *
   * 为什么需要兜底：`fadeOutOthers` 只在"有新动作开始"时被调用。某些罕见交错（相位轮询、
   * 200ms 总闸、桥链正好在换状态时收尾）会让一个过渡段停在满权重，而那一刻没有新动作启动
   * 去触发淡出 —— 实测 `probe-acts` 抓到过 `Trans_03to04` 与入场动作各 1.00 叠 3 秒。
   * 追这条路径的收益远小于代价，所以在帧循环里做一次周期检查。
   *
   * **只碰"没有任何权重插值"的动作**（`_weightInterpolant === null`）：正在交叉淡入淡出的
   * 那一对必须交给 three 自己走完，硬插一脚会让权重从 1 重新起跳（可见的一闪）。
   * @param dt - 帧间隔（秒）。
   */
  let sweepAccum = 0
  /** 每个动作"连续第几次被清道夫看到还压着权重"（WeakMap：随动作回收，不泄漏）。 */
  const strayStrikes = new WeakMap<object, number>()
  const sweepStrayActions = (dt: number): void => {
    if (!(dt > 0)) return
    sweepAccum += dt
    // 150ms：最坏情况"下一拍发现 + 220ms 淡出"≈ 370ms，仍远小于一次状态切换的观察窗口。
    if (sweepAccum < 0.15) return
    sweepAccum = 0
    const generation = live
    const mixer = generation.mixer as unknown as {
      _actions?: readonly unknown[]
      _isActiveAction?: (action: unknown) => boolean
    } | undefined
    if (mixer?._actions === undefined) return
    const owner = generation.currentAction
    if (owner === undefined) return
    for (const raw of mixer._actions) {
      if (raw === owner) continue
      const action = raw as {
        getEffectiveWeight?: () => number
        setEffectiveWeight?: (weight: number) => void
        fadeOut?: (duration: number) => void
        _weightInterpolant?: unknown
      }
      const weight = action.getEffectiveWeight?.() ?? 0
      if (weight <= 0.5) {
        strayStrikes.delete(action as object)
        continue
      }
      const strikes = (strayStrikes.get(action as object) ?? 0) + 1
      strayStrikes.set(action as object, strikes)
      if (strikes >= 2) {
        /**
         * 第二次还压着 ⇒ **硬收**。
         *
         * 为什么要到这一步：实测有些残留身上带着一个**不推进的淡出插值**（动作已播完被
         * `clampWhenFinished` 定住），`fadeOut` 再叫一次也没用，权重就一直是 1.00
         * —— `probe-acts` 因此偶发报"两动作叠加 0.8~3 秒"。对这种，直接置 0 才是对的：
         * 它本来就不该在驱动骨架。正常交叉淡入淡出不会被误伤（220ms 内就降到 0.5 以下了）。
         */
        action.setEffectiveWeight?.(0)
        strayStrikes.delete(action as object)
        continue
      }
      action.setEffectiveWeight?.(weight)
      action.fadeOut?.(FADE_SECONDS)
    }
  }

  /**
   * 诊断：**连续"两个以上动作同时有权重"的最长时长**（毫秒）与那一对的名字。
   *
   * `acts=` 只说明"这一刻谁在"，说不出"叠了多久"；而"两套动作打架"恰恰是时长问题。
   * 这里在帧循环里按 dt 累加（30fps 级精度），并用 `strays=` 给出现场名单，
   * 排查时不用再靠外部探针节流后的抽样去猜。
   */
  let overlapRunMs = 0
  let overlapWorstMs = 0
  let overlapWorstNames = ''
  const trackOverlap = (dt: number): void => {
    if (!(dt > 0)) return
    const mixer = live.mixer as unknown as { _actions?: readonly unknown[] } | undefined
    if (mixer?._actions === undefined) return
    const names: string[] = []
    for (const raw of mixer._actions) {
      const action = raw as { getEffectiveWeight?: () => number; _clip?: { name?: string } }
      if ((action.getEffectiveWeight?.() ?? 0) <= 0.5) continue
      names.push(shortClipName(action._clip?.name ?? '?', live.clipNames))
    }
    if (names.length >= 2) {
      overlapRunMs += dt * 1000
      if (overlapRunMs > overlapWorstMs) {
        overlapWorstMs = overlapRunMs
        overlapWorstNames = names.join('+')
      }
    } else {
      overlapRunMs = 0
    }
  }

  /** The action for one clip, created once and cached by the mixer. */
  const actionForClip = (generation: Generation, clip: ThreeAnimationClip): ThreeAnimationAction | undefined => {
    if (generation.mixer === undefined) return undefined
    return generation.mixer.clipAction(clip)
  }

  /** The registered clip for one name in a generation. */
  const clipNamed = (generation: Generation, name: string): ThreeAnimationClip | undefined =>
    (generation.bundle?.clips as ThreeAnimationClip[] | undefined)?.find(clip => clip.name === name)

  /**
   * 一个"动作组"的三段式：给一条循环片名，配齐 进入 / 循环 / 退出。
   *
   * 这个资产（以及这类游戏资产）的动作是**成组**的：`X_Start` → `X_Loop` → `X_End`
   * （跑=跑开始→跑循环→跑结束）。前后两段按名字约定自动配齐，找不到就退化成单循环。
   *   · `MainCity_Run_Loop` ⇒ 进入 `MainCity_Run_Start`、退出 `MainCity_Run_End_R`
   *   · `Galgame_Sad_Loop`  ⇒ 进入 `Galgame_Sad_Start`、退出 `Galgame_Sad_End`
   *   · `Idle_Loop`         ⇒ 没有 `Idle_Start`/`Idle_End`，就只有循环段
   */
  const trioFor = (generation: Generation, loop: string): { enter?: string; loop?: string; exit?: string } => {
    const base = loop.replace(/_Loop(_\d+)?$/i, '')
    if (base === loop) return { loop }
    const has = (name: string): boolean => generation.clipNames.includes(name) && clipNamed(generation, name) !== undefined
    const first = (candidates: string[]): string | undefined => candidates.find(has)
    return {
      enter: first([`${base}_Start`]),
      loop,
      exit: first([`${base}_End`, `${base}_End_R`, `${base}_End_L`, `${base}_End_02_R`, `${base}_End_02_L`]),
    }
  }

  /** 一个状态的"三段式"编排 + 时间轴算出来的收尾倍率。 */
  type Sequence = { enter?: string; loop?: string; exit?: string; loops?: number; exitRate?: number }

  /**
   * 把配置里的 `seconds`(T) 换算成**实际遍数与收尾倍率**：`T = nL + F`。
   *
   * - `L` / `F` 取 clip **自己**的时长（原速口径）⇒ 换动作、改动作都不需要动配置。
   * - 只有配置里写了 `seconds` 才走这条路；没写就用 `loops`（或一直循环）。
   * - `T < F` 时收尾**加速**（倍率 `F/T`），总时长刚好 T；
   *   `T ≥ F` 时按 `gap` 补富余：缺省 `stretch`（把收尾放慢到刚好填满 T，倍率 ≤ 1，没有停顿）。
   * - 倍率不钳上界（契约优先）：配置写了个荒谬的短 T，就让它真的快放。
   * - 数学在 `timeline.planBeat` 里（纯函数，有离线守卫扫边界）。
   */
  const timed = (generation: Generation, state: PhaseState, sequence: Sequence): Sequence => {
    const beat = choreography.states[state]
    const seconds = beat?.seconds
    if (seconds === undefined || !(seconds > 0) || sequence.loop === undefined) return sequence
    const loopSeconds = clipNamed(generation, sequence.loop)?.duration
    if (loopSeconds === undefined || !(loopSeconds > 0)) return sequence
    const exitSeconds = sequence.exit === undefined ? 0 : (clipNamed(generation, sequence.exit)?.duration ?? 0)
    if (!(exitSeconds > 0)) {
      // 没有收尾段：T 全部用来循环。
      return { ...sequence, loops: Math.max(1, Math.round(seconds / loopSeconds)) }
    }
    const plan = planBeat(seconds, loopSeconds, exitSeconds, beat?.gap ?? 'stretch')
    if (plan === undefined) return sequence
    // `T < F` 时 plan.loops 是 0，而 `fadeToLoops` 至少播 1 遍 —— 配置把 T 写得比收尾还短本来就是错的，
    // 走 的下限由 `tools/check-pet3d-timeline.mjs` 的 `timingProblems` 挡住。
    return { ...sequence, loops: Math.max(1, plan.loops), exitRate: plan.exitRate }
  }

  /** 一个状态的"三段式"编排：先看用户在 `choreography.json` 里怎么排的，没有再回落到宿主给的循环片 + 名字约定。 */
  const sequenceFor = (generation: Generation, state: PhaseState): Sequence => {
    const configured = choreography.states[state]
    if (configured !== undefined) {
      const resolve = (pattern: string | undefined): string | undefined => {
        if (pattern === undefined) return undefined
        const hit = expandPattern(pattern, generation.clipNames).find((name) => clipNamed(generation, name) !== undefined)
        return hit
      }
      const loop = resolve(configured.loop)
      if (loop !== undefined || configured.enter !== undefined || configured.exit !== undefined) {
        return timed(generation, state, { enter: resolve(configured.enter), loop, exit: resolve(configured.exit), loops: configured.loops })
      }
    }
    const loop = pickClipForState(view.phases, state, generation.clipNames)
    if (loop === undefined) return {}
    return timed(generation, state, trioFor(generation, loop))
  }

  /**
   * 把除 `next`/`keep` 之外**所有还在跑的动作**淡出。
   *
   * 为什么必须逐个淡：`generation.currentAction` 只是"上一个"一个指针，而这套编排真的会
   * 同时留下不止一条在跑的动作（进/循/收三段之间的桥、面板点播、一拍的重播、走→跑引导）。
   * 每条动作都是 412 轨 / 138 骨骼的**全身**动作，只要漏掉一条留在权重 1，画面上就是
   * "两套（甚至三套）动作在打架" —— 用户反复报的就是这个现象，`tools/probe-acts.mjs`
   * 的实测数字：修之前换一次状态能堆到 2~4 条满权重动作，而且不收敛（最长 8.5s 不回落）。
   *
   * 先把"当前权重"冻到 `weight` 上再 `fadeOut`：three 的 `fadeOut` 起点固定写 1，
   * 直接对一条正在淡出的动作调用会让它从 1 重新起跳（看得见地闪一下）。
   */
  /**
   * 这条动作现在"还看得见"吗（权重 > 0.1）。
   *
   * 只在一个地方要这个判据，但很关键：**没人在淡出时不要从 0 淡入**。
   * fadeIn 的第一帧插值就是 0；如果此时对面那条也已经淡到快没了，两边同时落在
   * 0.01 以下 ⇒ 骨架有 2~3 帧**没有任何动作在驱动**，看起来就是换动作时"顿一下"。
   * 阈值取 0.1 而不是 0.01：0.01~0.03 这种"已经透明"的对手不该再参与交叉淡入，
   * 直接从它切到满权重反而看不出接缝（它本来就只剩几个百分点的贡献）。
   * 实测（tools/probe-acts.mjs，60fps）：0.01 时每分钟 7 次 2~3 帧空档，0.1 之后归零。
   */
  const audible = (action: unknown): boolean => {
    const probe = action as { getEffectiveWeight?: () => number } | undefined
    return (probe?.getEffectiveWeight?.() ?? 0) > 0.1
  }

  const fadeOutOthers = (generation: Generation, next: unknown, keep?: unknown): void => {
    const mixer = generation.mixer as unknown as {
      _actions?: readonly unknown[]
      _isActiveAction?: (action: unknown) => boolean
    } | undefined
    if (mixer?._actions === undefined) return
    for (const raw of mixer._actions) {
      if (raw === next || raw === keep) continue
      const action = raw as {
        isRunning?: () => boolean
        getEffectiveWeight?: () => number
        setEffectiveWeight?: (weight: number) => void
        fadeOut?: (duration: number) => void
        _weightInterpolant?: unknown
      }
      /**
       * 判活必须和仪表（`activeActionList`）用**同一套**标准：`isRunning()` 会把
       * "已经播完、被 `clampWhenFinished` 定在末帧"的动作排除掉 —— 而那种动作仍然以
       * 满权重驱动骨架。只用 `isRunning()` 判，就会出现"桥放完停在 1.00 永不淡出"：
       * 新动作在演，旧的过渡段也一直满权重压着（实测 `Trans_01to03:1.00` 挂 11 秒，
       * 被新模型较慢的加载时序暴露，`tools/probe-acts.mjs` 的"3 个动作"段就是这么来的）。
       */
      const active = mixer._isActiveAction?.(action) === true || action.isRunning?.() === true
      if (!active) continue
      /**
       * ★ **已经在淡出的不要再淡一次**。
       *
       * three 的 `fadeOut(d)` 永远按 `1 → 0` 重新排期，不管当前权重是多少；对一条正在
       * 淡出的动作再调一次，等于把它**从 1 重新起跳**并重新计时 ⇒ 淡出时间翻倍。
       * 实测后果：220ms 的交叉淡入淡出变成 440ms，过桥链上再叠一次就是 800ms 的
       * "两个动作同时在动"（`tools/probe-acts.mjs` 偶发 800ms 的来源）。
       * 下面那个 `setEffectiveWeight(weight)` 的"冻结"只解决可见的一闪，不解决计时。
       */
      if (action._weightInterpolant !== null && action._weightInterpolant !== undefined) continue
      const weight = action.getEffectiveWeight?.() ?? 1
      // 已经在 0 附近就别动：把 weight 冻成 0 是永久的（下次淡入也只到 0），
      // 表现就是"动作在演但模型不跟随"。
      if (weight <= 0.01) continue
      action.setEffectiveWeight?.(weight)
      action.fadeOut?.(FADE_SECONDS)
    }
  }

  /** Cross-fade onto one clip that loops forever. */
  const fadeToLoop = (generation: Generation, name: string): boolean => {
    if (vendor === undefined) return false
    const clip = clipNamed(generation, name)
    if (clip === undefined) return false
    const next = actionForClip(generation, clip)
    if (next === undefined) return false
    const previous = generation.currentAction
    next.reset()
    next.setLoop(vendor.LoopRepeat, Infinity)
    next.clampWhenFinished = false
    next.enabled = true
    next.play()
    // weight 是粘的：被淡出过 / 被冻结过的 action，这里不显式抬回 1，后面淡入也只能到那个残值。
    next.setEffectiveWeight(1)
    if (previous !== undefined && previous !== next && audible(previous)) previous.crossFadeTo(next, FADE_SECONDS, false)
    else next.setEffectiveWeight(1)
    fadeOutOthers(generation, next, previous)
    generation.currentAction = next
    generation.currentClipName = name
    return true
  }

  /** Cross-fade onto one clip that plays exactly once (an enter or an exit段). `rate` = 播放倍率（收尾加速/放慢用）。 */
  const fadeToOnce = (generation: Generation, name: string, rate = 1, fadeSeconds = FADE_SECONDS): boolean => {
    if (vendor === undefined) return false
    const clip = clipNamed(generation, name)
    if (clip === undefined) return false
    const action = actionForClip(generation, clip)
    if (action === undefined) return false
    const previous = generation.currentAction
    action.reset()
    // 倍率放在 `reset()` 之后设：`reset()` 只清 time / paused / 淡入淡出插值，**不动 weight**。
    action.setEffectiveTimeScale(rate > 0 && Number.isFinite(rate) ? rate : 1)
    action.setLoop(vendor.LoopOnce, 1)
    action.clampWhenFinished = true
    action.enabled = true
    action.play()
    // 权重必须显式给（reset() 不动 weight；被冻结过的那份残值会一路带下来）。
    action.setEffectiveWeight(1)
    // 还有两个原因，都真的踩到过：
    // ① `reset()` 不会把 weight 抬回 1，而**被淡出过的 action 权重停在 0**
    //    ⇒ 同一条一次性 clip 第二次播就是"隐形播放"（角色定格在上一帧姿态，看起来卡住）。
    // ② 只有把新段也 `fadeIn`，才是一次真正的交叉淡入淡出。否则新段瞬间满权重、
    //    旧段还在 ~0.5 —— 这套资产的待机与情绪都是 412 轨 / 138 骨骼的全身动作，
    //    两套叠在一起就是"同时做两个动作在打架"。
    if (previous !== undefined && previous !== action && audible(previous)) {
      previous.fadeOut(fadeSeconds)
      action.fadeIn(fadeSeconds)
    } else {
      // `actionForClip` 对同一 clip 返回同一个 action：重播自己时不能从 0 淡入（会闪一下）。
      action.setEffectiveWeight(1)
    }
    fadeOutOthers(generation, action, previous)
    generation.currentAction = action
    generation.currentClipName = undefined
    oneShotActive = true
    return true
  }

  /** Cross-fade onto one clip that plays exactly N loops (N finite ⇒ `finished` 会在最后一次结束时发). */
  const fadeToLoops = (generation: Generation, name: string, loops: number): boolean => {
    if (vendor === undefined) return false
    const clip = clipNamed(generation, name)
    if (clip === undefined) return false
    const next = actionForClip(generation, clip)
    if (next === undefined) return false
    const previous = generation.currentAction
    next.reset()
    next.setLoop(vendor.LoopRepeat, Math.max(1, loops))
    next.clampWhenFinished = true
    next.enabled = true
    next.play()
    next.setEffectiveWeight(1)
    if (previous !== undefined && previous !== next && audible(previous)) previous.crossFadeTo(next, FADE_SECONDS, false)
    else next.setEffectiveWeight(1)
    fadeOutOthers(generation, next, previous)
    generation.currentAction = next
    generation.currentClipName = name
    oneShotActive = true
    return true
  }

  /**
   * 剧情演出（点一下宠物叫出来的那一整段）已按用户要求**整套删除**：
   * 太没用而且有 bug（`fadeToOnce` 的权重问题在它身上最明显）。要重写就从零写。
   */

  /** "一拍"的第二段：只循环一遍（有限次 LoopRepeat，three 在结束时发 `finished`）。 */
  const beatLoopOnce = (state: PhaseState): boolean => {
    const sequence = sequenceFor(live, state)
    if (sequence.loop === undefined) return false
    return fadeToLoops(live, sequence.loop, 1)
  }

  /** "一拍"演完：回到平静（若相位已经变了，`applyState` 会自己走到那个状态）。 */
  const finishBeat = (): void => {
    beatActive = false
    oneShotActive = false
    sequenceStep = 'idle'
    pendingState = undefined
    exitingFrom = undefined
    currentState = undefined
    // 这是"回到相位状态"，不是"开始工作" ⇒ 跳过"走"的引导
    // （否则干活干到一半被戳一下，回来会白走 10 秒）。
    applyState(lastState, true)
  }

  /** 顿一下宠物（随机演一段"剧情"）已整套删除 —— 见上面 `playGuest` 位置的说明。 */

  /**
   * 进入一个状态。**"一拍"状态**（done / failed）走有限次数：起手 → 循环一遍 → 收招 → 回待机，
   * 而不是把情绪循环一直挂着（用户的原话："做动作之后回归平静做平静动作，然后再回到待机状态"）。
   */
  const enterState = (generation: Generation, state: PhaseState): void => {
    const sequence = sequenceFor(generation, state)
    if (sequence.loop === undefined) return
    currentState = state
    lastPlayedState = state
    pendingState = undefined
    exitingFrom = undefined
    beatActive = isBeatState(state)
    // 记下"这一拍演过了"：无论从哪条路进来（直接进、还是先放上一个状态的收招再进），
    // 相位不变就不会反复重演（否则情绪循环会一遍遍刷屏）。
    if (beatActive) beatPlayed = state
    if (sequence.enter !== undefined && fadeToOnce(generation, sequence.enter)) {
      sequenceStep = 'enter'
      return
    }
    sequenceStep = 'idle'
    if (beatActive) {
      if (fadeToLoops(generation, sequence.loop, 1)) sequenceStep = 'loop'
      return
    }
    if (fadeToLoop(generation, sequence.loop)) sequenceStep = 'loop'
  }

  /** 进入当前状态的循环段。`loops` 有限次时 three 会在最后一次结束时发 `finished`（"一拍"用）。 */
  const loopState = (generation: Generation, state: PhaseState, loops = Infinity): void => {
    const sequence = sequenceFor(generation, state)
    if (sequence.loop === undefined) return
    sequenceStep = 'idle'
    if (Number.isFinite(loops)) {
      // 只循环一遍就收尾：走"有限次 LoopRepeat"这条路，收招由 finished 推进。
      if (fadeToLoops(generation, sequence.loop, loops)) sequenceStep = 'loop'
      return
    }
    if (fadeToLoop(generation, sequence.loop)) sequenceStep = 'loop'
  }

  /** 离开当前状态：有退出段就先放退出段（放完再去目标状态），否则直接切过去。 */
  const leaveTo = (generation: Generation, target: PhaseState): void => {
    const current = currentState === undefined ? {} : sequenceFor(generation, currentState)
    if (current.exit !== undefined && fadeToOnce(generation, current.exit, current.exitRate ?? 1)) {
      pendingState = target
      sequenceStep = 'exit'
      // 退出段一开播就算"已经离开这个状态"：否则它放完时再走一遍 leaveTo，
      // 会把同一段退出动画又放一次（跑结束放两遍）。`exitingFrom` 只是留给仪表报数。
      exitingFrom = currentState
      currentState = undefined
      return
    }
    enterState(generation, target)
  }

  /** 放桥的第 `index` 支（一次）；放完由 `onActionFinished` 推进。 */
  const playBridgeStep = (generation: Generation): boolean => {
    if (bridge === undefined) return false
    const clip = bridge.chain[bridge.index]
    if (clip === undefined) return false
    // 过桥用更短的淡出：桥的一步只有 0.32~0.42s，用常规 220ms 会和下一步的淡入叠在一起
    if (!fadeToOnce(generation, clip, 1, BRIDGE_FADE_SECONDS)) return false
    sequenceStep = 'exit'
    return true
  }

  /**
   * 换状态：优先走配置好的"桥"，没有桥才走原来的"先放退出段"。
   *
   * 桥是**完整的一条链**（含它自己需要的收步段），所以有桥时不再放 `from` 的退出段 ——
   * 例如 `walk>run` 的桥就是 `Trans_01to03` 一支：它的首帧必须接在**走循环的接缝**上，
   * 若先放了 `Walk_End` 就把姿态带到基础待机去了，接缝反而对不上。
   */
  const switchTo = (generation: Generation, from: PhaseState | undefined, to: PhaseState): void => {
    const chain = bridgeFor(choreography.transitions, from, to, generation.clipNames)
    if (chain.length > 0) {
      bridge = { chain, index: 0 }
      exitingFrom = from
      currentState = undefined
      if (playBridgeStep(generation)) return
      bridge = undefined
    }
    leaveTo(generation, to)
  }

  /**
   * 正在演的演出（`choreography.json` 的 `performances`）。
   *
   * 为什么不复用 `bridge`：桥的终点是**一个状态**（放完就进那个状态的起手段），
   * 演出的终点是**"回到此刻的相位"** —— 语义不同，硬塞进桥会让 onActionFinished
   * 变成一团 if（桥的每一支都要问一句"你是桥还是演出"）。
   */
  let playing: { id: string; steps: readonly PetPerformanceStep[]; index: number; elapsed: number } | undefined

  /** 把演出步骤解析成可播的 clip（允许通配，和 `states` 的写法一致）。 */
  const resolvePerformanceSteps = (generation: Generation, steps: readonly PetPerformanceStep[]): PetPerformanceStep[] => {
    const out: PetPerformanceStep[] = []
    for (const step of steps) {
      const hit = expandPattern(step.clip, generation.clipNames).find((name) => clipNamed(generation, name) !== undefined)
      if (hit === undefined) continue
      out.push({ ...step, clip: hit })
    }
    return out
  }

  /** 演出的第 `index` 步开演。 */
  const playPerformanceStep = (generation: Generation, index: number): boolean => {
    if (playing === undefined) return false
    const step = playing.steps[index]
    if (step === undefined) return false
    if (!fadeToOnce(generation, step.clip, step.rate ?? 1)) return false
    playing.index = index
    playing.elapsed = 0
    // 仪表里显示成 `exit`（一次性动作那一段），`perf=` 那一栏会说明这是演出。
    sequenceStep = 'exit'
    return true
  }

  /** 下一步；没有下一步就收场。 */
  const nextPerformanceStep = (): void => {
    if (playing === undefined) return
    const next = playing.index + 1
    if (next < playing.steps.length && playPerformanceStep(live, next)) return
    finishPerformance()
  }

  /** 收场：清干净状态机，然后回到当前相位（`resume` = 不重走"走路"引导）。 */
  const finishPerformance = (): void => {
    if (playing === undefined) return
    playing = undefined
    oneShotActive = false
    currentState = undefined
    sequenceStep = 'idle'
    pendingState = undefined
    exitingFrom = undefined
    applyState(lastState, true)
  }

  /**
   * 每帧推进演出（`dt` 秒）。
   *
   * 只有带 `seconds` 的步骤需要它；不带的由 `finished` 事件推进（播到自然结尾）。
   * 用帧时间而不是 `setTimeout`：暂停、变速、页面挂起都会自然跟着走。
   */
  const advancePerformance = (dt: number): void => {
    if (playing === undefined) return
    const step = playing.steps[playing.index]
    if (step === undefined) { finishPerformance(); return }
    if (step.seconds === undefined || !(step.seconds > 0)) return
    playing.elapsed += dt
    if (playing.elapsed >= step.seconds) nextPerformanceStep()
  }

  /**
   * Follow the phase state: idle / busy / done / failed, each played as its
   * 进入→循环→退出 sequence instead of a single looped clip.
   *
   * While the panel holds a clip on loop, phase updates are ignored: the user
   * asked for that clip explicitly, and a poll landing two seconds later must
   * not take it away.
   */
  const applyStateImmediate = (state: PhaseState, resume = false): void => {
    const generation = live
    if (disposed || generation.mixer === undefined || vendor === undefined) return
    if (manualLoop !== undefined) return
    // 演出在演：相位变化先记在 `lastState` 里（`applyState` 的入口早就在维护它），
    // 收场时 `finishPerformance` 会回到最新的相位。中途打断会把整段演出切碎。
    if (playing !== undefined) return
    // "一拍"（done / failed）在演：让它把 起手→循环→收招 走完。中途来的相位变化不打断，
    // 收尾时用最新的 `lastState` 决定去哪儿。
    if (beatActive) return
    // 不在"一拍"状态里了 ⇒ 清掉"这一拍已经演过"的记忆，下次再来还会演。
    if (!isBeatState(state)) beatPlayed = undefined
    // 已经在走了、目标还是跑：让走循环自然播完（播完的处理器会把下一站解析成 run），不重开。
    if (state === 'run' && currentState === 'walk') return
    // "闲置 → 跑"要先走一段（见 `leadInBefore`）：只改**这一次进哪个状态**，
    // `lastState` 仍然是宿主给的 `run`，所以走循环播完会自动接"收步 → 跑"。
    // `resume` = 这是一次"回到相位状态"（演出 / 一拍刚演完），不是"开始工作" ⇒ 不再走"走"的引导。
    const enter = resume ? state : leadInBefore(state, currentState)
    if (currentState === undefined) {
      // 桥正在放：让它放完（放完的处理器会用最新的 lastState 决定去哪），不打断。
      if (bridge !== undefined) return
      // 这一拍刚演过、相位还停在 done/failed ⇒ 按用户说的"回归平静"，回到待机而不是再演一遍。
      const target = isBeatState(enter) && beatPlayed === enter ? 'idle' : enter
      // "现在没东西在播"不等于"可以从任意姿态直接切"：上一次播的可能是别的家族
      // （演出与一拍都是 04）⇒ 同样要过桥，否则 04 → 01/03 是 36.49° 硬跳。
      if (bridgeFor(choreography.transitions, lastPlayedState, target, generation.clipNames).length > 0) {
        switchTo(generation, lastPlayedState, target)
        return
      }
      enterState(generation, target)
      return
    }
    if (enter === currentState) {
      // 正在放进入/退出段就让它放完（`finished` 会接着走）；否则确保循环段在跑。
      if (oneShotActive) return
      if (sequenceStep !== 'loop' || generation.currentClipName === undefined) loopState(generation, currentState)
      return
    }
    // 换状态：正在放某一段就等它放完（记下目标），放完的处理器会接着编排。
    if (oneShotActive) {
      pendingState = enter
      return
    }
    switchTo(generation, currentState, enter)
  }

  /**
   * 相位变化的入口：过"动作总闸"（同一时刻只允许一个动作，两次触发至少隔
   * {@link triggerDelayMs} 那个 200ms）。
   *
   * 相位变化是**延后不丢弃** —— 丢一次桌宠就停在错的状态，而晚 200ms 切过去没人看得出来。
   * 晚到的回调会重新读一遍当时的状态（`manualLoop` / `guest` / 一拍），所以比立刻执行更准。
   */
  const applyState = (state: PhaseState, resume = false): void => {
    const wait = triggerDelayMs(lastTriggerMs, Date.now())
    if (wait === 0) {
      lastTriggerMs = Date.now()
      applyStateImmediate(state, resume)
      return
    }
    if (triggerTimer !== undefined) window.clearTimeout(triggerTimer)
    triggerTimer = window.setTimeout(() => {
      triggerTimer = undefined
      lastTriggerMs = Date.now()
      applyStateImmediate(state, resume)
    }, wait)
  }

  /**
   * Advance the sequence when a 进入/退出段 finishes.
   *
   * `finished` fires for every LoopOnce action, and one-shots genuinely overlap:
   * the panel may play a second clip while the first is still running. The mixer
   * event says WHICH action ended, so a superseded action finishing must be
   * ignored — otherwise the stale event hands the mixer back mid-gesture.
   */
  const onActionFinished = (event: ThreeAnimationFinishedEvent): void => {
    if (disposed) return
    finishedEvents += 1
    if (event !== undefined && event.action !== live.currentAction) { finishedSkipped += 1; return }
    if (manualLoop !== undefined) { oneShotActive = false; return }
    // 演出：这一步播到自然结尾 ⇒ 进下一步（`seconds` 比 clip 短的步骤由帧循环推进，
    // 二者谁先到就算谁 —— 这就是"每步可以限时"的实现）。
    if (playing !== undefined) { nextPerformanceStep(); return }
    // 桥：依次放下一支，最后一支放完就直接进目标状态的起手段。
    // 目标取**最新的** `lastState`（不是当初记下的）：桥播放期间相位又变了的话，去最新的那个。
    if (bridge !== undefined) {
      bridge.index += 1
      if (bridge.index < bridge.chain.length && playBridgeStep(live)) return
      bridge = undefined
      oneShotActive = false
      // ★ 桥的落脚点必须和"直接进"用**同一套判据**（见 applyStateImmediate 里那个 target）：
      //   一拍（done/failed）已经演过就不能再进它 —— 否则 done → idle 的桥一放完又回到
      //   done:enter，一拍会无限重演。实测（tools/verify-inspect-panel.mjs）：
      //   修之前 seq 永远停在 done:enter / done:exit 之间打转。
      const wanted = pendingState ?? lastState
      pendingState = undefined
      enterState(live, isBeatState(wanted) && beatPlayed === wanted ? 'idle' : wanted)
      return
    }
    // "一拍"状态：起手 → 循环一遍 → 收招 → 回待机（见 enterState 的注释）。
    if (beatActive) {
      const state = currentState
      if (state === undefined) { finishBeat(); return }
      if (sequenceStep === 'enter') {
        sequenceStep = 'idle'
        if (beatLoopOnce(state)) { sequenceStep = 'loop'; return }
        finishBeat()
        return
      }
      if (sequenceStep === 'loop') {
        const sequence = sequenceFor(live, state)
        if (sequence.exit !== undefined && fadeToOnce(live, sequence.exit, sequence.exitRate ?? 1)) {
          sequenceStep = 'exit'
          exitingFrom = state
          return
        }
        finishBeat()
        return
      }
      finishBeat()
      return
    }
    const finishedStep = sequenceStep
    oneShotActive = false
    sequenceStep = 'idle'
    const target = pendingState ?? lastState
    pendingState = undefined
    if (target !== currentState) {
      // 进入段放完才发现相位已经变了：先补上这一状态的退出段，再去目标状态。
      switchTo(live, currentState, target)
      return
    }
    if (finishedStep === 'enter' || currentState !== undefined) loopState(live, target)
  }

  /** 仪表用：去掉多数族前缀的短名（见 {@link dominantNamePrefix}）。 */
  const clipLabel = (name: string): string => shortClipName(name, live.clipNames)

  /**
   * ★ 探针：列出此刻**真正在驱动骨架**的动作（`短名:权重`）。
   *
   * 为什么要有它：用户报过"角色像在同时做两套动作、卡住"，而这类毛病从截图看不出来。
   * 判据很硬：
   * - 正常 ⇒ 只有 1 个（交叉淡入淡出的那 220ms 里会有 2 个，这是对的）；
   * - 2 个以上（且不是正在交叉淡入淡出）⇒ **真的在叠加**，这套资产每条动作都是
   *   412 轨 / 138 骨骼的全身动作，一叠加就是"两套动作打架"；
   * - 一个都没有（仪表里显示 `acts=0!`）⇒ 骨架**没被任何动作驱动**，会定格在上一帧
   *   —— "动作在演但模型不跟随"就是这一种，几乎总是忘记把新动作权重抬起来造成的
   *   （three 的 `AnimationAction.reset()` **不会**把 weight 复位）。
   */
  /**
   * 诊断用：此刻**运行中**的动作总数（不看权重）。
   *
   * `acts=` 里列的是权重 > 0.01 的；两个一起看才能区分两种故障形态：
   * - `run>0` 但 `acts=0!` ⇒ 动作在跑、权重却被压到 0（淡入被卡住 / 权重没抬起来）；
   * - `run=0` ⇒ 真的没有任何动作在跑（状态机的空窗），骨架必然定格在上一帧。
   */
  let runningActions = 0

  const activeActionList = (): string => {
    const mixer = live.mixer as unknown as {
      _actions?: readonly unknown[]
      _isActiveAction?: (action: unknown) => boolean
    } | undefined
    if (mixer?._actions === undefined) return '-'
    const parts: string[] = []
    runningActions = 0
    for (const raw of mixer._actions) {
      const action = raw as {
        getEffectiveWeight?: () => number
        isRunning?: () => boolean
        _clip?: { name?: string }
        _weightInterpolant?: { parameterPositions: ArrayLike<number> } | null
      }
      /**
       * ★ 判据是"**还在 mixer 的活动表里**"（`_isActiveAction`），不是 `isRunning()`。
       *
       * 两个都踩过：
       * ① 只按权重（第一版）⇒ 永远报 134 个：`mixer._actions` 里躺着**每一条**用过的
       *    `clipAction`，而一条**从没 play 过**的动作 `getEffectiveWeight()` 也是 1.00。
       * ② 换成 `isRunning()` 又矫枉过正：它把**已播完但被 `clampWhenFinished` 定住**的动作
       *    排除掉 —— 而那种动作仍然以满权重驱动骨架（一拍/过渡段收尾全靠它 hold 住姿势）。
       *    实测后果：`seq=walk:exit` 交接的那 2~3 帧被假报成"没有任何动作"，其实旧动作
       *    正 paused 在末帧、权重 1.00，画面是正常的交叉淡入淡出。
       */
      if (mixer._isActiveAction?.(action) !== true) continue
      runningActions += 1
      const weight = action.getEffectiveWeight?.() ?? 0
      if (weight <= 0.01) continue
      const name = action._clip?.name ?? '?'
      /**
       * 再带上"这条的淡入淡出窗口有多宽"（`@0.22s`）。
       *
       * 没有这个字段，`FADE_MS` 当秒传给 three 那个 bug 是**看不出来**的：权重一直在动、
       * 数字看起来"就在淡"，只有窗口宽度会直接喊 `@220.00s`。修好之后这里恒为 `@0.22s`。
       */
      const fade = action._weightInterpolant
      const fadeWidth = fade === null || fade === undefined
        ? ''
        : `@${(fade.parameterPositions[1] - fade.parameterPositions[0]).toFixed(2)}s`
      parts.push(`${shortClipName(name, live.clipNames)}:${weight.toFixed(2)}${fadeWidth}`)
    }
    return parts.length === 0 ? '0!' : parts.join(',')
  }

  /** Record everything a loaded document owns, so retire is complete. */
  const collectOwned = (generation: Generation, node: ThreeObject3D): void => {
    node.traverse((child) => {
      const mesh = child as ThreeMesh
      if (mesh.isMesh !== true && mesh.isSkinnedMesh !== true) return
      if (mesh.geometry !== undefined && !generation.geometries.includes(mesh.geometry)) {
        generation.geometries.push(mesh.geometry)
      }
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material === undefined || generation.materials.includes(material)) continue
        generation.materials.push(material)
        const map = material.map
        if (map !== undefined && !generation.textures.includes(map)) generation.textures.push(map)
      }
    })
  }

  /** The cel-shading pass over one generation (see {@link applyToonPass}). */
  const applyToon = (generation: Generation, vendor3: Model3dVendor, node: ThreeObject3D, toon: PetModel3dToonView): void => {
    // 用户在编排器里可以把描边宽度改成 0（= 关掉描边壳），这是最省的一半开销：
    // 描边是把整个模型再画一遍。配置里没写就用宿主给的值。
    const width = choreography.render?.outlineWidth
    applyToonPass(vendor3, node, width === undefined ? toon : { ...toon, outlineWidth: width }, generation.materials)
  }

  /**
   * 应用"性能开关"（`choreography.json` 的 `render`）。
   *
   * `morphs: false` 会把几何的形态键（面部表情）摘掉 —— 这个模型的脸有 **29 个形态键**，
   * 顶点着色器里要按目标数循环采样，关掉能明显省顶点开销；代价是表情动作不再起作用，
   * 而且**摘掉之后要恢复得重载模型/刷新页面**（几何是加载器建的，没有原始数据可回填）。
   */
  const applyRenderOptions = (): void => {
    if (choreography.render?.morphs !== false) return
    let stripped = 0
    for (const geometry of live.geometries) {
      const holder = geometry as unknown as { morphAttributes?: Record<string, unknown> }
      const morphs = holder.morphAttributes
      if (morphs === undefined || Object.keys(morphs).length === 0) continue
      holder.morphAttributes = {}
      stripped += 1
    }
    if (stripped > 0) {
      for (const material of live.materials) (material as { needsUpdate?: boolean }).needsUpdate = true
      morphsStripped = stripped
    }
  }

  /** Drop the geometry / material / texture objects one generation created. */
  const disposeGeneration = (generation: Generation, opts: { textures: boolean }): void => {
    for (const material of generation.materials.splice(0)) {
      try { material.dispose() } catch { /* best-effort teardown */ }
    }
    for (const geometry of generation.geometries.splice(0)) {
      try { geometry.dispose() } catch { /* best-effort teardown */ }
    }
    if (!opts.textures) return
    for (const texture of generation.textures.splice(0)) {
      try { texture.dispose() } catch { /* best-effort teardown */ }
    }
  }

  /**
   * Retire one generation completely.
   *
   * Uncaching the mixer before dropping the bundle is what actually frees the
   * payload: a live `AnimationAction` holds its clip, and a clip holds views
   * into `clips.bin`. `keepBundle` is for the case where the bundle was handed
   * to the incoming generation — then only the mixer is torn down here.
   * @param generation - the generation to release.
   * @param keepBundle - whether its clip library now belongs to someone else.
   */
  const retire = (generation: Generation, keepBundle: boolean): void => {
    if (generation.mixer !== undefined) {
      try { generation.mixer.stopAllAction() } catch { /* best-effort teardown */ }
      if (generation.root !== undefined) {
        try { generation.mixer.uncacheRoot(generation.root) } catch { /* best-effort teardown */ }
      }
      try { generation.mixer.removeEventListener('finished', onActionFinished) } catch { /* best-effort teardown */ }
      generation.mixer = undefined
    }
    generation.currentAction = undefined
    generation.currentClipName = undefined
    if (generation.bundle !== undefined) {
      if (!keepBundle) releaseClipBundle(generation.bundle)
      generation.bundle = undefined
    }
    disposeGeneration(generation, { textures: true })
    if (generation.wrapper !== undefined && scene !== undefined) scene.remove(generation.wrapper)
    generation.wrapper = undefined
    generation.root = undefined
  }

  /** Build the mesh half of a generation (glTF → rig → toon), off screen. */
  const buildMesh = async (vendor3: Model3dVendor, next: PetModel3dView): Promise<Generation> => {
    const generation = newGeneration(next)
    const loader = new vendor3.GLTFLoader()
    loader.setCrossOrigin('anonymous')
    // A .vrm is glTF with a VRM extension block; the plugin is what turns that
    // block into springs, expressions and humanoid bones.
    loader.register(parser => new vendor3.VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(next.modelUrl)
    const sceneRoot = gltf.scene
    vendor3.VRMUtils.removeUnnecessaryVertices?.(sceneRoot)
    vendor3.VRMUtils.combineSkeletons?.(sceneRoot)
    vendor3.VRMUtils.rotateVRM0?.(sceneRoot.userData?.vrm ?? sceneRoot)
    collectOwned(generation, sceneRoot)
    applyToon(generation, vendor3, sceneRoot, next.toon)
    // Bake the fit and the visual center into a wrapper rig, so the camera math
    // stays a plain origin-centered orbit regardless of how the model was
    // authored (glTF is Y-up, VRM0 is Z-up, units vary by 100x, and origins vary).
    const fit = fitRig(vendor3, sceneRoot, { scale: next.scale })
    if (fit.warning !== undefined) clipProblems.push(fit.warning)
    // The loaders and VRMUtils fill per-mesh caches from whatever world matrix
    // was current at the time; a stale one makes three cull the mesh and the pet
    // vanishes with no error. Dropping them here makes the first cull recompute
    // in the FINAL space.
    sceneRoot.traverse((child) => {
      const mesh = child as ThreeMesh
      if (mesh.isMesh !== true && mesh.isSkinnedMesh !== true) return
      mesh.boundingBox = null
      mesh.boundingSphere = null
    })
    sceneRoot.updateMatrixWorld(true)
    const wrapper = new vendor3.Group()
    wrapper.add(sceneRoot)
    wrapper.position.set(next.translate?.x ?? 0, next.translate?.y ?? 0, 0)
    generation.root = sceneRoot
    generation.wrapper = wrapper
    generation.rigSize = { width: fit.size.width, height: fit.size.height }
    return generation
  }

  /** Register every assembled clip with a fresh mixer over one root. */
  const attachMixer = (vendor3: Model3dVendor, generation: Generation): void => {
    if (generation.root === undefined || generation.bundle === undefined) return
    const mixer = new vendor3.AnimationMixer(generation.root)
    mixer.timeScale = rate
    mixer.addEventListener('finished', onActionFinished)
    // Register EVERY clip with the mixer up front: that is what makes the
    // panel's 155 buttons instant afterwards, instead of each first click
    // paying for an action to be built.
    for (const clip of generation.bundle.clips as ThreeAnimationClip[]) mixer.clipAction(clip)
    generation.mixer = mixer
  }

  /**
   * Stage 2 + 3 for one generation: the clip list, then the payload, in the
   * background.
   *
   * Runs AFTER the model is on screen on purpose — the character must not wait
   * for a 150 MB download to appear. A failure here degrades to "no actions"
   * rather than killing an activation that is already rendering.
   * @param generation - the generation to fill.
   * @param source - the view whose URLs to fetch.
   */
  const loadClipsInto = async (generation: Generation, source: PetModel3dView): Promise<void> => {
    const vendor3 = vendor
    if (vendor3 === undefined) return
    if (source.clipCount === 0 || source.clipsUrl === '') {
      setStage('ready', '这个模型没有动作')
      return
    }
    let index
    try {
      index = await loadClipIndex(io, source.clipsUrl)
    } catch (error) {
      if (disposed) return
      clipProblems.push(`clips.json 读取失败：${error instanceof Error ? error.message : String(error)}`)
      setStage('ready', '动作清单读取失败')
      return
    }
    if (disposed) return
    generation.clipNames = index.clips.map(clip => clip.name)
    // 中文名/用途/慎用 是给面板看的（内部一律用英文 id：编排的三段约定、相位挑选、守卫断言都挂在它上面）。
    clipMeta.clear()
    for (const clip of index.clips) {
      if (clip.displayName === undefined && clip.usage === undefined && clip.caution === undefined) continue
      clipMeta.set(clip.name, { displayName: clip.displayName, usage: clip.usage, caution: clip.caution })
    }
    setStage('index', `动作清单 ${generation.clipNames.length} 条，数据后台载入中`)
    try {
      const payload = await loadClipPayload(io, source.clipsBinUrl)
      if (disposed) return
      const built = buildClipBundle(vendor3 as unknown as ClipFactory, index, payload)
      if (disposed) {
        releaseClipBundle(built)
        return
      }
      generation.bundle = built
      clipProblems.push(...built.problems)
      attachMixer(vendor3, generation)
      // Say BOTH numbers when they differ. The index lists every take the file
      // carries; the mixer only holds the ones with bone tracks. A bare "128 条已
      // 注册" next to a 155-name list reads as a bug report, so the drop is named
      // here and the reasons are handed to the panel through clipProblems().
      const listed = generation.clipNames.length
      const dropped = listed - built.clips.length
      setStage('ready', dropped <= 0
        ? `动作数据就绪，${built.clips.length} 条 clip 已注册`
        : `动作数据就绪：清单 ${listed} 条，其中 ${built.clips.length} 条有骨骼轨道、${dropped} 条无轨道（特效/材质动画，播不了）`)
      applyState(lastState)
    } catch (error) {
      if (disposed) return
      clipProblems.push(`clips.bin 读取失败：${error instanceof Error ? error.message : String(error)}`)
      setStage('index', '动作数据读取失败（清单仍可查看）')
    }
  }

  /** Adopt a freshly built generation, then retire the one it replaces. */
  const adopt = (generation: Generation, previous: Generation, keepBundle: boolean): void => {
    if (generation.wrapper !== undefined && scene !== undefined) scene.add(generation.wrapper)
    live = generation
    layout()
    if (previous !== generation) retire(previous, keepBundle)
  }

  /** Which parts a new view requires. */
  const planFor = (next: PetModel3dView): SwapPlan => {
    const plan = planSwap(live.artifacts, next.artifacts)
    const optionsMoved = next.scale !== view.scale
      || JSON.stringify(next.translate ?? null) !== JSON.stringify(view.translate ?? null)
      || JSON.stringify(next.toon) !== JSON.stringify(view.toon)
    if (optionsMoved) return { mesh: true, clips: plan.clips, textures: false, any: true }
    return plan
  }

  /** The clips-only hot swap: new actions, untouched mesh. */
  const swapClips = async (next: PetModel3dView): Promise<void> => {
    const previous = live
    const generation = newGeneration(next)
    generation.root = previous.root
    generation.rigSize = previous.rigSize
    // Ownership of the mesh resources moves to the new generation; only the
    // wrapper reference is dropped, because that object stays on screen.
    generation.geometries = previous.geometries.splice(0)
    generation.materials = previous.materials.splice(0)
    generation.textures = previous.textures.splice(0)
    generation.wrapper = previous.wrapper
    previous.wrapper = undefined
    // The mesh stays exactly as it is, which is the point: no rebuild, no bind
    // pose flash, no camera move. Only the mixer and the clip library change.
    live = generation
    await retireQuietly(previous, false)
    await loadClipsInto(generation, next)
    if (generation.bundle === undefined) throw new Error('动作数据没有装载成功')
  }

  /** The textures-only hot swap: new images, same geometry and skeleton. */
  const swapTextures = async (vendor3: Model3dVendor, next: PetModel3dView): Promise<void> => {
    const generation = live
    if (generation.root === undefined) throw new Error('网格尚未装载')
    const loader = new vendor3.GLTFLoader()
    loader.setCrossOrigin('anonymous')
    loader.register(parser => new vendor3.VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(next.modelUrl)
    // The re-parse is a THROWAWAY: only its images are kept. Its geometry,
    // materials and skeleton are disposed below, so the live mesh — and the
    // animation bound to its skeleton — is never disturbed.
    const throwaway = newGeneration(next)
    collectOwned(throwaway, gltf.scene)
    let replaced = 0
    const liveMeshes: ThreeMesh[] = []
    generation.root.traverse((child) => {
      const mesh = child as ThreeMesh
      if (mesh.isMesh === true || mesh.isSkinnedMesh === true) liveMeshes.push(mesh)
    })
    for (const mesh of liveMeshes) {
      const source = gltf.scene.getObjectByName(mesh.name) as ThreeMesh | undefined
      if (source === undefined) continue
      const sourceMaterial = Array.isArray(source.material) ? source.material[0] : source.material
      const targetMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      const nextMap = sourceMaterial?.map
      if (targetMaterial === undefined || nextMap === undefined) continue
      const previousMap = targetMaterial.map
      targetMaterial.map = nextMap
      targetMaterial.needsUpdate = true
      sourceMaterial.map = undefined
      generation.textures.push(nextMap)
      if (previousMap !== undefined) {
        const at = generation.textures.indexOf(previousMap)
        if (at >= 0) generation.textures.splice(at, 1)
        try { previousMap.dispose() } catch { /* best-effort teardown */ }
      }
      replaced++
    }
    disposeGeneration(throwaway, { textures: false })
    if (replaced === 0) throw new Error('新 glb 里没有可用于热换的贴图')
    generation.revision = next.revision
    generation.artifacts = { ...next.artifacts }
  }

  /** Retire a generation without throwing out of the swap that is running. */
  const retireQuietly = async (generation: Generation, keepBundle: boolean): Promise<void> => {
    try { retire(generation, keepBundle) } catch { /* best-effort teardown */ }
  }

  /** Run one hot swap, keeping the current generation on screen until it lands. */
  const runSwap = async (next: PetModel3dView, plan: SwapPlan): Promise<SwapKindName> => {
    const vendor3 = vendor
    if (vendor3 === undefined) throw new Error('3D 运行库还没就绪')
    if (plan.mesh) {
      const generation = await buildMesh(vendor3, next)
      if (disposed) {
        disposeGeneration(generation, { textures: true })
        return 'none'
      }
      const reuseClips = !plan.clips && live.bundle !== undefined
      if (reuseClips) {
        // The clip payload did not change: hand the SAME library to the new
        // generation instead of re-downloading 150 MB.
        generation.bundle = live.bundle
        generation.clipNames = [...live.clipNames]
        attachMixer(vendor3, generation)
      }
      const previous = live
      adopt(generation, previous, reuseClips)
      // 新 generation 的描边壳是新加的、默认可见：按当前模式**强制**再同步一次，
      // 否则"edge 模式下热换模型"会让新壳一直亮着（切回来才发现）。
      syncOutlineShells(outlineMode(), true)
      // 配饰的穿脱状态记在句柄上，热换换了整棵场景图 ⇒ 必须在新图上重放一次。
      applyHidden()
      if (reuseClips) {
        generation.currentClipName = undefined
        applyState(lastState)
        setStage('ready', `模型已热换（动作数据复用，${generation.clipNames.length} 条 clip）`)
      } else {
        generation.clipNames = []
        void loadClipsInto(generation, next)
      }
      return 'mesh'
    }
    if (plan.textures) {
      await swapTextures(vendor3, next)
      setStage('ready', '贴图已热换')
      return 'textures'
    }
    if (plan.clips) {
      await swapClips(next)
      setStage('ready', '动作已热换（网格未重建）')
      return 'clips'
    }
    return 'none'
  }

  const boot = async (): Promise<void> => {
    if (normalizeSize(container.clientWidth, container.clientHeight) === undefined) {
      // No layout yet. A ResizeObserver never fires for an already-settled zero
      // box, so report a legible failure instead of a silent black square.
      setStage('failed', '容器尺寸为 0')
      if (!disposed) errorListener?.('load-failed')
      return
    }
    const vendor3 = await loadVendor()
    if (disposed) return
    if (vendor3 === undefined) {
      setStage('failed', '3D 运行库缺失')
      errorListener?.('vendor-missing')
      return
    }
    vendor = vendor3
    const webgl = new vendor3.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
    if (disposed) {
      webgl.dispose()
      return
    }
    webgl.setClearColor(0x000000, 0)
    webgl.outputColorSpace = vendor3.SRGBColorSpace
    webgl.domElement.style.display = 'block'
    webgl.domElement.style.width = '100%'
    webgl.domElement.style.height = '100%'
    container.appendChild(webgl.domElement)
    renderer = webgl
    const scene3 = new vendor3.Scene()
    scene = scene3
    const camera3 = new vendor3.PerspectiveCamera(FOV_DEGREES, 1, 0.01, 200)
    camera = camera3
    ambientLight = new vendor3.AmbientLight(0xffffff, BASE_AMBIENT)
    scene3.add(ambientLight)
    const key = new vendor3.DirectionalLight(0xffffff, 1.35)
    key.position.set(1.6, 2.4, 2.2)
    scene3.add(key)
    scene3.add(new vendor3.HemisphereLight(0xdff0ff, 0x2a2a33, 0.55))
    // 补光：放在**前下方**，专门托住朝下的面（下巴/腋下/裙摆内侧）。缺省 0 = 不改变现有观感。
    fillLight = new vendor3.DirectionalLight(0xffffff, 0)
    fillLight.position.set(0.3, -1.6, 1.8)
    scene3.add(fillLight)
    clock = new vendor3.Clock()
    try {
      const generation = await buildMesh(vendor3, view)
      if (disposed) {
        disposeGeneration(generation, { textures: true })
        return
      }
      adopt(generation, live, false)
      syncOutlineShells(outlineMode(), true)
      applyHidden()
      webgl.render(scene3, camera3)
      setStage('model', '模型已上屏')
      lastState = phaseStream.get()
      phaseUnsubscribe = phaseStream.subscribe((state) => {
        lastState = state
        applyState(state)
      })
      // Park the loop whenever the pet is scrolled out of view or the tab is
      // hidden: a persistent WebGL context must not render into nothing.
      if (typeof IntersectionObserver !== 'undefined') {
        intersectionObserver = new IntersectionObserver((records) => {
          const record = records.find(candidate => candidate.target === container)
          inViewport = record === undefined ? true : record.isIntersecting
          syncLoop()
        })
        intersectionObserver.observe(container)
      }
      onDocumentVisibility = () => {
        pageHidden = document.hidden
        syncLoop()
      }
      document.addEventListener('visibilitychange', onDocumentVisibility)
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          layout()
          if (renderer !== undefined && scene !== undefined && camera !== undefined) renderer.render(scene, camera)
          // A resize is often the first moment the box has real area, and the
          // loop may have parked on the earlier zero-size state; re-sync instead
          // of waiting for an event that may never arrive.
          syncLoop()
        })
        resizeObserver.observe(container)
      }
      syncLoop()
      // Deliberately NOT awaited: the character is already on screen, and the
      // clip payload may be a 150 MB download.
      void loadClipsInto(generation, view)
    } catch (error) {
      if (!disposed) {
        setStage('failed', error instanceof Error ? error.message : String(error))
        errorListener?.('load-failed')
      }
    }
  }

  void boot().catch((error: unknown) => {
    if (disposed) return
    setStage('failed', error instanceof Error ? error.message : String(error))
    errorListener?.('load-failed')
  })

  return {
    dispose() {
      if (disposed) return
      disposed = true
      stopLoop()
      // 后处理描边的 RT / 材质 / 四边形跟着一起收：不然热换模型会留下 GPU 资源
      disposeOverlay()
      if (triggerTimer !== undefined) { window.clearTimeout(triggerTimer); triggerTimer = undefined }
      phaseUnsubscribe?.()
      phaseUnsubscribe = undefined
      resizeObserver?.disconnect()
      resizeObserver = undefined
      intersectionObserver?.disconnect()
      intersectionObserver = undefined
      if (onDocumentVisibility !== undefined) document.removeEventListener('visibilitychange', onDocumentVisibility)
      onDocumentVisibility = undefined
      const generation = live
      retire(generation, false)
      const currentRenderer = renderer
      renderer = undefined
      scene = undefined
      camera = undefined
      // A WebGL context is a hard per-page resource cap, so losing it here
      // matters more than the cost of rebuilding it on the next activation.
      const canvas = currentRenderer?.domElement
      try { currentRenderer?.dispose() } catch { /* best-effort teardown */ }
      if (canvas !== undefined && canvas.parentNode !== null) canvas.parentNode.removeChild(canvas)
    },
    stage: () => stage,
    stageDetail: () => stageDetail,
    clipNames: () => [...live.clipNames],
    currentClip: () => live.currentClipName,
    clipsReady: () => live.bundle !== undefined,
    clipsProblems: () => [...clipProblems],
    registeredClipNames: () => (live.bundle?.clips ?? []).map(clip => (clip as { name?: string }).name ?? ''),
    clipMeta: (name: string) => clipMeta.get(name),
    setChoreography(raw: unknown) {
      if (raw === undefined || raw === null) {
        choreography = DEFAULT_CHOREOGRAPHY
        applyRenderOptions()
        return []
      }
      const parsed = parseChoreography(raw)
      // 内容没变就别动状态机：客户端每 2 秒拉一次配置，每次"重来一遍"会让一拍永远演不完。
      const signature = JSON.stringify(parsed.config)
      if (signature === choreographySignature) return parsed.problems
      choreographySignature = signature
      choreography = parsed.config
      applyRenderOptions()
      if (!disposed) {
        currentState = undefined
        sequenceStep = 'idle'
        beatActive = false
        beatPlayed = undefined
        pendingState = undefined
        exitingFrom = undefined
        oneShotActive = false
        applyState(lastState)
      }
      return parsed.problems
    },
    loadedRevision: () => live.revision,
    swapping: () => swapping,
    swapError: () => swapError,
    memory() {
      const info = renderer?.info?.memory
      return { geometries: info?.geometries ?? 0, textures: info?.textures ?? 0 }
    },
    setBackdrop(color: string | null) {
      if (disposed) return
      const target = renderer
      if (target === undefined) return
      // 透明 = 和页面背景混在一起（默认）；不透明纯红 = 破洞/缝隙会直接漏出来。
      backdropColor = color
      if (color === null) target.setClearColor(0x000000, 0)
      else target.setClearColor(color, 1)
      // 立刻重画一帧：点按钮的当下就要看到，别等 30fps 的下一次循环。
      if (scene !== undefined && camera !== undefined) {
        try { target.render(scene, camera) } catch { /* 下一帧会重画 */ }
      }
    },
    async update(next: PetModel3dView): Promise<SwapKindName> {
      if (disposed) return 'none'
      const plan = planFor(next)
      view = next
      if (!plan.any || next.revision === live.revision) {
        // Nothing to load: still adopt a phase-map change so the next state
        // update picks the right clip.
        return 'none'
      }
      swapping = true
      swapError = undefined
      swaps++
      // 热换模型也要重新盖一次：换完的瞬间同样是 T-pose。
      posedOnce = false
      showLoading()
      setStage(stage === 'failed' ? 'model' : stage, `热换中（${next.revision.slice(0, 8)}）`)
      try {
        const kind = await runSwap(next, plan)
        lastSwap = kind
        return kind
      } catch (error) {
        // The failure is REPORTED, never swallowed: a hot fix that did not take
        // effect must not look like a model that quietly stayed broken.
        swapError = error instanceof Error ? error.message : String(error)
        setStage(stage === 'failed' ? 'failed' : stage, `热换失败：${swapError}`)
        return 'none'
      } finally {
        swapping = false
      }
    },
    playNamed(name: string, loop = false) {
      const generation = live
      if (disposed || generation.mixer === undefined || vendor === undefined) return false
      // 单条试播是"更具体"的意图：正在演的演出让位（不调 finishPerformance，
      // 那会把相位重新套一遍，和这次点播打架）。
      playing = undefined
      const clip = clipNamed(generation, name)
      if (clip === undefined) return false
      if (!loop) {
        // 面板点播：不进编排队列（`sequenceStep` 保持 loop），放完由 finished 回到本状态的循环段。
        // 同时放开"循环保持"：点播单条就意味着不再钉住之前那条循环片。
        manualLoop = undefined
        const ok = fadeToOnce(generation, name)
        if (ok) manualPlay = name
        return ok
      }
      const action = actionForClip(generation, clip)
      if (action === undefined) return false
      const previous = generation.currentAction
      action.reset()
      action.setLoop(vendor.LoopRepeat, Infinity)
      action.clampWhenFinished = false
      action.enabled = true
      action.play()
      action.setEffectiveWeight(1)
      if (previous !== undefined && previous !== action && audible(previous)) previous.crossFadeTo(action, FADE_SECONDS, false)
      else action.setEffectiveWeight(1)
      fadeOutOthers(generation, action, previous)
      generation.currentAction = action
      // The memo is set so a phase re-application of the SAME clip does not
      // restart it, and `manualLoop` keeps the phase from taking it away.
      generation.currentClipName = name
      manualLoop = name
      oneShotActive = false
      manualPlay = `${name}（循环）`
      return true
    },
    clearManual() {
      // 回到"跟随相位"：正在演的演出也算手动那一类，一起撤掉。
      playing = undefined
      manualLoop = undefined
      oneShotActive = false
      manualPlay = undefined
      live.currentClipName = undefined
      // 从"被面板拿走"回到编排队列：重新走一遍当前状态（进入段→循环段）。
      currentState = undefined
      sequenceStep = 'idle'
      pendingState = undefined
      applyState(lastState)
    },
    playPerformance(request) {
      const generation = live
      if (disposed || generation.mixer === undefined || vendor === undefined) return false
      const steps = resolvePerformanceSteps(generation, request.steps)
      if (steps.length === 0) return false
      // 演出优先于"面板钉住的循环"和正在放的桥：这是用户显式要求的整段表演。
      manualLoop = undefined
      manualPlay = `${request.id}（演出）`
      oneShotActive = false
      bridge = undefined
      // 演出替这一拍记账：演完回待机，而不是再把 done/failed 的三段式演一遍。
      if (lastState !== undefined && isBeatState(lastState)) beatPlayed = lastState
      playing = { id: request.id, steps, index: 0, elapsed: 0 }
      if (playPerformanceStep(generation, 0)) return true
      playing = undefined
      return false
    },
    stopPerformance() {
      finishPerformance()
    },
    performanceId() {
      return playing?.id
    },
    setPaused(next: boolean) {
      paused = next
      // Drop the parked time so resuming does not jump the animation forward.
      clock?.getDelta()
    },
    paused: () => paused,
    setSpeed(next: number) {
      rate = clamp(next, SPEED_MIN, SPEED_MAX, 1)
      if (live.mixer !== undefined) live.mixer.timeScale = rate
    },
    speed: () => rate,
    setView(next: { yaw?: number; pitch?: number; framing?: number }) {
      if (disposed) return
      if (next.yaw !== undefined) yawDegrees = next.yaw
      if (next.pitch !== undefined) pitchDegrees = clamp(next.pitch, -80, 80, 0)
      if (next.framing !== undefined) framing = clamp(next.framing, 0.05, 4, 1)
      layout()
    },
    setHiddenNodes(names: readonly string[]) {
      if (disposed) return
      const next = new Set(names.filter(name => name !== ''))
      const root = live.root
      // 恢复：只把"上一轮我们藏过、这一轮不要求藏"的节点放出来。模型自己设的不可见不动。
      for (const name of forcedHidden) {
        if (next.has(name)) continue
        const node = root?.getObjectByName(name)
        if (node !== undefined) node.visible = true
        const shell = root?.getObjectByName(name + OUTLINE_SUFFIX)
        // 壳的可见性由描边模式决定，不由"恢复"决定 —— 比如 `off` 模式下它本来就该藏着。
        if (shell !== undefined) shell.visible = outlineMode() === 'shell'
      }
      forcedHidden.clear()
      hiddenNodes = next
      // 藏：新节点可能还没装上（boot 还在跑），那时留到 applyHidden 的重放里。
      applyHidden()
    },
    camera() {
      return {
        yaw: yawDegrees,
        pitch: pitchDegrees,
        framing,
        position: {
          x: camera?.position.x ?? 0,
          y: camera?.position.y ?? 0,
          z: camera?.position.z ?? 0,
        },
      }
    },
    onStage(listener) {
      stageListener = listener
      listener(stage, stageDetail)
    },
    onError(listener) {
      errorListener = listener
    },
    debug() {
      // The panel's instrument. One line, fields chosen because each answers a
      // question a screenshot cannot: `clips` did the model load, `cur` which
      // clip is on the mixer, `os` whether a one-shot owns it, `mt` whether the
      // mixer clock is advancing at all (a frozen clock and a wrong clip look
      // identical in a picture), `ph` what the host asked for, `mplay` what the
      // PANEL asked for (the panel-only field, since a self-directed action
      // would overwrite any shared "last played"), `fr`/`err` whether the frame
      // loop is alive and healthy, and `wd` whether it ever needed a restart.
      return [
        'st=' + stage, 'fr=' + frames, 'err=' + frameErrors, 'wd=' + loopRescues,
        'inv=' + (inViewport ? 1 : 0), 'hid=' + (pageHidden ? 1 : 0),
        'dis=' + (disposed ? 1 : 0),
        'clips=' + (live.bundle === undefined ? 0 : live.bundle.clips.length),
        'idx=' + live.clipNames.length,
        // 编排走到哪一段：enter（进入段）→ loop（循环段）→ exit（退出段）。
        // 守卫靠它验证"跑开始→跑循环→跑结束"真的按顺序发生，而不是只看最后一张图。
        'seq=' + (currentState ?? exitingFrom ?? '-') + ':' + sequenceStep + (pendingState === undefined ? '' : '>' + pendingState),
        'fin=' + finishedEvents + '/' + finishedSkipped,
        // ★ 探针：**当前真正有权重的动作**（name:权重），以及"有几个在同时驱动骨架"。
        //   "角色像在同时做两套动作"这类毛病，看这个字段就能定性：
        //   正常时只该有 1 个（交叉淡入淡出的那 220ms 里会有 2 个）。
        //   全部为 0 ⇒ 骨架没被任何动作驱动（会定格在上一帧），这也是一个明确的故障形态。
        'acts=' + activeActionList(),
        // 运行中的动作总数（不看权重）。和 `acts=` 一起看才能分清"权重被压到 0"与"根本没有动作在跑"。
        'run=' + runningActions,
        // 编排来源（`file` = 用户在编排器里排的，`default` = 内置缺省）与性能开关状态
        'choreo=' + (choreography === DEFAULT_CHOREOGRAPHY ? 'default' : 'file'),
        // 描边：`ol=` 实际生效的方式（shell=反向壳 / edge=深度边缘 / off），
        // `olw=` 反向壳宽度（`default` = 用模型配置里的 toon.outlineWidth）
        'ol=' + outlineMode(),
        'olw=' + (choreography.render?.outlineWidth === undefined ? 'default' : choreography.render.outlineWidth.toFixed(4)),
        'morph=' + (morphsStripped > 0 ? 'off' : 'on'),
        'at=' + (live.currentAction === undefined || live.currentAction.time === undefined ? '-' : live.currentAction.time.toFixed(2)),
        'cur=' + (live.currentClipName === undefined ? '-' : clipLabel(live.currentClipName)), 'os=' + (oneShotActive ? 1 : 0),
        'hold=' + (manualLoop ?? '-'),
        // 配饰穿脱：`parts=all` 表示一件没脱；否则列出被藏起来的节点名。
        // 面板/守卫靠它证明"点了开关真的作用到场景图上了"，而不是只改了按钮样式。
        'parts=' + (hiddenNodes.size === 0 ? 'all' : [...hiddenNodes].join(',')),
        // 本帧的绘制调用/三角形数：**脱掉一件配饰这两个数必须下降** ——
        // 这是"GPU 真的没画它"的硬证据；截图会被动画噪声干扰，这两个数不会。
        'dc=' + (renderer?.info?.render?.calls ?? 0),
        'tri=' + (renderer?.info?.render?.triangles ?? 0),
        // 调试底色：`bk=none` 是透明；`bk=#ff0000` 表示"红底找漏"正开着。
        'bk=' + (backdropColor ?? 'none'),
        'ph=' + lastState, 'paused=' + (paused ? 1 : 0), 'spd=' + rate,
        'mt=' + (live.mixer === undefined ? '-' : live.mixer.time.toFixed(2)),
        'mplay=' + (manualPlay ?? '-'),
        // 诊断：**非当前动作、权重还 >0.5** 的动作（也就是"清道夫该收拾的"）。
        // 排查"两套动作叠加"时，这一栏比 `acts=` 更直接：它一眼指出是谁不该在。
        'strays=' + (() => {
          const mixer = live.mixer as unknown as { _actions?: readonly unknown[] } | undefined
          if (mixer?._actions === undefined) return '-'
          const owner = live.currentAction
          const out: string[] = []
          for (const raw of mixer._actions) {
            if (raw === owner) continue
            const action = raw as { getEffectiveWeight?: () => number; _clip?: { name?: string } }
            const weight = action.getEffectiveWeight?.() ?? 0
            if (weight <= 0.5) continue
            out.push(`${shortClipName(action._clip?.name ?? '?', live.clipNames)}:${weight.toFixed(2)}`)
          }
          return out.length === 0 ? '-' : out.join(',')
        })(),
        // 诊断：历史上"两个以上动作同时有权重"的最长连续时长与那一对名字
        // （<300ms 视为正常交叉淡入淡出，显示 `-`）
        'worst2=' + (overlapWorstMs < 300 ? '-' : `${overlapWorstMs.toFixed(0)}ms:${overlapWorstNames}`),
        'owner=' + (live.currentAction === undefined ? '-' : clipLabel((live.currentAction as unknown as { _clip?: { name?: string } })._clip?.name ?? '?')),
        // 演出：`perf=<id>:<第几步>/<共几步>`，没在演是 `-`。
        // 守卫靠它证明"按顺序演完了整套"（只看截图分不清演出和普通一拍）。
        'perf=' + (playing === undefined ? '-' : `${playing.id}:${playing.index + 1}/${playing.steps.length}`),
        'rev=' + (live.revision === '' ? '-' : live.revision.slice(0, 8)),
        'swaps=' + swaps, 'lastSwap=' + lastSwap, 'swapping=' + (swapping ? 1 : 0),
        ...(swapError === undefined ? [] : ['swapErr=' + swapError]),
        ...(clipProblems.length === 0 ? [] : ['clipsErr=' + clipProblems.length]),
        ...(lastFrameError === undefined ? [] : ['lastFrameErr=' + lastFrameError]),
      ].join(' ')
    },
  }
}
