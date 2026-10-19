/**
 * Offline guard for the action timeline (`T = nL + F`).
 *
 * The scheduling rule is the one thing that can silently make the pet either cut a beat
 * short or overrun it, so the boundaries are pinned here rather than discovered on screen:
 *
 *   - `T < F` must **accelerate** the exit (`F' = T`, rate `F/T`) and land exactly on `T`;
 *   - the static gap policy must either pause (`gap = Δ`) or stretch the exit (`F' ≥ F`);
 *   - the **dynamic** decision must only ever speed the exit up (rate ≥ 1) while the
 *     **static** stretch only ever slows it down (rate ≤ 1) — the two directions are
 *     deliberately opposite, so a future edit that "unifies" them fails here;
 *   - a walk state shorter than `enter + 1 loop + exit` can never reach its loop segment,
 *     which is exactly the segment the `走→跑` transition is entered from.
 *
 * The timeline module is pure (no node/DOM), and the integration part reads the real
 * `clips.json` when the model is installed, so the numbers checked are the shipped ones.
 *
 * Usage: node tools/check-pet3d-timeline.mjs
 * Exit 0 = the timeline maths behave.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIN_ACTION_GAP_MS, decideByRemaining, parseDuration, planBeat, timingProblems, triggerDelayMs } from '../packages/dsh-pet-3d/src/timeline.ts'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`)
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

console.log('--- 1. 静态版：n = floor((T − F) / L) ---')
{
  const p = planBeat(20, 4, 3)
  check(p !== undefined && p.loops === 4, 'T=20 L=4 F=3 ⇒ n=4', `n=${p?.loops}`)
  check(p !== undefined && near(p.loopSeconds, 16), '循环段 = nL = 16s', `${p?.loopSeconds}`)
  check(p !== undefined && near(p.exitSeconds, 3), 'pause 补法：收尾原速 3s', `${p?.exitSeconds}`)
  check(p !== undefined && near(p.gapSeconds, 1), 'pause 补法：富余 Δ = 1s', `${p?.gapSeconds}`)
  check(p !== undefined && near(p.actionSeconds, 19), '动作本身 19s（不含富余）', `${p?.actionSeconds}`)
}
{
  const p = planBeat(19, 4, 3) // 刚好整除：Δ = 0
  check(p !== undefined && p.loops === 4 && near(p.gapSeconds, 0), 'T=nL+F 时 Δ=0', `n=${p?.loops} Δ=${p?.gapSeconds}`)
}
{
  const p = planBeat(3, 4, 3) // T === F
  check(p !== undefined && p.loops === 0 && near(p.exitSeconds, 3) && near(p.exitRate, 1), 'T=F ⇒ n=0、收尾原速', `n=${p?.loops} rate=${p?.exitRate}`)
}
{
  const p = planBeat(3.5, 4, 3)
  check(p !== undefined && p.loops === 0 && near(p.gapSeconds, 0.5), 'T=F+0.5 ⇒ n=0、富余 0.5s', `Δ=${p?.gapSeconds}`)
}

console.log('\n--- 2. T < F：收尾必须加速，总时长刚好 T ---')
{
  const p = planBeat(1, 4, 3)
  check(p !== undefined && p.loops === 0, 'T=1 < F=3 ⇒ n=0')
  check(p !== undefined && near(p.exitSeconds, 1), '实际收尾 F′ = T = 1s', `${p?.exitSeconds}`)
  check(p !== undefined && near(p.exitRate, 3), '倍率 = F/T = 3（加速）', `${p?.exitRate}`)
  check(p !== undefined && near(p.actionSeconds, 1), '总时长刚好 T = 1s', `${p?.actionSeconds}`)
  const z = planBeat(0, 4, 3)
  check(z !== undefined && z.loops === 0 && near(z.exitSeconds, 0), 'T=0 ⇒ n=0、收尾 0s（不除零）', `rate=${z?.exitRate}`)
  check(z !== undefined && z.jumpToEnd === true, 'T=0 ⇒ 标 jumpToEnd（与动态版同语义，不许给倍率 0 让 three 定住）', JSON.stringify(z))
}

console.log('\n--- 3. 静态版的两种补法 ---')
{
  const pause = planBeat(20, 4, 3, 'pause')
  const stretch = planBeat(20, 4, 3, 'stretch')
  check(stretch !== undefined && near(stretch.exitSeconds, 4), 'stretch：F′ = T − nL = 4s', `${stretch?.exitSeconds}`)
  check(stretch !== undefined && near(stretch.exitRate, 0.75), 'stretch：倍率 = F/F′ = 0.75（放慢）', `${stretch?.exitRate}`)
  check(stretch !== undefined && near(stretch.gapSeconds, 0), 'stretch：没有富余', `${stretch?.gapSeconds}`)
  check(stretch !== undefined && near(stretch.actionSeconds, 20), 'stretch：总时长刚好 T', `${stretch?.actionSeconds}`)
  check(pause !== undefined && near(pause.actionSeconds, 19) && near(pause.gapSeconds, 1), 'pause：动作 19s + 停 1s = T', `${pause?.actionSeconds}+${pause?.gapSeconds}`)
}

console.log('\n--- 4. 不变量（防止将来被"顺手统一"改错） ---')
{
  let staleOk = true
  let dynOk = true
  let budgetOk = true
  const worst = []
  for (let T = 0; T <= 40; T += 0.25) {
    for (const F of [0.5, 3, 6.06]) {
      for (const L of [0.8, 4.03]) {
        for (const policy of ['pause', 'stretch']) {
          const p = planBeat(T, L, F, policy)
          if (p === undefined) { budgetOk = false; continue }
          // 通用铁律：静态版永远不会超时
          if (p.actionSeconds > T + 1e-9) { budgetOk = false; worst.push(`T=${T} L=${L} F=${F} ${policy} 动作 ${p.actionSeconds} > T`) }
          // jumpToEnd 只在 T ≤ 0 时允许出现，且 T ≤ 0 时必须出现
          if (p.jumpToEnd === true && T > 0) { staleOk = false; worst.push(`T=${T} > 0 却标了 jumpToEnd`) }
          if (T <= 0 && p.jumpToEnd !== true) { staleOk = false; worst.push(`T=${T} ≤ 0 却没标 jumpToEnd`) }

          if (T <= 0) continue
          if (T < F) {
            // 规格铁律：T < F 时**无论补法**收尾都必须加速，且总时长刚好 T、没有富余
            if (p.exitRate <= 1) { staleOk = false; worst.push(`T=${T} < F=${F} ${policy} 却没加速（rate=${p.exitRate}）`) }
            if (!near(p.actionSeconds, T, 1e-6)) { staleOk = false; worst.push(`T=${T} < F=${F} 动作没吃满 T`) }
            if (!near(p.gapSeconds, 0)) { staleOk = false; worst.push(`T=${T} < F=${F} 不该有富余`) }
            continue
          }
          // T ≥ F：补法才起作用
          if (policy === 'pause') {
            if (!near(p.exitRate, 1)) { staleOk = false; worst.push(`pause 倍率 ≠1 @T=${T}`) }
            if (!near(p.gapSeconds, T - (p.loopSeconds + p.exitSeconds), 1e-6)) { staleOk = false; worst.push(`pause 富余 Δ 算错 @T=${T}`) }
          } else {
            if (p.exitRate > 1 + 1e-9) { staleOk = false; worst.push(`stretch 倍率 >1 @T=${T}`) }
            if (!near(p.actionSeconds, T, 1e-6)) { staleOk = false; worst.push(`stretch 没吃满 T=${T}`) }
            if (!near(p.gapSeconds, 0)) { staleOk = false; worst.push(`stretch 不该有富余 @T=${T}`) }
          }
        }
        for (let R = 0; R <= 40; R += 0.25) {
          const d = decideByRemaining(R, L, F)
          if (d.kind === 'exit' && !d.jumpToEnd && d.rate < 1 - 1e-9) { dynOk = false; worst.push(`动态倍率 <1 @R=${R}`) }
          if (d.kind === 'loop' && R <= F) { dynOk = false; worst.push(`R=${R} ≤ F=${F} 却还在循环`) }
          if (d.kind === 'exit' && !d.jumpToEnd && !near(d.rate, F / R, 1e-9)) { dynOk = false; worst.push(`动态倍率 ≠ F/R @R=${R}`) }
        }
      }
    }
  }
  check(budgetOk, '静态版永不超时；stretch 恰好用满 T', worst.slice(0, 3).join(' | '))
  check(staleOk, '静态版收尾只会放慢或原速（倍率 ≤ 1）', worst.slice(0, 3).join(' | '))
  check(dynOk, '动态版收尾只会加速（倍率 ≥ 1），且 R ≤ F 时一定收尾', worst.slice(0, 3).join(' | '))
}

console.log('\n--- 5. 动态版 decideByRemaining ---')
{
  const a = decideByRemaining(10, 4, 3)
  check(a.kind === 'loop', 'R=10 > F=3 ⇒ 继续循环')
  const b = decideByRemaining(3, 4, 3)
  check(b.kind === 'exit' && near(b.seconds, 3) && near(b.rate, 1), 'R=3=F ⇒ 收尾原速', JSON.stringify(b))
  const c = decideByRemaining(1, 4, 3)
  check(c.kind === 'exit' && near(c.seconds, 1) && near(c.rate, 3), 'R=1 ⇒ 收尾 1s、倍率 3', JSON.stringify(c))
  const d = decideByRemaining(0, 4, 3)
  check(d.kind === 'exit' && d.jumpToEnd === true, 'R=0 ⇒ 直接落到末帧', JSON.stringify(d))
  const e = decideByRemaining(-5, 4, 3)
  check(e.kind === 'exit' && e.jumpToEnd === true, 'R 为负 ⇒ 直接落到末帧', JSON.stringify(e))
  const f = decideByRemaining(undefined, 4, 3)
  check(f.kind === 'exit' && f.seconds <= 3, 'R 缺失 ⇒ 不当成"还能循环"（安全方向）', JSON.stringify(f))
}

console.log('\n--- 6. 坏配置不猜（L/F 非正返回 undefined） ---')
{
  check(planBeat(10, 0, 3) === undefined, 'L=0 ⇒ undefined')
  check(planBeat(10, 4, 0) === undefined, 'F=0 ⇒ undefined')
  check(planBeat(10, -1, 3) === undefined, 'L<0 ⇒ undefined')
  check(planBeat(10, Number.NaN, 3) === undefined, 'L=NaN ⇒ undefined')
}

console.log('\n--- 7. 人类可读时长 ---')
{
  const cases = [
    [90, 90], ['90', 90], ['90s', 90], ['2m30s', 150], ['1小时30分', 5400],
    ['1h30m10s', 5410], ['500ms', 0.5], ['1时2分3秒', 3723], ['45 秒', 45], ['2 分', 120],
  ]
  for (const [input, want] of cases) {
    const got = parseDuration(input)
    check(got !== undefined && near(got, want, 1e-9), `parseDuration(${JSON.stringify(input)}) = ${want}`, `得到 ${got}`)
  }
  for (const bad of ['', '  ', 'abc', '1x', '-5', '5秒前', 's90', null, undefined, {}]) {
    check(parseDuration(bad) === undefined, `parseDuration(${JSON.stringify(bad)}) 认不出来 ⇒ undefined`, `得到 ${parseDuration(bad)}`)
  }
}

console.log('\n--- 8. 走 的时长下限（①′ 从"走循环中途"进入，走不到循环段就失效） ---')
{
  const E = 1.5   // Walk_Start 1.500s
  const L = 0.8   // Walk_Loop 0.800s
  const F = 3.667 // Walk_End 3.667s
  check(timingProblems('states.walk', L, F, E, 10).length === 0, '走 T=10s 通过下限检查')
  const bad = timingProblems('states.walk', L, F, E, 5)
  check(bad.length === 1 && bad[0].includes('太短'), '走 T=5s 被拒（下限 5.97s）', bad[0] ?? '（没有报错！）')
  check(timingProblems('states.walk', 0, F, E, 10).length === 1, 'L=0 被报出来')
  check(timingProblems('states.walk', L, 0, E, 10).length === 1, 'F=0 被报出来')
  check(timingProblems('states.walk', L, F, E).length === 0, '不填 T（按遍数配）时跳过下限检查')
}

console.log('\n--- 9. 与真实模型对表（装了模型才跑） ---')
{
  const file = join(process.env.DSH_HOME ?? 'D:\\.dsh', 'models', 'panyinhu', '.import', 'clips.json')
  try {
    const index = JSON.parse(readFileSync(file, 'utf8'))
    const ANI = 'Avatar_Male_Size03_PanYinhu_Ani_'
    const dur = (short) => index.clips.find((c) => c.name === ANI + short)?.duration
    const E = dur('Walk_Start'), L = dur('Walk_Loop'), F = dur('Walk_End')
    if (E === undefined || L === undefined || F === undefined) {
      check(false, '模型里应能找到 Walk_Start / Walk_Loop / Walk_End', `${E} / ${L} / ${F}`)
    } else {
      console.log(`         实测时长：起手 ${E.toFixed(3)}s  循环 ${L.toFixed(3)}s  收尾 ${F.toFixed(3)}s`)
      const floor = E + L + F
      check(timingProblems('states.walk', L, F, E, 10).length === 0, `走 T=10s ≥ 下限 ${floor.toFixed(2)}s`)
      check(timingProblems('states.walk', L, F, E, floor - 0.1).length === 1, `走 T=${(floor - 0.1).toFixed(2)}s（差一点）必须被拒`)
      // 配置里 walk 是 seconds=10 + gap=stretch ⇒ 客户端会用这两个真实时长算出"正好 10s"
      const walkPlan = planBeat(10, L, F, 'stretch')
      check(walkPlan !== undefined && near(walkPlan.actionSeconds, 10, 1e-6),
        '走 T=10s（真实 L/F）⇒ 动作正好用满 10s', `n=${walkPlan?.loops} 收尾倍率=${walkPlan?.exitRate.toFixed(3)}`)
      check(walkPlan !== undefined && walkPlan.exitRate <= 1 && walkPlan.exitRate > 0,
        '走的收尾是"放慢"（0 < 倍率 ≤ 1，不是加速也不是停住）', String(walkPlan?.exitRate.toFixed(3)))
      check(walkPlan !== undefined && walkPlan.gapSeconds === 0, 'stretch 补法没有停顿（不会走一半站着不动）', String(walkPlan?.gapSeconds))
      // 思考：Galgame_Think 三段，F 含起手吗？按规格 F 只算收尾 ⇒ 起手单独给
      const tE = dur('Galgame_Think_Start'), tL = dur('Galgame_Think_Loop'), tF = dur('Galgame_Think_End')
      if (tE !== undefined && tL !== undefined && tF !== undefined) {
        const p = planBeat(30, tL, tF, 'stretch')
        check(p !== undefined && near(p.actionSeconds, 30, 1e-6), `思考 T=30s（L=${tL.toFixed(2)} F=${tF.toFixed(2)}）⇒ 正好用满 30s`, `n=${p?.loops} 动作=${p?.actionSeconds.toFixed(2)}s`)
        check(p !== undefined && p.exitRate <= 1 + 1e-9, '思考的收尾倍率 ≤ 1（静态版只会放慢）', `${p?.exitRate.toFixed(3)}`)
      }
    }
  } catch (error) {
    console.log(`  （没有 ${file}，跳过：${error instanceof Error ? error.message : String(error)}）`)
  }
}

console.log('\n--- 10. 动作总闸：≥200ms，且"不丢相位"由调用方负责 ---')
{
  check(MIN_ACTION_GAP_MS === 200, '最小间隔 = 200ms', String(MIN_ACTION_GAP_MS))
  check(triggerDelayMs(undefined, 1000) === 0, '第一次触发不用等')
  check(triggerDelayMs(1000, 1000) === 200, '同一时刻再触发 ⇒ 还要等 200ms', String(triggerDelayMs(1000, 1000)))
  check(triggerDelayMs(1000, 1100) === 100, '隔了 100ms ⇒ 再等 100ms', String(triggerDelayMs(1000, 1100)))
  check(triggerDelayMs(1000, 1199) === 1, '差 1ms 也要等 1ms', String(triggerDelayMs(1000, 1199)))
  check(triggerDelayMs(1000, 1200) === 0, '隔满 200ms ⇒ 可以开演')
  check(triggerDelayMs(1000, 5000) === 0, '隔很久 ⇒ 可以开演')
  check(triggerDelayMs(1000, 1000, 0) === 0, '把间隔配成 0 就不拦')
  check(triggerDelayMs(Number.NaN, 1000) === 0, 'lastTriggerMs 是 NaN ⇒ 当没触发过')
  check(triggerDelayMs(1000, Number.NaN) === 0, 'now 是 NaN ⇒ 不拦（宁可让它演，也不要卡住宠物）')
}

console.log(failures === 0 ? '\ncheck-pet3d-timeline: 时间轴（T = nL + F）的静态/动态/边界都成立' : `\ncheck-pet3d-timeline: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
