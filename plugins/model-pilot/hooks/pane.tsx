// The ModelPilot cockpit: header, tabs, and four panels (overview with the
// radial chart and agent lanes, the data-flow graph, the activity feed, the
// router's plan). Wide panes show the radial, lanes, graph and feed at once.
// Everything drawn is read from real state; nothing here invents activity.

import type { Panel, PilotEvent, Pilot, Subtask, Task, View } from '../types'
import { edgeLines, layoutGraph } from './graph'
import { barTarget, barValue, overall } from './progress'
import { DARK, donut, LIGHT, type Palette } from './raster'
import { filterEvents } from './store'

type Els = { Box: any; Text: any; Button: any; Raster?: any }

export type PaneInput = {
  p: Pilot
  v: View
  now: number
  tick: number
  cols: number
  rows: number
  isLight: boolean
  isTerminal: boolean
  setView: (fn: (v: View) => View) => void
  setActive: (taskId: string) => void
  approve: () => void
  cancel: (subtaskId?: string) => void
  toggleMotion: () => void
  close: () => void
}

const WIDE = 110
const PURPLE = 'merged'

const STATE_COLOR: Record<Subtask['state'], string> = {
  queued: 'inactive',
  ready: 'suggestion',
  running: 'warning',
  blocked: 'error',
  completed: 'success',
  failed: 'error',
  cancelled: 'inactive',
}

const TASK_PILL: Record<Task['state'], { text: string; color: string }> = {
  planned: { text: 'PLANNED', color: 'suggestion' },
  'awaiting-approval': { text: 'AWAITING APPROVAL', color: 'warning' },
  running: { text: 'RUNNING', color: 'success' },
  completed: { text: 'COMPLETED', color: 'success' },
  failed: { text: 'FAILED', color: 'error' },
  cancelled: { text: 'CANCELLED', color: 'inactive' },
  direct: { text: 'NO AGENTS NEEDED', color: 'suggestion' },
}

const SHORT_STATE: Record<Task['state'], string> = {
  planned: 'planned',
  'awaiting-approval': 'approve?',
  running: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  direct: 'no agents',
}

export const fmtMs = (ms: number | undefined) => {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

export const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s)

// A bar with eighth-cell precision.
export const bar = (value: number, width: number) => {
  const cells = (Math.max(0, Math.min(100, value)) / 100) * width
  const full = Math.floor(cells)
  const part = Math.round((cells - full) * 8)
  const parts = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
  const filled = '█'.repeat(full) + (part > 0 && full < width ? parts[part] : '')
  return { filled, empty: ' '.repeat(Math.max(0, width - [...filled].length)) }
}

export const drawPane = (els: Els, i: PaneInput) => {
  const { Box, Text } = els
  const t = i.p.tasks.find(x => x.id === i.p.activeTaskId)
  const isWide = i.cols >= WIDE
  const pal = i.isLight ? LIGHT : DARK
  let body
  if (i.v.isHelpOpen) body = help(els)
  else if (!t) body = emptyState(els, i)
  else if (i.v.panel === 'graph') body = graphPanel(els, i, t, pal, i.cols, true)
  else if (i.v.panel === 'feed') body = feedPanel(els, i, t, Math.max(6, i.rows - 8))
  else if (i.v.panel === 'plan') body = planPanel(els, i, t)
  else body = isWide ? wideOverview(els, i, t, pal) : overview(els, i, t, pal, i.cols)
  return (
    <Box flexDirection="column">
      {header(els, i, t)}
      {tabs(els, i, t)}
      <Text dimColor wrap="truncate-end">
        {'─'.repeat(i.cols)}
      </Text>
      {body}
      {keys(els, i, t)}
    </Box>
  )
}

const header = ({ Box, Text }: Els, i: PaneInput, t: Task | undefined) => {
  const pill = t ? TASK_PILL[t.state] : { text: 'IDLE', color: 'inactive' }
  const end = t?.endedAt ?? i.now
  const team = t ? [...new Set(t.subtasks.map(s => s.model))].join('+') : ''
  const budget = i.p.config.budgetUsd !== undefined ? ` · BUDGET $${i.p.config.budgetUsd}` : ''
  const meta = t
    ? `${t.decision.strategy.toUpperCase()}${t.subtasks.length ? ` · ${t.subtasks.length} SUBTASK${t.subtasks.length === 1 ? '' : 'S'}` : ''}${team ? ` · ${team.toUpperCase()}` : ''} · ${fmtMs(end - t.createdAt)} · MODE ${i.p.config.mode.toUpperCase()}${budget}`
    : `MODE ${i.p.config.mode.toUpperCase()} · MAX ${i.p.config.maxAgents} AGENTS${budget}`
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={PURPLE} bold>
            {'◈ MODELPILOT'}
          </Text>
          {t ? <Text bold>{`  ${t.title}`}</Text> : ''}
        </Text>
        <Box flexShrink={0} paddingLeft={1}>
          <Text backgroundColor={pill.color} color="inverseText" bold>
            {` ${pill.text} `}
          </Text>
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">
        {meta}
      </Text>
    </Box>
  )
}

