/**
 * model3d visual mount — the React bridge between the stage and the imperative
 * model3d renderer.
 *
 * The bridge owns three things: one activation per model IDENTITY, the polled
 * phase state fed into the activation's stream, and the hot-swap push.
 *
 * The two effects below are deliberately split, and the split is the whole
 * hot-swap design:
 *
 *  - the MOUNT effect keys on the model ID only, so a re-import never tears the
 *    activation down (which would blank the pet, drop the camera and re-download
 *    everything);
 *  - the UPDATE effect keys on the view's CONTENT — revision, hashed URLs,
 *    artifact digests, framing — and hands it to `handle.update()`, which swaps
 *    exactly what moved. A poll that changes nothing produces the same signature
 *    and therefore costs one string compare.
 * @module dsh-pet-3d/client/renderers/model3d/Model3dVisualMount
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { mountModel3d, type Model3dErrorCode, type Model3dHandle, type SwapKindName } from '../model3d.ts'
import type { PetDefinition } from '../../../model.ts'
import type { PhaseState } from '../../../state.ts'
import { createPhaseStream, type PhaseStream } from '../../phase-stream.ts'
import { devModeEnabled, useDevMode } from '../../dev-mode.ts'

/** The renderer failure copy this bridge asks its caller for. */
export type Model3dErrorKey = 'pet.model3d.vendor-missing' | 'pet.model3d.load-failed'

/**
 * Whether the on-screen debug instrument was switched on for this page.
 *
 * 就是设置页里的「开发者模式」（`dev-mode.ts`，localStorage 键 `dshPet3dDebug`）：
 * 仪表和检查面板是同一件事的两半，共用一个开关。
 */
function debugEnabled(): boolean {
  return devModeEnabled()
}

/** Mount the model3d renderer as the pet's visual. */
export function Model3dVisualMount(props: {
  definition: PetDefinition
  phase: PhaseState
  t: (key: Model3dErrorKey) => string
  /**
   * Hands the activation handle up so the inspection panel can aim the camera,
   * list the clips, play them and read the swap state. Called with the handle
   * after mount and with null on teardown, so the caller never keeps a disposed
   * handle.
   */
  onHandle?: (handle: Model3dHandle | null) => void
}): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const streamRef = useRef<PhaseStream | null>(null)
  const handleRef = useRef<Model3dHandle | null>(null)
  const [error, setError] = useState<Model3dErrorCode | null>(null)
  const [debugLine, setDebugLine] = useState<string | null>(null)
  /** 开发者模式开关（设置 → 3D 桌宠 → 开发者）：仪表跟着它即时开关。 */
  const devMode = useDevMode()

  /** Content signature of the VIEW — deliberately not the object identity. */
  const viewSignature = JSON.stringify(props.definition.model3d)
  const modelId = props.definition.id

  // One activation per model IDENTITY: a re-import must never rebuild it.
  useEffect(() => {
    setError(null)
    const container = containerRef.current
    if (container === null) return undefined
    streamRef.current ??= createPhaseStream(props.phase)
    const handle = mountModel3d({
      container,
      view: props.definition.model3d,
      phase: streamRef.current,
    })
    handleRef.current = handle
    handle.onError(setError)
    props.onHandle?.(handle)
    return () => {
      handleRef.current = null
      props.onHandle?.(null)
      handle.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one activation per model IDENTITY
  }, [modelId])

  // Push every view change into the live activation; it decides the granularity.
  useEffect(() => {
    const handle = handleRef.current
    if (handle === null) return
    void handle.update(props.definition.model3d).catch(() => {
      // Recorded on the handle (swapError) and surfaced by the panel; a failed
      // hot swap must never escape as an unhandled rejection.
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the content signature IS the change
  }, [viewSignature])

  // Feed the polled state into the activation's stream (change-only).
  useEffect(() => {
    streamRef.current?.push(props.phase)
  }, [props.phase])

  // The on-screen instrument, only when asked for. It follows the settings page's
  // developer switch live: flipping it off removes the overlay and the probe seam.
  useEffect(() => {
    if (!debugEnabled()) return undefined
    const read = (): void => setDebugLine(handleRef.current?.debug?.() ?? null)
    read()
    const timer = window.setInterval(read, 500)
    /**
     * ★ 探针出口（只在调试开关打开时才存在）：把渲染器仪表**按帧**交出去。
     *
     * DOM 里那份 500ms 才刷一次，抓不到 220ms 的交叉淡入淡出窗口 —— 而"两个动作在打架"
     * 恰恰要在这个尺度上判。无头浏览器（`tools/probe-acts.mjs`）每帧调它，就能把
     * "此刻有几个动作在驱动骨架、各自权重多少"从推断变成数字。
     */
    const host = window as unknown as { __pet3dProbe?: () => string | null }
    host.__pet3dProbe = () => handleRef.current?.debug?.() ?? null
    return () => {
      window.clearInterval(timer)
      delete host.__pet3dProbe
    }
  }, [devMode])

  return (
    <div
      ref={containerRef}
      data-pet3d-model3d={props.definition.id}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      {error !== null && (
        <span data-pet3d-model3d-error={error} style={{ color: '#f88', fontSize: 12 }}>
          {props.t(error === 'vendor-missing' ? 'pet.model3d.vendor-missing' : 'pet.model3d.load-failed')}
        </span>
      )}
      {debugLine !== null && (
        <pre
          data-pet3d-debug=""
          style={{
            position: 'absolute', left: 0, bottom: 0, margin: 0,
            font: '10px/1.2 monospace', color: '#8f8', background: 'rgba(0,0,0,0.55)',
            padding: '2px 4px', pointerEvents: 'none', whiteSpace: 'pre-wrap',
          }}
        >
          {debugLine}
        </pre>
      )}
    </div>
  )
}

/** The swap kind, for the panel's readout (re-exported to keep one import site). */
export type { SwapKindName }
