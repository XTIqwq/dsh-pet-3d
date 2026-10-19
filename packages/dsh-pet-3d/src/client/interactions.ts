/**
 * 互动表（`interactions.json`）—— "这个模型能怎么被撸、每一下播哪条动作、说什么话"。
 *
 * 和 `appearance.json` / `choreography.json` 同一个思路：**能互动什么是模型自己的数据**，
 * 插件只负责读表、播动作、显示台词、把好感度记在本地。换一个模型、换一套台词，
 * 改文件就行（≤2 秒生效），不用改代码、不用重新构建。
 *
 * 形状（`version` 目前只有 1）：
 * ```jsonc
 * {
 *   "version": 1,
 *   "actions": [
 *     { "id": "pat", "label": "摸摸", "clip": "Avatar_..._Shy_Loop",
 *       "line": "唔…舒服。", "affinity": 1 }
 *   ],
 *   "affinity": { "max": 10, "lines": ["……", "今天心情不错。", "最喜欢你了。"] }
 * }
 * ```
 *
 * `clip` 必须是模型 `clips.json` 里真实存在的动作名 —— 写错不会报错，只会"点了没反应"，
 * 所以 `tools/verify-pet-menu.mjs` 会把它和真实动作表逐条核对。
 * @module dsh-pet-3d/client/interactions
 */

/** 一个互动按钮。 */
export interface InteractionAction {
  /** 稳定 id（守卫与 `data-pet3d-interaction` 按它定位；改名等于换一个新按钮）。 */
  id: string
  /** 按钮上的字。 */
  label: string
  /** 要播的动作名（`clips.json` 里的真名）。 */
  clip: string
  /** 说完就淡出的那一句台词；空字符串 = 不说话。 */
  line: string
  /** 这一次加多少好感度（缺省 1）。 */
  affinity: number
}

/** 好感度：上限与"满值台词"。 */
export interface InteractionAffinity {
  max: number
  /** 满值附近轮换说的句子（可以没有）。 */
  lines: string[]
}

/** 一个模型的互动表。 */
export interface Interactions {
  actions: InteractionAction[]
  affinity: InteractionAffinity
}

/** 解析结果：`interactions === null` = 这个模型没有可用的互动配置。 */
export interface ParsedInteractions {
  interactions: Interactions | null
  problems: string[]
}

/** 顶层允许的字段（多写的报出来，不静默吞掉）。 */
const TOP_FIELDS: readonly string[] = ['version', 'actions', 'affinity']

/** 一条动作允许的字段。 */
const ACTION_FIELDS: readonly string[] = ['id', 'label', 'clip', 'line', 'affinity']

/** 好感度允许的字段。 */
const AFFINITY_FIELDS: readonly string[] = ['max', 'lines']

/** 好感度缺省上限。 */
export const DEFAULT_AFFINITY_MAX = 10

/** Whether a JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析并校验一份 `interactions.json`。
 *
 * 永不抛：写坏一行只损失那一个按钮 + 一条问题，不会让整个菜单报错或空白。
 * @param raw - 解析后的 JSON 值。
 * @param label - 来源描述（问题文本里带上它）。
 * @returns 解析结果与问题清单；没有一条合法动作时 `interactions` 为 null。
 */
