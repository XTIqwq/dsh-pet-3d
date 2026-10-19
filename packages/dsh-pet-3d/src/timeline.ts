/**
 * 动作时间轴：`T = nL + F` 的纯计算（宿主与客户端共用）。
 *
 * 用户定的规格（原文口径）：
 *
 * 1. **起手不计入 T**：进入一个状态时先播"起手段"，**起手播完那一刻**才开始计 T。
 *    所以本模块只负责 `循环段 + 收尾段` 的分配，起手段由调用方先播掉。
 * 2. **静态版（T 预先已知）**：`n = floor((T − F) / L)`；`T < F` 时 `n = 0`。
 *    - 收尾按原速播完还有富余 `Δ = T − (nL + F)` 时，两种补法二选一：
 *      · `pause`  —— 收尾原速，播完**回常态循环**站 `Δ` 秒（`gapSeconds = Δ`）
 *      · `stretch`—— 把收尾放慢到 `F' = T − nL`（因为 `F' ≥ F`，倍率 `F/F' ≤ 1`），没有富余
 * 3. **`T < F`**：收尾**必须加速**，`F' = T`、倍率 `F/T > 1`，总时长刚好 `T`。
 *    （原速会超时；停顿 Δ 为负不成立。）
 * 4. **动态版（宿主每 tick 给剩余秒数 R）**：`R > F` 继续循环；`R ≤ F` 播收尾、倍率 `F/R`。
 *    注意动态版的变速方向与静态版相反 —— 静态版只会**放慢**收尾（≤1），动态版只会**加速**（≥1）。
 *
 * 本模块**不碰任何 three/DOM/node**，所以离线守卫可以直接 import 它。
 * @module dsh-pet-3d/timeline
 */

/** 收尾不足时间时的两种补法（只在静态版有意义）。 */
export type GapPolicy = 'pause' | 'stretch'

/** 一次"循环 N 轮 + 收尾一次"的完整排期。 */
export interface BeatPlan {
  /** 循环轮数，`T < F` 时为 0。 */
  loops: number
  /** 循环段实际占用秒数（`loops × L`）。 */
  loopSeconds: number
  /** 收尾段实际占用秒数（可能被放慢/加快）。 */
  exitSeconds: number
  /** 收尾段的播放倍率：1 = 原速，<1 = 放慢，>1 = 加速。 */
  exitRate: number
  /** 动作全部播完后的富余秒数（仅 `pause` 补法不为 0）；调用方用它站常态循环。 */
  gapSeconds: number
  /** 整段实际占用秒数（`loopSeconds + exitSeconds`，不含 `gapSeconds`）。 */
  actionSeconds: number
  /**
   * `true` 表示**完全没有时间可用**（`T ≤ 0`）：调用方应当直接落到收尾末帧，
   * 而不是拿 `exitSeconds = 0` / `exitRate = 0` 去播（倍率 0 会被 three 解释成"定住"）。
   * 与 {@link TimelineDecision} 的 `jumpToEnd` 是同一个语义，两处必须一致。
   */
  jumpToEnd?: boolean
}

/** 动态版的一次决策（宿主还没说"想完了"时每 tick 都要重新问一次）。 */
export type TimelineDecision =
  | { kind: 'loop' }
  | {
      kind: 'exit'
      /** 收尾段要用掉的秒数。 */
      seconds: number
      /** 收尾段的播放倍率（`F / seconds`）。 */
      rate: number
      /**
       * `true` 表示已经没有任何时间可用（`R ≤ 0`）：调用方应当**直接落到收尾末帧**，
       * 而不是按 `seconds = 0` 去播（那会除零/闪一帧）。
       */
      jumpToEnd: boolean
    }

/** 一个正数（秒），非法输入一律当 0 处理 —— 配置写坏时宁可不动，不要抛。 */
const seconds = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/**
 * 静态版：`T` 预先知道时，把 T 拆成"循环 N 轮 + 收尾一次"。
 *
 * @param totalSeconds - 起手播完之后还剩的思考秒数 `T`。
 * @param loopSecondsPerRound - 循环动作**一轮**的耗时 `L`（原速口径）。
 * @param exitSeconds - 收尾动作**原速**耗时 `F`。
 * @param gapPolicy - 富余时间怎么补，缺省 `pause`。
 * @returns 排期；`L` 或 `F` 非正时返回 `undefined`（调用方应当报配置错误，而不是猜）。
 */
