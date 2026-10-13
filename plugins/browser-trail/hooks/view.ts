// What the pane shows, worked out as plain values: layout for a size, the
// telemetry figures, row labels, the failure report. Drawing lives in pane.tsx.

import type { ActionType, BrowserEvent, Status, Trail } from '../types'
import { durationMs } from './trail'

export type Mode = 'full' | 'short'

export type Layout = {
  mode: Mode
  cols: number
  rows: number
}

export const SHORT_MAX_ROWS = 19

export const layoutFor = (cols: number, rows: number): Layout => {
  const c = Math.max(40, Math.floor(cols || 80))
  const r = Math.max(8, Math.floor(rows || 24))
  return { mode: r <= SHORT_MAX_ROWS ? 'short' : 'full', cols: c, rows: r }
}

// Cut to `w` columns with an ellipsis; pad to `w` when `pad`.
export const fit = (s: string, w: number, pad = false) => {
  if (w <= 0) return ''
  const out = s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s
  return pad ? out.padEnd(w) : out
}

export const shortSession = (sid: string) => (sid ? sid.slice(0, 8) : '')

export type Telemetry = {
  total: number
  failed: number
  unknown: number
  running: number
  completed: number
  // Mean of completed calls that have both a start and a finish; undefined
  // when none has.
  avgMs?: number
  elapsedMs?: number
}

export const telemetry = (t: Trail, events: BrowserEvent[], now: number): Telemetry => {
  const timed = events.filter(e => e.status !== 'running' && e.startedAt !== undefined && e.finishedAt !== undefined)
  const sum = timed.reduce((n, e) => n + (durationMs(e, now) ?? 0), 0)
  const firstAt = t.events.find(e => e.startedAt !== undefined)?.startedAt
  const from = t.startedAt ?? firstAt
  const until = t.isEnded ? t.lastAt || now : now
  return {
    total: events.length,
    failed: events.filter(e => e.status === 'error' || e.status === 'timeout').length,
    unknown: events.filter(e => e.status === 'unknown').length,
    running: events.filter(e => e.status === 'running').length,
    completed: events.filter(e => e.status !== 'running').length,
    avgMs: timed.length ? Math.round(sum / timed.length) : undefined,
    elapsedMs: from !== undefined ? Math.max(0, until - from) : undefined,
  }
}

export const STATUS_GLYPH: Record<Status, string> = {
  running: '◐',
  ok: '●',
  error: '●',
  timeout: '●',
  unknown: '○',
}
export const SPINNER = ['◐', '◓', '◑', '◒']

export const STATUS_LABEL: Record<Status, string> = {
  running: 'RUNNING',
  ok: 'DONE',
  error: 'FAILED',
  timeout: 'TIMEOUT',
  unknown: 'NO RESULT',
}

// Theme names, so the pane follows the person's light or dark theme.
export const STATUS_COLOR: Record<Status, string> = {
  running: 'warning',
  ok: 'success',
  error: 'error',
  timeout: 'error',
  unknown: 'inactive',
}

export const ACTION_COLOR: Partial<Record<ActionType, string>> = {
  NAVIGATE: 'suggestion',
  CLICK: 'claude',
  TYPE: 'permission',
  KEYPRESS: 'permission',
  SCREENSHOT: 'ide',
  INSPECT: 'subtle',
  ASSERT: 'warning',
  BATCH: 'warning',
}

export const glyphFor = (s: Status, tick: number) => (s === 'running' ? SPINNER[tick % SPINNER.length]! : STATUS_GLYPH[s])

export const fmtShort = (ms: number | undefined) => {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
  return `${Math.floor(ms / 3_600_000)}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}m`
}

// A row's two lines. Adapters that know the action set `title` and
// `detail`; otherwise the summary leads and the target or tool follows.
// Rows recorded before adapters set titles: "Navigate to X" still splits.
const legacyNav = (ev: BrowserEvent) => (!ev.title && ev.actionType === 'NAVIGATE' ? ev.summary.match(/^Navigate to (.+)$/)?.[1] : undefined)

