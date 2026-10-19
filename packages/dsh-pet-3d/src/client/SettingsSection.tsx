/**
 * 设置 → 3D 桌宠 —— 插件自己的应用内设置页（`settings.section` 一级页）。
 *
 * 这一页承担两件事：
 *
 *   1. **基础设置**：显示开关、大小、位置、选模型、导入器脚本、插件总开关 ——
 *      用户日常会改的东西，每种都即时生效、不需要重启；
 *   2. **模型导入维护**：重新导入（reimport + 热换）、导入阻塞原因、宿主版本、
 *      模型目录问题 —— 导入是这个插件最容易出问题的一环，出错信息必须有个地方看。
 *
 * 宠物身上那套"检查面板"（试播 161 条动作、强制相位、编排器、放大、视角、仪表）
 * 不在这里：它只属于调试，由本页的「开发者模式」开关放出来（见 dev-mode.ts）。
 *
 * 写路径都是**已有的**机制，这一页不发明新的：
 *   - 显示 / 大小 / 位置 → `POST /api/pet3d/display`（和拖动宠物同一条路，落在 pet3d.json）；
 *   - 选模型            → `POST /api/pet3d/set-pet`；
 *   - 重新导入          → `POST /api/pet3d/reimport`（冲突要带 force，见下）；
 *   - 总开关 / 导入器脚本 → cordis Config（`configForms` 的 mutate，宿主写 profile 配置）。
 * @module dsh-pet-3d/client/SettingsSection
 */

import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactElement, type ReactNode,
} from 'react'
import { setDevMode, useDevMode } from './dev-mode.ts'
import { PerformanceEditor } from './PerformanceEditor.tsx'

/** 本页对宿主快照的轮询间隔，ms（比宠物自己的 1s 宽松：这一页不需要跟帧）。 */
const POLL_MS = 2000
/** 输入框改动后多久提交，ms（拖动滑杆时不要把每个像素都写成一次磁盘写）。 */
const COMMIT_DELAY_MS = 220
/** 大小 / 位置的可调范围，与宿主 Config 的 schema 一致。 */
const SIZE_MIN = 80
const SIZE_MAX = 1200
const OFFSET_MIN = 0
const OFFSET_MAX = 4000

/** 宿主快照里的 display 块。 */
interface DisplayView {
  visible: boolean
  size: number
  right: number
  bottom: number
}

/** 宿主快照里的一个模型条目。 */
interface ModelOptionView {
  id: string
  displayName: string
  clipCount: number
  clipsBinBytes: number
  stale: boolean
}

/** `/api/pet3d/state` 里本页用到的部分。 */
interface StateResponse {
  model: { id: string; displayName?: string; warnings?: string[] } | null
  modelRevision: string
  importStall?: string
  models: ModelOptionView[]
  phase: string
  display: DisplayView
  problems: string[]
}

/** 插件 Config 的字段（与 src/index.ts 的 Config 一致）。 */
interface PetSettingsValue {
  enabled?: boolean
  visible?: boolean
  size?: number
  right?: number
  bottom?: number
  petId?: string
  importerScript?: string
}

/** `configForms` 表单快照的最小形状。 */
interface SettingsFormSnapshot {
  status?: string
  value?: PetSettingsValue
  writable?: boolean
}

/** 一条 Config 写操作（宿主表单契约）。 */
type ConfigOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** `configForms` 表单的最小形状（只声明这一页用到的）。 */
export interface SettingsFormLike {
  getSnapshot(): SettingsFormSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: ConfigOp[]): Promise<boolean>
}

/** 设置页的注入面：注册时由 `inject()` 交给组件。 */
export interface Pet3dSettingsFace {
  /** 插件 Config 的表单；某些部署没有 configForms 服务时为 undefined。 */
  settings?: SettingsFormLike
}

