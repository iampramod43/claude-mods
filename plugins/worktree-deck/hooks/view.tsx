/**
 * The pane: a dashboard of worktree cards and, for one worktree, a session
 * inspector. Pure drawing: everything it shows comes in `d`, every change
 * goes out through `act`.
 */
import type { Color, Elements, RenderSurface } from 'claude-code'

import type { Deck, DeckEvent, Filter, Prefs, Session, SessionState, Sort, ToolRun, View, Worktree } from '../types'
import { ago, clockTime, displayPath, duration, toolLabel } from './deck'
import { isActive, needsAttention, PRIORITY, verbFor } from './monitor'

type UI = Elements[RenderSurface]


export type Act = {
  inspect: (path: string | undefined, sid?: string) => void
  tab: (tab: View['tab']) => void
  toggleOpen: (id: string) => void
  layout: () => void
  filter: () => void
  sort: () => void
  files: () => void
  query: (q: string) => void
  refresh: () => void
}

export type Ctx = {
  d: Deck
  view: View
  prefs: Prefs
  now: number
  home?: string
  width: number
  act: Act
}

export const ACCENT: Color = 'permission'

export const STATE: Record<SessionState, { label: string; glyph: string; color: Color }> = {
  working: { label: 'Working', glyph: '●', color: 'success' },
  initializing: { label: 'Starting', glyph: '◌', color: 'suggestion' },
  input: { label: 'Waiting for input', glyph: '◆', color: 'warning' },
  permission: { label: 'Needs approval', glyph: '▲', color: 'warning' },
  paused: { label: 'Paused', glyph: '‖', color: 'inactive' },
  completed: { label: 'Completed', glyph: '✓', color: 'inactive' },
  error: { label: 'Error', glyph: '✕', color: 'error' },
  disconnected: { label: 'Disconnected', glyph: '⊘', color: 'error' },
  idle: { label: 'Idle', glyph: '○', color: 'inactive' },
  none: { label: 'No session', glyph: '·', color: 'inactive' },
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const glyph = (s: SessionState, now: number) => (s === 'working' ? SPIN[Math.floor(now / 500) % SPIN.length]! : STATE[s].glyph)

const name = (w: Worktree) => w.path.split('/').pop() || w.path
const branch = (w: Worktree) => (w.git ? (w.git.detached ? 'detached' : w.git.branch) : '')
const primary = (w: Worktree) => w.sessions[0]
const changed = (w: Worktree) => (w.git ? w.git.staged + w.git.modified + w.git.untracked + w.git.conflicts : 0)

// ─── filtering and sorting ─────────────────────────────────────────────────

const matches = (w: Worktree, q: string) => {
  if (!q) return true
  const hay = [w.path, branch(w), ...w.sessions.flatMap(s => [s.title ?? '', s.prompt ?? '', s.sid])].join('\n').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(t => hay.includes(t))
}

const passes = (w: Worktree, f: Filter) =>
  f === 'all' ? true : f === 'active' ? isActive(w.state) || w.state === 'input' : needsAttention(w.state)

const lastAt = (w: Worktree) => Math.max(0, ...w.sessions.map(s => s.lastAt))

export const arrange = (ws: readonly Worktree[], p: Pick<Prefs, 'filter' | 'sort' | 'query'>) => {
  const list = ws.filter(w => passes(w, p.filter) && matches(w, p.query))
  const by: Record<Sort, (a: Worktree, b: Worktree) => number> = {
    status: (a, b) => PRIORITY[b.state] - PRIORITY[a.state] || lastAt(b) - lastAt(a),
    recent: (a, b) => lastAt(b) - lastAt(a),
    name: (a, b) => name(a).localeCompare(name(b)),
  }
  // The main worktree and this session's stay first only in name order.
  return [...list].sort(by[p.sort])
}

export const counts = (ws: readonly Worktree[]) => {
  const all = ws.flatMap(w => w.sessions)
  const n = (s: SessionState) => all.filter(x => x.state === s).length
  return {
    worktrees: ws.length,
    active: all.filter(s => isActive(s.state)).length,
    working: n('working') + n('initializing'),
    input: n('input'),
    permission: n('permission'),
    completed: n('completed'),
    errors: n('error') + n('disconnected'),
  }
}

// ─── event lines ───────────────────────────────────────────────────────────

type Line = { glyph: string; color?: Color; dim?: boolean; label: string; strong?: string; right?: string; sub?: boolean }

const splitDetail = (tool: string, text: string | undefined) => {
  const label = toolLabel(tool)
  const t = text ?? ''
  return { label, rest: t.startsWith(label) ? t.slice(label.length).trim() : t }
}

export const lineOf = (e: DeckEvent, runs: ReadonlyMap<string, ToolRun>, now: number): Line | undefined => {
  const sub = e.agentId !== undefined
  switch (e.kind) {
    case 'prompt':
      return { glyph: '›', color: ACCENT, strong: 'You', label: e.text ?? '' }
    case 'turn.start':
      return undefined
    case 'text':
      return { glyph: '‹', label: e.text ?? '', strong: 'Claude' }
    case 'tool.start': {
      const run = e.toolUseId ? runs.get(e.toolUseId) : undefined
      const { label, rest } = splitDetail(e.tool ?? '', e.text)
      const done = run?.endedAt !== undefined
      return {
        glyph: done ? (run!.ok === false ? '✗' : '✓') : SPIN[Math.floor(now / 500) % SPIN.length]!,
        color: done ? (run!.ok === false ? 'error' : 'success') : 'suggestion',
        strong: label,
        label: rest,
        right: done ? duration(run!.endedAt! - run!.startedAt) : `${duration(now - (run?.startedAt ?? e.at))}…`,
        sub,
      }
    }
    case 'tool.end':
      return e.ok === false
        ? { glyph: '✗', color: 'error', strong: `${toolLabel(e.tool ?? 'Tool')} failed`, label: e.text ?? '', sub }
        : undefined
    case 'permission':
      return { glyph: '▲', color: 'warning', strong: 'Approval needed', label: e.text ?? '', sub }
    case 'permission.done':
      return { glyph: e.ok ? '✓' : '✗', color: e.ok ? 'success' : 'error', label: e.ok ? 'Approved' : 'Denied', dim: true, sub }
    case 'subagent.start':
      return { glyph: '⑂', color: ACCENT, strong: 'Subagent', label: e.text ?? '' }
    case 'subagent.end':
      return {
        glyph: '⑂',
        color: e.ok === false ? 'error' : 'inactive',
        strong: e.ok === false ? 'Subagent failed' : 'Subagent done',
        label: e.text ?? '',
        right: e.durationMs !== undefined ? duration(e.durationMs) : undefined,
        dim: e.ok !== false,
      }
    case 'turn.end':
      return {
        glyph: '■',
        dim: true,
        label: 'Turn finished',
        right: e.durationMs !== undefined ? duration(e.durationMs) : undefined,
      }
    case 'interrupt':
      return { glyph: '◼', color: 'warning', label: 'Interrupted' }
    case 'error':
      return { glyph: '✕', color: 'error', strong: 'Error', label: e.text ?? '' }
    case 'session.start':
      return { glyph: '◌', dim: true, label: 'Session started' }
    case 'session.end':
      return { glyph: '◼', dim: true, label: e.text ?? 'Session ended' }
  }
}

const runsOf = (s: Session) => new Map(s.tools.map(t => [t.id, t]))

// ─── shared pieces ─────────────────────────────────────────────────────────

const EventRow = (ui: UI, e: DeckEvent, l: Line, opts: { time: boolean }) => {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end" dimColor={l.dim}>
          {opts.time && <Text dimColor>{clockTime(e.at)} </Text>}
          {l.sub && <Text dimColor>↳ </Text>}
          <Text color={l.color}>{l.glyph} </Text>
          {l.strong && <Text bold={!l.sub}>{l.strong} </Text>}
          <Text dimColor={l.sub}>{l.label}</Text>
        </Text>
      </Box>
      {l.right && (
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{l.right}</Text>
        </Box>
      )}
    </Box>
  )
}

