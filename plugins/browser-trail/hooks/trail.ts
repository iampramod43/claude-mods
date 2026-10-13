// The trail as pure functions over plain values, so it can be tested alone.

import type { BrowserEvent, PageFact, Status, Trail, View } from '../types'
import type { Classified } from './adapters'
import { batchProgress, evidenceOf, pageFromOutput } from './adapters'
import { preview, redactText } from './redact'

export const MAX_EVENTS = 200
export const LIVE_MS = 60_000

export const empty = (sessionId = ''): Trail => ({
  sessionId,
  events: [],
  seq: 0,
  isEnded: false,
  connected: [],
  dropped: 0,
  lastAt: 0,
})

export const emptyView = (): View => ({
  isDetailOpen: false,
  isFailuresOnly: false,
  isHelpOpen: false,
  isAllTools: false,
  hiddenThrough: 0,
})

const bound = (t: Trail): Trail => {
  if (t.events.length <= MAX_EVENTS) return t
  const over = t.events.length - MAX_EVENTS
  return { ...t, events: t.events.slice(over), dropped: t.dropped + over }
}

// A call began. A second start for an id already on the trail is a duplicate
// and changes nothing; a start for an id whose result came first fills it in.
export const start = (t: Trail, id: string, tool: string, c: Classified, at: number): Trail => {
  const known = t.events.find(ev => ev.id === id)
  if (known) {
    if (known.startedAt !== undefined) return t
    return {
      ...t,
      events: t.events.map(ev =>
        ev.id === id ? { ...ev, startedAt: at, page: ev.page ?? pageFor(t) } : ev,
      ),
    }
  }
  const seq = t.seq + 1
  const ev: BrowserEvent = {
    id,
    seq,
    toolName: tool,
    integration: c.integration,
    actionType: c.actionType,
    summary: c.summary,
    title: c.title,
    detail: c.detail,
    target: c.target,
    inputSummary: c.inputSummary,
    classification: c.classification,
    startedAt: at,
    status: 'running',
    steps: c.steps?.map(label => ({ label, status: 'unknown' as const })),
  }
  return bound({ ...t, seq, events: [...t.events, ev], lastAt: Math.max(t.lastAt, at) })
}

// The page a call is believed to act on: the last page fact, correlated by
// order alone (a call does not say which page it ran on).
const pageFor = (t: Trail): PageFact | undefined =>
  t.page ? { ...t.page, confidence: 'correlated', via: `last known page (${t.page.via})` } : undefined

// A bounded preview of a result, cut before any page snapshot: page content
// is not kept, only noted as evidence.
// What a tool's result says, without what is not the tool's: Claude Code's
// own <system-reminder> notes appended to results, and Claude in Chrome's
// trailing Tab Context block (the page is shown on its own).
export const cleanOutput = (text: string) =>
  text
    .replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, '')
    .replace(/\n*\s*Tab Context:[\s\S]*$/, '')
    .trim()

