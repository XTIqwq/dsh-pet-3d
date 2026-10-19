/**
 * 演出编排器（设置 → 3D 桌宠 → 演出）。
 *
 * 这套东西和上面的"相位动作"是**两件事**：
 *   - 相位动作（`states`）= 某个相位循环演什么，一直演到相位变；
 *   - 演出（`performances`）= 某个**时刻**按顺序演一小段，演完回到当前相位。
 *
 * 所以这里排的是"曲子"：一条一条的 clip，每步可以限时（`seconds`，不填就播到自然结尾），
 * 按顺序连播。触发方式决定它什么时候自己开演（闲置 / 完成 / 出错 / 开始干活 / 每天第一次），
 * 或者干脆只手动试播。
 *
 * 三件事刻意做成这样：
 *  1. **时间线按真实时长画**：块宽 ∝ `clips.json` 里的 duration，所以"这段演出有多长"
 *     不用算，一眼看到（这也是它和下拉表格的差别）。
 *  2. **保存前不改文件**：所有编辑都在本地草稿里，点「保存」才 POST 回宿主；
 *     存完再**读回文件**确认 `performances` 真的落盘了 —— 宿主没重启时它的旧解析器
 *     会把不认识的字段吃掉，那种"看起来保存成功、其实没写进去"必须当场说出来。
 *  3. **试播走客户端总线**：设置页碰不到渲染器，只有宠物那棵树手里有 handle；
 *     命令通过 `performance-bus` 落到同一个渲染器实例上，不经过宿主、不写文件。
 * @module dsh-pet-3d/client/PerformanceEditor
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import {
  DEFAULT_CHOREOGRAPHY, PERFORMANCE_TRIGGERS, expandPattern, parseChoreography,
  type Choreography, type PerformanceTrigger, type PetPerformance, type PetPerformanceStep,
} from '../choreography.ts'
import { requestPerformance, requestPerformanceStop } from './performance-bus.ts'

/** 触发时机的中文名。 */
const TRIGGER_LABELS: Record<PerformanceTrigger, string> = {
  manual: '只手动试播',
  run: '开始干活',
  done: '回合完成',
  failed: '出错',
  idle: '闲置够久',
  daily: '每天第一次',
}

/** `/api/pet3d/clips/<id>` 的一条。 */
interface ClipSummary {
  name: string
  duration: number
  displayName?: string
  usage?: string
  caution?: string
}

/** 时间线每秒多少像素。 */
const PX_PER_SECOND = 14
/** 时间线里一块的最小宽度（短动作也点得到）。 */
const MIN_BLOCK_PX = 26
/** 时间线可见宽度的上限：演出很长时块会缩到这个范围里（并标出"已压缩"）。 */
const MAX_TIMELINE_PX = 720

