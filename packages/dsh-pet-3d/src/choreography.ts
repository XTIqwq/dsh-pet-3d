/**
 * 动作编排配置（`choreography.json`）。
 *
 * 这是给用户自己排"什么时候做什么动作"的数据文件，放在模型目录里
 * （`$DSH_HOME/models/<id>/choreography.json`），改完 ≤2 秒自动生效，不重启、不刷新。
 *
 * 设计的三个取舍：
 *
 * 1. **动作用英文 id，但允许通配**：`Avatar_…_Galgame_*_Loop` 能一次选中六种情绪；面板/编辑器
 *    显示中文名（来自名称对照表 `clip-names.csv` → `clips.json.displayName`）。
 * 2. **"一拍"结构写进数据**：起手(`enter`) → 循环(`loop`) × `loops` 遍 → 收招(`exit`) → 回待机。
 *    三段都可以留空（留空就跳过那一段），所以既能表达"跑"（起手+循环、没有收招），
 *    也能表达"高兴"（三段齐全、只循环一遍）。
 * 3. **缺省即现状**：文件缺失/字段缺失/名字对不上，一律回落到内置的名字约定
 *    （`X_Loop` → `X_Start` / `X_End`），不会因为配置写坏而不动。
 */

import { PHASE_STATES, type PhaseState } from './state.ts'
import { parseDuration, type GapPolicy } from './timeline.ts'

/** 一个"动作"：三段 + 时长/遍数。任意一段都可以省略。 */
export interface ChoreographyBeat {
  /** 起手段（进入）。 */
  enter?: string
  /** 循环段（动作本体）。 */
  loop?: string
  /** 收招段（回归平静）。 */
  exit?: string
  /** 循环段放几遍；缺省 = 一直循环（持续状态），`1` = 一拍。 */
  loops?: number
  /**
   * 这个状态的 **T**（起手播完之后还要持续多少秒）。
   *
   * 一个状态**同时**允许填 `seconds` 和 `loops`：有 T 时按 `T = nL + F` 动态排期，
   * 没有 T 时就用配置写死的 `loops`。两者都不填 = 一直循环。
   */
  seconds?: number
  /** 富余时间怎么补（只在有 T 时有意义）；缺省 `pause`（播完站常态循环）。 */
  gap?: GapPolicy
}

/**
 * 演出的触发时机。
 *
 * - `manual` —— 只在编排器里点「试播」时演（缺省）；
 * - `run`    —— 开始干活时（相位从闲置/思考切到"跑"）；
 * - `done` / `failed` —— 回合完成 / 出错时；
 * - `idle`   —— 闲置超过 `afterSeconds` 秒还闲着，自己演一段；
 * - `daily`  —— 每天第一次打开时（按浏览器记日期）。
 *
 * 注意：`idle` / `daily` 是**会自己开演**的两类，所以它们必须在编排器里显式加进来
 * —— 之前那套 `timed` 彩蛋之所以被用户整套删掉，就是因为它不由分说地插演。
 */
export const PERFORMANCE_TRIGGERS = ['manual', 'run', 'done', 'failed', 'idle', 'daily'] as const

/** 演出的触发时机类型。 */
export type PerformanceTrigger = (typeof PERFORMANCE_TRIGGERS)[number]

/** 演出里的一步：一条 clip，可选"占多少秒"。 */
export interface PetPerformanceStep {
  /** clip 名（允许通配，和 `states` 里的写法一致）。 */
  clip: string
  /** 这一步占多少秒；省略 = 播到这条 clip 的自然结尾再进下一步。 */
  seconds?: number
  /** 播放倍率，缺省 1（<1 放慢，>1 加快）。 */
  rate?: number
}

/**
 * 一套"演出"：按顺序连播的若干 clip。
 *
 * 和 `states` 的区别：`states` 是**状态驱动**的循环（跑到死都用同一条），
 * 演出是**一次性**的曲子 —— 有开头、有结尾、演完回到当前相位。
 */
