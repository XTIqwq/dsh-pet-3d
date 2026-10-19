/**
 * Importer runner — the host's side of "the model is never nailed down".
 *
 * The importer is a SEPARATE PROCESS (`spawn(node, [script, modelDir, '--json'])`)
 * whose stdout is one JSON object. Two consequences the user asked for follow
 * directly: fixing the importer script is a file edit rather than a host
 * restart (the script path is configurable), and an import that dies takes its
 * own process down instead of the app.
 *
 * Freshness: `import.json` records the source files' `size + mtimeMs`, and a
 * sweep compares them against the disk at most once every
 * {@link SWEEP_MIN_INTERVAL_MS}. A mismatch re-imports automatically, with one
 * in-flight import per directory — the same folder can never be imported twice
 * at once, however many sweeps and manual clicks overlap.
 * @module dsh-pet-3d/importer
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, extname, isAbsolute, join, posix, resolve, sep } from 'node:path'

/** How a source file looked when the model was last imported. */
export interface ImportSourceStamp {
  size: number
  mtimeMs: number
}

/** The provenance document the importer writes (`import.json`). */
export interface ImportMeta {
  /** Content revision: source sha256 + artifact sha256 + importer version. */
  revision?: string
  /** Per-artifact sha256, keyed by path relative to the model directory. */
  artifacts?: Record<string, string>
  /** Importer format version. */
  importerVersion?: number
  /** Absolute path of the script that produced this import. */
  importerScript?: string
  /**
   * Source files as they looked at import time (the freshness baseline).
   *
   * Typed loosely because importers write it in more than one shape and the
   * reader must survive all of them: a flat `{ "<relpath>": { size, mtimeMs } }`
   * map, or a grouped `{ fbx: { path, bytes, mtimeMs }, textures: [...] }`.
   * {@link normalizeSources} is the one place that knows the difference.
   *
   * ABSENT means the import did not opt into the freshness protocol — an
   * importer that does not write this is never auto-re-imported, because the
   * host has nothing to compare against and guessing would rewrite a foreign
   * model's artifacts.
   */
  sources?: Record<string, unknown>
  sourceFbx?: string
  sourceBytes?: number
  sourceSha256?: string
  importedAt?: string
  clipCount?: number
  warnings?: string[]
}

/** Absolute path of one model's provenance document. */
export function importMetaPath(modelDir: string): string {
  return join(modelDir, '.import', 'import.json')
}

/** Read and sanity-check one `import.json`; undefined when missing or broken. */
export function readImportMeta(modelDir: string): ImportMeta | undefined {
  const file = importMetaPath(modelDir)
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as ImportMeta
  } catch {
    return undefined
  }
}

/** `size:mtimeMs` of one file, or undefined when it is not a readable file. */
function stampOf(file: string): ImportSourceStamp | undefined {
  try {
    const info = statSync(file)
    if (!info.isFile()) return undefined
    return { size: info.size, mtimeMs: Math.round(info.mtimeMs) }
  } catch {
    return undefined
  }
}

/** Keys use forward slashes so a stamp written on Windows still matches. */
function relativeKey(dir: string, absolute: string): string {
  return absolute.slice(dir.length + 1).split(sep).join(posix.sep)
}

/** Directory entries of a directory, or none when it cannot be read. */
function direntsOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * The source files of one model: the `.fbx` files in its root plus everything
 * under `textures/`.
 *
 * Deliberately excludes `.import/` (that is the output) and everything else the
 * user may keep in the folder: an unrelated note or a render must not trigger a
 * re-import.
 * @param modelDir - the model directory.
 * @returns the stamps keyed by relative path.
 */
export function sourceStamps(modelDir: string): Record<string, ImportSourceStamp> {
  const stamps: Record<string, ImportSourceStamp> = {}
  // Absolute paths throughout: a bare file name would be resolved against the
  // process's cwd, which is NOT the model directory.
  const add = (absolute: string): void => {
    const stamp = stampOf(absolute)
    if (stamp !== undefined) stamps[relativeKey(modelDir, absolute)] = stamp
  }
  for (const dirent of direntsOf(modelDir)) {
    if (!dirent.isFile()) continue
    if (extname(dirent.name).toLowerCase() !== '.fbx') continue
    add(join(modelDir, dirent.name))
  }
  const walk = (relative: string): void => {
    for (const dirent of direntsOf(join(modelDir, relative))) {
      const child = relative === '' ? dirent.name : `${relative}/${dirent.name}`
      if (dirent.isDirectory()) walk(child)
      else add(join(modelDir, child))
    }
  }
  walk('textures')
  return stamps
}

