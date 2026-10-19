/**
 * Build config for the self-use pet.
 *
 * Two artifacts:
 *  - the node half (`lib/index.js`), mounted by the host loader, plus
 *  - the browser half (`lib/client.js`), a closure-factory bundle the shell
 *    evaluates through `window.__ModuleLoader__.load`.
 *
 * The three.js stack ships separately as `lib/three-vendor.js` (see
 * tsdown.three-vendor.ts) so the main bundle never carries it.
 *
 * `tsc -b` is deliberately absent from the build: this tree carries no
 * `@deepseek-ai/*` SDK devDependencies, so tsc cannot resolve the host half's
 * type imports and cannot emit `lib/types`. The client entry therefore
 * resolves from `src/client/index.ts` — a build-graph detail only; the bundle
 * is the same closure factory either way.
 */
import { readFileSync } from 'node:fs'
import { clientBundle } from '../../shared/tsdown.client.ts'
import { threeVendorBundle } from './tsdown.three-vendor.ts'

/**
 * The bundle id must be the package's RESOLUTION name, not the directory
 * name: the shell keys registered client bundles by this id, and the profile
 * roster row resolves the package name. Reading it from package.json keeps
 * the two from drifting apart.
 */
const RESOLUTION_NAME = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).name as string

const base = clientBundle(RESOLUTION_NAME, ['src/index.ts'], {
  companions: [threeVendorBundle()],
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-settings',
  ],
  // Bundle schemastery into lib/index.js. It is a small, stateless schema
  // builder, and keeping it external breaks `link:` installs: pnpm does not
  // install dependencies of a linked package, so the host half dies with
  // ERR_MODULE_NOT_FOUND before it can register a single route.
  lib: { noExternal: [/^@deepseek-ai\/schemastery$/] },
})

export default function config(inlineConfig: Parameters<typeof base>[0]) {
  const configs = base(inlineConfig)
  for (const config of configs) {
    config.dts = false
  }
  return configs
}
