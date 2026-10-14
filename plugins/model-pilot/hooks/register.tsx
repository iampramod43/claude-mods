import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Config, Pilot, Task, View } from '../types'
import { bundleIds, configLine, failToStart, finishSubtask, mapSub, retry, settle, TOOL, toLaunch, WORKER, WORKER_SYSTEM, workerPrompt } from './orchestrate'
import { drawPane } from './pane'
import { isAnimating, retarget } from './progress'
import { aliasOf, buildRegistry, classify, isSupported, plan, SCHEMA_MODELS } from './router'
import { pushEvent, readArtifact, redact, writeArtifact } from './store'
import { HOT_MS } from './graph'

const PANE = 'model-pilot'
const TITLE = 'ModelPilot'
const MAX_TASKS = 8

const DEFAULT_CONFIG: Config = { mode: 'recommend', maxAgents: 3, maxParallel: 3, isAnimated: true, maxArtifactBytes: 50_000 }

export const emptyPilot = (): Pilot => ({ tasks: [], agents: {}, registry: buildRegistry(undefined, undefined), config: DEFAULT_CONFIG, seq: 0 })
export const emptyView = (): View => ({ panel: 'overview', isDetailOpen: false, feedFilter: 'all', isHelpOpen: false })

const pilot = atom({ plugin: 'model-pilot', key: 'pilot' } as const, emptyPilot())
const view = atom({ plugin: 'model-pilot', key: 'view' } as const, emptyView())
const tick = atom({ plugin: 'model-pilot', key: 'tick' } as const, 0)
const isLight = atom({ plugin: 'model-pilot', key: 'isLight' } as const, false)

const setTask = (p: Pilot, id: string, fn: (t: Task) => Task): Pilot => ({ ...p, tasks: p.tasks.map(t => (t.id === id ? fn(t) : t)) })

const spentSince = async ($: EngineInterface, t: Task) => {
  try {
    const usd = (await $.session.usage()).cost?.usd
    return usd === undefined || t.costAtStart === undefined ? undefined : usd - t.costAtStart
  } catch {
    return undefined
  }
}

const costNow = async ($: EngineInterface) => {
  try {
    return (await $.session.usage()).cost?.usd
  } catch {
    return undefined
  }
}

// Start every subtask that may start now, for real, through $.agent.spawn.
const launch = async ($: EngineInterface, taskId: string) => {
  const p = await read($, pilot)
  const t = p.tasks.find(x => x.id === taskId)
  if (!t) return
  const spent = await spentSince($, t)
  const { launch: subs, budgetBlocked } = toLaunch(p, t, spent)
  const now = await $.clock.now()
  if (budgetBlocked) {
    const already = t.events.some(e => e.type === 'budget_alert' && now - e.at < 60_000)
    if (!already)
      await update($, pilot, q =>
        setTask(q, taskId, x =>
          pushEvent(x, {
            at: now,
            type: 'budget_alert',
            agent: 'router',
            reason:
              spent === undefined
                ? 'budget-aware: session cost is not reported, so no agent is started'
                : `budget reached: $${spent.toFixed(2)} of $${q.config.budgetUsd} spent since the task started; no new agents`,
          }),
        ),
      )
    return
  }
  for (const s of subs) {
    const at = await $.clock.now()
    // Mark it running first, so a second launch pass cannot start it twice.
    await update($, pilot, q => setTask(q, taskId, x => mapSub(x, s.id, y => retarget(y, { state: 'running', startedAt: at, activity: 'starting' }, at))))
    const cur = (await read($, pilot)).tasks.find(x => x.id === taskId)!
    const sub = cur.subtasks.find(x => x.id === s.id)!
    let res
    try {
      res = await $.agent.spawn({ prompt: workerPrompt(cur, sub), description: `ModelPilot ${s.id}: ${s.title}`.slice(0, 60), subagentType: WORKER, model: s.model })
    } catch (err) {
      res = { deny: err instanceof Error ? err.message : String(err) }
    }
    const done = await $.clock.now()
    await update($, pilot, q => {
      let next = q
      if (res.deny !== undefined || !res.agentId) {
        const why = res.deny !== undefined ? redact(res.deny) : `no agent id in ${JSON.stringify(res).slice(0, 120)}`
        next = setTask(next, taskId, x => failToStart(x, s.id, why, done))
        return next
      }
      next = { ...next, agents: { ...next.agents, [res.agentId]: { taskId, subtaskId: s.id } } }
      next = { ...next, registry: next.registry.map(m => (m.alias === aliasOf(res.model) && !m.ids.includes(res.model) ? { ...m, ids: [...m.ids, res.model] } : m)) }
      return setTask(next, taskId, x => {
        let y = mapSub(x, s.id, z => ({ ...z, agentId: res.agentId, resolvedModel: res.model, activity: 'started' }))
        y = pushEvent(y, { at: done, type: 'agent_started', agent: s.id, reason: `${s.id} started on ${res.model} (${s.modelReason})` })
        // References delivered in its prompt: shared, not read.
        for (const id of bundleIds(y, sub)) {
          const handed = y.events.find(e => e.type === 'handoff_created' && e.to === s.id && e.artifact === id)
          y = pushEvent(y, handed
            ? { at: done, type: 'handoff_received', agent: s.id, from: handed.from, to: s.id, artifact: id, reason: `${s.id} was handed ${id} (as a reference)` }
            : { at: done, type: 'artifact_shared', agent: s.id, to: s.id, artifact: id, reason: `reference to ${id} in ${s.id}'s prompt` })
        }
        return y
      })
    })
  }
}

