/**
 * Copy the models shipped in this repo into the DSH model directory.
 *
 * A model folder is data: `$DSH_HOME/models/<id>/`. This script copies every
 * directory under `models/` (currently the synthetic `panyinhu-placeholder`)
 * without touching models the user already has.
 *
 * Usage:
 *   node tools/install-models.mjs [--dest <models-dir>] [--force]
 *
 * Env: DSH_HOME (default: %USERPROFILE%\.dsh on Windows, ~/.dsh elsewhere)
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}
const force = argv.includes('--force')
const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = join(here, '..', 'models')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const destRoot = flag('dest') ?? join(dshHome, 'models')

if (!existsSync(sourceRoot)) {
  console.error(`no models/ directory at ${sourceRoot}`)
  process.exit(2)
}
mkdirSync(destRoot, { recursive: true })

let copied = 0
let skipped = 0
for (const entry of readdirSync(sourceRoot)) {
  const source = join(sourceRoot, entry)
  if (!statSync(source).isDirectory()) continue
  const dest = join(destRoot, entry)
  if (existsSync(dest) && !force) {
    console.log(`skip  ${entry}  (already at ${dest}; use --force to overwrite)`)
    skipped++
    continue
  }
  cpSync(source, dest, { recursive: true })
  console.log(`copy  ${entry}  -> ${dest}`)
  copied++
}
console.log(`\nmodels dir: ${destRoot}`)
console.log(`copied ${copied}, skipped ${skipped}`)
console.log('Restart DSH (or wait for the catalog TTL) and check GET /api/pet3d/models.')
