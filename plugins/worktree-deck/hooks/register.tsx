import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Deck, Git, Prefs, SessionState, View, Worktree } from '../types'
import {
  parseLastCommit,
  parseLeftRight,
  parseShortstat,
  parseStatus,
  parseWorktreeList,
  type ListedWorktree,
} from './deck'
import { claudeProcessCwds, collect, createCollector, processesPerTree } from './collector'
import { mostUrgent } from './monitor'
import {
  BEAT_MS,
  FLUSH_MS,
  createPublisher,
  end,
  flush,
  liveDir,
  permissionAsked,
  prompt,
  spawn,
  start,
  toolEnd,
  toolStart,
  turnComplete,
  turnStart,
} from './publisher'
import { renderPane } from './view'

const PANE = 'worktree-deck'
const TITLE = 'Worktree Deck'
/** sessions: live feeds and transcript tails */
const FAST_MS = 1500
/** git, worktree list, processes */
const SLOW_MS = 5000

const emptyDeck = (root = ''): Deck => ({
  root,
  worktrees: [],
  polledAt: 0,
  health: { live: 0, transcript: 0, processes: false, sessionsAt: 0, gitAt: 0 },
})
const deck = atom({ plugin: 'worktree-deck', key: 'deck' } as const, emptyDeck(), { shape: 'deck-2' })
const view = atom({ plugin: 'worktree-deck', key: 'view' } as const, { tab: 'activity', open: [] } as View, { shape: 'view-1' })
const prefs = atom(
  { plugin: 'worktree-deck', key: 'prefs' } as const,
  { layout: 'expanded', filter: 'all', sort: 'status', query: '', files: false } as Prefs,
  { shape: 'prefs-1' },
)

// ─── git ───────────────────────────────────────────────────────────────────

const git = async ($: EngineInterface, cwd: string, args: string[]) => {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout : undefined
  } catch {
    return undefined
  }
}

const OPS: [string, string][] = [
  ['rebase-merge', 'rebasing'],
  ['rebase-apply', 'rebasing'],
  ['MERGE_HEAD', 'merging'],
  ['CHERRY_PICK_HEAD', 'cherry-picking'],
  ['REVERT_HEAD', 'reverting'],
  ['BISECT_LOG', 'bisecting'],
]

const gitOf = async ($: EngineInterface, path: string, base: string | undefined): Promise<Git | undefined> => {
  const [status, stat, log, gitDir] = await Promise.all([
    git($, path, ['status', '--porcelain=v2', '--branch']),
    git($, path, ['diff', '--shortstat', 'HEAD']),
    git($, path, ['log', '-1', '--format=%ct%x09%s']),
    git($, path, ['rev-parse', '--absolute-git-dir']),
  ])
  if (status === undefined) return undefined
  const g = parseStatus(status)
  Object.assign(g, parseShortstat(stat ?? ''))
  g.lastCommit = parseLastCommit(log ?? '')
  if (base && g.branch !== base && !g.detached) {
    const lr = parseLeftRight((await git($, path, ['rev-list', '--left-right', '--count', `${base}...HEAD`])) ?? '')
    if (lr) {
      g.baseAhead = lr.ahead
      g.baseBehind = lr.behind
    }
  }
  const dir = gitDir?.trim()
  if (dir) {
    for (const [file, op] of OPS) {
      if (await $.fs.exists(`${dir}/${file}`).catch(() => false)) {
        g.op = op
        break
      }
    }
  }
  return g
}

/** The path as the OS resolves it: what a process reports as its cwd. */
const canonical = async ($: EngineInterface, path: string) => {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}

// ─── the monitor's module state (starts over on reload) ────────────────────

type Ctx = { top: string; here: string; projects: string; live: string; home?: string; sid?: string }
type Slow = {
  list: ListedWorktree[]
  /** git's path → the canonical path sessions report */
  real: Map<string, string>
  gits: Map<string, Git | undefined>
  procs: string[] | null
  at: number
}

let ctx: Ctx | undefined
let slow: Slow | undefined
let limit = 150
const P = createPublisher(limit)
const C = createCollector()
/** worktrees seen this process, to keep one that was removed under a running session */
const known = new Set<string>()
/** each other session's last state, for the attention toasts */
const seen = new Map<string, SessionState>()
let lastJson = ''
let fastBusy = false
let slowBusy = false

