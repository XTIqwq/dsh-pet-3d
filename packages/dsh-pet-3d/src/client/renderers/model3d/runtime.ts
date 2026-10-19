/**
 * 3D runtime loading (pet-center, fourth renderer) — the one script a model3d
 * mount needs, fetched lazily through the plugin's own runtime route: the
 * plugin-shipped MIT vendor bundle (three.js + @pixiv/three-vrm). It loads at
 * most once per page; concurrent mounts share the in-flight promise, and a
 * failure is cached as 'absent' so a broken install stops retrying the network
 * every mount.
 *
 * The vendor surface below is the structural slice the renderer consumes; the
 * real objects come from 'window.__dshPet3dThree' (lib/three-vendor.js), so this
 * module never imports three — the client bundle stays lean (the same
 * discipline as the live2d renderer's runtime module).
 * @module dsh-pet-3d/client/renderers/model3d/runtime
 */

/** Runtime file URL the host serves ('/api/pet3d/runtime/<name>'). */
const VENDOR_URL = '/api/pet3d/runtime/three-vendor.js'

/**
 * Object3D slice. Declared structurally rather than aliased to three's own
 * types: importing three's declarations would pull the whole three type graph
 * into the client bundle's build, which is exactly what the vendor split
 * exists to avoid.
 */
export interface ThreeObject3D {
  name: string
  position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number; set(x: number, y: number, z: number): void; multiplyScalar(s: number): unknown }
  visible: boolean
  /** 视锥剔除开关：全屏四边形、以及"包围球按绑定空间算"的蒙皮网格都要能关掉它。 */
  frustumCulled?: boolean
  parent: ThreeObject3D | null
  children: ThreeObject3D[]
  /** Local transform, refreshed by `updateMatrixWorld`. */
  matrixWorld?: { elements: number[] }
  userData: Record<string, unknown>
  traverse(callback: (child: ThreeObject3D) => void): void
  getObjectByName(name: string): ThreeObject3D | undefined
  add(...objects: ThreeObject3D[]): ThreeObject3D
  remove(...objects: ThreeObject3D[]): ThreeObject3D
  updateMatrixWorld(force?: boolean): void
}

/** Material slice accepted by the toon pass. */
export interface ThreeMaterial {
  name?: string
  color?: ThreeColor
  map?: ThreeTexture
  /**
   * Surface maps carried over from the source material.
   *
   * Dropping these is what makes a correct asset look like broken textures: the
   * surface loses its normal/roughness/AO detail and shades as flat patches.
   */
  normalMap?: ThreeTexture
  normalScale?: { x: number; y: number }
  roughnessMap?: ThreeTexture
  roughness?: number
  metalness?: number
  aoMap?: ThreeTexture
  alphaMap?: ThreeTexture
  emissiveMap?: ThreeTexture
  emissive?: ThreeColor
  flatShading?: boolean
  transparent?: boolean
  opacity?: number
  side?: number
  depthWrite?: boolean
  vertexColors?: boolean
  visible?: boolean
  needsUpdate?: boolean
  /** Shader hook the outline shell uses to expand along its normals. */
  onBeforeCompile?: (shader: ThreeShader) => void
  dispose(): void
}

/** The shader source pair three hands `onBeforeCompile`. */
export interface ThreeShader {
  vertexShader: string
  fragmentShader: string
  uniforms: Record<string, unknown>
}

/** Color slice. */
export interface ThreeColor {
  r: number
  g: number
  b: number
  copy(color: ThreeColor): ThreeColor
  multiplyScalar(scalar: number): ThreeColor
  clone(): ThreeColor
  setHex(hex: number): ThreeColor
}

/** Mesh slice (both Mesh and SkinnedMesh satisfy it). */
export interface ThreeMesh extends ThreeObject3D {
  isMesh?: boolean
  isSkinnedMesh?: boolean
  material: ThreeMaterial | ThreeMaterial[]
  geometry: ThreeGeometry
  /**
   * Per-mesh bounds caches.
   *
   * Nullable and writable on purpose: three fills them from the world matrix
   * that happened to be current, and a stale one silently culls the mesh. The
   * renderer drops them after the fit so the first cull recomputes in the final
   * space.
   */
  boundingBox?: unknown
  boundingSphere?: unknown
  /** Present on a SkinnedMesh; the outline shell must share it. */
  skeleton?: unknown
  /** Present on a SkinnedMesh; the outline shell must share it. */
  bindMatrix?: unknown
  /** Bind the shell to the source skeleton (SkinnedMesh.bind). */
  bind?(skeleton: unknown, bindMatrix?: unknown): void
}

