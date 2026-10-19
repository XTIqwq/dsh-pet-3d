/**
 * Hot-swap planning — which parts of a loaded model an import change touches.
 *
 * The user's requirement is that a broken model is FIXED IN PLACE: re-import,
 * swap, carry on. Swapping everything would work but would throw away work that
 * did not change — above all the 150 MB clip payload, and the mesh whose
 * skeleton the animation is bound to. So the decision is made per artifact, from
 * the sha256 map the importer writes into `import.json`:
 *
 *   clips.bin changed      → actions only (the common hot-fix path)
 *   model.glb changed      → mesh, skeleton, materials and skins
 *   anything else changed  → the textures that artifact names
 *
 * Pure module: no three, no DOM, no I/O, so both the renderer and the offline
 * guards can reason about it without a browser.
 * @module dsh-pet-3d/hot-swap
 */

/** The artifact names the container always carries. */
export const MODEL_ARTIFACT = 'model.glb'
export const CLIPS_INDEX_ARTIFACT = 'clips.json'
export const CLIPS_PAYLOAD_ARTIFACT = 'clips.bin'

/** What a new revision requires. */
export interface SwapPlan {
  /** The mesh / skeleton / materials have to be rebuilt. */
  mesh: boolean
  /** The clip library has to be rebuilt. */
  clips: boolean
  /** The textures have to be reloaded. */
  textures: boolean
  /** True when a load must actually happen. */
  any: boolean
}

/** The plan for an unchanged model. */
export const NO_SWAP: SwapPlan = { mesh: false, clips: false, textures: false, any: false }

/**
 * Whether one artifact name is a texture rather than one of the three
 * container files.
 *
 * Named rather than inferred from an extension list: the importer decides what
 * goes into `artifacts`, so "everything that is not the container" is a texture
 * for this purpose, and an unknown future artifact degrades into "reload the
 * textures" instead of being ignored.
 */
export function isTextureArtifact(name: string): boolean {
  return name !== MODEL_ARTIFACT && name !== CLIPS_INDEX_ARTIFACT && name !== CLIPS_PAYLOAD_ARTIFACT
}

/**
 * Compare two artifact maps and decide what has to be reloaded.
 *
 * A missing map (an older `.import/`, or the very first load) conservatively
 * plans a full swap: a wrong "nothing changed" would leave the pet showing a
 * model the host no longer has.
 * @param loaded - the artifact digests of what is currently on screen.
 * @param next - the artifact digests the host now serves.
 * @returns the plan.
 */
export function planSwap(
  loaded: Record<string, string> | undefined,
  next: Record<string, string> | undefined,
): SwapPlan {
  if (loaded === undefined || Object.keys(loaded).length === 0) {
    return { mesh: true, clips: true, textures: true, any: true }
  }
  if (next === undefined || Object.keys(next).length === 0) {
    return { mesh: true, clips: true, textures: true, any: true }
  }
  const mesh = changed(loaded, next, MODEL_ARTIFACT)
  const clips = changed(loaded, next, CLIPS_INDEX_ARTIFACT) || changed(loaded, next, CLIPS_PAYLOAD_ARTIFACT)
  let textures = false
  for (const name of new Set([...Object.keys(loaded), ...Object.keys(next)])) {
    if (!isTextureArtifact(name)) continue
    if (loaded[name] !== next[name]) textures = true
  }
  // A texture reload re-parses the glTF, so a mesh rebuild makes it redundant.
  if (mesh) textures = false
  return { mesh, clips, textures, any: mesh || clips || textures }
}

/** Whether one named artifact differs between the two maps. */
function changed(loaded: Record<string, string>, next: Record<string, string>, name: string): boolean {
  return (loaded[name] ?? '') !== (next[name] ?? '')
}