const nameOf = (path: string) => path.split('/').pop() || path

const pollSlow = async ($: EngineInterface) => {
  if (!ctx || slowBusy) return
  slowBusy = true
  try {
    const listed = await git($, ctx.top, ['worktree', 'list', '--porcelain'])
    const now = await $.clock.now()
    if (listed === undefined) {
      slow = undefined
      await update($, deck, d => ({ ...d, root: ctx!.top, polledAt: now, error: 'Not a git repository.' }))
      return
    }
    const list = parseWorktreeList(listed).filter(w => !w.bare)
    const base = list[0]?.branch
    const [gits, real, procs] = await Promise.all([
      Promise.all(list.map(async w => [w.path, w.prunable ? undefined : await gitOf($, w.path, base)] as const)),
      Promise.all(list.map(async w => [w.path, await canonical($, w.path)] as const)),
      claudeProcessCwds($),
    ])
    slow = { list, gits: new Map(gits), real: new Map(real), procs, at: now }
    list.forEach(w => known.add(w.path))
  } finally {
    slowBusy = false
  }
}

const notify = ($: EngineInterface, ws: Worktree[]) => {
  for (const w of ws) {
    for (const s of w.sessions) {
      const before = seen.get(s.sid)
      seen.set(s.sid, s.state)
      if (s.isHere || before === undefined || before === s.state) continue
      const where = `🌳 ${nameOf(w.path)}`
      if (s.state === 'permission') $.ui.toast(`${where}: Claude needs approval — ${s.permission?.detail ?? 'a tool call'}`)
      else if (s.state === 'input' && (before === 'working' || before === 'permission' || before === 'initializing'))
        $.ui.toast(`${where}: Claude finished — your turn`)
      else if (s.state === 'error') $.ui.toast(`${where}: Claude hit an error`)
    }
  }
}

const statusLine = ($: EngineInterface, ws: Worktree[]) => {
  if (ws.length < 2) return $.ui.status(undefined)
  const all = ws.flatMap(w => w.sessions.map(s => s.state))
  const n = (s: SessionState) => all.filter(x => x === s).length
  const parts = [`🌳 ${ws.length} worktrees`]
  if (n('working')) parts.push(`${n('working')} working`)
  if (n('permission')) parts.push(`${n('permission')} approval`)
  if (n('input')) parts.push(`${n('input')} your turn`)
  if (n('error')) parts.push(`${n('error')} error`)
  $.ui.status(parts.join(' · '))
}

const pollFast = async ($: EngineInterface) => {
  if (!ctx || !slow || fastBusy) return
  fastBusy = true
  try {
    const now = await $.clock.now()
    const s = slow
    const listedPaths = s.list.map(w => w.path)
    const removed = [...known].filter(p => !listedPaths.includes(p))
    const realOf = (p: string) => s.real.get(p) ?? p
    const paths = [...listedPaths, ...removed]
    const bySession = await collect($, C, {
      projects: ctx.projects,
      liveDir: ctx.live,
      worktrees: paths.map(realOf),
      processes: s.procs,
      own: P.snap,
      now,
      limit,
    })
    const procs = processesPerTree(s.procs, paths.map(realOf))
    const herePath = paths
      .filter(p => ctx!.here === realOf(p) || ctx!.here === p || ctx!.here.startsWith(`${realOf(p)}/`) || ctx!.here.startsWith(`${p}/`))
      .sort((a, b) => b.length - a.length)[0]
    const worktrees: Worktree[] = []
    paths.forEach((p, i) => {
      const listed = s.list.find(w => w.path === p)
      const sessions = bySession.get(realOf(p)) ?? []
      // A removed worktree stays only while a session still runs in it.
      if (!listed && !sessions.some(x => x.state !== 'completed')) {
        if (!sessions.length) known.delete(p)
        return
      }
      worktrees.push({
        path: p,
        isMain: i === 0,
        isHere: p === herePath,
        locked: listed?.locked ?? false,
        prunable: listed ? listed.prunable : true,
        git: s.gits.get(p),
        sessions,
        state: mostUrgent(sessions.map(x => x.state)),
        processes: procs.get(realOf(p)) ?? null,
      })
    })
    const all = worktrees.flatMap(w => w.sessions)
    const next: Deck = {
      root: ctx.top,
      worktrees,
      polledAt: now,
      health: {
        live: all.filter(x => x.source === 'live').length,
        transcript: all.filter(x => x.source === 'transcript').length,
        processes: s.procs !== null,
        sessionsAt: now,
        gitAt: s.at,
      },
    }
    notify($, worktrees)
    statusLine($, worktrees)
    const json = JSON.stringify({ ...next, polledAt: 0, health: { ...next.health, sessionsAt: 0 } })
    if (json !== lastJson) {
      lastJson = json
      await update($, deck, () => next)
    }
    // Times, durations and spinners move even when nothing else did.
    $.ui.invalidate('ui.render')
  } catch (err) {
    await update($, deck, d => ({ ...d, health: { ...d.health, error: String(err).slice(0, 200) } }))
  } finally {
    fastBusy = false
  }
}

