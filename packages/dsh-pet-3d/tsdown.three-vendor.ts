/**
 * 3D (three.js) vendor bundle config — the pet-center's fourth renderer.
 *
 * Mirrors tsdown.live2d-vendor.ts: the three.js + VRM stack ships as ONE
 * self-contained IIFE (lib/three-vendor.js) exposed as 'window.__dshPet3dThree',
 * so a sprite2d/frames2d/live2d-only installation never downloads or parses
 * this stack. The main client bundle stays untouched and the model3d renderer
 * lazy-loads this file through the plugin's own runtime route
 * ('/api/pet3d/runtime/three-vendor.js').
 *
 * Redistribution: three.js is MIT, @pixiv/three-vrm is MIT. Both may ship
 * inside this plugin.
 */
import type { UserConfig } from 'tsdown'

export function threeVendorBundle(): UserConfig {
  return {
    name: 'dsh-pet-3d/three-vendor',
    entry: { 'three-vendor': 'src/client/renderers/model3d/vendor-entry.ts' },
    outDir: 'lib',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    // Third-party stable code: minify to keep the published tarball lean
    // (unlike first-party bundles, vendor internals have no profiling value).
    minify: true,
    clean: false,
    // Self-contained: the vendor file loads as a plain script tag with no
    // module table, so every dependency inlines.
    external: [],
    noExternal: [/.*/],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'three-vendor.js',
      // Classic-script top-level var: becomes window.__dshPet3dThree.
      name: '__dshPet3dThree',
    },
  }
}
