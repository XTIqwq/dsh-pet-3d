/**
 * 配饰表（`appearance.json`）—— "这个模型身上哪些部件可以穿、可以脱、哪些是二选一"。
 *
 * 为什么是**模型目录里的数据文件**而不是插件里的常量：能换的部件是模型自己的
 * 事（网格名、有几件、中文叫什么），交付新模型的人最清楚。插件只负责三件事：
 * 读这张表、把「脱掉哪些节点」记在本地、把结果交给渲染器。
 *
 * 文件放在模型目录里（和 `choreography.json`、`options.json` 同级），由既有的
 * `/pet3d/<id>/<相对路径>` 资源路由原样投递，所以**不需要宿主改一行代码**：
 * 改文件 ≤2 秒生效，不用刷新页面，也不用重启应用。
 *
 * 形状（`version` 目前只有 1）：
 * ```jsonc
 * {
 *   "version": 1,
 *   "title": "夏日装（可换装）",
 *   "hide": ["body_top2"],                 // 永远不显示的节点（占位/内部件）
 *   "groups": [                            // 互相排斥的"款式"：同一时刻只穿一件
 *     { "id": "top", "label": "面罩", "options": [
 *         { "id": "top1", "label": "潜水镜", "nodes": ["body_top1"], "default": true },
 *         { "id": "top0", "label": "太阳镜", "nodes": ["body_top0"] },
 *         { "id": "top-none", "label": "不戴", "nodes": [] }
 *     ] }
 *   ],
 *   "pieces": [                            // 独立的穿/脱
 *     { "id": "hat", "label": "草帽", "nodes": ["PanYinhu_ModHat"] }
 *   ]
 * }
 * ```
 *
 * `nodes` 是 glTF **节点名**（不是网格名 —— 这份资产的网格名是空的，名字在节点上）。
 * 一个部件可以跨多个节点；一个节点只能属于一处（重复声明按先出现的算并报问题）。
 *
 * 纪律：**身体和脸不放进 parts/groups**。表里只写"配饰/款式"，因为它们才是可以换的；
 * 把全身网格做成开关，等于给用户一个"让宠物消失"的按钮。
 * @module dsh-pet-3d/client/appearance
 */

/** 一件可以穿/脱的配饰。 */
export interface AppearancePiece {
  /** 稳定 id（本地存储与守卫按它定位；改名等于换一件新配饰）。 */
  id: string
  /** 菜单上显示的名字。 */
  label: string
  /** 这件配饰占哪些 glTF 节点名。 */
  nodes: string[]
  /** 默认就是脱下的状态（表里没写 = 默认穿在身上）。 */
  defaultHidden: boolean
}

/** 一组互斥款式里的一个选项。 */
export interface AppearanceOption {
  id: string
  label: string
  /** 这一款占哪些节点；空数组 = "不戴/无"（选中它等于把同组其它款全藏起来）。 */
  nodes: string[]
  /** 同组默认选它（一组最多一个）。 */
  default: boolean
}

/** 一组互斥款式（同一时刻只穿其中一件）。 */
export interface AppearanceGroup {
  id: string
  label: string
  options: AppearanceOption[]
}

/** 一个模型的配饰表。 */
export interface Appearance {
  /** 这套外观的名字（菜单标题与"整套外观"里的标签），缺省退回模型 id。 */
  title?: string
  /** 永远隐藏的节点（占位/内部件）。 */
  hide: string[]
  pieces: AppearancePiece[]
  groups: AppearanceGroup[]
}

/** 这张表允许出现的顶层字段（多写的会报出来，不静默吞掉）。 */
const APPEARANCE_FIELDS: readonly string[] = ['version', 'title', 'hide', 'pieces', 'groups']

/** 一件配饰允许出现的字段。 */
const PIECE_FIELDS: readonly string[] = ['id', 'label', 'nodes', 'defaultHidden']

/** 一个款式选项允许出现的字段。 */
const OPTION_FIELDS: readonly string[] = ['id', 'label', 'nodes', 'default']

