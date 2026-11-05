import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Claude, Deck, Git, Worktree } from '../types'
import {
  activityOf,
  ago,
  displayPath,
  emptyClaude,
  encodeProject,
  IDLE_MS,
  parseLastCommit,
  parseLeftRight,
  parseShortstat,
  parseStatus,
  parseTranscript,
  parseWorktreeList,
} from './deck'

const PANE = 'worktree-deck'
const POLL_MS = 5000
const TAIL_BYTES = '400000'

const emptyDeck = (root = ''): Deck => ({ root, worktrees: [], polledAt: 0 })
const deck = atom({ plugin: 'worktree-deck', key: 'deck' } as const, emptyDeck())
const expanded = atom({ plugin: 'worktree-deck', key: 'expanded' } as const, false)

const ACT: Record<Activity, { dot: string; color?: string; label: string }> = {
  working: { dot: '●', color: 'green', label: 'working' },
  pending: { dot: '◐', color: 'yellow', label: 'tool running / needs approval?' },
  waiting: { dot: '◆', color: 'cyan', label: 'your turn' },
  idle: { dot: '○', label: 'idle' },
  none: { dot: '·', label: 'no Claude session' },
}

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

const claudeOf = async ($: EngineInterface, projects: string, path: string, now: number): Promise<Claude> => {
  let files: { name: string; mtimeMs: number }[] = []
  try {
    files = (await $.fs.list(`${projects}/${encodeProject(path)}`))
      .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return emptyClaude()
  }
  const newest = files[0]
  if (!newest) return emptyClaude()
  const sessions = files.filter(f => now - f.mtimeMs < IDLE_MS).length
  let text = ''
  try {
    const r = await $.process.run(['tail', '-c', TAIL_BYTES, `${projects}/${encodeProject(path)}/${newest.name}`], {
      timeoutMs: 5000,
    })
    text = r.stdout
  } catch {}
  const t = parseTranscript(text)
  return {
    activity: activityOf(t.last, newest.mtimeMs, now),
    at: newest.mtimeMs,
    title: t.title,
    prompt: t.prompt,
    tool: t.tool,
    said: t.said,
    sessions,
  }
}

// Last activity per worktree, for the "finished" toasts. Starts over on reload.
const seen = new Map<string, Activity>()

const name = (w: Worktree) => w.path.split('/').pop() || w.path

const notify = ($: EngineInterface, ws: Worktree[]) => {
  for (const w of ws) {
    const before = seen.get(w.path)
    const now = w.claude.activity
    seen.set(w.path, now)
    if (w.isHere || before === undefined || before === now) continue
    if (now === 'waiting' && (before === 'working' || before === 'pending')) {
      $.ui.toast(`🌳 ${name(w)}: Claude finished — your turn`)
    } else if (now === 'pending' && before === 'working') {
      $.ui.toast(`🌳 ${name(w)}: Claude may be waiting for approval`)
    }
  }
}

const statusLine = ($: EngineInterface, ws: Worktree[]) => {
  if (ws.length < 2) return $.ui.status(undefined)
  const n = (a: Activity) => ws.filter(w => w.claude.activity === a).length
  const parts = [`🌳 ${ws.length} worktrees`]
  if (n('working')) parts.push(`${n('working')} working`)
  if (n('pending')) parts.push(`${n('pending')} stalled`)
  if (n('waiting')) parts.push(`${n('waiting')} your turn`)
  $.ui.status(parts.join(' · '))
}

let polling = false

