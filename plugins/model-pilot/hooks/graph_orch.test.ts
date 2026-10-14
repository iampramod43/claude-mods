import { describe, expect, test } from 'claude-code/testing'

import type { Config, Pilot, Task } from '../types'
import { edgeLines, edgesOf, layoutGraph } from './graph'
import { failToStart, finishSubtask, retry, toLaunch, workerPrompt } from './orchestrate'
import { DARK } from './raster'
import { buildRegistry, plan } from './router'
import { readArtifact, writeArtifact } from './store'

const cfg: Config = { mode: 'recommend', maxAgents: 3, maxParallel: 3, isAnimated: true, maxArtifactBytes: 50_000 }

const teamTask = (id = 't1'): Task => {
  const pl = plan('Review: review a in depth; review b in depth', cfg, buildRegistry(undefined, undefined), 0)
  let t: Task = {
    id, title: pl.title, text: '', createdAt: 0, state: 'running', classification: undefined as never, decision: pl.decision,
    subtasks: pl.subtasks, artifacts: {}, events: [], seq: 0,
  }
  t = writeArtifact(t, { id: 'task-spec', title: 'Task spec', type: 'spec', content: 'spec', author: 'router', maxBytes: 1000, reason: 'spec' }, 1).task
  return t
}
const pilotOf = (tasks: Task[], c: Partial<Config> = {}): Pilot => ({ tasks, agents: {}, registry: [], config: { ...cfg, ...c }, seq: 0 })
const run = (t: Task, id: string): Task => ({ ...t, subtasks: t.subtasks.map(s => (s.id === id ? { ...s, state: 'running', agentId: `ag-${id}` } : s)) })

describe('launching', () => {
  test('positive: ready subtasks start; dependents wait', async () => {
    const t = teamTask()
    expect(toLaunch(pilotOf([t]), t, 0).launch.map(s => s.id)).toEqual(['s1', 's2'])
  })

  test('negative: limits and budget are respected', async () => {
    const t = teamTask()
    expect(toLaunch(pilotOf([t], { maxParallel: 1 }), t, 0).launch.length).toBe(1)
    const busy = run(t, 's1')
    expect(toLaunch(pilotOf([busy], { maxParallel: 1 }), busy, 0).launch.length).toBe(0)
    expect(toLaunch(pilotOf([t], { budgetUsd: 1 }), t, 1.5)).toEqual({ launch: [], budgetBlocked: true })
    expect(toLaunch(pilotOf([t], { mode: 'budget-aware', budgetUsd: 1 }), t, undefined).budgetBlocked).toBe(true)
    expect(toLaunch(pilotOf([{ ...t, state: 'awaiting-approval' }]), { ...t, state: 'awaiting-approval' }, 0).launch).toEqual([])
  })

  test('the worker prompt passes references, never claims shared context', async () => {
    const p = workerPrompt(teamTask(), teamTask().subtasks[0]!)
    expect(p).toContain('task-spec')
    expect(p).toContain('NOT in your context')
    expect(p).not.toContain('\nspec\n')
  })
})