/* ------------------------------------------------------------------ 基础样式 */

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 16, padding: '9px 0' }
const labelStyle: CSSProperties = { flex: '1 1 auto', minWidth: 0 }
const labelTextStyle: CSSProperties = { fontSize: 13, fontWeight: 500, lineHeight: 1.5 }
const hintStyle: CSSProperties = { fontSize: 12, lineHeight: 1.5, opacity: 0.6, marginTop: 2 }
const controlStyle: CSSProperties = { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 }
const dividerStyle: CSSProperties = { border: 0, borderTop: '1px solid rgba(128,128,128,0.22)', margin: '6px 0' }
const sectionStyle: CSSProperties = { marginBottom: 22 }
const sectionTitleStyle: CSSProperties = { fontSize: 14, fontWeight: 600, margin: '0 0 2px' }
const sectionNoteStyle: CSSProperties = { fontSize: 12, lineHeight: 1.5, opacity: 0.55, margin: '0 0 6px' }
const inputStyle: CSSProperties = {
  width: 84, padding: '4px 8px', borderRadius: 6, textAlign: 'right',
  border: '1px solid rgba(128,128,128,0.35)', background: 'rgba(128,128,128,0.10)',
  color: 'inherit', font: 'inherit', fontVariantNumeric: 'tabular-nums',
}
const wideInputStyle: CSSProperties = { ...inputStyle, width: '100%', textAlign: 'left', fontVariantNumeric: 'normal' }
const buttonStyle: CSSProperties = {
  padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid rgba(128,128,128,0.35)', background: 'rgba(128,128,128,0.14)',
  color: 'inherit', font: 'inherit',
}
const disabledButtonStyle: CSSProperties = { ...buttonStyle, opacity: 0.45, cursor: 'not-allowed' }
const noteStyle: CSSProperties = { fontSize: 12, lineHeight: 1.55, opacity: 0.72, marginTop: 6 }
const problemStyle: CSSProperties = { fontSize: 12, lineHeight: 1.55, opacity: 0.75, margin: '4px 0 0', paddingLeft: 16 }

/* -------------------------------------------------------------------- 小部件 */

/** 一行：左侧标签 + 说明，右侧控件。 */
function Row(props: { label: ReactNode; hint?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div style={rowStyle}>
      <div style={labelStyle}>
        <div style={labelTextStyle}>{props.label}</div>
        {props.hint !== undefined && <div style={hintStyle}>{props.hint}</div>}
      </div>
      <div style={controlStyle}>{props.children}</div>
    </div>
  )
}

/** 一节：标题 + 说明 + 内容。 */
function Section(props: { title: string; note?: string; attrs?: Record<string, string>; children: ReactNode }): ReactElement {
  return (
    <section style={sectionStyle} {...props.attrs}>
      <h3 style={sectionTitleStyle}>{props.title}</h3>
      {props.note !== undefined && <p style={sectionNoteStyle}>{props.note}</p>}
      {props.children}
    </section>
  )
}

/** 开关：`role="switch"` 的胶囊按钮。 */
function Switch(props: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  attrs?: Record<string, string>
}): ReactElement {
  const width = 38
  const height = 22
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled === true}
      onClick={() => { if (props.disabled !== true) props.onChange(!props.checked) }}
      style={{
        position: 'relative', width, height, padding: 0, borderRadius: height / 2, cursor: props.disabled === true ? 'not-allowed' : 'pointer',
        border: '1px solid rgba(128,128,128,0.35)',
        background: props.checked ? 'rgba(90,170,255,0.85)' : 'rgba(128,128,128,0.25)',
        opacity: props.disabled === true ? 0.5 : 1,
        transition: 'background .15s ease',
      }}
      {...props.attrs}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute', top: 2, left: props.checked ? width - height + 2 : 2,
          width: height - 6, height: height - 6, borderRadius: '50%', background: '#fff',
          transition: 'left .15s ease', boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
        }}
      />
    </button>
  )
}

