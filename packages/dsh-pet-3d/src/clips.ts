/**
 * The frozen `.import/` clip container — the seam between the FBX importer
 * (workflow A) and this plugin.
 *
 * `clips.json` is an INDEX: per clip, one entry per track describing where its
 * two arrays live in `clips.bin` — offsets counted in float32 ELEMENTS, not
 * bytes. `clips.bin` is those arrays concatenated in order, copied verbatim out
 * of `FBXLoader`'s own `Float32Array`s. Nothing here resamples, interpolates or
 * quantizes: assembling an `AnimationClip` hands three the very same numbers the
 * importer read, which is what makes the import lossless end to end.
 *
 * Pure module (no node, no DOM, no three import): the browser half and the
 * offline guards both use it, and the three constructors arrive as an injected
 * {@link ClipFactory}.
 * @module dsh-pet-3d/clips
 */

/** Track kinds the container may carry (glTF's own vocabulary). */
export type ClipTrackPath = 'rotation' | 'translation' | 'scale' | 'weights'

/** The three binding property each path maps onto (FBXLoader's own naming). */
export const TRACK_SUFFIX: Readonly<Record<ClipTrackPath, string>> = {
  rotation: 'quaternion',
  translation: 'position',
  scale: 'scale',
  weights: 'morphTargetInfluences',
}

/** Components per key for each path. */
export const TRACK_COMPONENTS: Readonly<Record<ClipTrackPath, number>> = {
  rotation: 4,
  translation: 3,
  scale: 3,
  weights: 1,
}

/** The three track class each path needs. */
export type ClipTrackClass = 'QuaternionKeyframeTrack' | 'VectorKeyframeTrack' | 'NumberKeyframeTrack'

/** Which three track class a path is assembled with. */
export const TRACK_CLASS: Readonly<Record<ClipTrackPath, ClipTrackClass>> = {
  rotation: 'QuaternionKeyframeTrack',
  translation: 'VectorKeyframeTrack',
  scale: 'VectorKeyframeTrack',
  weights: 'NumberKeyframeTrack',
}

/** One track's slice of `clips.bin`, with float32-element offsets. */
export interface ClipTrackIndex {
  /** glTF node name the track binds to. */
  node: string
  path: ClipTrackPath
  /** Key count. */
  count: number
  /** Values per key (3 / 4 / 1). */
  components: number
  /** First float32 of this track's `times` array. */
  timeOffset: number
  /** First float32 of this track's `values` array. */
  valueOffset: number
}

/** One clip of the index. */
export interface ClipIndexEntry {
  name: string
  duration: number
  tracks: ClipTrackIndex[]
  /**
   * 人看得懂的名字（导入时由名称对照表带进来，例如"跑·循环"）。
   *
   * 内部一律继续用**英文 id**（`name`）：编排的三段约定（`_Start`/`_Loop`/`_End`）、相位挑选、
   * 面板守卫的断言全都挂在它上面。中文名只用于显示，所以导出成中文名的源文件也能用 ——
   * 导入器按对照表把中文名映射回英文 id。
   */
  displayName?: string
  /** 对照表给的"用途建议"（显示用）。 */
  usage?: string
  /** 对照表给的"慎用"说明（例如 `占位·勿用`、`含NaN·需清洗`）——面板据此禁用并说明原因。 */
  caution?: string
}

/** The whole `clips.json` document. */
export interface ClipIndex {
  version: number
  clips: ClipIndexEntry[]
}

/** The three.js constructors clip assembly needs. */
export interface ClipFactory {
  AnimationClip: new (name?: string, duration?: number, tracks?: unknown[]) => unknown
  QuaternionKeyframeTrack: new (name: string, times: Float32Array, values: Float32Array) => unknown
  VectorKeyframeTrack: new (name: string, times: Float32Array, values: Float32Array) => unknown
  NumberKeyframeTrack: new (name: string, times: Float32Array, values: Float32Array) => unknown
}

