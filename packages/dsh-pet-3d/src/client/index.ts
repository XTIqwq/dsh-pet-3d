/**
 * dsh-pet-3d browser half — mounts the pet surface onto `document.body`, and
 * seats the plugin's own settings page in the shell's settings dialog.
 *
 * The pet is host-global (its state, display and media are plain '/api/pet3d/*'
 * endpoints with no session dimension), so it mounts directly onto the body
 * instead of through a session-scoped slot: a per-session mount would reset the
 * pet on every session switch and leave it missing on the new-conversation
 * screen.
 *
 * The settings page is a `settings.section` slot entry (a first-level page in
 * the app's settings). It is registered through `ctx.inject` rather than a
 * top-level `inject` declaration on purpose: if a deployment serves no `slots`
 * or `configForms` service, the pet must still mount — only the settings page
 * goes missing. A top-level `inject` would hold the whole plugin back instead.
 * @module dsh-pet-3d/client
 */

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Pet3dSettingsSection, type SettingsFormLike } from './SettingsSection.tsx'
import { PetStage } from './PetStage.tsx'

/** Stable plugin name (must match the host half and cordis.patch.yml). */
export const name = 'pet3d'

/** Client services this half needs to mount the pet: none, by design. */
export const inject: readonly string[] = []

/** Page-global slot marker: one pet mount per page, across bundle reloads. */
const ROOT_ATTR = 'data-pet3d-root'

/** Settings page id (the `settings.section` entry) and its nav order. */
const SETTINGS_SECTION_ID = 'pet3d'
const SETTINGS_SECTION_ORDER = 145
/** The label the settings nav shows for this plugin. */
const SETTINGS_SECTION_LABEL = '3D 桌宠'

/** One settings-section entry as the slot registry takes it. */
interface SlotRegistration {
  name: string
  id: string
  order: number
  label: () => string
  inject?: () => { settings?: SettingsFormLike }
}

/** The `slots` client service, as far as this half uses it. */
interface SlotsService {
  inject(name: string, factory: () => (() => void) | undefined): void
  register(options: SlotRegistration, component: unknown): () => void
}

/** The `configForms` client service (a plugin's settings ARE its Config). */
interface ConfigFormsService {
  get(namespace: string): SettingsFormLike | undefined
}

/** The slice of the cordis client context this half uses. */
export interface ClientContext {
  effect(fn: () => (() => void) | void, label?: string): void
  /**
   * Run a callback once these services exist (cordis `ctx.inject`).
   *
   * Optional in the shape because the pet mount must not depend on it: when a
   * shell provides no `inject` seam, the plugin simply has no settings page.
   */
  inject?(deps: readonly string[], callback: (scoped: ClientContext & {
    slots?: SlotsService
    configForms?: ConfigFormsService
  }) => void): void
}

/**
 * Register the plugin's settings page as a first-level settings section.
 *
 * Every step is defensive: a shell that lacks `slots`/`configForms`, or a
 * registry that refuses the entry, must cost the settings page and nothing
 * else — the pet is already mounted by the time this runs.
 * @param ctx - the client plugin context.
 */
function mountSettingsPage(ctx: ClientContext): void {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['slots', 'configForms'], (scoped) => {
    const slots = scoped.slots
    if (slots === undefined) return
    try {
      slots.inject('settings.section', () => {
        try {
          return slots.register({
            name: 'settings.section',
            id: SETTINGS_SECTION_ID,
            order: SETTINGS_SECTION_ORDER,
            label: () => SETTINGS_SECTION_LABEL,
            inject: () => {
              let settings: SettingsFormLike | undefined
              try {
                settings = scoped.configForms?.get(SETTINGS_SECTION_ID)
              } catch {
                settings = undefined
              }
              return { settings }
            },
          }, Pet3dSettingsSection)
        } catch {
          return () => {}
        }
      })
    } catch {
      // No settings surface in this shell: the pet is unaffected.
    }
  })
}

/** Mount the pet surface (and the settings page) for the lifetime of this plugin fiber. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    // Take over the page-global slot FIRST: during a client reload the previous
    // bundle instance's fiber may still be draining, and its container would
    // otherwise survive as a second, unmovable pet.
    for (const stale of Array.from(document.querySelectorAll(`div[${ROOT_ATTR}]`))) {
      stale.remove()
    }
    const container = document.createElement('div')
    container.setAttribute(ROOT_ATTR, '')
    container.dataset.dshPlugin = name
    document.body.appendChild(container)
    const root = createRoot(container)
    root.render(createElement(PetStage))
    return () => {
      root.unmount()
      container.remove()
    }
  }, 'pet3d: stage')

  // The settings page rides its own fiber requirement (see mountSettingsPage).
  ctx.effect(() => {
    mountSettingsPage(ctx)
  }, 'pet3d: settings page')
}
