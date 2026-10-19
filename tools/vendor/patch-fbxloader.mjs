/**
 * 生成一份「容错版 FBXLoader」——用来读那些带**退化网格**的第三方 FBX。
 *
 * 起因（2026-10-19 的交付）：`body_top2`（"不戴面罩"的空状态）被导出成
 * **3 个顶点、0 个多边形、没有 Normal 数组**的占位网格。three 的 FBXLoader 在
 * `parseNormals` 里直接读 `NormalNode.Normals.a` ⇒ `undefined.a` ⇒ 整个 FBX 解析失败。
 *
 * 这个脚本把原生 FBXLoader 复制成同目录的 `FBXLoader.tolerant.js`（必须同目录，
 * 因为它用相对路径 import fflate / NURBSCurve），只改两处：
 *   1. `Normals.a` → `Normals?.a ?? []`
 *   2. 法线为空时不挂 `normal` 属性（退化网格照样能过，只是没有法线）
 *
 * 幂等；依赖升级后重跑一次即可。`tools/pet3d-import.mjs` 会优先加载它。
 *
 * 用法：node tools/vendor/patch-fbxloader.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const loaders = join(repo, 'tools', 'node_modules', 'three', 'examples', 'jsm', 'loaders')
const source = join(loaders, 'FBXLoader.js')
const target = join(loaders, 'FBXLoader.tolerant.js')

if (!existsSync(source)) {
  console.error(`找不到原生 FBXLoader：${source}`)
  process.exit(2)
}

let text = readFileSync(source, 'utf8')
const before = text

const normalsPatch = text.replace(
  'const buffer = NormalNode.Normals.a;',
  'const buffer = NormalNode.Normals?.a ?? []; // tolerant: 退化网格没有 Normals 数组',
)
if (normalsPatch === text) {
  console.warn('提示：没找到 parseNormals 的 `Normals.a` 行（three 版本变了？），这一处没改')
} else {
  text = normalsPatch
}

const assignPatch = text.replace(
  'geoInfo.normal = this.parseNormals( geoNode.LayerElementNormal[ 0 ] );',
  [
    'const parsedNormals = this.parseNormals( geoNode.LayerElementNormal[ 0 ] );',
    '\t\t\tif ( parsedNormals.buffer.length > 0 ) geoInfo.normal = parsedNormals; // tolerant: 空法线不挂属性',
  ].join('\n'),
)
if (assignPatch === text) {
  console.warn('提示：没找到 geoInfo.normal 赋值行，这一处没改')
} else {
  text = assignPatch
}

if (text === before) {
  console.error('两处都没改成功：three 的 FBXLoader 结构可能变了，请检查。')
  process.exit(1)
}

writeFileSync(target, text, 'utf8')
console.log(`已写出容错版：${target}`)
console.log('回归：node tools/pet3d-import.mjs <模型目录> --force')