/** Build the binding name three resolves: `<node>.<property>`. */
export function trackName(node: string, path: ClipTrackPath): string {
  return `${node}.${TRACK_SUFFIX[path]}`
}

/** Read the payload/JSON sides of the container (injected so tests can use disk). */
export interface ClipIo {
  fetchJson(url: string): Promise<unknown>
  fetchPayload(url: string): Promise<Float32Array>
}

/** Whether a JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite non-negative integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Parse and validate a `clips.json` document.
 *
 * Throws on a malformed document: this is the importer's frozen output, and a
 * silently half-parsed index would show up as "the model's animations are
 * missing" with no lead to follow. Per-TRACK damage is handled later, in
 * {@link buildClipBundle}, where it can degrade a single clip instead of the
 * whole model.
 * @param raw - the parsed JSON value.
 * @returns the validated index.
 */
export function parseClipIndex(raw: unknown): ClipIndex {
  if (!isRecord(raw)) throw new Error('clips.json: 顶层必须是对象')
  if (!Array.isArray(raw.clips)) throw new Error('clips.json: 缺少 "clips" 数组')
  const version = typeof raw.version === 'number' ? raw.version : 1
  const clips: ClipIndexEntry[] = raw.clips.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`clips.json: clips[${index}] 必须是对象`)
    if (typeof entry.name !== 'string' || entry.name === '') {
      throw new Error(`clips.json: clips[${index}].name 必须是非空字符串`)
    }
    const duration = typeof entry.duration === 'number' && Number.isFinite(entry.duration) ? entry.duration : 0
    if (!Array.isArray(entry.tracks)) throw new Error(`clips.json: clips[${index}].tracks 必须是数组`)
    const tracks: ClipTrackIndex[] = entry.tracks.map((track, trackIndex) => {
      const where = `clips[${index}].tracks[${trackIndex}]`
      if (!isRecord(track)) throw new Error(`clips.json: ${where} 必须是对象`)
      if (typeof track.node !== 'string' || track.node === '') throw new Error(`clips.json: ${where}.node 必须是非空字符串`)
      const path = track.path
      if (path !== 'rotation' && path !== 'translation' && path !== 'scale' && path !== 'weights') {
        throw new Error(`clips.json: ${where}.path 无效（${String(path)}）`)
      }
      for (const field of ['count', 'components', 'timeOffset', 'valueOffset'] as const) {
        if (!isCount(track[field])) throw new Error(`clips.json: ${where}.${field} 必须是非负整数`)
      }
      return {
        node: track.node,
        path,
        count: track.count as number,
        components: track.components as number,
        timeOffset: track.timeOffset as number,
        valueOffset: track.valueOffset as number,
      }
    })
    const text = (value: unknown): string | undefined =>
      (typeof value === 'string' && value !== '' ? value : undefined)
    return {
      name: entry.name,
      duration,
      tracks,
      displayName: text(entry.displayName),
      usage: text(entry.usage),
      caution: text(entry.caution),
    }
  })
  return { version, clips }
}

/** One clip as the light index route reports it (no track arrays). */
export interface ClipSummary {
  name: string
  duration: number
  trackCount: number
  keyframes: number
  /**
   * 名称对照表带来的显示名 / 用途 / 慎用说明（没有对照表时缺省）。
   *
   * 由 `/api/pet3d/clips/<id>` 直接交出去：编排器（演出一步一条 clip）和面板都要按
   * **中文名**选动作，否则面对 161 条 `Avatar_Male_Size03_PanYinhu_Ani_…` 根本没法挑。
   */
  displayName?: string
  usage?: string
  caution?: string
}

