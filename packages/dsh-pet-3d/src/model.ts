/**
 * The model folder contract — `$DSH_HOME/models/<id>/`.
 *
 * One folder IS one model: the imported `.import/` container (see §6 of the
 * construction spec) plus an OPTIONAL `options.json`. There is no `pet.json`
 * any more: the model already carries its meshes, its skeleton and all of its
 * clips, so the only thing left to configure is how to frame it and which clip
 * stands for which of the six phase states.
 *
 * Pure module: no node imports, so the browser half can type-import the served
 * shapes without pulling host code into the client bundle.
 * @module dsh-pet-3d/model
 */

import type { PhaseState } from './state.ts'

/** Resolved toon-shading options as the client renderer consumes them. */
export interface PetModel3dToonView {
  enabled: boolean
  outlineWidth: number
  outlineColor: string
  rimStrength: number
}

/** Where the model sits relative to the rig origin, as viewport fractions. */
export interface ModelTranslate {
  x?: number
  y?: number
}

/** Per-state clip-name overrides written in `options.json`. */
export type ModelPhaseOverrides = Partial<Record<PhaseState, string>>

/** The whole `options.json` document — deliberately five fields, no more. */
export interface ModelOptions {
  /** Uniform scale against the model's own units. */
  scale?: number
  /** Fraction of the model height framed inside the container. */
  framing?: number
  /** Camera yaw in degrees from straight-on. */
  yaw?: number
  translate?: ModelTranslate
  phase?: ModelPhaseOverrides
}

/** The allow-list `options.json` is validated against (order = error message order). */
export const OPTION_FIELDS: readonly string[] = ['scale', 'framing', 'yaw', 'translate', 'phase']

/** Defaults applied when `options.json` omits a field. */
export const MODEL_DEFAULTS = {
  framing: 1,
  yaw: 0,
  maxFps: 30,
  toon: { enabled: true, outlineWidth: 0.0025, outlineColor: '#000000', rimStrength: 0.4 },
} as const

/**
 * The clip-name convention per phase state, tried in order, case-insensitively.
 *
 * A name in `options.json` supersedes this; a state whose convention matches
 * nothing falls back to the model's FIRST clip and records a warning — never an
 * error, because a fresh import must not be able to brick the pet.
 *
 * 注意这是**最后一道兜底**：它按"大小写不敏感的子串"匹配，所以模型目录里的
 * `options.json` 与 `choreography.json` 才是权威（两处都写全了，这里根本不会用到）。
 */
export const PHASE_PATTERNS: Readonly<Record<PhaseState, readonly string[]>> = {
  idle: ['Idle_Loop'],
  walk: ['Walk_Loop'],
  run: ['MainCity_Run_Loop', 'Run_Loop'],
  think: ['Galgame_Think_Loop'],
  done: ['Galgame_Happy_Loop', 'Happy'],
  failed: ['Galgame_Sad_Loop', 'Sad'],
}

/** The `model3d` block as served to the browser half (defaults resolved). */
export interface PetModel3dView {
  /**
   * Content revision of the whole import.
   *
   * `import.json.revision` when the importer wrote one, otherwise a digest the
   * host derives from the artifacts' own sha256. The client compares it on every
   * poll: a change is what triggers an in-place hot swap, so a re-import lands
   * without a page reload and without a host restart.
   */
  revision: string
  /**
   * Per-artifact sha256, keyed by path relative to the model directory.
   *
   * This is what makes a swap PARTIAL: `model.glb` changing means the mesh has
   * to be rebuilt, while `clips.bin` changing means only the actions do — the
   * common hot-fix path, and the one that must not disturb the mesh.
   */
  artifacts: Record<string, string>
  /** Same-origin URL of the imported glTF, content-addressed when hashed. */
  modelUrl: string
  /** Same-origin URL of the clip index (`.import/clips.json`). */
  clipsUrl: string
  /** Same-origin URL of the clip payload (`.import/clips.bin`). */
  clipsBinUrl: string
  /** Bytes of the clip payload, so the panel can say what it is downloading. */
  clipsBinBytes: number
  /** Clips the index declares (the action list before the payload arrives). */
  clipCount: number
  /** Phase state -> clip name, resolved against this model's own clips. */
  phases: Partial<Record<PhaseState, string>>
  /** Uniform scale against the model's own units. */
  scale?: number
  /** Offset in container space, as fractions of the fitted height. */
  translate?: ModelTranslate
  /** Fraction of the model height framed inside the container. */
  framing: number
  /** Camera yaw in degrees from straight-on. */
  yaw: number
  /** Frameloop ceiling for this instance (fps). */
  maxFps: number
  toon: PetModel3dToonView
}

/** One model as the browser half receives it. */
export interface PetDefinition {
  /** Model id (its directory name). */
  id: string
  displayName: string
  description: string
  /** Non-fatal notes from resolving this model (a phase that fell back, …). */
  warnings: string[]
  model3d: PetModel3dView
}

/** Whether a JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an optional finite number; a bad value warns and is dropped. */
function optionalNumber(
  value: unknown,
  field: string,
  label: string,
  warnings: string[],
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push(`${label}: "${field}" 不是有限数字，已忽略`)
    return undefined
  }
  return value
}

