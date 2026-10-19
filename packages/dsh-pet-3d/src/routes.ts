/**
 * Pet HTTP routes — the browser half talks to the host through same-origin JSON
 * endpoints ('/api/pet3d/*') and loads model media from '/pet3d/<id>/*'.
 *
 * Five API routes, one clip-index route, one runtime route and one media route,
 * total. The media route serves a model's WHOLE folder, subdirectories
 * included (`textures/`, `.import/`), because a full-fidelity import is four
 * files and six PNGs rather than one self-contained .glb.
 *
 * Caching: a URL that carries the file's content digest (`?h=<sha256-12>`) is
 * answered `immutable` for a year, and one that does not is answered `no-cache`.
 * That is what makes a 150 MB clip payload cacheable without ever pinning a
 * stale model after a re-import: the digest changes, so the URL changes.
 * @module dsh-pet-3d/routes
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isPetAllowed } from './access.ts'
import { readJsonBody, writeJson } from './http.ts'
import {
  PET_API_PREFIX,
  PET_ASSET_PREFIX,
  PET_RUNTIME_PREFIX,
  VENDOR_BUNDLE,
  containedRealpath,
  fileDigest,
  isServableRelative,
  modelDirectory,
} from './registry.ts'
import type { Pet3dService } from './service.ts'
import { importConflict, type ImportRunner } from './importer.ts'
import type { Pet3dDisplay } from './persist.ts'

/** Content types for the servable asset set. */
const MIME: Readonly<Record<string, string>> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.vrm': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ktx2': 'image/ktx2',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

/** Content type for a file, by extension. */
function mimeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** Answer 405 unless the method matches. */
function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method === method) return true
  writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}

/**
 * The route fence: loopback (the desktop) always passes; a live paired-device
 * cookie is an extra allow path when remote-web-ui is loaded.
 */
function guard(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
  if (isPetAllowed(ctx, req)) return true
  writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
  return false
}

/** Wrap one async read as a GET JSON route. */
function getRoute(ctx: Context, path: string, run: () => unknown | Promise<unknown>): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!guard(ctx, req, res)) return
      if (!requireMethod(req, res, 'GET')) return
      Promise.resolve()
        .then(run)
        .then(
          (value) => writeJson(res, 200, value),
          (error) => writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
        )
    },
  }
}

/** Wrap one async write as a POST JSON route (body passed through). */
function postRoute(
  ctx: Context,
  path: string,
  run: (body: Record<string, unknown>) => unknown | Promise<unknown>,
): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!guard(ctx, req, res)) return Promise.resolve()
      if (!requireMethod(req, res, 'POST')) return Promise.resolve()
      return readJsonBody(req, { maxBytes: 64 * 1024 }).then((parsed) => {
        const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {}
        return Promise.resolve()
          .then(() => run(record))
          .then(
            (value) => writeJson(res, 200, value),
            (error) => writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }),
          )
      })
    },
  }
}

/**
 * Stream one file.
 *
 * `immutable` is claimed only when the caller proved which bytes it wants by
 * putting the content digest in the URL; everything else revalidates every
 * time, which is the deny-safe direction (an upstream incident served a stale
 * cached model for hours because the opposite choice was made globally).
 * @param req - the request.
 * @param res - the response.
 * @param file - absolute path of the file to stream.
 * @param digest - the digest the request asked for, when it asked for one.
 */
