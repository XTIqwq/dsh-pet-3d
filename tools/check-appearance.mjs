/**
 * 配饰表（`appearance.json`）离线校验器 —— 只读，不改任何东西。
 *
 * 查的是"表和数据对不对得上"，因为这类错误在屏幕上很难看出来：
 *  - 节点名写错一个字 ⇒ 菜单里那件配饰点了没反应（渲染器按名字找不到就跳过），
 *    看起来像"功能坏了"，其实是数据问题；
 *  - 把节点写成**组节点**（`ModBodyGroups`）⇒ 一次脱掉整组，比想脱的多；
 *  - 把身体/脸写进 pieces ⇒ 菜单里多出一个"让宠物消失"的开关（踩过：`body_low0` 是全身）。
 *
 * 用法：
 *   node tools/check-appearance.mjs                 # 扫 $DSH_HOME/models 下所有模型
 *   node tools/check-appearance.mjs --model <模型 id>
 *   node tools/check-appearance.mjs --json          # 机器可读
 *
 * 退出码：0 = 全部通过；1 = 有错误；2 = 用法/环境问题（比如模型目录不存在）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseAppearance } from '../packages/dsh-pet-3d/src/client/appearance.ts'

const DSH_HOME = process.env.DSH_HOME ?? 'D:\\.dsh'
const MODELS = join(DSH_HOME, 'models')

/** `--flag value` / `--flag`。 */
function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const JSON_OUT = process.argv.includes('--json')
const ONLY = typeof flag('model', null) === 'string' ? flag('model', null) : null

/** 读 GLB 的 JSON 块（不加载几何，秒级）。 */
function readGlbJson(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB（magic 不对）')
  const jsonLength = buf.readUInt32LE(12)
  return JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'))
}

/** 节点名 → 该节点的网格顶点数；只有挂 mesh 的节点才算"网格节点"。 */
function meshNodeVertices(gltf) {
  const out = new Map()
  for (const node of gltf.nodes ?? []) {
    if (node.mesh === undefined) continue
    const mesh = gltf.meshes?.[node.mesh]
    if (mesh === undefined) continue
    let vertices = 0
    for (const primitive of mesh.primitives ?? []) {
      const accessor = gltf.accessors?.[primitive.attributes?.POSITION]
      vertices = Math.max(vertices, accessor?.count ?? 0)
    }
    out.set(node.name ?? `#${node.name}`, { vertices, primitives: mesh.primitives?.length ?? 0 })
  }
  return out
}