const findCaller = (p: Pilot, agentId: string | undefined) => {
  if (agentId && p.agents[agentId]) return p.agents[agentId]
  return undefined
}

// The task an artifact tool call works on: the caller's, else the active one.
const taskFor = (p: Pilot, agentId: string | undefined) => {
  const c = findCaller(p, agentId)
  return { taskId: c?.taskId ?? p.activeTaskId, author: c?.subtaskId ?? (agentId ? `agent:${agentId.slice(0, 6)}` : 'main') }
}

const shortArg = (e: Record<string, unknown>) => {
  const v = e.file_path ?? e.path ?? e.url ?? e.query ?? e.command ?? e.id ?? e.description
  if (typeof v !== 'string') return ''
  return redact(v.replace(/^.*\/(?=[^/]+$)/, '')).slice(0, 40)
}

const help = [
  'Usage: /model-pilot [plan <task> | approve | cancel [id] | retry <id> [model] | models',
  '        | mode auto|recommend|single-model|budget-aware | pin <model>|off',
  '        | max-agents N | parallel N | budget <usd>|off | motion on|off]',
  'Write independent parts with `;` and ordered steps with `then`, e.g.',
  '  /model-pilot plan Review the mods: review burn-meter; review file-trail; review browser-trail',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    let sessionModel: string | undefined
    let window: number | undefined
    try {
      sessionModel = await $.session.model()
      window = (await $.session.usage()).context.window
    } catch {}
    await update($, pilot, p => ({ ...emptyPilot(), ...p, config: { ...DEFAULT_CONFIG, ...p.config }, sessionModel, registry: buildRegistry(sessionModel, window, p.registry) }))
    await update($, view, v => ({ ...emptyView(), ...v }))
    try {
      const row = (await $.config.list()).find(r => r.key === 'theme')
      await update($, isLight, () => typeof row?.value === 'string' && /light/i.test(row.value))
    } catch {}
    await $.command.register({ name: 'model-pilot', description: 'Route a task to a model or a team of subagents and watch it live; `plan <task>` to start', argumentHint: '[plan <task>|approve|cancel|retry|models|mode|pin|budget|motion]' })
    await $.tool.register({
      name: 'list_artifacts',
      description: 'ModelPilot: list the artifacts in the shared context store of your task (ids, titles, versions, sizes). Lists only; read one with read_artifact.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'read_artifact',
      description: 'ModelPilot: read one artifact from the shared context store by id. Returns its latest version and content.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'number', description: 'the version you last saw, to detect staleness' } }, required: ['id'] },
    })
    await $.tool.register({
      name: 'write_artifact',
      description: 'ModelPilot: create or update an artifact in the shared context store, for other agents. Content is redacted and size-limited. Pass base_version when updating one you read.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          type: { type: 'string', enum: ['finding', 'decision', 'note'] },
          content: { type: 'string' },
          base_version: { type: 'number' },
        },
        required: ['title', 'content'],
      },
    })
    await $.tool.register({
      name: 'report_progress',
      description: 'ModelPilot: report honest progress on your subtask at a real milestone (0-100) with a short note.',
      inputSchema: { type: 'object', properties: { percent: { type: 'number' }, note: { type: 'string' } }, required: ['percent'] },
    })
    try {
      await $.agent.register({
        name: 'worker',
        description: 'ModelPilot worker (spawned by ModelPilot only).',
        prompt: WORKER_SYSTEM,
        tools: ['Read', TOOL.list, TOOL.read, TOOL.write, TOOL.progress],
      })
    } catch {}
    // Redraw while a bar animates or an edge is lit; poll agent status while
    // agents run, in case a loop ends without a turn.complete.
    let beat = 0
    $.clock.every(150, () => {
      void (async () => {
        beat++
        const p = await read($, pilot)
        const now = await $.clock.now()
        const t = p.tasks.find(x => x.id === p.activeTaskId)
        const isLit = t?.events.some(ev => now - ev.at < HOT_MS)
        if (t && ((p.config.isAnimated && isAnimating(t.subtasks, now)) || isLit)) await update($, tick, n => n + 1)
        else if (beat % 7 === 0 && p.tasks.some(x => x.state === 'running')) await update($, tick, n => n + 1)
        if (beat % 20 === 0 && p.tasks.some(x => x.state === 'running')) await reconcile($)
      })()
    })
    return started
  })

  // The worker type is ModelPilot's own: the model is not offered it.
  on('agent.offer', { agent: WORKER }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  on('command.run', { command: 'model-pilot' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const now = await $.clock.now()
    const p = await read($, pilot)
    const setConfig = async (c: Partial<Config>, text: string) => {
      await update($, pilot, q => ({ ...q, config: { ...q.config, ...c } }))
      return { text: `${text}\n${configLine({ ...p.config, ...c })}` }
    }
    switch (verb) {
      case '':
        await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: 120 })
        return { text: `ModelPilot opened. ${configLine(p.config)}` }
      case 'plan': {
        if (!arg) return { text: help }
        const text = redact(arg)
        const pl = plan(text, p.config, p.registry, now)
        const id = `t${p.seq + 1}`
        let t: Task = {
          id,
          title: pl.title || text.slice(0, 60),
          text,
          createdAt: now,
          state: pl.decision.refused ? 'failed' : pl.decision.strategy === 'direct' ? 'direct' : p.config.mode === 'auto' ? 'running' : 'awaiting-approval',
          classification: classify(text),
          decision: pl.decision,
          subtasks: pl.subtasks,
          artifacts: {},
          events: [],
          seq: 0,
          costAtStart: await costNow($),
        }
        if (pl.subtasks.length) {
          t = writeArtifact(t, {
            id: 'task-spec',
            title: 'Task spec',
            type: 'spec',
            content: [`Task: ${text}`, '', 'Subtasks:', ...pl.subtasks.map(s => `- ${s.id} ${s.title}${s.deps.length ? ` (after ${s.deps.join(', ')})` : ''}: ${s.objective}`)].join('\n'),
            author: 'router',
            maxBytes: p.config.maxArtifactBytes,
            reason: 'the router wrote the task spec',
          }, now).task
        }
        t = pushEvent(t, { at: now, type: 'router_decision', agent: 'router', reason: pl.decision.refused ?? `${pl.decision.strategy}: ${pl.decision.rationale[0] ?? ''}` })
        await update($, pilot, q => ({ ...q, seq: q.seq + 1, activeTaskId: id, tasks: [...q.tasks, t].slice(-MAX_TASKS) }))
        await update($, view, v => ({ ...v, panel: 'overview' as const, selected: undefined, isDetailOpen: false }))
        void $.ui.open({ id: PANE, title: TITLE, columns: 120 }).catch(() => undefined)
        if (t.state === 'running') {
          await update($, pilot, q => setTask(q, id, x => pushEvent(x, { at: now, type: 'task_approved', agent: 'router', reason: 'auto mode: started without asking' })))
          $.clock.after(0, () => void launch($, id))
        }
        return { text: describe(t) }
      }
      case 'approve':
      case 'go':
        return { text: await approveTask($, arg || undefined) }
      case 'cancel':
        return { text: await cancelTask($, arg || undefined) }
      case 'retry': {
        const [id, model] = rest
        const t = p.tasks.find(x => x.id === p.activeTaskId)
        if (!t || !id) return { text: 'Usage: /model-pilot retry <subtask id> [model]' }
        if (model && !isSupported(model)) return { text: `"${model}" is not a model this Claude Code build can invoke (${SCHEMA_MODELS.join(', ')}).` }
        await update($, pilot, q => setTask(q, t.id, x => retry(x, id, model ? aliasOf(model) : undefined, now)))
        void launch($, t.id)
        return { text: `Retrying ${id}${model ? ` on ${model}` : ''}.` }
      }
      case 'models':
        return { text: modelsText(p) }
      case 'mode':
        if (!['auto', 'recommend', 'single-model', 'budget-aware'].includes(arg)) return { text: 'Usage: /model-pilot mode auto|recommend|single-model|budget-aware' }
        return setConfig({ mode: arg as Config['mode'] }, `Mode set to ${arg}.`)
      case 'pin':
        if (arg === 'off' || arg === '') return setConfig({ pin: undefined }, 'Model pin removed.')
        if (!isSupported(arg)) return { text: `"${arg}" is not a model this Claude Code build can invoke (${SCHEMA_MODELS.join(', ')}).` }
        return setConfig({ pin: aliasOf(arg) }, `Pinned to ${aliasOf(arg)}.`)
      case 'max-agents':
      case 'parallel': {
        const n = Number(arg)
        if (!Number.isInteger(n) || n < 1 || n > 8) return { text: `Usage: /model-pilot ${verb} <1-8>` }
        return setConfig(verb === 'parallel' ? { maxParallel: n } : { maxAgents: n }, `${verb} set to ${n}.`)
      }
      case 'budget': {
        if (arg === 'off') return setConfig({ budgetUsd: undefined }, 'Budget removed.')
        const n = Number(arg)
        if (!(n > 0)) return { text: 'Usage: /model-pilot budget <usd>|off' }
        return setConfig({ budgetUsd: n }, `Budget set to $${n}, checked against the session cost Claude Code reports.`)
      }
      case 'motion':
        return setConfig({ isAnimated: arg !== 'off' }, `Animation ${arg === 'off' ? 'off' : 'on'}.`)
      default:
        return { text: help }
    }
  })

  // ModelPilot's own tools: the shared context store and progress reports.
  on('tool.call', { tool: TOOL.list }, async ($, e) => {
    const p = await read($, pilot)
    const { taskId } = taskFor(p, e.agentId)
    const t = p.tasks.find(x => x.id === taskId)
    if (!t) return { result: 'No ModelPilot task is active.' }
    const rows = Object.values(t.artifacts).map(a => {
      const v = a.versions[a.versions.length - 1]!
      return `${a.id}\t"${a.title}"\t${a.type}\tv${v.v}\t~${v.tokensEst} tokens (est.)\tby ${v.author}`
    })
    return { result: rows.length ? rows.join('\n') : 'The store is empty.' }
  }).catch(() => ({ result: 'ModelPilot could not complete this call; nothing was stored.' }))

  on('tool.call', { tool: TOOL.read }, async ($, e) => {
    const id = String((e as { id?: unknown }).id ?? '')
    const version = typeof (e as { version?: unknown }).version === 'number' ? ((e as { version?: number }).version) : undefined
    const now = await $.clock.now()
    let out = ''
    await update($, pilot, p => {
      const { taskId, author } = taskFor(p, e.agentId)
      const t = p.tasks.find(x => x.id === taskId)
      if (!t) {
        out = 'No ModelPilot task is active.'
        return p
      }
      const r = readArtifact(t, id, author, now, version)
      if (!r.artifact) {
        out = `No artifact "${id}". Use list_artifacts.`
        return p
      }
      out = `${r.artifact.title} (v${r.latest}${r.isStale ? `; you asked for v${version}: this is newer` : ''})\n\n${r.artifact.content}`
      return setTask(p, t.id, () => r.task)
    })
    return { result: out }
  }).catch(() => ({ result: 'ModelPilot could not complete this call; nothing was stored.' }))

  on('tool.call', { tool: TOOL.write }, async ($, e) => {
    const a = e as { id?: unknown; title?: unknown; type?: unknown; content?: unknown; base_version?: unknown }
    const now = await $.clock.now()
    let out = ''
    await update($, pilot, p => {
      const { taskId, author } = taskFor(p, e.agentId)
      const t = p.tasks.find(x => x.id === taskId)
      if (!t) {
        out = 'No ModelPilot task is active.'
        return p
      }
      const type = a.type === 'decision' || a.type === 'note' ? a.type : 'finding'
      const r = writeArtifact(t, {
        id: typeof a.id === 'string' && a.id ? a.id : undefined,
        title: String(a.title ?? 'untitled'),
        type,
        content: String(a.content ?? ''),
        author,
        baseVersion: typeof a.base_version === 'number' ? a.base_version : undefined,
        maxBytes: p.config.maxArtifactBytes,
        reason: `${author} wrote "${String(a.title ?? '')}"`,
      }, now)
      out =
        r.status === 'stale'
          ? `Not written: ${r.artifact.id} is at v${r.latest}, newer than your base_version. Read it again first.`
          : r.status === 'unchanged'
            ? `Unchanged: identical content is already stored as ${r.artifact.id} v${r.latest} (deduplicated by hash).`
            : `${r.status === 'created' ? 'Created' : 'Updated'} ${r.artifact.id} v${r.latest}.`
      return setTask(p, t.id, () => r.task)
    })
    return { result: out }
  }).catch(() => ({ result: 'ModelPilot could not complete this call; nothing was stored.' }))

  on('tool.call', { tool: TOOL.progress }, async ($, e) => {
    const a = e as { percent?: unknown; note?: unknown }
    const pct = Math.max(0, Math.min(100, Number(a.percent) || 0))
    const note = typeof a.note === 'string' ? redact(a.note).slice(0, 80) : undefined
    const now = await $.clock.now()
    const p = await read($, pilot)
    const c = findCaller(p, e.agentId)
    if (!c) return { result: 'Progress is recorded only for ModelPilot workers.' }
    await update($, pilot, q =>
      setTask(q, c.taskId, x =>
        pushEvent(mapSub(x, c.subtaskId, s => retarget(s, { progress: { pct, note, at: now }, activity: note ?? s.activity, activityAt: now }, now)), {
          at: now,
          type: 'progress_reported',
          agent: c.subtaskId,
          reason: `${c.subtaskId} reported ${pct}%${note ? `: ${note}` : ''}`,
        }),
      ),
    )
    return { result: `Recorded ${pct}%.` }
  }).catch(() => ({ result: 'ModelPilot could not complete this call; nothing was stored.' }))

  // Every other tool call inside a ModelPilot agent (or an observed one):
  // its current activity. Observes only.
  on('tool.call', async ($, e, next) => {
    if (!e.agentId || e.tool.startsWith('mcp__model-pilot__')) return next(e)
    const p = await read($, pilot)
    const c = findCaller(p, e.agentId)
    if (!c) return next(e)
    const now = await $.clock.now()
    const activity = `${e.tool} ${shortArg(e as unknown as Record<string, unknown>)}`.trim()
    await update($, pilot, q => setTask(q, c.taskId, x => mapSub(x, c.subtaskId, s => ({ ...s, activity, activityAt: now }))))
    return next(e)
  }).catch(($, e, next) => next(e))

  // An agent's loop ended: its answer, usage and duration are real.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) return r
    const p = await read($, pilot)
    const c = findCaller(p, e.agentId)
    if (!c) return r
    const now = await $.clock.now()
    const u = e.usage ?? r.usage
    const usage = u ? { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, model: u.model } : undefined
    await update($, pilot, q => {
      const t = q.tasks.find(x => x.id === c.taskId)
      const s = t?.subtasks.find(x => x.id === c.subtaskId)
      if (!t || !s) return q
      const alias = aliasOf(usage?.model ?? s.resolvedModel ?? s.model)
      const ok = e.reason === 'answer'
      const next1 = {
        ...q,
        registry: q.registry.map(m =>
          m.alias === alias
            ? { ...m, isVerified: m.isVerified || ok, runs: m.runs + 1, failures: m.failures + (ok ? 0 : 1), totalMs: m.totalMs + (e.durationMs ?? 0), ids: usage?.model && !m.ids.includes(usage.model) ? [...m.ids, usage.model] : m.ids }
            : m,
        ),
      }
      if (t.isObserved) {
        return setTask(next1, t.id, x =>
          pushEvent(mapSub(x, s.id, y => retarget(y, { state: ok ? 'completed' : e.reason === 'aborted' ? 'cancelled' : 'failed', endedAt: now, usage, activity: ok ? 'done' : e.reason }, now)), {
            at: now,
            type: ok ? 'agent_completed' : 'agent_failed',
            agent: s.id,
            reason: `${s.id} ${ok ? 'completed' : e.reason}`,
          }),
        )
      }
      return setTask(next1, t.id, x => finishSubtask(x, s.id, { reason: e.reason, answer: e.answer, usage, durationMs: e.durationMs }, now, q.config.maxArtifactBytes))
    })
    void launch($, c.taskId)
    return r
  }).catch(($, e, next) => next(e))

  // Agents the model spawns itself are observed in their own task, so they
  // never mix with a planned task.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (e.subagentType === WORKER || r.deny !== undefined || !r.agentId) return r
    const now = await $.clock.now()
    await update($, pilot, p => {
      let q = p
      let t = q.tasks.find(x => x.isObserved)
      if (!t) {
        t = {
          id: 'observed',
          title: 'Agents Claude started',
          text: '',
          createdAt: now,
          state: 'running',
          classification: classify(''),
          decision: { at: now, mode: q.config.mode, strategy: 'team', category: 'general', assignments: [], rationale: ['Observed: spawned by the model, not planned by ModelPilot.'], uncertainty: [], tradeoffs: [], fallback: '', isParallelWorthwhile: false },
          subtasks: [],
          artifacts: {},
          events: [],
          seq: 0,
          isObserved: true,
        }
        q = { ...q, tasks: [...q.tasks, t].slice(-MAX_TASKS), activeTaskId: q.activeTaskId ?? 'observed' }
      }
      const sid = `a${t.subtasks.length + 1}`
      q = { ...q, agents: { ...q.agents, [r.agentId!]: { taskId: 'observed', subtaskId: sid } } }
      return setTask(q, 'observed', x =>
        pushEvent(
          {
            ...x,
            state: 'running',
            subtasks: [
              ...x.subtasks,
              {
                id: sid,
                title: redact(e.description).slice(0, 60),
                objective: '',
                acceptance: [],
                model: aliasOf(r.model) ?? r.model,
                modelReason: e.model ? `the model asked for ${e.model}` : `inherited (${e.subagentType})`,
                deps: [],
                weight: 1,
                state: 'running',
                agentId: r.agentId,
                resolvedModel: r.model,
                startedAt: now,
                activity: e.subagentType,
                anim: { from: 0, at: now },
                isObserved: true,
              },
            ],
          },
          { at: now, type: 'agent_started', agent: sid, reason: `${sid} (${e.subagentType}) started on ${r.model}` },
        ),
      )
    })
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const p = await read($, pilot)
    const v = await read($, view)
    const n = await read($, tick)
    const props = e.props as { bodyColumns?: number; scroll?: { bodyRows?: number } }
    return drawPane(els, {
      p,
      v,
      now: await $.clock.now(),
      tick: n,
      cols: props.bodyColumns ?? e.viewport?.columns ?? 100,
      rows: props.scroll?.bodyRows ?? Math.max(12, (e.viewport?.rows ?? 30) - 6),
      isLight: await read($, isLight),
      isTerminal: e.surface === 'terminal',
      setView: fn => void update($, view, fn),
      setActive: id => void update($, pilot, q => ({ ...q, activeTaskId: id })),
      approve: () => void approveTask($).catch(() => undefined),
      cancel: id => void cancelTask($, id).catch(() => undefined),
      toggleMotion: () => void update($, pilot, q => ({ ...q, config: { ...q.config, isAnimated: !q.config.isAnimated } })),
      close: () => void $.ui.close({ id: PANE }).catch(() => undefined),
    })
  })
}

