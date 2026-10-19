/**
 * 开发者模式 —— 宠物身上那套检查面板（小方块 → 动作面板）与渲染仪表的开关。
 *
 * 为什么存在：面板本来是给人"调动作"的，普通使用时会挡视线；用户要求把它
 * **收进应用内设置**（设置 → 3D 桌宠 → 开发者），关着的时候宠物身上什么都不出现。
 *
 * 存放在 localStorage（键沿用早已存在的 `dshPet3dDebug`）而不是插件 Config：
 *  - 这是**每一页浏览器**的界面偏好，不影响宿主行为；
 *  - 读取必须是同步的 —— 点宠物的那一刻就要判断，等不了一次配置往返；
 *  - 键名沿用旧调试开关，`tools/probe-acts.mjs` 这类探针照旧能先塞
 *    `localStorage.dshPet3dDebug = '1'` 就把仪表和面板一起打开。
 *
 * 监听者是模块级单例：宠物根与设置页是两棵 React 根，但共用同一个 bundle 模块实例，
 * 所以一条 `setDevMode` 能让两边同时刷新（同标签页的 `storage` 事件不会触发，故不依赖它）。
 * @module dsh-pet-3d/client/dev-mode
 */

import { useSyncExternalStore } from 'react'

/** localStorage 键（历史名，别改：探针脚本按它塞开关）。 */
export const DEV_MODE_KEY = 'dshPet3dDebug'

/** 进程内缓存，localStorage 不可用（无痕/被禁）时也能坚持到刷新。 */
let cached: boolean | undefined

/** 开关变化的所有订阅者。 */
const listeners = new Set<() => void>()

/** 读当前开关（同步、只读一次 localStorage）。 */
export function devModeEnabled(): boolean {
  if (cached !== undefined) return cached
  try {
    cached = window.localStorage.getItem(DEV_MODE_KEY) === '1'
  } catch {
    cached = false
  }
  return cached
}

/** 写开关并通知所有订阅者。 */
export function setDevMode(next: boolean): void {
  if (devModeEnabled() === next) return
  cached = next
  try {
    if (next) window.localStorage.setItem(DEV_MODE_KEY, '1')
    else window.localStorage.removeItem(DEV_MODE_KEY)
  } catch {
    // 存不下来就只在本页生效：关掉面板仍然有效，不会因此把面板重新弹出来。
  }
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 一个订阅者抛错不该让别的订阅者失联。
    }
  }
}

/** 订阅开关变化；返回退订函数。 */
export function subscribeDevMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** React 绑定：读到开关的变化。 */
export function useDevMode(): boolean {
  return useSyncExternalStore(subscribeDevMode, devModeEnabled, devModeEnabled)
}