/**
 * One source file as a freshness baseline, normalized across importer shapes.
 *
 * `size`/`bytes` and a fractional `mtimeMs` are both real: this kernel's own
 * cooperating importer writes a flat `{ "<relpath>": { size } }` map, while the
 * full-fidelity one writes `{ fbx: { path, bytes }, textures: [{ file, bytes }] }`
 * with sub-millisecond timestamps. Reading only one of them is how a healthy
 * import gets judged stale forever — and a permanently stale 330 MB model is a
 * re-import loop, not a cosmetic bug.
 */
export interface NormalizedSource {
  size: number
  mtimeMs: number
}

/** The recorded baselines plus the entries whose shape was not understood. */
export interface NormalizedSources {
  /** Relative path (forward slashes) -> baseline. */
  recorded: Record<string, NormalizedSource>
  /** Keys that could not be read; reported, never treated as "changed". */
  unknown: string[]
}

/** Two mtimes name the same source unless they differ by more than this, ms. */
export const MTIME_TOLERANCE_MS = 2

/** Whether a JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize a path to the key format `sourceStamps` produces. */
function sourceKeyFromPath(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  return slashed.split('/').filter(part => part !== '' && part !== '.').join('/')
}

/** Read one recorded baseline out of either shape (`size` or `bytes`). */
function normalizeStamp(value: unknown): NormalizedSource | undefined {
  if (!isRecord(value)) return undefined
  const size = typeof value.size === 'number' ? value.size : (typeof value.bytes === 'number' ? value.bytes : undefined)
  const mtimeMs = typeof value.mtimeMs === 'number' ? value.mtimeMs : undefined
  if (size === undefined || mtimeMs === undefined) return undefined
  return { size, mtimeMs }
}

/** The relative key of one entry: a relative `file`, else the basename of `path`. */
function normalizeKey(entry: Record<string, unknown>): string | undefined {
  for (const field of ['file', 'rel', 'relative'] as const) {
    const value = entry[field]
    if (typeof value === 'string' && value !== '' && !/^[A-Za-z]:/.test(value) && !value.startsWith('/')) {
      return sourceKeyFromPath(value)
    }
  }
  for (const field of ['path', 'file', 'absolute', 'name'] as const) {
    const value = entry[field]
    if (typeof value !== 'string' || value === '') continue
    const parts = sourceKeyFromPath(value).split('/')
    return parts[parts.length - 1] ?? undefined
  }
  return undefined
}

/**
 * Normalize a `sources` block into `relative path -> baseline`.
 *
 * Understood shapes: the flat map, and the grouped `{ fbx, textures: [...] }`
 * form. Anything else lands in `unknown` and is IGNORED by the freshness
 * comparison — the deny-safe direction, because a shape this reader does not
 * understand must not be the reason a 330 MB import runs forever.
 * @param meta - the provenance document.
 * @returns the normalized baselines.
 */
export function normalizeSources(meta: ImportMeta | undefined): NormalizedSources {
  const recorded: Record<string, NormalizedSource> = {}
  const unknown: string[] = []
  const raw = meta?.sources
  if (!isRecord(raw)) return { recorded, unknown }
  for (const [key, value] of Object.entries(raw)) {
    // A grouped entry: an array of files, or one file under a group name.
    if (Array.isArray(value)) {
      let read = 0
      for (const entry of value) {
        if (!isRecord(entry)) continue
        const stamp = normalizeStamp(entry)
        const file = normalizeKey(entry)
        if (stamp === undefined || file === undefined) continue
        recorded[file] = stamp
        read += 1
      }
      if (read === 0) unknown.push(key)
      continue
    }
    if (isRecord(value)) {
      const stamp = normalizeStamp(value)
      if (stamp !== undefined) {
        // Flat shape when the key already looks like a path, grouped otherwise
        // (the grouped `fbx` entry carries its own `path`).
        const looksLikePath = key.includes('/') || key.includes('\\') || key.includes('.')
        recorded[looksLikePath ? sourceKeyFromPath(key) : (normalizeKey(value) ?? key)] = stamp
        continue
      }
      unknown.push(key)
      continue
    }
    unknown.push(key)
  }
  return { recorded, unknown }
}

