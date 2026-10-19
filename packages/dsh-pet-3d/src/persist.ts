/**
 * Pet persistence — the display the user dragged to, plus the selected pet.
 *
 * Own file on purpose: `$DSH_HOME/pet.json` belongs to the upstream plugin and
 * holds the user's pet name / affinity / position. This kernel keeps its own
 * `$DSH_HOME/pet3d.json` so the two plugins can never clobber each other, and
 * so removing this plugin leaves the other one's data intact.
 * @module dsh-pet-3d/persist
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'

/** Where the pet sits on screen and how big it is. */
export interface Pet3dDisplay {
  /** Rendered pet height in px. */
  size: number
  /** Inset from the viewport's right edge, px. */
  right: number
  /** Inset from the viewport's bottom edge, px. */
  bottom: number
  /** Whether the pet is shown at all. */
  visible: boolean
}

/** The persisted document. */
export interface Pet3dPersist {
  /** Currently selected pet id. */
  petId?: string
  /** Last display the user chose (drag / settings). */
  display?: Partial<Pet3dDisplay>
}

/** Absolute path of this plugin's own persistence file. */
export function pet3dPersistPath(): string {
  return join(dshHome(), 'pet3d.json')
}

/**
 * Read the persisted document. A missing or unreadable file is not an error —
 * it is a first run, and every field has a config-level default.
 * @returns the persisted values, or an empty object.
 */
export function loadPet3dPersist(): Pet3dPersist {
  const file = pet3dPersistPath()
  try {
    if (!existsSync(file)) return {}
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Pet3dPersist
  } catch {
    return {}
  }
}

/**
 * Write the persisted document. Never throws: persistence is a convenience,
 * and a read-only home directory must not take the pet down.
 * @param next - the document to store.
 */
export function savePet3dPersist(next: Pet3dPersist): void {
  try {
    writeFileSync(pet3dPersistPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // Read-only home: the pet keeps running with the in-memory value.
  }
}
