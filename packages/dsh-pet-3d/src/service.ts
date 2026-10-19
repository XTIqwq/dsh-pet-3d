/**
 * Pet service — the host-side state the browser half polls.
 *
 * Deliberately thin: it holds the activity state machine, the selected model,
 * and the persisted display, and answers one snapshot. No affinity, no treats,
 * no ledger, no gameplay — and, since the folder is the model, no per-model
 * configuration beyond `options.json` either.
 * @module dsh-pet-3d/service
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipSummaries, type ClipSummary } from './clips.ts'
import { parseChoreography, restoreDroppedFields } from './choreography.ts'
import { IMPORT_DIR, CLIPS_INDEX_FILE, clipIndex, type ModelEntry } from './registry.ts'

/** 编排配置的文件名（模型目录内）。 */
export const CHOREOGRAPHY_FILE = 'choreography.json'
import { PetStateMachine, phaseStateOf, type ActivityPhase, type PetStateSnapshot, type PhaseState } from './state.ts'
import { loadPet3dPersist, savePet3dPersist, type Pet3dDisplay, type Pet3dPersist } from './persist.ts'
import type { PetDefinition } from './model.ts'

/**
 * 读磁盘上现有的 `choreography.json` 的**原始 JSON**（读不出来就当没有）。
 *
 * 用途是"把解析器不认识的字段留住"，所以**不能**用 `parseChoreography` 的结果 ——
 * 旧解析器同样看不见那些字段，拿解析结果来恢复就等于没修。
 * @param file - 配置文件的绝对路径。
 * @returns 原始 JSON 对象，或 `undefined`。
 */
function readRawChoreography(file: string): unknown {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as unknown : undefined
  } catch {
    return undefined
  }
}

/** Display defaults when neither config nor persistence says anything. */
export const DISPLAY_DEFAULTS: Pet3dDisplay = { size: 348, right: 24, bottom: 20, visible: true }

/**
 * Collapse a machine snapshot onto the state the pet renders.
 *
 * The state machine keeps the raw phase after a celebration / failure window and
 * only settles its ANIMATION back to idle. The renderer picks its clip from the
 * phase, so exposing the raw value would loop the celebration clip forever
 * instead of falling back to the idle loop.
 * @param rendered - the machine's current snapshot.
 * @returns the phase state the renderer should act on.
 */
export function settledPhaseState(rendered: PetStateSnapshot): PhaseState {
  return rendered.animation === 'idle' ? 'idle' : phaseStateOf(rendered.phase)
}

/** One model as the picker lists it. */
export interface ModelOption {
  id: string
  displayName: string
  /** Clips the model's index declares. */
  clipCount: number
  /** Bytes of the clip payload, so the panel can label the background load. */
  clipsBinBytes: number
  /** Bytes of the whole `.import/` container. */
  importBytes: number
  /** Content revision of the import (the hot-swap key). */
  revision: string
  /** True when a source file moved since the import. */
  stale: boolean
}

/** The snapshot the browser half polls. */
export interface Pet3dSnapshot {
  /** The selected model's served definition, or null when nothing is installed. */
  model: PetDefinition | null
  /**
   * Revision of the selected model's import.
   *
   * The client's 1 Hz poll compares it against what is loaded and hot-swaps in
   * place when it moves — that is the whole point: a fixed model or a re-import
   * must never require a page reload, let alone an app restart.
   */
  modelRevision: string
  /** Every installed model (for the settings picker). */
  models: ModelOption[]
  /** Current phase state. */
  phase: PhaseState
  /** True when a session is being watched. */
  sessionActive: boolean
  /** Where the pet sits and how big it is. */
  display: Pet3dDisplay
  /** Catalog problems worth showing the user. */
  problems: string[]
}

/** What the service needs from the catalog. */
export interface Pet3dServiceDeps {
  /** Every installed model. */
  entries: () => ModelEntry[]
  /** Last scan's problems. */
  problems: () => string[]
}