/** 数字输入：受控 draft + 失焦/回车提交。 */
function NumberInput(props: {
  value: number
  min: number
  max: number
  step?: number
  label: string
  disabled?: boolean
  onCommit: (next: number) => void
  attrs?: Record<string, string>
}): ReactElement {
  const [draft, setDraft] = useState(String(Math.round(props.value)))
  const focused = useRef(false)
  // 外部值变化（拖动宠物、别的页改了）时同步，但正在输入时不打断用户。
  useEffect(() => {
    if (!focused.current) setDraft(String(Math.round(props.value)))
  }, [props.value])

  /**
   * 提交输入框里的值。
   *
   * 取的是**事件里那个元素的 value**，不是 state 里的 draft：输入和失焦可能落在
   * 同一个批次里（快速输入后立刻点别处、或脚本驱动），那时闭包里的 draft 还是旧的，
   * 提交就会"看起来什么都没发生"。
   */
  const commit = (raw: string): void => {
    const parsed = Number(raw.trim())
    const settled = Number.isFinite(parsed) ? Math.min(props.max, Math.max(props.min, Math.round(parsed))) : Math.round(props.value)
    setDraft(String(settled))
    if (settled !== Math.round(props.value)) props.onCommit(settled)
  }

  return (
    <input
      type="number"
      aria-label={props.label}
      title={props.label}
      value={draft}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      disabled={props.disabled === true}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { focused.current = true }}
      onBlur={(e) => { focused.current = false; commit(e.currentTarget.value) }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        focused.current = false
        commit(e.currentTarget.value)
        e.currentTarget.blur()
      }}
      style={{ ...inputStyle, opacity: props.disabled === true ? 0.5 : 1 }}
      {...props.attrs}
    />
  )
}

/* ---------------------------------------------------------------- 数据小工具 */

/** 读一次宿主快照；失败返回 null（宿主没起来 / 插件被停用）。 */
async function fetchState(): Promise<StateResponse | null> {
  try {
    const response = await fetch('/api/pet3d/state', { headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!response.ok) return null
    return await response.json() as StateResponse
  } catch {
    return null
  }
}

/** POST 一个 JSON 体并解析回答；非 2xx 抛出宿主给的错误文本。 */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown = undefined
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const reason = typeof parsed === 'object' && parsed !== null && 'error' in parsed
      ? String((parsed as { error?: unknown }).error)
      : `HTTP ${response.status}`
    throw new Error(reason)
  }
  return parsed as T
}

/** 把毫秒化的字节数说成人话。 */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* -------------------------------------------------------------- 设置页主体 */

/**
 * 渲染「设置 → 3D 桌宠」整页。
 * @param props - 槽位把注册时的 `inject()` 结果并进 props。
 */