const poll = async ($: EngineInterface, root: string, here: string, projects: string) => {
  if (polling) return
  polling = true
  try {
    const now = await $.clock.now()
    const listed = await git($, root, ['worktree', 'list', '--porcelain'])
    if (listed === undefined) {
      await update($, deck, d => ({ ...d, root, polledAt: now, error: 'Not a git repository.' }))
      return
    }
    const list = parseWorktreeList(listed).filter(w => !w.bare)
    const base = list[0]?.branch
    // The deepest worktree holding the session's folder (worktrees can nest).
    const herePath = list
      .map(w => w.path)
      .filter(p => here === p || here.startsWith(`${p}/`))
      .sort((a, b) => b.length - a.length)[0]
    const worktrees = await Promise.all(
      list.map(async (w, i): Promise<Worktree> => {
        const alive = !w.prunable
        const [g, c] = await Promise.all([
          alive ? gitOf($, w.path, base) : Promise.resolve(undefined),
          claudeOf($, projects, w.path, now),
        ])
        return {
          path: w.path,
          isMain: i === 0,
          isHere: w.path === herePath,
          locked: w.locked,
          prunable: w.prunable,
          git: g,
          claude: c,
        }
      }),
    )
    notify($, worktrees)
    statusLine($, worktrees)
    await update($, deck, () => ({ root, worktrees, polledAt: now }))
  } finally {
    polling = false
  }
}

const startPolling = async ($: EngineInterface, cwd: string) => {
  const here = cwd.replace(/\/$/, '')
  const top = (await git($, here, ['rev-parse', '--show-toplevel']))?.trim() ?? here
  const home = (await $.env.get('HOME')) ?? ''
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const projects = `${config.replace(/\/$/, '')}/projects`
  await poll($, top, here, projects)
  $.clock.every(POLL_MS, () => void poll($, top, here, projects).catch(() => {}))
  return { top, here, projects }
}

