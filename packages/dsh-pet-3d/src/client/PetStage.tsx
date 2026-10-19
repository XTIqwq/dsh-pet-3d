/**
 * PetStage — the pet surface, plus its action panel.
 *
 * The panel exists because judging a gesture needs a bigger, seen-from-any-angle
 * pet than a 348px desktop companion, and because a model folder now carries
 * ALL of its clips: the panel is where "play any one of the 155" happens.
 *
 * 面板只在**开发者模式**（设置 → 3D 桌宠 → 开发者）打开时存在：关着时点宠物不会
 * 出小方块，宠物只剩拖动。开关存在客户端（见 dev-mode.ts），所以是即时的。
 *
 *   放大   — scales the stage box itself (crisp; the renderer resizes), rather
 *            than CSS-zooming a fixed-size canvas into blur;
 *   视角   — Blender-style orbit: yaw/pitch sliders, or right-drag on the pet;
 *   动作   — every clip the MODEL carries, playable once or looping, with a
 *            global pause and speed;
 *   相位   — force one of the four phase states without waiting for a real
 *            session to reach it, plus what the host currently reports.
 *
 * Deliberately absent: timeline scrubbing and frame stepping. The clip list is
 * gated on the payload: names appear as soon as `clips.json` is parsed, and the
 * buttons only arm once `clips.bin` has been assembled, so a click can never
 * play a clip that is not there yet.
 *
 * Everything the panel changes is inspection-scoped: closing it restores the
 * model's own camera and the configured size, so the desktop pet is never left
 * wearing a debug pose.
 * @module dsh-pet-3d/client/PetStage
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { DEFAULT_CHOREOGRAPHY, parseChoreography, type Choreography, type PerformanceTrigger } from '../choreography.ts'
import type { PetDefinition } from '../model.ts'
import { PHASE_STATES, type PhaseState } from '../state.ts'
import {
  applyGroupChoice,
  defaultHidden,
  loadAppearanceHidden,
  parseAppearance,
  sanitizeHidden,
  saveAppearanceHidden,
  type Appearance,
  type AppearanceGroup,
  type AppearancePiece,
} from './appearance.ts'
import { ChoreographyEditor } from './ChoreographyEditor.tsx'
import { devModeEnabled, useDevMode } from './dev-mode.ts'
import {
  affinityLine,
  clampAffinity,
  DEFAULT_AFFINITY_MAX,
  loadAffinity,
  parseInteractions,
  saveAffinity,
  type InteractionAction,
  type Interactions,
} from './interactions.ts'
import { PetMenu, type PetMenuAnchor, type PetMenuModel } from './PetMenu.tsx'
import { subscribePerformanceRequests, type PerformanceRequest } from './performance-bus.ts'
import type { Model3dErrorKey } from './renderers/model3d/Model3dVisualMount.tsx'
import { Model3dVisualMount } from './renderers/model3d/Model3dVisualMount.tsx'
import type { Model3dStage } from './renderers/model3d.ts'

/** How often the host snapshot is polled, ms. */
const POLL_MS = 1000
/** How often the panel re-reads the activation while it is open, ms. */
const PANEL_POLL_MS = 400
/** Pointer travel past which a press is a drag, not a click, px. */
const DRAG_LIMIT = 4
/** Panel box, px. */
const PANEL_WIDTH = 340
/** Magnification range for the stage box. */
const MAGNIFY_MIN = 1
const MAGNIFY_MAX = 4
/** Orbit limits, degrees; past 80 the camera looks at the model's crown. */
const PITCH_MIN = -80
const PITCH_MAX = 80
/** Playback-rate range for the panel's speed control. */
const SPEED_MIN = 0.1
const SPEED_MAX = 2
/** 同一个互动按钮两次之间的冷却，ms（防止动作还没收招就叠第二条）。 */
const INTERACTION_COOLDOWN_MS = 2000
/** 台词气泡停留时间，ms。 */
const BUBBLE_MS = 3000

/** The display block of the host snapshot. */
interface DisplayView {
  size: number
  right: number
  bottom: number
  visible: boolean
}

/** One catalog row of the host snapshot. */
interface ModelOptionView {
  id: string
  displayName: string
  clipCount: number
  clipsBinBytes: number
  importBytes: number
  revision: string
  stale: boolean
}

/** The host snapshot this stage renders. */
interface StateResponse {
  model: PetDefinition | null
  /** Content revision of the selected model's import (shown by the panel). */
  modelRevision: string
  /**
   * Why automatic re-import stopped for this model, when it did.
   *
   * Present means "your source change is no longer being picked up by itself" —
   * the one thing a user must not have to guess at.
   */
  importStall?: string
  models: ModelOptionView[]
  phase: PhaseState
  display: DisplayView
  problems: string[]
}

/** Offsets of the pet box from the viewport's right / bottom edges. */
interface Offsets {
  right: number
  bottom: number
}

/** What the panel reads off the activation, once per tick. */
interface PanelReadout {
  stage: Model3dStage
  detail: string
  clips: string[]
  /** The subset of `clips` the mixer actually holds (see the renderer contract). */
  registered: string[]
  /** 对照表带来的显示名/用途/慎用（按英文 id 索引）；没有对照表时为空。 */
  meta: Record<string, { displayName?: string; usage?: string; caution?: string } | undefined>
  /** Non-fatal clip problems, e.g. the reason a listed clip is not playable. */
  problems: string[]
  ready: boolean
  current: string | undefined
  paused: boolean
  speed: number
  revision: string
  swapping: boolean
  swapError: string | undefined
  debug: string | null
}

/** The two failure strings the renderer can report. */
function translate(key: Model3dErrorKey): string {
  return key === 'pet.model3d.vendor-missing'
    ? '3D 运行库缺失（lib/three-vendor.js 没打进包里）'
    : '3D 模型加载失败'
}

/** Keep the pet box on screen. */
function clampOffsets(next: Offsets, size: number): Offsets {
  const maxRight = Math.max(0, window.innerWidth - size)
  const maxBottom = Math.max(0, window.innerHeight - size)
  return {
    right: Math.min(Math.max(0, next.right), maxRight),
    bottom: Math.min(Math.max(0, next.bottom), maxBottom),
  }
}

/** Human-readable bytes. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** localStorage 里"上次见面是哪天"的键（`daily` 触发用）。 */
const DAILY_KEY = 'pet3d:lastSeenDay'

/** 本地日期 `YYYY-MM-DD`（用本地时区：用户说的"每天"是他自己的每天）。 */
function localDay(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }
const labelStyle: CSSProperties = { width: 34, flex: '0 0 auto', opacity: 0.75 }
const buttonStyle: CSSProperties = {
  font: '11px/1.4 system-ui, sans-serif', padding: '3px 7px', borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.08)', color: '#eee', cursor: 'pointer',
}
const disabledButtonStyle: CSSProperties = { ...buttonStyle, opacity: 0.4, cursor: 'not-allowed' }
const activeButtonStyle: CSSProperties = { ...buttonStyle, background: 'rgba(120,200,255,0.30)', borderColor: 'rgba(120,200,255,0.6)' }
const dividerStyle: CSSProperties = { border: 0, borderTop: '1px solid rgba(255,255,255,0.14)', margin: '8px 0' }
const noteStyle: CSSProperties = { opacity: 0.6, marginBottom: 4 }