export const outputPreview = (text: string) => {
  const clean = cleanOutput(text)
  const cut = clean.search(/Page Snapshot|```yaml|^\s*uid=/m)
  const head = cut === -1 ? clean : clean.slice(0, cut)
  return preview(redactText(head), 800) || undefined
}

const stepsAfter = (steps: BrowserEvent['steps'], status: Status, text: string): BrowserEvent['steps'] => {
  if (!steps) return undefined
  const got = batchProgress(steps.length, status !== 'ok', text)
  if (!got) return steps
  return steps.map((st, i) => ({
    ...st,
    status: i === got.failedAt ? 'error' : i < got.completed ? 'ok' : got.failedAt !== undefined ? 'not run' : 'unknown',
  }))
}

export type Outcome = {
  isError?: boolean
  isDenied?: boolean
  text?: string
  result?: unknown
}

export const statusOf = (o: Outcome): { status: Status; source: BrowserEvent['statusSource'] } => {
  if (o.isDenied) return { status: 'error', source: 'tool-result' }
  if (!o.isError) return { status: 'ok', source: 'tool-result' }
  if (o.text && /\btime(d)?[ -]?out\b|timeout|deadline exceeded/i.test(o.text)) return { status: 'timeout', source: 'error-text' }
  return { status: 'error', source: 'tool-result' }
}

// A call returned. A second result for the same id is a duplicate; a result
// for an id never started is kept with its start unknown.
export const finish = (t: Trail, id: string, o: Outcome, at: number, call?: { tool: string; c: Classified }): Trail => {
  let ev = t.events.find(e => e.id === id)
  let next = t
  if (!ev) {
    if (!call) return t
    const seq = t.seq + 1
    ev = {
      id,
      seq,
      toolName: call.tool,
      integration: call.c.integration,
      actionType: call.c.actionType,
      summary: call.c.summary,
      title: call.c.title,
      detail: call.c.detail,
      target: call.c.target,
      inputSummary: call.c.inputSummary,
      classification: call.c.classification,
      status: 'running',
      steps: call.c.steps?.map(label => ({ label, status: 'unknown' as const })),
    }
    next = { ...t, seq, events: [...t.events, ev] }
  }
  if (ev.status !== 'running') return t

  const { status, source } = statusOf(o)
  const text = o.text ?? ''
  const reported = text ? pageFromOutput(text, ev.toolName) : undefined
  const requested = call?.c.requestedUrl
  // A navigate that returned without error makes its URL the believed page,
  // correlated: the call succeeded, the page may have redirected.
  const believed: PageFact | undefined =
    reported ??
    (status === 'ok' && requested ? { url: requested, confidence: 'correlated', via: `${ev.toolName} returned OK for this URL` } : undefined)
  const page = believed ?? pageFor(next)

  const done: BrowserEvent = {
    ...ev,
    status,
    statusSource: source,
    finishedAt: at,
    page,
    errorSummary:
      status === 'ok' ? undefined : o.isDenied ? `denied: ${preview(redactText(cleanOutput(text)), 200)}` : preview(redactText(cleanOutput(text)), 600) || undefined,
    // Typing tools echo what was typed ("Set email value to …"): not kept.
    outputSummary: status === 'ok' && text && ev.actionType !== 'TYPE' ? outputPreview(text) : undefined,
    steps: stepsAfter(ev.steps, status, text),
    evidence: status === 'ok' ? evidenceOf(ev.actionType, o.result, text) : undefined,
  }
  return bound({
    ...next,
    events: next.events.map(e => (e.id === id ? done : e)),
    page: believed ?? next.page,
    lastAt: Math.max(next.lastAt, at),
  })
}

// A session boundary: every call still running lost its result.
export const cutOff = (t: Trail, source: 'session-restart' | 'session-end' | 'hook-failure', ids?: string[]): Trail => ({
  ...t,
  events: t.events.map(e =>
    e.status === 'running' && (!ids || ids.includes(e.id))
      ? { ...e, status: 'unknown', statusSource: source, errorSummary: `no result: ${source.replace('-', ' ')}` }
      : e,
  ),
})

export const durationMs = (ev: BrowserEvent, now: number) => {
  if (ev.startedAt === undefined) return undefined
  if (ev.finishedAt !== undefined) return Math.max(0, ev.finishedAt - ev.startedAt)
  return ev.status === 'running' ? Math.max(0, now - ev.startedAt) : undefined
}

export const fmtDuration = (ms: number | undefined) => {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

export const fmtClock = (at: number | undefined) => {
  if (at === undefined) return '--:--:--'
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

export const sessionStatus = (t: Trail, now: number): 'LIVE' | 'IDLE' | 'ENDED' => {
  if (t.isEnded) return 'ENDED'
  if (t.events.some(e => e.status === 'running')) return 'LIVE'
  return t.events.length > 0 && now - t.lastAt < LIVE_MS ? 'LIVE' : 'IDLE'
}

export const visible = (t: Trail, v: View) =>
  t.events.filter(e => e.seq > v.hiddenThrough && (!v.isFailuresOnly || e.status === 'error' || e.status === 'timeout' || e.status === 'unknown'))

export const counts = (events: BrowserEvent[]) => ({
  total: events.length,
  failed: events.filter(e => e.status === 'error' || e.status === 'timeout').length,
  unknown: events.filter(e => e.status === 'unknown').length,
  running: events.filter(e => e.status === 'running').length,
})

// Move the selection by `step` through the visible list, clamped.
export const moveSelection = (events: BrowserEvent[], selected: string | undefined, step: number) => {
  if (events.length === 0) return undefined
  const at = events.findIndex(e => e.id === selected)
  const from = at === -1 ? events.length : at
  return events[Math.min(events.length - 1, Math.max(0, from + step))]!.id
}
