// Orchestration as pure state transitions; register.tsx performs the real
// spawns and stops these decide on.

import type { Config, Pilot, Subtask, Task } from '../types'
import { retarget } from './progress'
import { bundleFor, pushEvent, writeArtifact } from './store'

export const TOOL = {
  list: 'mcp__model-pilot__list_artifacts',
  read: 'mcp__model-pilot__read_artifact',
  write: 'mcp__model-pilot__write_artifact',
  progress: 'mcp__model-pilot__report_progress',
} as const

export const WORKER = 'model-pilot:worker'

export const mapSub = (t: Task, id: string, fn: (s: Subtask) => Subtask): Task => ({
  ...t,
  subtasks: t.subtasks.map(s => (s.id === id ? fn(s) : s)),
})

export const running = (p: Pilot) => p.tasks.flatMap(t => t.subtasks).filter(s => s.state === 'running' && !s.isObserved).length

// The subtasks to start now: ready ones, within the parallel limit (across
// tasks) and the task's agent limit. A budget overrun starts nothing.
export const toLaunch = (p: Pilot, t: Task, spentUsd: number | undefined): { launch: Subtask[]; budgetBlocked: boolean } => {
  if (t.state !== 'running') return { launch: [], budgetBlocked: false }
  const c = p.config
  if (c.budgetUsd !== undefined && spentUsd !== undefined && spentUsd >= c.budgetUsd) return { launch: [], budgetBlocked: true }
  if (c.mode === 'budget-aware' && c.budgetUsd !== undefined && spentUsd === undefined) return { launch: [], budgetBlocked: true }
  const started = t.subtasks.filter(s => s.agentId).length
  const room = Math.min(c.maxParallel - running(p), c.maxAgents - started)
  return { launch: t.subtasks.filter(s => s.state === 'ready').slice(0, Math.max(0, room)), budgetBlocked: false }
}

// Task-specific context: the spec and the outputs of its own dependencies,
// passed as references. The agent reads what it needs.
export const bundleIds = (t: Task, s: Subtask) => ['task-spec', ...s.deps.map(d => t.subtasks.find(x => x.id === d)?.outputArtifact).filter((x): x is string => Boolean(x))]

export const workerPrompt = (t: Task, s: Subtask) => {
  const refs = bundleFor(t, bundleIds(t, s))
  return [
    `You are a ModelPilot worker running subtask ${s.id} of the task "${t.title}".`,
    '',
    `Objective: ${s.objective}`,
    'Acceptance criteria:',
    ...s.acceptance.map(a => `- ${a}`),
    '',
    'Shared context store. These artifacts are NOT in your context; read only the ones you need:',
    ...refs.map(r => `- ${r.id}: "${r.title}" (${r.type}, v${r.version}, ~${r.tokensEst} tokens est.)`),
    '',
    `Read one with ${TOOL.read} {"id": "<id>"}. Record a finding other agents may need with ${TOOL.write}.`,
    `At real milestones call ${TOOL.progress} with an honest percent and a short note. Do not report progress you have not made.`,
    'Do not modify files. Your final answer becomes this subtask\'s output artifact for the agents that depend on it, so make it complete and self-contained.',
  ].join('\n')
}

export const WORKER_SYSTEM = [
  'You are a focused worker inside ModelPilot, an orchestrator running in Claude Code.',
  'You work on one subtask. You may read repository files with Read, and you share knowledge only through the ModelPilot artifact tools.',
  'Be concise and factual; say plainly what you could not verify.',
].join(' ')