let ctx: { top: string; here: string; projects: string } | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'worktree-deck',
      description: 'Show every git worktree and what Claude is doing in each; `files` toggles changed-file lists',
      argumentHint: '[files|refresh]',
    })
    ctx = await startPolling($, started.cwd).catch(() => undefined)
    if ((await read($, deck)).worktrees.length > 1) void $.ui.open({ id: PANE, title: 'Worktrees' })
    return started
  })

  on('command.run', { command: 'worktree-deck' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'files') {
      await update($, expanded, v => !v)
      await $.ui.open({ id: PANE, title: 'Worktrees' })
      return { text: (await read($, expanded)) ? 'Showing changed files.' : 'Hiding changed files.' }
    }
    if (ctx) await poll($, ctx.top, ctx.here, ctx.projects)
    await $.ui.open({ id: PANE, title: 'Worktrees' })
    return { text: arg === 'refresh' ? 'Worktree deck refreshed.' : 'Worktree deck opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = await read($, deck)
    const showFiles = await read($, expanded)
    const now = await $.clock.now()
    const home = (await $.env.get('HOME')) ?? undefined
    const main = d.worktrees[0]?.path ?? d.root
    const repo = main.split('/').pop() || main

    if (d.error) return <Text dimColor>{d.error}</Text>
    if (d.worktrees.length === 0) return <Text dimColor>Looking for worktrees…</Text>

    const count = (a: Activity) => d.worktrees.filter(w => w.claude.activity === a).length

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>🌳 {repo}</Text>
          <Text dimColor>
            {'  '}
            {d.worktrees.length} worktree{d.worktrees.length === 1 ? '' : 's'}
          </Text>
        </Text>
        <Text>
          {(['working', 'pending', 'waiting', 'idle'] as const).map(a => (
            <Text>
              <Text color={ACT[a].color} bold>
                {ACT[a].dot}
              </Text>
              <Text dimColor>
                {' '}
                {count(a)} {a === 'pending' ? 'stalled' : ACT[a].label}
                {'  '}
              </Text>
            </Text>
          ))}
        </Text>
        {d.worktrees.map(w => {
          const g = w.git
          const c = w.claude
          const act = ACT[c.activity]
          const changes = g ? g.staged + g.modified + g.untracked + g.conflicts : 0
          return (
            <Box key={w.path} flexDirection="column" marginTop={1}>
              <Text wrap="truncate-end">
                <Text color={act.color} bold>
                  {act.dot}{' '}
                </Text>
                <Text bold color={w.isHere ? 'magenta' : undefined}>
                  {g?.branch || name(w)}
                </Text>
                {w.isHere && <Text color="magenta"> (this session)</Text>}
                {w.isMain && <Text dimColor> main</Text>}
                {w.locked && <Text color="yellow"> 🔒</Text>}
                {g?.op && (
                  <Text color="red" bold>
                    {' '}
                    {g.op.toUpperCase()}
                  </Text>
                )}
              </Text>
              <Text wrap="truncate-start" dimColor>
                {'  '}
                {displayPath(w.path, main, home)}
              </Text>
              {w.prunable ? (
                <Text color="red">{'  '}folder is gone — `git worktree prune`</Text>
              ) : null}
              {c.title && (
                <Text wrap="truncate-end">
                  {'  '}
                  <Text bold>{c.title}</Text>
                </Text>
              )}
              <Text wrap="truncate-end">
                {'  '}
                <Text color={act.color}>{act.label}</Text>
                {c.at > 0 && <Text dimColor> · {ago(now - c.at)} ago</Text>}
                {c.sessions > 1 && <Text dimColor> · {c.sessions} sessions</Text>}
              </Text>
              {c.activity !== 'none' && c.tool && (c.activity === 'working' || c.activity === 'pending') && (
                <Text wrap="truncate-end">
                  {'  '}
                  <Text color={act.color}>▶ </Text>
                  {c.tool}
                </Text>
              )}
              {c.prompt && (
                <Text wrap="truncate-end" dimColor>
                  {'  '}› {c.prompt}
                </Text>
              )}
              {c.activity === 'waiting' && c.said && (
                <Text wrap="truncate-end">
                  {'  '}
                  <Text color="cyan">‹ </Text>
                  <Text dimColor>{c.said}</Text>
                </Text>
              )}
              {g && (
                <Text wrap="truncate-end">
                  {'  '}
                  {g.baseAhead !== undefined && (
                    <Text>
                      <Text color="green">↑{g.baseAhead}</Text> <Text color="red">↓{g.baseBehind}</Text>
                      <Text dimColor> vs {d.worktrees[0]?.git?.branch ?? 'main'} · </Text>
                    </Text>
                  )}
                  {g.upstream && (g.ahead > 0 || g.behind > 0) && (
                    <Text dimColor>
                      ⇡{g.ahead} ⇣{g.behind} remote ·{' '}
                    </Text>
                  )}
                  {changes === 0 ? (
                    <Text dimColor>clean</Text>
                  ) : (
                    <Text>
                      {g.conflicts > 0 && <Text color="red">{g.conflicts}✖ </Text>}
                      {g.staged > 0 && <Text color="green">{g.staged}● </Text>}
                      {g.modified > 0 && <Text color="yellow">{g.modified}✚ </Text>}
                      {g.untracked > 0 && <Text color="blue">{g.untracked}? </Text>}
                      {(g.added > 0 || g.removed > 0) && (
                        <Text dimColor>
                          <Text color="green">+{g.added}</Text> <Text color="red">−{g.removed}</Text>
                        </Text>
                      )}
                    </Text>
                  )}
                </Text>
              )}
              {g?.lastCommit && (
                <Text wrap="truncate-end" dimColor>
                  {'  '}⎇ {ago(now - g.lastCommit.at)} · {g.lastCommit.subject}
                </Text>
              )}
              {showFiles &&
                g?.files.slice(0, 8).map(f => (
                  <Text wrap="truncate-start" dimColor>
                    {'    '}
                    {f}
                  </Text>
                ))}
              {showFiles && g && g.files.length > 8 && (
                <Text dimColor>
                  {'    '}… {g.files.length - 8} more
                </Text>
              )}
            </Box>
          )
        })}
        <Text dimColor>
          {'\n'}updated {ago(now - d.polledAt)} ago · /worktree-deck files
        </Text>
      </Box>
    )
  })
}
