/**
 * Phase stream — bridges the polled host snapshots onto the renderer's
 * { get, subscribe } shape. The poll loop pushes each snapshot's phase state;
 * subscribers are dispatched on CHANGE only (transitions are sparse — `done`
 * and `failed` hold a timed window before falling back to idle — and a
 * transition is when a clip has to change).
 * @module dsh-pet-3d/client/phase-stream
 */

import type { PhaseState } from '../state.ts'

/** The renderer-facing phase stream. */
export interface PhaseStream {
  /** The latest pushed state. */
  get(): PhaseState
  /** Subscribe to state changes; returns the unsubscribe. */
  subscribe(listener: (state: PhaseState) => void): () => void
  /** Feed a fresh snapshot state; no-op when unchanged. */
  push(state: PhaseState): void
}

/** Create the stream (one per pet entry lifetime, owned by the plugin body). */
export function createPhaseStream(initial: PhaseState = 'idle'): PhaseStream {
  let current = initial
  const listeners = new Set<(state: PhaseState) => void>()
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push(state) {
      if (state === current) return
      current = state
      for (const listener of [...listeners]) listener(state)
    },
  }
}