const cardStyle: CSSProperties = {
  border: '1px solid rgba(128,128,128,0.22)', borderRadius: 8, padding: '10px 12px', marginBottom: 10,
}
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }
const smallStyle: CSSProperties = { fontSize: 12, lineHeight: 1.5, opacity: 0.62 }
const inputStyle: CSSProperties = {
  padding: '3px 6px', borderRadius: 5, border: '1px solid rgba(128,128,128,0.35)',
  background: 'rgba(128,128,128,0.10)', color: 'inherit', font: 'inherit',
}
const numberStyle: CSSProperties = { ...inputStyle, width: 58, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const buttonStyle: CSSProperties = {
  padding: '4px 9px', borderRadius: 6, cursor: 'pointer', color: 'inherit', font: 'inherit',
  border: '1px solid rgba(128,128,128,0.35)', background: 'rgba(128,128,128,0.14)',
}
const disabledStyle: CSSProperties = { ...buttonStyle, opacity: 0.45, cursor: 'not-allowed' }
const tinyButtonStyle: CSSProperties = { ...buttonStyle, padding: '2px 6px', fontSize: 11 }

/**
 * 一步占多少秒（没填就用 clip 的真实时长）。
 *
 * `resolve` 负责把配置里的**短名/通配**（`Galgame_Happy_Start`）对到模型里的**全名**
 * （`Avatar_…_Ani_Galgame_Happy_Start`）—— 配置本来就允许写短名（渲染器用
 * `expandPattern` 展开），编辑器如果不做同样的解析，时长查不到、下拉也选不中，
 * 时间线会画成等宽的假块。
 */
function stepSeconds(step: PetPerformanceStep, durations: Map<string, number>, resolve: (clip: string) => string | undefined): number {
  if (step.seconds !== undefined && step.seconds > 0) return step.seconds
  const full = resolve(step.clip)
  return (full === undefined ? undefined : durations.get(full)) ?? 2
}

/** 一条演出总共多少秒。 */
function performanceSeconds(performance: PetPerformance, durations: Map<string, number>, resolve: (clip: string) => string | undefined): number {
  return performance.steps.reduce((sum, step) => sum + stepSeconds(step, durations, resolve), 0)
}

/** 短名（去掉资源前缀）—— 和渲染器仪表里的写法一致。 */
function shortName(name: string): string {
  const at = name.lastIndexOf('_Ani_')
  return at < 0 ? name : name.slice(at + 5)
}

export function PerformanceEditor(): ReactElement {
  const [modelId, setModelId] = useState<string | null>(null)
  const [clips, setClips] = useState<ClipSummary[]>([])
  /** 整份配置（保存时原样回传，避免把 states/transitions 冲掉）。 */
  const [config, setConfig] = useState<Choreography | null>(null)
  const [dirty, setDirty] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  /** 保存后"宿主认不认识 performances"（旧解析器会把它吃掉）。 */
  const [hostKnows, setHostKnows] = useState<boolean | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const configJsonRef = useRef('')

  const durations = useMemo(() => new Map(clips.map((clip) => [clip.name, clip.duration])), [clips])
  const clipNames = useMemo(() => clips.map((clip) => clip.name), [clips])
  /**
   * 把配置里的一步解析成模型里的真实 clip 名。
   *
   * 配置允许短名与通配（`Galgame_*_Loop`），编辑器和渲染器必须用**同一套规则**展开，
   * 否则时间线/下拉和真正播的对不上（实测过：默认演出用的是短名，编辑器直接按全名
   * 查时长，于是三块都成了最小宽度）。
   */
  const resolveClip = useCallback((clip: string): string | undefined => {
    if (durations.has(clip)) return clip
    return expandPattern(clip, clipNames)[0]
  }, [durations, clipNames])

  /** 当前模型 + 动作清单（带时长）。 */
  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      try {
        const state = await (await fetch('/api/pet3d/state', { headers: { accept: 'application/json' }, cache: 'no-store' })).json() as { model?: { id?: string } | null }
        const id = state.model?.id ?? null
        if (!live || id === null) return
        setModelId((current) => current === id ? current : id)
        if (clips.length === 0) {
          const index = await (await fetch(`/api/pet3d/clips/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' }, cache: 'no-store' })).json() as { clips?: ClipSummary[] }
          if (live && Array.isArray(index.clips)) setClips(index.clips)
        }
      } catch {
        // 宿主还没起来：下一次轮询再试。
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 5000)
    return () => { live = false; window.clearInterval(timer) }
  }, [clips.length])

  /** 读盘上的整份配置（只在没改过的时候覆盖草稿，避免把用户的编辑冲掉）。 */
  useEffect(() => {
    if (modelId === null) return undefined
    let live = true
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`/pet3d/${encodeURIComponent(modelId)}/choreography.json`, { cache: 'no-store' })
        if (!live) return
        if (!response.ok) {
          if (config === null) {
            setConfig({ ...DEFAULT_CHOREOGRAPHY })
            setProblems([])
          }
          return
        }
        const raw = await response.text()
        if (!live || raw === configJsonRef.current) return
        const parsed = parseChoreography(JSON.parse(raw))
        configJsonRef.current = raw
        setProblems(parsed.problems)
        if (!dirty) setConfig(parsed.config)
      } catch {
        // 文件损坏/网络抖动：保持现状。
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 4000)
    return () => { live = false; window.clearInterval(timer) }
  }, [modelId, dirty, config])

  /** 改草稿（只动 `performances`，其余字段原样带回）。 */
  const patch = useCallback((next: Record<string, PetPerformance>): void => {
    setConfig((current) => (current === null ? current : { ...current, performances: next }))
    setDirty(true)
    setNote(null)
  }, [])

  const performances = config?.performances ?? {}
  const entries = Object.entries(performances)
  /** 就绪 = 模型和配置都读到了（守卫据此等待，不用猜时间）。 */
  const ready = modelId !== null && config !== null

  /** 新建一条空演出（两步：闲置循环 + 情绪收招，用户可以随便改）。 */
  const addPerformance = (): void => {
    let n = 1
    while (performances[`show${n}`] !== undefined) n += 1
    const id = `show${n}`
    patch({
      ...performances,
      [id]: {
        name: `演出 ${n}`,
        trigger: 'manual',
        steps: [{ clip: 'Galgame_Shy_Start' }, { clip: 'Galgame_Shy_End' }],
      },
    })
  }

  /** 把内置的四套默认演出并进来（不覆盖同名）。 */
  const addDefaults = (): void => {
    const merged: Record<string, PetPerformance> = { ...(DEFAULT_CHOREOGRAPHY.performances ?? {}), ...performances }
    patch(merged)
    setNote('已把默认四套并进来（同名的保留你现有的），记得保存')
  }

  const removePerformance = (id: string): void => {
    const next = { ...performances }
    delete next[id]
    patch(next)
  }

  const updatePerformance = (id: string, change: Partial<PetPerformance>): void => {
    const current = performances[id]
    if (current === undefined) return
    patch({ ...performances, [id]: { ...current, ...change } })
  }

  const updateStep = (id: string, index: number, change: Partial<PetPerformanceStep>): void => {
    const current = performances[id]
    if (current === undefined) return
    const steps = current.steps.map((step, at) => (at === index ? { ...step, ...change } : step))
    updatePerformance(id, { steps })
  }

  const moveStep = (id: string, index: number, delta: number): void => {
    const current = performances[id]
    if (current === undefined) return
    const target = index + delta
    if (target < 0 || target >= current.steps.length) return
    const steps = [...current.steps]
    const [moved] = steps.splice(index, 1)
    if (moved === undefined) return
    steps.splice(target, 0, moved)
    updatePerformance(id, { steps })
  }

  const removeStep = (id: string, index: number): void => {
    const current = performances[id]
    if (current === undefined) return
    updatePerformance(id, { steps: current.steps.filter((_, at) => at !== index) })
  }

  const addStep = (id: string): void => {
    const current = performances[id]
    if (current === undefined) return
    const first = clips[0]?.name ?? 'Galgame_Idle'
    updatePerformance(id, { steps: [...current.steps, { clip: first }] })
  }

  const play = (id: string, performance: PetPerformance, steps?: readonly PetPerformanceStep[]): void => {
    requestPerformance({ id: steps === undefined ? id : `${id}#试播`, name: performance.name ?? id, steps: steps ?? performance.steps })
    setPlaying(id)
    setNote(`正在试播：${performance.name ?? id}（点「停下」回当前相位）`)
  }

  /** 保存：整份配置回传，然后**读回文件**确认演出真的落盘了。 */
  const save = async (): Promise<void> => {
    if (modelId === null || config === null) return
    setSaving(true)
    setNote(null)
    try {
      const response = await fetch('/api/pet3d/choreography', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId, config }),
      })
      const body = await response.json() as { ok?: boolean; problems?: string[]; error?: string }
      if (!response.ok || body.ok !== true) {
        setNote(`保存失败：${body.error ?? response.status}`)
        return
      }
      // 读回：宿主若是不认识 performances 的旧版本，会把它们吃掉 —— 必须说出来。
      const readBack = await (await fetch(`/pet3d/${encodeURIComponent(modelId)}/choreography.json?t=${Date.now()}`, { cache: 'no-store' })).json() as { performances?: unknown }
      const survived = typeof readBack.performances === 'object' && readBack.performances !== null
      setHostKnows(survived)
      setDirty(false)
      configJsonRef.current = ''
      setProblems(body.problems ?? [])
      setNote(survived
        ? '已保存（≤2 秒生效）'
        : '保存没生效：宿主这一版还不认识「演出」—— 重启 DSH 后再保存一次（原文件已备份为 choreography.json.bak）')
    } catch (error) {
      setNote(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const timelineWidth = (performance: PetPerformance): { blocks: { width: number; label: string }[]; total: number; compressed: boolean } => {
    const total = performanceSeconds(performance, durations, resolveClip)
    const raw = performance.steps.map((step) => Math.max(MIN_BLOCK_PX, stepSeconds(step, durations, resolveClip) * PX_PER_SECOND))
    const sum = raw.reduce((a, b) => a + b, 0)
    const scale = sum > MAX_TIMELINE_PX ? MAX_TIMELINE_PX / sum : 1
    return {
      blocks: performance.steps.map((step, at) => ({
        width: Math.round((raw[at] ?? MIN_BLOCK_PX) * scale),
        label: shortName(resolveClip(step.clip) ?? step.clip),
      })),
      total,
      compressed: scale < 1,
    }
  }

  return (
    <div data-pet3d-perf-editor="" {...(ready ? { 'data-pet3d-perf-ready': '' } : {})}>
      <div style={{ ...rowStyle, flexWrap: 'wrap' }}>
        <button type="button" style={buttonStyle} data-pet3d-perf-add="" onClick={addPerformance}>＋ 新建演出</button>
        <button type="button" style={buttonStyle} data-pet3d-perf-defaults="" onClick={addDefaults}>加入默认四套</button>
        <button type="button" style={buttonStyle} onClick={() => { requestPerformanceStop(); setPlaying(null); setNote('已停下') }}>停下</button>
        <button
          type="button"
          data-pet3d-perf-save=""
          style={!dirty || saving ? disabledStyle : buttonStyle}
          disabled={!dirty || saving}
          onClick={() => { void save() }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {dirty && <span style={smallStyle}>未保存</span>}
      </div>

      {modelId === null && <p style={smallStyle}>正在读取模型…</p>}
      {modelId !== null && config === null && <p style={smallStyle}>正在读取 choreography.json…</p>}

      {modelId !== null && config !== null && entries.length === 0 && (
        <p style={smallStyle}>还没有演出。点「新建演出」自己排一段，或点「加入默认四套」拿现成的四套开始改。</p>
      )}

      {entries.map(([id, performance]) => {
        const total = performanceSeconds(performance, durations, resolveClip)
        const line = timelineWidth(performance)
        const isIdle = (performance.trigger ?? 'manual') === 'idle'
        return (
          <div key={id} style={cardStyle} data-pet3d-perf-item={id}>
            <div style={{ ...rowStyle, flexWrap: 'wrap' }}>
              <input
                aria-label="演出名称"
                data-pet3d-perf-name=""
                value={performance.name ?? ''}
                placeholder={id}
                onChange={(event) => updatePerformance(id, { name: event.target.value })}
                style={{ ...inputStyle, width: 150 }}
              />
              <select
                aria-label="触发时机"
                data-pet3d-perf-trigger={id}
                value={performance.trigger ?? 'manual'}
                onChange={(event) => updatePerformance(id, { trigger: event.target.value as PerformanceTrigger })}
                style={inputStyle}
              >
                {PERFORMANCE_TRIGGERS.map((trigger) => (
                  <option key={trigger} value={trigger}>{TRIGGER_LABELS[trigger]}</option>
                ))}
              </select>
              {isIdle && (
                <label style={{ ...smallStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
                  闲置
                  <input
                    aria-label="闲置多少秒后开演"
                    data-pet3d-perf-after=""
                    type="number"
                    min={5}
                    step={5}
                    value={performance.afterSeconds ?? 180}
                    onChange={(event) => updatePerformance(id, { afterSeconds: Number(event.target.value) })}
                    style={numberStyle}
                  />
                  秒后开演
                </label>
              )}
              <span style={{ flex: '1 1 auto' }} />
              <span style={smallStyle}>共 {total.toFixed(1)}s</span>
              <button type="button" style={tinyButtonStyle} data-pet3d-perf-play={id} onClick={() => play(id, performance)}>试播</button>
              <button type="button" style={tinyButtonStyle} onClick={() => removePerformance(id)}>删除</button>
            </div>

            {/* 时间线：块宽 ∝ 这一步的秒数（没填就按 clip 真实时长）。 */}
            <div
              data-pet3d-perf-timebar={id}
              title={`总长约 ${total.toFixed(1)}s${line.compressed ? '（已压缩显示）' : ''}`}
              style={{ display: 'flex', gap: 2, marginBottom: 8, height: 22 }}
            >
              {line.blocks.map((block, at) => (
                <div
                  key={`${id}-bar-${at}`}
                  style={{
                    width: block.width, borderRadius: 4, overflow: 'hidden', whiteSpace: 'nowrap',
                    font: '10px/22px system-ui, sans-serif', textAlign: 'center', textOverflow: 'ellipsis',
                    color: '#0d1014',
                    background: at % 2 === 0 ? 'rgba(120,200,255,0.75)' : 'rgba(150,180,220,0.65)',
                  }}
                >
                  {block.label}
                </div>
              ))}
            </div>

            {performance.steps.map((step, at) => (
              <div key={`${id}-${at}`} style={rowStyle} data-pet3d-perf-step={`${id}:${at}`}>
                <span style={{ ...smallStyle, width: 16, textAlign: 'right' }}>{at + 1}</span>
                <select
                  aria-label="这一步的动作"
                  data-pet3d-perf-step-clip=""
                  value={resolveClip(step.clip) ?? step.clip}
                  onChange={(event) => updateStep(id, at, { clip: event.target.value })}
                  style={{ ...inputStyle, flex: '1 1 220px', minWidth: 0, maxWidth: 320 }}
                >
                  {clips.length === 0 && <option value={step.clip}>{step.clip}</option>}
                  {clips.map((clip) => (
                    <option key={clip.name} value={clip.name} title={`${clip.name}｜${clip.duration.toFixed(2)}s${clip.usage === undefined ? '' : `｜${clip.usage}`}`}>
                      {(clip.displayName ?? clip.name)}{clip.caution === undefined ? '' : `（${clip.caution}）`}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="这一步占多少秒（空=播到自然结尾）"
                  data-pet3d-perf-step-seconds=""
                  type="text"
                  placeholder={`${stepSeconds(step, durations, resolveClip).toFixed(1)}s`}
                  value={step.seconds === undefined ? '' : String(step.seconds)}
                  onChange={(event) => {
                    const text = event.target.value.trim()
                    const value = Number(text)
                    updateStep(id, at, { seconds: text === '' || !Number.isFinite(value) || value <= 0 ? undefined : value })
                  }}
                  style={{ ...numberStyle, width: 64 }}
                />
                <input
                  aria-label="播放倍率"
                  type="number"
                  min={0.1}
                  max={4}
                  step={0.1}
                  value={step.rate ?? 1}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    updateStep(id, at, { rate: Number.isFinite(value) && value !== 1 ? Math.min(4, Math.max(0.1, value)) : undefined })
                  }}
                  style={{ ...numberStyle, width: 52 }}
                />
                <span style={smallStyle}>×</span>
                <button type="button" style={tinyButtonStyle} onClick={() => moveStep(id, at, -1)} disabled={at === 0}>↑</button>
                <button type="button" style={tinyButtonStyle} onClick={() => moveStep(id, at, 1)} disabled={at === performance.steps.length - 1}>↓</button>
                <button type="button" style={tinyButtonStyle} data-pet3d-perf-step-play="" onClick={() => play(id, performance, [step])}>试播</button>
                <button type="button" style={tinyButtonStyle} onClick={() => removeStep(id, at)} disabled={performance.steps.length <= 1}>✕</button>
              </div>
            ))}
            <button type="button" style={tinyButtonStyle} onClick={() => addStep(id)}>＋ 加一步</button>
          </div>
        )
      })}

      {problems.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ ...smallStyle, cursor: 'pointer' }}>配置文件里有 {problems.length} 处看不懂（已忽略）</summary>
          <ul style={{ fontSize: 12, opacity: 0.7, margin: '4px 0 0', paddingLeft: 16 }}>
            {problems.slice(0, 8).map((line) => <li key={line}>{line}</li>)}
          </ul>
        </details>
      )}

      {note !== null && <p data-pet3d-perf-note="" style={{ ...smallStyle, opacity: 0.85, marginTop: 6 }}>{note}</p>}
      {hostKnows === false && (
        <p style={{ ...smallStyle, color: '#fd8', marginTop: 4 }}>
          宿主还没重启：这一版宿主不认识「演出」，保存会被它吃掉。重启 DSH 后再保存一次即可。
        </p>
      )}
      {playing !== null && <p style={smallStyle}>正在演：{playing}</p>}
    </div>
  )
}
