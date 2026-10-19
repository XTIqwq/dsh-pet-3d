/**
 * Pet state machine — pure, clock-injected. Maps official DSH session activity
 * and the legacy `activity/status` vocabulary onto the 9-state Codex pet
 * animation contract, plus turn-end celebration and no-session idle.
 *
 * The machine is deliberately dumb: it holds the last input phase, the
 * animation decision, and a one-shot "celebration" window after `done` so the
 * pet visibly jumps before settling back to idle. Everything here is a pure
 * function of (input, nowMs); persistence and RPC live in the service.
 * @module dsh-pet-3d/state
 */

/** Activity phases understood by the pet host. */
export type ActivityPhase = 'idle' | 'waiting' | 'thinking' | 'tool' | 'review' | 'done' | 'failed'

/**
 * The six states the pet actually renders（用户定的 6 个：闲置 / 走 / 跑 / 思考 / 完成 / 出错）。
 *
 * The seven projected phases are input detail, not display detail:
 * `thinking` / `tool` / `review` 都表示"模型在主动产出" ⇒ **跑**；
 * `waiting`（等用户回话、等工具或命令跑完、turn/step 刚起） ⇒ **思考**。
 * Compressing here — once, on the host — is what lets both halves agree on the
 * mapping without either re-deriving it.
 *
 * `walk`（走）**永远不会由宿主产生**：宿主没有"即将开始工作"这个相位，所以
 * "闲置 → 走 → 跑"那段引导由客户端在自己看到 `idle → run` 时补上（见渲染器的 `applyState`）。
 * 它仍然是合法的对外状态，因为面板可以手动强制到它。
 */
export type PhaseState = 'idle' | 'walk' | 'run' | 'think' | 'done' | 'failed'

/** Every phase state, in the order the panel lists them. */
export const PHASE_STATES: readonly PhaseState[] = ['idle', 'walk', 'run', 'think', 'done', 'failed']

/** Compress one projected phase onto the state the pet renders. */
export function phaseStateOf(phase: ActivityPhase): PhaseState {
  switch (phase) {
    // 模型在主动产出（推理流 / 正文流 / 工具调用在生成）⇒ 跑
    case 'thinking':
    case 'tool':
    case 'review': return 'run'
    // 模型没在主动输出（等用户回话、等工具或命令跑完、turn/step 刚起）⇒ 思考
    case 'waiting': return 'think'
    case 'idle': return 'idle'
    case 'done': return 'done'
    case 'failed': return 'failed'
  }
}

/**
 * 进入一个相位之前，要不要先"走一段"。
 *
 * 用户的时间轴：**闲置 →（即将进入工作）走起来 →（工作时）跑起来**。宿主没有
 * "即将开始工作"这个相位（它只知道 `waiting / thinking / tool / review / done / failed`），
 * 所以这段引导由**客户端**补：目标是 `run`、而当时还在 `idle`（或还没进任何状态）时，
 * 这一次先进入 `walk`。
 *
 * 关键：`lastState` 始终是宿主给的 `run`，所以走循环自然播完时 `onActionFinished`
 * 会把下一站解析成 `run`（先放 `Walk_End` 收步，再进跑）—— 整条链不需要额外状态。
 *
 * @param target - 宿主给的相位状态。
 * @param current - 此刻正在播的状态（还没进任何状态时是 `undefined`）。
 * @returns 这一次实际应当进入的状态。
 */
export function leadInBefore(target: PhaseState, current: PhaseState | undefined): PhaseState {
  if (target !== 'run') return target
  return current === undefined || current === 'idle' ? 'walk' : target
}

/** The Codex-compatible 9-state animation contract (spritesheet rows). */
export type PetAnimation =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

/** One input snapshot consumed by the machine. */
export interface PetStateInput {
  /** Current activity phase of the active session. */
  phase: ActivityPhase
  /** Human-readable status line (plain text). */
  line?: string
  /** Playful phrase from the activity tracker, when any. */
  phrase?: string
}

/** Animation decision plus the copy the pet should show. */
export interface PetStateSnapshot {
  /** Which animation track to play. */
  animation: PetAnimation
  /** Optional status bubble copy (line or phrase), shown while active. */
  bubble?: string
  /** Wall-clock ms this animation started (client can sync loops). */
  animationStartedAt: number
  /** Raw phase, for debugging and client-side rendering decisions. */
  phase: ActivityPhase
  /** True when there is an active session (pet mounted). */
  sessionActive: boolean
}