/** Geometry slice (the outline pass clones geometries). */
export interface ThreeGeometry {
  dispose(): void
  clone(): ThreeGeometry
}

/** Texture slice; three textures only need disposal here. */
export interface ThreeTexture {
  dispose(): void
  colorSpace?: string
}

/**
 * 带深度纹理的渲染目标（后处理描边用）。
 *
 * 为什么需要它：反向壳描边在层叠薄片上会把黑壳扎出来（夏日装的胡须/毛领就是这样），
 * 换成"深度边缘检测"必须能拿到**深度**，而深度只能通过给 RT 挂 depthTexture 才有。
 */
export interface ThreeDepthTexture {
  dispose(): void
}

/** RT slice — only what the edge-outline pass touches. */
export interface ThreeRenderTarget {
  /** 颜色附件；描边的深度图就存在这里（打包成 RGBA 的线性深度）。 */
  texture: ThreeTexture
  depthTexture: ThreeDepthTexture | null
  setSize(width: number, height: number): void
  dispose(): void
}

/** Uniform bag of the edge-outline shader (three hands it to onBeforeCompile as-is). */
export interface ThreeUniforms {
  [name: string]: { value: unknown }
}

/** AnimationClip slice. */
export interface ThreeAnimationClip {
  name: string
  duration: number
  tracks: unknown[]
  /** three's own reset of every track's cached interpolant. */
  resetDuration?(): void
}

/** AnimationAction slice. */
export interface ThreeAnimationAction {
  enabled: boolean
  paused: boolean
  timeScale: number
  weight: number
  time: number
  isRunning?(): boolean
  reset(): ThreeAnimationAction
  play(): ThreeAnimationAction
  stop(): ThreeAnimationAction
  fadeIn(ms: number): ThreeAnimationAction
  fadeOut(ms: number): ThreeAnimationAction
  crossFadeTo(target: ThreeAnimationAction, ms: number, warp?: boolean): ThreeAnimationAction
  setLoop(mode: number, repetitions?: number): ThreeAnimationAction
  /** 播放倍率（1 = 原速）。收尾段的"加速/放慢对齐 T"用它。 */
  setEffectiveTimeScale(rate: number): ThreeAnimationAction
  /** 直接设权重（`reset()` 不会把 weight 抬回来，所以重播自己时要显式给 1）。 */
  setEffectiveWeight(weight: number): ThreeAnimationAction
  clampWhenFinished: boolean
}

/**
 * The `finished` payload three dispatches for a LoopOnce action.
 *
 * `action` is the point of reading it at all: a self-directed action and a tap can overlap, and
 * without knowing WHICH one ended, the first `finished` hands the mixer back mid-gesture and
 * truncates the newer one — which is exactly what "the wave stops halfway" was.
 */
export interface ThreeAnimationFinishedEvent {
  type: 'finished'
  action: ThreeAnimationAction
}

/** AnimationMixer slice. */
export interface ThreeAnimationMixer {
  time: number
  /** Uniform playback rate; the panel's speed control writes here. */
  timeScale: number
  update(deltaSeconds: number): void
  clipAction(clip: ThreeAnimationClip, root?: ThreeObject3D): ThreeAnimationAction
  stopAllAction(): void
  /** Drop one clip's cached actions (the release half of a clip load). */
  uncacheClip(clip: ThreeAnimationClip): void
  /** Drop every action and binding created for one root. */
  uncacheRoot(root: ThreeObject3D): void
  /**
   * The one mixer event this renderer uses: `'finished'`, raised when a
   * LoopOnce action completes. It is how a one-shot hands the mixer back to the
   * phase loop.
   */
  addEventListener(type: 'finished', listener: (event: ThreeAnimationFinishedEvent) => void): void
  removeEventListener(type: 'finished', listener: (event: ThreeAnimationFinishedEvent) => void): void
}

/** Box3 slice. */
export interface ThreeBox3 {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
  isEmpty(): boolean
  /**
   * Bounds of an object's subtree.
   * @param precise - walk real vertex positions (the same skinning math the
   *   vertex shader runs) instead of trusting each mesh's cached, bind-pose box.
   */
  setFromObject(object: ThreeObject3D, precise?: boolean): ThreeBox3
  getSize(target: { x: number; y: number; z: number }): { x: number; y: number; z: number }
  getCenter(target: { x: number; y: number; z: number }): { x: number; y: number; z: number }
}

