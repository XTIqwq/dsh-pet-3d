/**
 * 3D vendor bundle entry (pet-center, fourth renderer) — builds three.js plus
 * the glTF/VRM toolchain into lib/three-vendor.js, an IIFE exposing
 * 'window.__dshPet3dThree'. The sprite-only client bundle never pays for this
 * stack: the model3d renderer lazy-loads the vendor file through the plugin's
 * own runtime route, exactly like the live2d renderer does.
 *
 * Named exports only (no `export * as THREE`): the IIFE global is populated by
 * rolldown's namespace projection, and a wildcard re-export makes the exact
 * property set depend on interop details. The renderer consumes a fixed,
 * explicit surface, so it is spelled out here and mirrored by
 * `model3d/runtime.ts`'s structural types.
 *
 * Deliberately excluded: KTX2Loader (needs a basis transcoder fetched from a
 * CDN at runtime; its bare `import.meta.url` also cannot survive the IIFE
 * format), DRACOLoader and MeshoptDecoder (both need a decoder sidecar and a
 * network fetch). A pet model ships as one self-contained .glb with ordinary
 * PNG/JPEG textures, so none of them are on the path. Add one back only
 * together with the decoder asset it needs and a route to serve it.
 *
 * Redistribution: three.js and @pixiv/three-vrm are both MIT-licensed and may
 * ship inside this plugin.
 */
export {
  AmbientLight,
  AnimationClip,
  AnimationMixer,
  BackSide,
  Box3,
  Clock,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Group,
  HemisphereLight,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NumberKeyframeTrack,
  PerspectiveCamera,
  QuaternionKeyframeTrack,
  SRGBColorSpace,
  Scene,
  SkinnedMesh,
  Vector2,
  Vector3,
  VectorKeyframeTrack,
  WebGLRenderer,
  // --- 后处理描边（2026-10-18）需要的表面 ---
  //
  // 反向壳描边（inverted hull）在**层叠薄片**上会把黑壳从表面里扎出来：夏日装这套的
  // 胡须/毛领/毛边都是单层薄片，于是白毛上出现黑块、关节处出现黑圈（实测关掉描边即消失）。
  // 换成"深度边缘检测"就只需要这几样：把场景渲染进一个带 depthTexture 的 RT，再用全屏
  // 四边形按深度差画 1~2px 的线 —— 黑壳不再是几何，自然不会扎出来。
  LinearFilter,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  WebGLRenderTarget,
} from 'three'
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
export { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