export function Pet3dSettingsSection(props: Pet3dSettingsFace = {}): ReactElement {
  const form = props.settings
  const devMode = useDevMode()

  const [state, setState] = useState<StateResponse | null>(null)
  const [reachable, setReachable] = useState(true)
  /** 用户正在改的三项；null 表示"跟随宿主"。 */
  const [draft, setDraft] = useState<DisplayView | null>(null)
  const draftRef = useRef<DisplayView | null>(null)
  /** 正在编辑的字段名：编辑期间不被轮询覆盖。 */
  const editing = useRef<string | null>(null)
  const [displayNote, setDisplayNote] = useState<string | null>(null)
  const [reloadNote, setReloadNote] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)
  const [configNote, setConfigNote] = useState<string | null>(null)
  const [importerDraft, setImporterDraft] = useState<string | null>(null)

  draftRef.current = draft

  // 宿主快照轮询：显示、模型列表、版本、导入状态。
  useEffect(() => {
    let alive = true
    let timer = 0
    const tick = async (): Promise<void> => {
      const next = await fetchState()
      if (!alive) return
      setReachable(next !== null)
      if (next !== null) {
        setState(next)
        if (editing.current === null) setDraft(next.display)
      }
      timer = window.setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [])

  // Config 表单快照（没有 configForms 服务时退化为空快照）。
  const subscribeForm = useCallback(
    (listener: () => void): (() => void) => (form === undefined ? () => {} : form.subscribe(listener)),
    [form],
  )
  const readForm = useCallback((): SettingsFormSnapshot => (form === undefined ? {} : form.getSnapshot()), [form])
  const formSnapshot = useSyncExternalStore(subscribeForm, readForm, readForm)
  const configValue = formSnapshot.value ?? {}
  const configWritable = formSnapshot.writable === true

  const importerText = importerDraft ?? configValue.importerScript ?? ''
  const importerDirty = importerDraft !== null && importerDraft !== (configValue.importerScript ?? '')

  /** 显示三项/可见性的提交（和拖动宠物同一条路）。 */
  const commitDisplay = useCallback(async (patch: Partial<DisplayView>): Promise<void> => {
    const base = draftRef.current
    if (base === null) return
    const next = { ...base, ...patch }
    setDraft(next)
    draftRef.current = next
    try {
      const saved = await postJson<DisplayView>('/api/pet3d/display', next)
      setDraft(saved)
      draftRef.current = saved
      setDisplayNote(null)
    } catch (error) {
      setDisplayNote(`没保存上：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  /** 数字框改动：先本地生效，延迟提交（滑杆/连续输入不会写出几十次）。 */
  const commitLater = useRef<number | undefined>(undefined)
  const changeNumber = useCallback((key: 'size' | 'right' | 'bottom', value: number): void => {
    const base = draftRef.current
    if (base === null) return
    const next = { ...base, [key]: value }
    setDraft(next)
    draftRef.current = next
    if (commitLater.current !== undefined) window.clearTimeout(commitLater.current)
    commitLater.current = window.setTimeout(() => {
      commitLater.current = undefined
      void commitDisplay({ [key]: value })
    }, COMMIT_DELAY_MS)
  }, [commitDisplay])

  useEffect(() => () => {
    if (commitLater.current !== undefined) window.clearTimeout(commitLater.current)
  }, [])

  /** 写一条 Config 字段。 */
  const mutateConfig = useCallback(async (field: string, value: unknown): Promise<void> => {
    if (form === undefined) {
      setConfigNote('这个部署没有 configForms 服务，改不了插件配置')
      return
    }
    setConfigSaving(true)
    setConfigNote(null)
    try {
      const landed = await form.mutate([{ op: 'set', path: [field], value }])
      setConfigNote(landed ? null : '宿主没有接受这次改动')
    } catch (error) {
      setConfigNote(`没保存上：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setConfigSaving(false)
    }
  }, [form])

  /** 切模型。 */
  const selectModel = useCallback(async (id: string): Promise<void> => {
    try {
      await postJson('/api/pet3d/set-pet', { modelId: id })
    } catch (error) {
      setDisplayNote(`切换模型失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  /**
   * 重新导入并热换。
   *
   * 冲突（目录里的产物是别的导入器写的）宿主会回一个"需要确认"的错误：这里把它
   * 变成一次确认，而不是静默覆盖 —— 覆盖的是模型目录里的产物，不可逆。
   */
  const reimport = useCallback(async (modelId: string, force = false): Promise<void> => {
    if (reloading) return
    setReloading(true)
    setReloadNote('正在重新导入…')
    try {
      const outcome = await postJson<{ revision?: string; durationMs?: number }>(
        '/api/pet3d/reimport',
        force ? { modelId, force: true } : { modelId },
      )
      const seconds = typeof outcome.durationMs === 'number' ? (outcome.durationMs / 1000).toFixed(1) : '?'
      setReloadNote(`重导入完成（${seconds}s，revision ${String(outcome.revision ?? '').slice(0, 8)}），正在热换`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!force && message.includes('需要确认')) {
        const proceed = window.confirm(`${message}\n\n仍然要用当前配置的导入器覆盖这份产物吗？`)
        setReloading(false)
        if (proceed) await reimport(modelId, true)
        else setReloadNote('已取消')
        return
      }
      setReloadNote(`重载失败：${message}`)
    } finally {
      setReloading(false)
    }
  }, [reloading])

  const models = state?.models ?? []
  const current = state?.model ?? null
  const display = draft ?? state?.display ?? null
  const writable = configWritable && form !== undefined

  /** 模型目录里能选的名字：带上动作条数与"源文件已变"。 */
  const modelOptions = useMemo(() => models.map((option) => ({
    id: option.id,
    label: `${option.displayName || option.id}（${option.clipCount} 动作${option.stale ? ' · 源文件已变' : ''}）`,
  })), [models])

  return (
    <div data-pet3d-settings="" style={{ padding: '2px 0 8px', maxWidth: 760 }}>
      <Section
        title="显示"
        note="改完立即生效；直接拖动宠物也会改这里的数字。点宠物正中间的小熊 🐻 可以换整套外观、穿脱配饰（那份菜单不在这个设置页里）。"
        attrs={{ 'data-pet3d-settings-section': 'display' }}
      >
        {display === null
          ? <p style={noteStyle}>{reachable ? '正在读取宠物状态…' : '宿主接口不可用（插件可能已停用）。'}</p>
          : (
            <>
              <Row label="显示宠物" hint="关掉后宠物从画面上消失，插件本身照常在跑。">
                <Switch
                  label="显示宠物"
                  checked={display.visible}
                  onChange={(next) => { void commitDisplay({ visible: next }) }}
                  attrs={{ 'data-pet3d-settings-visible': '' }}
                />
              </Row>
              <hr style={dividerStyle} />
              <Row label="大小" hint={`像素，${SIZE_MIN}–${SIZE_MAX}。`}>
                <NumberInput
                  label="宠物大小"
                  value={display.size}
                  min={SIZE_MIN}
                  max={SIZE_MAX}
                  onCommit={(next) => changeNumber('size', next)}
                  attrs={{ 'data-pet3d-settings-size': '' }}
                />
                <span style={{ fontSize: 12, opacity: 0.6 }}>px</span>
              </Row>
              <hr style={dividerStyle} />
              <Row label="右边距" hint={`距离窗口右侧的像素，${OFFSET_MIN}–${OFFSET_MAX}。`}>
                <NumberInput
                  label="右边距"
                  value={display.right}
                  min={OFFSET_MIN}
                  max={OFFSET_MAX}
                  onCommit={(next) => changeNumber('right', next)}
                  attrs={{ 'data-pet3d-settings-right': '' }}
                />
                <span style={{ fontSize: 12, opacity: 0.6 }}>px</span>
              </Row>
              <hr style={dividerStyle} />
              <Row label="下边距" hint={`距离窗口底部的像素，${OFFSET_MIN}–${OFFSET_MAX}。`}>
                <NumberInput
                  label="下边距"
                  value={display.bottom}
                  min={OFFSET_MIN}
                  max={OFFSET_MAX}
                  onCommit={(next) => changeNumber('bottom', next)}
                  attrs={{ 'data-pet3d-settings-bottom': '' }}
                />
                <span style={{ fontSize: 12, opacity: 0.6 }}>px</span>
              </Row>
            </>
          )}
        {displayNote !== null && <p data-pet3d-settings-note="" style={noteStyle}>{displayNote}</p>}
      </Section>

      <Section
        title="模型"
        note="模型是数据：放在 $DSH_HOME/models/<id>/ 里就能被选中。重新导入会按导入器脚本重跑一遍并就地热换。"
        attrs={{ 'data-pet3d-settings-section': 'model' }}
      >
        <Row label="当前模型" hint={current === null ? '宿主还没报出模型。' : `已装载 ${state?.modelRevision === undefined || state.modelRevision === '' ? '-' : state.modelRevision.slice(0, 8)}`}>
          <select
            aria-label="选择模型"
            data-pet3d-settings-model=""
            value={current?.id ?? ''}
            disabled={models.length === 0}
            onChange={(e) => { void selectModel(e.target.value) }}
            style={{ ...wideInputStyle, width: 240, textAlign: 'left' }}
          >
            {models.length === 0 && <option value="">（没有可用模型）</option>}
            {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </Row>
        <hr style={dividerStyle} />
        <Row
          label="重新导入"
          hint={`按导入器脚本重跑这个模型：几分钟的长任务，跑完自动热换，不用刷新页面。${current === null ? '' : `（${mb(models.find((m) => m.id === current.id)?.clipsBinBytes ?? 0)} 动作数据）`}`}
        >
          <button
            type="button"
            data-pet3d-settings-reimport=""
            disabled={reloading || current === null}
            onClick={() => { if (current !== null) void reimport(current.id) }}
            style={reloading || current === null ? disabledButtonStyle : buttonStyle}
          >
            {reloading ? '重导入中…' : '重新导入'}
          </button>
        </Row>
        {state?.importStall !== undefined && (
          <p data-pet3d-settings-stall="" style={{ ...noteStyle, opacity: 0.85 }}>
            自动重导入已停止：{state.importStall}
          </p>
        )}
        {reloadNote !== null && <p data-pet3d-settings-reload="" style={noteStyle}>{reloadNote}</p>}

        {state !== null && state.problems.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.75 }}>模型目录问题（{state.problems.length}）</summary>
            <ul style={problemStyle}>
              {state.problems.slice(0, 8).map((line) => <li key={line}>{line}</li>)}
              {state.problems.length > 8 && <li>…还有 {state.problems.length - 8} 条</li>}
            </ul>
          </details>
        )}
        {current?.warnings !== undefined && current.warnings.length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.75 }}>这个模型的提示（{current.warnings.length}）</summary>
            <ul style={problemStyle}>
              {current.warnings.slice(0, 8).map((line) => <li key={line}>{line}</li>)}
              {current.warnings.length > 8 && <li>…还有 {current.warnings.length - 8} 条</li>}
            </ul>
          </details>
        )}

        <details data-pet3d-settings-advanced="" style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.75 }}>导入器脚本（高级）</summary>
          <Row
            label="脚本路径"
            hint="留空＝用插件自带的 tools/pet3d-import.mjs。换脚本不需要重启，下一次重新导入就按新脚本跑。"
          >
            <input
              type="text"
              aria-label="导入器脚本路径"
              data-pet3d-settings-importer=""
              value={importerText}
              placeholder="（留空＝插件自带）"
              disabled={!writable}
              onChange={(e) => setImporterDraft(e.target.value)}
              style={{ ...wideInputStyle, width: 260 }}
            />
            <button
              type="button"
              data-pet3d-settings-importer-save=""
              disabled={!writable || !importerDirty || configSaving}
              onClick={() => { void mutateConfig('importerScript', importerText).then(() => setImporterDraft(null)) }}
              style={!writable || !importerDirty || configSaving ? disabledButtonStyle : buttonStyle}
            >
              {configSaving ? '保存中…' : '保存'}
            </button>
          </Row>
          {!writable && <p style={noteStyle}>只读：这份配置当前不被本客户端写入（没有 configForms 服务或宿主标了只读）。</p>}
        </details>
      </Section>

      <Section
        title="演出"
        note="演出是「某个时刻按顺序演一小段」，演完回到当前相位 —— 和上面「相位动作」（一直循环到相位变）是两件事。时间线按真实时长画；「试播」会立刻在宠物身上演一遍，不写文件。"
        attrs={{ 'data-pet3d-settings-section': 'performances' }}
      >
        <PerformanceEditor />
      </Section>

      <Section
        title="插件"
        note="整个插件的总开关：关掉后宠物和它的接口一起停用，重新打开即可恢复。"
        attrs={{ 'data-pet3d-settings-section': 'plugin' }}
      >
        <Row label="启用 dsh-pet-3d" hint={configValue.enabled === false ? '当前已停用。' : '当前启用中。'}>
          <Switch
            label="启用插件"
            checked={configValue.enabled !== false}
            disabled={!writable || configSaving}
            onChange={(next) => { void mutateConfig('enabled', next) }}
            attrs={{ 'data-pet3d-settings-enabled': '' }}
          />
        </Row>
        {configNote !== null && <p data-pet3d-settings-config-note="" style={noteStyle}>{configNote}</p>}
      </Section>

      <Section
        title="开发者"
        note="检查面板只给调动作的人用；关着的时候宠物身上不会出现任何小方块。"
        attrs={{ 'data-pet3d-settings-section': 'developer' }}
      >
        <Row
          label="开发者模式"
          hint={devMode
            ? '已打开：点一下宠物会出现小方块，点小方块展开动作面板（试播/相位/视角/编排/仪表）。'
            : '关着：宠物只能拖动，点它不会有任何面板。'}
        >
          <Switch
            label="开发者模式"
            checked={devMode}
            onChange={(next) => setDevMode(next)}
            attrs={{ 'data-pet3d-settings-devmode': '' }}
          />
        </Row>
      </Section>
    </div>
  )
}