/** What the session is doing now, in one line. */
const NowLine = (ui: UI, s: Session, now: number) => {
  const { Text } = ui
  const st = STATE[s.state]
  if (s.state === 'permission' && s.permission)
    return (
      <Text wrap="truncate-end">
        <Text color="warning" bold>
          ▲ Approve?{' '}
        </Text>
        {s.permission.detail}
        <Text dimColor> · {ago(now - s.permission.at)}</Text>
      </Text>
    )
  if (s.state === 'working' && s.tool)
    return (
      <Text wrap="truncate-end">
        <Text color={s.stalled ? 'warning' : 'success'}>{glyph('working', now)} </Text>
        <Text bold>{verbFor(s.tool.name)}</Text> {splitDetail(s.tool.name, s.tool.detail).rest || toolLabel(s.tool.name)}
        <Text dimColor> · {duration(now - s.tool.at)}</Text>
        {s.stalled && <Text color="warning"> · no result yet — may need approval</Text>}
      </Text>
    )
  if (s.state === 'working' || s.state === 'initializing')
    return (
      <Text wrap="truncate-end">
        <Text color={st.color}>{glyph(s.state, now)} </Text>
        {s.state === 'initializing' ? 'Starting session…' : 'Generating response…'}
      </Text>
    )
  if (s.state === 'input')
    return (
      <Text wrap="truncate-end">
        <Text color="warning" bold>
          ◆ Your turn{' '}
        </Text>
        <Text dimColor>{s.said ? `‹ ${s.said}` : 'Claude is waiting for your input'}</Text>
      </Text>
    )
  if (s.state === 'error')
    return (
      <Text wrap="truncate-end" color="error">
        ✕ {[...s.events].reverse().find(e => e.kind === 'error' || (e.kind === 'tool.end' && e.ok === false))?.text ?? 'The last turn failed'}
      </Text>
    )
  if (s.state === 'disconnected')
    return (
      <Text wrap="truncate-end" color="error">
        ⊘ Live feed lost {ago(now - s.lastAt)} ago
      </Text>
    )
  return (
    <Text wrap="truncate-end" dimColor>
      {st.glyph} {st.label}
      {s.lastAt > 0 ? ` · ${ago(now - s.lastAt)} ago` : ''}
    </Text>
  )
}

