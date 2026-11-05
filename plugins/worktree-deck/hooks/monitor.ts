/**
 * The pure half of the session monitor: reading transcripts incrementally,
 * normalizing their records into DeckEvents, merging them with what a live
 * session published, and settling each session's state.
 */
import type { Activity, DeckEvent, EventKind, LiveSnapshot, SessionState, ToolRun } from '../types'
import { describeTool, filePathOf, oneLine, toolLabel } from './deck'

/** No writes for this long: the session is idle, not working. */
export const IDLE_MS = 15 * 60_000
/** A tool call with no result for this long is flagged as stalled. */
export const STALL_MS = 30_000
/** A prompt or tool result with nothing after it for this long: idle. */
export const WORKING_MS = 2 * 60_000
/** A live feed whose heartbeat is older than this is disconnected. */
export const STALE_MS = 20_000
/** A live feed older than this is ignored; the transcript speaks alone. */
export const LIVE_TTL_MS = 10 * 60_000
/** How long a session that ended still shows. */
export const ENDED_TTL_MS = 30 * 60_000
/** A session starting for longer than this without a prompt is idle. */
export const START_MS = 10_000

const LINE = 200
const ERROR_LINE = 160

// ─── transcript ────────────────────────────────────────────────────────────

export type TranscriptState = {
  sid: string
  cwd?: string
  model?: string
  title?: string
  prompt?: string
  said?: string
  startedAt?: number
  lastAt: number
  /** the kind of the main thread's last event */
  last?: EventKind
  events: DeckEvent[]
  tools: ToolRun[]
  toolCount: number
  errorCount: number
}

export const emptyTranscript = (sid: string): TranscriptState => ({
  sid,
  lastAt: 0,
  events: [],
  tools: [],
  toolCount: 0,
  errorCount: 0,
})

type Block = {
  type?: string
  text?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

type TranscriptRecord = {
  type?: string
  subtype?: string
  uuid?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  cwd?: string
  sessionId?: string
  aiTitle?: string
  summary?: string
  lastPrompt?: string
  durationMs?: number
  level?: string
  content?: unknown
  message?: { model?: string; content?: string | Block[] }
}

const firstLine = (v: unknown, max: number): string | undefined => {
  let s: string | undefined
  if (typeof v === 'string') s = v
  else if (Array.isArray(v)) {
    for (const b of v as Block[]) if (b && typeof b.text === 'string') s = (s ? `${s}\n` : '') + b.text
  }
  const line = s
    ?.split('\n')
    .map(l => l.trim())
    .find(Boolean)
  return line ? oneLine(line, max) : undefined
}

/** A prompt's display text; slash commands show as the command they ran. */
export const promptText = (raw: string): string | undefined => {
  const s = raw.trim()
  if (!s || s.startsWith('Caveat:')) return undefined
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(s)
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(s)?.[1]?.trim()
    return oneLine(`${cmd[1]!.trim()}${args ? ` ${args}` : ''}`, LINE)
  }
  if (s.startsWith('<')) return undefined
  return oneLine(s, LINE)
}

const isInterrupt = (s: string) => s.startsWith('[Request interrupted')

/** Adds an event, keeping the list bounded and its ids unique. */
const push = (st: TranscriptState, e: DeckEvent, limit: number) => {
  if (st.events.length && st.events.some(x => x.id === e.id)) return
  st.events.push(e)
  if (st.events.length > limit * 2) st.events = st.events.slice(-limit)
  if (!e.agentId) st.last = e.kind
}

const pushTool = (st: TranscriptState, run: ToolRun, limit: number) => {
  if (st.tools.some(t => t.id === run.id)) return
  st.tools.push(run)
  st.toolCount++
  if (st.tools.length > limit * 2) st.tools = st.tools.slice(-limit)
}

/**
 * Folds complete transcript lines into the state. Lines that are not JSON
 * (a cut first line, a half-written last one) are skipped. Subagent
 * sidechain records are skipped: subagents keep their own files.
 */
