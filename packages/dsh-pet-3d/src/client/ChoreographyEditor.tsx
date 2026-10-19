/**
 * 动作编排器（网页版）。
 *
 * 用户的原话："帮我写个小工具吧，我来编排什么时候做什么动作"。
 * 所以这里就干三件事：
 *
 *  1. **看得见**：每个相位状态（待机 / 干活 / 干完 / 出错）当前用哪条动作、点击时随机演哪几段、
 *     空闲多久插一段什么 —— 一行行列出来，名字显示中文（来自名称对照表）；
 *  2. **改得动**：下拉选动作、加减定时条目，改完点保存 → POST 回宿主写进
 *     `<模型目录>/choreography.json` → 客户端 ≤2 秒自动生效（不用刷新、不用重启）；
 *  3. **省得慌**：描边（整模再画一遍）和面部形态键（29 个）两个开销开关，帧率不够时用；
 *     旁边就显示实时状态与帧率，改了马上能看出有没有用。
 *
 * 不依赖任何 UI 库：就是 React + 原生 `<select>` / `<input>`，面板里塞得下就行。
 */
import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_CHOREOGRAPHY, type Choreography } from '../choreography.ts'
import { PHASE_STATES, type PhaseState } from '../state.ts'
import { parseDuration, type GapPolicy } from '../timeline.ts'

/** 相位状态的中文名。 */
const STATE_LABELS: Record<string, string> = {
  idle: '闲置',
  walk: '走',
  run: '跑',
  think: '思考',
  done: '完成',
  failed: '出错',
}

/** 编辑器要读的东西（都来自页面已有的轮询，不额外发请求）。 */
export interface ChoreographyEditorProps {
  /** 当前模型 id。 */
  modelId: string
  /** 可选的 clip：英文 id → 中文名。 */
  clips: { name: string; label: string; caution?: string }[]
  /** 当前生效的配置。 */
  config: Choreography
  /** 保存成功后回调（父组件据此立刻把新配置喂给渲染器）。 */
  onSaved: (config: Choreography, note: string) => void
  /** 关闭编辑器。 */
  onClose: () => void
  /** 实时状态一行（相位 / 当前动作 / 编排段 / 帧率）。 */
  status: string
}

/** 下拉框：可选 clip（中文名 + 英文 id），空值 = 不指定。 */
function ClipSelect(props: {
  value: string | undefined
  clips: ChoreographyEditorProps['clips']
  onChange: (next: string | undefined) => void
  allowEmpty?: boolean
  emptyLabel?: string
}): React.ReactElement {
  const { value, clips, onChange, allowEmpty = true, emptyLabel = '（不指定）' } = props
  const known = value === undefined || clips.some((clip) => clip.name === value)
  return (
    <select
      data-pet3d-choreo-clip=""
      value={value ?? ''}
      style={{ maxWidth: 150, font: '11px/1.4 system-ui, sans-serif' }}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
    >
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {!known && value !== undefined && (
        <option value={value}>{clips.length === 0 ? `${value}（清单载入中）` : `${value}（当前文件里的名字）`}</option>
      )}
      {clips.map((clip) => (
        <option key={clip.name} value={clip.name}>
          {clip.label}{clip.caution === undefined ? '' : `（${clip.caution}）`}
        </option>
      ))}
    </select>
  )
}