const GitLine = (ui: UI, w: Worktree, base: string | undefined, now: number) => {
  const { Text } = ui
  const g = w.git
  if (!g) return <Text dimColor>{w.prunable ? 'folder is gone — git worktree prune' : 'git status unavailable'}</Text>
  const n = changed(w)
  return (
    <Text wrap="truncate-end">
      {n === 0 ? (
        <Text dimColor>✓ clean</Text>
      ) : (
        <Text>
          <Text color="warning">● {n} changed</Text>
          {g.conflicts > 0 && <Text color="error"> {g.conflicts}✖</Text>}
          {(g.added > 0 || g.removed > 0) && (
            <Text>
              {' '}
              <Text color="diffAdded">+{g.added}</Text> <Text color="diffRemoved">−{g.removed}</Text>
            </Text>
          )}
        </Text>
      )}
      {g.baseAhead !== undefined && (
        <Text dimColor>
          {' '}
          · ↑{g.baseAhead} ↓{g.baseBehind} vs {base ?? 'main'}
        </Text>
      )}
      {g.upstream && (g.ahead > 0 || g.behind > 0) && (
        <Text dimColor>
          {' '}
          · ⇡{g.ahead} ⇣{g.behind} remote
        </Text>
      )}
      {g.lastCommit && <Text dimColor> · {ago(now - g.lastCommit.at)} {g.lastCommit.subject}</Text>}
    </Text>
  )
}