describe('completion, handoff and failure', () => {
  test('positive: output artifact, handoffs and unblocking with correct ids', async () => {
    let t = run(run(teamTask(), 's1'), 's2')
    t = finishSubtask(t, 's1', { reason: 'answer', answer: 'A found', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, model: 'claude-haiku-5-5' } }, 100, 1000)
    expect(t.subtasks[2]!.state).toBe('queued')
    const h = t.events.find(e => e.type === 'handoff_created')!
    expect([h.from, h.to, h.artifact]).toEqual(['s1', 's3', 'out-s1'])
    expect(t.artifacts['out-s1']!.versions[0]!.author).toBe('s1')
    t = finishSubtask(t, 's2', { reason: 'answer', answer: 'B found' }, 200, 1000)
    expect(t.subtasks[2]!.state).toBe('ready')
    expect(t.events.some(e => e.type === 'dependency_unblocked' && e.to === 's3')).toBe(true)
    expect(t.subtasks[1]!.usage).toBeUndefined()
  })

  test('negative: a failure blocks dependents and is not completion', async () => {
    let t = run(run(teamTask(), 's1'), 's2')
    t = finishSubtask(t, 's1', { reason: 'error', answer: '' }, 100, 1000)
    expect(t.subtasks[0]!.state).toBe('failed')
    expect(t.subtasks[2]!.state).toBe('blocked')
    t = finishSubtask(t, 's2', { reason: 'answer', answer: 'ok' }, 200, 1000)
    expect(t.state).toBe('failed')
    t = retry(t, 's1', 'sonnet', 300)
    expect(t.subtasks[0]!.state).toBe('ready')
    expect(t.subtasks[0]!.model).toBe('sonnet')
    expect(t.subtasks[2]!.state).toBe('queued')
    expect(t.state).toBe('running')
  })

  test('edge: an aborted agent is cancelled', async () => {
    const t = finishSubtask(run(teamTask(), 's1'), 's1', { reason: 'aborted', answer: '' }, 1, 1000)
    expect(t.subtasks[0]!.state).toBe('cancelled')
  })

  test('separate tasks never cross-contaminate', async () => {
    const a = run(teamTask('ta'), 's1')
    const b = teamTask('tb')
    const a2 = finishSubtask(a, 's1', { reason: 'answer', answer: 'x' }, 5, 1000)
    expect(b.events.length).toBe(1)
    expect(a2.events.every(e => e.id.startsWith('ta-'))).toBe(true)
  })
})

describe('graph', () => {
  test('negative: no context edges before real events', async () => {
    const t = teamTask()
    const kinds = edgesOf(t).map(e => e.kind)
    expect(kinds.filter(k => k === 'dep').length).toBe(2)
    expect(kinds.filter(k => k === 'read' || k === 'handoff').length).toBe(0)
    expect(edgeLines(t).some(l => l.includes('R▶'))).toBe(false)
  })

  test('positive: direction and type come from the events', async () => {
    let t = teamTask()
    t = readArtifact(t, 'task-spec', 's1', 10).task
    t = writeArtifact(t, { title: 'Finding', type: 'finding', content: 'f', author: 's2', maxBytes: 100, reason: 'w' }, 11).task
    t = finishSubtask(run(t, 's1'), 's1', { reason: 'answer', answer: 'done' }, 12, 1000)
    const e = edgesOf(t)
    expect(e.find(x => x.kind === 'read')).toMatchObject({ from: 'task-spec', to: 's1' })
    expect(e.find(x => x.kind === 'write' && x.from === 's2')).toMatchObject({ to: 'finding' })
    expect(e.find(x => x.kind === 'handoff')).toMatchObject({ from: 's1', to: 's3', artifact: 'out-s1' })
    const g = layoutGraph(t, 70, DARK, 12, {})
    const text = g.grid.lines().join('\n')
    expect(text).toContain('SHARED CONTEXT')
    expect(text).toContain('◀')
    expect(text).toContain('▶')
    expect(text).toContain('═')
    // The just-happened handoff is lit.
    expect(g.grid.cells.some(c => c.fg === DARK.hot)).toBe(true)
    expect(layoutGraph(t, 70, DARK, 10_000, {}).grid.cells.some(c => c.fg === DARK.hot)).toBe(false)
  })

  test('edge: many artifacts and agents stay bounded', async () => {
    let t = teamTask()
    for (let i = 0; i < 20; i++) t = writeArtifact(t, { title: `note ${i}`, type: 'note', content: `c${i}`, author: 's1', maxBytes: 100, reason: 'w' }, 20 + i).task
    const g = layoutGraph(t, 64, DARK, 100, { maxArtifacts: 6 })
    expect(g.artifacts.length).toBe(6)
    expect(g.grouped).toBe(16)
    expect(g.grid.lines().join('\n')).toContain('+16 older')
  })
})

describe('refused spawns', () => {
  test('negative: a refused spawn fails the subtask and blocks its dependents', async () => {
    const t = failToStart(run(teamTask(), 's1'), 's1', 'classifier refused', 5)
    expect(t.subtasks[0]!.state).toBe('failed')
    expect(t.subtasks[2]!.state).toBe('blocked')
    expect(t.events.at(-1)!.reason).toBeDefined()
  })
})