export const feedTranscript = (st: TranscriptState, lines: readonly string[], limit: number) => {
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    let r: TranscriptRecord
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = r.timestamp ? Date.parse(r.timestamp) : NaN
    const at = Number.isFinite(parsed) ? parsed : st.lastAt
    if (at > st.lastAt) st.lastAt = at
    if (r.cwd && !st.cwd) st.cwd = r.cwd
    if (r.type === 'ai-title' && r.aiTitle) st.title = oneLine(r.aiTitle, 80)
    else if (r.type === 'summary' && r.summary && !st.title) st.title = oneLine(r.summary, 80)
    else if (r.type === 'last-prompt' && r.lastPrompt && !st.prompt) st.prompt = promptText(r.lastPrompt)
    if (r.isSidechain || r.isMeta) continue
    const id = r.uuid ?? `${st.sid}:${at}:${st.events.length}`
    if ((r.type === 'user' || r.type === 'assistant') && st.startedAt === undefined && at) st.startedAt = at
    const c = r.message?.content

    if (r.type === 'user') {
      const texts: string[] = typeof c === 'string' ? [c] : []
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            const run = st.tools.find(t => t.id === b.tool_use_id)
            const ok = !b.is_error
            const error = ok ? undefined : firstLine(b.content, ERROR_LINE)
            if (run) {
              run.endedAt = at
              run.ok = ok
              run.error = error
            }
            if (!ok) st.errorCount++
            push(
              st,
              {
                id: `tool:${b.tool_use_id}:end`,
                sid: st.sid,
                at,
                kind: 'tool.end',
                src: 'transcript',
                tool: run?.tool,
                toolUseId: b.tool_use_id,
                ok,
                text: error,
                durationMs: run ? at - run.startedAt : undefined,
              },
              limit,
            )
          } else if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
        }
      }
      texts.forEach((t, i) => {
        if (isInterrupt(t.trim())) {
          push(st, { id: `${id}:${i}`, sid: st.sid, at, kind: 'interrupt', src: 'transcript', text: 'Interrupted' }, limit)
          return
        }
        const p = promptText(t)
        if (!p) return
        st.prompt = p
        push(st, { id: `${id}:${i}`, sid: st.sid, at, kind: 'prompt', src: 'transcript', text: p }, limit)
      })
    } else if (r.type === 'assistant' && Array.isArray(c)) {
      if (r.message?.model && !r.message.model.startsWith('<')) st.model = r.message.model
      c.forEach((b, i) => {
        if (b.type === 'tool_use' && b.name) {
          const toolUseId = b.id ?? `${id}:${i}`
          const detail = describeTool(b.name, b.input)
          const path = filePathOf(b.input)
          pushTool(st, { id: toolUseId, tool: b.name, detail, path, startedAt: at }, limit)
          push(
            st,
            { id: `tool:${toolUseId}:start`, sid: st.sid, at, kind: 'tool.start', src: 'transcript', tool: b.name, toolUseId, text: detail, path },
            limit,
          )
        } else if (b.type === 'text' && b.text?.trim()) {
          st.said = oneLine(b.text, LINE)
          push(st, { id: `${id}:${i}`, sid: st.sid, at, kind: 'text', src: 'transcript', text: oneLine(b.text, 600) }, limit)
        }
      })
    } else if (r.type === 'system') {
      if (r.subtype === 'turn_duration') {
        push(st, { id, sid: st.sid, at, kind: 'turn.end', src: 'transcript', durationMs: r.durationMs, ok: true }, limit)
      } else if (r.level === 'error' || /error/i.test(r.subtype ?? '')) {
        st.errorCount++
        push(
          st,
          { id, sid: st.sid, at, kind: 'error', src: 'transcript', ok: false, text: firstLine(r.content, ERROR_LINE) ?? 'Error' },
          limit,
        )
      }
    }
  }
}

/** Joins a carried partial line with a new chunk: complete lines, and the rest. */
export const splitChunk = (rest: string, chunk: string) => {
  const lines = (rest + chunk).split('\n')
  const tail = lines.pop() ?? ''
  return { lines, rest: tail }
}

/** The tool call still running on the main thread, from a transcript. */
export const openTool = (st: TranscriptState): Activity | undefined => {
  if (st.last !== 'tool.start' && st.last !== 'tool.end') return undefined
  const run = [...st.tools].reverse().find(t => t.endedAt === undefined && !t.agentId)
  return run && { name: run.tool, detail: run.detail, path: run.path, at: run.startedAt }
}

