/**
 * Offline guard for the model FIT — the bug that made the deployed pet a blank
 * transparent canvas while every resource returned 200 and nothing threw.
 *
 * The mechanism, reproduced here with a hand-built rig (no glb, no browser):
 *
 *   1. a `SkinnedMesh`'s bounding box is computed through `bindMatrixInverse`,
 *      which ONLY `SkinnedMesh.updateMatrixWorld()` refreshes. Measuring right
 *      after loading (or after VRMUtils rewrote the meshes) reads a stale cache
 *      and reports the mesh in the wrong space;
 *   2. on a rig whose nodes carry a 100x unit conversion (Unity cm -> m) that
 *      measurement comes out 100x too big, so the fit shrinks the model 100x
 *      and parks the camera 100x too far away;
 *   3. that camera sits outside its own hardcoded `far` plane, three culls every
 *      mesh, and the canvas stays empty — no exception, no warning, all
 *      resources fine.
 *
 * What this asserts: the shipped `fitRig` measures in the space the GPU draws
 * (so the 100x rig normalizes correctly), centres the model on the origin,
 * derives clip planes that bracket it, and refuses to poison the camera when the
 * measurement is unusable.
 *
 * Usage: node tools/check-pet3d-fit.mjs
 * Exit code 0 = every check passed.
 */
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as THREE from 'three'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const { fitRig, CANONICAL_MODEL_HEIGHT } = await import(
  pathToFileURL(join(repoRoot, 'packages', 'dsh-pet-3d', 'src', 'client', 'renderers', 'model3d.ts')).href
)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/**
 * A rig with the shape of the real asset: one skinned mesh, three bones, and a
 * 100x node scale on the whole thing (the FBX cm/m conversion this kernel hit).
 *
 * The mesh is BOUND WHILE DETACHED, exactly as a glTF loader does during
 * parsing: at that moment `matrixWorld` is the identity, so the mesh's
 * `bindMatrix` is the identity too — and `bindMatrixInverse` only becomes the
 * inverse of the real world matrix once `updateMatrixWorld` runs (three's
 * `bindMode: 'attached'`). Measuring before that is the stale-cache trap.
 * @param unitScale - the node scale to bake in.
 * @param deform - move a bone so skinning actually has to do work.
 */
function buildRig(unitScale = 100, deform = false) {
  const root = new THREE.Group()
  root.name = 'Rig'
  root.scale.set(unitScale, unitScale, unitScale)

  const bones = [new THREE.Bone(), new THREE.Bone(), new THREE.Bone()]
  bones[0].name = 'Bip_Hip'
  bones[1].name = 'Bip_Spine'
  bones[2].name = 'Bip_Head'
  bones[0].add(bones[1])
  bones[1].add(bones[2])
  bones[0].position.set(0, 0, 0)
  bones[1].position.set(0, 1, 0)
  bones[2].position.set(0, 1, 0)
  if (deform) bones[2].position.set(0.25, 1, 0)

  const geometry = new THREE.BufferGeometry()
  // A unit-ish quad strip: four vertices, two triangles, in the mesh's own units.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, 0, 0,
    0.5, 0, 0,
    -0.5, 2, 0,
    0.5, 2, 0,
  ], 3))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 1, 0, 0, 1, 2, 0, 0, 0, 1, 0, 0, 1, 2, 0, 0], 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1, 0, 0, 0.5, 0.5, 0, 0], 4))
  geometry.setIndex([0, 1, 2, 2, 1, 3])

  const skeleton = new THREE.Skeleton(bones)
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff }))
  mesh.name = 'Body'
  // Bind while detached (identity bindMatrix), THEN assemble the hierarchy.
  mesh.bind(skeleton)
  root.add(bones[0])
  root.add(mesh)
  return { root, mesh, bones, skeleton }
}

// --- 1. the measurement trap ---------------------------------------------
console.log('check-pet3d-fit: 100x 单位换算 + 蒙皮网格的测量')
{
  // An external transform change leaves every mesh's `bindMatrixInverse` stale
  // until someone refreshes the world matrices — the state the loader and
  // VRMUtils leave behind. `fitRig` must refresh internally, or it measures a
  // space that no longer exists.
  const { root } = buildRig()
  root.updateMatrixWorld(true)
  root.scale.multiplyScalar(7)
  const fit = fitRig(THREE, root, { scale: 1 })
  root.updateMatrixWorld(true)
  const measured = new THREE.Box3().setFromObject(root, true).getSize(new THREE.Vector3())
  check(
    Number.isFinite(measured.y) && Math.abs(measured.y - CANONICAL_MODEL_HEIGHT) < 1e-3,
    '外部改过变换（世界矩阵已陈旧）后 fitRig 仍量到正确的最终高度（内部先刷世界矩阵）',
    `measured=${measured.toArray().map(v => v.toFixed(4))} applied=${fit.applied}`,
  )
}

