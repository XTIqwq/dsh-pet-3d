/**
 * 宠物悬浮菜单 —— 宠物正中间那只小熊（🐻）点开的卡片。
 *
 * 和「设置 → 3D 桌宠」是两件事，别混：
 *  - 设置页是**配置**（大小、位置、选模型、重新导入、开发者开关），进去要离开宠物；
 *  - 这张卡片是**随手操作**（换整套外观、穿脱配饰），就贴在宠物旁边，点两下就完。
 *
 * 位置：优先贴在宠物**左侧**（右边留给宠物自己），左边放不下就翻到右侧；纵向按宠物
 * 顶端对齐并夹在视口内。宠物被拖动时卡片跟着走 —— 锚点是每次渲染重算的。
 *
 * 数据：`appearance.json`（模型目录里，见 `appearance.ts`）。没有这个文件的模型
 * 就只显示「整套外观」，不编造配饰按钮 —— 宁可少一块，也不给一个点了没反应的开关。
 *
 * 扩展位：「互动」这一节留给下一步（摸摸头 / 喂食 / 说话气泡）。现在只放一行说明，
 * 不放假按钮：假按钮点下去没反应，比没有更糟。
 *
 * **边界**：这张卡片是**给用户用的**，不承载开发者 UI —— 检查面板（动作/相位/编排）
 * 仍然由"开发者模式 + 点宠物"打开（`PetStage` 里那条路），不要塞进这里。
 * @module dsh-pet-3d/client/PetMenu
 */

import { useMemo, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { Appearance, AppearanceGroup, AppearancePiece } from './appearance.ts'
import { pieceHidden, selectedOptionId } from './appearance.ts'
import type { InteractionAction, Interactions } from './interactions.ts'

/** 卡片宽度，px。与 `PetStage` 的定位逻辑共用（导出让两边不会各写一个数）。 */
export const PET_MENU_WIDTH = 268

/** 宠物方框在视口里的位置（`position: fixed` 坐标系）。 */
export interface PetMenuAnchor {
  /** 方框左边缘。 */
  left: number
  /** 方框上边缘。 */
  top: number
  /** 方框边长。 */
  size: number
}

/** 「整套外观」里的一行。 */
export interface PetMenuModel {
  id: string
  label: string
}

const cardStyle: CSSProperties = {
  position: 'fixed',
  width: PET_MENU_WIDTH,
  // 宽度/高度都按"含内边距"算：定位用的是 PET_MENU_WIDTH，两套算法必须一致，
  // 否则卡片会比算出来的宽 24px，贴着宠物时压上去（守卫第一轮就是这么抓到的）。
  boxSizing: 'border-box',
  zIndex: 42,
  display: 'flex',
  flexDirection: 'column',
  padding: '10px 12px 12px',
  font: '12px/1.5 system-ui, sans-serif',
  color: '#eee',
  background: 'rgba(18,20,26,0.95)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 10,
  boxShadow: '0 10px 32px rgba(0,0,0,0.5)',
  // 卡片本身不参与拖动：宠物是"按住拖"的，卡片里要能正常点按钮、拉滚动条。
  pointerEvents: 'auto',
}

const titleStyle: CSSProperties = { fontWeight: 600, fontSize: 13, letterSpacing: 0.2 }
const noteStyle: CSSProperties = { opacity: 0.6, fontSize: 11, lineHeight: 1.45, margin: '2px 0 0' }
const dividerStyle: CSSProperties = { border: 0, borderTop: '1px solid rgba(255,255,255,0.12)', margin: '9px 0' }
const iconButtonStyle: CSSProperties = {
  width: 22, height: 22, padding: 0, flex: '0 0 auto', borderRadius: 6, cursor: 'pointer',
  font: '13px/1 system-ui, sans-serif', color: '#ddd',
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.16)',
}
const chipStyle: CSSProperties = {
  font: '11px/1.4 system-ui, sans-serif', padding: '3px 9px', borderRadius: 999, cursor: 'pointer',
  color: '#e8e8e8', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.18)',
}
const chipActiveStyle: CSSProperties = {
  ...chipStyle,
  background: 'rgba(120,200,255,0.26)',
  borderColor: 'rgba(120,200,255,0.62)',
  color: '#fff',
}
const smallButtonStyle: CSSProperties = {
  font: '11px/1.4 system-ui, sans-serif', padding: '2px 8px', borderRadius: 5, cursor: 'pointer',
  color: '#ddd', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)',
}