// ─── dashboard ─────────────────────────────────────────────────────────────

const Card = (ui: UI, c: Ctx, w: Worktree, i: number, width: number | undefined) => {
  const { Box, Text, Button } = ui
  const { now, prefs, d } = c
  const s = primary(w)
  const state = w.state
  const st = STATE[state]
  const main = d.worktrees[0]?.path ?? d.root
  const base = d.worktrees[0]?.git?.branch
  const compact = prefs.layout === 'compact'
  const stream = s
    ? (() => {
        const runs = runsOf(s)
        return s.events
          .map(e => ({ e, l: lineOf(e, runs, now) }))
          .filter((x): x is { e: DeckEvent; l: Line } => !!x.l && x.e.kind !== 'session.start')
          .slice(compact ? 0 : -6)
      })()
    : []
  const tags = [
    displayPath(w.path, main, c.home),
    w.isHere ? 'this session' : undefined,
    w.isMain ? 'main' : undefined,
    w.locked ? 'locked' : undefined,
  ].filter(Boolean)
  return (
    <Box
      key={w.path}
      flexDirection="column"
      borderStyle="round"
      borderColor={isActive(state) || needsAttention(state) ? st.color : 'subtle'}
      paddingX={1}
      width={width}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={st.color} bold>
              {glyph(state, now)}{' '}
            </Text>
            <Text bold color={w.isHere ? ACCENT : undefined}>
              {name(w)}
            </Text>
            {branch(w) && branch(w) !== name(w) && <Text dimColor> ⎇ {branch(w)}</Text>}
            {w.git?.op && (
              <Text color="error" bold>
                {' '}
                {w.git.op.toUpperCase()}
              </Text>
            )}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={st.color}>
            {st.label}
            {w.sessions.length > 1 && <Text dimColor> ×{w.sessions.length}</Text>}
          </Text>
        </Box>
      </Box>
      {!compact && (
        <Text wrap="truncate-start" dimColor>
          {tags.join(' · ')}
        </Text>
      )}
      {s?.title && !compact && (
        <Text wrap="truncate-end" bold>
          {s.title}
        </Text>
      )}
      {s?.prompt && (
        <Text wrap="truncate-end">
          <Text color={ACCENT}>› </Text>
          <Text dimColor={compact}>{s.prompt}</Text>
        </Text>
      )}
      {s ? NowLine(ui, s, now) : <Text dimColor>· No Claude session in this worktree</Text>}
      {stream.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {stream.map(({ e, l }) => EventRow(ui, e, l, { time: true }))}
        </Box>
      )}
      {!compact && GitLine(ui, w, base, now)}
      {prefs.files &&
        w.git?.files.slice(0, 8).map(f => (
          <Text wrap="truncate-start" dimColor>
            {'  '}
            {f}
          </Text>
        ))}
      {prefs.files && w.git && w.git.files.length > 8 && <Text dimColor>{'  '}… {w.git.files.length - 8} more</Text>}
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>
          <Text wrap="truncate-end" dimColor>
            {s ? `⏱ ${ago(now - s.startedAt)} · last ${ago(now - s.lastAt)} ago` : 'no activity'}
            {s && s.toolCount > 0 ? ` · ${s.toolCount} tools` : ''}
            {s && s.subagents.some(a => a.status === 'running')
              ? ` · ${s.subagents.filter(a => a.status === 'running').length} agents`
              : ''}
            {compact ? ` · ${changed(w) ? `${changed(w)} changed` : 'clean'}` : ''}
            {s?.source === 'transcript' ? ' · transcript' : ''}
          </Text>
        </Box>
        {s && (
          <Box flexShrink={0} marginLeft={1}>
            <Button
              key={`open:${w.path}`}
              plain
              hotkey={i < 9 ? String(i + 1) : undefined}
              label="Inspect ›"
              onPress={() => c.act.inspect(w.path)}
            />
          </Box>
        )}
      </Box>
    </Box>
  )
}