/** Vector3 slice. */
export interface ThreeVector3 {
  x: number
  y: number
  z: number
  set(x: number, y: number, z: number): ThreeVector3
}

/** 二元向量（描边 pass 的 texel 步长、near/far 打包都用它）。 */
export interface ThreeVector2 {
  x: number
  y: number
  set(x: number, y: number): ThreeVector2
}

/** A parsed glTF/VRM document. */
export interface ThreeGLTF {
  scene: ThreeObject3D
  scenes: ThreeObject3D[]
  animations: ThreeAnimationClip[]
  userData?: Record<string, unknown>
}

/** WebGLRenderer slice. */
export interface ThreeRenderer {
  domElement: HTMLCanvasElement
  outputColorSpace?: string
  /**
   * three's own resource counters.
   *
   * The leak check for hot swapping reads these: after N swaps the live
   * geometry / texture counts must come back to where they started, and a
   * counter that only grows is the definition of the leak this design has to
   * avoid. `renderer.info` is always present on a real WebGLRenderer; a test
   * double may omit it, hence optional.
   */
  info?: {
    memory: { geometries: number; textures: number }
    /**
     * 上一帧的绘制统计。
     *
     * 为什么仪表要读它：**"脱掉一件配饰"必须让绘制调用数下降** —— 那是"GPU 真的
     * 没画它"的硬证据，而截图会被动画噪声干扰（宠物一直在动）。
     */
    render?: { calls: number; triangles: number }
  }
  setSize(width: number, height: number, updateStyle?: boolean): void
  setPixelRatio(ratio: number): void
  setClearColor(color: ThreeColor | number | string, alpha?: number): void
  render(scene: ThreeObject3D, camera: ThreeObject3D): void
  /** 换渲染目标（后处理描边的深度预渲染用）；`null` = 回到画布。 */
  setRenderTarget(target: ThreeRenderTarget | null): void
  /** 关掉自动清屏才能把描边叠在已画好的画面上（见 renderFrame）。 */
  autoClear: boolean
  dispose(): void
}

/** PerspectiveCamera slice. */
export interface ThreeCamera extends ThreeObject3D {
  fov: number
  aspect: number
  near: number
  far: number
  updateProjectionMatrix(): void
  lookAt(x: number, y: number, z: number): void
}

/** Scene slice. */
export interface ThreeScene extends ThreeObject3D {
  add(...objects: ThreeObject3D[]): ThreeScene
  remove(...objects: ThreeObject3D[]): ThreeScene
  /** 深度预渲染时用它整体覆盖材质（描边的深度图就是这么来的）。 */
  overrideMaterial?: unknown
}

/** GLTFLoader slice (only the decoder hooks the renderer might set are named). */
export interface ThreeGLTFLoader {
  setCrossOrigin(value: string): ThreeGLTFLoader
  setMeshoptDecoder(decoder: unknown): ThreeGLTFLoader
  register(callback: (parser: unknown) => unknown): ThreeGLTFLoader
  load(
    url: string,
    onLoad: (gltf: ThreeGLTF) => void,
    onProgress?: (event: unknown) => void,
    onError?: (error: unknown) => void,
  ): void
  loadAsync(url: string, onProgress?: (event: unknown) => void): Promise<ThreeGLTF>
}

