import type { Burn, ModelTally, Sample, Tokens } from '../types'

export const WINDOW_MS = 10 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

export const empty = (startedAt: number): Burn => ({
  startedAt,
  usd: 0,
  samples: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  turns: 0,
  models: {},
  limits: [],
  history: [],
  alerted: [],
})

export const addTokens = <T extends Tokens>(a: T, b: Tokens): T => ({
  ...a,
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

export const emptyTally = (): ModelTally => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })

// List prices, $ per million tokens: [input, output, cache read]. Cache writes
// are estimated at 1.25x input (5-minute TTL), so the per-model figures are
// approximations; the session total stays the engine's own number.
const PRICES: [string, number, number, number][] = [
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4-6', 3, 15, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4-5', 1, 5, 0.1],
]

// Longest matching id first, so `claude-opus-5-5` never matches `claude-opus-5`.
const BY_LENGTH = [...PRICES].sort((a, b) => b[0].length - a[0].length)

export const estimateUsd = (model: string, t: Tokens): number | undefined => {
  const price = BY_LENGTH.find(([id]) => model.includes(id))
  if (!price) return undefined
  const [, input, output, read] = price

  return (t.input * input + t.output * output + t.cacheRead * read + t.cacheWrite * input * 1.25) / 1_000_000
}

export const shortModel = (model: string): string => model.replace(/^claude-/, '').replace(/\[.*\]$/, '')

// Keep samples inside the window, plus the last one before it as the baseline.
export const addSample = (samples: Sample[], s: Sample): Sample[] => {
  const all = [...samples, s]
  const firstIn = all.findIndex(x => s.t - x.t <= WINDOW_MS)

  return all.slice(Math.max(0, firstIn - 1))
}

// $/hr over the last window; falls back to the session average when the
// window holds under a minute of history.
export const ratePerHour = (b: Burn, now: number): number => {
  const recent = b.samples.filter(x => now - x.t <= WINDOW_MS)
  const base = b.samples.find(x => now - x.t > WINDOW_MS) ?? recent[0]
  if (base && now - base.t >= 60_000) return ((b.usd - base.usd) / (now - base.t)) * HOUR_MS
  const elapsed = now - b.startedAt

  return elapsed >= 60_000 ? (b.usd / elapsed) * HOUR_MS : 0
}

export const sessionRate = (b: Burn, now: number): number => {
  const elapsed = now - b.startedAt

  return elapsed > 0 ? (b.usd / elapsed) * HOUR_MS : 0
}

export const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

export const count = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n}`

export const duration = (ms: number): string => {
  const m = Math.floor(ms / 60_000)

  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export const bar = (percent: number, width: number): string => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export const HISTORY_MS = 60 * 60 * 1000

// Cost samples for the last hour, plus one baseline before it.
export const addHistory = (history: Sample[], s: Sample): Sample[] => {
  const all = [...history, s]
  const firstIn = all.findIndex(x => s.t - x.t <= HISTORY_MS)

  return all.slice(Math.max(0, firstIn - 1))
}

// Spend inside each of `n` equal buckets ending at `now`.
export const bucketSpend = (history: Sample[], now: number, n: number, spanMs = HISTORY_MS): number[] => {
  const at = (t: number) => {
    let v = 0
    for (const s of history) if (s.t <= t) v = s.usd
    return v
  }
  const size = spanMs / n

  return Array.from({ length: n }, (_, i) => {
    const start = now - spanMs + i * size

    return Math.max(0, at(start + size) - at(start))
  })
}

const TICKS = '▁▂▃▄▅▆▇█'

export const sparkline = (values: number[]): string => {
  const max = Math.max(...values)
  if (max <= 0) return TICKS[0]!.repeat(values.length)

  return values.map(v => TICKS[Math.min(7, Math.round((v / max) * 7))]).join('')
}

export type Heat = { flames: string; color: string }

export const heat = (perHour: number): Heat =>
  perHour <= 0
    ? { flames: '·', color: 'gray' }
    : perHour < 5
      ? { flames: '🔥', color: 'green' }
      : perHour < 20
        ? { flames: '🔥🔥', color: 'yellow' }
        : { flames: '🔥🔥🔥', color: 'red' }

export const THRESHOLDS = [50, 80, 100]

// Budget thresholds crossed now that weren't alerted before.
export const newAlerts = (spent: number, budget: number | undefined, alerted: number[]): number[] =>
  budget ? THRESHOLDS.filter(p => spent >= (budget * p) / 100 && !alerted.includes(p)) : []

// Hours until the budget runs out at `perHour`; undefined when not burning.
export const hoursToCap = (spent: number, budget: number, perHour: number): number | undefined =>
  perHour > 0 && spent < budget ? (budget - spent) / perHour : undefined

export const until = (iso: string | undefined, now: number): string | undefined => {
  if (!iso) return undefined
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return 'now'
  const d = Math.floor(ms / 86_400_000)

  return d >= 1 ? `${d}d${Math.floor((ms % 86_400_000) / 3_600_000)}h` : duration(ms)
}

// Each part's share of `width` cells; rounding remainder goes to the largest.
export const segments = (values: number[], width: number): number[] => {
  const total = values.reduce((a, b) => a + b, 0)
  if (total <= 0) return values.map(() => 0)
  const cells = values.map(v => Math.floor((v / total) * width))
  const left = width - cells.reduce((a, b) => a + b, 0)
  const top = values.indexOf(Math.max(...values))
  cells[top] = (cells[top] ?? 0) + left

  return cells
}

export const parseBudget = (args: string): number | 'off' | undefined => {
  const m = args.trim().match(/^budget\s+(off|\$?(\d+(?:\.\d+)?))$/i)
  if (!m) return undefined

  return m[1]!.toLowerCase() === 'off' ? 'off' : Number(m[2])
}
