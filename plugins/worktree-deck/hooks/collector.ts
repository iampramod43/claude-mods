/**
 * The I/O half of the monitor: finds the sessions of each worktree, reads
 * their live feeds and tails their transcripts incrementally. One instance
 * serves the whole pane; no card reads anything on its own.
 */
import type { EngineInterface } from 'claude-code'

import type { LiveSnapshot, Session, SessionState } from '../types'
import { deepestRoot, encodeProject, utf8Length } from './deck'
import {
  emptyTranscript,
  ENDED_TTL_MS,
  feedTranscript,
  LIVE_TTL_MS,
  liveState,
  mergeEvents,
  openTool,
  PRIORITY,
  splitChunk,
  transcriptState,
  type TranscriptState,
} from './monitor'

/** Bytes read from a transcript the first time it is seen. */
export const SEED_BYTES = 400_000
/** A transcript that grew by more than this between polls is reseeded. */
export const MAX_DELTA = 2_000_000
/** Transcripts written within this window are candidates. */
export const WINDOW_MS = 6 * 60 * 60_000
/** At most this many transcripts per project folder. */
export const PER_DIR = 6

type Cursor = { offset: number; rest: string; st: TranscriptState; mtime: number }

export type Collector = {
  cursors: Map<string, Cursor>
  live: Map<string, { mtime: number; snap?: LiveSnapshot }>
}

export const createCollector = (): Collector => ({ cursors: new Map(), live: new Map() })

async function run($: EngineInterface, argv: string[], cwd?: string) {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout : undefined
  } catch {
    return undefined
  }
}

/**
 * The working directories of running Claude processes: `/proc` on Linux,
 * `lsof` elsewhere; null where neither works (then nothing is assumed).
 */
export async function claudeProcessCwds($: EngineInterface): Promise<string[] | null> {
  const script = [
    'if [ -d /proc/self ] && command -v pgrep >/dev/null 2>&1; then',
    '  for p in $(pgrep -x claude 2>/dev/null); do readlink "/proc/$p/cwd" 2>/dev/null; done; exit 0',
    'elif command -v lsof >/dev/null 2>&1; then',
    "  lsof -a -d cwd -c claude -Fn 2>/dev/null | sed -n 's/^n//p'; exit 0",
    'fi',
    'exit 3',
  ].join('\n')
  const out = await run($, ['sh', '-c', script])
  if (out === undefined) return null
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
}

/** Reads what the transcript gained since the last poll. */
async function tail($: EngineInterface, c: Collector, path: string, sid: string, size: number, mtime: number, limit: number) {
  const prev = c.cursors.get(path)
  if (prev && prev.offset === size && prev.mtime === mtime) return prev
  const replaced = !prev || size < prev.offset
  const gap = !replaced && size - prev!.offset > MAX_DELTA
  const from = replaced || gap ? Math.max(0, size - SEED_BYTES) : prev!.offset
  const out = await run($, ['tail', '-c', `+${from + 1}`, path])
  if (out === undefined) return prev
  const st = replaced ? emptyTranscript(sid) : prev!.st
  const carried = replaced || gap ? '' : prev!.rest
  const { lines, rest } = splitChunk(carried, out)
  // A read that starts mid-file starts mid-line: drop the cut first line.
  if (from > 0 && (replaced || gap)) lines.shift()
  feedTranscript(st, lines, limit)
  const cur: Cursor = { offset: from + utf8Length(out), rest, st, mtime }
  c.cursors.set(path, cur)
  return cur
}