export const titleOf = (ev: BrowserEvent) => ev.title ?? (legacyNav(ev) ? 'Navigate' : ev.summary)

export const detailOf = (ev: BrowserEvent) => {
  if (ev.detail) return ev.detail
  const nav = legacyNav(ev)
  if (nav) return nav
  const tool = ev.toolName.startsWith('mcp__') ? ev.toolName.slice(ev.toolName.lastIndexOf('__') + 2) : ev.toolName
  return [ev.target ? `target ${ev.target}` : undefined, tool].filter(Boolean).join(' · ')
}

// Display names for the header's integration line.
export const integrationName = (server: string) =>
  /claude[-_]?in[-_]?chrome/i.test(server)
    ? 'CHROME EXTENSION'
    : /playwright/i.test(server)
      ? 'PLAYWRIGHT'
      : /devtools/i.test(server)
        ? 'CHROME DEVTOOLS'
        : server.toUpperCase()

export const pad2 = (n: number) => String(n).padStart(2, '0')

// The window of `room` rows to draw, keeping the focus row in view and the
// newest rows showing when nothing is selected.
export const windowAround = <T>(rows: T[], focus: number, room: number) => {
  if (rows.length <= room) return { start: 0, rows }
  if (focus < 0) return { start: rows.length - room, rows: rows.slice(-room) }
  const start = Math.min(rows.length - room, Math.max(0, focus - Math.floor(room / 2)))
  return { start, rows: rows.slice(start, start + room) }
}

// The event the inspector follows: the selection, else the call running now,
// else the newest one.
export const focusEvent = (events: BrowserEvent[], selected: string | undefined) =>
  events.find(e => e.id === selected) ?? [...events].reverse().find(e => e.status === 'running') ?? events[events.length - 1]

const CHECKS = new Set<ActionType>(['INSPECT', 'SCREENSHOT', 'WAIT', 'ASSERT'])

export type FailureItem = {
  ev: BrowserEvent
  // `tool`: the tool call failed; it says nothing about the app.
  // `test`: a test runner the command started reported the failure.
  kind: 'tool' | 'test'
  // The first later call that looked at the page, if any: what it did is
  // shown, never judged.
  nextCheck?: BrowserEvent
}

export const failureReport = (events: BrowserEvent[]): FailureItem[] =>
  events.flatMap((ev, i) => {
    if (ev.status !== 'error' && ev.status !== 'timeout') return []
    const nextCheck = events.slice(i + 1).find(e => CHECKS.has(e.actionType))
    return [{ ev, kind: ev.actionType === 'ASSERT' && ev.integration === 'browser-cli' ? 'test' : 'tool', nextCheck } as FailureItem]
  })

// Whether an integration exposes anything finer than the call.
export const substepNote = (connected: string[], events: BrowserEvent[]) => {
  const chrome = connected.some(s => /claude[-_]?in[-_]?chrome/i.test(s)) || events.some(e => e.integration === 'claude-in-chrome')
  return chrome ? 'substeps: batch steps only' : 'substeps: not exposed'
}

// Split text into at most `max` lines of `w` columns, breaking at spaces
// where a line has one in its last third, else mid-word.
export const wrapLines = (s: string, w: number, max: number) => {
  const width = Math.max(10, w)
  const all: string[] = []
  for (const para of s.split('\n')) {
    let rest = para
    while (rest.length > width) {
      const cut = rest.lastIndexOf(' ', width)
      const at = cut > width * 0.66 ? cut : width
      all.push(rest.slice(0, at))
      rest = rest.slice(at).replace(/^ /, '')
    }
    all.push(rest)
  }
  if (all.length <= max) return all
  const out = all.slice(0, max)
  const more = `… +${all.length - max + 1} lines`
  out[max - 1] = `${out[max - 1]!.slice(0, Math.max(0, width - more.length - 1)).trimEnd()} ${more}`
  return out
}
