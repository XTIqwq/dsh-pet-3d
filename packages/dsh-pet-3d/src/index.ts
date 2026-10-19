/**
 * dsh-pet-3d host half — mounts the pet service and its HTTP routes.
 *
 * The browser half (the './client' entry) renders the selected model and drives
 * it through the same-origin '/api/pet3d/*' JSON endpoints plus the
 * '/pet3d/<id>/*' media route. Models are folders: dropping an imported model
 * into `$DSH_HOME/models/<id>/` is the whole install step, and it takes effect
 * without a host restart.
 * @module dsh-pet-3d
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context, type Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { ImportRunner, SWEEP_MIN_INTERVAL_MS } from './importer.ts'
import { mountOnce } from './mount-once.ts'
import { createCatalog, packageRoot } from './registry.ts'
import { DISPLAY_DEFAULTS, Pet3dService } from './service.ts'
import { makePet3dRoutes } from './routes.ts'
import {
  emptyProjectionState,
  projectAssistantStreamFrame,
  projectEvent,
  type AssistantStreamFrameLike,
  type ProjectionState,
  type SessionEventLike,
} from './projection.ts'
import type { ActivityPhase } from './state.ts'
import type { Pet3dDisplay } from './persist.ts'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'pet3d'

/** Services required before the pet can mount its surfaces. */
export const inject = ['webServer']

/** Schema defaults of the display fields (an untouched profile resolves here). */
export const PET_FORM_DEFAULTS = DISPLAY_DEFAULTS

/**
 * One settings field as the config carries it. The Host commits an edit into
 * the running config through a live reference rather than remounting the row,
 * so a field usually arrives as that reference; a plain value appears when the
 * plugin runs outside a Loader (tests, direct mounts).
 */
export type LiveField<T> = Volatile<T> | T

/** The display fields a profile entry's config declares. */
export interface PetFormConfig {
  /** Master switch for the plugin (browser half + host routes). */
  enabled?: LiveField<boolean>
  /** Master switch for the pet surface. */
  visible?: LiveField<boolean>
  /** Size of the rendered pet in px (the square the model is framed into). */
  size?: LiveField<number>
  /** Horizontal inset from the viewport's right edge, px. */
  right?: LiveField<number>
  /** Vertical inset from the viewport's bottom edge, px. */
  bottom?: LiveField<number>
  /** Selected model id (a catalog entry; the service clamps stale values). */
  petId?: LiveField<string | undefined>
  /**
   * Absolute path of the importer script the host spawns.
   *
   * Volatile and configurable on purpose: fixing the importer is then a file
   * edit (or a one-line setting change), never a host restart — which is half of
   * "the model must not be nailed down".
   */
  importerScript?: LiveField<string>
}

/**
 * Plugin configuration. Under the 0.1.7 settings model a plugin's own Cordis
 * Config IS its settings page, so the fields the pet card edits live here.
 * Every field is `volatile()` on purpose: the Host serves exactly the volatile
 * fields of a Config and can commit an edit into the RUNNING config, so the pet
 * re-reads the value instead of being remounted for each edit. `petId` stays a
 * plain string because the service clamps it against the catalog, so a stored
 * selection naming a removed pet cannot invalidate the entry.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  visible: z.boolean().default(PET_FORM_DEFAULTS.visible).volatile(),
  size: z.number().step(1).min(80).max(1200).default(PET_FORM_DEFAULTS.size).volatile(),
  right: z.number().step(1).min(0).max(4000).default(PET_FORM_DEFAULTS.right).volatile(),
  bottom: z.number().step(1).min(0).max(4000).default(PET_FORM_DEFAULTS.bottom).volatile(),
  petId: z.string().volatile(),
  importerScript: z.string().default('').volatile(),
})

/** Plugin config: the pet's settings fields. */
export type PetPluginConfig = PetFormConfig

/** Read one live config field. */
function readLive<T>(field: LiveField<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  const ref = field as { get?: () => T | undefined }
  return typeof ref.get === 'function' ? ref.get() ?? fallback : field as T
}

/** The effective display and selected pet of one mount. */
function configOf(config: PetPluginConfig): { display: Pet3dDisplay; petId?: string } {
  const petId = readLive<string | undefined>(config.petId, undefined)
  return {
    display: {
      visible: readLive(config.visible, PET_FORM_DEFAULTS.visible),
      size: readLive(config.size, PET_FORM_DEFAULTS.size),
      right: readLive(config.right, PET_FORM_DEFAULTS.right),
      bottom: readLive(config.bottom, PET_FORM_DEFAULTS.bottom),
    },
    ...(petId === undefined || petId === '' ? {} : { petId }),
  }
}