/** Summarize an index without touching the payload. */
export function clipSummaries(index: ClipIndex): ClipSummary[] {
  return index.clips.map(clip => ({
    name: clip.name,
    duration: clip.duration,
    trackCount: clip.tracks.length,
    keyframes: clip.tracks.reduce((total, track) => total + track.count, 0),
    ...(clip.displayName === undefined ? {} : { displayName: clip.displayName }),
    ...(clip.usage === undefined ? {} : { usage: clip.usage }),
    ...(clip.caution === undefined ? {} : { caution: clip.caution }),
  }))
}

/** Every keyframe in the index. */
export function totalKeyframes(index: ClipIndex): number {
  let total = 0
  for (const clip of index.clips) for (const track of clip.tracks) total += track.count
  return total
}

/** An assembled, still-ownable library. */
export interface ClipBundle {
  index: ClipIndex
  /** The payload the tracks view into; dropped by {@link releaseClipBundle}. */
  payload?: Float32Array
  /** Every assembled `AnimationClip`, in index order. */
  clips: unknown[]
  /** Per-track damage that degraded a clip instead of failing the load. */
  problems: string[]
}

/**
 * Assemble every clip of an index against its payload.
 *
 * The arrays are handed to three as SUBARRAY VIEWS — no copy — so the 150 MB
 * payload is never duplicated, and the values three plays are bit-identical to
 * the ones the importer wrote. A track whose slice runs past the payload, or
 * whose `components` disagrees with its path, is dropped with a problem line
 * rather than taking the model down with it.
 * @param factory - the three constructors.
 * @param index - the validated index.
 * @param payload - `clips.bin` as float32.
 * @returns the bundle, ready to hand to an `AnimationMixer`.
 */
export function buildClipBundle(factory: ClipFactory, index: ClipIndex, payload: Float32Array): ClipBundle {
  const clips: unknown[] = []
  const problems: string[] = []
  for (const entry of index.clips) {
    const tracks: unknown[] = []
    for (const track of entry.tracks) {
      const expected = TRACK_COMPONENTS[track.path]
      if (track.components !== expected) {
        problems.push(`${entry.name}: 轨道 ${track.node}.${track.path} 的 components=${track.components}，应为 ${expected}，已跳过`)
        continue
      }
      const timeEnd = track.timeOffset + track.count
      const valueEnd = track.valueOffset + track.count * track.components
      if (timeEnd > payload.length || valueEnd > payload.length) {
        problems.push(`${entry.name}: 轨道 ${track.node}.${track.path} 越界（需要到 ${Math.max(timeEnd, valueEnd)}，载荷 ${payload.length}），已跳过`)
        continue
      }
      const times = payload.subarray(track.timeOffset, timeEnd)
      const values = payload.subarray(track.valueOffset, valueEnd)
      const name = trackName(track.node, track.path)
      const Track = factory[TRACK_CLASS[track.path]]
      tracks.push(new Track(name, times, values))
    }
    if (tracks.length === 0) {
      problems.push(`${entry.name}: 没有任何可用轨道，已跳过这条 clip`)
      continue
    }
    clips.push(new factory.AnimationClip(entry.name, entry.duration, tracks))
  }
  return { index, payload, clips, problems }
}

/**
 * Drop everything a bundle owns.
 *
 * The mixer must have been uncached FIRST: while an `AnimationAction` is alive
 * it holds its clip, and the clip holds views into the payload. Clearing this
 * object is what lets the 150 MB buffer be collected.
 * @param bundle - the bundle to empty in place.
 */
export function releaseClipBundle(bundle: ClipBundle): void {
  bundle.clips.length = 0
  bundle.payload = undefined
}

/** Read and validate `clips.json` through an injected IO. */
export async function loadClipIndex(io: ClipIo, url: string): Promise<ClipIndex> {
  return parseClipIndex(await io.fetchJson(url))
}

/** Read `clips.bin` through an injected IO as float32. */
export async function loadClipPayload(io: ClipIo, url: string): Promise<Float32Array> {
  const payload = await io.fetchPayload(url)
  if (!(payload instanceof Float32Array)) throw new Error('clips.bin 不是 float32 数据')
  return payload
}
