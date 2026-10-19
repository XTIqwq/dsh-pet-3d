/**
 * Offline guard: the pet's IN-PLACE motion must stay "alive" without ever leaving the frame.
 *
 * This is the tripwire for a mistake that shipped once: pinning the locomotion nodes'
 * translation to a constant made the whole body stand still while only the limbs moved —
 * the run played but read as limp ("动画跑起来了，但跑不起来"). The fix keeps the body's
 * bounce and sway but removes the net travel, scales down runaway takes, and pins the
 * facing. Numbers, not vibes:
 *
 *   1. `MainCity_Run_Loop` still has real vertical travel (the bounce is the "drive");
 *   2. its horizontal travel stays inside the box;
 *   3. no clip's horizontal travel exceeds the ceiling (nothing flies out and snaps back);
 *   4. every clip's per-loop net translation is ~0 (no accumulation, so it cannot drift
 *      out of frame over time no matter how long it runs).
 *
 * Usage: node tools/check-pet3d-motion.mjs [modelId]   (default panyinhu)
 * Exit 0 = all four hold.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const modelId = process.argv[2] ?? 'panyinhu'
const modelsRoot = join(process.env.DSH_HOME ?? 'D:\\.dsh', 'models')
const imports = join(modelsRoot, modelId, '.import')
const index = JSON.parse(readFileSync(join(imports, 'clips.json'), 'utf8'))
const bin = readFileSync(join(imports, 'clips.bin'))
const floats = new Float32Array(bin.buffer, bin.byteOffset, Math.floor(bin.byteLength / 4))
/**
 * 只量**身体链**上的平移（走位节点）。
 *
 * 全量平移轨道里混着道具和空标记：`Bip001_Prop1` 一个 take 能走 2689 单位、`Root` 走 1023 单位，
 * 但它们**不动人**（`Root` 是个没有子节点的标记，实测不是骨架祖先）。量它们会得出"宠物飞出画面"
 * 的假结论，所以名单直接取导入器记下来的 `rootMotion.locomotionNodes`。
 */
const locomotion = new Set(
  existsSync(join(imports, 'import.json'))
    ? (JSON.parse(readFileSync(join(imports, 'import.json'), 'utf8')).verification?.rootMotion?.locomotionNodes ?? [])
    : [],
)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}
/** 一条 clip 里**走位节点**的平移在某个轴上的行程；没有可用轨道算 0。 */
const rangeOf = (clip, axis) => {
  let min = Infinity
  let max = -Infinity
  for (const track of clip.tracks) {
    if (track.path !== 'translation' || track.count < 2 || track.components < 3) continue
    if (locomotion.size > 0 && !locomotion.has(track.node)) continue
    for (let i = 0; i < track.count; i++) {
      const v = floats[track.valueOffset + i * track.components + axis]
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0
}
const short = (name) => name.replace(/^Avatar_.*_Ani_/, '')

console.log(`检查 ${modelId} 的原地动作（${index.clips.length} 条 clip）`)
const run = index.clips.find((clip) => /MainCity_Run_Loop$/.test(clip.name))
if (run === undefined) {
  console.log('  （没有 MainCity_Run_Loop，跳过跑循环判据）')
} else {
  const vertical = rangeOf(run, 1)
  const horizontal = Math.hypot(rangeOf(run, 0), rangeOf(run, 2))
  check(vertical >= 8, '跑循环保留身体起伏（不是"四肢动、人不动"的肌无力）', `竖直行程 ${vertical.toFixed(1)} 单位`)
  check(horizontal <= 90, '跑循环的水平行程在画面内', `${horizontal.toFixed(1)} 单位`)
}

let widest = 0
let widestClip = ''
let worstNet = 0
let worstNetClip = ''
for (const clip of index.clips) {
  const wide = Math.hypot(rangeOf(clip, 0), rangeOf(clip, 2))
  if (wide > widest) { widest = wide; widestClip = short(clip.name) }
  for (const track of clip.tracks) {
    if (track.path !== 'translation' || track.count < 2) continue
    if (locomotion.size > 0 && !locomotion.has(track.node)) continue
    for (let axis = 0; axis < 3; axis++) {
      const first = floats[track.valueOffset + axis]
      const last = floats[track.valueOffset + (track.count - 1) * track.components + axis]
      if (!Number.isFinite(first) || !Number.isFinite(last)) continue
      const net = Math.abs(last - first)
      if (net > worstNet) { worstNet = net; worstNetClip = `${short(clip.name)}·${track.node}` }
    }
  }
}
check(widest <= 130, '全量没有会甩出画面的走位行程', `最大水平 ${widest.toFixed(1)} 单位（${widestClip}）`)
check(worstNet <= 1, '每条 clip 的走位平移首末差 ≈ 0（不累积漂移，永远不会跑出画面）', `最大 ${worstNet.toFixed(3)} 单位（${worstNetClip}）`)

console.log(failures === 0 ? '\ncheck-pet3d-motion: 原地动作既有劲又不越界' : `\ncheck-pet3d-motion: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
