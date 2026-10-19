/**
 * 资源路由 id 安全回归 —— 只读，不启动宿主。
 *
 * 背景：`/pet3d/<id>/<file>` 的 `<id>` 直接来自 URL。它必须是**模型目录名**，
 * 不能是路径；否则 `%2e%2e%2f` 这类 id 会让 `join(modelsRoot, id)` 跑出模型根，
 * 读到 `$DSH_HOME` 甚至更外面的 `.json`/图片/glb（2026-10-19 审计发现并修复）。
 *
 * 这里直接 import 插件的注册表源码做单元断言，不依赖正在运行的宿主，
 * 所以修完立刻能验，不用重启 DSH。
 *
 * 用法：node tools/check-pet3d-route-safety.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isSafeModelId, modelDirectory } from '../packages/dsh-pet-3d/src/registry.ts'

const DSH_HOME = process.env.DSH_HOME ?? 'D:\\.dsh'
const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail === '' ? '' : `  — ${detail}`}`)
  if (!ok) failures.push(label)
}

console.log('\n--- id 只能是目录名 ---')
const rejected = ['', '.', '..', '../x', '..\\x', 'a/b', 'a\\b', 'C:', 'C:\\x', 'x\0y']
for (const id of rejected) {
  check(!isSafeModelId(id), `拒绝 ${JSON.stringify(id)}`)
}
check(isSafeModelId('panyinhu'), '接受正常 id（panyinhu）')
check(isSafeModelId('some-model-v2'), '接受带连字符的 id')
check(isSafeModelId('模型-01'), '接受非 ASCII 目录名')

console.log('\n--- modelDirectory 不越界 ---')
check(modelDirectory('..') === undefined, '`..` 解析为 undefined')
check(modelDirectory('../profiles/desktop') === undefined, '`../profiles/desktop` 解析为 undefined')
check(modelDirectory('a/b') === undefined, '`a/b` 解析为 undefined')

const realDir = join(DSH_HOME, 'models', 'panyinhu')
if (existsSync(realDir)) {
  check(modelDirectory('panyinhu') === realDir, '正常模型仍然解析到自己的目录', realDir)
} else {
  console.log(`  （跳过正常模型检查：${realDir} 不存在）`)
}

console.log('')
if (failures.length > 0) {
  console.log(`check-pet3d-route-safety: 失败 ${failures.length} 项`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('check-pet3d-route-safety: 全部通过')
