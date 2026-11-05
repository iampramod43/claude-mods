/**
 * The hook half of the monitor: this session describes itself.
 *
 * Every hook here passes the event on unchanged (`next(e)`) and only records
 * what happened in memory; a timer writes the snapshot to
 * `<config>/worktree-deck/live/<sessionId>.json` at most every FLUSH_MS, so
 * monitoring never waits on the disk and never changes what Claude does.
 */
import type { EngineInterface } from 'claude-code'

import type { Activity, DeckEvent, LiveSnapshot, Subagent, ToolRun } from '../types'
import { describeTool, filePathOf, oneLine } from './deck'

export const FLUSH_MS = 500
export const BEAT_MS = 5000

type Pending = { id: string; prompt: string }

export type Publisher = {
  snap?: LiveSnapshot
  file?: string
  limit: number
  dirty: boolean
  seq: number
  /** subagent spawns waiting for their first turn, matched by prompt */
  spawns: Pending[]
  writing?: Promise<void>
}

export const createPublisher = (limit: number): Publisher => ({ limit, dirty: false, seq: 0, spawns: [] })

export const liveDir = (config: string) => `${config.replace(/\/$/, '')}/worktree-deck/live`

const bound = <T>(list: T[], limit: number) => (list.length > limit * 2 ? list.slice(-limit) : list)

export const start = (p: Publisher, init: { sid: string; cwd: string; model?: string; now: number; file: string; previous?: LiveSnapshot }) => {
  const prev = init.previous && init.previous.sid === init.sid && !init.previous.ended ? init.previous : undefined
  p.file = init.file
  p.snap = {
    v: 1,
    sid: init.sid,
    cwd: init.cwd,
    model: init.model,
    startedAt: prev?.startedAt ?? init.now,
    beat: init.now,
    phase: prev ? 'input' : 'starting',
    phaseAt: init.now,
    events: prev?.events ?? [],
    tools: prev?.tools ?? [],
    subagents: prev?.subagents ?? [],
    toolCount: prev?.toolCount ?? 0,
    errorCount: prev?.errorCount ?? 0,
  }
  if (!prev) event(p, { kind: 'session.start', at: init.now, text: 'Session started' })
  p.dirty = true
}

export const event = (p: Publisher, e: Omit<DeckEvent, 'sid' | 'src' | 'id'> & { id?: string }) => {
  const s = p.snap
  if (!s) return
  const id = e.id ?? `${s.sid}:h:${e.at}:${p.seq++}`
  if (s.events.some(x => x.id === id)) return
  s.events = bound([...s.events, { ...e, id, sid: s.sid, src: 'hook' }], p.limit)
  p.dirty = true
}

const phase = (p: Publisher, ph: LiveSnapshot['phase'], now: number) => {
  if (!p.snap) return
  if (p.snap.phase !== ph) p.snap.phaseAt = now
  p.snap.phase = ph
  p.dirty = true
}

export const prompt = (p: Publisher, text: string, now: number) => {
  const t = oneLine(text, 200)
  if (!t) return
  event(p, { kind: 'prompt', at: now, text: t })
}

export const turnStart = (p: Publisher, e: { turnId: string; agentId?: string; text: string }, now: number) => {
  const s = p.snap
  if (!s) return
  if (e.agentId === undefined) {
    phase(p, 'working', now)
    s.permission = undefined
    event(p, { id: `turn:${e.turnId}:start`, kind: 'turn.start', at: now })
    return
  }
  // A subagent's first turn: tie its loop id to the spawn it came from.
  if (s.subagents.some(a => a.agentId === e.agentId)) return
  const i = p.spawns.findIndex(x => x.prompt === e.text)
  const spawn = i >= 0 ? p.spawns.splice(i, 1)[0] : undefined
  const agent = spawn ? s.subagents.find(a => a.id === spawn.id) : s.subagents.find(a => a.status === 'running' && !a.agentId)
  if (agent) {
    agent.agentId = e.agentId
    p.dirty = true
  }
}

export const turnComplete = (
  p: Publisher,
  e: { turnId: string; agentId?: string; reason: string; durationMs: number },
  now: number,
) => {
  const s = p.snap
  if (!s) return
  const ok = e.reason === 'answer'
  if (e.agentId !== undefined) {
    const agent = s.subagents.find(a => a.agentId === e.agentId)
    if (agent && agent.status === 'running') {
      agent.status = ok || e.reason === 'aborted' ? 'done' : 'error'
      agent.endedAt = now
      event(p, {
        id: `agent:${agent.id}:end`,
        kind: 'subagent.end',
        at: now,
        agentId: e.agentId,
        ok,
        text: agent.description,
        durationMs: now - agent.startedAt,
      })
    }
    return
  }
  s.tool = undefined
  s.permission = undefined
  if (e.reason === 'aborted') {
    phase(p, 'input', now)
    event(p, { id: `turn:${e.turnId}:abort`, kind: 'interrupt', at: now, text: 'Interrupted' })
  } else if (ok) {
    phase(p, 'input', now)
  } else {
    phase(p, 'error', now)
    s.errorCount++
    event(p, { id: `turn:${e.turnId}:error`, kind: 'error', at: now, ok: false, text: e.reason === 'refusal' ? 'The model refused' : 'The turn ended in an error' })
  }
  event(p, { id: `turn:${e.turnId}:end`, kind: 'turn.end', at: now, ok, durationMs: e.durationMs })
}

