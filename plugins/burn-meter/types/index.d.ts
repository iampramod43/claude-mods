export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type ModelTally = Tokens & { turns: number }
export type Sample = { t: number; usd: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Burn = {
  startedAt: number
  usd: number
  samples: Sample[]
  history: Sample[]
  tokens: Tokens
  turns: number
  models: Record<string, ModelTally>
  contextPercent?: number
  limits: Limit[]
  budget?: number
  alerted: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'burn-meter': { burn: Burn; tick: number }
  }
}
