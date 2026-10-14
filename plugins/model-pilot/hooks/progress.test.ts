import { describe, expect, test } from 'claude-code/testing'

import type { Subtask } from '../types'
import { ANIM_MS, barTarget, barValue, isAnimating, overall, retarget } from './progress'
import { DARK, donut } from './raster'

const sub = (id: string, state: Subtask['state'], extra: Partial<Subtask> = {}): Subtask => ({
  id, title: id, objective: '', acceptance: [], model: 'haiku', modelReason: '', deps: [], weight: 1, state, anim: { from: 0, at: 0 }, ...extra,
})

describe('overall progress', () => {
  test('positive: completed weight over total', async () => {
    const o = overall([sub('a', 'completed'), sub('b', 'completed'), sub('c', 'queued'), sub('d', 'ready')])
    expect(o.fraction).toBe(0.5)
    expect(o.isEstimated).toBe(false)
  })

  test('negative: failed and cancelled never count as done', async () => {
    const o = overall([sub('a', 'completed'), sub('b', 'failed'), sub('c', 'cancelled'), sub('d', 'blocked')])
    expect(o.fraction).toBe(0.25)
    expect(o.failedWeight).toBe(2)
  })

  test('negative: running without a report adds nothing (no fake precision)', async () => {
    const o = overall([sub('a', 'running', { startedAt: 0 }), sub('b', 'queued')])
    expect(o.fraction).toBe(0)
    expect(o.isEstimated).toBe(false)
    expect(barTarget(sub('a', 'running'))).toBeUndefined()
  })

  test('edge: agent-reported progress is partial and labelled estimated', async () => {
    const o = overall([sub('a', 'running', { progress: { pct: 50, at: 1 } }), sub('b', 'completed')])
    expect(o.fraction).toBe(0.75)
    expect(o.isEstimated).toBe(true)
    // A report of 100 while still running caps at 99: it is not done.
    expect(overall([sub('a', 'running', { progress: { pct: 100, at: 1 } })]).fraction).toBe(0.99)
  })

  test('edge: no subtasks is unknown, not 0%', async () => {
    expect(overall([]).fraction).toBeUndefined()
  })
})

describe('bar animation', () => {
  test('positive: eases from the old value on a real change, then settles', async () => {
    const a = sub('a', 'running', { progress: { pct: 20, at: 0 } })
    const b = retarget(a, { progress: { pct: 60, at: 1000 } }, 1000)
    expect(b.anim).toEqual({ from: 20, at: 1000 })
    const mid = barValue(b, 1000 + ANIM_MS / 2, true)!
    expect(mid).toBeGreaterThan(20)
    expect(mid).toBeLessThan(60)
    expect(barValue(b, 1000 + ANIM_MS, true)).toBe(60)
    expect(isAnimating([b], 1000 + 10)).toBe(true)
    expect(isAnimating([b], 1000 + ANIM_MS + 1)).toBe(false)
  })

  test('negative: no change, no animation; motion off shows the value at once', async () => {
    const a = sub('a', 'completed')
    expect(retarget(a, { activity: 'x' }, 5).anim).toEqual(a.anim)
    const b = retarget(sub('b', 'running', { progress: { pct: 10, at: 0 } }), { state: 'completed' }, 100)
    expect(barValue(b, 101, false)).toBe(100)
  })
})

describe('radial chart', () => {
  test('positive: the ring is drawn and round; segments follow the fractions', async () => {
    const g = donut(22, 11, { done: 0.5, partial: 0, failed: 0 }, DARK, [{ text: '50%', color: DARK.text }])
    const cells = g.cells
    expect(cells.some(c => c.fg === DARK.done)).toBe(true)
    expect(cells.some(c => c.fg === DARK.track || c.bg === DARK.track)).toBe(true)
    expect(g.lines().join('\n')).toContain('50%')
    // Top-right quadrant is done, bottom-left is track.
    expect(g.at(15, 2)!.fg).toBe(DARK.done)
    expect([g.at(5, 8)!.fg, g.at(5, 8)!.bg]).toContain(DARK.track)
    expect(typeof g.encode()).toBe('string')
  })

  test('edge: no plan draws a plain track', async () => {
    const g = donut(22, 11, undefined, DARK, [{ text: '—', color: DARK.dim }])
    expect(g.cells.some(c => c.fg === DARK.done)).toBe(false)
  })
})
