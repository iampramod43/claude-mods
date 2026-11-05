/**
 * worktree-deck's contract.
 *
 * Two data paths feed one monitor:
 *  - hooks: every session running this mod publishes a LiveSnapshot to
 *    `<claude config>/worktree-deck/live/<sessionId>.json` (lifecycle, tools,
 *    permission asks, subagents), and
 *  - transcripts: each session's JSONL transcript is tailed incrementally
 *    (prompts, assistant text, tool calls and results, turn ends).
 * Both are normalized into DeckEvents and folded into a Session per worktree.
 */

/** A session's state, as the state machine settles it. */
export type SessionState =
  | 'initializing' // the session started and has not settled yet
  | 'working' // a turn is running: the model is generating or a tool runs
  | 'input' // a turn ended; Claude waits for the next prompt
  | 'permission' // a tool call waits for the person's approval
  | 'paused' // reserved: not detectable from hooks or transcripts today
  | 'completed' // the session ended (its transcript remains)
  | 'error' // the last turn ended in an API error or refusal
  | 'disconnected' // the session's live feed stopped without an end
  | 'idle' // the session exists but nothing has happened for a while
  | 'none' // no Claude session is associated with the worktree

export type EventKind =
  | 'session.start'
  | 'prompt'
  | 'turn.start'
  | 'text'
  | 'tool.start'
  | 'tool.end'
  | 'permission'
  | 'permission.done'
  | 'subagent.start'
  | 'subagent.end'
  | 'turn.end'
  | 'interrupt'
  | 'error'
  | 'session.end'

/** One normalized event. Ids are stable across sources so they deduplicate. */
export type DeckEvent = {
  id: string
  sid: string
  at: number
  kind: EventKind
  src: 'hook' | 'transcript'
  /** set when a subagent's loop raised it */
  agentId?: string
  tool?: string
  toolUseId?: string
  /** one line, length-capped: never a tool's full input or output */
  text?: string
  /** the file the event operated on, when there is one */
  path?: string
  ok?: boolean
  durationMs?: number
}

export type ToolRun = {
  id: string
  tool: string
  /** "Edit hooks/deck.ts", "Bash npm test": one line, capped */
  detail: string
  path?: string
  agentId?: string
  startedAt: number
  endedAt?: number
  ok?: boolean
  /** the first line of an error result, capped */
  error?: string
}

export type Subagent = {
  /** the Agent tool call's id */
  id: string
  /** the subagent loop's own id, once its first turn starts */
  agentId?: string
  description: string
  type?: string
  background?: boolean
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'error'
  tools: number
  lastTool?: string
}

export type Activity = {
  name: string
  detail: string
  path?: string
  at: number
}

/** What a session running this mod publishes about itself. */
export type LiveSnapshot = {
  v: 1
  sid: string
  cwd: string
  model?: string
  startedAt: number
  /** heartbeat: rewritten every few seconds while the session lives */
  beat: number
  phase: 'starting' | 'working' | 'input' | 'permission' | 'error'
  phaseAt: number
  ended?: { at: number; reason: string }
  tool?: Activity
  permission?: Activity
  events: DeckEvent[]
  tools: ToolRun[]
  subagents: Subagent[]
  toolCount: number
  errorCount: number
}

export type Session = {
  sid: string
  cwd: string
  transcript?: string
  /** `live` when a LiveSnapshot feeds it, else transcript (and process) only */
  source: 'live' | 'transcript'
  state: SessionState
  stateAt: number
  /** transcript-only: a tool call has had no result for a while */
  stalled?: boolean
  isHere: boolean
  model?: string
  title?: string
  prompt?: string
  said?: string
  startedAt: number
  lastAt: number
  tool?: Activity
  permission?: Activity
  toolCount: number
  errorCount: number
  events: DeckEvent[]
  tools: ToolRun[]
  subagents: Subagent[]
}

export type Git = {
  branch: string
  detached: boolean
  upstream?: string
  ahead: number
  behind: number
  /** vs the main worktree's branch, when this is another branch */
  baseAhead?: number
  baseBehind?: number
  staged: number
  modified: number
  untracked: number
  conflicts: number
  added: number
  removed: number
  files: string[]
  lastCommit?: { subject: string; at: number }
  op?: string
}

export type Worktree = {
  path: string
  isMain: boolean
  isHere: boolean
  locked: boolean
  prunable: boolean
  git?: Git
  /** the most urgent of its sessions' states */
  state: SessionState
  sessions: Session[]
  /** Claude processes whose working directory is inside it; null: unknown */
  processes: number | null
}

export type Health = {
  /** sessions fed by hooks, and by transcripts alone */
  live: number
  transcript: number
  /** whether process inspection works on this machine */
  processes: boolean
  /** last successful fast and slow polls */
  sessionsAt: number
  gitAt: number
  error?: string
}

export type Deck = {
  root: string
  worktrees: Worktree[]
  polledAt: number
  health: Health
  error?: string
}

export type Layout = 'compact' | 'expanded'
export type Filter = 'all' | 'active' | 'attention'
export type Sort = 'status' | 'name' | 'recent'

export type View = {
  /** the worktree whose inspector is open, else the dashboard */
  inspect?: string
  /** the session shown in the inspector */
  sid?: string
  tab: 'activity' | 'tools' | 'agents'
  /** tool runs expanded in the inspector */
  open: string[]
}

export type Prefs = {
  layout: Layout
  filter: Filter
  sort: Sort
  query: string
  files: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'worktree-deck': {
      deck: Shaped<Deck>
      view: Shaped<View>
      prefs: Shaped<Prefs>
    }
  }
}