export interface PetPerformance {
  /** 显示名（缺省用 id）。 */
  name?: string
  /** 什么时候演。 */
  trigger: PerformanceTrigger
  /** 每个触发窗口只演一次；缺省 `true`。 */
  once?: boolean
  /** 仅 `idle` 用：闲置多少秒之后开演；缺省 180。 */
  afterSeconds?: number
  /** 步骤（至少一步）。 */
  steps: readonly PetPerformanceStep[]
}

/** 演出步骤数的上限：防止手写文件把编排器/引擎拖垮。 */
const MAX_PERFORMANCE_STEPS = 64

/** 完整配置。 */
export interface Choreography {
  version: number
  /** 六个相位状态各自的动作。 */
  states: Partial<Record<PhaseState, ChoreographyBeat>>
  /**
   * 跨状态的"桥"：`"from>to"` → 依次播**一次**的 clip 名。
   *
   * 为什么需要它：这套资产分成三套互不相通的家族，家族之间差 28–40°，直接切就是硬跳。
   * 桥把"收步 → 过渡"这条链写进数据，客户端照着放，放完直接进目标状态的起手段。
   * 键必须是 `<状态>><状态>`（状态名见 `PHASE_STATES`）。
   */
  transitions?: Record<string, readonly string[]>
  /**
   * 演出：`id` → 一套按顺序连播的曲子（见 {@link PetPerformance}）。
   *
   * 与 `states` 正交：`states` 管"某个相位循环演什么"，演出管"某个时刻演一小段"。
   * 演出期间相位变化被屏蔽（和"一拍"一样），演完回到当前相位。
   */
  performances?: Record<string, PetPerformance>
  /**
   * 渲染开销相关的开关（帧率不够时用）。
   *
   * `outlineMode` 决定描边怎么画（2026-10-18）：
   *   · `shell`（缺省）= 反向壳：同一份几何外扩一圈纯黑、只画背面。厚实、便宜，但在
   *     **层叠薄片**上会把黑壳从表面里扎出来（夏日装的胡须/毛领就是单层薄片 ⇒ 白毛上
   *     出现黑块、关节处出现黑圈；关掉描边立刻消失，原版 panyinhu 因为皮毛是实体所以干净）。
   *   · `edge` = 屏幕空间深度边缘检测：场景渲进带深度的 RT，再按深度差画 1~2px 的线。
   *     黑壳不再是几何，薄片之间不会扎黑边；代价是多一个深度 pass。
   *   · `off` = 不画描边。
   * 改这个字段 2 秒内生效（客户端轮询 choreography.json），**不用重载模型**。
   */
  render?: {
    outlineWidth?: number
    morphs?: boolean
    outlineMode?: 'shell' | 'edge' | 'off'
    /** `edge` 模式：线宽（单位=画布像素，1.6 大约是 2px 的视觉宽度）。 */
    edgeThickness?: number
    /**
     * `edge` 模式：深度差阈值，**世界单位**（宠物被归一化到高度 1）。
     *
     * 调它就是在选"哪些前后关系算一条线"：薄片之间只差 1~2cm，而轮廓是无穷远，
     * 所以阈值抬高不会丢轮廓，只会把层叠薄片（胡须/毛领）产生的碎线滤掉。
     * 实测 0.008 会把整片胡须画黑，0.035 左右只留轮廓与"手臂压在身体前"这类真前后关系。
     */
    edgeThreshold?: number
    /**
     * 环境光强度（1 = 现在的缺省 0.62）。用来压"黑色阴影感"：toon 分级下**背光面会掉进最暗档**，
     * 下巴/腋下这类朝下的面就变成一团黑。抬环境光能把这些面托起来，代价是整体反差变小。
     */
    ambient?: number
    /**
     * 补光强度（缺省 0），灯在**前下方**，专门托住朝下的面（下巴、腋下、裙摆内侧）。
     * 比抬环境光更"只救暗部"：亮面基本不变，暗面明显变亮。
     */
    fill?: number
  }
}

