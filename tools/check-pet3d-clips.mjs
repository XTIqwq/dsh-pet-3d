/**
 * Offline proof of the clip path: `.import/clips.json` + `.import/clips.bin`
 * → assembled `AnimationClip`s → a REAL three `AnimationMixer` driving a REAL
 * scene graph → released.
 *
 * Uses the real three.js from the workspace (the same library the vendor bundle
 * is built from) and the real fixture model, so this is the actual code path,
 * not a mock: `src/clips.ts` is imported as source (Node strips the types), the
 * clips are assembled by the same function the browser half uses, and the mixer
 * that plays them is three's own.
 *
 * Usage: node tools/check-pet3d-clips.mjs [modelDir]
 * Exit code 0 = every check passed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import * as THREE from 'three'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const modelsRoot = join(process.env.DSH_HOME ?? 'D:\\.dsh', 'models')
const modelDir = process.argv[2] ?? join(modelsRoot, '_fixture')
const imports = join(modelDir, '.import')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

/** Keep the fixture present and at variant A (the identity pose). */
function ensureFixture() {
  const result = spawnSync(process.execPath, [
    join(repoRoot, 'tools', 'make-fixture-model.mjs'), modelDir, '--json', '--variant', 'A',
  ], { encoding: 'utf8', cwd: repoRoot })
  if (result.status !== 0) {
    console.error('  无法生成 fixture：', result.stderr || result.stdout)
    process.exit(1)
  }
  return JSON.parse(result.stdout)
}

/** The fs-backed IO: the same two calls the browser half makes, off disk. */
function fileIo() {
  const read = (url) => {
    const path = url.startsWith('file:') ? fileURLToPath(url) : url
    if (!existsSync(path)) throw new Error(`404 ${path}`)
    return readFileSync(path)
  }
  return {
    async fetchJson(url) { return JSON.parse(read(url).toString('utf8')) },
    async fetchPayload(url) {
      const bytes = read(url)
      return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    },
  }
}

const meta = ensureFixture()
const clipsSource = await import(pathToFileURL(join(repoRoot, 'packages', 'dsh-pet-3d', 'src', 'clips.ts')).href)
const io = fileIo()
const clipsJsonUrl = pathToFileURL(join(imports, 'clips.json')).href
const clipsBinUrl = pathToFileURL(join(imports, 'clips.bin')).href

console.log(`check-pet3d-clips: fixture ${modelDir} (revision ${meta.revision}, variant ${meta.variant})`)

// --- 1. the index and the payload ----------------------------------------
const index = await clipsSource.loadClipIndex(io, clipsJsonUrl)
const payload = await clipsSource.loadClipPayload(io, clipsBinUrl)
check(index.clips.length === 2, 'clips.json 读到 2 条 clip', index.clips.map(clip => clip.name).join(', '))
check(payload instanceof Float32Array, 'clips.bin 读成 float32', `${payload.length} floats / ${payload.byteLength} B`)
check(payload.length === 23, 'payload 元素数与 .import 布局一致（15 + 8）', String(payload.length))
check(
  Object.keys(meta.artifacts).length === 4 && 'clips.bin' in meta.artifacts,
  'import.json 带逐产物哈希（热换判据存在）',
  Object.keys(meta.artifacts).join(', '),
)

// --- 2. assemble the clips ------------------------------------------------
const bundle = clipsSource.buildClipBundle(THREE, index, payload)
check(bundle.clips.length === 2, '组装出 2 条 AnimationClip')
check(bundle.problems.length === 0, '组装没有告警', bundle.problems.join(' | '))
const idle = bundle.clips.find(clip => clip.name === 'Fixture_Arm_Idle_Loop')
const sad = bundle.clips.find(clip => clip.name === 'Fixture_Galgame_Sad')
check(idle !== undefined && sad !== undefined, '两条 clip 名字都在')
check(idle.tracks[0].name === 'FixtureArm.quaternion', '轨道名按 three 绑定约定生成', idle.tracks[0].name)
check(sad.tracks[0].name === 'FixtureArm.position', '位移轨道名按约定生成', sad.tracks[0].name)

// --- 3. the values are the container's values, element by element ---------
{
  let mismatches = 0
  let compared = 0
  for (const clip of index.clips) {
    const built = bundle.clips.find(candidate => candidate.name === clip.name)
    clip.tracks.forEach((track, at) => {
      const times = payload.subarray(track.timeOffset, track.timeOffset + track.count)
      const values = payload.subarray(track.valueOffset, track.valueOffset + track.count * track.components)
      const builtTrack = built.tracks[at]
      for (let i = 0; i < times.length; i++) {
        compared += 1
        if (builtTrack.times[i] !== times[i]) mismatches += 1
      }
      for (let i = 0; i < values.length; i++) {
        compared += 1
        if (builtTrack.values[i] !== values[i]) mismatches += 1
      }
    })
  }
  check(mismatches === 0, '逐元素完全一致（times + values）', `${compared} 个元素，差异 ${mismatches}`)
}

// --- 4. play it on a real mixer ------------------------------------------
{
  const root = new THREE.Object3D()
  root.name = 'FixtureRoot'
  const arm = new THREE.Object3D()
  arm.name = 'FixtureArm'
  root.add(arm)

  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(sad)
  action.setLoop(THREE.LoopRepeat, Infinity)
  action.play()
  mixer.update(0.5)
  const y = arm.position.y
  check(Math.abs(y - (-0.06)) < 1e-6, '播放 0.5s 后骨骼被驱动到插值姿势（translation.y = -0.06）', String(y))

  const idleAction = mixer.clipAction(idle)
  idleAction.setLoop(THREE.LoopRepeat, Infinity)
  idleAction.play()
  mixer.update(0.1)
  check(arm.quaternion.w === 1 && arm.quaternion.x === 0, 'A 变体的 Idle 保持单位四元数', `${arm.quaternion.x},${arm.quaternion.y},${arm.quaternion.z},${arm.quaternion.w}`)
  check(mixer.time > 0, 'mixer 时钟在推进', mixer.time.toFixed(3))

  // --- 5. release ---------------------------------------------------------
  mixer.stopAllAction()
  mixer.uncacheClip(sad)
  mixer.uncacheClip(idle)
  mixer.uncacheRoot(root)
  clipsSource.releaseClipBundle(bundle)
  check(bundle.clips.length === 0, '释放后 clip 列表为空')
  check(bundle.payload === undefined, '释放后 150MB 级的 payload 引用被丢掉')
  const before = arm.position.y
  mixer.update(1)
  check(arm.position.y === before, '释放后 mixer 不再驱动骨架（没有残留 action）')
}
// 真实模型上的"跑起来有劲、又跑不出画面"判据在 tools/check-pet3d-motion.mjs ——
// 那个守卫直接读真实模型目录的 clips.json/bin（本守卫的 [modelDir] 参数会被 fixture 覆盖，读不到真实数据）。

console.log(`\ncheck-pet3d-clips: ${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
