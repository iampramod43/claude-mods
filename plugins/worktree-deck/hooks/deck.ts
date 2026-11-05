import type { Git } from '../types'

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

export const oneLine = (s: string, max = 140) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const short = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/')

/** The file a tool call operates on, when its input names one. */
export const filePathOf = (input: unknown): string | undefined => {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof i[k] === 'string' && i[k]) return i[k] as string
  return undefined
}

/** "Edit hooks/deck.ts", "Bash git status", "github · create_pr". */
export const describeTool = (name: string, input: unknown): string => {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined)
  const label = toolLabel(name)
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

/** The tool's display name: MCP tools as "server · tool". */
export const toolLabel = (name: string) => {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]!.replace(/^plugin_[^_]+_/, '')} · ${mcp[2]}` : name
}

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

/** 15:42:03 in the machine's local time. */
export const clockTime = (at: number) => {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 3.2s, 840ms, 4m 10s */
export const duration = (ms: number) => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The deepest of `roots` that holds `path` (worktrees can nest). */
export const deepestRoot = (path: string, roots: readonly string[]) =>
  roots
    .filter(r => path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`))
    .sort((a, b) => b.length - a.length)[0]

/** UTF-8 byte length, to advance a file offset by what was read. */
export const utf8Length = (s: string) => {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}