// Approval: the person's own command or key; nothing starts before it.
const approveTask = async ($: EngineInterface, id?: string) => {
  const p = await read($, pilot)
  const t = p.tasks.find(x => x.id === (id ?? p.activeTaskId))
  if (!t) return 'No task to approve. Start one with /model-pilot plan <task>.'
  if (t.state !== 'awaiting-approval') return `Task ${t.id} is ${t.state}; nothing to approve.`
  const now = await $.clock.now()
  await update($, pilot, q => setTask(q, t.id, x => pushEvent({ ...x, state: 'running', costAtStart: x.costAtStart }, { at: now, type: 'task_approved', agent: 'router', reason: 'approved by you' })))
  void launch($, t.id)
  return `Approved ${t.id}: starting up to ${Math.min(p.config.maxParallel, t.subtasks.filter(s => s.state === 'ready').length)} agent(s).`
}

// Cancel one subtask or the whole active task. Running agents are stopped
// with the TaskStop tool, through the normal permission check.
const cancelTask = async ($: EngineInterface, subId?: string) => {
  const p = await read($, pilot)
  const t = p.tasks.find(x => x.id === p.activeTaskId)
  if (!t) return 'No active task.'
  const targets = t.subtasks.filter(s => (subId ? s.id === subId : true) && ['running', 'ready', 'queued'].includes(s.state))
  const out: string[] = []
  for (const s of targets) {
    if (s.state === 'running' && s.agentId) {
      try {
        const r = await $.tool.call({ tool: 'TaskStop', task_id: s.agentId } as never)
        if ((r as { isError?: boolean; deny?: string }).isError || (r as { deny?: string }).deny) {
          out.push(`${s.id}: stop refused`)
          continue
        }
        out.push(`${s.id}: stopped`)
      } catch (err) {
        out.push(`${s.id}: stop failed (${err instanceof Error ? err.message : String(err)})`)
        continue
      }
    }
    const at = await $.clock.now()
    await update($, pilot, q =>
      setTask(q, t.id, x => settle(pushEvent(mapSub(x, s.id, y => retarget(y, { state: 'cancelled', endedAt: at, error: 'cancelled by you' }, at)), { at, type: 'agent_cancelled', agent: s.id, reason: `${s.id} cancelled by you` }), at)),
    )
  }
  const now = await $.clock.now()
  if (!subId) await update($, pilot, q => setTask(q, t.id, x => (x.state === 'awaiting-approval' ? { ...x, state: 'cancelled', endedAt: now } : settle(x, now))))
  return targets.length ? `Cancelled ${targets.map(s => s.id).join(', ')}${out.length ? ` (${out.join('; ')})` : ''}.` : 'Nothing to cancel.'
}

