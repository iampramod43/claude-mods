export type Activity = 'working' | 'pending' | 'waiting' | 'idle' | 'none'

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

export type Claude = {
  activity: Activity
  at: number
  title?: string
  prompt?: string
  tool?: string
  said?: string
  sessions: number
}

export type Worktree = {
  path: string
  isMain: boolean
  isHere: boolean
  locked: boolean
  prunable: boolean
  git?: Git
  claude: Claude
}

export type Deck = {
  root: string
  worktrees: Worktree[]
  polledAt: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'worktree-deck': { deck: Deck; expanded: boolean }
  }
}