function serveFile(req: IncomingMessage, res: ServerResponse, file: string, digest?: string): void {
  let size: number
  try {
    const info = statSync(file)
    if (!info.isFile()) throw new Error('not a file')
    size = info.size
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  const immutable = digest !== undefined && digest !== '' && fileDigest(file) === digest
  res.writeHead(200, {
    'content-type': mimeOf(file),
    'content-length': String(size),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).pipe(res)
}

/** Read a display patch out of a request body. */
function displayPatch(body: Record<string, unknown>): Partial<Pet3dDisplay> {
  const patch: Partial<Pet3dDisplay> = {}
  for (const key of ['size', 'right', 'bottom'] as const) {
    const value = body[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid-${key}`)
    patch[key] = value
  }
  if (body.visible !== undefined) {
    if (typeof body.visible !== 'boolean') throw new Error('invalid-visible')
    patch.visible = body.visible
  }
  return patch
}

/** The model id a selection body names (`modelId` preferred, `petId` legacy). */
function selectionId(body: Record<string, unknown>): string {
  const value = body.modelId ?? body.petId
  if (typeof value !== 'string' || value === '') throw new Error('invalid-model')
  return value
}

/** Percent-decode one path segment, or undefined when it is malformed. */
function decodeSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

/**
 * Build every route the plugin registers.
 * @param deps - the service, the host context, the importer and the package root.
 * @returns the routes, in match order.
 */
export function makePet3dRoutes(deps: {
  service: Pet3dService
  ctx: Context
  packageRoot: string
  /** The importer runner; absent mounts serve read-only (no re-import route). */
  importer?: ImportRunner
}): WebRoute[] {
  const { service, ctx, packageRoot, importer } = deps

  const api: WebRoute[] = [
    // The snapshot carries the model revision (the client's hot-swap key) and,
    // when automatic re-import has been called off for the selected model, the
    // reason — a stalled model must not look like a kept-up-to-date one.
    getRoute(ctx, `${PET_API_PREFIX}/state`, () => {
      const snapshot = service.snapshot()
      if (importer === undefined) return snapshot
      const dir = service.modelDir(service.selectedModelId() ?? '')
      const stall = dir === undefined ? undefined : importer.stall(dir)
      return stall === undefined ? snapshot : { ...snapshot, importStall: stall }
    }),
    getRoute(ctx, `${PET_API_PREFIX}/models`, () => ({ models: service.models(), problems: service.snapshot().problems })),
    postRoute(ctx, `${PET_API_PREFIX}/display`, (body) => service.patchDisplay(displayPatch(body))),
    postRoute(ctx, `${PET_API_PREFIX}/set-pet`, (body) => ({ petId: service.setModelId(selectionId(body)) })),
    // 编排配置的写入口：网页编排器保存时调它。校验与备份都在 service 里做，
    // 这里只负责挑出模型 id 并把 body 原样递过去（写坏配置会让宠物不动，所以唯一的写路径要窄）。
    postRoute(ctx, `${PET_API_PREFIX}/choreography`, (body) => {
      const id = selectionId(body)
      const result = service.writeChoreography(id, body.config ?? body.choreography ?? body)
      return { modelId: id, ...result }
    }),
  ]

  // Re-import on demand: the panel's 重载 button, and the way a fixed source
  // file or a fixed importer script is picked up WITHOUT restarting anything.
  // The response carries the new revision, and the client's poll then hot-swaps.
  //
  // This route is EXPLICIT intent — the caller named exactly one model — so it is
  // the only place an import may target a folder the freshness sweep refuses
  // (that is how a new importer script gets adopted). It still names one model
  // directory and never walks the catalog, and when the folder's current
  // artifacts were written by a DIFFERENT script it asks for `force: true`
  // rather than overwriting another importer's output silently.
  if (importer !== undefined) {
    api.push(postRoute(ctx, `${PET_API_PREFIX}/reimport`, async (body) => {
      const id = selectionId(body)
      const dir = service.modelDir(id)
      if (dir === undefined) throw new Error('unknown-model')
      const conflict = importConflict(dir, importer.script())
      if (conflict !== undefined && body.force !== true) {
        throw new Error(`需要确认：${conflict}。确认请带 force:true 重发`)
      }
      const outcome = await importer.run(dir)
      if (!outcome.ok) throw new Error(outcome.error)
      return {
        modelId: id,
        revision: outcome.revision,
        artifacts: outcome.artifacts,
        warnings: outcome.warnings,
        durationMs: outcome.durationMs,
      }
    }))
  }

  // The two clip routes exist because a full index is megabytes of track
  // offsets: the panel needs names and durations LONG before — and without —
  // the payload, and this route is the cheap way to ask for exactly that.
  const clipsRoute: WebRoute = {
    kind: 'prefix',
    path: `${PET_API_PREFIX}/clips`,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!guard(ctx, req, res)) return
      if (!requireMethod(req, res, 'GET')) return
      const rest = pathnameOf(req).slice(`${PET_API_PREFIX}/clips`.length).replace(/^\/+/, '')
      const id = decodeSegment(rest)
      if (id === undefined || id === '' || id.includes('/')) {
        writeJson(res, 400, { ok: false, error: 'invalid-model' })
        return
      }
      const clips = service.clipsOf(id)
      if (clips === undefined) {
        writeJson(res, 404, { ok: false, error: 'no-clip-index', model: id })
        return
      }
      writeJson(res, 200, { model: id, clips })
    },
  }

  // The three.js stack, lazy-loaded by the renderer as a plain script tag.
  const vendorRoute: WebRoute = {
    kind: 'exact',
    path: `${PET_RUNTIME_PREFIX}/${VENDOR_BUNDLE}`,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!guard(ctx, req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const file = join(packageRoot, 'lib', VENDOR_BUNDLE)
      if (!existsSync(file)) {
        writeJson(res, 404, { ok: false, error: 'vendor-missing', file: VENDOR_BUNDLE })
        return
      }
      serveFile(req, res, file, queryOf(req).get('h') ?? undefined)
    },
  }

  // '/pet3d/<id>/<relative path>' — one prefix registration serving every model,
  // subdirectories included.
  const assetRoute: WebRoute = {
    kind: 'prefix',
    path: PET_ASSET_PREFIX,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!guard(ctx, req, res)) return
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const pathname = pathnameOf(req)
      const rest = pathname.slice(PET_ASSET_PREFIX.length).replace(/^\/+/, '')
      const slash = rest.indexOf('/')
      if (slash <= 0) {
        res.writeHead(404)
        res.end()
        return
      }
      const id = decodeSegment(rest.slice(0, slash))
      const relative = decodeSegment(rest.slice(slash + 1))
      if (id === undefined || relative === undefined) {
        res.writeHead(400)
        res.end()
        return
      }
      // Layer one: the extension allow-list plus a segment check that rejects
      // '.' / '..' / drive-letter paths before any filesystem call.
      if (!isServableRelative(relative)) {
        res.writeHead(403)
        res.end()
        return
      }
      const dir = modelDirectory(id)
      if (dir === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      // Layer two: realpath containment, so a symlink out of the model
      // directory is refused rather than followed.
      const file = containedRealpath(dir, join(dir, relative))
      if (file === undefined) {
        res.writeHead(403)
        res.end()
        return
      }
      serveFile(req, res, file, queryOf(req).get('h') ?? undefined)
    },
  }

  // Prefixes match in order, so a narrower prefix must never follow a broader
  // one that would swallow it. Assert rather than trust: the failure symptom is
  // a bare 404 with silent feature loss.
  const ordered: WebRoute[] = [vendorRoute, ...api, clipsRoute, assetRoute]
  for (const route of ordered) {
    if (route.kind !== 'prefix') continue
    for (const other of ordered) {
      if (other === route || other.kind !== 'prefix') continue
      if (other.path !== route.path && other.path.startsWith(route.path + '/')) {
        throw new Error(
          `pet3d route order: prefix "${route.path}" precedes narrower prefix "${other.path}", `
          + 'which would therefore never match',
        )
      }
    }
  }
  return ordered
}

/** The request's pathname, or '/' when the URL cannot be parsed. */
function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://pet.local').pathname
  } catch {
    return '/'
  }
}

/** The request's query, empty when the URL cannot be parsed. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://pet.local').searchParams
  } catch {
    return new URLSearchParams()
  }
}
