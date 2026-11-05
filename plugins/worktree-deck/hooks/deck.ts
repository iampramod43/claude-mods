import type { Activity, Claude, Git } from '../types'

export const IDLE_MS = 15 * 60_000
export const STALL_MS = 30_000
export const WORKING_MS = 2 * 60_000

export type ListedWorktree = {
  path: string
  head?: string
  branch?: string
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

/** `git worktree list --porcelain` → one entry per worktree, main first. */
export const parseWorktreeList = (text: string): ListedWorktree[] => {
  const out: ListedWorktree[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const wt: ListedWorktree = { path: '', detached: false, bare: false, locked: false, prunable: false }
    for (const line of block.split('\n')) {
      const sp = line.indexOf(' ')
      const key = sp < 0 ? line : line.slice(0, sp)
      const val = sp < 0 ? '' : line.slice(sp + 1)
      if (key === 'worktree') wt.path = val
      else if (key === 'HEAD') wt.head = val
      else if (key === 'branch') wt.branch = val.replace(/^refs\/heads\//, '')
      else if (key === 'detached') wt.detached = true
      else if (key === 'bare') wt.bare = true
      else if (key === 'locked') wt.locked = true
      else if (key === 'prunable') wt.prunable = true
    }
    if (wt.path) out.push(wt)
  }
  return out
}

/** `git status --porcelain=v2 --branch` → branch, upstream and change counts. */
export const parseStatus = (text: string): Git => {
  const g: Git = {
    branch: '',
    detached: false,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    added: 0,
    removed: 0,
    files: [],
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14)
      g.detached = head === '(detached)'
      g.branch = g.detached ? 'detached' : head
    } else if (line.startsWith('# branch.upstream ')) g.upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        g.ahead = Number(m[1])
        g.behind = Number(m[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      if (xy[0] !== '.') g.staged++
      if (xy[1] !== '.') g.modified++
      const path = parts.slice(line.startsWith('1 ') ? 8 : 9).join(' ').split('\t')[0]!
      g.files.push(path)
    } else if (line.startsWith('u ')) {
      g.conflicts++
      g.files.push(line.split(' ').slice(10).join(' '))
    } else if (line.startsWith('? ')) {
      g.untracked++
      g.files.push(line.slice(2))
    }
  }
  return g
}

/** `git diff --shortstat` → lines added and removed. */
export const parseShortstat = (text: string) => ({
  added: Number(/(\d+) insertion/.exec(text)?.[1] ?? 0),
  removed: Number(/(\d+) deletion/.exec(text)?.[1] ?? 0),
})

/** `git rev-list --left-right --count base...HEAD` → behind/ahead of base. */
export const parseLeftRight = (text: string) => {
  const [l, r] = text.trim().split(/\s+/).map(Number)
  return Number.isFinite(l) && Number.isFinite(r) ? { behind: l!, ahead: r! } : undefined
}

/** `git log -1 --format=%ct%x09%s` */
export const parseLastCommit = (text: string) => {
  const t = text.trim()
  const tab = t.indexOf('\t')
  if (tab < 0) return undefined
  const at = Number(t.slice(0, tab)) * 1000
  return Number.isFinite(at) && at > 0 ? { at, subject: t.slice(tab + 1) } : undefined
}

/** The folder name Claude Code keeps a project's transcripts under. */
export const encodeProject = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')

const oneLine = (s: string, max = 140) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const short = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/')

/** "Edit hooks/deck.ts", "Bash git status", "github · create_pr". */
export const describeTool = (name: string, input: unknown): string => {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined)
  let label = name
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) label = `${mcp[1]!.replace(/^plugin_[^_]+_/, '')} · ${mcp[2]}`
  const detail =
    (s('file_path') && short(s('file_path')!)) ??
    (s('notebook_path') && short(s('notebook_path')!)) ??
    s('description') ??
    s('command') ??
    s('pattern') ??
    s('url') ??
    s('query') ??
    s('skill') ??
    s('prompt')
  return oneLine(detail ? `${label} ${detail}` : label, 80)
}

type Block = { type?: string; text?: string; name?: string; input?: unknown }
type Record_ = {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  aiTitle?: string
  summary?: string
  lastPrompt?: string
  message?: { content?: string | Block[] }
}

export type Last = 'prompt' | 'result' | 'tool' | 'text' | 'interrupt'

export type Transcript = { title?: string; prompt?: string; tool?: string; said?: string; last?: Last }

const isPromptText = (t: string) => {
  const s = t.trim()
  return s.length > 0 && !s.startsWith('<') && !s.startsWith('Caveat:')
}

/** Reads the tail of a session transcript (JSON lines; the first may be cut). */
export const parseTranscript = (text: string): Transcript => {
  const out: Transcript = {}
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let r: Record_
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.type === 'ai-title' && r.aiTitle) out.title = oneLine(r.aiTitle, 80)
    else if (r.type === 'summary' && r.summary && !out.title) out.title = oneLine(r.summary, 80)
    else if (r.type === 'last-prompt' && r.lastPrompt) out.prompt = oneLine(r.lastPrompt)
    if (r.isSidechain || r.isMeta) continue
    const c = r.message?.content
    if (r.type === 'user') {
      if (typeof c === 'string') {
        if (c.startsWith('[Request interrupted')) out.last = 'interrupt'
        else if (isPromptText(c)) {
          out.prompt = oneLine(c)
          out.last = 'prompt'
        }
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result') out.last = 'result'
          else if (b.type === 'text' && b.text) {
            if (b.text.startsWith('[Request interrupted')) out.last = 'interrupt'
            else if (isPromptText(b.text)) {
              out.prompt = oneLine(b.text)
              out.last = 'prompt'
            }
          }
        }
      }
    } else if (r.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'tool_use' && b.name) {
          out.tool = describeTool(b.name, b.input)
          out.last = 'tool'
        } else if (b.type === 'text' && b.text?.trim()) {
          out.said = oneLine(b.text)
          out.last = 'text'
        }
      }
    }
  }
  return out
}

/** What the session is up to, from its last record and how long ago it wrote. */
export const activityOf = (last: Last | undefined, mtime: number, now: number): Activity => {
  const age = now - mtime
  if (!last) return 'none'
  if (age > IDLE_MS) return 'idle'
  if (last === 'text' || last === 'interrupt') return 'waiting'
  if (last === 'tool' && age > STALL_MS) return 'pending'
  if (age > WORKING_MS) return 'idle'
  return 'working'
}

export const emptyClaude = (): Claude => ({ activity: 'none', at: 0, sessions: 0 })

export const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/** Path shown under the name: relative to the main worktree when inside it. */
export const displayPath = (path: string, main: string, home?: string) => {
  if (path === main) return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
  if (path.startsWith(`${main}/`)) return `./${path.slice(main.length + 1)}`
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
