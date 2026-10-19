/**
 * Offline guard for the choreography config (`choreography.json`) parser.
 *
 * The parser is the ONE thing between a user-typed file and a pet that does not move,
 * so it must be provably forgiving: garbage fields are dropped with a reported
 * problem, never thrown. This guard checks exactly that, plus the wildcard
 * expansion the config leans on.
 *
 * Usage: node tools/check-pet3d-choreography.mjs
 * Exit 0 = the parser and the matchers behave.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CHOREOGRAPHY, PERFORMANCE_TRIGGERS, bridgeFor, expandPattern, matchesClip, parseChoreography, poolOf, restoreDroppedFields } from '../packages/dsh-pet-3d/src/choreography.ts'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

console.log('--- 1. 通配匹配 ---')
check(matchesClip('Idle_Loop', 'Idle_Loop'), '完全相同的名字算命中')
check(matchesClip('Galgame_*_Loop', 'Galgame_Sad_Loop'), '* 能匹配中间一段（短名）')
// 这条是踩过的坑：配置里人会写 `Galgame_*_Loop`，而 clip 全名带着 40 个字符的资源前缀，
// 只按全名匹配的话一条都命中不了（"戳一下"直接没反应）。所以要在每个下划线处截断后再试。
check(expandPattern('Galgame_*_Loop', ['Avatar_Male_Size03_PanYinhu_Ani_Galgame_Sad_Loop']).length === 1,
  '模式写的是动作那一截，也能命中带长前缀的全名')
check(expandPattern('Ani_Galgame_*_Loop', ['Avatar_Male_Size03_PanYinhu_Ani_Galgame_Sad_Loop']).length === 1,
  '中间截断（Ani_ 开头）也能命中')
check(matchesClip('Avatar_????_*', 'Avatar_Male_Size03'), '? 匹配单字符（四个 ? 吃掉 Male）')
check(!matchesClip('idle_loop', 'Idle_Loop'), '大小写不敏感 ⇒ 小写模式也能命中', 'idle_loop 应命中 Idle_Loop')

const NAMES = [
  'Avatar_Male_Size03_PanYinhu_Ani_Idle_Loop',
  'Avatar_Male_Size03_PanYinhu_Ani_Galgame_Sad_Loop',
  'Avatar_Male_Size03_PanYinhu_Ani_Galgame_Happy_Loop',
  'Avatar_Male_Size03_PanYinhu_Ani_Gacha_Loop',
  'Eff_PanYinhu_Attack_ExQTE_Start_05_Aura',
]
check(expandPattern('*Galgame_*_Loop', NAMES).length === 2, '按模式展开能选出多条', String(expandPattern('*Galgame_*_Loop', NAMES).length))
check(expandPattern('没有这条', NAMES).length === 0, '名字不在清单里 ⇒ 空（不瞎回落到第一条）')
const pooled = poolOf(['*Galgame_*_Loop', '*Gacha_Loop'], NAMES)
check(pooled.length === 3 && new Set(pooled).size === 3, '池子里多个模式合并且去重', pooled.length.toString())

console.log('\n--- 2. 解析：正常配置 ---')
const good = parseChoreography({
  version: 2,
  states: {
    idle: { loop: 'Idle_Loop' },
    run: { enter: 'Run_Start', loop: 'Run_Loop', exit: 'Run_End' },
    done: { loop: 'Happy_Loop', loops: 1 },
  },
  render: { outlineWidth: 0, morphs: false },
})
check(good.problems.length === 0, '干净配置不报问题', good.problems.join('；'))
check(good.config.states.run?.exit === 'Run_End', '三段都读进来了')
check(good.config.states.done?.loops === 1, '循环遍数读进来了')
// 彩蛋（`timed`）已整套删除：旧配置里还留着它时必须**明确报出来**，不能静默忽略
const legacyTimed = parseChoreography({ timed: [{ everyMs: 1000, clip: 'Galgame_Idle' }] })
check(legacyTimed.problems.some((line) => line.includes('timed')), '旧配置里的 timed 会被报出来（已删除的彩蛋）', legacyTimed.problems.join('；'))
check(!('timed' in legacyTimed.config), '配置里已经不存在 timed 字段', JSON.stringify(legacyTimed.config))
check(good.config.render?.outlineWidth === 0 && good.config.render?.morphs === false, '性能开关读进来了')

console.log('\n--- 2b. 跨状态的"桥"（transitions）---')
{
  const P = (name) => `Avatar_Male_Size03_PanYinhu_Ani_${name}`
  const names = [P('Walk_End'), P('MainCity_RunToWalk'), P('MainCity_Walk_End_02_L'), 'Trans_03to04', P('Idle_Loop')]
  const parsed = parseChoreography({
    transitions: {
      'run>think': [P('MainCity_RunToWalk'), P('MainCity_Walk_End_02_L'), 'Trans_03to04'],
      'walk>run': ['Trans_01to03'],   // 这个名字不在 names 里 ⇒ 整条作废
      'bogus>x': ['Trans_04to01'],    // 键不是两个合法状态
      'think>run': [],                // 空链
    },
  })
  const bridges = parsed.config.transitions
  check(parsed.problems.some((line) => line.includes('bogus>x')), '"bogus>x" 这样的键被报出来', parsed.problems.join('；'))
  check(parsed.problems.some((line) => line.includes('think>run')), '空链被报出来', parsed.problems.join('；'))
  check(bridges?.['bogus>x'] === undefined && bridges?.['think>run'] === undefined, '非法/空链没有进配置', JSON.stringify(bridges))
  check(bridgeFor(bridges, 'run', 'think', names).length === 3, '链齐全时整条返回', JSON.stringify(bridgeFor(bridges, 'run', 'think', names)))
  check(bridgeFor(bridges, 'walk', 'run', names).length === 0,
    '链里有一支不在模型里 ⇒ 整条作废（宁可硬切，也不要跳错位置）')
  check(bridgeFor(bridges, 'idle', 'run', names).length === 0, '没配的配对返回空')
  check(bridgeFor(bridges, 'idle', 'idle', names).length === 0, '同状态不取桥')
  check(bridgeFor(bridges, undefined, 'run', names).length === 0, '还没进任何状态时不取桥')
  check(bridgeFor(undefined, 'idle', 'run', names).length === 0, '没有 transitions 配置时返回空（缺省就是硬切）')
  check(bridgeFor(bridges, 'run', 'think', []).length === 0, '模型里一条 clip 都没有时返回空')
}

console.log('\n--- 2c. 非破坏性保存：提交里没有的字段按磁盘原值保留（事故 2026-10-15）---')
{
  const disk = {
    states: {
      idle: { loop: 'Idle_Loop' },
      walk: { enter: 'Walk_Start', loop: 'Walk_Loop', exit: 'Walk_End', seconds: 10, gap: 'stretch' },
    },
    transitions: { 'walk>run': ['Trans_01to03'] },
    render: { outlineWidth: 0.0025 },
    timed: [{ everyMs: 1000, clip: 'Galgame_Idle' }],
  }
  // 模拟"旧解析器 / 旧客户端"：只认得 idle，其余全丢
  const incoming = parseChoreography({ states: { idle: { loop: 'Idle_Loop' } } })
  const problems = [...incoming.problems]
  restoreDroppedFields(incoming.config, disk, problems)
  check(incoming.config.transitions?.['walk>run']?.[0] === 'Trans_01to03', '顶层 transitions 被保留', JSON.stringify(incoming.config.transitions))
  check(incoming.config.states.walk?.seconds === 10 && incoming.config.states.walk?.gap === 'stretch',
    '整块缺失的 states.walk 被保留（连 seconds/gap 一起）', JSON.stringify(incoming.config.states.walk))
  check(incoming.config.render?.outlineWidth === 0.0025, '顶层 render 被保留')
  check(!('timed' in incoming.config), '已删除的 timed 不会被复活（不在白名单里）', JSON.stringify(incoming.config.timed))
  check(problems.filter((line) => line.includes('已按磁盘上的原值保留')).length >= 3,
    '"保留了哪些"被报出来（不静默）', `问题 ${problems.length} 条`)

  // 提交里明确写了的值必须赢，不能被磁盘原值盖掉
  const edited = parseChoreography({ states: { idle: { loop: 'Idle_Loop' }, walk: { loop: 'Walk_Loop', seconds: 25 } } })
  restoreDroppedFields(edited.config, disk, [])
  check(edited.config.states.walk?.seconds === 25, '提交里写了 seconds=25 ⇒ 以提交为准', String(edited.config.states.walk?.seconds))
  check(edited.config.states.walk?.enter === undefined,
    'enter/loop/exit 不在白名单：有意清空的段不会被复活（清空 = 不要这一段）',
    String(edited.config.states.walk?.enter))

  // 磁盘读不出来 / 不是对象 ⇒ 原样返回，不抛错
  const bare = parseChoreography({ states: { idle: { loop: 'Idle_Loop' } } })
  restoreDroppedFields(bare.config, undefined, [])
  restoreDroppedFields(bare.config, 42, [])
  restoreDroppedFields(bare.config, { states: 'nope' }, [])
  check(bare.config.states.idle?.loop === 'Idle_Loop', '磁盘读不出来时不动配置，也不抛错')
}

console.log('\n--- 2d. 演出（performances）：解析、触发、越界值、非破坏性保存 ---')
{
  const parsed = parseChoreography({
    performances: {
      // 正常：三步，中间一步限时，最后一步放慢
      greet: { name: '见面', trigger: 'daily', steps: [{ clip: 'P_A' }, { clip: 'P_B', seconds: 2 }, { clip: 'P_C', rate: 0.5 }] },
      // 裸字符串步骤 = 只给 clip 名
      bare: { trigger: 'manual', steps: ['P_A'] },
      // 不认识的触发 → 按 manual 处理**并报出来**（不能静默变成别的时机）
      weird: { trigger: 'whenever', steps: ['P_A'] },
      // 没有可用步骤 → 整条忽略并报
      empty: { trigger: 'done', steps: [] },
      // 不是对象 → 忽略并报
      broken: 42,
    },
  })
  const list = parsed.config.performances ?? {}
  check(Object.keys(list).length === 3, '三条合法演出进了配置', Object.keys(list).join(','))
  check(list.greet?.steps.length === 3 && list.greet.steps[1]?.seconds === 2, '三步与"这一步占 2 秒"都读进来了', JSON.stringify(list.greet?.steps))
  check(list.greet?.steps[2]?.rate === 0.5, '倍率读进来了')
  check(list.bare?.steps[0]?.clip === 'P_A', '裸字符串步骤 = 只给 clip 名')
  check(list.weird?.trigger === 'manual', '不认识的 trigger 按 manual 处理', String(list.weird?.trigger))
  check(parsed.problems.some((line) => line.includes('weird')), '不认识的 trigger 被报出来', parsed.problems.join('；'))
  check(parsed.problems.some((line) => line.includes('empty')), '没有步骤的演出被报出来')
  check(parsed.problems.some((line) => line.includes('broken')), '不是对象的演出被报出来')

  for (const trigger of PERFORMANCE_TRIGGERS) {
    const one = parseChoreography({ performances: { p: { trigger, steps: ['P_A'] } } })
    check(one.config.performances?.p?.trigger === trigger, `触发时机 ${trigger} 能读`)
  }

  // 倍率越界：100 不是"变快"，是写错了 —— 夹回 0.1~4，而不是把 three 打爆
  const clamped = parseChoreography({ performances: { p: { trigger: 'manual', steps: [{ clip: 'P_A', rate: 100 }] } } })
  check(clamped.config.performances?.p?.steps[0]?.rate === 4, '倍率被夹到 4', String(clamped.config.performances?.p?.steps[0]?.rate))

  // 非破坏性保存：旧宿主（不认识 performances）也不会让一次保存吃掉用户刚排的曲子
  const disk = { performances: { keepMe: { trigger: 'manual', steps: ['P_A'] } }, states: { idle: { loop: 'Idle_Loop' } } }
  const incoming = parseChoreography({ states: { idle: { loop: 'Idle_Loop' } } })
  const problems = [...incoming.problems]
  restoreDroppedFields(incoming.config, disk, problems)
  check(incoming.config.performances?.keepMe !== undefined, 'performances 在非破坏性保存的白名单里（一次旧保存不会吃掉它）')
  check(problems.some((line) => line.includes('performances')), '"保留了 performances"被报出来（不静默）', problems.join('；'))
}

console.log('\n--- 3. 解析：坏配置必须"忽略 + 汇报"，绝不抛错 ---')
const cases = [
  ['不是对象', 42],
  ['null', null],
  ['states 不是对象', { states: 7 }],
  ['state 值看不懂', { states: { idle: 3, run: { loop: 'X' } } }],
  ['click（已删除的字段）', { click: { pool: [] } }],
  ['timed 不是数组（已删除的字段）', { timed: 'nope' }],
  ['render 值类型不对', { render: { outlineWidth: 'x', morphs: 'yes' } }],
]
for (const [label, raw] of cases) {
  let threw = false
  let problems = []
  try {
    problems = parseChoreography(raw).problems
  } catch (error) {
    threw = true
  }
  check(!threw, `${label}：不抛错`, threw ? '抛了！' : `问题 ${problems.length} 条`)
}
const partial = parseChoreography({ states: { idle: { loop: 'Idle_Loop' } }, timed: [{ clip: 'X' }] })
check(partial.config.states.idle?.loop === 'Idle_Loop' && partial.problems.length === 1,
  '已删除的 timed 被报出来，且不影响别的字段', `states.idle 保住了，问题 ${partial.problems.length} 条`)

console.log('\n--- 4. 缺省配置能用，且字符串简写等于 { loop } ---')
check(DEFAULT_CHOREOGRAPHY.states.idle?.loop === 'Idle_Loop', '缺省 idle 是待机循环')
check(DEFAULT_CHOREOGRAPHY.states.done?.loops === 1, '缺省 done 是"一拍"（循环一遍）')
const shorthand = parseChoreography({ states: { idle: 'Idle_Loop' } })
check(shorthand.problems.length === 0 && shorthand.config.states.idle?.loop === 'Idle_Loop',
  'state 直接写字符串 = 只指定循环段')

console.log('\n--- 5. 真实模型目录里的 choreography.json（若存在）也要能读 ---')
const modelFile = join(process.env.DSH_HOME ?? 'D:\\.dsh', 'models', 'panyinhu', 'choreography.json')
try {
  const raw = JSON.parse(readFileSync(modelFile, 'utf8'))
  const parsed = parseChoreography(raw)
  check(parsed.problems.length === 0, '实际文件解析无问题', parsed.problems.join('；'))
  console.log(`         状态：${Object.keys(parsed.config.states).join(', ')}`)
  // 配置里的每个 clip 名都必须真的在模型里。写错一个名字，`bridgeFor` 会**静默**整条作废
  // ⇒ 退回硬跳；状态三段写错则会退到别的 clip。这条断言把"静默"变成"报错"。
  try {
    const clipsFile = join(process.env.DSH_HOME ?? 'D:\\.dsh', 'models', 'panyinhu', '.import', 'clips.json')
    const index = JSON.parse(readFileSync(clipsFile, 'utf8'))
    const present = new Set(index.clips.map((clip) => clip.name))
    const missing = []
    for (const [state, beat] of Object.entries(parsed.config.states)) {
      for (const key of ['enter', 'loop', 'exit']) {
        const name = beat[key]
        if (name !== undefined && !present.has(name)) missing.push(`states.${state}.${key}=${name}`)
      }
    }
    const pairs = Object.keys(parsed.config.transitions ?? {})
    for (const pair of pairs) {
      for (const name of parsed.config.transitions[pair]) {
        if (!present.has(name)) missing.push(`transitions."${pair}"=${name}`)
      }
    }
    // 演出的每一步也必须真的在模型里：通配写错了会被渲染器"跳过这一步"，
    // 静默跳过一步 = 演出少一段，不报出来根本发现不了。
    const shows = Object.entries(parsed.config.performances ?? {})
    for (const [id, performance] of shows) {
      for (const [at, step] of performance.steps.entries()) {
        if (!present.has(step.clip)) missing.push(`performances.${id}.step${at + 1}=${step.clip}`)
      }
    }
    check(missing.length === 0, `配置里的 clip 名全都能在模型里找到（模型 ${present.size} 条）`, missing.join(' | '))
    console.log(`         桥 ${pairs.length} 条：${pairs.join(', ')}`)
    console.log(`         演出 ${shows.length} 套：${shows.map(([id, p]) => `${id}(${p.trigger}/${p.steps.length}步)`).join(', ') || '（无）'}`)
  } catch (error) {
    console.log(`  （没有 clips.json，跳过 clip 名存在性检查：${error instanceof Error ? error.message : String(error)}）`)
  }
} catch (error) {
  console.log(`  （没有 ${modelFile}，跳过：${error instanceof Error ? error.message : String(error)}）`)
}

console.log(failures === 0 ? '\ncheck-pet3d-choreography: 编排配置的解析与匹配都成立' : `\ncheck-pet3d-choreography: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
