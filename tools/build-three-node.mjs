/**
 * Regenerate `tools/vendor/three-node.mjs` (the importer's self-contained
 * three + FBXLoader.tolerant + GLTFExporter bundle).
 *
 * Why a bundle: the plugin must work from a `link:` install, and pnpm does not
 * install dependencies of a linked package. The importer is a separate Node
 * process, so it cannot use the browser's `three-vendor.js` IIFE either.
 *
 * Source of truth: `tools/node_modules/three` (0.171.0 + `patch-fbxloader.mjs`
 * generated `FBXLoader.tolerant.js`), which is the version that actually
 * produced the shipped models. Re-run this after upgrading that copy:
 *
 *   node tools/build-three-node.mjs
 */
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const here = fileURLToPath(new URL('.', import.meta.url))
const input = `${here}vendor/three-node-entry.mjs`
const file = `${here}vendor/three-node.mjs`

const bundle = await rolldown({ input, platform: 'node' })
await bundle.write({ file, format: 'esm', inlineDynamicImports: true })
await bundle.close()
console.log(`wrote ${file}`)