/** Why one recorded source does or does not match the disk. */
export interface FreshnessRow {
  key: string
  /** `match` and `unknown-shape` are both "not stale". */
  status: 'match' | 'size' | 'mtime' | 'missing' | 'extra' | 'unknown-shape'
  expected: string
  actual: string
}

/**
 * A per-key freshness report.
 *
 * This exists because "9 keys are stale" is not actionable: which side failed,
 * what was expected and what the disk says are what name the mismatch. The
 * offline guard prints these rows when the real product is judged stale.
 * @param modelDir - the model directory.
 * @param meta - its provenance document.
 * @returns one row per recorded source, plus one per unrecorded source on disk.
 */
export function freshnessReport(modelDir: string, meta: ImportMeta | undefined): FreshnessRow[] {
  const { recorded, unknown } = normalizeSources(meta)
  const now = sourceStamps(modelDir)
  const rows: FreshnessRow[] = []
  const judgeable = Object.keys(recorded).length > 0
  for (const [key, stamp] of Object.entries(recorded)) {
    const current = now[key]
    const expected = `${stamp.size}B @ ${stamp.mtimeMs}`
    if (current === undefined) {
      rows.push({ key, status: 'missing', expected, actual: '磁盘上没有这个文件' })
    } else if (current.size !== stamp.size) {
      rows.push({ key, status: 'size', expected, actual: `${current.size}B @ ${current.mtimeMs}` })
    } else if (Math.abs(current.mtimeMs - stamp.mtimeMs) > MTIME_TOLERANCE_MS) {
      rows.push({ key, status: 'mtime', expected, actual: `${current.size}B @ ${current.mtimeMs}` })
    } else {
      rows.push({ key, status: 'match', expected, actual: `${current.size}B @ ${current.mtimeMs}` })
    }
  }
  // A baseline NOTHING could be read out of cannot judge the disk: reporting
  // every real file as "unrecorded" would judge a healthy model stale for the
  // same reason an unreadable key would — and a stale 330 MB model re-imports
  // forever. So extras are only reported when at least one baseline was read.
  if (judgeable) {
    for (const key of Object.keys(now)) {
      if (key in recorded) continue
      const stamp = now[key] as ImportSourceStamp
      rows.push({ key, status: 'extra', expected: '未被记录', actual: `${stamp.size}B @ ${stamp.mtimeMs}` })
    }
  }
  for (const key of unknown) {
    rows.push({ key, status: 'unknown-shape', expected: '（形状无法识别，按新鲜处理）', actual: '' })
  }
  return rows
}

/**
 * Which recorded source files no longer match the disk.
 *
 * An import with NO readable `sources` baseline reports "nothing changed",
 * always. That is the deny-safe direction and it is deliberate: without a
 * baseline the host cannot tell a stale import from a foreign one, and a wrong
 * guess here rewrites another model's artifacts.
 * @param modelDir - the model directory.
 * @param meta - its provenance document.
 * @returns the relative paths that changed, appeared or disappeared.
 */
export function staleSources(modelDir: string, meta: ImportMeta | undefined): string[] {
  return freshnessReport(modelDir, meta)
    .filter(row => row.status !== 'match' && row.status !== 'unknown-shape')
    .map(row => row.key)
}

/** Whether two script paths name the same file (case- and separator-insensitive). */
export function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => resolve(value).replace(/\\/g, '/').toLowerCase()
  return normalize(a) === normalize(b)
}

