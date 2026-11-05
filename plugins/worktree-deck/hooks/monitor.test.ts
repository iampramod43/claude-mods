import { describe, expect, test } from 'claude-code/testing'

import type { DeckEvent } from '../types'
import {
  emptyTranscript,
  feedTranscript,
  IDLE_MS,
  liveState,
  mergeEvents,
  mostUrgent,
  openTool,
  promptText,
  splitChunk,
  STALE_MS,
  transcriptState,
} from './monitor'
import * as pub from './publisher'

const T0 = Date.parse('2026-11-05T15:42:00.000Z')
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()
const line = (r: unknown) => JSON.stringify(r)

const records = [
  line({ type: 'ai-title', aiTitle: 'Retry uploads' }),
  line({ type: 'user', uuid: 'u1', timestamp: iso(0), cwd: '/r/.wt/feat/src', message: { content: 'make retries exponential' } }),
  line({
    type: 'assistant',
    uuid: 'a1',
    timestamp: iso(2),
    message: {
      model: 'claude-opus-5-5',
      content: [
        { type: 'text', text: 'Looking at the upload code.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/r/.wt/feat/src/up.ts' } },
      ],
    },
  }),
  line({ type: 'user', uuid: 'u2', timestamp: iso(3), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  line({ type: 'assistant', uuid: 'a2', timestamp: iso(5), message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } }),
]