// ─── state machine ─────────────────────────────────────────────────────────

/**
 * State from a transcript alone. `alive` is whether a Claude process still
 * runs for it: `undefined` when processes cannot be inspected.
 */
export const transcriptState = (
  st: Pick<TranscriptState, 'last'>,
  lastAt: number,
  now: number,
  alive: boolean | undefined,
): { state: SessionState; stalled?: boolean } => {
  const age = now - lastAt
  if (alive === false) return { state: 'completed' }
  if (!st.last) return { state: age < START_MS * 6 ? 'initializing' : 'idle' }
  if (age > IDLE_MS) return { state: 'idle' }
  switch (st.last) {
    case 'turn.end':
    case 'interrupt':
      return { state: 'input' }
    case 'error':
      return { state: 'error' }
    case 'tool.start':
      return { state: 'working', stalled: age > STALL_MS }
    case 'text':
      // A reply with no turn end after it: still streaming, or an older
      // Claude Code that writes no turn end. Settle on input after a beat.
      return { state: age < 10_000 ? 'working' : 'input' }
    default:
      return { state: age < WORKING_MS ? 'working' : 'idle' }
  }
}

/** State from what a live session published about itself. */
export const liveState = (s: Pick<LiveSnapshot, 'ended' | 'beat' | 'phase' | 'phaseAt'>, now: number): SessionState => {
  if (s.ended) return 'completed'
  if (now - s.beat > STALE_MS) return 'disconnected'
  switch (s.phase) {
    case 'starting':
      return now - s.phaseAt < START_MS ? 'initializing' : 'idle'
    case 'input':
      return now - s.phaseAt > IDLE_MS ? 'idle' : 'input'
    default:
      return s.phase
  }
}

/** Most urgent first: what a worktree with several sessions shows. */
export const PRIORITY: Record<SessionState, number> = {
  permission: 9,
  error: 8,
  working: 7,
  initializing: 6,
  input: 5,
  disconnected: 4,
  paused: 3,
  idle: 2,
  completed: 1,
  none: 0,
}

export const mostUrgent = (states: readonly SessionState[]): SessionState =>
  states.reduce<SessionState>((a, b) => (PRIORITY[b] > PRIORITY[a] ? b : a), 'none')

export const needsAttention = (s: SessionState) => s === 'permission' || s === 'input' || s === 'error' || s === 'disconnected'
export const isActive = (s: SessionState) => s === 'working' || s === 'initializing' || s === 'permission'

// ─── merging ───────────────────────────────────────────────────────────────

/** For a live session these come from the transcript; the rest from hooks. */
const TRANSCRIPT_KINDS = new Set<EventKind>(['text', 'interrupt'])

/**
 * One ordered, deduplicated, bounded event list from both sources. Hooks
 * own the lifecycle, tools, permissions and prompts of a live session; the
 * transcript adds what only it holds (Claude's text). Without a live feed
 * the transcript speaks alone. Out-of-order arrivals sort by time.
 */
export const mergeEvents = (live: readonly DeckEvent[] | undefined, transcript: readonly DeckEvent[], limit: number) => {
  const picked = live ? [...live, ...transcript.filter(e => TRANSCRIPT_KINDS.has(e.kind))] : [...transcript]
  const seen = new Set<string>()
  const out: { e: DeckEvent; i: number }[] = []
  picked.forEach((e, i) => {
    if (seen.has(e.id)) return
    seen.add(e.id)
    out.push({ e, i })
  })
  out.sort((a, b) => a.e.at - b.e.at || a.i - b.i)
  return out.slice(-limit).map(x => x.e)
}

/** "Bash", "Edit", "github · create_pr" with a verb for the live status. */
export const verbFor = (tool: string) => {
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return 'Reading'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'Editing'
    case 'Grep':
    case 'Glob':
    case 'WebSearch':
      return 'Searching'
    case 'Bash':
      return 'Running'
    case 'WebFetch':
      return 'Fetching'
    case 'Agent':
    case 'Task':
      return 'Delegating'
    default:
      return toolLabel(tool)
  }
}