// An agent's loop ended. On an answer the subtask completes, its answer is
// stored as its output artifact (authored by it), and each dependent whose
// prerequisites are all done is unblocked with a handoff of that artifact.
export const finishSubtask = (
  t: Task,
  subtaskId: string,
  outcome: { reason: 'answer' | 'aborted' | 'refusal' | 'error'; answer: string; usage?: Subtask['usage']; durationMs?: number },
  at: number,
  maxBytes: number,
): Task => {
  const s = t.subtasks.find(x => x.id === subtaskId)
  if (!s || s.state !== 'running') return t
  if (outcome.reason !== 'answer') {
    const state = outcome.reason === 'aborted' ? 'cancelled' : 'failed'
    let next = mapSub(t, s.id, x => retarget(x, { state, endedAt: at, usage: outcome.usage ?? x.usage, error: outcome.reason === 'refusal' ? 'the model refused' : outcome.reason === 'aborted' ? 'stopped' : 'the agent ended with an error' }, at))
    next = pushEvent(next, { at, type: state === 'cancelled' ? 'agent_cancelled' : 'agent_failed', agent: s.id, reason: `${s.id} ${state} (${outcome.reason})` })
    return blockDependents(next, s.id, at)
  }
  let next = writeArtifact(t, { id: `out-${s.id}`, title: `${s.id} output`, type: 'output', content: outcome.answer || '(empty answer)', author: s.id, tags: ['output'], maxBytes, reason: `${s.id}'s final answer` }, at).task
  next = mapSub(next, s.id, x => retarget(x, { state: 'completed', endedAt: at, usage: outcome.usage ?? x.usage, outputArtifact: `out-${s.id}`, activity: 'done' }, at))
  next = pushEvent(next, { at, type: 'agent_completed', agent: s.id, reason: `${s.id} completed on ${s.resolvedModel ?? s.model}${outcome.durationMs ? ` in ${Math.round(outcome.durationMs / 1000)}s` : ''}` })
  for (const d of next.subtasks.filter(x => x.deps.includes(s.id))) {
    next = pushEvent(next, { at, type: 'handoff_created', agent: s.id, from: s.id, to: d.id, artifact: `out-${s.id}`, reason: `${s.id}'s output passed to ${d.id}` })
    const isReady = d.deps.every(id => next.subtasks.find(x => x.id === id)?.state === 'completed')
    if (isReady && d.state === 'queued') {
      next = mapSub(next, d.id, x => ({ ...x, state: 'ready', blockedReason: undefined }))
      next = pushEvent(next, { at, type: 'dependency_unblocked', agent: d.id, from: s.id, to: d.id, reason: `${d.id} unblocked: all of ${d.deps.join(', ')} completed` })
    }
  }
  return settle(next, at)
}

// A subtask that never started (its spawn was refused): failed, and its
// dependents blocked, exactly as if its agent had failed.
export const failToStart = (t: Task, id: string, error: string, at: number): Task => {
  let next = mapSub(t, id, x => retarget(x, { state: 'failed', endedAt: at, error }, at))
  next = pushEvent(next, { at, type: 'agent_failed', agent: id, reason: `${id} could not start: ${error}` })
  return blockDependents(next, id, at)
}

// Dependents of a failed or cancelled subtask cannot run.
const blockDependents = (t: Task, failedId: string, at: number): Task => {
  let next = t
  const queue = [failedId]
  while (queue.length) {
    const id = queue.shift()!
    for (const d of next.subtasks.filter(x => x.deps.includes(id) && (x.state === 'queued' || x.state === 'ready'))) {
      next = mapSub(next, d.id, x => ({ ...x, state: 'blocked', blockedReason: `needs ${id}, which did not complete` }))
      queue.push(d.id)
    }
  }
  return settle(next, at)
}

// The task's own state once its subtasks have settled.
export const settle = (t: Task, at: number): Task => {
  if (t.state !== 'running' || t.isObserved) return t
  const subs = t.subtasks
  if (subs.some(s => s.state === 'running' || s.state === 'ready')) return t
  if (subs.every(s => s.state === 'completed')) return { ...t, state: 'completed', endedAt: at }
  const isCancelled = subs.some(s => s.state === 'cancelled')
  return { ...t, state: isCancelled ? 'cancelled' : 'failed', endedAt: at }
}

// A retry puts a failed, cancelled or blocked subtask back to ready (and its
// blocked dependents back to queued), optionally on another model.
export const retry = (t: Task, id: string, model: string | undefined, at: number): Task => {
  const s = t.subtasks.find(x => x.id === id)
  if (!s || !['failed', 'cancelled', 'blocked'].includes(s.state)) return t
  const depsDone = s.deps.every(d => t.subtasks.find(x => x.id === d)?.state === 'completed')
  let next = mapSub(t, id, x => retarget(x, { state: depsDone ? 'ready' : 'queued', agentId: undefined, error: undefined, blockedReason: undefined, progress: undefined, endedAt: undefined, model: model ?? x.model, modelReason: model ? 'chosen at retry' : x.modelReason }, at))
  next = { ...next, subtasks: next.subtasks.map(x => (x.state === 'blocked' && x.blockedReason?.includes(id) ? { ...x, state: 'queued', blockedReason: undefined } : x)), state: 'running', endedAt: undefined }
  return pushEvent(next, { at, type: 'router_decision', agent: 'router', reason: `retry ${id}${model ? ` on ${model}` : ''}` })
}

export const configLine = (c: Config) =>
  `mode ${c.mode} · max ${c.maxAgents} agents · ${c.maxParallel} parallel · budget ${c.budgetUsd === undefined ? 'none' : `$${c.budgetUsd}`}${c.pin ? ` · pinned ${c.pin}` : ''} · motion ${c.isAnimated ? 'on' : 'off'}`