const Dashboard = (ui: UI, c: Ctx) => {
  const { Box, Text, Button, Input } = ui
  const { d, prefs, now } = c
  const n = counts(d.worktrees)
  const list = arrange(d.worktrees, prefs)
  const repo = (d.worktrees[0]?.path ?? d.root).split('/').pop() || d.root
  const health = d.health
  const stale = now - health.sessionsAt > 15_000
  const cols = c.width >= 130 ? 2 : 1
  const cardW = cols > 1 ? Math.floor((c.width - 1) / cols) : undefined
  const stat = (v: number, label: string, color: Color, g: string) => (
    <Text>
      <Text color={v ? color : 'inactive'}>
        {g} {v}
      </Text>
      <Text dimColor> {label}   </Text>
    </Text>
  )
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text bold color={ACCENT}>
              ◧ Worktree Deck
            </Text>
            <Text dimColor>  {repo}</Text>
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={health.error || stale ? 'error' : 'success'}>
            ●{' '}
            <Text dimColor>
              {health.error ? 'monitor error' : stale ? 'reconnecting' : `live ${health.live}`}
              {health.transcript ? ` · ${health.transcript} transcript` : ''}
            </Text>
          </Text>
        </Box>
      </Box>
      <Text wrap="truncate-end">
        <Text dimColor>{n.worktrees} worktrees   </Text>
        {stat(n.working, 'working', 'success', '●')}
        {stat(n.input, 'input', 'warning', '◆')}
        {stat(n.permission, 'approval', 'warning', '▲')}
        {stat(n.completed, 'done', 'inactive', '✓')}
        {stat(n.errors, 'errors', 'error', '✕')}
      </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button key="layout" plain hotkey="l" label={prefs.layout === 'compact' ? 'Compact' : 'Expanded'} onPress={() => c.act.layout()} />
        <Button key="filter" plain hotkey="f" label={`Show: ${prefs.filter}`} onPress={() => c.act.filter()} />
        <Button key="sort" plain hotkey="s" label={`Sort: ${prefs.sort}`} onPress={() => c.act.sort()} />
        <Button key="files" plain hotkey="x" label={prefs.files ? 'Files: on' : 'Files: off'} onPress={() => c.act.files()} />
        <Button key="refresh" plain hotkey="r" label="Refresh" onPress={() => c.act.refresh()} />
      </Box>
      <Input
        key="search"
        placeholder="Search worktrees, branches, prompts…"
        value={prefs.query}
        onInput={v => c.act.query(v)}
        onSubmit={v => c.act.query(v)}
      />
      {list.length === 0 ? (
        <Text dimColor>{'\n'}No worktrees match this filter.</Text>
      ) : (
        <Box flexDirection={cols > 1 ? 'row' : 'column'} flexWrap={cols > 1 ? 'wrap' : 'nowrap'} columnGap={1}>
          {list.map((w, i) => Card(ui, c, w, i, cardW))}
        </Box>
      )}
      <Text dimColor wrap="truncate-end">
        updated {ago(now - d.polledAt)} ago · 1–9 inspect · /worktree-deck help
      </Text>
    </Box>
  )
}

// ─── inspector ─────────────────────────────────────────────────────────────

const KV = (ui: UI, k: string, v: string, color?: Color) => {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row">
      <Box width={10} flexShrink={0}>
        <Text dimColor>{k}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="truncate-start" color={color}>
          {v}
        </Text>
      </Box>
    </Box>
  )
}