export function planBeat(
  totalSeconds: unknown,
  loopSecondsPerRound: unknown,
  exitSeconds: unknown,
  gapPolicy: GapPolicy = 'pause',
): BeatPlan | undefined {
  const T = seconds(totalSeconds)
  const L = seconds(loopSecondsPerRound)
  const F = seconds(exitSeconds)
  if (L <= 0 || F <= 0) return undefined

  // T ≤ 0：一点时间都没有，直接落到收尾末帧（倍率 0 会"定住"，不能这么交给 three）。
  if (T <= 0) {
    return { loops: 0, loopSeconds: 0, exitSeconds: 0, exitRate: 1, gapSeconds: 0, actionSeconds: 0, jumpToEnd: true }
  }

  // 0 < T < F：一轮循环都不播，收尾加速，总时长刚好 T。
  if (T < F) {
    return {
      loops: 0,
      loopSeconds: 0,
      exitSeconds: T,
      exitRate: F / T,
      gapSeconds: 0,
      actionSeconds: T,
    }
  }

  const loops = Math.floor((T - F) / L)
  const loopSeconds = loops * L
  const leftover = T - (loopSeconds + F)

  if (gapPolicy === 'stretch') {
    // F' = T − nL ≥ F ⇒ 倍率 = F / F' ≤ 1（只会放慢）
    const stretched = T - loopSeconds
    return {
      loops,
      loopSeconds,
      exitSeconds: stretched,
      exitRate: F / stretched,
      gapSeconds: 0,
      actionSeconds: loopSeconds + stretched,
    }
  }

  return {
    loops,
    loopSeconds,
    exitSeconds: F,
    exitRate: 1,
    gapSeconds: leftover,
    actionSeconds: loopSeconds + F,
  }
}

/**
 * 动态版：宿主每 tick 给"剩余思考秒数 R"，客户端据此决定继续循环还是收尾。
 *
 * @param remainingSeconds - 宿主给的 `R`；`undefined`/负值按 0 处理。
 * @param loopSecondsPerRound - 一轮循环 `L`。
 * @param exitSeconds - 收尾原速 `F`。
 * @returns `{ kind: 'loop' }` 表示继续循环；`{ kind: 'exit' }` 表示收尾（带时长与倍率）。
 */
export function decideByRemaining(
  remainingSeconds: unknown,
  loopSecondsPerRound: unknown,
  exitSeconds: unknown,
): TimelineDecision {
  const R = seconds(remainingSeconds)
  const L = seconds(loopSecondsPerRound)
  const F = seconds(exitSeconds)
  if (R > F && L > 0) return { kind: 'loop' }
  if (F <= 0) return { kind: 'exit', seconds: 0, rate: 1, jumpToEnd: true }
  if (R <= 0) return { kind: 'exit', seconds: 0, rate: 1, jumpToEnd: true }
  return { kind: 'exit', seconds: R, rate: F / R, jumpToEnd: false }
}

/**
 * 配置自检：把明显写坏的时序值报出来（不抛错）。
 *
 * 覆盖两件确定的事实：
 * - `L` / `F` 必须是正数，否则排期无从谈起；
 * - **走的时长有下限**：①′ 过渡只能从"走循环的中途"进入，所以走的 T 必须至少
 *   够播完"起手 + 1 轮循环 + 收尾"，否则永远走不到循环段、那条过渡也就用不上。
 *
 * @param label - 报错前缀（例如 `states.walk`）。
 * @param loopSecondsPerRound - 一轮循环 `L`。
 * @param exitSeconds - 收尾 `F`。
 * @param enterSeconds - 起手耗时（不含在 T 里，但下限要用）。
 * @param totalSeconds - 该状态的 `T`（不填表示按遍数配，跳过下限检查）。
 * @param minLoops - 至少要能播满几轮循环，缺省 1。
 * @returns 问题清单，空数组表示没问题。
 */