/** 一个模型目录的检查结果。 */
function checkModel(id) {
  const dir = join(MODELS, id)
  const errors = []
  const notes = []
  const file = join(dir, 'appearance.json')
  const glbFile = join(dir, '.import', 'model.glb')
  if (!existsSync(glbFile)) {
    return { id, skipped: true, errors: [], notes: ['没有 .import/model.glb（还没导入过），跳过'] }
  }
  const gltf = readGlbJson(glbFile)
  const meshes = meshNodeVertices(gltf)
  const totalVertices = [...meshes.values()].reduce((sum, info) => sum + info.vertices, 0)
  /** 主体网格 = 顶点最多的那个。做成开关等于给用户一个"让宠物消失"的按钮。 */
  let body = null
  for (const [name, info] of meshes) {
    if (body === null || info.vertices > body.vertices) body = { name, vertices: info.vertices }
  }
  if (!existsSync(file)) {
    return {
      id,
      errors,
      notes: [...notes, '没有 appearance.json：这个模型在悬浮菜单里只有「整套外观」，没有配饰开关'],
    }
  }
  let parsed
  try {
    parsed = parseAppearance(JSON.parse(readFileSync(file, 'utf8')), `${id}/appearance.json`)
  } catch (error) {
    return { id, errors: [`appearance.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`], notes }
  }
  const { appearance, problems } = parsed
  for (const problem of problems) errors.push(problem)
  if (appearance.pieces.length === 0 && appearance.groups.length === 0) {
    errors.push('pieces 与 groups 都是空的：配饰表存在但没有可切换的东西')
  }
  /** 每一条声明（配饰 / 款式选项 / 永远隐藏）都要能落到一个**网格节点**上。 */
  const entries = [
    ...appearance.hide.map(name => ({ owner: 'hide', name, kind: 'hide', groupHasNone: false })),
    ...appearance.pieces.flatMap(piece => piece.nodes.map(name => ({ owner: piece.id, name, kind: 'piece', groupHasNone: false }))),
    ...appearance.groups.flatMap(group => group.options.flatMap(option =>
      option.nodes.map(name => ({
        owner: `${group.id}.${option.id}`,
        name,
        kind: 'option',
        // 有"不戴"选项的组可以选到空 ⇒ 组里不许放身体。
        groupHasNone: group.options.some(o => o.nodes.length === 0),
      })))),
  ]
  const declared = new Set()
  for (const entry of entries) {
    const { owner, name, kind, groupHasNone } = entry
    if (declared.has(name)) errors.push(`节点 "${name}" 被多处声明（${owner}）`)
    declared.add(name)
    const info = meshes.get(name)
    if (info === undefined) {
      const isGroupNode = (gltf.nodes ?? []).some(node => node.name === name)
      errors.push(
        isGroupNode
          ? `"${owner}" 的节点 "${name}" 是个**组节点**（没有网格）：会连组里所有东西一起隐藏，改用具体网格名`
          : `"${owner}" 的节点 "${name}" 在 model.glb 里找不到`,
      )
      continue
    }
    const share = totalVertices > 0 ? info.vertices / totalVertices : 0
    // 款式组的选项本来就可能是"整只身体"（下装 5 款）—— 只要组里**始终有且只有一款**
    // 被选中，换款就不会让宠物消失。真正的风险是：组里带"不戴"，而某一款就是身体。
    if (kind === 'option') {
      if (groupHasNone && (name === body?.name || share > 0.4)) {
        errors.push(`款式组 "${owner}" 含"不戴"选项，却包含了身体级网格 "${name}"（${(share * 100).toFixed(0)}%）：选"不戴"会让宠物消失`)
      }
      continue
    }
    if (body !== null && name === body.name) {
      errors.push(`"${owner}" 指向主体网格 "${name}"（${body.vertices} 顶点）：脱掉它宠物就没了`)
    } else if (share > 0.6) {
      errors.push(`"${owner}" 的节点 "${name}" 占了 ${(share * 100).toFixed(0)}% 的顶点，不像配饰`)
    }
  }
  for (const group of appearance.groups) {
    const withGeometry = group.options.filter(option => option.nodes.length > 0)
    if (withGeometry.length === 0) errors.push(`款式组 "${group.id}" 里没有任何一款有几何`)
    if (!group.options.some(option => option.default)) {
      notes.push(`款式组 "${group.id}" 没标 default，默认按第一款（${withGeometry[0]?.id ?? '无'}）`)
    }
  }
  return {
    id,
    errors,
    notes,
    title: appearance.title ?? null,
    pieces: appearance.pieces.map(piece => ({
      id: piece.id,
      label: piece.label,
      nodes: piece.nodes,
      vertices: piece.nodes.reduce((sum, name) => sum + (meshes.get(name)?.vertices ?? 0), 0),
    })),
    groups: appearance.groups.map(group => ({
      id: group.id,
      label: group.label,
      default: group.options.find(option => option.default)?.id
        ?? group.options.find(option => option.nodes.length > 0)?.id
        ?? null,
      options: group.options.map(option => ({
        id: option.id,
        label: option.label,
        nodes: option.nodes,
        vertices: option.nodes.reduce((sum, name) => sum + (meshes.get(name)?.vertices ?? 0), 0),
      })),
    })),
    hiddenAlways: appearance.hide,
    stats: { nodes: meshes.size, totalVertices, body: body?.name ?? null },
  }
}

/** 主流程。 */
function main() {
  if (!existsSync(MODELS)) {
    console.error(`模型目录不存在：${MODELS}（可用 $env:DSH_HOME 覆盖）`)
    process.exit(2)
  }
  const ids = readdirSync(MODELS)
    .filter(name => statSync(join(MODELS, name)).isDirectory())
    .filter(name => ONLY === null || name === ONLY)
    .sort()
  if (ONLY !== null && ids.length === 0) {
    console.error(`找不到模型目录：${join(MODELS, ONLY)}`)
    process.exit(2)
  }
  const results = ids.map(checkModel)
  const failed = results.filter(result => result.errors.length > 0)
  if (JSON_OUT) {
    console.log(JSON.stringify({ models: results, failed: failed.length }, null, 2))
  } else {
    for (const result of results) {
      if (result.skipped) { console.log(`- ${result.id}: 跳过（${result.notes.join('；')}）`); continue }
      const mark = result.errors.length === 0 ? '✔' : '✘'
      const pieces = result.pieces === undefined ? '' : ` · ${result.pieces.length} 件配饰${result.title === null || result.title === undefined ? '' : `（${result.title}）`}`
      console.log(`${mark} ${result.id}${pieces}`)
      for (const note of result.notes) console.log(`    · ${note}`)
      for (const group of result.groups ?? []) {
        const options = group.options
          .map(option => `${option.label}${option.id === group.default ? '*' : ''}（${option.id}${option.nodes.length === 0 ? ' 无几何' : ` ${option.vertices} 顶点`}）`)
          .join(' / ')
        console.log(`    = 款式「${group.label}」默认 ${group.default}：${options}`)
      }
      for (const piece of result.pieces ?? []) {
        console.log(`    - ${piece.label}（${piece.id}） ← ${piece.nodes.join(', ')}　${piece.vertices} 顶点`)
      }
      if ((result.hiddenAlways ?? []).length > 0) {
        console.log(`    × 永远隐藏：${result.hiddenAlways.join(', ')}`)
      }
      for (const error of result.errors) console.log(`    ✘ ${error}`)
    }
    console.log(failed.length === 0 ? `\n全部通过（${results.length} 个模型）` : `\n有 ${failed.length} 个模型不通过`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main()