/**
 * Display fields the profile explicitly changed.
 *
 * `configOf` applies the schema defaults, so "unset" and "set to the default"
 * look identical; the profile's own convention (see `resolveDisplayField`) is
 * that a value equal to the schema default means "not configured". Only the
 * other fields may overwrite the persisted / dragged display — otherwise every
 * mount and every settings broadcast resets the pet to the default corner.
 * @param config - the live plugin config.
 * @returns only the fields that differ from the schema defaults.
 */
function explicitDisplayOf(config: PetPluginConfig): Partial<Pet3dDisplay> {
  const next = configOf(config).display
  const patch: Partial<Pet3dDisplay> = {}
  if (next.size !== PET_FORM_DEFAULTS.size) patch.size = next.size
  if (next.right !== PET_FORM_DEFAULTS.right) patch.right = next.right
  if (next.bottom !== PET_FORM_DEFAULTS.bottom) patch.bottom = next.bottom
  if (next.visible !== PET_FORM_DEFAULTS.visible) patch.visible = next.visible
  return patch
}

/** Register the pet service and its API + media routes on the context. */
export const apply = mountOnce('dsh-pet-3d', applyImpl)

/**
 * Where the packaged importer lives, and the repo copy as a fallback.
 *
 * The packaged copy wins in a deployed install; in the working tree the script
 * is produced by the import workflow at the repository's own `tools/`, so that
 * copy is used when the package one is absent — a model can then be imported and
 * re-imported without configuring anything.
 * @param configured - the profile's override ('' when unset).
 * @param pkgRoot - the plugin package root.
 * @returns the script path to spawn.
 */
export function resolveImporterScript(configured: string, pkgRoot: string): string {
  if (configured !== '') return configured
  const packaged = join(pkgRoot, 'tools', 'pet3d-import.mjs')
  if (existsSync(packaged)) return packaged
  const workspace = join(pkgRoot, '..', '..', 'tools', 'pet3d-import.mjs')
  if (existsSync(workspace)) return workspace
  return packaged
}

