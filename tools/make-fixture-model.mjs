/**
 * Synthetic fixture model — a COMPLETE, tiny `.import/` container.
 *
 * Two jobs, deliberately in one file:
 *
 *  1. it writes a self-contained miniature model folder (one mesh, two clips)
 *     so the whole pipeline — scan → serve → fetch clip → assemble
 *     `AnimationClip` → play — can be proven offline without the real 300 MB
 *     import;
 *  2. it acts as the IMPORTER the host spawns (`<script> <modelDir> --json`),
 *     printing one JSON object on stdout and writing `import.json` with a
 *     revision, per-artifact sha256 and source stamps. That is what makes the
 *     hot-swap chain testable end to end: touch a source file, let the host's
 *     freshness sweep call this script, and the client sees a new revision.
 *
 * The variant is read from the SOURCE file, exactly like a real importer reads
 * its FBX: `variant=A|B|C|T` in `fixture.fbx` decides what gets produced.
 *   A — baseline
 *   B — only `clips.bin` differs (the arm holds 45° instead of the identity)
 *   C — `model.glb` differs too (the mesh is edited)
 *   T — only `textures/fixture.png` differs (the image is replaced)
 *
 * Usage:
 *   node tools/make-fixture-model.mjs [modelDir] [--json] [--variant A|B|C]
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const jsonOut = args.includes('--json')
const variantFlag = args.indexOf('--variant')
const forcedVariant = variantFlag >= 0 ? (args[variantFlag + 1] ?? 'A').toUpperCase() : undefined
const positional = args.filter((arg, at) => !arg.startsWith('--') && args[at - 1] !== '--variant')
const defaultDir = join(process.env.DSH_HOME ?? 'D:\\.dsh', 'models', '_fixture')
const modelDir = resolve(positional[0] ?? defaultDir)

// HARD REFUSAL — this is the guard that stops a whole class of accident.
//
// This script is ALSO the importer the host spawns (`<script> <modelDir> --json`), so anything that
// points it at a real model directory rewrites that model's `.import/` with 1 KB of fixture
// artifacts. That has happened twice; the second time it destroyed 156 MB of real output that had to
// be restored from a snapshot. A model directory is a fixture directory only if its NAME says so.
if (!basename(modelDir).startsWith('_')) {
  console.error(`make-fixture-model 拒绝写入 "${modelDir}"`)
  console.error('目标目录名必须以 _ 开头。本脚本同时被宿主当作导入器调用，')
  console.error('指向真实模型目录会把它的产物覆盖成 fixture（已发生过两次）。')
  process.exit(2)
}

const IMPORTER_VERSION = 1
/** The clip names the fixture carries (chosen to hit both conventions). */
const IDLE_CLIP = 'Fixture_Arm_Idle_Loop'
const SAD_CLIP = 'Fixture_Galgame_Sad'

/** 1×1 opaque PNGs (real, decodable images). Variant T swaps one for the other. */
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)
const FIXTURE_PNG_T = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64',
)

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Pad a buffer to a 4-byte boundary. */
function pad4(bytes, filler) {
  const rest = bytes.length % 4
  if (rest === 0) return bytes
  return Buffer.concat([bytes, Buffer.alloc(4 - rest, filler)])
}

/** The float32 payload of both clips: [clip0 times|values][clip1 times|values]. */
function clipPayload(variant) {
  // Fixture_Arm_Idle_Loop: 3 keys of a rotation (4 components each). Every key
  // carries the SAME pose so a swap is visible at any sample time: variant A
  // holds the identity, variant B holds a 45° yaw.
  const idleTimes = [0, 0.5, 1]
  const idleValues = variant === 'B'
    ? [0, 0, 0.3826834, 0.9238795, 0, 0, 0.3826834, 0.9238795, 0, 0, 0.3826834, 0.9238795]
    : [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
  // Fixture_Galgame_Sad: 2 keys of a translation (3 components each).
  const sadTimes = [0, 1]
  const sadValues = [0, 0, 0, 0, -0.12, 0]
  return { idleTimes, idleValues, sadTimes, sadValues }
}

/** The `clips.json` index for the payload above (offsets in float32 elements). */
function clipIndex() {
  const { idleTimes, idleValues, sadTimes, sadValues } = clipPayload('A')
  const idleTimeOffset = 0
  const idleValueOffset = idleTimes.length
  const sadTimeOffset = idleValueOffset + idleValues.length
  const sadValueOffset = sadTimeOffset + sadTimes.length
  const total = sadValueOffset + sadValues.length
  return {
    total,
    index: {
      version: 1,
      clips: [
        {
          name: IDLE_CLIP,
          duration: idleTimes[idleTimes.length - 1],
          tracks: [{
            node: 'FixtureArm',
            path: 'rotation',
            count: idleTimes.length,
            components: 4,
            timeOffset: idleTimeOffset,
            valueOffset: idleValueOffset,
          }],
        },
        {
          name: SAD_CLIP,
          duration: sadTimes[sadTimes.length - 1],
          tracks: [{
            node: 'FixtureArm',
            path: 'translation',
            count: sadTimes.length,
            components: 3,
            timeOffset: sadTimeOffset,
            valueOffset: sadValueOffset,
          }],
        },
      ],
    },
  }
}

/** The float32 buffer matching `clipIndex()`. */
function clipBin(variant) {
  const { idleTimes, idleValues, sadTimes, sadValues } = clipPayload(variant)
  return Buffer.from(new Float32Array([...idleTimes, ...idleValues, ...sadTimes, ...sadValues]).buffer)
}

/**
 * A minimal but real GLB: one triangle, one external PNG texture, no animations
 * (the animations live in `clips.bin`, which is the whole point of the layout).
 * @param variant - 'C' nudges a vertex so the glTF bytes really differ.
 */
function buildGlb(variant) {
  const lift = variant === 'C' ? 0.25 : 0
  const positions = new Float32Array([
    -0.5, 0, 0,
    0.5, 0, 0,
    0, 1 + lift, 0,
  ])
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
  const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1])
  const indices = new Uint16Array([0, 1, 2])
  const parts = [
    Buffer.from(positions.buffer),
    Buffer.from(normals.buffer),
    Buffer.from(uvs.buffer),
    pad4(Buffer.from(indices.buffer), 0),
  ]
  const views = []
  let offset = 0
  for (const part of parts) {
    views.push({ buffer: 0, byteOffset: offset, byteLength: part.length })
    offset += part.length
  }
  const bin = Buffer.concat(parts)
  const json = {
    asset: { version: '2.0', generator: 'dsh-pet-3d fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'FixtureRoot', children: [1] },
      { name: 'FixtureArm', mesh: 0 },
    ],
    meshes: [{
      name: 'FixtureArmMesh',
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
        indices: 3,
        material: 0,
      }],
    }],
    materials: [{
      name: 'FixtureSkin',
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    }],
    textures: [{ source: 0, sampler: 0 }],
    images: [{ uri: '../textures/fixture.png' }],
    samplers: [{ magFilter: 9729, minFilter: 9729 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, 0, 0], max: [0.5, 1 + lift, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  }
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonChunk.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(bin.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, bin])
}