const TABS: [Panel, string, string][] = [
  ['overview', '1', 'Overview'],
  ['graph', '2', 'Graph'],
  ['feed', '3', 'Feed'],
  ['plan', '4', 'Plan'],
]

const tabs = ({ Box, Button, Text }: Els, i: PaneInput, t: Task | undefined) => (
  <Box flexDirection="row" columnGap={2}>
    {TABS.map(([panel, key, label]) => (
      <Button key={`tab-${panel}`} hotkey={key} plain onPress={() => i.setView(v => ({ ...v, panel, isHelpOpen: false, isDetailOpen: false }))}>
        <Text bold={i.v.panel === panel} color={i.v.panel === panel ? PURPLE : undefined} underline={i.v.panel === panel}>
          {label}
        </Text>
      </Button>
    ))}
    {i.p.tasks.length > 1 && (
      <Button key="tab-next" hotkey="t" plain onPress={() => {
        const idx = i.p.tasks.findIndex(x => x.id === t?.id)
        i.setActive(i.p.tasks[(idx + 1) % i.p.tasks.length]!.id)
      }}>
        <Text dimColor>{`task ${t ? i.p.tasks.indexOf(t) + 1 : 0}/${i.p.tasks.length}`}</Text>
      </Button>
    )}
  </Box>
)

const emptyState = ({ Box, Text }: Els, i: PaneInput) => (
  <Box flexDirection="column">
    <Text bold>No task yet.</Text>
    <Text dimColor wrap="wrap">
      Start one with /model-pilot plan &lt;task&gt;. Write independent parts with ; and ordered steps with then. In recommend mode nothing starts until you approve.
    </Text>
    <Text> </Text>
    <Text bold color={PURPLE}>
      MODELS THIS BUILD CAN INVOKE
    </Text>
    {i.p.registry.map(m => (
      <Text key={`m-${m.alias}`} wrap="truncate-end">
        <Text bold>{m.alias.padEnd(8)}</Text>
        <Text dimColor>{`tier ${m.tier ?? '—'} (${m.tierSource}) · ctx ${m.contextWindow ? `${fmtTok(m.contextWindow)} (session)` : 'unknown'} · price unknown · ${m.isVerified ? `${m.runs} run(s)` : 'not run yet'}${m.isSessionDefault ? ' · session' : ''}`}</Text>
      </Text>
    ))}
  </Box>
)

// ---- overview ---------------------------------------------------------------

const radial = (els: Els, i: PaneInput, t: Task, pal: Palette, cols: number, rows: number) => {
  const { Box, Text, Raster } = els
  const o = overall(t.subtasks)
  const pct = o.fraction === undefined ? undefined : Math.round(o.fraction * 100)
  const label = [
    { text: pct === undefined ? '—' : `${pct}%`, color: pal.text },
    { text: pct === undefined ? 'no plan' : o.isEstimated ? 'est.' : SHORT_STATE[t.state], color: pal.dim },
  ]
  const ring = o.total ? { done: o.doneWeight / o.total, partial: o.partialWeight / o.total, failed: o.failedWeight / o.total } : undefined
  const chart =
    i.isTerminal && Raster ? (
      <Raster key="radial" columns={cols} rows={rows} cells={donut(cols, rows, ring, pal, label).encode()} />
    ) : (
      <Text bold>{pct === undefined ? '—' : `${pct}%${o.isEstimated ? ' est.' : ''}`}</Text>
    )
  return (
    <Box flexDirection="row" gap={2}>
      {chart}
      <Box flexDirection="column" justifyContent="center">
        <Text>
          <Text color="success">{'● '}</Text>
          {`${o.counts.completed}/${t.subtasks.length} completed`}
        </Text>
        {o.counts.running > 0 && (
          <Text>
            <Text color="warning">{'● '}</Text>
            {`${o.counts.running} running${o.isEstimated ? ' (agent-reported, est.)' : ''}`}
          </Text>
        )}
        {o.counts.failed + o.counts.cancelled > 0 && (
          <Text>
            <Text color="error">{'● '}</Text>
            {`${o.counts.failed} failed · ${o.counts.cancelled} cancelled (not counted)`}
          </Text>
        )}
        {o.counts.blocked > 0 && <Text color="error">{`◌ ${o.counts.blocked} blocked`}</Text>}
        {o.counts.queued + o.counts.ready > 0 && <Text dimColor>{`○ ${o.counts.queued + o.counts.ready} waiting`}</Text>}
        <Text dimColor wrap="wrap">
          progress = completed weight ÷ total; a running agent adds only what it reported
        </Text>
      </Box>
    </Box>
  )
}