/**
 * Resolve one display field across the three layers that can set it.
 *
 * Precedence: an explicit config value (one that DIFFERS from the schema
 * default, i.e. the profile really set it) beats a dragged value; otherwise the
 * dragged value wins, so a drag survives a restart; otherwise the config value
 * (which is the schema default) applies. Without the "differs from default"
 * test, a later explicit profile edit would look identical to an untouched
 * field and the stale dragged value would silently win — the classic
 * "I changed the config and nothing happened".
 * @param key - the display field.
 * @param config - the row config's value (defaults already applied by schema).
 * @param schemaDefault - the schema default for that field.
 * @param persisted - the value the user last chose by dragging.
 * @returns the effective value.
 */
export function resolveDisplayField<K extends keyof Pet3dDisplay>(
  key: K,
  config: Pet3dDisplay[K],
  schemaDefault: Pet3dDisplay[K],
  persisted: Partial<Pet3dDisplay>,
): Pet3dDisplay[K] {
  if (config !== schemaDefault) return config
  // TypeScript cannot narrow an indexed access through `Partial<>` (it keeps
  // `Partial<T>[K]`, not `T[K] | undefined`), so the field type is restated
  // here: same key, same field, the fallback is the always-present config value.
  const stored = persisted[key] as Pet3dDisplay[K] | undefined
  return stored ?? config
}

/**
 * The persisted selection key.
 *
 * Still `petId` on disk: the file belongs to this plugin's own history and a
 * rename would silently drop the user's chosen model on the first start after
 * the upgrade. The API accepts `modelId` as well, so nothing has to know that.
 */

/** The pet service: pure state plus the persistence side effect. */
export class Pet3dService {
  private readonly machine = new PetStateMachine()
  private readonly deps: Pet3dServiceDeps
  private displayValue: Pet3dDisplay
  private modelIdValue: string | undefined
  private sessionActive = false

  /**
   * @param deps - the catalog accessors.
   * @param config - the row config's display fields (schema defaults applied).
   * @param schemaDefaults - the schema defaults, for the explicit-edit test.
   */
  constructor(
    deps: Pet3dServiceDeps,
    config: Pet3dDisplay & { petId?: string },
    schemaDefaults: Pet3dDisplay = DISPLAY_DEFAULTS,
  ) {
    this.deps = deps
    const persisted = loadPet3dPersist()
    this.displayValue = {
      size: resolveDisplayField('size', config.size, schemaDefaults.size, persisted.display ?? {}),
      right: resolveDisplayField('right', config.right, schemaDefaults.right, persisted.display ?? {}),
      bottom: resolveDisplayField('bottom', config.bottom, schemaDefaults.bottom, persisted.display ?? {}),
      visible: resolveDisplayField('visible', config.visible, schemaDefaults.visible, persisted.display ?? {}),
    }
    // A configured id is an explicit choice too; otherwise the last selection
    // stands, and failing both, the first installed model wins.
    this.modelIdValue = config.petId !== undefined && config.petId !== ''
      ? config.petId
      : persisted.petId
    if (this.modelIdValue === undefined) this.modelIdValue = this.deps.entries()[0]?.id
  }

  /** The currently selected model id, after clamping to what is installed. */
  selectedModelId(): string | undefined {
    const entries = this.deps.entries()
    if (this.modelIdValue !== undefined && entries.some(entry => entry.id === this.modelIdValue)) {
      return this.modelIdValue
    }
    return entries[0]?.id
  }

  /** Replace the display wholesale (an explicit profile edit / remount). */
  setDisplay(next: Pet3dDisplay): Pet3dDisplay {
    this.displayValue = next
    return this.displayValue
  }

  /**
   * Apply a partial display change and persist it.
   * @param patch - the fields to change.
   * @returns the effective display after the change.
   */
  patchDisplay(patch: Partial<Pet3dDisplay>): Pet3dDisplay {
    const next: Pet3dDisplay = {
      size: patch.size ?? this.displayValue.size,
      right: patch.right ?? this.displayValue.right,
      bottom: patch.bottom ?? this.displayValue.bottom,
      visible: patch.visible ?? this.displayValue.visible,
    }
    this.displayValue = next
    savePet3dPersist({ ...loadPet3dPersist(), display: next, ...this.storedId() })
    return next
  }

  /** Select another model and persist the choice. */
  setModelId(id: string): string | undefined {
    this.modelIdValue = id
    savePet3dPersist({ ...loadPet3dPersist(), display: this.displayValue, ...this.storedId() })
    return this.selectedModelId()
  }

