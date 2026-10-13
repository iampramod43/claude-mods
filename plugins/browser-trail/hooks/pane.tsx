// The pane's drawing: a header, telemetry cards, the execution timeline, the
// failure callout and the key line; the inspector and help as screens of
// their own. Everything here reads the trail; only the view toggles write.

import type { BrowserEvent, PageFact, Trail, View } from '../types'
import { cleanOutput, durationMs, fmtClock, moveSelection, sessionStatus, visible } from './trail'
import {
  detailOf,
  failureReport,
  fit,
  fmtShort,
  focusEvent,
  glyphFor,
  integrationName,
  layoutFor,
  pad2,
  STATUS_COLOR,
  STATUS_LABEL,
  telemetry,
  titleOf,
  windowAround,
  wrapLines,
} from './view'
import type { Layout } from './view'

// The surface's own elements, from $.ui.resolve(e).
type Els = { Box: any; Text: any; Button: any }

export type PaneInput = {
  t: Trail
  v: View
  now: number
  tick: number
  cols: number
  rows: number
  isLight: boolean
  setView: (fn: (old: View) => View) => void
  close: () => void
}

// Accents: theme keys where the theme has the meaning, raw colors for the
// two the theme has no name for.
const PURPLE = 'merged'
const CYAN = 'cyan'

// Card and callout fills, per theme brightness.
const fills = (isLight: boolean) =>
  isLight ? { card: '#eef0f4', alert: '#fdecec' } : { card: '#14161b', alert: '#240f12' }

// A tab still loading reports its URL as its title; that is no title.
const realTitle = (pg: PageFact) => (pg.title && pg.title !== pg.url && !/^https?:\/\//.test(pg.title) ? pg.title : undefined)

const STEP_COLOR = { ok: 'success', error: 'error', 'not run': 'warning', unknown: 'inactive' } as const
const STEP_LABEL = { ok: 'DONE', error: 'FAILED', 'not run': 'NOT RUN', unknown: '—' } as const

// "2/3 ok, step 3 failed" for a batch, from its own report.
export const stepNote = (ev: BrowserEvent) => {
  if (!ev.steps?.length || ev.status === 'running') return ''
  const ok = ev.steps.filter(st => st.status === 'ok').length
  const bad = ev.steps.findIndex(st => st.status === 'error')
  if (bad !== -1) return `${ok}/${ev.steps.length} ok, step ${bad + 1} failed`
  return ok === ev.steps.length ? `${ok} steps ok` : ''
}

export const drawPane = (els: Els, p: PaneInput) => {
  const { Box } = els
  const L = layoutFor(p.cols, p.rows)
  const list = visible(p.t, p.v)
  const failure = pickFailure(list, p.v.selected)

  let body
  if (p.v.isHelpOpen) body = help(els, L)
  else if (p.v.isDetailOpen && focusEvent(list, p.v.selected)) body = inspector(els, p, focusEvent(list, p.v.selected)!, L)
  else body = timeline(els, p, L, list, failure ? CALLOUT_ROWS : 0)

  return (
    <Box flexDirection="column">
      {header(els, p, L)}
      {L.mode === 'full' ? cards(els, p, list, L.cols) : strip(els, p, list)}
      {rule(els, L.cols)}
      {body}
      {failure && !p.v.isHelpOpen && !p.v.isDetailOpen && L.mode === 'full' ? callout(els, p, failure, list, L.cols) : null}
      {keys(els, p, L, list)}
    </Box>
  )
}

const rule = ({ Text }: Els, cols: number) => (
  <Text dimColor wrap="truncate-end">
    {'─'.repeat(cols)}
  </Text>
)

const header = ({ Box, Text }: Els, p: PaneInput, L: Layout) => {
  const state = p.t.isEnded ? 'ENDED' : p.t.connected.length === 0 && p.t.events.length === 0 ? 'DISCONNECTED' : sessionStatus(p.t, p.now)
  const pill = {
    LIVE: { text: 'LIVE SESSION', color: 'success' },
    IDLE: { text: 'IDLE', color: 'warning' },
    ENDED: { text: 'ENDED', color: 'inactive' },
    DISCONNECTED: { text: 'NO BROWSER TOOLS', color: 'error' },
  }[state]
  const tools = p.t.connected.length ? p.t.connected.map(integrationName).join(' / ') : 'NO BROWSER TOOLS CONNECTED'
  const sid = p.t.sessionId ? ` · SESSION ${p.t.sessionId.slice(0, 4).toUpperCase()}` : ''
  const page = p.t.page
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={PURPLE}>{'▣ '}</Text>
          <Text bold>BROWSER TRAIL</Text>
        </Text>
        <Text backgroundColor={pill.color} color="inverseText" bold>
          {` ${pill.text} `}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {`${tools}${sid}${p.v.isAllTools ? ' · ALL TOOLS' : ''}`}
      </Text>
      {L.mode === 'full' && page ? (
        <Text wrap="truncate-end">
          <Text dimColor>{'⌂ '}</Text>
          {realTitle(page) ? <Text>{`${realTitle(page)} · `}</Text> : ''}
          <Text color="suggestion">{page.url}</Text>
          <Text dimColor>{page.confidence === 'observed' ? '' : ' ≈'}</Text>
        </Text>
      ) : null}
    </Box>
  )
}

