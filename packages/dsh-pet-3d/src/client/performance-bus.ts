/**
 * 演出命令总线 —— 设置页（演出编排器）→ 宠物根（PetStage）→ 渲染器 handle。
 *
 * 为什么需要它：设置对话框和宠物是**两棵独立的 React 根**（设置页在壳的 slot 里，
 * 宠物直接挂在 `document.body` 上），而"试播一段演出"必须落到**正在跑的那个渲染器**
 * 上 —— 只有宠物那棵树手里有 handle。所以走一条模块级的小总线：两边共用同一个
 * bundle 模块实例，一条命令就能从设置页传到渲染器，不需要宿主中转、也不占 HTTP。
 *
 * 单向、极简：只承载"演这个"和"停下"两种意图，不承载状态。
 * @module dsh-pet-3d/client/performance-bus
 */

import type { PetPerformanceStep } from '../choreography.ts'

/** 一次"演这套"的请求（`id` 只用于显示）。 */
export interface PerformanceRequest {
  /** 演出 id（配置文件里的键）。 */
  id: string
  /** 显示名（缺省用 id）。 */
  name?: string
  /** 步骤（编排器写具体 clip 名；通配也支持，由渲染器展开）。 */
  steps: readonly PetPerformanceStep[]
}

/** 监听签名：`null` 表示"停下"。 */
type Listener = (request: PerformanceRequest | null) => void

/** 监听者（PetStage 在挂载时订阅）。 */
const listeners = new Set<Listener>()

/** 把一条命令发给所有订阅者；一个订阅者抛错不影响其他人。 */
function dispatch(request: PerformanceRequest | null): void {
  for (const listener of [...listeners]) {
    try {
      listener(request)
    } catch {
      // 设置页/宠物任一侧坏掉，不该连带另一侧。
    }
  }
}

/** 订阅演出命令；返回退订函数。 */
export function subscribePerformanceRequests(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 让宠物立刻演这套（没人订阅时静默丢弃：宠物没挂载时本来也没东西可演）。 */
export function requestPerformance(request: PerformanceRequest): void {
  dispatch(request)
}

/** 让宠物停下正在演的演出（回当前相位）。 */
export function requestPerformanceStop(): void {
  dispatch(null)
}
