/**
 * Model catalog — scans `$DSH_HOME/models/<id>/` into served definitions.
 *
 * A folder is a model: the frozen `.import/` container the importer writes, an
 * optional `options.json`, and the user's own source files. There is no
 * `pet.json` and no registry of renderers — the plugin renders exactly one kind
 * of model, so all this module decides is which folders are loadable, what
 * their clips are called, and what content-hashed URLs to serve them from.
 *
 * Rescanning is deliberate: an import that lands while the host is running is
 * picked up within {@link CATALOG_TTL_MS}, with no restart. The per-file caches
 * below are what keep a 1 Hz poll from re-reading a 150 MB payload: a digest is
 * computed once per (path, size, mtime) and reused until the bytes change.
 * @module dsh-pet-3d/registry
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseClipIndex, type ClipIndex } from './clips.ts'
import { dshHome } from './dsh-home.ts'
import { readImportMeta, staleSources } from './importer.ts'
import {
  MODEL_DEFAULTS,
  parseModelOptions,
  resolvePhaseClips,
  type ModelOptions,
  type PetDefinition,
  type PetModel3dView,
} from './model.ts'

/** Browser-facing base path of the pet API. */
export const PET_API_PREFIX = '/api/pet3d'

/** Browser-facing base path of the model media routes ('/pet3d/<id>/<file>'). */
export const PET_ASSET_PREFIX = '/pet3d'

/** Browser-facing base path of the runtime bundles. */
export const PET_RUNTIME_PREFIX = PET_API_PREFIX + '/runtime'

/** The only runtime bundle this kernel serves (lazy-loaded by the renderer). */
export const VENDOR_BUNDLE = 'three-vendor.js'

/** How long a scan stays fresh before the next read rescans the models dir. */
export const CATALOG_TTL_MS = 2000

/** The generated container inside one model folder (safe to delete and rebuild). */
export const IMPORT_DIR = '.import'

/** The imported full-fidelity glTF. */
export const MODEL_FILE = 'model.glb'

/** The clip index (names, durations, per-track slices). */
export const CLIPS_INDEX_FILE = 'clips.json'

/** The clip payload (float32 arrays, verbatim from the importer). */
export const CLIPS_BIN_FILE = 'clips.bin'

/** Importer provenance for one import. */
export const IMPORT_META_FILE = 'import.json'

/** The one optional configuration file (five fields, see `model.ts`). */
export const OPTIONS_FILE = 'options.json'

/** Archived models live here and are never scanned. */
export const ARCHIVE_DIR = '_archive'

/** Extensions the asset route will serve. Everything else is refused. */
const SERVABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.glb', '.gltf', '.vrm', '.bin',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ktx2',
  '.json',
])

/** One installed model. */
export interface ModelEntry {
  /** Model id (its directory name; what the URL path uses). */
  id: string
  /** Absolute directory. */
  dir: string
  /** The served definition handed to the browser half. */
  definition: PetDefinition
  /** Clips the index declares. */
  clipCount: number
  /** Bytes of `clips.bin` (0 when the payload has not been imported). */
  clipsBinBytes: number
  /** Bytes of the whole `.import/` container. */
  importBytes: number
  /** Content digest of `model.glb` (empty when it could not be read). */
  revision: string
  /** True when a source file moved since the import (the sweep will re-import). */
  stale: boolean
}

/** One scan result. */
export interface ModelScan {
  entries: ModelEntry[]
  /** Human-readable problems for models that could not be loaded. */
  problems: string[]
}

/** The models directory root. */
export function modelsRoot(): string {
  return join(dshHome(), 'models')
}

/** The `.import/` directory of one model. */
export function importDir(modelDir: string): string {
  return join(modelDir, IMPORT_DIR)
}

/**
 * Walk up from one module URL to the directory holding `package.json`.
 *
 * Needed because the built artifact inlines every source module into
 * `lib/index.js`: `import.meta.url` then points at the bundle, and the walk
 * finds `<package>/package.json` in one step. In a source run it is `<pkg>/src`
 * and takes two.
 * @param fromUrl - `import.meta.url` of the calling module.
 * @returns the package root directory.
 */
