import { describe, expect, test } from 'claude-code/testing'

import type { Task } from '../types'
import { classify } from './router'
import { bundleFor, filterEvents, hash, readArtifact, redact, tokensEst, writeArtifact } from './store'

const task = (): Task => ({
  id: 't1', title: 't', text: '', createdAt: 0, state: 'running', classification: classify(''),
  decision: { at: 0, mode: 'recommend', strategy: 'team', category: 'general', assignments: [], rationale: [], uncertainty: [], tradeoffs: [], fallback: '', isParallelWorthwhile: true },
  subtasks: [], artifacts: {}, events: [], seq: 0,
})
const W = { type: 'finding' as const, maxBytes: 1000, reason: 'test' }

describe('artifacts', () => {
  test('positive: create, update, versions and authors', async () => {
    let r = writeArtifact(task(), { ...W, title: 'API notes', content: 'v1', author: 's1' }, 10)
    expect(r.status).toBe('created')
    r = writeArtifact(r.task, { ...W, id: r.artifact.id, title: 'API notes', content: 'v2', author: 's2', baseVersion: 1 }, 20)
    expect(r.status).toBe('updated')
    expect(r.artifact.versions.map(v => [v.v, v.author])).toEqual([[1, 's1'], [2, 's2']])
    const ev = r.task.events
    expect(ev.map(e => [e.type, e.from, e.artifact])).toEqual([['artifact_created', 's1', 'api-notes'], ['artifact_updated', 's2', 'api-notes']])
  })

  test('positive: deduplicated by hash', async () => {
    let r = writeArtifact(task(), { ...W, title: 'A', content: 'same text', author: 's1' }, 1)
    const again = writeArtifact(r.task, { ...W, id: r.artifact.id, title: 'A', content: 'same text', author: 's2' }, 2)
    expect(again.status).toBe('unchanged')
    expect(again.artifact.versions.length).toBe(1)
    const copy = writeArtifact(r.task, { ...W, title: 'Another title', content: 'same text', author: 's3' }, 3)
    expect(copy.status).toBe('unchanged')
    expect(Object.keys(copy.task.artifacts)).toEqual(['a'])
    expect(hash('x')).toBe(hash('x'))
    expect(hash('x')).not.toBe(hash('y'))
  })

  test('negative: a stale write is refused and recorded', async () => {
    let r = writeArtifact(task(), { ...W, title: 'A', content: 'one', author: 's1' }, 1)
    r = writeArtifact(r.task, { ...W, id: 'a', title: 'A', content: 'two', author: 's1', baseVersion: 1 }, 2)
    const stale = writeArtifact(r.task, { ...W, id: 'a', title: 'A', content: 'three', author: 's2', baseVersion: 1 }, 3)
    expect(stale.status).toBe('stale')
    expect(stale.artifact.content).toBe('two')
    expect(stale.task.events.at(-1)!.isStale).toBe(true)
  })

  test('positive: reads record reader and staleness, only when asked', async () => {
    let r = writeArtifact(task(), { ...W, title: 'A', content: 'one', author: 's1' }, 1)
    r = writeArtifact(r.task, { ...W, id: 'a', title: 'A', content: 'two', author: 's1' }, 2)
    const before = r.task.events.length
    const read = readArtifact(r.task, 'a', 's2', 3, 1)
    expect(read.task.events.length).toBe(before + 1)
    const e = read.task.events.at(-1)!
    expect([e.type, e.to, e.artifact, e.version, e.isStale]).toEqual(['artifact_read', 's2', 'a', 2, true])
    expect(readArtifact(r.task, 'missing', 's2', 4).artifact).toBeUndefined()
  })

  test('edge: redaction, size bound and estimated tokens', async () => {
    const r = writeArtifact(task(), { ...W, title: 'Leak', content: `key sk-abcdefghijklmnopqrstu and API_KEY=hunter2 ${'x'.repeat(2000)}`, author: 's1' }, 1)
    expect(r.artifact.content).not.toContain('sk-abcdefghijklmnopqrstu')
    expect(r.artifact.content).not.toContain('hunter2')
    expect(r.artifact.isTruncated).toBe(true)
    expect(r.artifact.versions[0]!.tokensEst).toBe(tokensEst(r.artifact.content))
    expect(redact('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
  })

  test('bundles are references, not content', async () => {
    const r = writeArtifact(task(), { ...W, title: 'Spec', content: 'secret plan details', author: 'router' }, 1)
    const b = bundleFor(r.task, ['spec', 'nope'])
    expect(b).toEqual([{ id: 'spec', title: 'Spec', type: 'finding', version: 1, hash: hash('secret plan details'), tokensEst: tokensEst('secret plan details') }])
    expect(JSON.stringify(b)).not.toContain('secret plan details')
  })

  test('filters', async () => {
    let r = writeArtifact(task(), { ...W, title: 'A', content: 'x', author: 's1' }, 1)
    const t = readArtifact(r.task, 'a', 's2', 2).task
    expect(filterEvents(t.events, 'context').length).toBe(2)
    expect(filterEvents(t.events, 'agent', 's2').map(e => e.type)).toEqual(['artifact_read'])
    expect(filterEvents(t.events, 'failures')).toEqual([])
  })
})
