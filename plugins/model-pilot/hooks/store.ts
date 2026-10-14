// The shared context store: compact, versioned artifacts that agents read
// and write explicitly through ModelPilot's tools. It is not a shared model
// context: an agent sees an artifact's text only after it reads it, and that
// text is then in (and billed as part of) that agent's own prompt.

import type { Artifact, EventType, PilotEvent, Task } from '../types'

export const MAX_EVENTS = 400

// FNV-1a, 32-bit: a stable content hash for deduplication, not security.
export const hash = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// A rough count, labelled as such wherever it is shown.
export const tokensEst = (s: string) => Math.ceil(s.length / 4)

const SECRET: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[redacted]'],
  [/\b(sk|pk|rk|ghp|gho|ghs|glpat|xox[abpr])[-_][A-Za-z0-9_-]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*\S+/g, '$1=[redacted]'],
  [/((?:set-)?cookie|authorization)\s*[:=]\s*[^\n]+/gi, '$1: [redacted]'],
  [/("(?:password|passwd|secret|token|api[-_]?key|cookie)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"'],
]

export const redact = (s: string) => SECRET.reduce((out, [re, to]) => out.replace(re, to), s)

export const pushEvent = (t: Task, e: Omit<PilotEvent, 'id' | 'at'> & { at: number }): Task => {
  const seq = t.seq + 1
  const ev: PilotEvent = { ...e, id: `${t.id}-e${seq}`, reason: redact(e.reason).slice(0, 300) }
  const events = [...t.events, ev]
  return { ...t, seq, events: events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events }
}

export type WriteResult = { task: Task; artifact: Artifact; status: 'created' | 'updated' | 'unchanged' | 'stale'; latest: number }

// Write an artifact as `author`. Content is redacted and bounded before it is
// stored. The same hash as the latest version is a no-op (deduplicated). A
// write whose `baseVersion` is older than the latest is refused as stale.
export const writeArtifact = (
  t: Task,
  args: { id?: string; title: string; type: Artifact['type']; content: string; author: string; baseVersion?: number; tags?: string[]; maxBytes: number; reason: string },
  at: number,
): WriteResult => {
  let content = redact(args.content)
  const isTruncated = content.length > args.maxBytes
  if (isTruncated) content = `${content.slice(0, args.maxBytes)}\n… [truncated at ${args.maxBytes} bytes]`
  const h = hash(content)
  const id = args.id && t.artifacts[args.id] ? args.id : args.id ?? newId(t, args.title)
  const prev = t.artifacts[id]
  if (prev) {
    const latest = prev.versions[prev.versions.length - 1]!
    if (args.baseVersion !== undefined && args.baseVersion < latest.v) {
      return { task: pushEvent(t, { at, type: 'artifact_updated', agent: args.author, from: args.author, artifact: id, version: latest.v, isStale: true, reason: `refused: written over v${args.baseVersion}, latest is v${latest.v}` }), artifact: prev, status: 'stale', latest: latest.v }
    }
    if (latest.hash === h) return { task: t, artifact: prev, status: 'unchanged', latest: latest.v }
    const v = { v: latest.v + 1, hash: h, at, author: args.author, bytes: content.length, tokensEst: tokensEst(content) }
    const artifact: Artifact = { ...prev, title: args.title || prev.title, content, isTruncated, versions: [...prev.versions, v] }
    const next = { ...t, artifacts: { ...t.artifacts, [id]: artifact } }
    return { task: pushEvent(next, { at, type: 'artifact_updated', agent: args.author, from: args.author, artifact: id, version: v.v, reason: args.reason }), artifact, status: 'updated', latest: v.v }
  }
  // A new artifact with exactly the content of an existing one is the same
  // artifact: the write returns that one (deduplicated by hash).
  const same = Object.values(t.artifacts).find(a => a.versions[a.versions.length - 1]!.hash === h)
  if (same) return { task: t, artifact: same, status: 'unchanged', latest: same.versions[same.versions.length - 1]!.v }
  const artifact: Artifact = {
    id,
    type: args.type,
    title: args.title.slice(0, 80),
    content,
    isTruncated,
    tags: args.tags ?? [],
    versions: [{ v: 1, hash: h, at, author: args.author, bytes: content.length, tokensEst: tokensEst(content) }],
  }
  const next = { ...t, artifacts: { ...t.artifacts, [id]: artifact } }
  return { task: pushEvent(next, { at, type: 'artifact_created', agent: args.author, from: args.author, artifact: id, version: 1, reason: args.reason }), artifact, status: 'created', latest: 1 }
}

const newId = (t: Task, title: string) => {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'artifact'
  let id = slug
  for (let i = 2; t.artifacts[id]; i++) id = `${slug}-${i}`
  return id
}

// A read by `reader`: recorded only when an agent actually asked for it.
// Stale when the reader names a version older than the latest.
export const readArtifact = (t: Task, id: string, reader: string, at: number, version?: number) => {
  const a = t.artifacts[id]
  if (!a) return { task: t, artifact: undefined }
  const latest = a.versions[a.versions.length - 1]!.v
  const isStale = version !== undefined && version < latest
  const task = pushEvent(t, { at, type: 'artifact_read', agent: reader, to: reader, artifact: id, version: latest, isStale, reason: isStale ? `asked for v${version}, latest is v${latest}` : `read v${latest}` })
  return { task, artifact: a, latest, isStale }
}

// The references an agent is handed: ids, titles, versions and sizes only.
export const bundleFor = (t: Task, ids: string[]) =>
  ids
    .map(id => t.artifacts[id])
    .filter((a): a is Artifact => Boolean(a))
    .map(a => {
      const v = a.versions[a.versions.length - 1]!
      return { id: a.id, title: a.title, type: a.type, version: v.v, hash: v.hash, tokensEst: v.tokensEst }
    })

export type EventFilter = 'all' | 'failures' | 'context' | 'agent'

const CONTEXT: EventType[] = ['artifact_created', 'artifact_updated', 'artifact_read', 'artifact_shared', 'handoff_created', 'handoff_received']
const FAILS: EventType[] = ['agent_failed', 'agent_cancelled', 'budget_alert', 'error']

export const filterEvents = (events: PilotEvent[], f: EventFilter, agent?: string) =>
  events.filter(e =>
    f === 'all'
      ? true
      : f === 'failures'
        ? FAILS.includes(e.type) || e.isStale
        : f === 'context'
          ? CONTEXT.includes(e.type)
          : e.agent === agent || e.from === agent || e.to === agent,
  )