export function packageRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl))
  const start = dir
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return start
}

/** Whether a relative asset path may be served (extension allow-list, no escapes). */
export function isServableRelative(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(rel)) return false
  const segments = rel.split(/[\\/]+/)
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false
  return SERVABLE_EXTENSIONS.has(extname(rel).toLowerCase())
}

/**
 * Realpath containment: resolve both sides and require the candidate to stay
 * strictly inside the base. A symlink pointing out of the model directory
 * therefore fails, and the deny-safe direction is a refusal.
 * @param base - the model directory.
 * @param file - the candidate absolute path.
 * @returns the real path, or undefined when it escapes or is missing.
 */
export function containedRealpath(base: string, file: string): string | undefined {
  try {
    const realBase = realpathSync(base)
    const real = realpathSync(file)
    const prefix = realBase.endsWith(sep) ? realBase : realBase + sep
    return real.startsWith(prefix) ? real : undefined
  } catch {
    return undefined
  }
}

/** `size:mtimeMs` of a file, or undefined when it is missing. */
function statKey(file: string): string | undefined {
  try {
    const info = statSync(file)
    if (!info.isFile()) return undefined
    return `${info.size}:${info.mtimeMs}`
  } catch {
    return undefined
  }
}

/** Size of a file in bytes, or 0 when it is missing. */
function fileSize(file: string): number {
  const key = statKey(file)
  return key === undefined ? 0 : Number(key.slice(0, key.indexOf(':')))
}

/** One cached derivation, keyed by the file's `size:mtimeMs`. */
interface Stamp<T> {
  key: string
  value: T
}

const digestCache = new Map<string, Stamp<string>>()
const indexCache = new Map<string, Stamp<ClipIndex | undefined>>()

/** Chunk size for hashing: bounded memory even for a 150 MB payload. */
const HASH_CHUNK = 4 * 1024 * 1024

/** Keep the caches from growing without bound across many re-imports. */
function capCache(cache: Map<string, unknown>): void {
  if (cache.size > 256) cache.clear()
}

/**
 * The content digest of one file, cached by `size:mtimeMs`.
 *
 * A real content hash (not a size/mtime stamp) because it rides a URL that is
 * served with `Cache-Control: immutable`: a stale digest would pin a stale
 * model in the browser for a year. It is computed in 4 MB chunks so a 150 MB
 * `clips.bin` costs a bounded amount of memory, and cached so a 1 Hz client
 * poll never pays for it twice.
 * @param file - absolute path.
 * @returns the first 12 hex digits of sha256, or '' when the file is unreadable.
 */
export function fileDigest(file: string): string {
  const key = statKey(file)
  if (key === undefined) return ''
  const cached = digestCache.get(file)
  if (cached !== undefined && cached.key === key) return cached.value
  let digest = ''
  try {
    const hash = createHash('sha256')
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.allocUnsafe(HASH_CHUNK)
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, null)
        if (read <= 0) break
        hash.update(buffer.subarray(0, read))
      }
    } finally {
      closeSync(fd)
    }
    digest = hash.digest('hex').slice(0, 12)
  } catch {
    digest = ''
  }
  digestCache.set(file, { key, value: digest })
  capCache(digestCache)
  return digest
}

/**
 * Parse one model's `clips.json`, cached by `size:mtimeMs`.
 *
 * Cached because it is read on every scan (to resolve the phase names) and can
 * be several megabytes: re-parsing it once per client poll would be the most
 * expensive thing the host does all day.
 * @param file - absolute path of `clips.json`.
 * @returns the parsed index, or undefined when missing/malformed.
 */