/**
 * 取一条可播的"桥"。
 *
 * 桥必须**完整**：链里任何一支在模型里不存在，就整条不放（返回空数组）。
 * 半截桥的起点/终点姿态是错的，还不如让调用方退回硬切 —— 宁可跳一下，不要跳错位置。
 *
 * @param transitions - 配置里的 `transitions`。
 * @param from - 从哪个状态离开（还没进任何状态时是 `undefined`）。
 * @param to - 要去哪个状态。
 * @param names - 模型实际带的 clip 名。
 * @returns 可播的 clip 序列；没有桥/不完整时返回空数组。
 */
export function bridgeFor(
  transitions: Record<string, readonly string[]> | undefined,
  from: PhaseState | undefined,
  to: PhaseState,
  names: readonly string[],
): string[] {
  if (transitions === undefined || from === undefined || from === to) return []
  const chain = transitions[`${from}>${to}`]
  if (chain === undefined || chain.length === 0) return []
  const present = new Set(names)
  return chain.every((clip) => present.has(clip)) ? [...chain] : []
}

/**
 * 占多数的那一族名字前缀（这个模型是 `Avatar_Male_Size03_PanYinhu_`）。
 *
 * 用途是让配置能写**短名**：用户在编排器里看到的是 `Galgame_Sad_Loop`，
 * 自然就会写 `Galgame_*_Loop`，而不是把 40 个字符的前缀抄一遍。匹配时短名和全名都试。
 */
export function dominantNamePrefix(names: readonly string[]): string {
  if (names.length === 0) return ''
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const token = name.split('_', 1)[0] ?? name
    const list = groups.get(token) ?? []
    list.push(name)
    groups.set(token, list)
  }
  let best: readonly string[] = []
  for (const list of groups.values()) if (list.length > best.length) best = list
  if (best.length === 0 || best.length * 100 < names.length * 60) return ''
  let prefix = best[0] ?? ''
  for (const name of best) {
    let i = 0
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i += 1
    prefix = prefix.slice(0, i)
    if (prefix === '') break
  }
  const cut = prefix.lastIndexOf('_')
  return cut > 0 ? prefix.slice(0, cut + 1) : ''
}