/**
 * Whether one directory's import was produced by a DIFFERENT importer script.
 *
 * The automatic sweep refuses such a directory outright. The manual re-import
 * route surfaces this as a confirmation request instead of refusing: pointing
 * the config at a new script and re-importing with it is exactly how a fixed
 * importer gets adopted, so the user may override — but never by accident, and
 * never without the two path names in front of them.
 * @param modelDir - the model directory.
 * @param script - the importer script currently configured.
 * @returns the conflict description, or undefined when there is nothing to confirm.
 */
export function importConflict(modelDir: string, script: string): string | undefined {
  const meta = readImportMeta(modelDir)
  if (meta === undefined) return undefined
  const recorded = meta.importerScript
  if (typeof recorded !== 'string' || recorded === '') return undefined
  if (samePath(recorded, script)) return undefined
  // A relative record (the packaged bundle writes `tools/pet3d-import.mjs`)
  // cannot be resolved against an install location we do not know, so compare
  // the file name. Two different importers sharing a basename are rare enough
  // that a false "same" is safer than asking for confirmation on every run.
  if (!isAbsolute(recorded) && basename(recorded) === basename(script)) return undefined
  return `这份 .import 产物是 ${recorded} 写的，当前配置的导入器是 ${script}`
}

/** The outcome of one importer run. */
export interface ImportOutcome {
  ok: boolean
  /** Human-readable failure reason (empty when `ok`). */
  error: string
  revision: string
  artifacts: Record<string, string>
  warnings: string[]
  /** Importer stdout, kept for the failure path and for the log. */
  stdout: string
  stderr: string
  durationMs: number
}

/** How the host invokes the importer. */
export interface ImporterConfig {
  /** Absolute path of `pet3d-import.mjs` (configurable: a script fix needs no restart). */
  script: string
  /** Node executable (defaults to the running one, so the app's Node is reused). */
  node?: string
  /** Hard cap on one import, ms. A 345 MB FBX import is minutes, not seconds. */
  timeoutMs?: number
}

/** Default cap on one import: long enough for a 345 MB source. */
export const IMPORT_TIMEOUT_MS = 20 * 60 * 1000

/** How often the freshness sweep may look at the disk, ms (spec: ≤ once / 5 s). */
export const SWEEP_MIN_INTERVAL_MS = 5000

/** Largest stdout capture (a runaway importer must not eat the host's memory). */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024