const lane = (els: Els, i: PaneInput, t: Task, s: Subtask, width: number) => {
  const { Box, Text, Button } = els
  const isSel = s.id === i.v.selected
  const color = STATE_COLOR[s.state]
  const dur = s.startedAt ? (s.endedAt ?? i.now) - s.startedAt : undefined
  const value = barValue(s, i.now, i.p.config.isAnimated)
  const barW = Math.max(8, Math.min(28, width - 34))
  const b = value === undefined ? undefined : bar(value, barW)
  const tokens = s.usage ? `${fmtTok(s.usage.input + s.usage.cacheRead + s.usage.cacheWrite)} in · ${fmtTok(s.usage.output)} out` : s.state === 'completed' ? 'tokens not reported' : ''
  const lastArtifact = [...t.events].reverse().find(e => (e.agent === s.id || e.to === s.id) && e.artifact && (e.type === 'artifact_read' || e.type === 'artifact_created' || e.type === 'artifact_updated'))
  const third =
    s.state === 'blocked'
      ? `blocked: ${s.blockedReason ?? ''}`
      : s.error
        ? s.error
        : s.state === 'queued' && s.deps.length
          ? `waits for ${s.deps.join(', ')}`
          : [s.activity, lastArtifact ? `${lastArtifact.type === 'artifact_read' ? 'read' : 'wrote'} ◆ ${lastArtifact.artifact}` : undefined].filter(Boolean).join(' · ')
  return (
    <Box key={`lane-${s.id}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Button key={`sel-${s.id}`} plain onPress={() => i.setView(v => ({ ...v, selected: s.id, isDetailOpen: true }))}>
            <Text color={color} bold>
              {s.state === 'running' ? '◉ ' : s.state === 'completed' ? '● ' : s.state === 'failed' || s.state === 'blocked' ? '✗ ' : '○ '}
            </Text>
            <Text bold inverse={isSel}>
              {s.id}
            </Text>
            <Text color={PURPLE}>{` ${s.resolvedModel ?? s.model} `}</Text>
            <Text>{fit(s.title, Math.max(8, width - 26 - (s.resolvedModel ?? s.model).length))}</Text>
          </Button>
        </Box>
        <Box flexShrink={0} paddingLeft={1}>
          <Text dimColor>{`${fmtMs(dur)} `}</Text>
          <Text color={color} bold>
            {s.state.toUpperCase()}
          </Text>
        </Box>
      </Box>
      <Text wrap="truncate-end">
        <Text dimColor>{'  ▕'}</Text>
        {b ? (
          <Text>
            <Text color={color}>{b.filled}</Text>
            <Text backgroundColor={i.isLight ? '#d8dee4' : '#262b36'}>{b.empty}</Text>
          </Text>
        ) : (
          <Text color="warning" dimColor>
            {'░'.repeat(barW)}
          </Text>
        )}
        <Text dimColor>{'▏ '}</Text>
        <Text bold={Boolean(b)}>{b ? `${Math.round(barTarget(s) ?? 0)}%` : 'no progress reported'}</Text>
        <Text dimColor>{s.progress && s.state === 'running' ? ' est.' : ''}</Text>
        <Text dimColor>{tokens ? `  ${tokens}` : ''}</Text>
      </Text>
      {third ? (
        <Text dimColor wrap="truncate-end">
          {`  ${third}`}
        </Text>
      ) : null}
    </Box>
  )
}

const lanes = (els: Els, i: PaneInput, t: Task, width: number, room: number) => {
  const { Box, Text } = els
  const per = 3
  const max = Math.max(1, Math.floor(room / per))
  const selIdx = t.subtasks.findIndex(s => s.id === i.v.selected)
  const start = selIdx < max ? 0 : Math.min(t.subtasks.length - max, selIdx - max + 1)
  const shown = t.subtasks.slice(start, start + max)
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={PURPLE}>
          AGENTS
        </Text>
        <Text dimColor>{`  ${t.subtasks.length ? `${t.subtasks.length} subtask(s)` : 'none'}${t.subtasks.length > shown.length ? ` · showing ${start + 1}-${start + shown.length}` : ''}`}</Text>
      </Text>
      {t.subtasks.length === 0 && (
        <Text dimColor wrap="wrap">
          {t.state === 'direct' ? 'Short task: no agent is worth its overhead. See Plan (4) for the suggested model.' : t.decision.refused ?? 'No subtasks.'}
        </Text>
      )}
      {shown.map(s => lane(els, i, t, s, width))}
    </Box>
  )
}

const detail = (els: Els, i: PaneInput, t: Task, s: Subtask) => {
  const { Box, Text } = els
  const evs = filterEvents(t.events, 'agent', s.id).slice(-6)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={STATE_COLOR[s.state]} paddingX={1}>
      <Text bold>{`${s.id} · ${s.title}`}</Text>
      <Text dimColor wrap="wrap">{`model ${s.resolvedModel ?? s.model} — ${s.modelReason}`}</Text>
      <Text dimColor wrap="wrap">{`objective: ${s.objective}`}</Text>
      {s.deps.length > 0 && <Text dimColor>{`depends on ${s.deps.join(', ')}`}</Text>}
      {s.error && <Text color="error" wrap="wrap">{`error: ${s.error}`}</Text>}
      {s.blockedReason && <Text color="error" wrap="wrap">{`blocked: ${s.blockedReason}`}</Text>}
      {s.usage && <Text dimColor>{`tokens (provider-reported): ${s.usage.input} in · ${s.usage.cacheRead} cache read · ${s.usage.cacheWrite} cache write · ${s.usage.output} out · ${s.usage.model}`}</Text>}
      {s.progress && <Text dimColor>{`last progress report: ${s.progress.pct}%${s.progress.note ? ` — ${s.progress.note}` : ''}`}</Text>}
      {evs.map(e => (
        <Text key={`de-${e.id}`} dimColor wrap="truncate-end">
          {`${clock(e.at)} ${e.reason}`}
        </Text>
      ))}
    </Box>
  )
}

const overview = (els: Els, i: PaneInput, t: Task, pal: Palette, width: number) => {
  const { Box } = els
  const sel = t.subtasks.find(s => s.id === i.v.selected)
  const room = Math.max(4, i.rows - 8 - 11)
  return (
    <Box flexDirection="column">
      {radial(els, i, t, pal, 22, 11)}
      {i.v.isDetailOpen && sel ? detail(els, i, t, sel) : lanes(els, i, t, width, room)}
    </Box>
  )
}

const wideOverview = (els: Els, i: PaneInput, t: Task, pal: Palette) => {
  const { Box } = els
  const sel = t.subtasks.find(s => s.id === i.v.selected)
  const leftW = 52
  const rightW = i.cols - leftW - 2
  const graphW = Math.floor(i.cols * 0.6)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Box width={leftW} flexDirection="column">
          {radial(els, i, t, pal, 24, 12)}
        </Box>
        <Box width={rightW} flexDirection="column">
          {i.v.isDetailOpen && sel ? detail(els, i, t, sel) : lanes(els, i, t, rightW, 12)}
        </Box>
      </Box>
      <Box flexDirection="row" gap={2}>
        <Box width={graphW} flexDirection="column">
          {graphPanel(els, i, t, pal, graphW, false)}
        </Box>
        <Box width={i.cols - graphW - 2} flexDirection="column">
          {feedPanel(els, i, t, 12)}
        </Box>
      </Box>
    </Box>
  )
}

// ---- graph ------------------------------------------------------------------

const graphPanel = (els: Els, i: PaneInput, t: Task, pal: Palette, width: number, isFull: boolean) => {
  const { Box, Text, Raster } = els
  const g = layoutGraph(t, width, pal, i.now, { maxArtifacts: isFull ? 10 : 6, selected: i.v.selected })
  const real = g.edges.filter(e => e.kind !== 'dep').length
  const sel = t.subtasks.find(s => s.id === i.v.selected)
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={PURPLE}>
          DATA FLOW
        </Text>
        <Text dimColor>{`  ${real} context edge(s) from real events${g.grouped ? ` · ${g.grouped} older artifacts grouped` : ''}`}</Text>
      </Text>
      {i.isTerminal && Raster && width >= 48 ? (
        <Raster key="graph" columns={width} rows={g.grid.rows} cells={g.grid.encode()} />
      ) : (
        <Box flexDirection="column">
          {edgeLines(t).slice(0, 12).map((l, n) => (
            <Text key={`el-${n}`} wrap="truncate-end">
              {l}
            </Text>
          ))}
          {real === 0 && <Text dimColor>No artifact reads, writes or handoffs yet.</Text>}
        </Box>
      )}
      <Text wrap="truncate-end">
        <Text color="suggestion">{'┄◀ read  '}</Text>
        <Text color="success">{'─▶ write  '}</Text>
        <Text color={PURPLE}>{'═▶ handoff  '}</Text>
        <Text dimColor>{'╎ dependency  '}</Text>
        <Text color="warning">{'lit = last 1.5s'}</Text>
      </Text>
      {isFull && sel && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{`${sel.id} edges`}</Text>
          {g.edges
            .filter(e => e.from === sel.id || e.to === sel.id)
            .map((e, n) => (
              <Text key={`se-${n}`} dimColor wrap="truncate-end">
                {`${e.kind.padEnd(8)} ${e.from} → ${e.to}${e.artifact && e.kind === 'handoff' ? ` via ◆ ${e.artifact}` : ''}${e.count > 1 ? ` ×${e.count}` : ''}${e.lastAt ? ` · last ${clock(e.lastAt)}` : ''}`}
              </Text>
            ))}
        </Box>
      )}
    </Box>
  )
}

// ---- feed -------------------------------------------------------------------

const EVENT_GLYPH: Partial<Record<PilotEvent['type'], [string, string]>> = {
  router_decision: ['◇', PURPLE],
  task_approved: ['✓', 'success'],
  agent_started: ['▶', 'warning'],
  agent_completed: ['●', 'success'],
  agent_failed: ['✗', 'error'],
  agent_cancelled: ['■', 'inactive'],
  progress_reported: ['%', 'warning'],
  artifact_created: ['◆', 'success'],
  artifact_updated: ['◆', 'success'],
  artifact_read: ['◇', 'suggestion'],
  artifact_shared: ['↗', 'inactive'],
  handoff_created: ['⇒', PURPLE],
  handoff_received: ['⇐', PURPLE],
  dependency_unblocked: ['⊳', 'suggestion'],
  budget_alert: ['$', 'error'],
  error: ['!', 'error'],
}

const clock = (at: number) => {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const feedPanel = (els: Els, i: PaneInput, t: Task, room: number) => {
  const { Box, Text } = els
  const list = filterEvents(t.events, i.v.feedFilter, i.v.selected).slice(-room)
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={PURPLE}>
          ACTIVITY
        </Text>
        <Text dimColor>{`  ${i.v.feedFilter}${i.v.feedFilter === 'agent' ? ` ${i.v.selected ?? '(select one)'}` : ''} · ${t.events.length} event(s)`}</Text>
      </Text>
      {list.length === 0 && <Text dimColor>Nothing yet.</Text>}
      {list.map(e => {
        const [g, c] = EVENT_GLYPH[e.type] ?? ['·', 'inactive']
        return (
          <Text key={`f-${e.id}`} wrap="truncate-end">
            <Text dimColor>{`${clock(e.at)} `}</Text>
            <Text color={e.isStale ? 'error' : c}>{`${g} `}</Text>
            <Text>{e.reason}</Text>
            {e.isStale ? <Text color="error"> (stale)</Text> : ''}
          </Text>
        )
      })}
    </Box>
  )
}

// ---- plan -------------------------------------------------------------------

const planPanel = (els: Els, i: PaneInput, t: Task) => {
  const { Box, Text } = els
  const d = t.decision
  const c = t.classification
  const sec = (title: string, lines: string[]) =>
    lines.length ? (
      <Box key={`sec-${title}`} flexDirection="column" marginTop={1}>
        <Text bold color={PURPLE}>
          {title}
        </Text>
        {lines.map((l, n) => (
          <Text key={`${title}-${n}`} wrap="wrap">
            <Text dimColor>{'· '}</Text>
            {l}
          </Text>
        ))}
      </Box>
    ) : null
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        <Text bold>{`Strategy ${d.strategy}`}</Text>
        <Text dimColor>{` · category ${d.category} · parallelism ${d.isParallelWorthwhile ? 'worthwhile' : 'not worthwhile'} · mode ${d.mode}`}</Text>
      </Text>
      {d.refused && <Text color="error">{d.refused}</Text>}
      {sec('ASSIGNMENTS', d.assignments.map(a => `${a.subtaskId} → ${a.model}: ${a.reason}`))}
      {sec('WHY', d.rationale)}
      {sec('CLASSIFICATION', [`${c.complexity} complexity · ${c.ambiguity} ambiguity · ${c.risk} risk · ${c.speed} · ${c.shape} (${c.steps} part(s))`, ...c.signals])}
      {sec('UNCERTAINTY', d.uncertainty)}
      {sec('TRADE-OFFS', d.tradeoffs)}
      {sec('FALLBACK', d.fallback ? [d.fallback] : [])}
      {sec('REGISTRY', i.p.registry.map(m => `${m.alias}: tier ${m.tier ?? '—'} (${m.tierSource}), ctx ${m.contextWindow ? `${fmtTok(m.contextWindow)} (session)` : 'unknown'}, price unknown, ${m.isVerified ? `${m.runs} run(s), avg ${fmtMs(m.totalMs / Math.max(1, m.runs))} (measured)` : 'not run yet'}`))}
    </Box>
  )
}

// ---- help & keys ------------------------------------------------------------

const help = ({ Box, Text }: Els) => {
  const rows: [string, string][] = [
    ['1 2 3 4', 'overview · graph · feed · plan'],
    ['j / k', 'select the next / previous agent'],
    ['o', 'details of the selected agent (o again to close)'],
    ['f', 'feed filter: all → failures → context → selected agent'],
    ['a', 'approve the planned task (recommend mode)'],
    ['x', 'cancel the selected agent, or the whole task if none'],
    ['m', 'motion on / off (bars ease only on real changes)'],
    ['t', 'next task, when there are several'],
    ['q', 'close the dashboard; the task keeps running'],
  ]
  return (
    <Box flexDirection="column">
      <Text bold color={PURPLE}>
        KEYS
      </Text>
      {rows.map(([k, d]) => (
        <Text key={`h-${k}`} wrap="truncate-end">
          <Text bold>{k.padEnd(9)}</Text>
          <Text dimColor>{d}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor wrap="wrap">
        Agents do not share one model context: they read and write artifacts in ModelPilot's store, and whatever an agent reads is copied into its own prompt and billed there. Graph lines appear only after a real read, write or handoff. Token counts are provider-reported per agent; prices are unknown to ModelPilot.
      </Text>
    </Box>
  )
}

const keys = ({ Box, Button, Text }: Els, i: PaneInput, t: Task | undefined) => {
  const k = (key: string, label: string, act: () => void) => (
    <Button key={`k-${key}`} hotkey={key} plain onPress={act}>
      {label}
    </Button>
  )
  const subs = t?.subtasks ?? []
  const move = (step: number) =>
    i.setView(v => {
      if (!subs.length) return v
      const at = subs.findIndex(s => s.id === v.selected)
      const next = at === -1 ? (step > 0 ? 0 : subs.length - 1) : Math.max(0, Math.min(subs.length - 1, at + step))
      return { ...v, selected: subs[next]!.id }
    })
  const FILTERS: View['feedFilter'][] = ['all', 'failures', 'context', 'agent']
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {'─'.repeat(i.cols)}
      </Text>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {k('j', 'next', () => move(1))}
          {k('k', 'prev', () => move(-1))}
          {k('o', i.v.isDetailOpen ? 'close' : 'details', () => i.setView(v => ({ ...v, isDetailOpen: !v.isDetailOpen, selected: v.selected ?? subs[0]?.id })))}
          {k('f', i.v.feedFilter, () => i.setView(v => ({ ...v, feedFilter: FILTERS[(FILTERS.indexOf(v.feedFilter) + 1) % FILTERS.length]! })))}
          {t?.state === 'awaiting-approval' && k('a', 'approve', i.approve)}
          {t?.state === 'running' && !t.isObserved && k('x', i.v.selected ? `cancel ${i.v.selected}` : 'cancel task', () => i.cancel(i.v.selected))}
          {k('m', i.p.config.isAnimated ? 'motion on' : 'motion off', i.toggleMotion)}
          {k('h', i.v.isHelpOpen ? 'back' : 'help', () => i.setView(v => ({ ...v, isHelpOpen: !v.isHelpOpen })))}
        </Box>
        {k('q', 'close', i.close)}
      </Box>
    </Box>
  )
}