/** 去掉多数族前缀的短名（前缀算不出来就原样返回）。 */
export function shortClipName(name: string, names: readonly string[]): string {
  const prefix = dominantNamePrefix(names)
  return prefix !== '' && name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/** 通配匹配：`*` 任意串（大小写不敏感），`?` 单字符。 */
export function matchesClip(pattern: string, name: string): boolean {
  if (pattern === name) return true
  if (!pattern.includes('*') && !pattern.includes('?')) return false
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${escaped}$`, 'iu').test(name)
}

/**
 * 从一个 clip 名单里挑出匹配某个模式的所有名字（保持原顺序）。
 *
 * 匹配时除了全名，还把名字**在每个下划线处截断后**再试一遍：所以 `Galgame_*_Loop`、
 * `Ani_Galgame_*_Loop`、`Avatar_Male_Size03_PanYinhu_Ani_Galgame_*_Loop` 三种写法都能命中
 * 同一批动作。这一步是必须的 —— 配置里人只会写动作那一截（`Galgame_*_Loop`），
 * 而不是把 40 个字符的资源前缀抄一遍；只按全名匹配的话，"戳一下"会直接没反应。
 */
export function expandPattern(pattern: string, names: readonly string[]): string[] {
  const hit = (name: string): boolean => {
    if (matchesClip(pattern, name)) return true
    let at = name.indexOf('_')
    while (at >= 0) {
      if (matchesClip(pattern, name.slice(at + 1))) return true
      at = name.indexOf('_', at + 1)
    }
    return false
  }
  return names.filter(hit)
}

/** 命中 `pool` 里任意一个模式的名字。 */
export function poolOf(pool: readonly string[], names: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const pattern of pool) {
    for (const name of expandPattern(pattern, names)) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const positive = (value: unknown): number | undefined => {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined
}

function parseBeat(raw: unknown): ChoreographyBeat | undefined {
  if (typeof raw === 'string') return { loop: raw }
  if (!isRecord(raw)) return undefined
  // `seconds`（该状态的 T）允许写成人类可读：`"1小时30分"` / `"10s"` / `90`；0 也合法。
  const seconds = parseDuration(raw.seconds ?? raw.秒)
  const gap = raw.gap === 'stretch' || raw.gap === 'pause' ? raw.gap : undefined
  const beat: ChoreographyBeat = {
    enter: text(raw.enter) ?? text(raw.起手),
    loop: text(raw.loop) ?? text(raw.循环),
    exit: text(raw.exit) ?? text(raw.收招),
    loops: positive(raw.loops) ?? positive(raw.循环遍数),
    ...(seconds === undefined ? {} : { seconds }),
    ...(gap === undefined ? {} : { gap }),
  }
  const hasClip = beat.enter !== undefined || beat.loop !== undefined || beat.exit !== undefined
  return hasClip || beat.loops !== undefined ? beat : undefined
}

/** 解析一步演出（允许写成裸字符串 = 只给 clip 名）。 */
function parsePerformanceStep(raw: unknown): PetPerformanceStep | undefined {
  if (typeof raw === 'string') {
    const clip = text(raw)
    return clip === undefined ? undefined : { clip }
  }
  if (!isRecord(raw)) return undefined
  const clip = text(raw.clip) ?? text(raw.动作)
  if (clip === undefined) return undefined
  const seconds = parseDuration(raw.seconds ?? raw.秒)
  const rateValue = typeof raw.rate === 'number' && Number.isFinite(raw.rate) ? raw.rate : undefined
  // 倍率限制在 0.1–4：再往外的值不是"变快变慢"，是写错了（three 会照单全收，看起来像坏掉）。
  const rate = rateValue === undefined ? undefined : Math.min(4, Math.max(0.1, rateValue))
  return {
    clip,
    ...(seconds === undefined || seconds <= 0 ? {} : { seconds }),
    ...(rate === undefined || rate === 1 ? {} : { rate }),
  }
}

/** 解析一套演出；看不懂就返回 undefined（调用方报问题）。 */
function parsePerformance(raw: unknown): PetPerformance | undefined {
  if (!isRecord(raw)) return undefined
  const rawTrigger = text(raw.trigger) ?? 'manual'
  const trigger = (PERFORMANCE_TRIGGERS as readonly string[]).includes(rawTrigger)
    ? rawTrigger as PerformanceTrigger
    : 'manual'
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : []
  const steps = rawSteps
    .slice(0, MAX_PERFORMANCE_STEPS)
    .map((step) => parsePerformanceStep(step))
    .filter((step): step is PetPerformanceStep => step !== undefined)
  if (steps.length === 0) return undefined
  const afterSeconds = parseDuration(raw.afterSeconds ?? raw.闲置秒数)
  const once = typeof raw.once === 'boolean' ? raw.once : undefined
  return {
    ...(text(raw.name) === undefined ? {} : { name: text(raw.name) }),
    trigger,
    ...(once === undefined ? {} : { once }),
    ...(afterSeconds === undefined || afterSeconds <= 0 ? {} : { afterSeconds }),
    steps,
  }
}

/**
 * 解析配置。**不抛错**：这是用户手写/用网页编排器生成的文件，坏字段应该被忽略并汇报，
 * 而不是让宠物不动。返回的 `problems` 会显示在面板上。
 */
export function parseChoreography(raw: unknown): { config: Choreography; problems: string[] } {
  const problems: string[] = []
  const config: Choreography = { version: 1, states: {} }
  if (!isRecord(raw)) {
    problems.push('choreography.json：顶层不是对象，已忽略（回落到内置编排）')
    return { config, problems }
  }
  const states = isRecord(raw.states) ? raw.states : {}
  for (const state of PHASE_STATES) {
    const beat = parseBeat(states[state])
    if (beat !== undefined) config.states[state] = beat
    else if (states[state] !== undefined) problems.push(`choreography.json：states.${state} 看不懂，已忽略`)
  }
  // 彩蛋（`timed` 定时插入）与"戳一下"（`click` 点击池）都已按用户要求**整套删除**。
  // 旧配置里还留着它们时明确报出来，而不是静默忽略 —— 否则"我明明配了它却不播"会变成一个查不出来的谜。
  if (raw.timed !== undefined) {
    problems.push('choreography.json：`timed`（闲置彩蛋）已删除，这一项被忽略 —— 桌宠不再自己定时插演')
  }
  if (raw.click !== undefined) {
    problems.push('choreography.json：`click`（戳一下的点击池）已删除，这一项被忽略 —— 点宠物不再演剧情')
  }
  // 桥（跨状态过渡）：键写成 `<状态>><状态>`，值是一串 clip。
  if (isRecord(raw.transitions)) {
    const transitions: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(raw.transitions)) {
      const parts = key.split('>')
      const from = parts[0]
      const to = parts[1]
      if (parts.length !== 2 || !PHASE_STATES.includes(from as PhaseState) || !PHASE_STATES.includes(to as PhaseState)) {
        problems.push(`choreography.json：transitions."${key}" 的键必须是 "<状态>><状态>"（可用状态：${PHASE_STATES.join(' / ')}），已忽略`)
        continue
      }
      const clips = Array.isArray(value)
        ? value.map((item) => text(item)).filter((item): item is string => item !== undefined)
        : []
      if (clips.length === 0) {
        problems.push(`choreography.json：transitions."${key}" 需要至少一个 clip 名，已忽略`)
        continue
      }
      transitions[key] = clips
    }
    if (Object.keys(transitions).length > 0) config.transitions = transitions
  }
  // 演出：`id` → 一套按顺序连播的曲子。
  if (isRecord(raw.performances)) {
    const performances: Record<string, PetPerformance> = {}
    for (const [id, value] of Object.entries(raw.performances)) {
      const performance = parsePerformance(value)
      if (performance === undefined) {
        problems.push(`choreography.json：performances."${id}" 至少要有一个可用的步骤（clip 名），已忽略`)
        continue
      }
      const rawTrigger = isRecord(value) ? text(value.trigger) : undefined
      if (rawTrigger !== undefined && !(PERFORMANCE_TRIGGERS as readonly string[]).includes(rawTrigger)) {
        problems.push(`choreography.json：performances."${id}".trigger="${rawTrigger}" 不认识（可用：${PERFORMANCE_TRIGGERS.join(' / ')}），按 manual 处理`)
      }
      performances[id] = performance
    }
    if (Object.keys(performances).length > 0) config.performances = performances
  }
  if (isRecord(raw.render)) {
    const render: Choreography['render'] = {}
    const width = raw.render.outlineWidth
    if (typeof width === 'number' && Number.isFinite(width) && width >= 0) render.outlineWidth = width
    if (typeof raw.render.morphs === 'boolean') render.morphs = raw.render.morphs
    // 描边方式：只认这三个值，写错了退回缺省（shell）而不是把整份配置判成坏
    const mode = raw.render.outlineMode
    if (mode === 'shell' || mode === 'edge' || mode === 'off') render.outlineMode = mode
    // edge 模式的两个手感旋钮（线宽 / 深度阈值），非法值一律忽略
    for (const key of ['edgeThickness', 'edgeThreshold', 'ambient', 'fill'] as const) {
      const value = raw.render[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) render[key] = value
    }
    if (Object.keys(render).length > 0) config.render = render
  }
  const version = positive(raw.version)
  if (version !== undefined) config.version = version
  return { config, problems }
}

/**
 * 默认配置：和内置的名字约定等价（`X_Loop` → `X_Start` / `X_End`），外加四套默认演出。
 *
 * 演出刻意都选**短**的（入场 4s、回头看一眼 1.9s、情绪一小段）：
 * 桌宠是常驻的，长演出会变成噪音。默认值只在这份文件缺失、或用户点「恢复缺省」时生效
 * —— 已经有 `choreography.json` 的机器不会突然开始自己演（要演得自己在编排器里加）。
 */
export const DEFAULT_CHOREOGRAPHY: Choreography = {
  version: 1,
  states: {
    idle: { loop: 'Idle_Loop' },
    walk: { loop: 'Walk_Loop' },
    run: { loop: 'MainCity_Run_Loop' },
    think: { loop: 'Galgame_Think_Loop' },
    done: { loop: 'Galgame_Happy_Loop', loops: 1 },
    failed: { loop: 'Galgame_Sad_Loop', loops: 1 },
  },
  performances: {
    /** 每天第一次见面：角色切换入场。 */
    greet: {
      name: '见面',
      trigger: 'daily',
      steps: [{ clip: 'SwitchIn_Normal' }],
    },
    /** 回合完成：高兴一小段（起手 → 循环 2 秒 → 收招）。 */
    celebrate: {
      name: '完工庆祝',
      trigger: 'done',
      steps: [
        { clip: 'Galgame_Happy_Start' },
        { clip: 'Galgame_Happy_Loop', seconds: 2 },
        { clip: 'Galgame_Happy_End' },
      ],
    },
    /** 开始干活：回头看一眼再跑。 */
    lookBack: {
      name: '开始干活',
      trigger: 'run',
      steps: [{ clip: 'TurnBack' }],
    },
    /** 闲置五分钟：自己动一下。 */
    idleFidget: {
      name: '闲置小动作',
      trigger: 'idle',
      afterSeconds: 300,
      steps: [{ clip: 'Galgame_Idle' }],
    },
  },
}

/**
 * 非破坏性保存：把"这次提交里没有、但磁盘上还有"的白名单字段补回配置里。
 *
 * 为什么需要它：宿主写盘的是**解析结果的子集**，所以提交里没有的字段一律消失。
 * 真实事故（2026-10-15）：宿主没重启时手里是旧解析器，它不认识
 * `transitions` / `seconds` / `gap` / `walk` / `run` / `think` —— 用户在编排器点一下「保存」
 * 这些就全没了（靠 `.bak` 才救回来）。这个函数让"点保存"对白名单字段永远只增不减，
 * 并把"保留了什么"**报出来**（不静默）。
 *
 * **`diskRaw` 必须是原始 JSON**，不能是 `parseChoreography` 的结果 ——
 * 旧解析器同样看不见那些字段，拿解析结果来恢复就等于没修。
 *
 * 白名单刻意只收"旧解析器会丢、而用户不会有意清空"的东西：顶层
 * `transitions` / `render`、整块缺失的 `states.<x>`、每个状态的 `seconds` / `gap`。
 * `enter` / `loop` / `exit` **故意不在白名单里**：旧解析器认识它们，而用户可能是有意清空的
 * （清空 = 这个状态不要这一段），补回来反而让人删不掉。
 *
 * @param config - 这次提交解析出来的配置（**会被就地修改**）。
 * @param diskRaw - 磁盘上现有文件的原始 JSON。
 * @param problems - 追加"保留了哪些字段"的说明。
 */
export function restoreDroppedFields(config: Choreography, diskRaw: unknown, problems: string[]): void {
  if (!isRecord(diskRaw)) return
  const mine = config as unknown as Record<string, unknown>
  const keep = (key: string, label: string): void => {
    if (mine[key] === undefined && diskRaw[key] !== undefined) {
      mine[key] = diskRaw[key]
      problems.push(`保存内容里没有 ${label}，已按磁盘上的原值保留`)
    }
  }
  keep('transitions', 'transitions（跨状态桥）')
  keep('render', 'render（渲染开关）')
  // 演出是"用户排的东西"，和桥同级：旧解析器（没重启的宿主）不认识它，
  // 一次保存就会把用户刚排的曲子吃掉 —— 这正是那次事故的形状，所以也进白名单。
  keep('performances', 'performances（演出）')

  const diskStates = isRecord(diskRaw.states) ? diskRaw.states : {}
  const myStates = config.states as Record<string, Record<string, unknown> | undefined>
  for (const [state, rawBeat] of Object.entries(diskStates)) {
    if (!isRecord(rawBeat)) continue
    const myBeat = myStates[state]
    if (myBeat === undefined) {
      myStates[state] = { ...rawBeat }
      problems.push(`保存内容里没有 states.${state}，已按磁盘上的原值保留`)
      continue
    }
    for (const key of ['seconds', 'gap'] as const) {
      if (myBeat[key] === undefined && rawBeat[key] !== undefined) {
        myBeat[key] = rawBeat[key]
        problems.push(`保存内容里没有 states.${state}.${key}，已按磁盘上的原值保留`)
      }
    }
  }
}