/** 一组款式允许出现的字段。 */
const GROUP_FIELDS: readonly string[] = ['id', 'label', 'options']

/** Whether a JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a node-name array (empty array allowed, used for the "none" option). */
function readNodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((name): name is string => typeof name === 'string' && name !== '')
}

/**
 * 解析并校验一份 `appearance.json`。
 *
 * 永不抛：写坏一行只损失那一件配饰 + 一条问题，不会让整个菜单消失。理由和
 * `parseModelOptions` / `parseChoreography` 一样 —— 数据文件是手写的。
 * @param raw - 解析后的 JSON 值。
 * @param label - 来源描述（问题文本里带上它）。
 * @returns 解析结果与问题清单（空数组 = 干净）。
 */
export function parseAppearance(raw: unknown, label: string): { appearance: Appearance; problems: string[] } {
  const problems: string[] = []
  const empty: Appearance = { hide: [], pieces: [], groups: [] }
  if (!isRecord(raw)) {
    problems.push(`${label}: 顶层必须是对象（{ "version": 1, "pieces": [...] }）`)
    return { appearance: empty, problems }
  }
  for (const key of Object.keys(raw)) {
    if (!APPEARANCE_FIELDS.includes(key)) {
      problems.push(`${label}: 未知字段 "${key}"（可用：${APPEARANCE_FIELDS.join(' / ')}），已忽略`)
    }
  }
  const appearance: Appearance = { hide: [], pieces: [], groups: [] }
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || raw.title === '') problems.push(`${label}: "title" 必须是非空字符串，已忽略`)
    else appearance.title = raw.title
  }

  /** 节点名 → 声明它的地方；重复声明只保留第一个并报问题。 */
  const declared = new Map<string, string>()
  const claim = (nodes: string[], where: string): string[] => nodes.filter((name) => {
    const owner = declared.get(name)
    if (owner !== undefined) {
      problems.push(`${where}: 节点 "${name}" 已经属于 ${owner}，重复声明的那一条已忽略`)
      return false
    }
    declared.set(name, where)
    return true
  })

  if (raw.hide !== undefined) {
    if (!Array.isArray(raw.hide)) problems.push(`${label}: "hide" 必须是数组，已忽略`)
    else appearance.hide = claim(readNodes(raw.hide), `${label} hide`)
  }

  const seenIds = new Set<string>()

  if (raw.pieces !== undefined && !Array.isArray(raw.pieces)) {
    problems.push(`${label}: "pieces" 必须是数组，已忽略`)
  }
  const pieces = Array.isArray(raw.pieces) ? raw.pieces : []
  pieces.forEach((entry, index) => {
    const where = `${label}: pieces[${index}]`
    if (!isRecord(entry)) { problems.push(`${where} 必须是对象，已忽略`); return }
    for (const key of Object.keys(entry)) {
      if (!PIECE_FIELDS.includes(key)) problems.push(`${where}: 未知字段 "${key}"，已忽略`)
    }
    const id = entry.id
    if (typeof id !== 'string' || id === '') { problems.push(`${where}: "id" 必须是非空字符串，已忽略`); return }
    if (seenIds.has(id)) { problems.push(`${where}: id "${id}" 重复，已忽略`); return }
    const nodes = claim(readNodes(entry.nodes), `${label} ${id}`)
    if (nodes.length === 0) { problems.push(`${where}（${id}）: "nodes" 必须是非空字符串数组，已忽略`); return }
    if (entry.defaultHidden !== undefined && typeof entry.defaultHidden !== 'boolean') {
      problems.push(`${where}（${id}）: "defaultHidden" 必须是布尔值，已忽略`)
    }
    seenIds.add(id)
    appearance.pieces.push({
      id,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : id,
      nodes,
      defaultHidden: entry.defaultHidden === true,
    })
  })

  if (raw.groups !== undefined && !Array.isArray(raw.groups)) {
    problems.push(`${label}: "groups" 必须是数组，已忽略`)
  }
  const groups = Array.isArray(raw.groups) ? raw.groups : []
  groups.forEach((entry, index) => {
    const where = `${label}: groups[${index}]`
    if (!isRecord(entry)) { problems.push(`${where} 必须是对象，已忽略`); return }
    for (const key of Object.keys(entry)) {
      if (!GROUP_FIELDS.includes(key)) problems.push(`${where}: 未知字段 "${key}"，已忽略`)
    }
    const id = entry.id
    if (typeof id !== 'string' || id === '') { problems.push(`${where}: "id" 必须是非空字符串，已忽略`); return }
    if (seenIds.has(id)) { problems.push(`${where}: id "${id}" 重复，已忽略`); return }
    if (!Array.isArray(entry.options) || entry.options.length === 0) {
      problems.push(`${where}（${id}）: "options" 必须是非空数组，已忽略`)
      return
    }
    const options: AppearanceOption[] = []
    let defaults = 0
    entry.options.forEach((rawOption, optionIndex) => {
      const at = `${where}（${id}）options[${optionIndex}]`
      if (!isRecord(rawOption)) { problems.push(`${at} 必须是对象，已忽略`); return }
      for (const key of Object.keys(rawOption)) {
        if (!OPTION_FIELDS.includes(key)) problems.push(`${at}: 未知字段 "${key}"，已忽略`)
      }
      const optionId = rawOption.id
      if (typeof optionId !== 'string' || optionId === '') { problems.push(`${at}: "id" 必须是非空字符串，已忽略`); return }
      if (seenIds.has(optionId)) { problems.push(`${at}: id "${optionId}" 重复，已忽略`); return }
      const nodes = claim(readNodes(rawOption.nodes), `${label} ${optionId}`)
      if (rawOption.nodes !== undefined && !Array.isArray(rawOption.nodes)) {
        problems.push(`${at}（${optionId}）: "nodes" 必须是数组，已当作"不戴"处理`)
      }
      if (rawOption.default === true) defaults++
      seenIds.add(optionId)
      options.push({
        id: optionId,
        label: typeof rawOption.label === 'string' && rawOption.label !== '' ? rawOption.label : optionId,
        nodes,
        default: rawOption.default === true,
      })
    })
    if (options.length === 0) return
    if (defaults > 1) problems.push(`${where}（${id}）: 有 ${defaults} 个 default，只认第一个`)
    appearance.groups.push({
      id,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : id,
      options: options.map((option, optionIndex) => ({
        ...option,
        default: option.default && options.findIndex(o => o.default) === optionIndex,
      })),
    })
  })

  if (appearance.pieces.length === 0 && appearance.groups.length === 0) {
    problems.push(`${label}: pieces 与 groups 都是空的，这个模型将没有可切换的配饰`)
  }
  return { appearance, problems }
}