const cards = ({ Box, Text }: Els, p: PaneInput, list: BrowserEvent[], cols: number) => {
  const tel = telemetry(p.t, list, p.now)
  const bg = fills(p.isLight).card
  const items = [
    { label: 'ACTIONS', value: pad2(tel.total), color: undefined as string | undefined },
    { label: 'FAILURES', value: pad2(tel.failed), color: tel.failed ? 'error' : 'inactive' },
    { label: 'AVG LATENCY', value: fmtShort(tel.avgMs), color: tel.avgMs === undefined ? 'inactive' : PURPLE },
    { label: 'ELAPSED', value: fmtShort(tel.elapsedMs), color: tel.elapsedMs === undefined ? 'inactive' : CYAN },
  ]
  return (
    <Box flexDirection="row" gap={1} marginTop={1}>
      {items.map(it => (
        <Box key={it.label} flexDirection="column" flexGrow={1} width={0} backgroundColor={bg} paddingX={1}>
          <Text dimColor wrap="truncate-end">
            {it.label}
          </Text>
          <Text bold color={it.color} wrap="truncate-end">
            {it.value}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

// The short-terminal stand-in for the cards.
const strip = ({ Text }: Els, p: PaneInput, list: BrowserEvent[]) => {
  const tel = telemetry(p.t, list, p.now)
  return (
    <Text wrap="truncate-end">
      <Text bold>{pad2(tel.total)}</Text>
      <Text dimColor> actions · </Text>
      <Text bold color={tel.failed ? 'error' : 'inactive'}>
        {pad2(tel.failed)}
      </Text>
      <Text dimColor> failed · avg </Text>
      <Text color={PURPLE}>{fmtShort(tel.avgMs)}</Text>
      <Text dimColor> · </Text>
      <Text color={CYAN}>{fmtShort(tel.elapsedMs)}</Text>
    </Text>
  )
}

// Rows the callout takes: border 2, title, two error lines, caveat, next check.
const CALLOUT_ROWS = 8

const timeline = (els: Els, p: PaneInput, L: Layout, list: BrowserEvent[], below: number) => {
  const { Box, Text } = els
  // Rows above: header 2-3, cards 3, rule 1, the title 1; below: keys 1.
  const chrome = L.mode === 'full' ? 9 + (p.t.page ? 1 : 0) : 5
  const perEvent = L.mode === 'full' ? 2 : 1
  const room = Math.max(2, Math.floor((L.rows - chrome - below) / perEvent))
  const focusIdx = p.v.selected ? list.findIndex(e => e.id === p.v.selected) : -1
  const win = windowAround(list, focusIdx, room)
  const above = win.start
  const after = list.length - win.start - win.rows.length
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={PURPLE}>
          {p.v.isFailuresOnly ? 'FAILED CALLS' : 'EXECUTION TIMELINE'}
        </Text>
        <Text dimColor>
          {[above ? `↑ ${above} earlier` : '', after ? `↓ ${after} later` : '', p.t.dropped ? `+${p.t.dropped} dropped` : ''].filter(Boolean).join('  ')}
        </Text>
      </Box>
      {list.length === 0 && emptyTimeline(els, p)}
      {win.rows.map((ev, i) => eventRow(els, p, L, ev, win.start + i === list.length - 1))}
    </Box>
  )
}

const emptyTimeline = ({ Text }: Els, p: PaneInput) => (
  <Text dimColor wrap="wrap">
    {p.t.events.length > 0
      ? p.v.isFailuresOnly
        ? '  No failed calls. f shows every call again.'
        : '  Timeline cleared. Nothing was deleted; new calls appear here.'
      : p.t.connected.length === 0
        ? '  No browser tools are connected. Turn on Claude in Chrome (/chrome) or a browser MCP server, or use /browser-trail all to follow every tool call.'
        : '  Waiting for the first browser tool call.'}
  </Text>
)

const eventRow = (els: Els, p: PaneInput, L: Layout, ev: BrowserEvent, isLast: boolean) => {
  const { Box, Text, Button } = els
  const isSel = ev.id === p.v.selected
  const color = STATUS_COLOR[ev.status]
  const dur = durationMs(ev, p.now)
  const durText = ev.status === 'running' ? `${fmtShort(dur)}…` : fmtShort(dur)
  const title = `${pad2(ev.seq)} ${titleOf(ev)}${ev.classification === 'inferred' ? ' ?' : ''}`
  const note = stepNote(ev)
  const detail = [note, detailOf(ev)].filter(Boolean).join(' · ')
  const select = () => p.setView(o => ({ ...o, selected: ev.id, isDetailOpen: true, isHelpOpen: false }))
  // The title shrinks; the duration and status on the right never move.
  const line1 = (
    <Box key={ev.id} flexDirection="row" justifyContent="space-between">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Button key={`ev-${ev.id}`} plain onPress={select}>
          <Text color={color} bold>{`${glyphFor(ev.status, p.tick)}  `}</Text>
          <Text bold inverse={isSel} wrap="truncate-end">
            {title}
          </Text>
        </Button>
      </Box>
      <Box flexShrink={0} paddingLeft={2}>
        <Text dimColor>{`${durText}  `}</Text>
        <Text color={color} bold>
          {STATUS_LABEL[ev.status]}
        </Text>
      </Box>
    </Box>
  )
  if (L.mode === 'short') return line1
  return (
    <Box key={`row-${ev.id}`} flexDirection="column">
      {line1}
      <Text dimColor wrap="truncate-end">
        {`${isLast ? '   ' : '│  '}   ${detail}`}
      </Text>
    </Box>
  )
}

// The failure the callout explains: the selected call when it failed, else
// the newest failure in view.
const pickFailure = (list: BrowserEvent[], selected: string | undefined) => {
  const failed = (e: BrowserEvent) => e.status === 'error' || e.status === 'timeout'
  const sel = list.find(e => e.id === selected)
  return sel && failed(sel) ? sel : [...list].reverse().find(failed)
}

const callout = ({ Box, Text }: Els, p: PaneInput, ev: BrowserEvent, list: BrowserEvent[], cols: number) => {
  const tool = ev.toolName.startsWith('mcp__') ? ev.toolName.slice(ev.toolName.lastIndexOf('__') + 2) : ev.toolName
  const item = failureReport(list).find(f => f.ev.id === ev.id)
  const w = cols - 4
  const isTest = item?.kind === 'test'
  const next = item?.nextCheck
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="error" backgroundColor={fills(p.isLight).alert} paddingX={1}>
      <Text wrap="truncate-end">
        <Text color="error" bold>{`⚠ ${ev.status === 'timeout' ? 'ACTION TIMED OUT' : 'ACTION FAILED'}`}</Text>
        <Text dimColor>{`  #${pad2(ev.seq)} ${titleOf(ev)}`}</Text>
      </Text>
      <Text wrap="truncate-end">
        {isTest ? 'The test run reported a failure (exit status of the command).' : `${tool} returned an error:`}
      </Text>
      {wrapLines(cleanOutput(ev.errorSummary ?? '') || 'no error text was returned', w - 2, 2).map((line, i) => (
        <Text key={`err-${i}`} color="error" wrap="truncate-end">
          {`  ${line}`}
        </Text>
      ))}
      <Text dimColor wrap="truncate-end">
        {isTest
          ? 'Inspect the run to see which test failed.'
          : ev.integration === 'tool'
            ? 'This is the tool call failing, as reported by the tool.'
            : 'A failed tool call does not show that the app failed.'}
      </Text>
      {ev.integration !== 'tool' && (
        <Text dimColor wrap="truncate-end">
          {next
            ? `Next page check: #${pad2(next.seq)} ${titleOf(next)} · ${STATUS_LABEL[next.status]}`
            : 'No later check of the page observed.'}
        </Text>
      )}
    </Box>
  )
}

const kv = ({ Text }: Els, k: string, val: string | undefined, w: number, color?: string) =>
  val ? (
    <Text key={k} wrap="truncate-end">
      <Text dimColor>{fit(k.toUpperCase(), 10, true)}</Text>
      <Text color={color}>{fit(val, Math.max(10, w - 10))}</Text>
    </Text>
  ) : null

const block = ({ Box, Text }: Els, k: string, val: string | undefined, w: number, max: number, color?: string) =>
  val ? (
    <Box key={k} flexDirection="column" marginTop={1}>
      <Text dimColor>{k.toUpperCase()}</Text>
      {wrapLines(val, w - 2, max).map((line, i) => (
        <Text key={`${k}-${i}`} color={color} wrap="truncate-end">
          {`  ${line}`}
        </Text>
      ))}
    </Box>
  ) : null

const inspector = (els: Els, p: PaneInput, ev: BrowserEvent, L: Layout) => {
  const { Box, Text } = els
  const w = L.cols - 1
  const isBrowser = ev.integration !== 'tool'
  const titleLines = wrapLines(titleOf(ev), w, 2)
  // The fixed lines: heading, title, detail, a gap, and the key/value rows.
  const kvRows = 6 + (ev.target ? 1 : 0) + (isBrowser ? 1 + (ev.page ? 1 : 0) + (ev.status === 'ok' ? 1 : 0) : 0)
  const fixed = 3 + titleLines.length + kvRows
  // Rows under the header, cards and keys (9, +1 with a page line), less
  // the fixed lines: shared by input, steps, evidence and output, so the
  // screen never outgrows the pane.
  let left = Math.max(6, L.rows - 9 - (p.t.page ? 1 : 0) - fixed)
  const inputMax = Math.min(3, Math.max(1, Math.floor(left / 3)))
  left -= inputMax + 2
  const stepsShown = ev.steps?.length ? Math.min(ev.steps.length, Math.max(1, Math.floor(left / 2))) : 0
  if (stepsShown) left -= stepsShown + 2
  const showEvidence = Boolean(ev.evidence?.length) && left > 5
  if (showEvidence) left -= 4
  const outMax = Math.max(1, left - 2)
  const out = ev.status === 'ok' ? ev.outputSummary : ev.errorSummary
  const color = STATUS_COLOR[ev.status]
  const dur = durationMs(ev, p.now)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={PURPLE}>{`INSPECT · #${pad2(ev.seq)}`}</Text>
        <Text color={color} bold>{`${glyphFor(ev.status, p.tick)} ${STATUS_LABEL[ev.status]}`}</Text>
      </Box>
      {titleLines.map((line, i) => (
        <Text key={`t-${i}`} bold wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Text dimColor wrap="truncate-end">
        {detailOf(ev)}
      </Text>
      <Text> </Text>
      {kv(els, 'tool', ev.toolName, w)}
      {kv(els, 'action', `${ev.actionType} · ${ev.classification}`, w)}
      {kv(els, 'started', ev.startedAt !== undefined ? fmtClock(ev.startedAt) : 'not observed', w)}
      {kv(els, 'duration', `${fmtShort(dur)}${ev.status === 'running' ? '…' : ''}`, w)}
      {kv(els, 'status', `${STATUS_LABEL[ev.status]}${ev.statusSource ? ` via ${ev.statusSource}` : ''}`, w, color)}
      {kv(els, 'source', ev.integration, w)}
      {kv(els, 'target', ev.target, w)}
      {isBrowser && kv(els, 'page', ev.page ? `${realTitle(ev.page) ? `${realTitle(ev.page)} · ` : ''}${ev.page.url}` : 'not exposed', w, ev.page ? 'suggestion' : undefined)}
      {isBrowser && ev.page && kv(els, '', `${ev.page.confidence}: ${ev.page.via}`, w)}
      {isBrowser && ev.status === 'ok' && kv(els, 'meaning', 'the call returned; not proof of page state', w)}
      {block(els, 'input', ev.inputSummary, w, inputMax)}
      {block(els, ev.status === 'ok' ? 'output' : 'error', out ? cleanOutput(out) : undefined, w, outMax, ev.status === 'ok' ? undefined : 'error')}
      {showEvidence ? block(els, 'evidence', ev.evidence!.join('\n'), w, 2) : null}
      {ev.steps?.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>STEPS · from the call's input, status from its report</Text>
          {ev.steps.slice(0, stepsShown).map((st, i) => (
            <Text key={`s-${i}`} wrap="truncate-end">
              <Text color={STEP_COLOR[st.status]}>{`  ${pad2(i + 1)} ${fit(STEP_LABEL[st.status], 8, true)}`}</Text>
              {fit(st.label, Math.max(10, w - 14))}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

const help = ({ Box, Text }: Els, L: Layout) => {
  const rows: [string, string][] = [
    ['j / k', 'next / previous call'],
    ['tab ⏎', 'focus a row and inspect it'],
    ['o', 'inspect the selected call (o again to go back)'],
    ['f', 'failed calls only'],
    ['c', 'clear the timeline (nothing is deleted)'],
    ['h', 'this help'],
    ['q', 'close the pane (the browser is untouched)'],
  ]
  return (
    <Box flexDirection="column">
      <Text bold color={PURPLE}>
        KEYS
      </Text>
      {rows.map(([k, d]) => (
        <Text key={k} wrap="truncate-end">
          <Text bold>{fit(k, 8, true)}</Text>
          <Text dimColor>{d}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text bold color={PURPLE}>
        LEGEND
      </Text>
      <Text wrap="truncate-end">
        <Text color="success">● DONE </Text>
        <Text color="warning">◐ RUNNING </Text>
        <Text color="error">● FAILED ● TIMEOUT </Text>
        <Text color="inactive">○ NO RESULT</Text>
      </Text>
      <Text dimColor wrap="wrap">
        DONE means the tool call returned without error, not that the page reached a state. ≈ correlated · ? inferred
        from a command line. Typed values, secrets and tokens are redacted before they are stored.
      </Text>
      {L.cols < 60 && <Text dimColor>Drag the dock wider for more room.</Text>}
    </Box>
  )
}

const keys = ({ Box, Button, Text }: Els, p: PaneInput, L: Layout, list: BrowserEvent[]) => {
  const k = (key: string, label: string, act: () => void) => (
    <Button key={`k-${key}`} hotkey={key} plain onPress={act}>
      {label}
    </Button>
  )
  return (
    <Box flexDirection="column">
      {rule({ Text } as Els, L.cols)}
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" columnGap={2}>
          {k('j', 'next', () => p.setView(o => ({ ...o, selected: moveSelection(visible(p.t, o), o.selected, 1) })))}
          {k('k', 'prev', () => p.setView(o => ({ ...o, selected: moveSelection(visible(p.t, o), o.selected, -1) })))}
          {k('o', p.v.isDetailOpen ? 'back' : 'inspect', () =>
            p.setView(o => ({ ...o, selected: o.selected ?? focusEvent(list, undefined)?.id, isDetailOpen: !o.isDetailOpen, isHelpOpen: false })),
          )}
          {k('f', p.v.isFailuresOnly ? 'all' : 'failures', () => p.setView(o => ({ ...o, isFailuresOnly: !o.isFailuresOnly, isDetailOpen: false })))}
          {L.cols >= 72 && k('c', 'clear', () => p.setView(o => ({ ...o, hiddenThrough: p.t.seq, selected: undefined, isDetailOpen: false })))}
          {k('h', p.v.isHelpOpen ? 'back' : 'help', () => p.setView(o => ({ ...o, isHelpOpen: !o.isHelpOpen })))}
        </Box>
        {k('q', 'close', p.close)}
      </Box>
    </Box>
  )
}