  /** The persisted selection, spelled with this plugin's on-disk key. */
  private storedId(): Pet3dPersist {
    return this.modelIdValue === undefined ? {} : { petId: this.modelIdValue }
  }

  /** The current phase state (the renderer's clip switch reads this). */
  phase(): PhaseState {
    return settledPhaseState(this.machine.render())
  }

  /** Feed one projected activity update. */
  setPhase(phase: ActivityPhase): void {
    this.machine.onActivityStatus({ phase })
  }

  /** Mark the watched session active / disposed. */
  setSessionActive(active: boolean): void {
    this.sessionActive = active
    if (active) this.machine.onSessionActive()
    else this.machine.onSessionDisposed()
  }

  /** The catalog as the picker and the `/models` route report it. */
  models(): ModelOption[] {
    return this.deps.entries().map(entry => ({
      id: entry.id,
      displayName: entry.definition.displayName,
      clipCount: entry.clipCount,
      clipsBinBytes: entry.clipsBinBytes,
      importBytes: entry.importBytes,
      revision: entry.revision,
      stale: entry.stale,
    }))
  }

  /** The directory of one model, when it is installed. */
  modelDir(id: string): string | undefined {
    return this.deps.entries().find(entry => entry.id === id)?.dir
  }

  /**
   * The clip index of one model — names and durations, no track arrays.
   * @param id - the model id.
   * @returns one summary per clip, or undefined when the model has no index.
   */
  clipsOf(id: string): ClipSummary[] | undefined {
    const entry = this.deps.entries().find(candidate => candidate.id === id)
    if (entry === undefined) return undefined
    const index = clipIndex(join(entry.dir, IMPORT_DIR, CLIPS_INDEX_FILE))
    return index === undefined ? undefined : clipSummaries(index)
  }

  /**
   * 写模型目录里的 `choreography.json`（用户在网页编排器里排的"什么时候做什么动作"）。
   *
   * 校验放在这里，因为这是**唯一的写入路径**：写坏配置文件会让宠物不动，所以：
   *   · 先 `parseChoreography` 过一遍，把看不懂的字段报回去（不静默）；
   *   · 写之前把旧文件备份成 `choreography.json.bak`（用户手写的内容不会被默默吃掉）；
   *   · 只写这一个文件，路径由模型目录拼出来，不接受调用方给路径。
   * @param id - 模型 id。
   * @param raw - 配置对象（POST 的 body）。
   * @returns 校验问题清单（空数组 = 干净）与写盘结果。
   */
  writeChoreography(id: string, raw: unknown): { ok: true; file: string; bytes: number; problems: string[] } {
    const entry = this.deps.entries().find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error('unknown-model')
    const { config, problems } = parseChoreography(raw)
    const file = join(entry.dir, CHOREOGRAPHY_FILE)
    // ★ 非破坏性保存：提交里没有、磁盘上还有的白名单字段按**原始 JSON**原样保留并报出来。
    //   真实事故（2026-10-15）：宿主没重启时手里是旧解析器，用户在编排器点一下「保存」，
    //   transitions / seconds / gap / walk / run / think 就全被吃掉了。
    restoreDroppedFields(config, readRawChoreography(file), problems)
    if (existsSync(file)) {
      try { copyFileSync(file, `${file}.bak`) } catch { /* 备份失败不挡写入 */ }
    }
    const body = `${JSON.stringify(config, null, 2)}\n`
    writeFileSync(file, body, 'utf8')
    return { ok: true, file, bytes: Buffer.byteLength(body, 'utf8'), problems }
  }

  /** Render the polled snapshot. */
  snapshot(): Pet3dSnapshot {    const rendered = this.machine.render()
    const id = this.selectedModelId()
    const entry = this.deps.entries().find(candidate => candidate.id === id)
    return {
      model: entry?.definition ?? null,
      modelRevision: entry?.revision ?? '',
      models: this.models(),
      phase: settledPhaseState(rendered),
      sessionActive: this.sessionActive,
      display: this.displayValue,
      problems: this.deps.problems(),
    }
  }
}