/** 一行小标题。 */
function Section(props: { title: string; hint?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '0 0 6px' }}>
        <span style={{ ...titleStyle, fontSize: 12 }}>{props.title}</span>
        {props.hint !== undefined && <span style={{ ...noteStyle, margin: 0 }}>{props.hint}</span>}
      </div>
      {props.children}
    </section>
  )
}

/** 开关：整行可点，状态用 `aria-checked` 表达（守卫按它断言）。 */
function PieceRow(props: {
  piece: AppearancePiece
  hidden: boolean
  /** 传的是"接下来要不要脱"（true = 脱下来）；调用方按它增删节点。 */
  onSetHidden: (hidden: boolean) => void
}): ReactElement {
  const on = !props.hidden
  return (
    <div
      data-pet3d-piece={props.piece.id}
      data-pet3d-piece-on={on ? '1' : '0'}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}
    >
      <span style={{ flex: 1, opacity: on ? 1 : 0.55 }}>{props.piece.label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${props.piece.label}${on ? '（穿着）' : '（已脱下）'}`}
        title={on ? '点一下脱下来' : '点一下穿回去'}
        onClick={() => props.onSetHidden(on)}
        style={{
          width: 34, height: 18, padding: 0, flex: '0 0 auto', borderRadius: 999, cursor: 'pointer',
          position: 'relative', transition: 'background .15s ease',
          background: on ? 'rgba(120,200,255,0.55)' : 'rgba(255,255,255,0.14)',
          border: '1px solid rgba(255,255,255,0.22)',
        }}
      >
        <span
          style={{
            position: 'absolute', top: 1, left: on ? 17 : 1, width: 14, height: 14, borderRadius: '50%',
            background: on ? '#fff' : '#b9c0cc', transition: 'left .15s ease',
          }}
        />
      </button>
    </div>
  )
}

/** 悬浮菜单本体（受控：所有状态在 `PetStage` 里）。 */
export function PetMenu(props: {
  /** 宠物方框的位置（卡片据此贴到旁边）。 */
  anchor: PetMenuAnchor
  /** 当前模型 id。 */
  modelId: string
  /** 当前模型的显示名（`appearance.json` 的 title，缺省是 id）。 */
  title: string
  /** 「整套外观」可选项（已安装的模型）。 */
  models: PetMenuModel[]
  /** 当前模型的配饰表；null = 这个模型没有 `appearance.json`。 */
  appearance: Appearance | null
  /** 配饰表读过了没：`false` = 还在拉，显示"正在读取"而不是"没有配饰"。 */
  appearanceKnown: boolean
  /** 配饰表的问题（有就折叠显示，不静默）。 */
  appearanceProblems: string[]
  /** 已被脱下的节点名。 */
  hidden: readonly string[]
  onTogglePiece: (piece: AppearancePiece, next: boolean) => void
  onSetAll: (hidden: boolean) => void
  /** 换一款（同组互斥）。 */
  onSelectGroup: (group: AppearanceGroup, optionId: string) => void
  onSelectModel: (id: string) => void
  /** 当前模型的互动表；null = 这个模型没配互动（菜单显示说明，不放空按钮）。 */
  interactions: Interactions | null
  /** 互动表读过了没：`false` = 还在拉，显示"正在读取"。 */
  interactionsKnown: boolean
  /** 互动表的问题（有就折叠显示，不静默）。 */
  interactionsProblems: string[]
  /** 当前好感度与上限（进度条）。 */
  affinity: number
  affinityMax: number
  /** 刚说完、正在淡出的那一句台词；null = 不显示气泡。 */
  bubble: string | null
  /** 正在冷却（2 秒内点过）的动作 id。 */
  cooling: readonly string[]
  onInteract: (action: InteractionAction) => void
  onClose: () => void
}): ReactElement {
  // 锚点：左侧优先，放不下翻到右边，再不行就贴着视口左边；纵向夹在视口内。
  const position = useMemo(() => {
    const { left, top, size } = props.anchor
    const gap = 10
    const margin = 8
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    let x = left - gap - PET_MENU_WIDTH
    if (x < margin) {
      x = left + size + gap
      if (x + PET_MENU_WIDTH > viewportW - margin) x = Math.max(margin, viewportW - margin - PET_MENU_WIDTH)
    }
    const y = Math.min(Math.max(margin, top), Math.max(margin, viewportH - 180))
    return { left: x, top: y, maxHeight: Math.max(160, viewportH - y - margin) }
  }, [props.anchor])

  const pieces = props.appearance?.pieces ?? []
  const groups = props.appearance?.groups ?? []
  const hiddenSet = new Set(props.hidden)
  const wornCount = pieces.filter(piece => !pieceHidden(piece, [...hiddenSet])).length

  return (
    <div
      data-pet3d-menu=""
      style={{ ...cardStyle, left: position.left, top: position.top, maxHeight: position.maxHeight }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
        <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1 }}>🐻</span>
        <strong style={titleStyle}>{props.title}</strong>
        <span style={{ opacity: 0.45, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {props.modelId}
        </span>
        <button type="button" style={iconButtonStyle} onClick={props.onClose} aria-label="关闭菜单" title="关闭（Esc）">
          ✕
        </button>
      </div>

      <hr style={dividerStyle} />

      <div style={{ overflowY: 'auto', flex: '1 1 auto', paddingRight: 2 }}>
        <Section title="整套外观" hint="等于换一个模型">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {props.models.map(model => {
              const active = model.id === props.modelId
              return (
                <button
                  key={model.id}
                  type="button"
                  data-pet3d-menu-model={model.id}
                  data-pet3d-menu-model-active={active ? '1' : '0'}
                  style={active ? chipActiveStyle : chipStyle}
                  onClick={() => { if (!active) props.onSelectModel(model.id) }}
                  title={active ? '当前穿着' : `换上「${model.label}」`}
                >
                  {model.label}
                </button>
              )
            })}
            {props.models.length <= 1 && <span style={noteStyle}>只装了一个模型</span>}
          </div>
        </Section>

        <hr style={dividerStyle} />

        {groups.length > 0 && (
          <>
            <Section title="款式" hint="同一组只穿一件">
              {groups.map(group => {
                const active = selectedOptionId(group, props.hidden)
                return (
                  <div key={group.id} data-pet3d-group={group.id} style={{ marginBottom: 7 }}>
                    <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 3 }}>{group.label}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {group.options.map(option => {
                        const on = active === option.id
                        return (
                          <button
                            key={option.id}
                            type="button"
                            data-pet3d-group-option={option.id}
                            data-pet3d-group-option-active={on ? '1' : '0'}
                            style={on ? chipActiveStyle : chipStyle}
                            onClick={() => { if (!on) props.onSelectGroup(group, option.id) }}
                            title={on ? '正在穿这款' : `换上「${option.label}」`}
                          >
                            {option.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </Section>

            <hr style={dividerStyle} />
          </>
        )}

        <Section
          title="配饰"
          hint={pieces.length === 0 ? undefined : `穿着 ${wornCount} / ${pieces.length}`}
        >
          {!props.appearanceKnown
            ? <p style={noteStyle}>正在读取配饰表…</p>
            : props.appearance === null
              ? (
                <p style={noteStyle}>
                  这个模型还没有配饰表。把 <code style={{ opacity: 0.9 }}>appearance.json</code> 放进模型目录
                  就能出现穿脱开关（格式见 <code style={{ opacity: 0.9 }}>docs</code>）。
                </p>
              )
              : pieces.length === 0
                ? <p style={noteStyle}>配饰表是空的：这个模型没有可以脱下来的东西。</p>
                : (
                  <>
                    <div data-pet3d-piece-count={pieces.length}>
                      {pieces.map(piece => (
                        <PieceRow
                          key={piece.id}
                          piece={piece}
                          hidden={pieceHidden(piece, [...hiddenSet])}
                          onSetHidden={(hide) => props.onTogglePiece(piece, hide)}
                        />
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button
                        type="button"
                        style={smallButtonStyle}
                        data-pet3d-wear-all=""
                        onClick={() => props.onSetAll(false)}
                        title="把所有配饰都穿回去"
                      >
                        全部穿上
                      </button>
                      <button
                        type="button"
                        style={smallButtonStyle}
                        data-pet3d-strip-all=""
                        onClick={() => props.onSetAll(true)}
                        title="把配饰全脱了（身体和脸不在此列）"
                      >
                        全部脱下
                      </button>
                    </div>
                  </>
                )}
        </Section>

        <hr style={dividerStyle} />

        <Section
          title="互动"
          hint={
            props.interactions === null
              ? undefined
              : `好感度 ${props.affinity} / ${props.affinityMax}`
          }
        >
          {!props.interactionsKnown
            ? <p style={noteStyle}>正在读取互动表…</p>
            : props.interactions === null
              ? (
                <p data-pet3d-interactions-empty="" style={noteStyle}>
                  这个模型还没配互动。把 <code style={{ opacity: 0.9 }}>interactions.json</code> 放进模型目录
                  就能出现按钮（格式见 <code style={{ opacity: 0.9 }}>docs</code>）。
                </p>
              )
              : (
                <>
                  <div data-pet3d-interaction-count={props.interactions.actions.length} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {props.interactions.actions.map(action => {
                      const cooling = props.cooling.includes(action.id)
                      return (
                        <button
                          key={action.id}
                          type="button"
                          data-pet3d-interaction={action.id}
                          data-pet3d-interaction-cooling={cooling ? '1' : '0'}
                          disabled={cooling}
                          style={cooling ? { ...chipStyle, opacity: 0.45, cursor: 'not-allowed' } : chipStyle}
                          title={cooling ? '刚点过，喘口气（2 秒）' : `${action.label}：播「${action.clip}」`}
                          onClick={() => { if (!cooling) props.onInteract(action) }}
                        >
                          {action.label}
                        </button>
                      )
                    })}
                  </div>

                  {props.bubble !== null && (
                    <div
                      data-pet3d-interaction-line=""
                      style={{
                        marginTop: 7, padding: '5px 9px', borderRadius: 8,
                        background: 'rgba(120,200,255,0.16)', border: '1px solid rgba(120,200,255,0.42)',
                        color: '#eaf6ff', fontSize: 11, lineHeight: 1.45, transition: 'opacity .3s ease',
                      }}
                    >
                      {props.bubble}
                    </div>
                  )}

                  <div
                    data-pet3d-affinity={props.affinity}
                    data-pet3d-affinity-max={props.affinityMax}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={props.affinityMax}
                    aria-valuenow={props.affinity}
                    aria-label="好感度"
                    style={{ marginTop: 8, height: 5, borderRadius: 999, overflow: 'hidden', background: 'rgba(255,255,255,0.12)' }}
                  >
                    <div
                      style={{
                        width: `${props.affinityMax > 0 ? Math.min(100, Math.round((props.affinity / props.affinityMax) * 100)) : 0}%`,
                        height: '100%', borderRadius: 999, transition: 'width .25s ease',
                        background: 'linear-gradient(90deg, rgba(120,200,255,0.75), rgba(255,150,200,0.85))',
                      }}
                    />
                  </div>
                </>
              )}

          {props.interactionsProblems.length > 0 && (
            <details data-pet3d-interaction-problems={props.interactionsProblems.length} style={{ marginTop: 6, opacity: 0.7 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11 }}>
                互动表有问题（{props.interactionsProblems.length}）
              </summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                {props.interactionsProblems.slice(0, 6).map(line => <li key={line} style={{ marginBottom: 2 }}>{line}</li>)}
              </ul>
            </details>
          )}
        </Section>

        {props.appearanceProblems.length > 0 && (
          <details data-pet3d-menu-problems={props.appearanceProblems.length} style={{ marginTop: 8, opacity: 0.7 }}>
            <summary style={{ cursor: 'pointer', fontSize: 11 }}>
              配饰表有问题（{props.appearanceProblems.length}）
            </summary>
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {props.appearanceProblems.slice(0, 6).map(line => <li key={line} style={{ marginBottom: 2 }}>{line}</li>)}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}