/** Machine configuration. */
export interface PetStateConfig {
  /** Celebration window after `done` before settling to idle, ms (default 2400). */
  celebrateMs: number
  /** Failure display window before settling to idle, ms (default 2400). */
  failureMs: number
}

export const defaultPetStateConfig: PetStateConfig = { celebrateMs: 2400, failureMs: 2400 }

/**
 * Map one activity phase onto the animation contract.
 * - thinking → `running` and tool → `running-right` (focused work).
 * - review → `review` while answer text is streaming.
 * - waiting → `waiting` (expectant pose, needs user input).
 * - done → `jumping` (celebration), then back to `idle` after the window.
 * - failed → `failed` briefly, then back to `idle`.
 * - idle → `idle` (calm breathing loop).
 */
export function animationForPhase(phase: ActivityPhase): PetAnimation {
  switch (phase) {
    case 'thinking': return 'running'
    case 'tool': return 'running-right'
    case 'review': return 'review'
    case 'waiting': return 'waiting'
    case 'done': return 'jumping'
    case 'failed': return 'failed'
    case 'idle': return 'idle'
  }
}

/** The spritesheet row index for one animation track. */
export function rowOf(animation: PetAnimation): number {
  const rows: Record<PetAnimation, number> = {
    'idle': 0,
    'running-right': 1,
    'running-left': 2,
    'waving': 3,
    'jumping': 4,
    'failed': 5,
    'waiting': 6,
    'running': 7,
    'review': 8,
  }
  return rows[animation]
}

/**
 * PetStateMachine — one instance per host process. Holds only the latest
 * input snapshot and terminal-state timing; no storage, no side effects.
 */
export class PetStateMachine {
  private phase: ActivityPhase = 'idle'
  private line: string | undefined
  private phrase: string | undefined
  private sessionActive = false
  private doneAt: number | undefined
  private failedAt: number | undefined
  private readonly config: PetStateConfig
  /**
   * Clock seam.
   *
   * A plain field assigned in the constructor rather than a parameter property:
   * Node's strip-only TypeScript mode refuses those, and this module is imported
   * directly by the offline guard, so it has to stay strip-friendly.
   */
  private readonly now: () => number

  constructor(config: Partial<PetStateConfig> = defaultPetStateConfig, now: () => number = Date.now) {
    this.config = { ...defaultPetStateConfig, ...config }
    this.now = now
  }

  /** Consume one projected activity update. */
  onActivityStatus(input: PetStateInput): void {
    this.phase = input.phase
    this.line = input.line
    this.phrase = input.phrase
    this.doneAt = input.phase === 'done' ? this.now() : undefined
    this.failedAt = input.phase === 'failed' ? this.now() : undefined
  }

  /** A session became the active one (or a fresh session started). */
  onSessionActive(): void {
    this.sessionActive = true
  }

  /** The active session was disposed (or none left). */
  onSessionDisposed(): void {
    this.sessionActive = false
    this.phase = 'idle'
    this.line = undefined
    this.phrase = undefined
    this.doneAt = undefined
    this.failedAt = undefined
  }

  /** Render the current animation decision. */
  render(): PetStateSnapshot {
    const nowMs = this.now()
    let animation = animationForPhase(this.phase)
    const doneSettled = this.phase === 'done'
      && this.doneAt !== undefined
      && nowMs - this.doneAt >= this.config.celebrateMs
    const failedSettled = this.phase === 'failed'
      && this.failedAt !== undefined
      && nowMs - this.failedAt >= this.config.failureMs
    if (doneSettled || failedSettled) animation = 'idle'
    // Settled sessions never bubble: idle (e.g. an aborted/stopped turn),
    // completed celebration expiry, and failed display expiry all fall silent.
    const settled = this.phase === 'idle' || doneSettled || failedSettled
    const bubble = settled ? undefined : this.phrase ?? this.line
    return {
      animation,
      ...(bubble === undefined ? {} : { bubble }),
      animationStartedAt: nowMs,
      phase: this.phase,
      sessionActive: this.sessionActive,
    }
  }
}