export function clipIndex(file: string): ClipIndex | undefined {
  const key = statKey(file)
  if (key === undefined) return undefined
  const cached = indexCache.get(file)
  if (cached !== undefined && cached.key === key) return cached.value
  let value: ClipIndex | undefined
  try {
    value = parseClipIndex(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    value = undefined
  }
  indexCache.set(file, { key, value })
  capCache(indexCache)
  return value
}

/** Append the content digest as a cache key, when there is one. */
function hashed(url: string, digest: string): string {
  return digest === '' ? url : `${url}?h=${digest}`
}

/**
 * Derive a revision when the importer did not write one.
 *
 * Not a substitute for `import.json.revision` (which also covers the source
 * file and the importer version) but enough for the hot-swap comparison, and it
 * keeps a hand-written or older `.import/` working instead of leaving the pet
 * unable to notice a change at all.
 * @param artifacts - the per-artifact digests.
 * @returns a 12-hex digest over the artifact map.
 */
function deriveRevision(artifacts: Record<string, string>): string {
  const material = Object.keys(artifacts).sort().map(name => `${name}=${artifacts[name]}`).join('\n')
  return createHash('sha256').update(material).digest('hex').slice(0, 12)
}

/**
 * Scan the models directory once.
 * @returns the loaded entries plus one problem line per unloadable model.
 */
export function scanModels(): ModelScan {
  const root = modelsRoot()
  const entries: ModelEntry[] = []
  const problems: string[] = []
  let dirents
  try {
    dirents = readdirSync(root, { withFileTypes: true })
  } catch {
    // No models directory yet: an empty catalog, not an error.
    return { entries, problems }
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const id = dirent.name
    if (id === ARCHIVE_DIR) continue
    const dir = join(root, id)
    const imports = importDir(dir)
    const modelFile = join(imports, MODEL_FILE)
    if (statKey(modelFile) === undefined) {
      problems.push(`models/${id}: 尚未导入（缺 ${IMPORT_DIR}/${MODEL_FILE}），请先跑导入器`)
      continue
    }
    const label = `${OPTIONS_FILE} (models/${id})`
    const warnings: string[] = []
    let options: ModelOptions = {}
    const optionsFile = join(dir, OPTIONS_FILE)
    if (existsSync(optionsFile)) {
      try {
        const parsed = parseModelOptions(JSON.parse(readFileSync(optionsFile, 'utf8')), label)
        options = parsed.options
        warnings.push(...parsed.warnings)
      } catch (error) {
        warnings.push(`${label}: 读取失败（${error instanceof Error ? error.message : String(error)}），已按默认值处理`)
      }
    }
    const clipsFile = join(imports, CLIPS_INDEX_FILE)
    const binFile = join(imports, CLIPS_BIN_FILE)
    const meta = readImportMeta(dir)
    const index = clipIndex(clipsFile)
    if (existsSync(clipsFile) && index === undefined) {
      warnings.push(`${IMPORT_DIR}/${CLIPS_INDEX_FILE} 解析失败，这个模型暂时没有动作清单`)
    }
    const clipNames = (index?.clips ?? []).map(clip => clip.name)
    const resolved = resolvePhaseClips(clipNames, options)
    warnings.push(...resolved.warnings)
    const base = `${PET_ASSET_PREFIX}/${encodeURIComponent(id)}`
    // The host hashes the bytes it actually serves, and keeps those three as the
    // authority; anything else the importer recorded (the texture hashes, which
    // the host does not walk) rides along untouched.
    const modelDigest = fileDigest(modelFile)
    const clipsDigest = fileDigest(clipsFile)
    const binDigest = fileDigest(binFile)
    const artifacts: Record<string, string> = {
      [MODEL_FILE]: modelDigest,
      [CLIPS_INDEX_FILE]: clipsDigest,
      [CLIPS_BIN_FILE]: binDigest,
    }
    for (const [name, digest] of Object.entries(meta?.artifacts ?? {})) {
      if (typeof digest === 'string' && !(name in artifacts)) artifacts[name] = digest
    }
    const revision = typeof meta?.revision === 'string' && meta.revision !== ''
      ? meta.revision
      : deriveRevision(artifacts)
    const view: PetModel3dView = {
      revision,
      artifacts,
      modelUrl: hashed(`${base}/${IMPORT_DIR}/${MODEL_FILE}`, modelDigest),
      clipsUrl: hashed(`${base}/${IMPORT_DIR}/${CLIPS_INDEX_FILE}`, clipsDigest),
      clipsBinUrl: hashed(`${base}/${IMPORT_DIR}/${CLIPS_BIN_FILE}`, binDigest),
      clipsBinBytes: fileSize(binFile),
      clipCount: clipNames.length,
      phases: resolved.phases,
      ...(options.scale === undefined ? {} : { scale: options.scale }),
      ...(options.translate === undefined ? {} : { translate: options.translate }),
      framing: options.framing ?? MODEL_DEFAULTS.framing,
      yaw: options.yaw ?? MODEL_DEFAULTS.yaw,
      maxFps: MODEL_DEFAULTS.maxFps,
      toon: { ...MODEL_DEFAULTS.toon },
    }
    const definition: PetDefinition = {
      id,
      displayName: id,
      description: '',
      warnings,
      model3d: view,
    }
    entries.push({
      id,
      dir,
      definition,
      clipCount: clipNames.length,
      clipsBinBytes: view.clipsBinBytes,
      importBytes: [modelFile, clipsFile, binFile, join(imports, IMPORT_META_FILE), optionsFile]
        .reduce((total, file) => total + fileSize(file), 0),
      revision,
      stale: staleSources(dir, meta).length > 0,
    })
  }
  // Sorted by id, with a `_`-prefixed folder last: `_fixture` and friends are
  // working material, and a real model must never lose the default selection to
  // one of them.
  entries.sort((a, b) => {
    const aPrivate = a.id.startsWith('_') ? 1 : 0
    const bPrivate = b.id.startsWith('_') ? 1 : 0
    if (aPrivate !== bPrivate) return aPrivate - bPrivate
    return a.id.localeCompare(b.id)
  })
  return { entries, problems }
}

/** A short-TTL view over {@link scanModels}. */
export interface ModelCatalog {
  /** The current entries, rescanning when the cache went stale. */
  get(): ModelEntry[]
  /** The problems of the last scan. */
  problems(): string[]
  /** Drop the cache so the next read rescans. */
  invalidate(): void
}

/**
 * Build a catalog with a short TTL.
 * @param ttlMs - how long a scan stays fresh.
 * @param now - clock seam for tests.
 * @returns the catalog.
 */
export function createCatalog(ttlMs: number = CATALOG_TTL_MS, now: () => number = Date.now): ModelCatalog {
  let at = Number.NEGATIVE_INFINITY
  let scan: ModelScan = { entries: [], problems: [] }
  const refresh = (): void => {
    const nowMs = now()
    if (nowMs - at < ttlMs) return
    scan = scanModels()
    at = nowMs
  }
  return {
    get() {
      refresh()
      return scan.entries
    },
    problems() {
      refresh()
      return scan.problems
    },
    invalidate() {
      at = Number.NEGATIVE_INFINITY
    },
  }
}

/**
 * Whether an id is a plain model directory name.
 *
 * The id comes from a URL path segment (`/pet3d/<id>/...`), so it must never be
 * able to name a path: `%2f`-decoded separators, `.`/`..`, a Windows drive
 * prefix or a NUL would otherwise let `join(modelsRoot(), id)` escape the
 * models root. Kept permissive for non-ASCII model names, strict about path
 * syntax.
 * @param id - candidate model id.
 * @returns true when the id is safe to append to the models root.
 */
export function isSafeModelId(id: string): boolean {
  if (id === '' || id === '.' || id === '..') return false
  if (/[\\/\0]/.test(id)) return false
  if (/^[A-Za-z]:/.test(id)) return false
  return true
}

/** The directory of one model, when it exists. */
export function modelDirectory(id: string): string | undefined {
  if (!isSafeModelId(id)) return undefined
  const dir = join(modelsRoot(), id)
  try {
    return statSync(dir).isDirectory() ? dir : undefined
  } catch {
    return undefined
  }
}