/**
 * Parse and validate one `options.json` document.
 *
 * Never throws: a typo costs the pet one option and a warning line on the
 * panel, never the model. Unknown fields are reported rather than silently
 * dropped — a silently ignored `"faming"` is indistinguishable from a bug.
 * @param raw - the parsed JSON value.
 * @param label - where the document came from, for the warning text.
 * @returns the validated options plus one warning per ignored field.
 */
export function parseModelOptions(raw: unknown, label: string): { options: ModelOptions; warnings: string[] } {
  const warnings: string[] = []
  if (!isRecord(raw)) {
    warnings.push(`${label}: 顶层必须是对象，已按默认值处理`)
    return { options: {}, warnings }
  }
  for (const key of Object.keys(raw)) {
    if (!OPTION_FIELDS.includes(key)) {
      warnings.push(`${label}: 未知字段 "${key}"（可用：${OPTION_FIELDS.join(' / ')}），已忽略`)
    }
  }
  const options: ModelOptions = {}
  const scale = optionalNumber(raw.scale, 'scale', label, warnings)
  if (scale !== undefined) options.scale = scale
  const framing = optionalNumber(raw.framing, 'framing', label, warnings)
  if (framing !== undefined) options.framing = framing
  const yaw = optionalNumber(raw.yaw, 'yaw', label, warnings)
  if (yaw !== undefined) options.yaw = yaw
  if (raw.translate !== undefined) {
    if (!isRecord(raw.translate)) {
      warnings.push(`${label}: "translate" 必须是对象，已忽略`)
    } else {
      const translate: ModelTranslate = {}
      const x = optionalNumber(raw.translate.x, 'translate.x', label, warnings)
      if (x !== undefined) translate.x = x
      const y = optionalNumber(raw.translate.y, 'translate.y', label, warnings)
      if (y !== undefined) translate.y = y
      options.translate = translate
    }
  }
  if (raw.phase !== undefined) {
    if (!isRecord(raw.phase)) {
      warnings.push(`${label}: "phase" 必须是对象，已忽略`)
    } else {
      const phase: ModelPhaseOverrides = {}
      for (const [state, clip] of Object.entries(raw.phase)) {
        if (!(state in PHASE_PATTERNS)) {
          warnings.push(`${label}: "phase.${state}" 不是已知状态（可用：${(Object.keys(PHASE_PATTERNS) as string[]).join(' / ')}），已忽略`)
          continue
        }
        if (typeof clip !== 'string' || clip === '') {
          warnings.push(`${label}: "phase.${state}" 必须是非空字符串，已忽略`)
          continue
        }
        phase[state as PhaseState] = clip
      }
      options.phase = phase
    }
  }
  return { options, warnings }
}

/** Find a clip by name: exact match first, then a case-insensitive substring. */
function matchClip(clipNames: readonly string[], wanted: string): string | undefined {
  const lower = wanted.toLowerCase()
  const exact = clipNames.find(name => name.toLowerCase() === lower)
  if (exact !== undefined) return exact
  return clipNames.find(name => name.toLowerCase().includes(lower))
}

/**
 * Resolve the six phase states onto clip names this model actually carries.
 *
 * Order per state: the `options.json` override, then the name convention, then
 * the model's first clip. Everything that fell through lands in `warnings`.
 * @param clipNames - every clip name the model's index declares.
 * @param options - the parsed `options.json`.
 * @returns the resolved map plus one warning per state that fell back.
 */
export function resolvePhaseClips(
  clipNames: readonly string[],
  options: ModelOptions = {},
): { phases: Partial<Record<PhaseState, string>>; warnings: string[] } {
  const warnings: string[] = []
  const phases: Partial<Record<PhaseState, string>> = {}
  if (clipNames.length === 0) {
    warnings.push('模型里没有任何 clip，将保持绑定姿势')
    return { phases, warnings }
  }
  const first = clipNames[0] as string
  for (const state of Object.keys(PHASE_PATTERNS) as PhaseState[]) {
    const override = options.phase?.[state]
    if (override !== undefined) {
      const hit = matchClip(clipNames, override)
      if (hit !== undefined) {
        phases[state] = hit
        continue
      }
      warnings.push(`相位 ${state}：options.json 指定的 "${override}" 不在模型里，改按名字约定找`)
    }
    let found: string | undefined
    for (const pattern of PHASE_PATTERNS[state]) {
      found = matchClip(clipNames, pattern)
      if (found !== undefined) break
    }
    if (found !== undefined) {
      phases[state] = found
      continue
    }
    const patterns = PHASE_PATTERNS[state].map(name => `含 "${name}"`).join(' 或 ')
    warnings.push(`相位 ${state}：${patterns} 的 clip 找不到，退到第一条 clip "${first}"`)
    phases[state] = first
  }
  return { phases, warnings }
}

/**
 * The clip one state should play, given what the loaded model actually carries.
 *
 * The client's own safety net: a clip named by the host but absent from the
 * payload resolves to the first clip instead of throwing or freezing.
 * @param phases - the host-resolved map.
 * @param state - the state being rendered.
 * @param available - every clip name currently registered with the mixer.
 * @returns the clip name, or undefined when the model carries no clips at all.
 */
export function pickClipForState(
  phases: Partial<Record<PhaseState, string>> | undefined,
  state: PhaseState,
  available: readonly string[],
): string | undefined {
  const wanted = phases?.[state]
  if (wanted !== undefined && available.includes(wanted)) return wanted
  return available[0]
}