// An agent whose loop ended without a turn.complete reaching us.
const reconcile = async ($: EngineInterface) => {
  let list
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const now = await $.clock.now()
  const p = await read($, pilot)
  for (const a of list) {
    const c = p.agents[a.id]
    if (!c || !['failed', 'killed'].includes(a.status)) continue
    const s = p.tasks.find(t => t.id === c.taskId)?.subtasks.find(x => x.id === c.subtaskId)
    if (s?.state !== 'running') continue
    await update($, pilot, q =>
      setTask(q, c.taskId, x =>
        x.isObserved
          ? pushEvent(mapSub(x, s.id, y => retarget(y, { state: a.status === 'killed' ? 'cancelled' : 'failed', endedAt: now }, now)), { at: now, type: a.status === 'killed' ? 'agent_cancelled' : 'agent_failed', agent: s.id, reason: `${s.id} ${a.status} (agent list)` })
          : finishSubtask(x, s.id, { reason: a.status === 'killed' ? 'aborted' : 'error', answer: '' }, now, q.config.maxArtifactBytes),
      ),
    )
    void launch($, c.taskId)
  }
}

const describe = (t: Task) => {
  const d = t.decision
  if (d.refused) return `Not planned: ${d.refused}`
  const lines = [`${t.id} · ${t.title}`, `strategy: ${d.strategy} · category: ${d.category}`, ...d.rationale.map(r => `  ${r}`)]
  for (const a of d.assignments) lines.push(`  ${a.subtaskId} → ${a.model}: ${a.reason}`)
  if (t.state === 'awaiting-approval') lines.push('Approve with /model-pilot approve (or press a in the dashboard). Nothing has started.')
  if (t.state === 'direct') lines.push('No agents: handle it in this session.')
  return lines.join('\n')
}

const modelsText = (p: Pilot) =>
  [
    'Models this Claude Code build can invoke (Agent tool schema):',
    ...p.registry.map(
      m =>
        `  ${m.alias.padEnd(7)} tier ${m.tier ?? '—'} (${m.tierSource}) · context ${m.contextWindow ? `${m.contextWindow.toLocaleString()} (session)` : 'unknown'} · price unknown · ${m.isVerified ? `verified, ${m.runs} run(s)` : 'not run yet'}${m.isSessionDefault ? ' · session model' : ''}${m.ids.length ? ` · ids ${m.ids.join(', ')}` : ''}`,
    ),
    'Other providers (e.g. an OpenRouter key in settings) are not invoked: Claude Code has no subagent path to them.',
  ].join('\n')
