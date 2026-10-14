// Where a value came from. Nothing is shown without one.
//  schema   — this Claude Code build's Agent tool lists the model
//  session  — the engine reported it for this session
//  policy   — ModelPilot's own documented routing rule, not a provider fact
//  measured — observed in this session's real events
//  estimated— computed by ModelPilot (e.g. chars/4 tokens), labelled so
export type Source = 'schema' | 'session' | 'policy' | 'measured' | 'estimated' | 'unknown'

export type Mode = 'auto' | 'recommend' | 'single-model' | 'budget-aware'

export type ModelEntry = {
  alias: string
  provider: string
  // Resolved ids seen in real spawns or turns for this alias.
  ids: string[]
  tier?: number
  tierSource: 'policy' | 'unknown'
  contextWindow?: number
  contextSource: 'session' | 'unknown'
  isSessionDefault: boolean
  // True once a real agent ran on it in this session.
  isVerified: boolean
  runs: number
  failures: number
  totalMs: number
}

export type TaskType = 'coding' | 'research' | 'reasoning' | 'summarization' | 'review' | 'writing' | 'general'

export type Classification = {
  type: TaskType
  complexity: 'low' | 'medium' | 'high'
  ambiguity: 'low' | 'high'
  needsLargeContext: boolean
  needsTools: boolean
  needsStructured: boolean
  risk: 'low' | 'high'
  speed: 'fast' | 'balanced' | 'depth'
  shape: 'single-step' | 'sequential' | 'parallel'
  steps: number
  // The words and structure each judgement came from.
  signals: string[]
}

export type Strategy = 'direct' | 'single' | 'team'

export type Decision = {
  at: number
  mode: Mode
  strategy: Strategy
  category: TaskType
  assignments: { subtaskId: string; model: string; reason: string }[]
  rationale: string[]
  uncertainty: string[]
  tradeoffs: string[]
  fallback: string
  isParallelWorthwhile: boolean
  refused?: string
}

export type SubtaskState = 'queued' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; model: string }

export type Subtask = {
  id: string
  title: string
  objective: string
  acceptance: string[]
  model: string
  modelReason: string
  deps: string[]
  weight: number
  state: SubtaskState
  // Only from report_progress calls the agent made; never from time.
  progress?: { pct: number; note?: string; at: number }
  agentId?: string
  resolvedModel?: string
  startedAt?: number
  endedAt?: number
  usage?: Usage
  activity?: string
  activityAt?: number
  blockedReason?: string
  error?: string
  outputArtifact?: string
  // The value the bar last settled at and when it changed, for animation.
  anim: { from: number; at: number }
  isObserved?: boolean
}

export type ArtifactVersion = { v: number; hash: string; at: number; author: string; bytes: number; tokensEst: number }

export type Artifact = {
  id: string
  type: 'spec' | 'finding' | 'decision' | 'output' | 'note'
  title: string
  content: string
  versions: ArtifactVersion[]
  tags: string[]
  isTruncated: boolean
}

export type EventType =
  | 'router_decision'
  | 'task_approved'
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'
  | 'agent_cancelled'
  | 'agent_activity'
  | 'progress_reported'
  | 'artifact_created'
  | 'artifact_updated'
  | 'artifact_read'
  | 'artifact_shared'
  | 'handoff_created'
  | 'handoff_received'
  | 'dependency_unblocked'
  | 'budget_alert'
  | 'error'

export type PilotEvent = {
  id: string
  at: number
  type: EventType
  // A subtask id, `router`, or `main` (the session's own loop).
  agent?: string
  from?: string
  to?: string
  artifact?: string
  version?: number
  isStale?: boolean
  reason: string
}

export type TaskState = 'planned' | 'awaiting-approval' | 'running' | 'completed' | 'failed' | 'cancelled' | 'direct'

export type Task = {
  id: string
  title: string
  text: string
  createdAt: number
  endedAt?: number
  state: TaskState
  classification: Classification
  decision: Decision
  subtasks: Subtask[]
  artifacts: Record<string, Artifact>
  events: PilotEvent[]
  seq: number
  costAtStart?: number
  isObserved?: boolean
}

export type Config = {
  mode: Mode
  maxAgents: number
  maxParallel: number
  budgetUsd?: number
  pin?: string
  isAnimated: boolean
  maxArtifactBytes: number
}

export type Pilot = {
  tasks: Task[]
  activeTaskId?: string
  // A spawned agent's id → the task and subtask it runs.
  agents: Record<string, { taskId: string; subtaskId: string }>
  registry: ModelEntry[]
  sessionModel?: string
  config: Config
  seq: number
}

export type Panel = 'overview' | 'graph' | 'feed' | 'plan'

export type View = {
  panel: Panel
  selected?: string
  isDetailOpen: boolean
  feedFilter: 'all' | 'failures' | 'context' | 'agent'
  isHelpOpen: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'model-pilot': { pilot: Pilot; view: View; tick: number; isLight: boolean }
  }
}