export const spawn = (
  p: Publisher,
  e: { tool_use_id: string; prompt: string; description: string; subagentType: string; background: boolean },
  now: number,
) => {
  const s = p.snap
  if (!s) return
  const agent: Subagent = {
    id: e.tool_use_id,
    description: oneLine(e.description || e.subagentType || 'Subagent', 120),
    type: e.subagentType || undefined,
    background: e.background,
    startedAt: now,
    status: 'running',
    tools: 0,
  }
  s.subagents = bound([...s.subagents.filter(a => a.id !== agent.id), agent], 50)
  p.spawns = [...p.spawns, { id: agent.id, prompt: e.prompt }].slice(-20)
  event(p, { id: `agent:${agent.id}:start`, kind: 'subagent.start', at: now, text: agent.description, tool: agent.type })
}

type ToolIn = { tool: string; tool_use_id?: string; agentId?: string } & Record<string, unknown>

const toolId = (p: Publisher, e: ToolIn) => e.tool_use_id ?? `${e.tool}:${p.seq++}`

export const permissionAsked = (p: Publisher, e: { tool: string; input: unknown; tool_use_id?: string; agentId?: string }, now: number) => {
  const s = p.snap
  if (!s) return
  const a: Activity = { name: e.tool, detail: describeTool(e.tool, e.input), path: filePathOf(e.input), at: now }
  s.permission = a
  phase(p, 'permission', now)
  event(p, {
    id: `perm:${e.tool_use_id ?? `${e.tool}:${now}`}`,
    kind: 'permission',
    at: now,
    tool: e.tool,
    toolUseId: e.tool_use_id,
    agentId: e.agentId,
    text: a.detail,
    path: a.path,
  })
}

export const toolStart = (p: Publisher, e: ToolIn, now: number): string => {
  const s = p.snap
  const id = toolId(p, e)
  if (!s) return id
  const detail = describeTool(e.tool, e)
  const path = filePathOf(e)
  const run: ToolRun = { id, tool: e.tool, detail, path, agentId: e.agentId, startedAt: now }
  s.tools = bound([...s.tools.filter(t => t.id !== id), run], p.limit)
  s.toolCount++
  if (e.agentId === undefined) s.tool = { name: e.tool, detail, path, at: now }
  else {
    const agent = s.subagents.find(a => a.agentId === e.agentId)
    if (agent) {
      agent.tools++
      agent.lastTool = detail
    }
  }
  event(p, { id: `tool:${id}:start`, kind: 'tool.start', at: now, tool: e.tool, toolUseId: id, agentId: e.agentId, text: detail, path })
  return id
}

export const toolEnd = (
  p: Publisher,
  id: string,
  e: ToolIn,
  r: { deny?: string; isError?: boolean; text?: string } | undefined,
  now: number,
) => {
  const s = p.snap
  if (!s) return
  const ok = !r?.deny && !r?.isError
  const error = ok ? undefined : oneLine((r?.deny ?? r?.text ?? 'failed').split('\n').find(l => l.trim()) ?? 'failed', 160)
  const run = s.tools.find(t => t.id === id)
  if (run) {
    run.endedAt = now
    run.ok = ok
    run.error = error
  }
  if (!ok) s.errorCount++
  if (s.permission && (e.agentId === undefined || s.phase === 'permission')) {
    const asked = s.events.some(x => x.id === `perm:${id}`)
    if (asked) {
      event(p, { id: `perm:${id}:done`, kind: 'permission.done', at: now, tool: e.tool, toolUseId: id, ok: !r?.deny, text: r?.deny ? 'Denied' : 'Approved' })
      s.permission = undefined
      if (s.phase === 'permission') phase(p, 'working', now)
    }
  }
  if (e.agentId === undefined && s.tool && s.tool.at <= now) s.tool = undefined
  event(p, {
    id: `tool:${id}:end`,
    kind: 'tool.end',
    at: now,
    tool: e.tool,
    toolUseId: id,
    agentId: e.agentId,
    ok,
    text: error,
    durationMs: run ? now - run.startedAt : undefined,
  })
}

export const end = (p: Publisher, reason: string, now: number) => {
  const s = p.snap
  if (!s) return
  s.ended = { at: now, reason }
  s.tool = undefined
  s.permission = undefined
  event(p, { kind: 'session.end', at: now, text: `Session ended (${reason})` })
}

/** Writes the snapshot when it changed (or `force`), one write at a time. */
export async function flush($: EngineInterface, p: Publisher, now: number, force = false) {
  if (!p.snap || !p.file) return
  if (!p.dirty && !force) return
  if (p.writing) return p.writing
  p.snap.beat = now
  p.dirty = false
  const text = JSON.stringify(p.snap)
  p.writing = $.fs
    .write(p.file, text)
    .catch(() => {
      p.dirty = true
    })
    .finally(() => {
      p.writing = undefined
    })
  return p.writing
}