export function parseInteractions(raw: unknown, label: string): ParsedInteractions {
  const problems: string[] = []
  if (!isRecord(raw)) {
    problems.push(`${label}: 顶层必须是对象（{ "version": 1, "actions": [...] }）`)
    return { interactions: null, problems }
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_FIELDS.includes(key)) problems.push(`${label}: 未知字段 "${key}"（可用：${TOP_FIELDS.join(' / ')}），已忽略`)
  }

  const actions: InteractionAction[] = []
  const seen = new Set<string>()
  if (raw.actions !== undefined && !Array.isArray(raw.actions)) {
    problems.push(`${label}: "actions" 必须是数组`)
  }
  const rows = Array.isArray(raw.actions) ? raw.actions : []
  rows.forEach((entry, index) => {
    const where = `${label}: actions[${index}]`
    if (!isRecord(entry)) { problems.push(`${where} 必须是对象，已忽略`); return }
    for (const key of Object.keys(entry)) {
      if (!ACTION_FIELDS.includes(key)) problems.push(`${where}: 未知字段 "${key}"，已忽略`)
    }
    const id = entry.id
    if (typeof id !== 'string' || id === '') { problems.push(`${where}: "id" 必须是非空字符串，已忽略`); return }
    if (seen.has(id)) { problems.push(`${where}: id "${id}" 重复，已忽略`); return }
    const clip = entry.clip
    if (typeof clip !== 'string' || clip === '') {
      problems.push(`${where}（${id}）: "clip" 必须是非空字符串（动作表里的真实名字），已忽略`)
      return
    }
    if (entry.line !== undefined && typeof entry.line !== 'string') {
      problems.push(`${where}（${id}）: "line" 必须是字符串，已忽略`)
    }
    if (entry.affinity !== undefined && (typeof entry.affinity !== 'number' || !Number.isFinite(entry.affinity) || entry.affinity < 0)) {
      problems.push(`${where}（${id}）: "affinity" 必须是非负数字，已忽略`)
    }
    seen.add(id)
    actions.push({
      id,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : id,
      clip,
      line: typeof entry.line === 'string' ? entry.line : '',
      affinity: typeof entry.affinity === 'number' && Number.isFinite(entry.affinity) && entry.affinity >= 0 ? entry.affinity : 1,
    })
  })

  const affinity: InteractionAffinity = { max: DEFAULT_AFFINITY_MAX, lines: [] }
  if (raw.affinity !== undefined) {
    if (!isRecord(raw.affinity)) {
      problems.push(`${label}: "affinity" 必须是对象，已忽略`)
    } else {
      for (const key of Object.keys(raw.affinity)) {
        if (!AFFINITY_FIELDS.includes(key)) problems.push(`${label}: affinity 的未知字段 "${key}"，已忽略`)
      }
      const max = raw.affinity.max
      if (max !== undefined) {
        if (typeof max === 'number' && Number.isFinite(max) && max > 0) affinity.max = Math.floor(max)
        else problems.push(`${label}: affinity.max 必须是正数，已忽略`)
      }
      const lines = raw.affinity.lines
      if (lines !== undefined) {
        if (!Array.isArray(lines)) problems.push(`${label}: affinity.lines 必须是数组，已忽略`)
        else affinity.lines = lines.filter((line): line is string => typeof line === 'string' && line !== '')
      }
    }
  }

  if (actions.length === 0) {
    problems.push(`${label}: 没有一条可用的 actions（每个按钮至少要有 id 和 clip）`)
    return { interactions: null, problems }
  }
  return { interactions: { actions, affinity }, problems }
}

/** 本地存储键：每个模型各记一份（换模型不该把另一只的好感度带过来）。 */
export function affinityStorageKey(modelId: string): string {
  return `pet3d:affinity:${modelId}`
}

/** 读这个模型的好感度；没存过 / 存坏了都回 0。 */
export function loadAffinity(modelId: string): number {
  try {
    const raw = window.localStorage.getItem(affinityStorageKey(modelId))
    if (raw === null) return 0
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
  } catch {
    return 0
  }
}

/** 记住这个模型的好感度（存不下来也不算错：本次会话照常显示）。 */
export function saveAffinity(modelId: string, value: number): void {
  try {
    window.localStorage.setItem(affinityStorageKey(modelId), String(Math.max(0, Math.floor(value))))
  } catch {
    // 无痕模式 / 配额满：只在本页生效。
  }
}

/** 把好感度夹在 0..max（max 非法时退回缺省）。 */
export function clampAffinity(value: number, max: number): number {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_AFFINITY_MAX
  return Math.min(limit, Math.max(0, Math.floor(value)))
}

/** 好感度对应的一句心情话术（没有 lines 时返回 null）。 */
export function affinityLine(affinity: InteractionAffinity, value: number): string | null {
  if (affinity.lines.length === 0) return null
  const ratio = affinity.max > 0 ? Math.min(1, Math.max(0, value / affinity.max)) : 1
  const index = Math.min(affinity.lines.length - 1, Math.floor(ratio * affinity.lines.length))
  return affinity.lines[index] ?? null
}