/** 这件/这款占的全部节点（不含 `hide`）。 */
export function pieceNodes(appearance: Appearance | null): string[] {
  if (appearance === null) return []
  return [
    ...appearance.pieces.flatMap(piece => piece.nodes),
    ...appearance.groups.flatMap(group => group.options.flatMap(option => option.nodes)),
  ]
}

/** 表里声明过的**全部**节点（含永远隐藏的 `hide`），按声明顺序 —— 隐藏列表按它排序。 */
export function declaredNodes(appearance: Appearance | null): string[] {
  if (appearance === null) return []
  return [...appearance.hide, ...pieceNodes(appearance)]
}

/** 表里没被用户改过时该藏哪些节点：`hide` + 非默认款式 + 默认脱下的配饰。 */
export function defaultHidden(appearance: Appearance | null): string[] {
  if (appearance === null) return []
  const hidden = new Set(appearance.hide)
  for (const group of appearance.groups) {
    // 没标 default 的组按"第一个有几何的款"算默认 —— 否则一进菜单就把所有款全藏了，
    // 下装那种组会直接让人物没有身体（比"默认款不对"严重得多）。
    const chosen = group.options.find(option => option.default) ?? group.options.find(option => option.nodes.length > 0)
    for (const option of group.options) {
      if (option === chosen) continue
      for (const name of option.nodes) hidden.add(name)
    }
  }
  for (const piece of appearance.pieces) {
    if (piece.defaultHidden) for (const name of piece.nodes) hidden.add(name)
  }
  return declaredNodes(appearance).filter(name => hidden.has(name))
}