async function readLive($: EngineInterface, c: Collector, dir: string, now: number) {
  let entries: { name: string; kind: string; mtimeMs: number }[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return [] as LiveSnapshot[]
  }
  const out: LiveSnapshot[] = []
  const names = new Set<string>()
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    if (now - f.mtimeMs > Math.max(LIVE_TTL_MS, ENDED_TTL_MS)) continue
    const path = `${dir}/${f.name}`
    names.add(path)
    const cached = c.live.get(path)
    let snap = cached?.snap
    if (!cached || cached.mtime !== f.mtimeMs) {
      try {
        const parsed = JSON.parse(await $.fs.read(path)) as LiveSnapshot
        if (parsed && parsed.v === 1 && typeof parsed.sid === 'string') snap = parsed
      } catch {
        // half-written: keep what was read before
      }
      c.live.set(path, { mtime: f.mtimeMs, snap })
    }
    if (snap) out.push(snap)
  }
  for (const k of c.live.keys()) if (!names.has(k)) c.live.delete(k)
  return out
}

export type CollectInput = {
  projects: string
  liveDir: string
  /** canonical worktree paths */
  worktrees: readonly string[]
  /** Claude process cwds, or null when unknown */
  processes: readonly string[] | null
  /** this session's own snapshot, fresher than its file */
  own?: LiveSnapshot
  now: number
  limit: number
}

type ReadTranscript = { path: string; st: TranscriptState; mtime: number; guess?: string }

const fresh = (s: LiveSnapshot, now: number) => (s.ended ? now - s.ended.at < ENDED_TTL_MS : now - s.beat < LIVE_TTL_MS)