const refresh = async ($: EngineInterface) => {
  await pollSlow($)
  await pollFast($)
}

const setup = async ($: EngineInterface, cwd: string): Promise<Ctx> => {
  const here = await canonical($, cwd.replace(/\/$/, ''))
  const top = (await git($, here, ['rev-parse', '--show-toplevel']))?.trim() ?? here
  const home = (await $.env.get('HOME')) ?? undefined
  const config = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home ?? ''}/.claude`).replace(/\/$/, '')
  return { top, here, home, projects: `${config}/projects`, live: liveDir(config) }
}

const startPublishing = async ($: EngineInterface, c: Ctx) => {
  const [sid, model, now] = await Promise.all([
    $.session.id().catch(() => undefined),
    $.session.model().catch(() => undefined),
    $.clock.now(),
  ])
  if (!sid) return
  c.sid = sid
  const file = `${c.live}/${sid}.json`
  let previous
  try {
    if (await $.fs.exists(file)) previous = JSON.parse(await $.fs.read(file))
  } catch {}
  start(P, { sid, cwd: c.here, model, now, file, previous })
  await flush($, P, now, true)
  // Old feeds of sessions long gone: only this mod's own folder.
  void $.process.run(['find', c.live, '-name', '*.json', '-mmin', '+1440', '-delete'], { timeoutMs: 10_000 }).catch(() => {})
}

/** Records a hook's observation without ever failing the hook. */
const observe = async ($: EngineInterface, fn: (now: number) => void) => {
  try {
    fn(await $.clock.now())
  } catch {}
}

const HELP = [
  '/worktree-deck                 open the deck',
  '/worktree-deck refresh         refresh now',
  '/worktree-deck files           show or hide changed files',
  '/worktree-deck compact|expanded  card layout',
  '/worktree-deck filter all|active|attention',
  '/worktree-deck sort status|recent|name',
  '/worktree-deck inspect <name>  open a worktree’s session inspector',
  '/worktree-deck back            back to the dashboard',
  'Pane keys: l layout · f filter · s sort · x files · r refresh · 1–9 inspect · b back · a/t/g tabs',
  'History size: /config → worktree-deck → historySize',
].join('\n')

export const register: Register = (on, options) => {
  const configured = Number(options.historySize)
  limit = Number.isFinite(configured) ? Math.min(1000, Math.max(20, Math.round(configured))) : 150
  P.limit = limit

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'worktree-deck',
      description: 'Live dashboard of every git worktree and the Claude sessions in it',
      argumentHint: '[refresh|files|compact|expanded|filter …|sort …|inspect <name>|back|help]',
    })
    try {
      ctx = await setup($, started.cwd)
      await startPublishing($, ctx)
      $.clock.every(FLUSH_MS, () => void $.clock.now().then(now => flush($, P, now)).catch(() => {}))
      $.clock.every(BEAT_MS, () => {
        P.dirty = true
      })
      await refresh($)
      $.clock.every(FAST_MS, () => void pollFast($).catch(() => {}))
      $.clock.every(SLOW_MS, () => void pollSlow($).catch(() => {}))
    } catch {}
    if ((await read($, deck)).worktrees.length > 1) void $.ui.open({ id: PANE, title: TITLE })
    return started
  })

  // ── this session's own feed ──
  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta) await observe($, now => prompt(P, e.text, now))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await observe($, now => turnStart(P, e, now))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await observe($, now => turnComplete(P, e, now))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (!('deny' in r && r.deny)) await observe($, now => spawn(P, e, now))
    return r
  })

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision === 'ask') await observe($, now => permissionAsked(P, e, now))
    return r
  })

  on('tool.call', async ($, e, next) => {
    let id = ''
    await observe($, now => {
      id = toolStart(P, e as never, now)
    })
    try {
      const r = await next(e)
      await observe($, now => toolEnd(P, id, e as never, r, now))
      return r
    } catch (err) {
      await observe($, now => toolEnd(P, id, e as never, { isError: true, text: String(err) }, now))
      throw err
    }
  })

  on('session.end', async ($, e, next) => {
    await observe($, now => end(P, e.reason, now))
    await $.clock
      .now()
      .then(now => flush($, P, now, true))
      .catch(() => {})
    return next(e)
  })

  // ── commands ──
  on('command.run', { command: 'worktree-deck' }, async ($, e) => {
    const [cmd = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const open = () => $.ui.open({ id: PANE, title: TITLE })
    switch (cmd) {
      case 'help':
        return { text: HELP }
      case 'files':
        await update($, prefs, p => ({ ...p, files: !p.files }))
        await open()
        return { text: (await read($, prefs)).files ? 'Showing changed files.' : 'Hiding changed files.' }
      case 'compact':
      case 'expanded':
        await update($, prefs, (p): Prefs => ({ ...p, layout: cmd as Prefs['layout'] }))
        await open()
        return { text: `Layout: ${cmd}.` }
      case 'filter':
        if (arg !== 'all' && arg !== 'active' && arg !== 'attention') return { text: 'Filter is one of: all, active, attention.' }
        await update($, prefs, (p): Prefs => ({ ...p, filter: arg as Prefs['filter'] }))
        await open()
        return { text: `Showing ${arg} worktrees.` }
      case 'sort':
        if (arg !== 'status' && arg !== 'recent' && arg !== 'name') return { text: 'Sort is one of: status, recent, name.' }
        await update($, prefs, (p): Prefs => ({ ...p, sort: arg as Prefs['sort'] }))
        await open()
        return { text: `Sorted by ${arg}.` }
      case 'inspect': {
        const d = await read($, deck)
        const q = arg.toLowerCase()
        const w =
          d.worktrees.find(x => nameOf(x.path).toLowerCase() === q || x.git?.branch.toLowerCase() === q) ??
          d.worktrees.find(x => x.path.toLowerCase().includes(q) || x.git?.branch.toLowerCase().includes(q))
        if (!w || !q) return { text: `No worktree matches “${arg}”.` }
        await update($, view, v => ({ ...v, inspect: w.path, sid: undefined }))
        await open()
        return { text: `Inspecting ${nameOf(w.path)}.` }
      }
      case 'back':
        await update($, view, v => ({ ...v, inspect: undefined, sid: undefined }))
        await open()
        return { text: 'Back to the dashboard.' }
      default:
        await refresh($).catch(() => {})
        await open()
        return { text: cmd === 'refresh' ? 'Worktree deck refreshed.' : 'Worktree deck opened.' }
    }
  })

  // ── the pane ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const [d, v, p, now] = await Promise.all([read($, deck), read($, view), read($, prefs), $.clock.now()])
    const cycle = <T,>(list: readonly T[], x: T) => list[(list.indexOf(x) + 1) % list.length]!
    return renderPane(ui, {
      d,
      view: v,
      prefs: p,
      now,
      home: ctx?.home,
      width: e.props.bodyColumns,
      act: {
        inspect: (path, sid) => void update($, view, x => ({ ...x, inspect: path, sid, open: path ? x.open : [] })),
        tab: tab => void update($, view, x => ({ ...x, tab })),
        toggleOpen: id =>
          void update($, view, x => ({ ...x, open: x.open.includes(id) ? x.open.filter(o => o !== id) : [...x.open, id].slice(-50) })),
        layout: () => void update($, prefs, (x): Prefs => ({ ...x, layout: x.layout === 'compact' ? 'expanded' : 'compact' })),
        filter: () => void update($, prefs, x => ({ ...x, filter: cycle(['all', 'active', 'attention'] as const, x.filter) })),
        sort: () => void update($, prefs, x => ({ ...x, sort: cycle(['status', 'recent', 'name'] as const, x.sort) })),
        files: () => void update($, prefs, x => ({ ...x, files: !x.files })),
        query: q => void update($, prefs, x => ({ ...x, query: q })),
        refresh: () => void refresh($).catch(() => {}),
      },
    })
  })
}


