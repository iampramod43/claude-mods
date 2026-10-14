// The data-flow graph. Edges come only from recorded events:
//   write    agent → artifact   artifact_created / artifact_updated (not refused)
//   read     artifact → agent   artifact_read (an agent called read_artifact)
//   handoff  agent → agent      handoff_created (an output passed to a dependent)
//   dep      task → task        the plan's dependencies (a plan fact, drawn dim)
// Agents sit on the left, the shared context store is a bar on the right with
// its artifacts hanging off it; every artifact has its own vertical lane.

import type { Subtask, Task } from '../types'
import { Grid, type Palette } from './raster'

export type EdgeKind = 'read' | 'write' | 'handoff' | 'dep'

export type Edge = { kind: EdgeKind; from: string; to: string; artifact?: string; count: number; lastAt: number }

export const edgesOf = (t: Task): Edge[] => {
  const map = new Map<string, Edge>()
  const add = (kind: EdgeKind, from: string, to: string, at: number, artifact?: string) => {
    const key = `${kind}|${from}|${to}|${artifact ?? ''}`
    const e = map.get(key)
    if (e) {
      e.count++
      e.lastAt = Math.max(e.lastAt, at)
    } else map.set(key, { kind, from, to, artifact, count: 1, lastAt: at })
  }
  for (const s of t.subtasks) for (const d of s.deps) add('dep', d, s.id, 0)
  for (const e of t.events) {
    if ((e.type === 'artifact_created' || e.type === 'artifact_updated') && !e.isStale && e.artifact && (e.from ?? e.agent))
      add('write', (e.from ?? e.agent)!, e.artifact, e.at, e.artifact)
    else if (e.type === 'artifact_read' && e.artifact && (e.to ?? e.agent)) add('read', e.artifact, (e.to ?? e.agent)!, e.at, e.artifact)
    else if (e.type === 'handoff_created' && e.from && e.to) add('handoff', e.from, e.to, e.at, e.artifact)
  }
  return [...map.values()]
}

const U = 1
const R = 2
const D = 4
const L = 8

const LIGHT: Record<number, string> = {
  [L | R]: '─', [U | D]: '│', [R | D]: '┌', [L | D]: '┐', [U | R]: '└', [U | L]: '┘',
  [U | D | R]: '├', [U | D | L]: '┤', [L | R | D]: '┬', [L | R | U]: '┴', [U | R | D | L]: '┼',
  [L]: '─', [R]: '─', [U]: '│', [D]: '│',
}
const DOUBLE: Record<number, string> = {
  [L | R]: '═', [U | D]: '║', [R | D]: '╔', [L | D]: '╗', [U | R]: '╚', [U | L]: '╝',
  [U | D | R]: '╠', [U | D | L]: '╣', [L | R | D]: '╦', [L | R | U]: '╩', [U | R | D | L]: '╬',
  [L]: '═', [R]: '═', [U]: '║', [D]: '║',
}

const PRIORITY: EdgeKind[] = ['handoff', 'write', 'read', 'dep']

type Paint = { dirs: number; kinds: Set<EdgeKind>; isHot: boolean }

export type GraphLayout = {
  grid: Grid
  agents: string[]
  artifacts: string[]
  grouped: number
  edges: Edge[]
}

export const HOT_MS = 1500