/**
 * 把一份"想藏起来"的列表收拢到这张表声明过的节点上。
 *
 * 为什么要过滤：表会变（新交付删掉一件配饰、改了节点名），而本地存的是上一次的
 * 节点名。不认识的名字传给渲染器没有危害（它按名字找不到就跳过），但留着会让
 * "脱了几件"的计数和菜单勾选状态对不上。
 * @param appearance - 当前模型的配饰表。
 * @param hidden - 想藏的节点名。
 * @returns 只包含表里声明过的节点，保持表里的顺序。
 */
export function sanitizeHidden(appearance: Appearance | null, hidden: readonly string[]): string[] {
  if (appearance === null) return []
  const wanted = new Set(hidden)
  return declaredNodes(appearance).filter(name => wanted.has(name))
}

/** 一件配饰现在的状态：是否脱下来了。 */
export function pieceHidden(piece: AppearancePiece, hidden: readonly string[]): boolean {
  const set = new Set(hidden)
  return piece.nodes.every(name => set.has(name))
}

/** 一组款式里正在穿的是哪一个：节点全可见的那款；都不可见则是"不戴"（空节点那款）。 */
export function selectedOptionId(group: AppearanceGroup, hidden: readonly string[]): string | undefined {
  const set = new Set(hidden)
  const worn = group.options.find(option => option.nodes.length > 0 && option.nodes.every(name => !set.has(name)))
  if (worn !== undefined) return worn.id
  return group.options.find(option => option.nodes.length === 0)?.id
}

/**
 * 换一款：选中款的节点全部显示，同组其它款全部隐藏。
 *
 * 只动这一组，不碰别的配饰/款式（"换下装"不该把帽子也穿回去）。
 * @param appearance - 配饰表。
 * @param group - 要换的那一组。
 * @param optionId - 目标款 id。
 * @param hidden - 当前隐藏表。
 * @returns 新的隐藏表（已按表内顺序整理）。
 */
export function applyGroupChoice(
  appearance: Appearance,
  group: AppearanceGroup,
  optionId: string,
  hidden: readonly string[],
): string[] {
  const next = new Set(hidden)
  for (const option of group.options) {
    const chosen = option.id === optionId
    for (const name of option.nodes) {
      if (chosen) next.delete(name)
      else next.add(name)
    }
  }
  return sanitizeHidden(appearance, [...next])
}

/** 本地存储键：每个模型各存一份（换模型不该把另一套的配饰也脱了）。 */
export function appearanceStorageKey(modelId: string): string {
  return `pet3d:appearance:${modelId}`
}

/**
 * 读这个模型上次的配饰状态。
 * @param modelId - 模型 id（目录名）。
 * @returns 节点名数组，或 undefined 表示"还没被用户改过"（此时用表里的默认值）。
 */
export function loadAppearanceHidden(modelId: string): string[] | undefined {
  try {
    const raw = window.localStorage.getItem(appearanceStorageKey(modelId))
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    return parsed.filter((name): name is string => typeof name === 'string' && name !== '')
  } catch {
    return undefined
  }
}

/** 记住这个模型的配饰状态（存不下来也不算错：本次会话照常生效）。 */
export function saveAppearanceHidden(modelId: string, hidden: readonly string[]): void {
  try {
    window.localStorage.setItem(appearanceStorageKey(modelId), JSON.stringify([...hidden]))
  } catch {
    // 无痕模式 / 配额满：只在本页生效。
  }
}
