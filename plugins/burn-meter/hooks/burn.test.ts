import { describe, expect, test } from 'claude-code/testing'

import {
  addSample,
  bucketSpend,
  empty,
  estimateUsd,
  hoursToCap,
  newAlerts,
  parseBudget,
  ratePerHour,
  segments,
  sessionRate,
  shortModel,
  sparkline,
  usd,
} from './burn'

const MIN = 60_000

describe('burn rate', () => {
  test('positive: rate over the last window', async () => {
    const b = { ...empty(0), usd: 3, samples: [{ t: 0, usd: 1 }, { t: 30 * MIN, usd: 3 }] }
    // 2 dollars over the 30 minutes since the baseline sample -> $4/h
    expect(Math.round(ratePerHour(b, 30 * MIN) * 100) / 100).toBe(4)
    expect(Math.round(sessionRate(b, 30 * MIN) * 100) / 100).toBe(6)
  })

  test('edge: under a minute of history reads zero', async () => {
    const b = { ...empty(0), usd: 1, samples: [{ t: 10_000, usd: 1 }] }
    expect(ratePerHour(b, 20_000)).toBe(0)
  })

  test('edge: addSample keeps one baseline before the window', async () => {
    const s = addSample([{ t: 0, usd: 0 }, { t: MIN, usd: 1 }], { t: 20 * MIN, usd: 2 })
    expect(s).toEqual([{ t: MIN, usd: 1 }, { t: 20 * MIN, usd: 2 }])
  })

  test('negative: no spend formats as zero', async () => {
    expect(usd(0)).toBe('$0.00')
  })
})

describe('per-model estimate', () => {
  const t = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }

  test('positive: opus-5-5 priced at its own rate, not opus-5', async () => {
    expect(Math.round(estimateUsd('claude-opus-5-5', t)! * 100) / 100).toBe(24.2)
  })

  test('edge: context suffix still matches', async () => {
    expect(estimateUsd('claude-sonnet-5-5[1m]', t)).toBeDefined()
    expect(shortModel('claude-sonnet-5-5[1m]')).toBe('sonnet-5-5')
  })

  test('negative: unknown model has no estimate', async () => {
    expect(estimateUsd('some-other-model', t)).toBeUndefined()
  })
})

describe('polish helpers', () => {
  test('positive: sparkline scales to the busiest bucket', async () => {
    expect(sparkline([0, 1, 2])).toBe('▁▅█')
  })

  test('edge: no spend draws a flat line', async () => {
    expect(sparkline([0, 0, 0])).toBe('▁▁▁')
  })

  test('positive: bucketSpend splits spend by time', async () => {
    const h = [{ t: 0, usd: 0 }, { t: 30 * MIN, usd: 1 }, { t: 60 * MIN, usd: 3 }]
    expect(bucketSpend(h, 60 * MIN, 2)).toEqual([1, 2])
  })

  test('positive: budget alerts fire once per threshold', async () => {
    expect(newAlerts(8.5, 10, [])).toEqual([50, 80])
    expect(newAlerts(8.5, 10, [50, 80])).toEqual([])
  })

  test('negative: no budget means no alerts', async () => {
    expect(newAlerts(100, undefined, [])).toEqual([])
  })

  test('edge: eta is undefined when idle or over budget', async () => {
    expect(hoursToCap(5, 10, 0)).toBeUndefined()
    expect(hoursToCap(12, 10, 5)).toBeUndefined()
    expect(hoursToCap(5, 10, 5)).toBe(1)
  })

  test('positive and negative: budget command parsing', async () => {
    expect(parseBudget('budget 10')).toBe(10)
    expect(parseBudget('budget $2.5')).toBe(2.5)
    expect(parseBudget('budget off')).toBe('off')
    expect(parseBudget('budget ten')).toBeUndefined()
  })

  test('edge: segments fill the full width', async () => {
    const s = segments([3, 1, 1], 10)
    expect(s.reduce((a, b) => a + b, 0)).toBe(10)
  })
})