export function timingProblems(
  label: string,
  loopSecondsPerRound: unknown,
  exitSeconds: unknown,
  enterSeconds: unknown,
  totalSeconds?: unknown,
  minLoops = 1,
): string[] {
  const problems: string[] = []
  const L = seconds(loopSecondsPerRound)
  const F = seconds(exitSeconds)
  const E = seconds(enterSeconds)
  if (L <= 0) problems.push(`${label}：循环一轮耗时 L 必须是正数（现在是 ${String(loopSecondsPerRound)}）`)
  if (F <= 0) problems.push(`${label}：收尾耗时 F 必须是正数（现在是 ${String(exitSeconds)}）`)
  if (L <= 0 || F <= 0) return problems

  if (totalSeconds === undefined || totalSeconds === null) return problems
  const T = seconds(totalSeconds)
  const floorSeconds = E + minLoops * L + F
  if (T < floorSeconds) {
    problems.push(
      `${label}：T=${T.toFixed(2)}s 太短 —— 必须 ≥ 起手 ${E.toFixed(2)} + ${minLoops} 轮循环 ${L.toFixed(2)} + 收尾 ${F.toFixed(2)} = ${floorSeconds.toFixed(2)}s，`
      + '否则永远播不到循环段（走→跑那条过渡就从"走循环中途"进入，会失效）',
    )
  }
  return problems
}

/** 时长单位表：中文/英文/缩写都认，值为"1 个该单位等于多少秒"。 */
const UNIT_SECONDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:ms|毫秒)$/i, 0.001],
  [/^(?:s|sec|secs|second|seconds|秒)$/i, 1],
  [/^(?:m|min|mins|minute|minutes|分|分钟)$/i, 60],
  [/^(?:h|hr|hrs|hour|hours|时|小时)$/i, 3600],
]

/**
 * 人类可读时长 → 秒。
 *
 * 认得：`90`、`90s`、`2m30s`、`1小时30分`、`1h30m10s`、`500ms`、`1时2分3秒`。
 * 纯数字按**秒**算。认不出来的返回 `undefined`（调用方报配置错误，别猜）。
 *
 * @param text - 用户写在配置里的字符串。
 * @returns 秒数，或 `undefined`。
 */
export function parseDuration(text: unknown): number | undefined {
  if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? text : undefined
  if (typeof text !== 'string') return undefined
  const raw = text.trim()
  if (raw === '') return undefined
  // 纯数字 = 秒
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw)

  // 负号一律拒绝（时间不能是负的）
  if (raw.includes('-')) return undefined

  let total = 0
  let matched = 0
  let rest = raw
  // 反复吃掉 "<数字><单位>"，单位可以是中文或英文
  const piece = /^(\d+(?:\.\d+)?)\s*([A-Za-z\u4e00-\u9fa5]+)/
  while (rest !== '') {
    const hit = piece.exec(rest)
    if (hit === null) return undefined
    const value = Number(hit[1])
    const unit = hit[2]
    const unitHit = UNIT_SECONDS.find(([re]) => re.test(unit))
    if (unitHit === undefined) return undefined
    total += value * unitHit[1]
    matched += 1
    rest = rest.slice(hit[0].length).trim()
  }
  return matched > 0 ? total : undefined
}

/**
 * 动作总闸：同一时刻只允许一个动作在演，两次"触发"之间至少隔这么多毫秒。
 *
 * 用户的原话：「只允许同时只有一个动作在运行，不允许有两个动作同时被触发」+
 * 「允许两个动作相隔较近，但不允许过近或同时触发」。
 */
export const MIN_ACTION_GAP_MS = 200

/**
 * 这一次触发还要等多久才能开演。
 *
 * @param lastTriggerMs - 上一次触发动作的时刻（还没触发过传 `undefined`）。
 * @param nowMs - 现在的时刻。
 * @param minGapMs - 最小间隔，缺省 {@link MIN_ACTION_GAP_MS}。
 * @returns `0` = 现在就能开演；`> 0` = 还要等这么多毫秒。
 *
 * 调用方决定**延后**还是**丢弃**这一次触发：
 * - 相位变化必须**延后**（丢一次桌宠就停在错的状态，晚 200ms 没人看得出来）；
 * - 用户点击可以**丢弃**（本来就是"还没演完，别急"的意思）。
 */
export function triggerDelayMs(
  lastTriggerMs: number | undefined,
  nowMs: number,
  minGapMs = MIN_ACTION_GAP_MS,
): number {
  if (lastTriggerMs === undefined || !Number.isFinite(lastTriggerMs)) return 0
  if (!Number.isFinite(nowMs)) return 0
  const wait = minGapMs - (nowMs - lastTriggerMs)
  return wait > 0 ? wait : 0
}