describe('transcript', () => {
  test('records become ordered events with tool runs and durations', async () => {
    const st = emptyTranscript('s1')
    feedTranscript(st, records, 100)
    expect(st.cwd).toBe('/r/.wt/feat/src')
    expect(st.title).toBe('Retry uploads')
    expect(st.model).toBe('claude-opus-5-5')
    expect(st.prompt).toBe('make retries exponential')
    expect(st.events.map(e => e.kind)).toEqual(['prompt', 'text', 'tool.start', 'tool.end', 'tool.start'])
    expect(st.tools[0]).toMatchObject({ id: 't1', tool: 'Read', ok: true, endedAt: T0 + 3000 })
    expect(st.events[3]).toMatchObject({ id: 'tool:t1:end', durationMs: 1000 })
    expect(openTool(st)).toMatchObject({ name: 'Bash', detail: 'Bash npm test' })
  })

  test('a chunk cut mid-line waits for the rest of the line', async () => {
    const all = `${records.join('\n')}\n`
    const cut = 300
    const a = splitChunk('', all.slice(0, cut))
    const b = splitChunk(a.rest, all.slice(cut))
    const st = emptyTranscript('s1')
    feedTranscript(st, a.lines, 100)
    feedTranscript(st, b.lines, 100)
    expect(b.rest).toBe('')
    expect(st.events).toHaveLength(5)
  })

  test('feeding the same lines twice adds nothing (dedupe by id)', async () => {
    const st = emptyTranscript('s1')
    feedTranscript(st, records, 100)
    feedTranscript(st, records, 100)
    expect(st.events).toHaveLength(5)
    expect(st.toolCount).toBe(2)
  })

  test('turn ends, interrupts, errors and slash commands', async () => {
    const st = emptyTranscript('s1')
    feedTranscript(
      st,
      [
        line({ type: 'user', uuid: 'c', timestamp: iso(0), message: { content: '<command-name>/review</command-name><command-args>42</command-args>' } }),
        line({ type: 'system', subtype: 'turn_duration', uuid: 'd', timestamp: iso(9), durationMs: 9000 }),
        line({ type: 'user', uuid: 'i', timestamp: iso(10), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
        line({ type: 'user', uuid: 'f', timestamp: iso(11), message: { content: [{ type: 'tool_result', tool_use_id: 'zz', is_error: true, content: 'boom\nstack' }] } }),
        line({ type: 'assistant', uuid: 'side', isSidechain: true, timestamp: iso(12), message: { content: [{ type: 'text', text: 'subagent' }] } }),
      ],
      100,
    )
    expect(st.events.map(e => e.kind)).toEqual(['prompt', 'turn.end', 'interrupt', 'tool.end'])
    expect(st.events[0]!.text).toBe('/review 42')
    expect(st.events[3]).toMatchObject({ ok: false, text: 'boom' })
    expect(st.errorCount).toBe(1)
    expect(promptText('<system-reminder>x</system-reminder>')).toBeUndefined()
  })

  test('history stays bounded', async () => {
    const st = emptyTranscript('s1')
    const many = Array.from({ length: 300 }, (_, i) =>
      line({ type: 'user', uuid: `p${i}`, timestamp: iso(i), message: { content: `prompt ${i}` } }),
    )
    feedTranscript(st, many, 50)
    expect(st.events.length).toBeLessThanOrEqual(100)
    expect(st.events.at(-1)!.text).toBe('prompt 299')
  })
})

describe('state machine', () => {
  const now = T0 + 60_000
  test('transcript only', async () => {
    expect(transcriptState({ last: 'tool.start' }, now - 5000, now, true)).toEqual({ state: 'working', stalled: false })
    expect(transcriptState({ last: 'tool.start' }, now - 45_000, now, true)).toEqual({ state: 'working', stalled: true })
    expect(transcriptState({ last: 'turn.end' }, now - 5000, now, true).state).toBe('input')
    expect(transcriptState({ last: 'interrupt' }, now - 5000, now, undefined).state).toBe('input')
    expect(transcriptState({ last: 'error' }, now - 5000, now, undefined).state).toBe('error')
    expect(transcriptState({ last: 'text' }, now - 2000, now, undefined).state).toBe('working')
    expect(transcriptState({ last: 'text' }, now - 20_000, now, undefined).state).toBe('input')
    expect(transcriptState({ last: 'prompt' }, now - IDLE_MS - 1, now, undefined).state).toBe('idle')
    // A process that is gone: the session ended, its transcript remains.
    expect(transcriptState({ last: 'tool.start' }, now - 5000, now, false).state).toBe('completed')
  })

  test('live', async () => {
    const base = { beat: now - 1000, phaseAt: now - 1000 }
    expect(liveState({ ...base, phase: 'starting' }, now)).toBe('initializing')
    expect(liveState({ ...base, phase: 'starting', phaseAt: now - 60_000 }, now)).toBe('idle')
    expect(liveState({ ...base, phase: 'working' }, now)).toBe('working')
    expect(liveState({ ...base, phase: 'permission' }, now)).toBe('permission')
    expect(liveState({ ...base, phase: 'input' }, now)).toBe('input')
    expect(liveState({ ...base, phase: 'input', phaseAt: now - IDLE_MS - 1 }, now)).toBe('idle')
    expect(liveState({ ...base, phase: 'working', beat: now - STALE_MS - 1 }, now)).toBe('disconnected')
    expect(liveState({ ...base, phase: 'working', ended: { at: now, reason: 'exit' } }, now)).toBe('completed')
  })

  test('a worktree shows its most urgent session', async () => {
    expect(mostUrgent(['idle', 'working', 'permission'])).toBe('permission')
    expect(mostUrgent(['completed', 'input'])).toBe('input')
    expect(mostUrgent([])).toBe('none')
  })
})

describe('merging', () => {
  const ev = (id: string, at: number, kind: DeckEvent['kind'], src: DeckEvent['src']): DeckEvent => ({ id, sid: 's', at, kind, src })
  test('hooks own lifecycle and tools, the transcript adds text; out-of-order sorts', async () => {
    const live = [ev('tool:t1:start', 2, 'tool.start', 'hook'), ev('p', 1, 'prompt', 'hook'), ev('tool:t1:end', 3, 'tool.end', 'hook')]
    const tr = [ev('u1', 1, 'prompt', 'transcript'), ev('a1', 2, 'text', 'transcript'), ev('tool:t1:start', 2, 'tool.start', 'transcript')]
    const m = mergeEvents(live, tr, 100)
    expect(m.map(e => `${e.kind}:${e.src}`)).toEqual(['prompt:hook', 'tool.start:hook', 'text:transcript', 'tool.end:hook'])
  })
  test('without a live feed the transcript speaks alone, bounded', async () => {
    const tr = Array.from({ length: 10 }, (_, i) => ev(`e${i}`, i, 'prompt', 'transcript'))
    expect(mergeEvents(undefined, tr, 3).map(e => e.id)).toEqual(['e7', 'e8', 'e9'])
  })
})

describe('publisher', () => {
  test('a turn with a permission ask, a subagent and a failing tool', async () => {
    const p = pub.createPublisher(100)
    pub.start(p, { sid: 's1', cwd: '/r', now: 0, file: '/x/s1.json' })
    expect(p.snap!.phase).toBe('starting')
    pub.prompt(p, 'fix the build', 1)
    pub.turnStart(p, { turnId: 'T', text: 'fix the build' }, 2)
    expect(p.snap!.phase).toBe('working')

    pub.permissionAsked(p, { tool: 'Bash', input: { command: 'rm -rf dist' }, tool_use_id: 'b1' }, 3)
    expect(p.snap!.phase).toBe('permission')
    expect(p.snap!.permission?.detail).toBe('Bash rm -rf dist')
    const id = pub.toolStart(p, { tool: 'Bash', tool_use_id: 'b1', command: 'rm -rf dist' }, 3)
    pub.toolEnd(p, id, { tool: 'Bash', tool_use_id: 'b1' }, { isError: true, text: 'rm: denied\nmore' }, 7)
    expect(p.snap!.phase).toBe('working')
    expect(p.snap!.permission).toBeUndefined()
    expect(p.snap!.tools[0]).toMatchObject({ ok: false, error: 'rm: denied', endedAt: 7 })

    pub.spawn(p, { tool_use_id: 'ag', prompt: 'look around', description: 'Explore repo', subagentType: 'Explore', background: false }, 8)
    pub.turnStart(p, { turnId: 'S', agentId: 'A1', text: 'look around' }, 9)
    pub.toolStart(p, { tool: 'Grep', tool_use_id: 'g1', agentId: 'A1', pattern: 'retry' }, 10)
    expect(p.snap!.subagents[0]).toMatchObject({ agentId: 'A1', tools: 1, status: 'running' })
    pub.turnComplete(p, { turnId: 'S', agentId: 'A1', reason: 'answer', durationMs: 5 }, 14)
    expect(p.snap!.subagents[0]).toMatchObject({ status: 'done', endedAt: 14 })

    pub.turnComplete(p, { turnId: 'T', reason: 'answer', durationMs: 20 }, 20)
    expect(p.snap!.phase).toBe('input')
    expect(p.snap!.events.map(e => e.kind)).toEqual([
      'session.start',
      'prompt',
      'turn.start',
      'permission',
      'tool.start',
      'permission.done',
      'tool.end',
      'subagent.start',
      'tool.start',
      'subagent.end',
      'turn.end',
    ])
    pub.end(p, 'prompt_input_exit', 30)
    expect(p.snap!.ended).toEqual({ at: 30, reason: 'prompt_input_exit' })
  })

  test('a restart of the same session keeps its history', async () => {
    const p = pub.createPublisher(100)
    pub.start(p, { sid: 's1', cwd: '/r', now: 0, file: '/x/s1.json' })
    pub.prompt(p, 'hello', 1)
    const q = pub.createPublisher(100)
    pub.start(q, { sid: 's1', cwd: '/r', now: 50, file: '/x/s1.json', previous: p.snap })
    expect(q.snap!.events.map(e => e.kind)).toEqual(['session.start', 'prompt'])
    expect(q.snap!.startedAt).toBe(0)
  })
})
