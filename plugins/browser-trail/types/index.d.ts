export type Status = 'running' | 'ok' | 'error' | 'timeout' | 'unknown'
export type Confidence = 'observed' | 'correlated' | 'inferred'
export type ActionType =
  | 'NAVIGATE'
  | 'INSPECT'
  | 'CLICK'
  | 'TYPE'
  | 'KEYPRESS'
  | 'SCROLL'
  | 'WAIT'
  | 'SCREENSHOT'
  | 'TAB'
  | 'ASSERT'
  | 'BATCH'
  | 'OTHER'
export type Integration = 'playwright-mcp' | 'chrome-devtools-mcp' | 'claude-in-chrome' | 'browser-cli' | 'browser-mcp' | 'tool'

// A page fact and where it came from: `observed` when a tool's output reported
// it, `correlated` when it is the URL a successful navigate call asked for.
export type PageFact = { url: string; title?: string; confidence: Confidence; via: string }

// One tool call: its start and its result, paired by tool_use_id.
export type BrowserEvent = {
  id: string
  seq: number
  toolName: string
  integration: Integration
  actionType: ActionType
  summary: string
  // The row's two lines: what (`title`) and how (`detail`), when the adapter
  // knows better than `summary`.
  title?: string
  detail?: string
  target?: string
  inputSummary?: string
  // How the action type was worked out: `observed` from a known tool name,
  // `inferred` from a Bash command line.
  classification: Confidence
  startedAt?: number
  finishedAt?: number
  status: Status
  // What set the status: the tool's result, its error text (timeouts), or a
  // session boundary that cut the call off before a result arrived.
  statusSource?: 'tool-result' | 'error-text' | 'session-restart' | 'session-end' | 'hook-failure'
  errorSummary?: string
  outputSummary?: string
  page?: PageFact
  evidence?: string[]
  // A batch call's steps, from its input; `status` from its own report.
  steps?: { label: string; status: 'ok' | 'error' | 'not run' | 'unknown' }[]
}

export type Trail = {
  sessionId: string
  events: BrowserEvent[]
  seq: number
  page?: PageFact
  isEnded: boolean
  // Browser tool servers connected at session start (from the tool list).
  connected: string[]
  dropped: number
  lastAt: number
  // When the session began ($.session.usage().startedAt), for elapsed time.
  startedAt?: number
}

export type View = {
  selected?: string
  isDetailOpen: boolean
  isFailuresOnly: boolean
  isHelpOpen: boolean
  // Generic fallback: record every tool call, not only browser ones.
  isAllTools: boolean
  // Events with seq at or below this are hidden by `clear`; nothing is deleted.
  hiddenThrough: number
}

declare module 'claude-code' {
  interface PluginState {
    'browser-trail': { trail: Trail; view: View; tick: number; isLight: boolean }
  }
}
