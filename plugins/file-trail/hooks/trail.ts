import type { Active, Entry, Op, Touch, Trail } from '../types'

export const empty = (root = ''): Trail => ({
  root,
  rootEntries: [],
  sizes: {},
  touches: {},
  active: {},
  outside: 0,
  seq: 0,
})

// A path relative to `root`, '' for the root itself, undefined outside it.
export const relPath = (root: string, path: string): string | undefined => {
  const clean = path.replace(/\/{2,}/g, '/').replace(/\/$/, '')
  if (clean.startsWith('/')) {
    if (clean === root) return ''
    return clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : undefined
  }
  const rel = clean.replace(/^(\.\/)+/, '')
  if (rel === '.' || rel === '') return ''

  return rel.startsWith('../') ? undefined : rel
}

export const ancestors = (rel: string): string[] => {
  const parts = rel.split('/')

  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

const SKIP = new Set([
  'git', 'gh', 'cd', 'echo', 'printf', 'mkdir', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'claude',
  'curl', 'export', 'pkill', 'kill', 'sleep', 'for', 'do', 'done', 'while', 'if', 'then', 'fi',
  'python', 'python3', 'node', 'rtk', 'which', 'test', 'true', 'false', 'set',
])
// Commands whose first non-flag argument is a pattern or script, not a path.
const PATTERN_FIRST = new Set(['grep', 'egrep', 'rg', 'sed', 'awk', 'jq'])

// `bare` marks a word with no slash or extension: kept only if it exists.
export type Candidate = { token: string; op: Op; bare?: true }

// Paths a shell command most likely reads or writes. Heuristic: the caller
// keeps only those that exist (or are written) inside the repo.
export const bashCandidates = (command: string): Candidate[] => {
  const found: Candidate[] = []
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const words: string[] = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    const first = words[0]?.replace(/^['"]|['"]$/g, '')
    if (!first || SKIP.has(first)) continue
    const isInPlace = first === 'sed' && words.some(w => /^-i/.test(w))
    let skipPattern = PATTERN_FIRST.has(first) && !words.includes('-e')
    let writeNext = first === 'tee'
    for (const raw of words.slice(1)) {
      if (raw === '>' || raw === '>>') {
        writeNext = true
        continue
      }
      const redirected = /^>>?[^&]/.test(raw)
      const word = raw.replace(/^>>?/, '').replace(/^['"]|['"]$/g, '').replace(/:\d+(:\d+)?$/, '')
      if (raw.startsWith('-') || /^\d*>&\d$/.test(raw)) continue
      if (skipPattern) {
        skipPattern = false
        continue
      }
      const looksLikePath = /\//.test(word) || /\.[A-Za-z0-9]{1,8}$/.test(word)
      const isBare = !looksLikePath && /^[A-Za-z_@][\w@.-]*$/.test(word)
      if ((!looksLikePath && !isBare) || /[*?{}$()=<>`]/.test(word) || word.startsWith('/dev/')) {
        writeNext = writeNext && first === 'tee'
        continue
      }
      const op: Op = writeNext || redirected ? 'write' : isInPlace ? 'edit' : 'read'
      found.push(isBare ? { token: word, op, bare: true } : { token: word, op })
      writeNext = first === 'tee'
    }
  }

  return found.slice(0, 25)
}

export const STRENGTH: Op[] = ['write', 'edit', 'read', 'search']

export const strongest = (t: Touch): Op => STRENGTH.find(op => t[op] > 0) ?? 'read'

export const total = (t: Touch): number => t.read + t.edit + t.write + t.search

export const record = (trail: Trail, path: string, op: Op, isDir: boolean, at = 0): Trail => {
  const prev: Touch = trail.touches[path] ?? { isDir, read: 0, edit: 0, write: 0, search: 0, last: 0, lastAt: 0 }

  return {
    ...trail,
    seq: trail.seq + 1,
    touches: { ...trail.touches, [path]: { ...prev, isDir, [op]: prev[op] + 1, last: trail.seq + 1, lastAt: at } },
  }
}

export type Row = {
  key: string
  path: string
  guide: string
  name: string
  isDir: boolean
  isOpen: boolean
  touch?: Touch
  active?: Op
  more?: number
}

// The tree to draw: every top-level entry of the repo, and below it only the
// branches leading to touched or active paths, each opened folder noting how
// many of its entries are not shown.
export const buildRows = (trail: Trail): Row[] => {
  const activeOf = new Map<string, Op>()
  for (const list of Object.values(trail.active)) for (const a of list) activeOf.set(a.path, a.op)
  const marked = new Set([...Object.keys(trail.touches), ...activeOf.keys()].filter(Boolean))

  const dirs = new Set<string>()
  for (const p of marked) for (const a of ancestors(p)) dirs.add(a)
  for (const e of trail.rootEntries) if (e.isDir) dirs.add(e.name)
  for (const [p, t] of Object.entries(trail.touches)) if (t.isDir) dirs.add(p)

  const open = new Set<string>()
  for (const p of marked) for (const a of ancestors(p)) open.add(a)

  const childrenOf = (dir: string): string[] => {
    const names = new Set<string>()
    if (dir === '') trail.rootEntries.forEach(e => names.add(e.name))
    const prefix = dir === '' ? '' : `${dir}/`
    for (const p of marked) {
      if (!p.startsWith(prefix)) continue
      const head = p.slice(prefix.length).split('/')[0]
      if (head) names.add(head)
    }

    return [...names]
      .map(n => prefix + n)
      .sort((a, b) => Number(dirs.has(b)) - Number(dirs.has(a)) || a.localeCompare(b))
  }

  const rows: Row[] = []
  const walk = (dir: string, indent: string) => {
    const kids = childrenOf(dir)
    const hidden = dir === '' ? 0 : Math.max(0, (trail.sizes[dir] ?? 0) - kids.length)
    kids.forEach((path, i) => {
      const isLast = i === kids.length - 1 && hidden === 0
      const isDir = dirs.has(path)
      const isOpen = isDir && open.has(path)
      rows.push({
        key: path,
        path,
        guide: indent + (isLast ? '└─ ' : '├─ '),
        name: path.slice(dir === '' ? 0 : dir.length + 1) + (isDir ? '/' : ''),
        isDir,
        isOpen,
        touch: trail.touches[path],
        active: activeOf.get(path),
      })
      if (isOpen) walk(path, indent + (isLast ? '   ' : '│  '))
    })
    if (hidden > 0) {
      rows.push({ key: `${dir}/…`, path: dir, guide: `${indent}└─ `, name: '', isDir: false, isOpen: false, more: hidden })
    }
  }
  walk('', '')

  return rows
}

export const sortEntries = (entries: Entry[]): Entry[] =>
  [...entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))

export const removeActive = (active: Record<string, Active[]>, id: string): Record<string, Active[]> => {
  const { [id]: _, ...rest } = active

  return rest
}

// How long a touched path stays highlighted after the tool finishes.
export const LINGER_MS = 4000

export const isFresh = (t: Touch | undefined, now: number): boolean =>
  t !== undefined && t.lastAt > 0 && now - t.lastAt < LINGER_MS