export function ChoreographyEditor(props: ChoreographyEditorProps): React.ReactElement {
  const { modelId, clips, config, onSaved, onClose, status } = props
  const [draft, setDraft] = useState<Choreography>(config)
  const [note, setNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showJson, setShowJson] = useState(false)

  // 外面（热换 / 重新读取文件）更新了配置就跟着刷新草稿，但正在编辑时不动它。
  useEffect(() => { setDraft(config) }, [config])

  const json = useMemo(() => `${JSON.stringify(draft, null, 2)}\n`, [draft])

  const patchBeat = (state: string, patch: Partial<Choreography['states'][keyof Choreography['states']]>): void => {
    setDraft((current) => ({
      ...current,
      states: { ...current.states, [state]: { ...current.states[state as keyof typeof current.states], ...patch } },
    }))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setNote(null)
    try {
      const response = await fetch('/api/pet3d/choreography', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId, config: draft }),
      })
      const body = await response.json() as { ok?: boolean; problems?: string[]; error?: string }
      if (!response.ok || body.ok !== true) {
        setNote(`保存失败：${body.error ?? response.status}`)
        return
      }
      const problems = body.problems ?? []
      setNote(problems.length === 0
        ? '已保存，≤2 秒自动生效'
        : `已保存，但有几处看不懂被忽略：${problems.join('；')}`)
      onSaved(draft, problems.length === 0 ? '已保存' : `已保存（${problems.length} 处被忽略）`)
    } catch (error) {
      setNote(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const style = {
    overlay: {
      position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(8,9,12,0.82)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    } as const,
    window: {
      width: 'min(920px, 94vw)', maxHeight: '88vh', overflowY: 'auto' as const,
      padding: '14px 16px', borderRadius: 10, color: '#eee',
      background: 'rgba(22,24,30,0.98)', border: '1px solid rgba(255,255,255,0.18)',
      font: '12px/1.55 system-ui, sans-serif', boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
    } as const,
    row: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } as const,
    label: { width: 52, opacity: 0.75, flex: '0 0 auto' } as const,
    button: {
      padding: '4px 10px', borderRadius: 5, cursor: 'pointer', color: '#eee',
      background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)',
      font: '12px/1.4 system-ui, sans-serif',
    } as const,
    input: { width: 70, font: '11px/1.4 system-ui, sans-serif' } as const,
  }

  return (
    <div style={style.overlay} data-pet3d-choreo-editor="">
      <div style={style.window}>
        <div style={style.row}>
          <strong style={{ flex: 1, fontSize: 13 }}>动作编排 · {modelId}</strong>
          <span style={{ opacity: 0.65, font: '11px/1.4 monospace' }}>{status}</span>
          <button type="button" style={style.button} disabled={saving} onClick={() => { void save() }}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button type="button" style={style.button} onClick={onClose}>关闭</button>
        </div>
        <div style={{ opacity: 0.7, marginBottom: 10 }}>
          改完点保存 → 写进 <code>{`$DSH_HOME/models/${modelId}/choreography.json`}</code>，≤2 秒自动生效（不用刷新、不用重启）。
          动作用"中文名（英文 id）"显示；带 <code>*</code> 的写法算通配，能一次选中多条。
        </div>

        <div style={{ marginBottom: 4, opacity: 0.85 }}>四个相位状态各做什么（起手 → 循环 × 遍数 → 收招）</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
          <thead>
            <tr style={{ opacity: 0.6, textAlign: 'left' }}>
              <th style={{ width: 60 }}>状态</th>
              <th>起手</th>
              <th>循环（动作本体）</th>
              <th>收招</th>
              <th style={{ width: 76 }}>循环遍数</th>
              <th style={{ width: 92 }}>时长 T（秒）</th>
              <th style={{ width: 104 }}>富余补法</th>
            </tr>
          </thead>
          <tbody>
            {PHASE_STATES.map((state: PhaseState) => {
              const beat = draft.states[state] ?? {}
              return (
                <tr key={state} data-pet3d-choreo-state={state}>
                  <td style={{ opacity: 0.8 }}>{STATE_LABELS[state]}</td>
                  <td>
                    <ClipSelect value={beat.enter} clips={clips} onChange={(next) => patchBeat(state, { enter: next })} />
                  </td>
                  <td>
                    <ClipSelect value={beat.loop} clips={clips} onChange={(next) => patchBeat(state, { loop: next })} />
                  </td>
                  <td>
                    <ClipSelect value={beat.exit} clips={clips} onChange={(next) => patchBeat(state, { exit: next })} />
                  </td>
                  <td>
                    <input
                      style={style.input}
                      type="number"
                      min={0}
                      step={1}
                      placeholder="一直循环"
                      value={beat.loops ?? ''}
                      onChange={(event) => patchBeat(state, { loops: event.target.value === '' ? undefined : Number(event.target.value) })}
                    />
                  </td>
                  <td>
                    {/* 用 `defaultValue`（非受控）：这样用户可以边打边试 "1小时30分" / "10s" / "90"，
                        不会因为中途那一下解析不出来就被清空。 */}
                    <input
                      style={style.input}
                      type="text"
                      placeholder="不按 T"
                      defaultValue={beat.seconds === undefined ? '' : String(beat.seconds)}
                      onChange={(event) => patchBeat(state, { seconds: parseDuration(event.target.value) })}
                    />
                  </td>
                  <td>
                    <select
                      value={beat.gap ?? ''}
                      style={{ font: '11px/1.4 system-ui, sans-serif' }}
                      onChange={(event) => patchBeat(state, { gap: event.target.value === '' ? undefined : (event.target.value as GapPolicy) })}
                    >
                      <option value="">（缺省）</option>
                      <option value="stretch">放慢收尾填满</option>
                      <option value="pause">演完停一会儿</option>
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* 「点一下宠物：从这些动作里随机演一段」整套已删除（戳一下功能取消，将来从零重写）。 */}

        <div style={{ marginTop: 12, marginBottom: 4, opacity: 0.85 }}>性能（帧率不够时用）</div>
        <div style={style.row}>
          <span style={style.label}>描边</span>
          <input
            style={style.input}
            type="number"
            min={0}
            step={0.0005}
            value={draft.render?.outlineWidth ?? 0.0025}
            onChange={(event) => setDraft((current) => ({ ...current, render: { ...current.render, outlineWidth: Number(event.target.value) } }))}
          />
          <span style={{ opacity: 0.7 }}>
            0 = 关掉描边（整模就不必再画第二遍，最省）；缺省 0.0025
          </span>
        </div>
        <div style={style.row}>
          <span style={style.label}>表情</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={draft.render?.morphs !== false}
              onChange={(event) => setDraft((current) => ({ ...current, render: { ...current.render, morphs: event.target.checked } }))}
            />
            <span style={{ opacity: 0.8 }}>启用面部形态键（29 个，关掉省顶点开销；关掉后要刷新页面才能再打开）</span>
          </label>
        </div>

        <div style={{ ...style.row, marginTop: 10 }}>
          <button type="button" style={style.button} onClick={() => setShowJson((value) => !value)}>
            {showJson ? '收起 JSON' : '看 JSON（也可以直接手改文件）'}
          </button>
          <button
            type="button"
            style={style.button}
            onClick={() => { setDraft(DEFAULT_CHOREOGRAPHY); setNote('已填入内置缺省，记得点保存') }}
          >
            恢复缺省
          </button>
        </div>
        {showJson && (
          <textarea
            readOnly
            value={json}
            style={{ width: '100%', height: 180, font: '11px/1.4 monospace', background: 'rgba(0,0,0,0.45)', color: '#cfc', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 5 }}
          />
        )}
        {note !== null && <div style={{ marginTop: 8, opacity: 0.85 }}>{note}</div>}
      </div>
    </div>
  )
}
