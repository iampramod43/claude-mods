import { describe, expect, test } from 'claude-code/testing'

import type { Config } from '../types'
import { aliasOf, buildRegistry, classify, isSupported, plan, splitTask } from './router'

const cfg = (c: Partial<Config> = {}): Config => ({ mode: 'recommend', maxAgents: 3, maxParallel: 3, isAnimated: true, maxArtifactBytes: 50_000, ...c })
const reg = buildRegistry('claude-opus-5-5', 1_000_000)

describe('registry', () => {
  test('positive: only the Agent tool schema models, session facts where reported', async () => {
    expect(reg.map(m => m.alias)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    const opus = reg.find(m => m.alias === 'opus')!
    expect(opus.isSessionDefault).toBe(true)
    expect(opus.contextWindow).toBe(1_000_000)
    expect(opus.contextSource).toBe('session')
  })

  test('negative: missing metadata stays unknown', async () => {
    const haiku = reg.find(m => m.alias === 'haiku')!
    expect(haiku.contextWindow).toBeUndefined()
    expect(haiku.contextSource).toBe('unknown')
    expect(haiku.isVerified).toBe(false)
    expect(reg.find(m => m.alias === 'fable')!.tier).toBeUndefined()
    expect(reg.find(m => m.alias === 'fable')!.tierSource).toBe('unknown')
  })

  test('edge: aliases from full ids; unsupported names refused', async () => {
    expect(aliasOf('claude-sonnet-5-5')).toBe('sonnet')
    expect(aliasOf('haiku')).toBe('haiku')
    expect(isSupported('gpt-5')).toBe(false)
    expect(isSupported('openrouter/llama')).toBe(false)
  })
})

describe('classification and splitting', () => {
  test('positive: structure decides the shape', async () => {
    expect(splitTask('Audit: a; b; c').parts.length).toBe(3)
    expect(classify('Audit: review a; review b; review c').shape).toBe('parallel')
    expect(classify('Fix the bug then add a test then update docs').shape).toBe('sequential')
    expect(classify('rename a variable').shape).toBe('single-step')
  })

  test('edge: signals explain every judgement', async () => {
    const c = classify('Deploy the payment migration to production carefully')
    expect(c.risk).toBe('high')
    expect(c.signals.join(' ')).toContain('risk')
  })
})

describe('routing policy', () => {
  test('positive: a short task uses no agent', async () => {
    const p = plan('quick: rename one variable', cfg(), reg, 0)
    expect(p.decision.strategy).toBe('direct')
    expect(p.subtasks).toEqual([])
  })

  test('positive: long separable work gets a team plus integration', async () => {
    const p = plan('Review the mods: review burn-meter hooks thoroughly; review file-trail hooks thoroughly; review browser-trail hooks thoroughly', cfg(), reg, 0)
    expect(p.decision.strategy).toBe('team')
    expect(p.decision.isParallelWorthwhile).toBe(true)
    expect(p.subtasks.map(s => s.id)).toEqual(['s1', 's2', 's3'])
    expect(p.subtasks[2]!.deps).toEqual(['s1', 's2'])
    expect(p.subtasks.length).toBeLessThanOrEqual(3)
  })

  test('positive: sequential work avoids parallelism', async () => {
    const p = plan('Investigate the slow build then propose a fix then write a short report on it for the team', cfg(), reg, 0)
    expect(p.decision.strategy).toBe('single')
    expect(p.subtasks.length).toBe(1)
  })

  test('negative: single-model mode never plans a team', async () => {
    const p = plan('Review: review a in depth; review b in depth; review c in depth', cfg({ mode: 'single-model' }), reg, 0)
    expect(p.decision.strategy).toBe('single')
  })

  test('negative: unsupported or untiered models are never chosen', async () => {
    const p = plan('Research: compare a thoroughly; compare b thoroughly', cfg(), reg, 0)
    for (const s of p.subtasks) expect(['haiku', 'sonnet', 'opus']).toContain(s.model)
    const pinned = plan('Research: a; b', cfg({ pin: 'gpt-5' }), reg, 0)
    expect(pinned.decision.refused).toContain('not one this Claude Code build can invoke')
    expect(pinned.subtasks).toEqual([])
  })

  test('edge: budget-aware caps the tier; maxAgents caps the team', async () => {
    const text = 'Architecture: design the auth system in depth; analyze the security trade-offs in depth; plan the production migration in depth'
    expect(plan(text, cfg(), reg, 0).subtasks.some(s => s.model === 'opus')).toBe(true)
    expect(plan(text, cfg({ mode: 'budget-aware' }), reg, 0).subtasks.every(s => s.model !== 'opus')).toBe(true)
    const capped = plan('Many: a in depth; b in depth; c in depth; d in depth; e in depth', cfg({ maxAgents: 3 }), reg, 0)
    expect(capped.subtasks.length).toBe(3)
  })

  test('edge: a model failing this session is avoided', async () => {
    const shaky = reg.map(m => (m.alias === 'sonnet' ? { ...m, failures: 2 } : m))
    const p = plan('Write the docs for the parser module covering every public function and its errors', cfg(), shaky, 0)
    expect(p.subtasks.every(s => s.model !== 'sonnet')).toBe(true)
  })

  test('every decision explains itself', async () => {
    const p = plan('Review: a in depth; b in depth', cfg(), reg, 0)
    expect(p.decision.rationale.length).toBeGreaterThan(0)
    expect(p.decision.uncertainty.join(' ')).toContain('Prices are unknown')
    expect(p.decision.fallback).toContain('retry')
    for (const a of p.decision.assignments) expect(a.reason).toContain('policy tier')
  })
})