// --- 2. the shipped fit normalizes and centres ---------------------------
{
  const { root } = buildRig()
  const fit = fitRig(THREE, root, { scale: 1 })
  check(fit.warning === undefined, '可测量的模型不产生 warning', String(fit.warning))
  check(
    Math.abs(fit.size.height - CANONICAL_MODEL_HEIGHT) < 1e-6,
    `归一化到规范高度 ${CANONICAL_MODEL_HEIGHT}`,
    `height=${fit.size.height}`,
  )
  check(fit.applied > 0 && fit.applied < 1, '100× 单位的模型被缩小（而不是放大）', `applied=${fit.applied}`)
  // Where the model actually IS after the fit: skinned world positions.
  root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root, true)
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  check(
    Math.abs(center.x) < 1e-6 && Math.abs(center.y) < 1e-6 && Math.abs(center.z) < 1e-6,
    '缩放后模型中心落在渲染原点（相机是原点轨道，偏心就会偏出画面）',
    `center=${center.toArray().map(v => v.toFixed(6))}`,
  )
  check(
    Math.abs(size.y - CANONICAL_MODEL_HEIGHT) < 1e-3,
    '缩放后实测高度仍是规范高度（fit 的数学与实际渲染一致）',
    `measured=${size.toArray().map(v => v.toFixed(4))}`,
  )
}

// --- 3. the camera derived from the fit contains the model ---------------
{
  const { root } = buildRig()
  const fit = fitRig(THREE, root, { scale: 1 })
  const FOV_DEGREES = 30
  const framing = 1.08
  const rig = { width: fit.size.width, height: fit.size.height }
  const visibleHeight = rig.height / framing
  const halfFov = Math.tan((FOV_DEGREES * Math.PI / 180) / 2)
  const distance = Math.max((visibleHeight / 2) / halfFov, (rig.width / 2) / (halfFov * 1)) * 1.04
  // The shipped layout() derives the clip planes from the fit (a hardcoded far
  // plane is what turned "a bit too far" into "nothing at all").
  const extent = Math.hypot(rig.width, rig.height)
  const near = Math.max(0.001, distance / 1000)
  const far = distance * 4 + extent * 2
  const camera = new THREE.PerspectiveCamera(FOV_DEGREES, 1, near, far)
  camera.position.set(0, 0, distance)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  root.updateMatrixWorld(true)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  )
  const modelBox = new THREE.Box3().setFromObject(root, true)
  check(
    frustum.intersectsBox(modelBox),
    '相机视锥体包含整个模型（这就是"有没有画出来"的判据）',
    `d=${distance.toFixed(3)} near=${near.toFixed(4)} far=${far.toFixed(3)} box=${modelBox.min.toArray().map(v => v.toFixed(2))}..${modelBox.max.toArray().map(v => v.toFixed(2))}`,
  )
  // And the failure mode, for the record: the same model framed with the STALE
  // measurement plus the old hardcoded far plane is entirely culled.
  const staleSize = new THREE.Box3().setFromObject(buildRig().root).getSize(new THREE.Vector3())
  const staleDistance = Math.max((staleSize.y / framing / 2) / halfFov, (staleSize.x / 2) / halfFov) * 1.04
  check(
    staleDistance > 200,
    '陈旧测量推出的相机距离超过旧的固定 far=200（因此每个网格都被剔除）',
    `staleDistance=${staleDistance.toFixed(1)}`,
  )
}

// --- 4. skinning actually deforms, so the fit is not measuring the bind pose
{
  const { root } = buildRig(100, true)
  const fit = fitRig(THREE, root, { scale: 1 })
  check(fit.warning === undefined, '变形骨架也能测量', String(fit.warning))
  check(Math.abs(fit.size.height - CANONICAL_MODEL_HEIGHT) < 1e-6, '变形骨架同样归一化到规范高度', `${fit.size.height}`)
}

// --- 5. an unusable measurement must not poison the camera --------------
{
  const broken = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute([NaN, NaN, NaN], 3))
  broken.add(mesh)
  const fit = fitRig(THREE, broken, { scale: 1 })
  check(fit.warning !== undefined, '尺寸非有限值时给出 warning 而不是把相机推成 NaN', String(fit.warning))
  check(fit.applied === 1, '测量失败时不缩放（保持资源原样）', `applied=${fit.applied}`)
}

// --- 6. the stale options.json scale cannot blank the pet ---------------
{
  const { root } = buildRig()
  const fit = fitRig(THREE, root, { scale: 0.0134 })
  check(
    Math.abs(fit.size.height - CANONICAL_MODEL_HEIGHT * 0.25) < 1e-6,
    '历史遗留的绝对单位系数（0.0134）被钳到 0.25：宠物变成 1/4 大，但仍然可见而不是消失',
    `height=${fit.size.height} applied=${fit.applied}`,
  )
}

console.log(`\ncheck-pet3d-fit: ${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
