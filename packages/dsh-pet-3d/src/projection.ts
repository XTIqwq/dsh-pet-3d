/**
 * Session event projection — pure.
 *
 * Maps the DSH session vocabulary onto the pet's visual phases. Holds no state
 * of its own beyond the bookkeeping one session's events need (which tool calls
 * are in flight, whether this step already failed); the caller keeps one
 * {@link ProjectionState} and feeds events in arrival order.
 *
 * The event shapes below are structural, not imported: this kernel depends on
 * no `@deepseek-ai` SDK package, and these five fields are the entire surface it
 * reads. A host that grows new event types simply projects to `undefined` and
 * leaves the pet's phase alone — which is the safe direction.
 *
 * What is deliberately NOT here (all upstream features this kernel drops):
 * status copy / bubbles, the murmur engine, voice packs, and turn rewards.
 * @module dsh-pet-3d/projection
 */

import type { ActivityPhase } from './state.ts'

/** One durable session event, as far as the projection reads it. */
export interface SessionEventLike {
  type: string
  data?: unknown
}

/** One live assistant-stream publication, as far as the projection reads it. */
export interface AssistantStreamFrameLike {
  type?: string
  chunk?: { type?: string; text?: string }
}

/** Per-session bookkeeping the projection mutates. */
export interface ProjectionState {
  /** callIds of tool calls that have not produced a result yet. */
  activeTools: Set<string>
  /** Whether any tool call in the current step failed. */
  stepHadFailure: boolean
}

/** A fresh projection state for a newly seen session. */
export function emptyProjectionState(): ProjectionState {
  return { activeTools: new Set(), stepHadFailure: false }
}

/** Read a value as a JSON object, or an empty one. */
function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Project one durable session event onto a visual phase.
 *
 * Unknown events return `undefined` so a log-only event never disturbs the last
 * meaningful activity.
 * @param event - the session event.
 * @param state - the session's projection state (mutated).
 * @returns the phase to display, or undefined when the event says nothing.
 */
export function projectEvent(event: SessionEventLike, state: ProjectionState): ActivityPhase | undefined {
  switch (event.type) {
    case 'turn/start':
      state.activeTools.clear()
      state.stepHadFailure = false
      return 'waiting'
    case 'step/start':
      state.activeTools.clear()
      state.stepHadFailure = false
      return 'waiting'
    case 'assistant/message':
      return 'review'
    case 'tool/call': {
      const data = objectOf(event.data)
      state.activeTools.add(String(data.callId))
      return 'tool'
    }
    case 'tool/result': {
      // Session format V4 moved the call identity and the outcome onto the
      // tool-role message root; the content blocks carry neither.
      const data = objectOf(event.data)
      const message = objectOf(data.message)
      state.activeTools.delete(String(message.toolCallId))
      state.stepHadFailure ||= data.error !== undefined || message.isError === true
      if (state.activeTools.size > 0) return 'tool'
      return state.stepHadFailure ? 'failed' : 'thinking'
    }
    case 'turn/end': {
      state.activeTools.clear()
      const reason = objectOf(objectOf(event.data).reason)
      switch (reason.kind) {
        case 'completed': return 'done'
        case 'error':
        case 'max-tokens':
        case 'interrupted': return 'failed'
        case 'blocked': return 'waiting'
        // 'aborted' and any newer ending settle to idle: a stopped session must
        // not leave the pet showing stale in-progress work.
        default: return 'idle'
      }
    }
    default:
      return undefined
  }
}

/**
 * Project one live `agent/assistant-stream` publication.
 *
 * Chunk frames are how streaming reaches the host: a reasoning delta keeps the
 * pet thinking, a text delta moves it to review. Start, end and non-delta
 * frames change nothing.
 * @param frame - the stream frame.
 * @returns the phase to display, or undefined.
 */
export function projectAssistantStreamFrame(frame: AssistantStreamFrameLike): ActivityPhase | undefined {
  if (frame.type !== 'chunk') return undefined
  const chunk = frame.chunk
  if (chunk === undefined) return undefined
  if (chunk.type === 'reasoning-delta' && (chunk.text ?? '').length > 0) return 'thinking'
  if (chunk.type === 'text-delta' && (chunk.text ?? '').length > 0) return 'review'
  return undefined
}