/** Parse the importer's stdout: the whole body, else its last JSON line. */
function parseImporterJson(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim()
  const attempt = (text: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined
    } catch {
      return undefined
    }
  }
  const whole = attempt(trimmed)
  if (whole !== undefined) return whole
  const lines = trimmed.split(/\r?\n/).filter(line => line.trim().startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = attempt(lines[i] as string)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Spawn one importer run and wait for it.
 *
 * The model directory is the only argument beyond `--json`, so the importer is
 * data-driven: a different FBX is a different folder, never a code change.
 * @param modelDir - the model folder to (re)import.
 * @param config - the importer script, node executable and timeout.
 * @returns the outcome, with the on-disk `import.json` as the authority for the
 *   revision and the artifact hashes.
 */
export function runImporter(modelDir: string, config: ImporterConfig): Promise<ImportOutcome> {
  const started = Date.now()
  const fail = (error: string, extra: Partial<ImportOutcome> = {}): ImportOutcome => ({
    ok: false, error, revision: '', artifacts: {}, warnings: [],
    stdout: '', stderr: '', durationMs: Date.now() - started, ...extra,
  })
  if (!existsSync(config.script)) {
    return Promise.resolve(fail(`导入器脚本不存在：${config.script}`))
  }
  return new Promise<ImportOutcome>((resolve) => {
    let child
    try {
      child = spawn(config.node ?? process.execPath, [config.script, modelDir, '--json'], {
        cwd: modelDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve(fail(`无法启动导入器：${error instanceof Error ? error.message : String(error)}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (outcome: ImportOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish(fail(`导入超时（${config.timeoutMs ?? IMPORT_TIMEOUT_MS} ms）`, { stdout, stderr }))
    }, config.timeoutMs ?? IMPORT_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDOUT_BYTES) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish(fail(`导入器进程错误：${error.message}`, { stdout, stderr }))
    })
    child.on('close', (code) => {
      const durationMs = Date.now() - started
      if (code !== 0) {
        // A `link:`-installed plugin has no `three` in the profile tree (pnpm
        // does not install dependencies of a linked package). Say what to do
        // instead of surfacing the raw module-not-found line.
        if (/Cannot find package ['"]three['"]/u.test(stderr)) {
          finish(fail(
            '导入器缺少 three 依赖：请在 profile 目录执行 pnpm add three@0.186.1 后重试，或改用 tgz 安装插件',
            { stdout, stderr, durationMs },
          ))
          return
        }
        const detail = stderr.trim().split(/\r?\n/).slice(-4).join(' | ')
        finish(fail(`导入器退出码 ${String(code)}${detail === '' ? '' : `：${detail}`}`, { stdout, stderr, durationMs }))
        return
      }
      // The DOCUMENT is the authority, not stdout: the importer may print
      // progress lines, and the revision has to describe the bytes that are
      // actually on disk now.
      const meta = readImportMeta(modelDir)
      const printed = parseImporterJson(stdout)
      const revision = typeof meta?.revision === 'string' && meta.revision !== ''
        ? meta.revision
        : (typeof printed?.revision === 'string' ? printed.revision : '')
      const artifacts = meta?.artifacts ?? (isArtifactMap(printed?.artifacts) ? printed?.artifacts as Record<string, string> : {})
      const warnings = [
        ...(Array.isArray(meta?.warnings) ? meta?.warnings.filter((line): line is string => typeof line === 'string') ?? [] : []),
      ]
      if (revision === '') {
        finish(fail('导入器没有产出 revision（import.json 缺 revision 字段）', { stdout, stderr, durationMs }))
        return
      }
      resolve({ ok: true, error: '', revision, artifacts, warnings, stdout, stderr, durationMs })
    })
  })
}

/** Whether a value is a `name -> sha256` map. */
function isArtifactMap(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'string')
}

/**
 * The import scheduler: one in-flight import per directory, the ≤5 s freshness
 * sweep, and a backoff that stops a permanently-stale directory from becoming a
 * permanently-running import.
 */
export class ImportRunner {
  private readonly config: ImporterConfig
  private readonly inflight = new Map<string, Promise<ImportOutcome>>()
  private readonly lastOutcome = new Map<string, ImportOutcome>()
  /**
   * Directories whose automatic re-import was called off, and why.
   *
   * The case this exists for: sources that read as changed forever (a stamp
   * shape mismatch, a file that keeps being touched by something else) while the
   * importer keeps producing the SAME revision. Left alone, the 5 s sweep would
   * re-import a 330 MB FBX for the rest of the session. Missing one hot update
   * is a far smaller loss than that, so the sweep gives up and says so.
   */
  private readonly autoStalled = new Map<string, string>()
  private lastSweep = Number.NEGATIVE_INFINITY
  private readonly onChanged: (modelDir: string) => void
  private readonly now: () => number

  /**
   * @param config - how to invoke the importer.
   * @param onChanged - called after a successful import (the catalog invalidates).
   * @param now - clock seam for the sweep throttle.
   */
  constructor(config: ImporterConfig, onChanged: (modelDir: string) => void = () => {}, now: () => number = Date.now) {
    this.config = config
    this.onChanged = onChanged
    this.now = now
  }

  /** The script this runner invokes (surfaced by the state route). */
  script(): string {
    return this.config.script
  }

  /** Whether a directory currently has an import running. */
  busy(modelDir: string): boolean {
    return this.inflight.has(modelDir)
  }

  /** The last outcome of one directory, when it has been imported by this host. */
  outcome(modelDir: string): ImportOutcome | undefined {
    return this.lastOutcome.get(modelDir)
  }

  /**
   * Why automatic re-import stopped for one directory, if it did.
   *
   * Surfaced on the panel: a stalled model must not look like a model that is
   * being kept up to date.
   * @param modelDir - the model directory.
   * @returns the reason, or undefined while the sweep is still live for it.
   */
  stall(modelDir: string): string | undefined {
    return this.autoStalled.get(modelDir)
  }

  /**
   * Import one directory, sharing the in-flight run when there is one.
   * @param modelDir - the model folder.
   * @param opts - `auto` marks a sweep-initiated run, which is the only kind that
   *   may be called off by the backoff.
   * @returns the outcome.
   */
  run(modelDir: string, opts: { auto?: boolean } = {}): Promise<ImportOutcome> {
    const existing = this.inflight.get(modelDir)
    if (existing !== undefined) return existing
    const before = readImportMeta(modelDir)?.revision ?? ''
    const started = runImporter(modelDir, this.config).then((outcome) => {
      this.inflight.delete(modelDir)
      this.lastOutcome.set(modelDir, outcome)
      if (outcome.ok) {
        if (outcome.revision !== before) {
          // The import actually moved: the directory is healthy again, so the
          // sweep is allowed to keep watching it.
          this.autoStalled.delete(modelDir)
        } else if (opts.auto === true) {
          this.autoStalled.set(modelDir, `自动重导入已停止：源文件被判定为有改动，但重导入后 revision 没变（${outcome.revision.slice(0, 12)}），`
            + '继续自动重导入只会反复白跑。修好 import.json 的 sources 记录，或用面板"重载"手动再试。')
        }
        this.onChanged(modelDir)
      }
      return outcome
    })
    this.inflight.set(modelDir, started)
    return started
  }

  /**
   * Whether the AUTOMATIC sweep may re-import one directory.
   *
   * Three independent gates, because the failure mode this prevents is
   * destructive: a wrong "re-import this" overwrites a model folder's
   * artifacts.
   *
   *  1. the caller only ever offers the SELECTED model (see `index.ts`) — a
   *     directory the user is not looking at is never touched;
   *  2. the import must carry a `sources` baseline, i.e. it opted into this
   *     protocol; an import without one is unjudgeable, so it is left alone;
   *  3. when the import records WHICH script produced it, that script must be
   *     the one currently configured — a model imported by a different importer
   *     is not this runner's to rewrite.
   * @param modelDir - the model directory.
   * @returns whether it may be auto-imported, and why not when it may not.
   */
  private autoEligible(modelDir: string): { ok: boolean; reason: string } {
    const stalled = this.autoStalled.get(modelDir)
    if (stalled !== undefined) return { ok: false, reason: stalled }
    const meta = readImportMeta(modelDir)
    if (meta === undefined) return { ok: false, reason: '没有可读的 import.json' }
    if (meta.sources === undefined) {
      return { ok: false, reason: 'import.json 没有 sources 记录（不是本协议导入的，跳过自动重导入）' }
    }
    if (typeof meta.importerScript === 'string' && meta.importerScript !== ''
      && !samePath(meta.importerScript, this.config.script)) {
      return { ok: false, reason: `import.json 记录的导入器是 ${meta.importerScript}，与当前配置不符` }
    }
    return { ok: true, reason: '' }
  }

  /**
   * One freshness pass: re-import every idle directory whose sources moved.
   *
   * Throttled to {@link SWEEP_MIN_INTERVAL_MS} because it stats the disk, and
   * "idle" means only that this directory has no import running — a sweep never
   * queues a second one behind the first. Every skip is REPORTED rather than
   * silent: "why did my fix not take?" has to be answerable.
   * @param dirs - the model directories to check (callers pass the selected one).
   * @returns what was started and what was skipped, with reasons.
   */
  sweep(dirs: readonly string[]): { started: string[]; skipped: { dir: string; reason: string }[] } {
    const started: string[] = []
    const skipped: { dir: string; reason: string }[] = []
    const nowMs = this.now()
    if (nowMs - this.lastSweep < SWEEP_MIN_INTERVAL_MS) return { started, skipped }
    this.lastSweep = nowMs
    for (const dir of dirs) {
      if (this.busy(dir)) {
        skipped.push({ dir, reason: '已有导入在进行' })
        continue
      }
      const eligible = this.autoEligible(dir)
      if (!eligible.ok) {
        skipped.push({ dir, reason: eligible.reason })
        continue
      }
      if (staleSources(dir, readImportMeta(dir)).length === 0) continue
      started.push(dir)
      void this.run(dir, { auto: true }).catch(() => { /* recorded in lastOutcome */ })
    }
    return { started, skipped }
  }
}
