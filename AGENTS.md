# AGENTS.md — deploy this repo

This file is the machine-readable deployment contract for agents that clone
`dsh-pet-3d`. Follow it exactly; do not improvise paths.

## What this is

`dsh-pet-3d` is a **DSH (DeepSeek Harness) Web GUI plugin**: a 3D desktop pet
renderer with a floating menu (appearance / accessories / interactions),
choreography editor and an import pipeline. Code only. The repo ships a
**synthetic placeholder model**; no game assets are included.

- Plugin package: `packages/dsh-pet-3d/` (source only; `lib/` is built)
- Models shipped for a first run: `models/panyinhu-placeholder/` (≈2 KB)
- License: Apache-2.0 (`LICENSE`); attribution in `NOTICE` / `AUTHORS.md`
- Public repo: https://github.com/XTIqwq/dsh-pet-3d
- `local/` and `trash/` are git-ignored, machine-local areas. They are never
  part of the public tree and must not be referenced from shipped files.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0`
- pnpm 11.x (`corepack enable` or a bundled pnpm)
- A running DSH Desktop/Web installation with a profile.

## Deploy (Windows PowerShell)

```powershell
# 1. build
pnpm install
pnpm -C packages/dsh-pet-3d build

# 2. pack + install into the profile (tarball, NOT a directory/link)
pnpm -C packages/dsh-pet-3d pack
$tgz = (Get-ChildItem packages/dsh-pet-3d/dsh-pet-3d-*.tgz | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"   # or `web` for `dsh web`
pnpm --dir $profile add $tgz

# 3. copy the bundled placeholder model
node tools/install-models.mjs

# 4. restart DSH, then verify
Invoke-RestMethod http://127.0.0.1:19387/api/pet3d/models
Invoke-RestMethod http://127.0.0.1:19387/api/pet3d/state
```

## Deploy (Linux/macOS)

```bash
pnpm install
pnpm -C packages/dsh-pet-3d build
pnpm -C packages/dsh-pet-3d pack
pnpm --dir "${DSH_HOME:-$HOME/.dsh}/profiles/desktop" add "$(ls -t packages/dsh-pet-3d/dsh-pet-3d-*.tgz | head -1)"
node tools/install-models.mjs
# restart DSH, then: curl -s http://127.0.0.1:19387/api/pet3d/models
```

## Verify

1. `GET /api/pet3d/models` returns at least `panyinhu-placeholder`.
2. The GUI shows a pet in the corner; hovering it exposes the 🐻 button.
3. Clicking 🐻 opens the floating menu; the 「互动」 tab plays a fixture clip.
4. Restart DSH once: the pet position must persist (v1.0.2+).

## Hard rules

- Do not add `dependencies` back to the package: `lib/index.js` bundles
  schemastery and the importer bundles three; `dependencies` must stay empty.
- Do not add a manual `pet3d` row to the profile's `cordis.patch.yml`; the
  package's own `cordis.patch.yml` inserts it.
- Keep the public tree free of `AGENT-MEMORY.md`, `tools/agent-memory/`,
  `_legacy/`, and machine-specific paths. Local-only material goes to the
  git-ignored `local/`; anything withdrawn from the public tree goes to the
  git-ignored `trash/` **at its original relative path** (never deleted, never
  flattened).

## Troubleshooting

- `/api/pet3d/*` 404 → plugin not installed in the **profile the GUI uses**.
  Desktop and `dsh web` profiles are separate.
- `ERR_MODULE_NOT_FOUND` on load → package installed as `link:` from a bare
  directory; install the `.tgz` instead (v1.0.3 has zero runtime deps).
- No pet, models empty → run `node tools/install-models.mjs --force` and check
  `$DSH_HOME/models/panyinhu-placeholder/.import/model.glb` exists.
- Reimport fails asking for `three` → old package (<1.0.3); upgrade to 1.0.3.