const Conversation = (ui: UI, s: Session, now: number) => {
  const { Box, Text } = ui
  const runs = runsOf(s)
  const rows = s.events.map(e => ({ e, l: lineOf(e, runs, now) })).filter(x => x.l)
  if (rows.length === 0) return <Text dimColor>No activity recorded yet.</Text>
  return (
    <Box flexDirection="column">
      {rows.map(({ e, l }) => {
        if (e.kind === 'prompt' || e.kind === 'text') {
          const you = e.kind === 'prompt'
          return (
            <Box key={e.id} flexDirection="column" marginTop={1}>
              <Text>
                <Text bold color={you ? ACCENT : 'claude'}>
                  {you ? '› You' : '‹ Claude'}
                </Text>
                <Text dimColor> {clockTime(e.at)}</Text>
              </Text>
              <Text wrap="wrap">{e.text}</Text>
            </Box>
          )
        }
        return EventRow(ui, e, l!, { time: true })
      })}
    </Box>
  )
}

const Tools = (ui: UI, c: Ctx, s: Session) => {
  const { Box, Text, Button } = ui
  const { now } = c
  if (s.tools.length === 0) return <Text dimColor>No tool calls yet.</Text>
  return (
    <Box flexDirection="column">
      {s.tools.map(t => {
        const done = t.endedAt !== undefined
        const status = !done ? 'Running' : t.ok === false ? 'Failed' : 'Completed'
        const color: Color = !done ? 'suggestion' : t.ok === false ? 'error' : 'success'
        const open = c.view.open.includes(t.id)
        const { label, rest } = splitDetail(t.tool, t.detail)
        return (
          <Box key={t.id} flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Box flexShrink={1}>
                <Button key={`tool:${t.id}`} plain onPress={() => c.act.toggleOpen(t.id)}>
                  {open ? '▾ ' : '▸ '}
                  <Text bold>{label}</Text>
                  <Text color={color}> · {status}</Text>
                  {t.agentId ? <Text dimColor> · subagent</Text> : ''}
                </Button>
              </Box>
              <Box flexShrink={0} marginLeft={1}>
                <Text dimColor>{duration((t.endedAt ?? now) - t.startedAt)}</Text>
              </Box>
            </Box>
            <Text wrap="truncate-end" dimColor>
              {'    '}
              {rest || '—'}
            </Text>
            {open && (
              <Box flexDirection="column" paddingLeft={4}>
                {t.path && KV(ui, 'file', t.path)}
                {KV(ui, 'started', clockTime(t.startedAt))}
                {done && KV(ui, 'ended', clockTime(t.endedAt!))}
                {t.error && KV(ui, 'error', t.error, 'error')}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

const Agents = (ui: UI, c: Ctx, s: Session) => {
  const { Box, Text, Button } = ui
  const { now } = c
  if (s.subagents.length === 0)
    return (
      <Text dimColor>
        {s.source === 'live' ? 'No subagents spawned.' : 'Subagents are visible for sessions running worktree-deck.'}
      </Text>
    )
  const running = s.subagents.filter(a => a.status === 'running').length
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {running} running · {s.subagents.length} total
      </Text>
      {s.subagents.map(a => {
        const open = c.view.open.includes(`agent:${a.id}`)
        const color: Color = a.status === 'running' ? 'success' : a.status === 'error' ? 'error' : 'inactive'
        const runs = a.agentId ? s.tools.filter(t => t.agentId === a.agentId) : []
        return (
          <Box key={a.id} flexDirection="column" marginTop={1} paddingLeft={1} borderStyle="single" borderColor="subtle">
            <Box flexDirection="row" justifyContent="space-between">
              <Box flexShrink={1}>
                <Button key={`agent:${a.id}`} plain onPress={() => c.act.toggleOpen(`agent:${a.id}`)}>
                  {open ? '▾ ' : '▸ '}
                  <Text color={color}>{a.status === 'running' ? glyph('working', now) : a.status === 'error' ? '✕' : '✓'} </Text>
                  <Text bold>{a.description}</Text>
                </Button>
              </Box>
              <Box flexShrink={0} marginLeft={1}>
                <Text dimColor>{duration((a.endedAt ?? now) - a.startedAt)}</Text>
              </Box>
            </Box>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {a.type ?? 'agent'}
              {a.background ? ' · background' : ''} · {a.tools} tools
              {a.lastTool ? ` · ${a.lastTool}` : ''}
            </Text>
            {open &&
              runs.map(t => (
                <Text wrap="truncate-end" dimColor>
                  {'    '}
                  {t.endedAt === undefined ? '…' : t.ok === false ? '✗' : '✓'} {t.detail}
                </Text>
              ))}
          </Box>
        )
      })}
    </Box>
  )
}

const Inspector = (ui: UI, c: Ctx, w: Worktree) => {
  const { Box, Text, Button } = ui
  const { now, view, d } = c
  const s = w.sessions.find(x => x.sid === view.sid) ?? primary(w)
  const st = STATE[s?.state ?? 'none']
  const main = d.worktrees[0]?.path ?? d.root
  const tab = view.tab
  const running = s?.subagents.filter(a => a.status === 'running').length ?? 0
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text bold>{name(w)}</Text>
            {branch(w) && <Text dimColor> ⎇ {branch(w)}</Text>}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={st.color}>
            {glyph(s?.state ?? 'none', now)} {st.label}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Button key="back" plain hotkey="b" label="‹ Back" onPress={() => c.act.inspect(undefined)} />
        {w.sessions.length > 1 &&
          w.sessions.map(x => (
            <Button
              key={`sid:${x.sid}`}
              plain
              variant={x.sid === s?.sid ? 'primary' : undefined}
              onPress={() => c.act.inspect(w.path, x.sid)}
            >
              <Text color={STATE[x.state].color}>{glyph(x.state, now)} </Text>
              {x.sid.slice(0, 8)}
            </Button>
          ))}
      </Box>
      {!s ? (
        <Text dimColor>{'\n'}No Claude session is associated with this worktree.</Text>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="column" marginTop={1}>
            {KV(ui, 'Session', `${s.sid}${s.isHere ? '  (this session)' : ''}`)}
            {KV(ui, 'Path', displayPath(s.cwd, main, c.home))}
            {s.model && KV(ui, 'Model', s.model)}
            {KV(ui, 'Started', `${clockTime(s.startedAt)} · ${ago(now - s.startedAt)} ago`)}
            {KV(ui, 'Last', `${clockTime(s.lastAt)} · ${ago(now - s.lastAt)} ago`)}
            {KV(ui, 'Feed', s.source === 'live' ? 'live hooks + transcript' : 'transcript only (no worktree-deck in that session)')}
            {KV(ui, 'Tools', `${s.toolCount} calls · ${s.errorCount} errors`)}
            {s.title && KV(ui, 'Task', s.title)}
          </Box>
          <Box marginTop={1}>{NowLine(ui, s, now)}</Box>
          <Box flexDirection="row" columnGap={2} marginTop={1}>
            <Button key="tab:activity" plain hotkey="a" variant={tab === 'activity' ? 'primary' : undefined} label="Activity" onPress={() => c.act.tab('activity')} />
            <Button key="tab:tools" plain hotkey="t" variant={tab === 'tools' ? 'primary' : undefined} label={`Tools ${s.tools.length}`} onPress={() => c.act.tab('tools')} />
            <Button
              key="tab:agents"
              plain
              hotkey="g"
              variant={tab === 'agents' ? 'primary' : undefined}
              label={`Agents ${running ? `${running}/` : ''}${s.subagents.length}`}
              onPress={() => c.act.tab('agents')}
            />
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {tab === 'activity' ? Conversation(ui, s, now) : tab === 'tools' ? Tools(ui, c, s) : Agents(ui, c, s)}
          </Box>
        </Box>
      )}
    </Box>
  )
}

export const renderPane = (ui: UI, c: Ctx) => {
  const { Text } = ui
  if (c.d.error) return <Text dimColor>{c.d.error}</Text>
  if (c.d.worktrees.length === 0) return <Text dimColor>Looking for worktrees…</Text>
  const w = c.view.inspect ? c.d.worktrees.find(x => x.path === c.view.inspect) : undefined
  return w ? Inspector(ui, c, w) : Dashboard(ui, c)
}