function applyImpl(ctx: Context, config: PetPluginConfig = {}): void {
  const pkgRoot = packageRoot(import.meta.url)
  const catalog = createCatalog()
  const initial = configOf(config)
  const service = new Pet3dService(
    { entries: () => catalog.get(), problems: () => catalog.problems() },
    { ...initial.display, ...(initial.petId === undefined ? {} : { petId: initial.petId }) },
  )
  // The runner reads `script` from this object on every run, so a settings edit
  // (or a `resolveImporterScript` change) takes effect on the NEXT import with no
  // remount — that is what makes fixing the importer a no-restart operation.
  const importerConfig = {
    script: resolveImporterScript(readLive(config.importerScript, ''), pkgRoot),
  }
  const runner = new ImportRunner(importerConfig, () => catalog.invalidate())
  const routes = makePet3dRoutes({ service, ctx, packageRoot: pkgRoot, importer: runner })

  // Routes are registered while the plugin is enabled; toggling the setting off
  // makes the pet API disappear until it is re-enabled.
  let disposeRoutes: (() => void) | undefined
  const enabled = (): boolean => readLive(config.enabled, true)
  const syncRoutes = (): void => {
    if (disposeRoutes === undefined && enabled()) {
      disposeRoutes = ctx.effect(() => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      }, 'pet3d: routes')
    } else if (disposeRoutes !== undefined && !enabled()) {
      disposeRoutes()
      disposeRoutes = undefined
    }
  }

  // --- session activity -> phase -------------------------------------------
  // The pet is host-global, so the most recent meaningful event from any
  // session wins the animation. Projection state is PER SESSION, not shared:
  // concurrent sessions (a subagent working while the main one waits) would
  // otherwise pool their in-flight tool calls into one set and report the wrong
  // phase when either of them finishes a call.
  const projections = new Map<unknown, ProjectionState>()
  let displaySession: unknown
  let disposeActivity: (() => void) | undefined

  /** The projection state of one session, created on first sight. */
  const projectionOf = (session: unknown): ProjectionState => {
    let found = projections.get(session)
    if (found === undefined) {
      found = emptyProjectionState()
      projections.set(session, found)
    }
    return found
  }

  /** Commit one projected phase from one session. */
  const applyPhase = (session: unknown, phase: ActivityPhase | undefined): void => {
    if (phase === undefined) return
    displaySession = session
    service.setSessionActive(true)
    service.setPhase(phase)
  }

  /** Start or stop the session listeners that drive the pet. */
  const syncActivity = (): void => {
    if (disposeActivity !== undefined) {
      disposeActivity()
      disposeActivity = undefined
    }
    if (!enabled()) {
      // Terminal events missed while disabled cannot be replayed, so drop the
      // transient state instead of resuming on a stale phase.
      projections.clear()
      displaySession = undefined
      service.setSessionActive(false)
      return
    }
    const disposers = [
      ctx.on('session/event', (session: unknown, event: SessionEventLike) => {
        applyPhase(session, projectEvent(event, projectionOf(session)))
      }),
      ctx.on('agent/assistant-stream', (payload: { agent?: { session?: unknown }; frame?: AssistantStreamFrameLike }) => {
        const frame = payload?.frame
        if (frame === undefined) return
        applyPhase(payload?.agent?.session, projectAssistantStreamFrame(frame))
      }),
      ctx.on('session/disposed', (session: unknown) => {
        projections.delete(session)
        if (session !== displaySession) return
        // The session driving the animation is gone: settle to idle rather than
        // freezing on its last phase.
        displaySession = undefined
        service.setSessionActive(false)
      }),
    ]
    disposeActivity = () => { for (const dispose of disposers) dispose() }
  }

  // A settings edit lands in this row's live config reference and is announced
  // here; the entry is NOT remounted for it, so the pet re-reads the config
  // itself rather than leaving the edit invisible until the next restart.
  const syncSettings = (): void => {
    const next = configOf(config)
    // Only explicit profile fields win; an unset field must keep the persisted
    // (dragged) value instead of being reset to the schema default.
    const patch = explicitDisplayOf(config)
    if (Object.keys(patch).length > 0) service.patchDisplay(patch)
    if (next.petId !== undefined) service.setModelId(next.petId)
    importerConfig.script = resolveImporterScript(readLive(config.importerScript, ''), pkgRoot)
    syncRoutes()
    syncActivity()
  }
  ctx.on('loader/volatile-update', () => { syncSettings() })
  syncSettings()

  // The freshness sweep: a changed source (or a fixed importer) re-imports by
  // itself, at most once every SWEEP_MIN_INTERVAL_MS.
  //
  // It looks at the SELECTED model ONLY, and ImportRunner additionally requires
  // that import to carry a source baseline written by the configured importer.
  // Both gates exist because the failure mode is destructive: an automatic
  // re-import aimed at the wrong folder overwrites that folder's artifacts, and
  // a model the user is not even looking at has no business being rewritten.
  // Deliberately not awaited anywhere: an import is minutes long and must never
  // block a request or the frame loop.
  ctx.effect(() => {
    /** Last logged skip reason per directory: an unchanged reason is not re-logged. */
    const lastSkip = new Map<string, string>()
    const timer = setInterval(() => {
      if (!enabled()) return
      const dir = service.modelDir(service.selectedModelId() ?? '')
      if (dir === undefined) return
      const outcome = runner.sweep([dir])
      const skipped = new Set<string>()
      for (const skip of outcome.skipped) {
        skipped.add(skip.dir)
        if (lastSkip.get(skip.dir) === skip.reason) continue
        lastSkip.set(skip.dir, skip.reason)
        console.warn(`[dsh-pet3d] 自动重导入跳过 ${skip.dir}：${skip.reason}`)
      }
      // A directory that stops being skipped may warn again if it regresses.
      for (const key of [...lastSkip.keys()]) {
        if (!skipped.has(key)) lastSkip.delete(key)
      }
    }, SWEEP_MIN_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'pet3d: reimport sweep')
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running fiber without a
     * remount; dispatched to the owning fiber only. Declared by the Loader and
     * restated here because this package carries no dependency on its types.
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
    /**
     * A session emitted an event; the pet projects it into a phase.
     *
     * These three are restated here for the same reason as above: the emitting
     * packages are only reachable as `import type {}` (they are provided by the
     * Host at runtime), so their declarations may not be in this program. Note
     * the shapes are deliberately structural (`unknown` session, a minimal event
     * projection) because the pet only reads those fields.
     */
    'session/event'(session: unknown, event: SessionEventLike): void
    /** Streaming assistant output; drives the "thinking → writing" transition. */
    'agent/assistant-stream'(payload: {
      agent?: { session?: unknown }
      frame?: AssistantStreamFrameLike
    }): void
    /** A session went away; the pet must not stay frozen on its last phase. */
    'session/disposed'(session: unknown): void
  }
}