export const layoutGraph = (
  t: Task,
  cols: number,
  pal: Palette,
  now: number,
  opts: { maxArtifacts?: number; selected?: string } = {},
): GraphLayout => {
  const edges = edgesOf(t)
  const touched = new Set<string>()
  for (const e of edges) if (e.kind === 'read' || e.kind === 'write') touched.add(e.artifact!)
  // Agents: the plan's subtasks, then any other writer or reader seen.
  const agents = t.subtasks.map(s => s.id)
  for (const e of edges) {
    const a = e.kind === 'read' ? e.to : e.kind === 'write' ? e.from : undefined
    if (a && !agents.includes(a)) agents.push(a)
  }
  // Artifacts: newest activity first kept, the rest grouped.
  const lastTouch = (id: string) => Math.max(...edges.filter(e => e.artifact === id).map(e => e.lastAt))
  let artifacts = [...touched].sort((a, b) => firstSeen(t, a) - firstSeen(t, b))
  const maxA = Math.max(2, opts.maxArtifacts ?? 8)
  let grouped = 0
  const GROUP = '…'
  if (artifacts.length > maxA) {
    const keep = new Set([...artifacts].sort((a, b) => lastTouch(b) - lastTouch(a)).slice(0, maxA - 1))
    grouped = artifacts.length - keep.size
    artifacts = [...artifacts.filter(a => keep.has(a)), GROUP]
  }
  const rowOfArtifact = (id: string) => {
    const i = artifacts.indexOf(id)
    // Artifact rows sit between agent rows, so a line on an agent's row
    // never runs on into an artifact it did not touch.
    return 3 + 2 * (i === -1 ? artifacts.indexOf(GROUP) : i)
  }
  const rowOfAgent = (id: string) => 2 + 2 * agents.indexOf(id)

  const left = edges.filter(e => e.kind === 'dep' || e.kind === 'handoff')
  const nLeft = Math.min(4, left.length)
  const G = nLeft ? 2 * nLeft + 1 : 0
  const A = 14
  const artW = Math.max(12, Math.min(24, Math.floor(cols * 0.3)))
  const bar = cols - artW - 2
  const laneStart = G + A + 2
  const lanes = Math.max(1, Math.floor((bar - 2 - laneStart) / 2))
  const height = Math.max(2 + 2 * agents.length, 4 + 2 * artifacts.length, 3)
  const g = new Grid(cols, height)
  const paint: Paint[] = Array.from({ length: cols * height }, () => ({ dirs: 0, kinds: new Set<EdgeKind>(), isHot: false }))
  const mark = (x: number, y: number, dirs: number, kind: EdgeKind, isHot: boolean) => {
    if (x < 0 || y < 0 || x >= cols || y >= height) return
    const p = paint[y * cols + x]!
    p.dirs |= dirs
    p.kinds.add(kind)
    p.isHot ||= isHot
  }
  const hline = (y: number, x1: number, x2: number, kind: EdgeKind, isHot: boolean) => {
    const [a, b] = x1 < x2 ? [x1, x2] : [x2, x1]
    for (let x = a; x <= b; x++) mark(x, y, (x > a ? L : 0) | (x < b ? R : 0), kind, isHot)
  }
  const vline = (x: number, y1: number, y2: number, kind: EdgeKind, isHot: boolean) => {
    const [a, b] = y1 < y2 ? [y1, y2] : [y2, y1]
    for (let y = a; y <= b; y++) mark(x, y, (y > a ? U : 0) | (y < b ? D : 0), kind, isHot)
  }
  const arrows: { x: number; y: number; ch: string; kind: EdgeKind; isHot: boolean }[] = []

  // The store: a bar every artifact hangs off.
  if (artifacts.length) vline(bar, 1, rowOfArtifact(artifacts[artifacts.length - 1]!) + 1, 'dep', false)

  // Middle: one lane per artifact.
  for (const e of edges) {
    if (e.kind !== 'read' && e.kind !== 'write') continue
    const agent = e.kind === 'read' ? e.to : e.from
    const ay = rowOfAgent(agent)
    const ry = rowOfArtifact(e.artifact!)
    const idx = artifacts.indexOf(e.artifact!) === -1 ? artifacts.length - 1 : artifacts.indexOf(e.artifact!)
    const lx = laneStart + 2 * (idx % lanes) + 1
    const isHot = now - e.lastAt < HOT_MS
    hline(ay, G + A, lx, e.kind, isHot)
    vline(lx, ay, ry, e.kind, isHot)
    hline(ry, lx, bar, e.kind, isHot)
    if (e.kind === 'write') arrows.push({ x: bar - 1, y: ry, ch: '▶', kind: e.kind, isHot })
    else arrows.push({ x: G + A, y: ay, ch: '◀', kind: e.kind, isHot })
  }

  // Left gutter: dependencies and handoffs between agents.
  left.forEach((e, k) => {
    const lane = G - 2 - 2 * (k % Math.max(1, nLeft))
    const y1 = rowOfAgent(e.from)
    const y2 = rowOfAgent(e.to)
    if (y1 < 2 || y2 < 2) return
    const isHot = e.kind === 'handoff' && now - e.lastAt < HOT_MS
    hline(y1, lane, G - 1, e.kind, isHot)
    vline(lane, y1, y2, e.kind, isHot)
    hline(y2, lane, G - 1, e.kind, isHot)
    arrows.push({ x: G - 1, y: y2, ch: '▶', kind: e.kind, isHot })
  })

  const colorOf = (kind: EdgeKind, isHot: boolean) =>
    isHot ? pal.hot : kind === 'handoff' ? pal.handoff : kind === 'write' ? pal.write : kind === 'read' ? pal.read : pal.dep
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < cols; x++) {
      const p = paint[y * cols + x]!
      if (!p.dirs) continue
      const kind = PRIORITY.find(k => p.kinds.has(k))!
      const only = p.kinds.size === 1
      const straightH = p.dirs === (L | R) || p.dirs === L || p.dirs === R
      const straightV = p.dirs === (U | D) || p.dirs === U || p.dirs === D
      let ch = LIGHT[p.dirs] ?? '┼'
      if (only && kind === 'handoff') ch = DOUBLE[p.dirs] ?? ch
      else if (only && kind === 'read' && straightH) ch = '┄'
      else if (only && kind === 'read' && straightV) ch = '┆'
      else if (only && kind === 'dep' && straightV && x !== bar) ch = '╎'
      else if (only && kind === 'dep' && straightH) ch = '╌'
      g.set(x, y, ch, x === bar && only && kind === 'dep' ? pal.store : colorOf(kind, p.isHot))
    }
  }
  for (const a of arrows) g.set(a.x, a.y, a.ch, colorOf(a.kind, a.isHot))

  // Labels.
  g.text(G, 0, 'AGENTS', pal.dim)
  g.text(bar, 0, '◈ SHARED CONTEXT', pal.store, cols - bar)
  agents.forEach(id => {
    const s = t.subtasks.find(x => x.id === id)
    const y = rowOfAgent(id)
    const color = s ? stateColor(s, pal) : pal.dim
    g.set(G, y, s ? '●' : '○', color)
    const name = s ? `${s.id} ${s.model}` : id
    g.text(G + 2, y, name, id === opts.selected ? pal.hot : pal.text, A - 3)
  })
  artifacts.forEach(id => {
    const y = rowOfArtifact(id)
    const a = t.artifacts[id]
    const label = id === GROUP ? `+${grouped} older` : `${a?.title ?? id} v${a?.versions.length ?? '?'}`
    g.set(bar + 1, y, '◆', id === GROUP ? pal.dim : pal.store)
    g.text(bar + 3, y, label, id === GROUP ? pal.dim : pal.text, artW - 1)
  })
  return { grid: g, agents, artifacts, grouped, edges }
}

const firstSeen = (t: Task, id: string) => t.events.find(e => e.artifact === id)?.at ?? 0

export const stateColor = (s: Subtask, pal: Palette) =>
  s.state === 'completed' ? pal.done : s.state === 'running' ? pal.running : s.state === 'failed' || s.state === 'cancelled' ? pal.failed : pal.queued

// The narrow fallback: one line per edge.
export const edgeLines = (t: Task) =>
  edgesOf(t)
    .filter(e => e.kind !== 'dep')
    .sort((a, b) => b.lastAt - a.lastAt)
    .map(e => {
      const sym = e.kind === 'read' ? '┄R▶' : e.kind === 'write' ? '─W▶' : '═H▶'
      const name = (id: string) => (t.artifacts[id] ? `◆ ${t.artifacts[id]!.title}` : id)
      return `${name(e.from)} ${sym} ${name(e.to)}${e.count > 1 ? ` ×${e.count}` : ''}`
    })