/** The vendor bundle global (window.__dshPet3dThree). */
export interface Model3dVendor {
  Scene: new () => ThreeScene
  PerspectiveCamera: new (fov?: number, aspect?: number, near?: number, far?: number) => ThreeCamera
  WebGLRenderer: new (parameters?: Record<string, unknown>) => ThreeRenderer
  Group: new () => ThreeObject3D
  AnimationMixer: new (root: ThreeObject3D) => ThreeAnimationMixer
  /**
   * The clip-assembly surface.
   *
   * A full-fidelity import keeps its clips OUTSIDE the glTF (a 150 MB payload
   * that must not be parsed as JSON), so this renderer builds the clips itself
   * from `.import/clips.json` + `.import/clips.bin`. `AnimationClip` plus the
   * three track classes are exactly what that needs — and using three's own
   * classes is what keeps the result identical to what `FBXLoader` would have
   * produced from the same numbers.
   */
  AnimationClip: new (name?: string, duration?: number, tracks?: unknown[]) => ThreeAnimationClip
  QuaternionKeyframeTrack: new (name: string, times: Float32Array, values: Float32Array) => unknown
  VectorKeyframeTrack: new (name: string, times: Float32Array, values: Float32Array) => unknown
  NumberKeyframeTrack: new (name: string, times: Float32Array, values: Float32Array) => unknown
  Box3: new () => ThreeBox3
  Vector3: new (x?: number, y?: number, z?: number) => ThreeVector3
  Vector2: new (x?: number, y?: number) => ThreeVector2
  Color: new (value?: number | string) => ThreeColor
  MeshToonMaterial: new (parameters?: Record<string, unknown>) => ThreeMaterial
  MeshBasicMaterial: new (parameters?: Record<string, unknown>) => ThreeMaterial
  Mesh: new (geometry?: ThreeGeometry, material?: ThreeMaterial) => ThreeMesh
  SkinnedMesh: new (geometry?: ThreeGeometry, material?: ThreeMaterial) => ThreeMesh
  AmbientLight: new (color?: number | string, intensity?: number) => ThreeObject3D & { intensity: number }
  DirectionalLight: new (color?: number | string, intensity?: number) => ThreeObject3D & { intensity: number }
  HemisphereLight: new (skyColor?: number | string, groundColor?: number | string, intensity?: number) => ThreeObject3D
  Clock: new () => { getDelta(): number }
  LoopOnce: number
  LoopRepeat: number
  SRGBColorSpace: string
  BackSide: number
  FrontSide: number
  DoubleSide: number
  // --- 后处理描边（2026-10-18）---
  /**
   * 深度边缘检测描边用的那几样。
   *
   * 反向壳（inverted hull）在**层叠薄片**上必然扎黑边：同一份几何外扩一圈纯黑、只画背面，
   * 相邻薄片的黑壳会从缝里露出来。夏日装的胡须/毛领就是单层薄片，于是白毛上出现黑块、
   * 关节处出现黑圈（关掉描边立刻消失，原版 panyinhu 因为皮毛是实体所以干净）。
   * 改法是把"描边"从几何挪到**屏幕空间**：场景渲进带深度的 RT，再用全屏四边形按深度差
   * 画 1~2px 的线 —— 黑壳不再是几何，自然扎不出来。
   */
  WebGLRenderTarget: new (
    width: number,
    height: number,
    options?: Record<string, unknown>,
  ) => ThreeRenderTarget
  ShaderMaterial: new (parameters?: Record<string, unknown>) => ThreeMaterial & {
    uniforms: { [name: string]: { value: unknown } }
  }
  OrthographicCamera: new (left: number, right: number, top: number, bottom: number, near?: number, far?: number) => ThreeCamera
  PlaneGeometry: new (width?: number, height?: number) => ThreeGeometry
  UnsignedByteType: number
  NearestFilter: number
  LinearFilter: number
  RGBAFormat: number
  GLTFLoader: new (manager?: unknown) => ThreeGLTFLoader
  VRMLoaderPlugin: new (parser?: unknown) => unknown
  VRMUtils: {
    removeUnnecessaryVertices?(root: ThreeObject3D): void
    combineSkeletons?(root: ThreeObject3D): void
    rotateVRM0?(vrm: unknown): void
  }
}

declare global {
  interface Window {
    __dshPet3dThree?: Model3dVendor
  }
}

/** Injects one classic script tag; resolves on load, rejects on error. */
type ScriptInjector = (src: string) => Promise<void>

const defaultInjector: ScriptInjector = (src) => new Promise<void>((resolve, reject) => {
  const tag = document.createElement('script')
  tag.src = src
  tag.onload = () => resolve()
  tag.onerror = () => reject(new Error('script failed to load: ' + src))
  document.head.appendChild(tag)
})

/** Test seam: swap the network for a stub injector. */
export interface Model3dRuntimeProbe {
  inject?: ScriptInjector
}

let vendorPromise: Promise<Model3dVendor | undefined> | undefined

/** Ensure the plugin vendor bundle global exists (cached, failure included). */
export function ensureModel3dVendor(probe: Model3dRuntimeProbe = {}): Promise<Model3dVendor | undefined> {
  if (typeof window !== 'undefined' && window.__dshPet3dThree !== undefined) return Promise.resolve(window.__dshPet3dThree)
  if (probe.inject !== undefined) {
    return probe.inject(VENDOR_URL)
      .then(() => typeof window !== 'undefined' ? window.__dshPet3dThree : undefined)
      .catch(() => undefined)
  }
  vendorPromise ??= defaultInjector(VENDOR_URL)
    .then(() => typeof window !== 'undefined' ? window.__dshPet3dThree : undefined)
    .catch(() => undefined)
  return vendorPromise
}

/** Reset the cached script promise (tests). */
export function resetModel3dRuntime(): void {
  vendorPromise = undefined
}