/** The pet surface: poll, drag, mount the 3D activation, and the action panel. */
export function PetStage(): ReactElement | null {
  const [state, setState] = useState<StateResponse | null>(null)
  const [offsets, setOffsets] = useState<Offsets | null>(null)
  /** Live mirror of {@link offsets} for the window-level drag listeners. */
  const offsetsRef = useRef<Offsets | null>(null)
  /** True from the first drag frame until the host confirms the new position. */
  const draggingRef = useRef(false)
  const dragRef = useRef<{ x: number; y: number; base: Offsets } | null>(null)
  const orbitRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)

  const [inspectOpen, setInspectOpen] = useState(false)
  /**
   * 面板展开还是收成小方块。
   *
   * 点宠物先出现一个**小方块**（不挡视线），点它才展开整块面板；展开状态下"收起"
   * 回到小方块、"关闭"把它撤掉。155 条动作清单还额外折叠在面板里（见 clip-list）。
   */
  const [panelExpanded, setPanelExpanded] = useState(false)
  /**
   * 开发者模式（设置 → 3D 桌宠 → 开发者）。
   *
   * 关着的时候宠物身上**什么都不出现**：点它不弹小方块，只有左键拖动改位置、
   * 右键拖动改视角（右键旋转也是调试用的，但不会留下 UI，所以不额外藏）。
   * 打开后才是原来那套：小方块 → 动作面板（试播 / 相位 / 视角 / 编排 / 仪表）。
   */
  const devMode = useDevMode()
  /** 开发者模式被关掉时，正在开着的面板要自动收起来（不能留一块点不动的 UI）。 */
  useEffect(() => {
    if (devMode) return
    setInspectOpen(false)
    setPanelExpanded(false)
    // 红底是调试状态：开发者模式一关就还原，免得宠物一直挂着红底。
    setRedBackdrop(false)
  }, [devMode])
  /**
   * 悬浮菜单（点宠物正中间那只 🐻 出来的卡片）开没开。
   *
   * 和检查面板是两套 UI：菜单是**日常操作**（换外观、穿脱配饰），面板是**调试**。
   * 菜单在开发者模式关着时也照常存在 —— 它本来就属于日常。
   */
  const [menuOpen, setMenuOpen] = useState(false)
  /** 小熊按钮的悬停态（提示"这里能点"；不悬停时它很淡，不抢宠物）。 */
  const [menuHover, setMenuHover] = useState(false)
  /**
   * 指针是不是在宠物方框里。
   *
   * 小熊**只在指针进入方框时浮现**（用户要求）：平时它完全透明、且 `pointer-events: none`，
   * 不会挡住点击，也不会在宠物肚子上一直挂一个图标。
   *
   * 为什么用 window 上的 pointermove + 矩形包含判断，而不是 `onPointerEnter/Leave`：
   * 小熊自己就盖在方框中心，指针移到它身上时方框会收到 `pointerleave` —— 用它会把
   * 按钮在"要点的瞬间"隐藏掉。按坐标判断则不受子元素影响。
   * 菜单开着时强制显示（否则指针挪到卡片上，入口就消失了）。
   */
  const [pointerInside, setPointerInside] = useState(false)
  /** 宠物方框的 DOM 引用（悬停判断要读它的实时矩形）。 */
  const stageRef = useRef<HTMLDivElement | null>(null)
  /**
   * 每个模型的配饰表（`appearance.json`）。
   *
   * 按模型 id 缓存：菜单里「整套外观」那一排要显示别的模型叫什么，也要知道自己这套
   * 有哪些配饰。键不存在 = 还没读过（菜单显示"正在读取"，而不是误报"没有配饰"）。
   */
  const [appearances, setAppearances] = useState<Record<string, { appearance: Appearance | null; problems: string[] }>>({})
  /**
   * 当前模型的互动表（`interactions.json`）。
   *
   * 和编排一样是**模型目录里的数据**：改文件 2 秒生效，换模型立刻换一套按钮。
   * `interactionsKnown` 区分"还在读"与"这个模型没配"，这样菜单不会把前者误报成后者。
   */
  const [interactions, setInteractions] = useState<Interactions | null>(null)
  const [interactionsKnown, setInteractionsKnown] = useState(false)
  const [interactionProblems, setInteractionProblems] = useState<string[]>([])
  /** 好感度（按模型各存一份，本地持久化）。 */
  const [affinity, setAffinity] = useState(0)
  /** 刚说完的那句台词（`seq` 让同一句话再点一次也能重新计时）。 */
  const [bubble, setBubble] = useState<{ text: string; seq: number } | null>(null)
  /** 正在冷却的按钮 id（2 秒）。 */
  const [cooling, setCooling] = useState<string[]>([])
  /** 冷却表：id → 解除时间；`onInteract` 里同步读，等不了一次重渲染。 */
  const coolingRef = useRef<Map<string, number>>(new Map())
  /** 冷却定时器（卸载时要清掉，否则会对已卸载组件 setState）。 */
  const coolingTimersRef = useRef<Map<string, number>>(new Map())
  /** 已经脱下来的节点名（当前模型）。 */
  const [hiddenParts, setHiddenParts] = useState<string[]>([])
  /** 同一份状态的即时镜像：`onHandle` 里要同步读，等不了一次重渲染。 */
  const hiddenPartsRef = useRef<string[]>([])
  /** 句柄换代计数：模型热换/重建后要把配饰状态重新喂给渲染器。 */
  const [handleVersion, setHandleVersion] = useState(0)
  /**
   * 开发者调试：把画布底色涂成纯红（只在这个检查面板开着时生效）。
   *
   * 用途是"找漏"：模型上有破洞 / 缝隙 / 没缝上的地方，红色会直接透出来；贴合完整时
   * 红色只出现在轮廓之外。面板一关就恢复透明，免得宠物一直挂着红底。
   */
  const [redBackdrop, setRedBackdrop] = useState(false)
  /**
   * 用户排的编排（`choreography.json`）。
   *
   * 数据在模型目录里，客户端每 2 秒拉一次 —— 所以"改文件/在编排器里保存"都是 **≤2 秒生效**，
   * 不用刷新页面、不用重启应用。这一份同时给渲染器（真正按它演）和编排器（编辑它）。
   */
  const [choreography, setChoreography] = useState<Choreography>(DEFAULT_CHOREOGRAPHY)
  const [choreoProblems, setChoreoProblems] = useState<string[]>([])
  const [editorOpen, setEditorOpen] = useState(false)
  /** 实时状态一行（编排器标题栏用）：相位 / 当前动作 / 编排段 / 帧率。 */
  const [statusLine, setStatusLine] = useState('')
  /** 帧率与"上次采样的帧计数"，用来把仪表里的帧计数换算成 FPS。 */
  const [fps, setFps] = useState(0)
  const [frameSample, setFrameSample] = useState<{ frames: number; at: number } | null>(null)
  const [magnify, setMagnify] = useState(1)
  const [view, setViewState] = useState<{ yaw: number; pitch: number } | null>(null)
  const [stateOverride, setStateOverride] = useState<PhaseState | null>(null)
  const [panel, setPanel] = useState<PanelReadout | null>(null)
  const [loopPlay, setLoopPlay] = useState(true)
  /** 面板里"手动试播"这一路的回执（`戳一下` 已删除，但试播/保存编排/回常态还会写它）。 */
  const [lastPlay, setLastPlay] = useState<string | null>(null)
  /** What the panel's 重载 button is doing / what went wrong, if anything. */
  const [reloadNote, setReloadNote] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const handleRef = useRef<import('./renderers/model3d.ts').Model3dHandle | null>(null)
  /** 上一次看到的宿主相位（用来判断"变成了什么"，首帧不算变化）。 */
  const lastPhaseRef = useRef<PhaseState | null>(null)
  /** 同一个触发下有多条演出时的轮换游标。 */
  const rotationRef = useRef<Map<PerformanceTrigger, number>>(new Map())

  /**
   * Keep the served definition's identity stable across polls.
   *
   * The host re-parses its snapshot every second, so `state.model` is a new
   * object each time even when nothing about it changed. The activation keys on
   * CONTENT, so this is not load-bearing for correctness — but without it every
   * poll churns this whole subtree once a second for nothing.
   */
  const modelSignature = state?.model == null ? '' : `${state.model.id}|${JSON.stringify(state.model.model3d)}`
  const model = useMemo(() => state?.model ?? null, [modelSignature])

  /* -------------------------------------------------------------- 配饰表 */

  /** 已安装模型的 id 列表签名：模型增删才需要重新拉配饰表。 */
  const modelsSignature = (state?.models ?? []).map(entry => entry.id).join('|')

  /**
   * 拉每个模型的 `appearance.json`（模型目录里的配饰表）。
   *
   * 走既有的资源路由 `/pet3d/<id>/<文件>`，所以**改文件 2 秒生效**，不用刷新、不用重启。
   * 内容没变就不 setState —— 每 2 秒喂一个新对象会让菜单每次重排一遍（编排那边同款坑）。
   */
  const appearanceSigRef = useRef('')
  useEffect(() => {
    const ids = (state?.models ?? []).map(entry => entry.id)
    if (ids.length === 0) return undefined
    let live = true
    const load = async (): Promise<void> => {
      const rows = await Promise.all(ids.map(async (id): Promise<readonly [string, string | null]> => {
        try {
          const response = await fetch(`/pet3d/${encodeURIComponent(id)}/appearance.json`, { cache: 'no-store' })
          if (!response.ok) return [id, null] as const
          return [id, await response.text()] as const
        } catch {
          // 单文件拿不到（模型正在重导入、宿主在重启）不该让整张菜单消失。
          return [id, null] as const
        }
      }))
      const signature = JSON.stringify(rows)
      if (signature === appearanceSigRef.current) return
      appearanceSigRef.current = signature
      const next: Record<string, { appearance: Appearance | null; problems: string[] }> = {}
      for (const [id, raw] of rows) {
        if (raw === null) {
          next[id] = { appearance: null, problems: [] }
          continue
        }
        try {
          const parsed = parseAppearance(JSON.parse(raw), `${id}/appearance.json`)
          next[id] = { appearance: parsed.appearance, problems: parsed.problems }
        } catch (error) {
          next[id] = {
            appearance: null,
            problems: [`${id}/appearance.json: 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`],
          }
        }
      }
      if (live) setAppearances(next)
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 2000)
    return () => { live = false; window.clearInterval(timer) }
  }, [modelsSignature])

  /** 当前模型的配饰表；`undefined` = 还没读到（菜单显示"正在读取"，不误报"没有配饰"）。 */
  const appearanceRoom = model === null ? undefined : appearances[model.id]
  const appearance = appearanceRoom?.appearance ?? null

  /** 好感度上限：来自互动表，没配就按缺省。 */
  const affinityMax = interactions?.affinity.max ?? DEFAULT_AFFINITY_MAX

  /**
   * 拉当前模型的互动表（`interactions.json`）。
   *
   * 没有这个文件 = "这个模型没配互动"，不是错误；文件存在但写坏 = 照常报问题
   * （菜单里折叠显示），两者都不该让整个菜单空白。
   */
  useEffect(() => {
    const id = model?.id
    if (id === undefined) {
      setInteractions(null)
      setInteractionsKnown(false)
      setInteractionProblems([])
      return undefined
    }
    let live = true
    let lastRaw: string | null = null
    setInteractions(null)
    setInteractionsKnown(false)
    setInteractionProblems([])
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/pet3d/${encodeURIComponent(id)}/interactions.json`, { cache: 'no-store' })
        if (!live) return
        if (!response.ok) {
          if (lastRaw !== '') { lastRaw = ''; setInteractions(null); setInteractionProblems([]) }
          setInteractionsKnown(true)
          return
        }
        const raw = await response.text()
        if (!live) return
        if (raw === lastRaw) { setInteractionsKnown(true); return }
        lastRaw = raw
        try {
          const parsed = parseInteractions(JSON.parse(raw), `${id}/interactions.json`)
          setInteractions(parsed.interactions)
          setInteractionProblems(parsed.problems)
        } catch (error) {
          setInteractions(null)
          setInteractionProblems([`${id}/interactions.json: 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`])
        }
        setInteractionsKnown(true)
      } catch {
        // 网络抖动 / 宿主重启：保持现状，2 秒后重试。
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 2000)
    return () => { live = false; window.clearInterval(timer) }
  }, [model?.id])

  // 换模型：好感度跟着换（每个模型各记一份）。
  useEffect(() => {
    if (model === null) { setAffinity(0); return }
    setAffinity(loadAffinity(model.id))
  }, [model?.id])

  // 互动表到了之后把存下来的好感度夹到这张表的范围内（表可以改 max）。
  useEffect(() => {
    setAffinity(previous => clampAffinity(previous, interactions?.affinity.max ?? DEFAULT_AFFINITY_MAX))
  }, [interactions])

  // 台词气泡 3 秒后自己消失。
  useEffect(() => {
    if (bubble === null) return undefined
    const timer = window.setTimeout(() => setBubble(null), BUBBLE_MS)
    return () => window.clearTimeout(timer)
  }, [bubble])

  // 卸载时清掉冷却定时器。
  useEffect(() => () => {
    for (const timer of coolingTimersRef.current.values()) window.clearTimeout(timer)
    coolingTimersRef.current.clear()
    coolingRef.current.clear()
  }, [])

  /**
   * 当前该脱哪些部件：本地存过的优先，没存过就用表里的默认值。
   *
   * 每次配饰表更新都重算一遍（表可能刚加上/删掉一件），并用 {@link sanitizeHidden}
   * 收拢到表里声明过的节点 —— 存下来的旧节点名不会让"脱了几件"的计数对不上。
   */
  useEffect(() => {
    if (model === null) {
      setHiddenParts([])
      return
    }
    const room = appearances[model.id]
    const stored = loadAppearanceHidden(model.id)
    const base = stored === undefined ? defaultHidden(room?.appearance ?? null) : stored
    setHiddenParts(sanitizeHidden(room?.appearance ?? null, base))
  }, [model?.id, appearances])

  /** 改配饰状态：立刻作用到渲染器，并记住这个模型的选择。 */
  const applyParts = useCallback((next: readonly string[]): void => {
    const ordered = sanitizeHidden(appearance, next)
    setHiddenParts(ordered)
    if (model !== null) saveAppearanceHidden(model.id, ordered)
  }, [appearance, model?.id])

  /** 穿/脱一件配饰（只动这一件，不碰款式组）。 */
  const togglePiece = useCallback((piece: AppearancePiece, next: boolean): void => {
    const set = new Set(hiddenParts)
    for (const name of piece.nodes) {
      if (next) set.add(name)
      else set.delete(name)
    }
    applyParts([...set])
  }, [applyParts, hiddenParts])

  /** 全部穿上 / 全部脱下（只碰 pieces，服装款式组不动）。 */
  const setAllPieces = useCallback((hide: boolean): void => {
    if (appearance === null) return
    const set = new Set(hiddenParts)
    for (const piece of appearance.pieces) {
      for (const name of piece.nodes) {
        if (hide) set.add(name)
        else set.delete(name)
      }
    }
    applyParts([...set])
  }, [applyParts, appearance, hiddenParts])

  /** 换一款（同组互斥：选中款显示，其余款隐藏；别的组和配饰不动）。 */
  const selectGroup = useCallback((group: AppearanceGroup, optionId: string): void => {
    if (appearance === null) return
    applyParts(applyGroupChoice(appearance, group, optionId, hiddenParts))
  }, [applyParts, appearance, hiddenParts])

  const applyOffsets = useCallback((next: Offsets): void => {
    offsetsRef.current = next
    setOffsets(next)
  }, [])

  // The host owns the phase, the selected model and the persisted display.
  useEffect(() => {
    let alive = true
    let timer = 0
    /**
     * 连续失败次数。宿主接口不可用（插件被总开关关掉、或宿主正好在重启）时，
     * 宠物必须**从画面上撤下来** —— 否则"关掉插件"之后它还会站在那儿演一个
     * 已经没人驱动的画面，看起来像开关坏了。三次约 3 秒，避免一次抖动就闪没。
     */
    let failures = 0
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch('/api/pet3d/state', { headers: { accept: 'application/json' } })
        // 非 2xx 也走失败分支：插件被停用时这条路会直接 404。
        if (!res.ok) throw new Error(`host-unavailable (${res.status})`)
        if (alive) {
          const data = await res.json() as StateResponse
          failures = 0
          setState(data)
          if (!draggingRef.current) {
            applyOffsets({ right: data.display.right, bottom: data.display.bottom })
          }
        }
      } catch {
        // Host not up yet, reloading, or the plugin was switched off: retry, and
        // take the pet off screen when it keeps failing.
        failures += 1
        if (failures >= 3 && alive) setState(null)
      }
      if (alive) timer = window.setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [applyOffsets])

  const commit = useCallback(async (next: Offsets): Promise<void> => {
    try {
      const res = await fetch('/api/pet3d/display', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (res.ok) {
        const saved = await res.json() as DisplayView
        applyOffsets({ right: saved.right, bottom: saved.bottom })
      }
    } catch {
      // Keep the dragged position on screen; the next poll restores the server's value.
    } finally {
      draggingRef.current = false
    }
  }, [applyOffsets])

  // The panel's readouts, POLLED rather than read once when the handle arrives:
  // the handle exists as soon as the activation mounts, but the clip list only
  // fills once `clips.json` has parsed and it only arms once `clips.bin` has
  // been assembled — reading at mount time would show an empty list forever.
  useEffect(() => {
    if (!inspectOpen) {
      setPanel(null)
      return undefined
    }
    const read = (): void => {
      const handle = handleRef.current
      if (handle === null) {
        setPanel(null)
        return
      }
      const clips = handle.clipNames()
      setPanel({
        stage: handle.stage(),
        detail: handle.stageDetail(),
        clips,
        registered: handle.registeredClipNames(),
        meta: Object.fromEntries(clips.map(name => [name, handle.clipMeta(name)])),
        problems: handle.clipsProblems(),
        ready: handle.clipsReady(),
        current: handle.currentClip(),
        paused: handle.paused(),
        speed: handle.speed(),
        revision: handle.loadedRevision(),
        swapping: handle.swapping(),
        swapError: handle.swapError(),
        debug: handle.debug(),
      })
    }
    read()
    const timer = window.setInterval(read, PANEL_POLL_MS)
    return () => window.clearInterval(timer)
  }, [inspectOpen])

  // 拉编排配置：模型目录里的 choreography.json（静态资源路由），2 秒一次 ⇒ 改文件/保存后自动生效。
  const choreoJsonRef = useRef('')
  useEffect(() => {
    if (model === null) return undefined
    let live = true
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/pet3d/${encodeURIComponent(model.id)}/choreography.json`, { cache: 'no-store' })
        if (!live) return
        if (!response.ok) {
          // 没有文件就回到内置缺省，但只在**内容变了**的时候才动状态机。
          if (choreoJsonRef.current !== '') { choreoJsonRef.current = ''; setChoreography(DEFAULT_CHOREOGRAPHY); setChoreoProblems([]) }
          return
        }
        const raw = await response.text()
        if (!live) return
        // 关键：内容没变就**不要**重新 setState —— 每 2 秒喂一个新对象会让渲染器
        // 每次都"按新配置重来一遍"，一拍永远演不完（踩过这个坑）。
        if (raw === choreoJsonRef.current) return
        const parsed = parseChoreography(JSON.parse(raw))
        if (!live) return
        choreoJsonRef.current = raw
        setChoreography(parsed.config)
        setChoreoProblems(parsed.problems)
      } catch {
        // 文件不在 / 网络抖动：保持现状，不打扰用户。
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 2000)
    return () => { live = false; window.clearInterval(timer) }
  }, [model?.id])

  // 把配置喂给渲染器（它按配置演；换配置立刻按新配置对齐一次）。
  useEffect(() => {
    handleRef.current?.setChoreography?.(choreography)
  }, [choreography, panel?.clips.length])

  // 配饰穿脱 → 渲染器。句柄换代（换模型/热换）也要重放一次：新场景图默认全可见。
  useEffect(() => {
    hiddenPartsRef.current = hiddenParts
    handleRef.current?.setHiddenNodes(hiddenParts)
  }, [hiddenParts, handleVersion])

  // 「红底」调试开关 → 渲染器的 clear color。
  // 面板关掉也**保持**（用户要关掉面板去截图）；只有关掉开发者模式才自动还原。
  useEffect(() => {
    handleRef.current?.setBackdrop(redBackdrop ? '#ff0000' : null)
  }, [redBackdrop, handleVersion])

  /* -------------------------------------------------------------- 演出触发 */

  /**
   * 开演一套演出。
   *
   * 同一个触发下有多条时**轮换**（而不是永远第一条）—— 用户排两条 `done` 就是
   * 想让庆祝有变化，每次随机反而看不出"是不是按我排的在演"，轮换是可预期的。
   * @param trigger - 触发时机。
   * @returns 是否真的开演。
   */
  const firePerformance = useCallback((trigger: PerformanceTrigger): boolean => {
    const matches = Object.entries(choreography.performances ?? {})
      .filter(([, performance]) => (performance.trigger ?? 'manual') === trigger)
    if (matches.length === 0) return false
    const handle = handleRef.current
    if (handle === null) return false
    const cursor = rotationRef.current.get(trigger) ?? 0
    const picked = matches[cursor % matches.length] ?? matches[0]
    if (picked === undefined) return false
    rotationRef.current.set(trigger, cursor + 1)
    const [id, performance] = picked
    const ok = handle.playPerformance({ id, steps: performance.steps })
    if (ok) setLastPlay(`演出：${performance.name ?? id}`)
    return ok
  }, [choreography])

  // 相位变化触发的演出：完成 / 出错 / 开始干活。
  useEffect(() => {
    if (state === null) return
    const phase = state.phase
    const previous = lastPhaseRef.current
    lastPhaseRef.current = phase
    if (previous === null || phase === previous) return
    if (phase === 'done') firePerformance('done')
    else if (phase === 'failed') firePerformance('failed')
    // "开始干活"= 从闲置或思考切到跑；从走/跑过来的不算（那是同一段工作的延续）。
    else if (phase === 'run' && (previous === 'idle' || previous === 'think')) firePerformance('run')
  }, [state?.phase, firePerformance])

  // 闲置够久自己演一段：每个"闲置窗口"最多演一次（相位一变窗口就结束了）。
  useEffect(() => {
    if (state?.phase !== 'idle') return undefined
    const startedAt = Date.now()
    let fired = false
    const timer = window.setInterval(() => {
      if (fired) return
      const idle = Object.entries(choreography.performances ?? {})
        .filter(([, performance]) => (performance.trigger ?? 'manual') === 'idle')
      if (idle.length === 0) return
      const waited = (Date.now() - startedAt) / 1000
      // 到点了才演；同一条只在这个窗口里演一次。
      if (!idle.some(([, performance]) => waited >= (performance.afterSeconds ?? 180))) return
      fired = true
      firePerformance('idle')
    }, 5000)
    return () => window.clearInterval(timer)
  }, [state?.phase, choreography, firePerformance])

  // 每天第一次见面：按浏览器记日期（同一台机器的另一个浏览器不算"见过"）。
  useEffect(() => {
    if (state === null) return undefined
    const hasDaily = Object.values(choreography.performances ?? {})
      .some((performance) => (performance.trigger ?? 'manual') === 'daily')
    if (!hasDaily) return undefined
    const today = localDay()
    let last: string | null = null
    try {
      last = window.localStorage.getItem(DAILY_KEY)
    } catch {
      last = null
    }
    if (last === today) return undefined
    try {
      window.localStorage.setItem(DAILY_KEY, today)
    } catch {
      // 无痕模式：记不住就本次照演一次。
    }
    // 等模型加载/摆好姿势再演，否则第一句话是"正在加载"。
    const timer = window.setTimeout(() => { firePerformance('daily') }, 2500)
    return () => window.clearTimeout(timer)
  }, [state !== null, choreography, firePerformance])

  // 设置页（演出编排器）的试播 / 停止：走模块级总线，落到同一个渲染器实例。
  useEffect(() => subscribePerformanceRequests((request: PerformanceRequest | null) => {
    const handle = handleRef.current
    if (request === null) {
      handle?.stopPerformance?.()
      setLastPlay('演出：已停下')
      return
    }
    const ok = handle?.playPerformance({ id: request.id, steps: request.steps }) ?? false
    setLastPlay(`演出：${request.name ?? request.id}${ok ? '（试播）' : ' ✗ 动作数据还没就绪'}`)
  }), [])

  // 帧率：面板轮询时就顺手算一下（渲染器仪表里的 fr 是帧计数），给编排器与面板显示。
  useEffect(() => {
    if (panel === null || panel.debug === null) return
    const match = /(?:^| )fr=(\d+)/u.exec(panel.debug)
    if (match === null) return
    const frames = Number(match[1])
    const at = Date.now()
    setFrameSample((previous) => {
      if (previous === null || frames < previous.frames) return { frames, at }
      const elapsed = at - previous.at
      if (elapsed < 800) return previous
      const fps = Math.round(((frames - previous.frames) * 1000) / elapsed)
      setFps(fps)
      return { frames, at }
    })
  }, [panel?.debug])

  useEffect(() => {
    if (panel === null) return
    const seg = /seq=([^ ]+)/u.exec(panel.debug ?? '')?.[1] ?? '-'
    setStatusLine(`${panel.current === undefined ? '（无动作）' : (panel.meta?.[panel.current]?.displayName ?? panel.current)}｜${seg}｜${fps} FPS`)
  }, [panel?.debug, fps])

  // Apply the panel's camera whenever it changes, and once the activation exists
  // (the handle arrives after the first render, so `panel` gates the retry).
  useEffect(() => {
    if (view === null) return
    handleRef.current?.setView?.({ yaw: view.yaw, pitch: view.pitch })
  }, [view, panel?.clips.length])

  // Closing the panel puts the pet back the way the model folder describes it.
  useEffect(() => {
    if (inspectOpen) return
    setMagnify(1)
    setStateOverride(null)
    setLastPlay(null)
    const base = model?.model3d.yaw ?? 0
    setViewState({ yaw: base, pitch: 0 })
    handleRef.current?.setView?.({ yaw: base, pitch: 0 })
    handleRef.current?.clearManual()
    handleRef.current?.setPaused(false)
  }, [inspectOpen, model])

  // Esc 先收菜单，再收检查面板；不用满屏幕找关闭按钮。
  useEffect(() => {
    if (!menuOpen && !inspectOpen) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (menuOpen) setMenuOpen(false)
      else setInspectOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen, inspectOpen])

  // 宠物被收起/被撤下时，贴在上面的菜单也要跟着消失（否则会留一张没有主人的卡片）。
  useEffect(() => {
    if (state === null || state.model === null || !state.display.visible) setMenuOpen(false)
  }, [state?.display.visible, state?.model])

  // 指针是否在宠物方框里 —— 决定小熊浮不浮现（见 pointerInside 的说明）。
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const rect = stageRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom
      setPointerInside(current => current === inside ? current : inside)
    }
    const onLeave = (): void => setPointerInside(false)
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerleave', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('blur', onLeave)
    }
  }, [])

  const onHandle = useCallback((handle: import('./renderers/model3d.ts').Model3dHandle | null): void => {
    handleRef.current = handle
    // 新句柄（首次装载 / 换模型）立刻接上当前的配饰状态，免得先露一秒"全套"再跳变。
    if (handle !== null) handle.setHiddenNodes(hiddenPartsRef.current)
    setHandleVersion(version => version + 1)
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const size = (state?.display.size ?? 0) * magnify
    // Right-drag orbits the camera, Blender-style; left-drag still moves the pet.
    if (event.button === 2) {
      event.preventDefault()
      const base = view ?? { yaw: model?.model3d.yaw ?? 0, pitch: 0 }
      orbitRef.current = { x: event.clientX, y: event.clientY, yaw: base.yaw, pitch: base.pitch }
      const onMove = (moveEvent: PointerEvent): void => {
        const orbit = orbitRef.current
        if (orbit === null) return
        const yaw = orbit.yaw + (moveEvent.clientX - orbit.x) * 0.5
        const pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, orbit.pitch - (moveEvent.clientY - orbit.y) * 0.4))
        setViewState({ yaw, pitch })
      }
      const onUp = (): void => {
        orbitRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      return
    }
    if (event.button !== 0 || offsetsRef.current === null) return
    dragRef.current = { x: event.clientX, y: event.clientY, base: offsetsRef.current }
    draggingRef.current = true
    let moved = false
    const onMove = (moveEvent: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null) return
      const dx = moveEvent.clientX - drag.x
      const dy = moveEvent.clientY - drag.y
      if (!moved && Math.abs(dx) <= DRAG_LIMIT && Math.abs(dy) <= DRAG_LIMIT) return
      moved = true
      applyOffsets(clampOffsets({ right: drag.base.right - dx, bottom: drag.base.bottom - dy }, size))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dragRef.current = null
      if (!moved) {
        // A press that never moved is a click: the SMALL SQUARE appears so the
        // full panel is one more click away (it would cover the pet otherwise).
        // A click only ever OPENS here — closing is the panel's own button or Esc —
        // so clicking the pet while inspecting cannot shut the box you are working in.
        // 开发者模式关着时，点宠物什么都不做（面板是调试 UI，不属于日常操作）；
        // 这里读模块函数而不是闭包里的 devMode，避免 useCallback 缓存住旧值。
        // （以前这里还会「戳一下」随机演一段，该功能已整套删除，将来从零重写。）
        draggingRef.current = false
        if (devModeEnabled()) {
          setInspectOpen(true)
          setPanelExpanded(false)
        }
        return
      }
      const settled = offsetsRef.current
      if (settled === null) draggingRef.current = false
      else void commit(settled)
    }
    // Window-level listeners instead of pointer capture: capturing on this box
    // would retarget the pointerup away from anything inside it.
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [applyOffsets, commit, magnify, model, state?.display.size, view])

  if (state === null || offsets === null) return null
  const { display } = state
  if (!display.visible || model === null) return null

  const box = Math.round(display.size * magnify)
  const phaseState = stateOverride ?? state.phase
  const panelLeft = Math.max(8, window.innerWidth - offsets.right - box - PANEL_WIDTH - 12)
  /** 宠物方框在视口里的矩形（`fixed` 坐标系）—— 小熊按钮与悬浮菜单都按它定位。 */
  const petLeft = window.innerWidth - offsets.right - box
  const petTop = window.innerHeight - offsets.bottom - box
  const menuAnchor: PetMenuAnchor = { left: petLeft, top: petTop, size: box }
  /** 「整套外观」候选：已安装的模型；名字优先取该模型 `appearance.json` 的 title。 */
  const menuModels: PetMenuModel[] = state.models.map(entry => ({
    id: entry.id,
    label: appearances[entry.id]?.appearance?.title ?? entry.id,
  }))
  /** 真正点得动的动作：混音器里有它，且名称对照表没标"慎用/勿用"。 */
  const usableClips = (panel?.registered ?? []).filter(name => (panel?.meta?.[name]?.caution ?? '') === '')

  /**
   * Play one clip now and remember what was asked for.
   *
   * A listed clip with no bone tracks (an effect take) is refused with its own
   * reason: "动作数据还没就绪" would be a lie once the payload has landed, and the
   * one thing the user needs to know is that this particular take has nothing to
   * play.
   */
  const play = (name: string): void => {
    const playable = panel?.registered.includes(name) ?? false
    const label = panel?.meta?.[name]?.displayName ?? name
    const reason = panel?.ready !== true ? ' ✗ 动作数据还没就绪' : ' ✗ 这条没有骨骼轨道（特效/材质动画），播不了'
    const ok = playable && (handleRef.current?.playNamed?.(name, loopPlay) ?? false)
    setLastPlay(`${label}${label === name ? '' : `（${name}）`}${loopPlay ? '（循环）' : '（播一次）'}${ok ? '' : reason}`)
  }

  /**
   * 点一个互动按钮。
   *
   * 顺序：冷却 → 播一次动作（播不了就直说，不装作成功）→ 加好感度 → 台词气泡。
   * 好感度只在动作真的播出来之后才加：点了没反应却涨进度，会让"功能坏了"看起来像正常。
   */
  const interact = (action: InteractionAction): void => {
    const now = Date.now()
    if (now < (coolingRef.current.get(action.id) ?? 0)) return
    coolingRef.current.set(action.id, now + INTERACTION_COOLDOWN_MS)
    setCooling([...coolingRef.current.keys()])
    const timer = window.setTimeout(() => {
      coolingRef.current.delete(action.id)
      coolingTimersRef.current.delete(action.id)
      setCooling([...coolingRef.current.keys()])
    }, INTERACTION_COOLDOWN_MS)
    coolingTimersRef.current.set(action.id, timer)

    // 单条试播：放完自己回到当前相位的循环段（见渲染器 playNamed(false)）。
    const played = handleRef.current?.playNamed?.(action.clip, false) ?? false
    if (!played) {
      setBubble({ text: `动作「${action.clip}」还播不了（数据没就绪或名字不对）`, seq: Date.now() })
      return
    }
    setLastPlay(`互动：${action.label}`)
    const max = interactions?.affinity.max ?? DEFAULT_AFFINITY_MAX
    const next = clampAffinity(affinity + action.affinity, max)
    setAffinity(next)
    if (model !== null) saveAffinity(model.id, next)
    // 满了就换一句"关系到位"的台词，而不是一直重复按钮上的那句。
    const full = next >= max ? affinityLine(interactions?.affinity ?? { max, lines: [] }, next) : null
    const line = full ?? action.line
    if (line !== '') setBubble({ text: line, seq: Date.now() })
  }

  /** Switch the selected model and let the next poll rebuild the activation. */
  const selectModel = async (id: string): Promise<void> => {
    try {
      await fetch('/api/pet3d/set-pet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: id }),
      })
    } catch {
      // The next poll shows whatever the host still has selected.
    }
  }

  /**
   * Ask the host to re-import AND hot-swap.
   *
   * The import itself is a subprocess (minutes for a real FBX) and its outcome
   * is reported either way: a fix that failed to take must never look like a
   * model that silently stayed broken.
   *
   * A conflict (the folder's artifacts were written by a different importer
   * script) comes back as a question, not as an overwrite: the user sees both
   * script paths and is asked before anything is rewritten.
   */
  const reload = async (modelId: string): Promise<void> => {
    if (reloading) return
    setReloading(true)
    setReloadNote('重载中：正在重新导入…')
    const post = (force: boolean): Promise<Response> => fetch('/api/pet3d/reimport', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(force ? { modelId, force: true } : { modelId }),
    })
    try {
      let res = await post(false)
      let data = await res.json() as { revision?: string; durationMs?: number; error?: string }
      if (!res.ok && typeof data.error === 'string' && data.error.includes('需要确认')) {
        const proceed = window.confirm(`${data.error}\n\n仍然要用当前配置的导入器覆盖这份产物吗？`)
        if (!proceed) {
          setReloadNote(`已取消：${data.error}`)
          return
        }
        setReloadNote('已确认，正在重新导入…')
        res = await post(true)
        data = await res.json() as { revision?: string; durationMs?: number; error?: string }
      }
      if (!res.ok) {
        setReloadNote(`重载失败：${data.error ?? `HTTP ${res.status}`}`)
        return
      }
      const seconds = typeof data.durationMs === 'number' ? (data.durationMs / 1000).toFixed(1) : '?'
      setReloadNote(`重导入完成（${seconds}s，revision ${String(data.revision ?? '').slice(0, 8)}），正在热换…`)
    } catch (error) {
      setReloadNote(`重载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setReloading(false)
    }
  }

  const style: CSSProperties = {
    position: 'fixed',
    right: offsets.right,
    bottom: offsets.bottom,
    width: box,
    height: box,
    zIndex: 40,
    userSelect: 'none',
    touchAction: 'none',
    cursor: inspectOpen ? 'crosshair' : 'grab',
  }

  return (
    <>
      <div
        ref={stageRef}
        style={style}
        data-pet3d-stage={model.id}
        data-pet3d-hidden={hiddenParts.join(',')}
        data-pet3d-hover={pointerInside ? '1' : '0'}
        onPointerDown={onPointerDown}
        onContextMenu={(e) => { if (inspectOpen) e.preventDefault() }}
        title={inspectOpen ? '右键拖动旋转视角 · 左键拖动移动位置' : (devMode ? '点一下打开检查面板 · 拖动可移动位置' : '拖动可移动位置')}
      >
        <Model3dVisualMount
          definition={model}
          phase={phaseState}
          t={translate}
          onHandle={onHandle}
        />
      </div>

      {/*
        宠物正中间的小熊：**悬浮菜单的唯一入口**。
        为什么放在正中心：宠物是个 500px 的透明方框，模型只占中间一块，角落里的"点"
        落到空处会让人怀疑没点中；中心一定落在躯干上。
        它是独立元素、不在舞台方框里 —— 所以点它不会触发拖动/检查面板，两套交互不打架。
        **只有指针进入方框时才浮现**（平时 opacity 0 + pointer-events: none）：宠物肚子上
        不该一直挂着一颗图标；菜单开着时强制显示，否则指针挪到卡片上入口就没了。
      */}
      <button
        type="button"
        data-pet3d-menu-toggle=""
        data-pet3d-menu-toggle-visible={(pointerInside || menuOpen) ? '1' : '0'}
        aria-expanded={menuOpen}
        aria-label={menuOpen ? '收起宠物菜单' : '打开宠物菜单'}
        title={menuOpen ? '收起菜单（Esc）' : '打开菜单：换外观 · 配饰穿脱'}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseEnter={() => setMenuHover(true)}
        onMouseLeave={() => setMenuHover(false)}
        onClick={() => setMenuOpen(open => !open)}
        style={{
          position: 'fixed',
          left: petLeft + Math.round(box / 2) - 15,
          top: petTop + Math.round(box / 2) - 15,
          width: 30, height: 30, padding: 0, zIndex: 41,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          font: '15px/1 system-ui, sans-serif', color: '#fff',
          borderRadius: '50%', cursor: 'pointer', userSelect: 'none',
          background: menuOpen ? 'rgba(120,200,255,0.34)' : 'rgba(18,20,26,0.55)',
          border: `1px solid ${menuOpen || menuHover ? 'rgba(140,210,255,0.85)' : 'rgba(255,255,255,0.32)'}`,
          boxShadow: '0 3px 10px rgba(0,0,0,0.45)',
          opacity: (pointerInside || menuOpen) ? (menuOpen || menuHover ? 1 : 0.72) : 0,
          // 不可见时也不许挡住底下的宠物（否则"没浮现"的区域仍然会吃掉一次点击）。
          pointerEvents: (pointerInside || menuOpen) ? 'auto' : 'none',
          transform: menuHover && !menuOpen ? 'scale(1.1)' : 'scale(1)',
          transition: 'opacity .16s ease, transform .16s ease, border-color .16s ease, background .16s ease',
        }}
      >
        <span aria-hidden="true">🐻</span>
      </button>

      {menuOpen && (
        <PetMenu
          anchor={menuAnchor}
          modelId={model.id}
          title={appearance?.title ?? model.id}
          models={menuModels}
          appearance={appearance}
          appearanceKnown={appearanceRoom !== undefined}
          appearanceProblems={appearanceRoom?.problems ?? []}
          hidden={hiddenParts}
          onTogglePiece={togglePiece}
          onSetAll={setAllPieces}
          onSelectGroup={selectGroup}
          onSelectModel={(id) => { void selectModel(id) }}
          interactions={interactions}
          interactionsKnown={interactionsKnown}
          interactionsProblems={interactionProblems}
          affinity={affinity}
          affinityMax={affinityMax}
          bubble={bubble?.text ?? null}
          cooling={cooling}
          onInteract={interact}
          onClose={() => setMenuOpen(false)}
        />
      )}

      {editorOpen && (
        <ChoreographyEditor
          modelId={model.id}
          clips={(panel?.clips ?? []).map(name => ({
            name,
            label: panel?.meta?.[name]?.displayName ?? name,
            caution: panel?.meta?.[name]?.caution,
          }))}
          config={choreography}
          status={statusLine}
          onSaved={(next, note) => { setChoreography(next); setLastPlay(`编排：${note}`) }}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {inspectOpen && panelExpanded && (
        <div
          data-pet3d-panel=""
          data-pet3d-panel-open="1"
          style={{
            position: 'fixed', left: panelLeft, bottom: offsets.bottom, width: PANEL_WIDTH,
            maxHeight: '78vh', overflowY: 'auto', zIndex: 41, padding: '10px 12px',
            font: '12px/1.5 system-ui, sans-serif', color: '#eee',
            background: 'rgba(18,20,26,0.94)', border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ flex: 1 }}>动作面板 · {model.id}</strong>
            <button
              type="button"
              data-pet3d-panel-collapse=""
              style={buttonStyle}
              onClick={() => setPanelExpanded(false)}
              title="收成小方块（面板内容还在，点方块再看）"
            >
              收起
            </button>
            <button
              type="button"
              data-pet3d-choreo-open=""
              style={buttonStyle}
              onClick={() => setEditorOpen(true)}
              title="打开编排器：自己排什么时候做什么动作（改完自动生效，不用刷新）"
            >
              编排
            </button>
            <button
              type="button"
              style={reloading ? disabledButtonStyle : buttonStyle}
              disabled={reloading}
              onClick={() => { void reload(model.id) }}
              title="重新导入这个模型的源文件并就地热换（不需要重启，也不需要刷新页面）"
            >
              {reloading ? '重载中…' : '重载'}
            </button>
            <button
              type="button"
              data-pet3d-backdrop=""
              data-pet3d-backdrop-on={redBackdrop ? '1' : '0'}
              style={redBackdrop ? activeButtonStyle : buttonStyle}
              onClick={() => setRedBackdrop(on => !on)}
              title="红底：把背景涂成纯红。模型上有破洞/缝隙/没缝上的地方会直接透红；再点一次恢复透明。"
            >
              红底
            </button>
            <button type="button" style={{ ...buttonStyle, marginLeft: 6 }} onClick={() => setInspectOpen(false)}>关闭</button>
          </div>

          {state.models.length > 1 && (
            <div style={rowStyle}>
              <span style={labelStyle}>模型</span>
              <select
                value={model.id}
                onChange={(e) => { void selectModel(e.target.value) }}
                style={{ flex: 1, font: '11px/1.4 system-ui, sans-serif' }}
              >
                {state.models.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.displayName}（{option.clipCount} 动作{option.stale ? ' · 源文件已变' : ''}）
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <span style={{ opacity: 0.75 }}>载入</span>
            <b data-pet3d-stage-name={panel?.stage ?? 'boot'}>{panel?.stage ?? 'boot'}</b>
            <span data-pet3d-stage-detail="" style={{ opacity: 0.7 }}>
              {panel === null ? '' : `· ${panel.detail}`}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'baseline' }}>
            <span style={{ opacity: 0.75 }}>热换</span>
            <span data-pet3d-swap="" style={{ opacity: 0.8 }}>
              已装载 {panel?.revision === undefined || panel.revision === '' ? '-' : panel.revision.slice(0, 8)}
              {' · 宿主 '}
              {(state.modelRevision === '' ? '-' : state.modelRevision.slice(0, 8))}
              {panel?.swapping === true ? ' · 热换中…' : ''}
            </span>
          </div>
          {panel?.swapError !== undefined && (
            <div data-pet3d-swap-error="" style={{ color: '#f88', marginBottom: 6 }}>热换失败：{panel.swapError}</div>
          )}
          {state.importStall !== undefined && (
            <div data-pet3d-import-stall="" style={{ color: '#fd8', marginBottom: 6 }}>
              自动重导入已停止：{state.importStall}
            </div>
          )}
          {reloadNote !== null && (
            <div data-pet3d-reload-note="" style={{ opacity: 0.85, marginBottom: 6 }}>{reloadNote}</div>
          )}

          <div style={rowStyle}>
            <span style={labelStyle}>放大</span>
            <input
              type="range" min={MAGNIFY_MIN} max={MAGNIFY_MAX} step={0.25} value={magnify}
              onChange={(e) => setMagnify(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ width: 38, textAlign: 'right' }}>{magnify.toFixed(2)}×</span>
          </div>

          <div style={rowStyle}>
            <span style={labelStyle}>水平</span>
            <input
              type="range" min={-180} max={180} step={1} value={Math.round(view?.yaw ?? 0)}
              onChange={(e) => setViewState({ yaw: Number(e.target.value), pitch: view?.pitch ?? 0 })}
              style={{ flex: 1 }}
            />
            <span style={{ width: 38, textAlign: 'right' }}>{Math.round(view?.yaw ?? 0)}°</span>
          </div>

          <div style={rowStyle}>
            <span style={labelStyle}>垂直</span>
            <input
              type="range" min={PITCH_MIN} max={PITCH_MAX} step={1} value={Math.round(view?.pitch ?? 0)}
              onChange={(e) => setViewState({ yaw: view?.yaw ?? 0, pitch: Number(e.target.value) })}
              style={{ flex: 1 }}
            />
            <span style={{ width: 38, textAlign: 'right' }}>{Math.round(view?.pitch ?? 0)}°</span>
          </div>
          <div style={noteStyle}>右键拖动宠物也能旋转视角</div>

          <hr style={dividerStyle} />

          <div style={rowStyle}>
            <span style={labelStyle}>播放</span>
            <button type="button" style={loopPlay ? activeButtonStyle : buttonStyle} onClick={() => setLoopPlay(v => !v)}>
              {loopPlay ? '循环' : '播一次'}
            </button>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => {
                const next = !(panel?.paused ?? false)
                handleRef.current?.setPaused(next)
                setPanel(current => (current === null ? current : { ...current, paused: next }))
              }}
            >
              {panel?.paused === true ? '继续' : '暂停'}
            </button>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => {
                handleRef.current?.clearManual()
                setLastPlay('回常态（跟随相位）')
              }}
            >
              回常态
            </button>
          </div>

          <div style={rowStyle}>
            <span style={labelStyle}>速度</span>
            <input
              type="range" min={SPEED_MIN} max={SPEED_MAX} step={0.05} value={panel?.speed ?? 1}
              onChange={(e) => {
                const next = Number(e.target.value)
                handleRef.current?.setSpeed(next)
                setPanel(current => (current === null ? current : { ...current, speed: next }))
              }}
              style={{ flex: 1 }}
            />
            <span style={{ width: 38, textAlign: 'right' }}>{(panel?.speed ?? 1).toFixed(2)}×</span>
          </div>

          <hr style={dividerStyle} />

          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ ...labelStyle, width: 'auto', marginRight: 6 }}>动作</span>
            <span data-pet3d-clip-count="" style={{ opacity: 0.7 }}>
              全部 {panel?.clips.length ?? 0} 条
              {panel !== null && panel.ready && ` · 可播 ${usableClips.length}`}
              {panel !== null && panel.ready && usableClips.length < panel.clips.length
                && `（${panel.clips.length - usableClips.length} 条不可用：无骨骼轨道或对照表标了慎用）`}
              {panel !== null && !panel.ready && ` · 数据载入中${model.model3d.clipsBinBytes > 0 ? `（${mb(model.model3d.clipsBinBytes)}）` : ''}`}
            </span>
          </div>
          {/* 155 条动作默认收起来：绝大多数时候用不到，展开才看（面板也不再被它撑得老长）。 */}
          <details data-pet3d-clip-list={(panel?.clips ?? []).length}>
            <summary style={{ cursor: 'pointer', opacity: 0.85, marginBottom: 6 }}>
              全部动作（{panel?.clips.length ?? 0}）
              {panel !== null && panel.ready
                ? ` · 可播 ${usableClips.length}（其余 ${panel.clips.length - usableClips.length} 条：特效无轨道、或对照表标了占位/慎用，按钮上写着原因）`
                : ''}
            </summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {(panel?.clips ?? []).length === 0 && <span style={{ opacity: 0.6 }}>（还没读到动作清单）</span>}
              {(panel?.clips ?? []).map(name => {
                const playable = panel?.ready === true && (panel?.registered.includes(name) ?? false)
                const meta = panel?.meta?.[name]
                const label = meta?.displayName ?? name
                // 对照表标了"慎用"的（占位 1 帧、含 NaN、零长度特效）不给点：点了也只会看到一张僵住的姿势，
                // 而且会让人以为模型坏了。按钮上写清楚原因。
                const cautioned = (meta?.caution ?? '') !== ''
                const usable = playable && !cautioned
                const why = cautioned
                  ? `${label}（${meta?.caution}）`
                  : playable
                    ? `${label}｜${name}${meta?.usage === undefined ? '' : `｜${meta.usage}`}`
                    : panel?.ready !== true
                      ? `${label}（动作数据还没就绪）`
                      : `${label}｜${name}（这条没有骨骼轨道：特效/材质动画，播不了）`
                return (
                  <button
                    key={name}
                    type="button"
                    data-pet3d-clip={name}
                    data-pet3d-clip-registered={playable ? '1' : '0'}
                    data-pet3d-clip-playable={usable ? '1' : '0'}
                    data-pet3d-clip-label={label}
                    data-pet3d-clip-caution={meta?.caution ?? ''}
                    disabled={usable !== true}
                    style={panel?.current === name ? activeButtonStyle : (usable ? buttonStyle : disabledButtonStyle)}
                    onClick={() => play(name)}
                    title={why}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </details>
          {lastPlay !== null && <div data-pet3d-last-play="" style={{ opacity: 0.7 }}>最近：{lastPlay}</div>}
          {panel !== null && panel.problems.length > 0 && (
            <details data-pet3d-clip-problems={panel.problems.length} style={{ opacity: 0.75, marginTop: 4 }}>
              <summary style={{ cursor: 'pointer' }}>被跳过的动作 / 动作问题（{panel.problems.length}）</summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: 16, opacity: 0.8 }}>
                {panel.problems.slice(0, 12).map(line => <li key={line}>{line}</li>)}
                {panel.problems.length > 12 && <li>…还有 {panel.problems.length - 12} 条</li>}
              </ul>
            </details>
          )}

          <hr style={dividerStyle} />

          <div style={rowStyle}>
            <span style={labelStyle}>相位</span>
            <span style={{ opacity: 0.75 }}>
              当前 <b data-pet3d-phase={phaseState}>{phaseState}</b>
              {stateOverride === null ? `（宿主 ${state.phase}）` : ` · 已强制（宿主 ${state.phase}）`}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
            {PHASE_STATES.map(name => (
              <button
                key={name}
                type="button"
                style={stateOverride === name ? activeButtonStyle : buttonStyle}
                onClick={() => setStateOverride(current => current === name ? null : name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div style={noteStyle}>
            四状态由宿主压缩：thinking / tool / review / waiting 都算 busy。
            强制只影响本面板显示，用来试各相位映射到哪条 clip。
          </div>

          {model.warnings.length > 0 && (
            <>
              <hr style={dividerStyle} />
              <div style={{ opacity: 0.75, marginBottom: 2 }}>这个模型的提示（{model.warnings.length}）</div>
              <ul style={{ margin: 0, paddingLeft: 16, opacity: 0.7 }}>
                {model.warnings.slice(0, 8).map(line => <li key={line}>{line}</li>)}
              </ul>
            </>
          )}

          {state.problems.length > 0 && (
            <>
              <hr style={dividerStyle} />
              <div style={{ opacity: 0.75, marginBottom: 2 }}>模型目录问题（{state.problems.length}）</div>
              <ul style={{ margin: 0, paddingLeft: 16, opacity: 0.7 }}>
                {state.problems.slice(0, 8).map(line => <li key={line}>{line}</li>)}
              </ul>
            </>
          )}

          {panel?.debug != null && (
            <pre
              data-pet3d-debug=""
              style={{
                margin: '8px 0 0', padding: '5px 6px', borderRadius: 5, background: 'rgba(0,0,0,0.5)',
                font: '10px/1.35 monospace', color: '#8f8', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}
            >
              {panel.debug}
            </pre>
          )}
        </div>
      )}

      {/*
        收起状态：一个不挡视线的小方块。点宠物先出它，点它才展开整块面板。
        它同样带 `data-pet3d-panel`（守卫据此判断"面板在不在"），用 `data-pet3d-panel-open="0"` 区分。
      */}
      {inspectOpen && !panelExpanded && (
        <button
          type="button"
          data-pet3d-panel=""
          data-pet3d-panel-open="0"
          data-pet3d-panel-expand=""
          onClick={() => setPanelExpanded(true)}
          title="打开动作面板（点开后可以看相位、动作、放大、视角；再点「收起」就回到这个小方块）"
          style={{
            position: 'fixed',
            left: Math.max(8, window.innerWidth - offsets.right - box + Math.round(box * 0.34)),
            bottom: Math.max(8, offsets.bottom + Math.round(box * 0.04)),
            width: 30, height: 30, zIndex: 41, padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            font: '15px/1 system-ui, sans-serif', color: '#eee', cursor: 'pointer',
            background: 'rgba(18,20,26,0.82)', border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: 6, boxShadow: '0 3px 10px rgba(0,0,0,0.4)',
          }}
        >
          {/* 小圆点＋方框：表示"这里有个面板" */}
          <span aria-hidden="true">▣</span>
        </button>
      )}
    </>
  )
}