/** The texture bytes of one variant: only T changes the image. */
function textureBytes(variant) {
  return variant === 'T' ? FIXTURE_PNG_T : FIXTURE_PNG
}

/** `size` + `mtimeMs` of a file, as the freshness check records them. */
function stampOf(file) {
  const info = statSync(file)
  return { size: info.size, mtimeMs: Math.round(info.mtimeMs) }
}

// --- write the fixture -----------------------------------------------------

const imports = join(modelDir, '.import')
const textures = join(modelDir, 'textures')
mkdirSync(imports, { recursive: true })
mkdirSync(textures, { recursive: true })

// The variant comes from the SOURCE, exactly like a real importer reads its
// FBX: the host's freshness sweep spawns this script WITHOUT `--variant`, so the
// source file is the only thing that can say what to produce.
const sourceFile = join(modelDir, 'fixture.fbx')
const previousSource = existsSync(sourceFile) ? readFileSync(sourceFile, 'utf8') : ''
const variant = forcedVariant ?? (/variant=([ABCT])/.exec(previousSource)?.[1] ?? 'A')
writeFileSync(sourceFile, `fixture-source variant=${variant} rev=${Date.now()}\n`, 'utf8')

writeFileSync(join(textures, 'fixture.png'), textureBytes(variant))
const glb = buildGlb(variant)
writeFileSync(join(imports, 'model.glb'), glb)
const payload = clipBin(variant)
writeFileSync(join(imports, 'clips.bin'), payload)
const { index } = clipIndex()
const clipsJson = Buffer.from(`${JSON.stringify(index, null, 1)}\n`, 'utf8')
writeFileSync(join(imports, 'clips.json'), clipsJson)
// Only when absent, so a hand-edited options.json survives a re-import.
const optionsFile = join(modelDir, 'options.json')
if (!existsSync(optionsFile)) {
  writeFileSync(optionsFile, `${JSON.stringify({
    scale: 1,
    framing: 1.2,
    yaw: 0,
    phase: { run: SAD_CLIP },
  }, null, 2)}\n`, 'utf8')
}

const artifacts = {
  'model.glb': sha256(glb),
  'clips.json': sha256(clipsJson),
  'clips.bin': sha256(payload),
  'textures/fixture.png': sha256(textureBytes(variant)),
}
const sourceBytes = readFileSync(sourceFile)
const revision = sha256(JSON.stringify({
  source: sha256(sourceBytes),
  artifacts,
  importerVersion: IMPORTER_VERSION,
})).slice(0, 16)

const meta = {
  sourceFbx: sourceFile,
  sourceBytes: sourceBytes.length,
  sourceSha256: sha256(sourceBytes),
  importedAt: new Date().toISOString(),
  clipCount: index.clips.length,
  meshVertexTotal: 3,
  warnings: [],
  revision,
  artifacts,
  importerVersion: IMPORTER_VERSION,
  // Recorded so the host can tell WHICH importer produced this: the automatic
  // freshness sweep refuses to rewrite an import made by a different script.
  importerScript: fileURLToPath(import.meta.url),
  sources: {
    'fixture.fbx': stampOf(sourceFile),
    'textures/fixture.png': stampOf(join(textures, 'fixture.png')),
  },
}
writeFileSync(join(imports, 'import.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

const result = {
  ok: true,
  modelDir,
  variant,
  revision,
  artifacts,
  importerVersion: IMPORTER_VERSION,
  clipCount: index.clips.length,
  clips: index.clips.map(clip => clip.name),
  bytes: {
    'model.glb': glb.length,
    'clips.json': clipsJson.length,
    'clips.bin': payload.length,
  },
  script: fileURLToPath(import.meta.url),
  repoRoot,
  warnings: [],
}

if (jsonOut) {
  // The importer contract: exactly one JSON object on stdout.
  process.stdout.write(`${JSON.stringify(result)}\n`)
} else {
  console.log(`fixture written: ${modelDir}`)
  console.log(`  variant ${variant}  revision ${revision}`)
  for (const [name, bytes] of Object.entries(result.bytes)) console.log(`  ${name}: ${bytes} B`)
  console.log(`  clips: ${result.clips.join(', ')}`)
}