/** Every visible session, keyed by the worktree it runs in. */
export async function collect($: EngineInterface, c: Collector, i: CollectInput): Promise<Map<string, Session[]>> {
  const { now, limit, worktrees } = i
  const result = new Map<string, Session[]>(worktrees.map(w => [w, []]))

  // Live feeds: this session's own from memory, the rest from disk.
  const lives = new Map<string, LiveSnapshot>()
  for (const s of await readLive($, c, i.liveDir, now)) if (fresh(s, now)) lives.set(s.sid, s)
  if (i.own) lives.set(i.own.sid, i.own)

  // Transcripts: project folders of each worktree and of folders inside it.
  let dirs: { name: string; kind: string }[] = []
  try {
    dirs = await $.fs.list(i.projects)
  } catch {}
  const encoded = worktrees.map(w => ({ w, enc: encodeProject(w) }))
  const transcripts: { path: string; sid: string; size: number; mtime: number; guess?: string }[] = []
  await Promise.all(
    dirs
      .filter(d => d.kind === 'dir')
      .map(async d => {
        const match = encoded.filter(x => d.name === x.enc || d.name.startsWith(`${x.enc}-`))
        if (match.length === 0) return
        let files: { name: string; kind: string; size: number; mtimeMs: number }[] = []
        try {
          files = await $.fs.list(`${i.projects}/${d.name}`)
        } catch {
          return
        }
        const exact = encoded.find(x => x.enc === d.name)?.w
        files
          .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
          .filter(f => now - f.mtimeMs < WINDOW_MS || lives.has(f.name.slice(0, -6)))
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, PER_DIR)
          .forEach(f =>
            transcripts.push({ path: `${i.projects}/${d.name}/${f.name}`, sid: f.name.slice(0, -6), size: f.size, mtime: f.mtimeMs, guess: exact }),
          )
      }),
  )
  const read = new Map<string, ReadTranscript>()
  await Promise.all(
    transcripts.map(async t => {
      const cur = await tail($, c, t.path, t.sid, t.size, t.mtime, limit)
      if (cur) read.set(t.sid, { path: t.path, st: cur.st, mtime: t.mtime, guess: t.guess })
    }),
  )
  // Forget transcripts no longer looked at.
  const looked = new Set(transcripts.map(t => t.path))
  for (const k of c.cursors.keys()) if (!looked.has(k)) c.cursors.delete(k)

  // Claude processes per worktree, for transcript-only sessions.
  const procs = new Map<string, number>()
  if (i.processes) for (const cwd of i.processes) {
    const w = deepestRoot(cwd, worktrees)
    if (w) procs.set(w, (procs.get(w) ?? 0) + 1)
  }

  const sids = new Set([...lives.keys(), ...read.keys()])
  const byTree = new Map<string, { sid: string; live?: LiveSnapshot; t?: ReadTranscript }[]>()
  for (const sid of sids) {
    const live = lives.get(sid)
    const t = read.get(sid)
    // Association by the session's own working directory, never by branch.
    const cwd = live?.cwd ?? t?.st.cwd
    const w = (cwd && deepestRoot(cwd, worktrees)) ?? (!cwd ? t?.guess : undefined)
    if (!w) continue
    const list = byTree.get(w) ?? []
    list.push({ sid, live, t })
    byTree.set(w, list)
  }

  for (const [w, list] of byTree) {
    // Processes not accounted for by live sessions belong to the newest
    // transcript-only sessions.
    const liveRunning = list.filter(x => x.live && !x.live.ended).length
    let spare = i.processes ? Math.max(0, (procs.get(w) ?? 0) - liveRunning) : undefined
    const transcriptOnly = list.filter(x => !x.live).sort((a, b) => (b.t?.mtime ?? 0) - (a.t?.mtime ?? 0))
    const alive = new Map<string, boolean | undefined>()
    for (const x of transcriptOnly) {
      if (spare === undefined) alive.set(x.sid, undefined)
      else {
        alive.set(x.sid, spare > 0)
        if (spare > 0) spare--
      }
    }

    const sessions: Session[] = []
    for (const { sid, live, t } of list) {
      const st = t?.st
      const lastAt = Math.max(live?.phaseAt ?? 0, live?.events.at(-1)?.at ?? 0, st?.lastAt ?? 0, t?.mtime ?? 0)
      let state: SessionState
      let stalled: boolean | undefined
      if (live) state = liveState(live, now)
      else {
        const r = transcriptState(st ?? {}, lastAt, now, alive.get(sid))
        state = r.state
        stalled = r.stalled
      }
      const events = mergeEvents(live?.events, st?.events ?? [], limit)
      const lastPrompt = [...events].reverse().find(e => e.kind === 'prompt')?.text
      sessions.push({
        sid,
        cwd: live?.cwd ?? st?.cwd ?? w,
        transcript: t?.path,
        source: live ? 'live' : 'transcript',
        state,
        stateAt: live?.phaseAt ?? lastAt,
        stalled,
        isHere: sid === i.own?.sid,
        model: live?.model ?? st?.model,
        title: st?.title,
        prompt: lastPrompt ?? st?.prompt,
        said: st?.said,
        startedAt: live?.startedAt ?? st?.startedAt ?? lastAt,
        lastAt,
        tool: live ? (state === 'working' || state === 'permission' ? live.tool : undefined) : state === 'working' && st ? openTool(st) : undefined,
        permission: state === 'permission' ? live?.permission : undefined,
        toolCount: live?.toolCount ?? st?.toolCount ?? 0,
        errorCount: live?.errorCount ?? st?.errorCount ?? 0,
        events,
        tools: (live?.tools ?? st?.tools ?? []).slice(-limit),
        subagents: live?.subagents ?? [],
      })
    }

    // Ended and long-quiet transcript sessions only show while recent, but
    // a worktree keeps its newest one for context.
    const shown = sessions.filter(
      s => s.source === 'live' || s.state !== 'completed' || now - s.lastAt < ENDED_TTL_MS,
    )
    const keep = shown.length ? shown : sessions.sort((a, b) => b.lastAt - a.lastAt).slice(0, 1)
    keep.sort((a, b) => PRIORITY[b.state] - PRIORITY[a.state] || b.lastAt - a.lastAt)
    result.set(w, keep)
  }
  return result
}

/** Claude processes per worktree; null when processes cannot be listed. */
export const processesPerTree = (cwds: readonly string[] | null, worktrees: readonly string[]) => {
  if (!cwds) return new Map<string, number | null>(worktrees.map(w => [w, null]))
  const m = new Map<string, number | null>(worktrees.map(w => [w, 0]))
  for (const cwd of cwds) {
    const w = deepestRoot(cwd, worktrees)
    if (w) m.set(w, (m.get(w) ?? 0) + 1)
  }
  return m
}
