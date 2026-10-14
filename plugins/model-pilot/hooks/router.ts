// The router: a model registry built from what this Claude Code build can
// actually invoke, a deterministic task classifier, a planner that splits a
// task only along structure the person wrote, and the routing policy.
// Nothing here calls a model or spends anything.

import type { Classification, Config, Decision, ModelEntry, Strategy, Subtask, TaskType } from '../types'

// The models this build's Agent tool accepts (its `model` parameter's enum,
// read from the build's tool schema). The only ones ModelPilot invokes.
export const SCHEMA_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const PROVIDER = 'Anthropic, through Claude Code subagents'

// ModelPilot's routing tiers. A policy, not a provider fact: Anthropic
// positions Haiku as fast and light, Sonnet as balanced, Opus as the most
// capable. Fable has no tier here, so it is used only when pinned.
const POLICY_TIER: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 }

export const buildRegistry = (sessionModel: string | undefined, sessionWindow: number | undefined, old: ModelEntry[] = []): ModelEntry[] =>
  SCHEMA_MODELS.map(alias => {
    const prev = old.find(m => m.alias === alias)
    const isSession = Boolean(sessionModel && aliasOf(sessionModel) === alias)
    return {
      alias,
      provider: PROVIDER,
      ids: prev?.ids ?? (isSession && sessionModel ? [sessionModel] : []),
      tier: POLICY_TIER[alias],
      tierSource: POLICY_TIER[alias] ? 'policy' : 'unknown',
      contextWindow: isSession ? sessionWindow : undefined,
      contextSource: isSession && sessionWindow ? 'session' : 'unknown',
      isSessionDefault: isSession,
      isVerified: prev?.isVerified ?? false,
      runs: prev?.runs ?? 0,
      failures: prev?.failures ?? 0,
      totalMs: prev?.totalMs ?? 0,
    }
  })

// `claude-opus-5-5` → `opus`; an alias stays itself; anything else undefined.
export const aliasOf = (model: string) => SCHEMA_MODELS.find(a => model === a || model.includes(`-${a}`) || model.startsWith(`${a}-`))

export const isSupported = (model: string) => Boolean(aliasOf(model))

// ---- classification -------------------------------------------------------

const has = (text: string, re: RegExp) => re.test(text)

const TYPE_RULES: [TaskType, RegExp][] = [
  ['review', /\b(review|audit|critique|assess|evaluate)\b/i],
  ['coding', /\b(implement|code|refactor|fix|bug|function|test|build|compile|typescript|python)\b/i],
  ['research', /\b(research|investigate|find out|compare|survey|look up|explore)\b/i],
  ['summarization', /\b(summari[sz]e|tl;?dr|digest|condense|recap)\b/i],
  ['reasoning', /\b(prove|reason|analy[sz]e|why|plan|design|architect|trade-?offs?)\b/i],
  ['writing', /\b(write|draft|document|explain|describe|readme|docs?)\b/i],
]

// Parts of the task, as written: `;` or newlines split independent parts,
// `then` / `->` / `→` chain sequential ones. Nothing is split otherwise.
export type Part = { text: string; after?: number }

export const splitTask = (text: string): { title: string; parts: Part[] } => {
  const colon = text.indexOf(':')
  const hasTitle = colon > 0 && colon < 60 && /[;\n]|\bthen\b|->|→/.test(text.slice(colon + 1))
  const title = (hasTitle ? text.slice(0, colon) : text).trim().slice(0, 80)
  const body = hasTitle ? text.slice(colon + 1) : text
  const parts: Part[] = []
  for (const group of body.split(/[;\n]+/).map(s => s.trim()).filter(Boolean)) {
    const chain = group.split(/\s*(?:->|→|\bthen\b)\s*/i).map(s => s.trim()).filter(Boolean)
    chain.forEach((step, i) => parts.push({ text: step, after: i > 0 ? parts.length - 1 : undefined }))
  }
  return { title, parts: parts.length ? parts : [{ text: body.trim() }] }
}

export const classify = (text: string): Classification => {
  const signals: string[] = []
  const { parts } = splitTask(text)
  const type = TYPE_RULES.find(([, re]) => has(text, re))?.[0] ?? 'general'
  signals.push(type === 'general' ? 'type: no type keyword matched' : `type: keyword for ${type}`)
  const isSequential = parts.some(p => p.after !== undefined)
  const independent = parts.filter(p => p.after === undefined).length
  const shape = parts.length <= 1 ? 'single-step' : isSequential && independent <= 1 ? 'sequential' : independent >= 2 ? 'parallel' : 'sequential'
  signals.push(`shape: ${parts.length} part(s) written, ${independent} independent`)
  const words = text.split(/\s+/).filter(Boolean).length
  const risk = has(text, /\b(prod(uction)?|deploy|delete|drop|migrat|security|secret|payment|credential|irreversible)\b/i) ? 'high' : 'low'
  if (risk === 'high') signals.push('risk: high-consequence keyword')
  const needsLargeContext = has(text, /\b(entire|whole|all files|every file|codebase|repo(sitory)?-wide|monorepo)\b/i)
  if (needsLargeContext) signals.push('context: whole-repo wording')
  const needsTools = has(text, /\b(read|file|run|search|grep|repo|code|test)\b/i)
  const needsStructured = has(text, /\b(json|table|csv|schema|structured|yaml)\b/i)
  const speed = has(text, /\b(quick(ly)?|fast|brief(ly)?|short|simple|tiny|small)\b/i) ? 'fast' : has(text, /\b(thorough(ly)?|deep(ly)?|careful(ly)?|rigorous(ly)?|in-depth|comprehensive(ly)?)\b/i) ? 'depth' : 'balanced'
  if (speed !== 'balanced') signals.push(`speed: "${speed}" wording`)
  const isAmbiguous = words < 6 || has(text, /\b(something|somehow|maybe|etc|whatever|stuff)\b/i)
  let score = 0
  if (words > 25) score++
  if (words > 60) score++
  if (parts.length >= 3) score++
  if (type === 'reasoning' || type === 'coding') score++
  if (risk === 'high' || needsLargeContext) score++
  if (speed === 'fast') score--
  if (speed === 'depth') score++
  const complexity = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low'
  signals.push(`complexity: ${words} words, ${parts.length} parts → ${complexity}`)
  return {
    type,
    complexity,
    ambiguity: isAmbiguous ? 'high' : 'low',
    needsLargeContext,
    needsTools,
    needsStructured,
    risk,
    speed,
    shape,
    steps: parts.length,
    signals,
  }
}

// ---- policy ---------------------------------------------------------------

// The tier a piece of work asks for, before limits.
const wantedTier = (c: Classification, partWords: number) => {
  let tier = c.complexity === 'high' ? 3 : c.complexity === 'medium' ? 2 : 1
  if (c.risk === 'high' || c.type === 'reasoning') tier = Math.max(tier, 3)
  if (c.speed === 'fast' && c.risk === 'low') tier = Math.min(tier, 1)
  if (partWords > 40) tier = Math.max(tier, 2)
  return tier
}

// The usable model for a tier: tiered, supported, not failing this session.
const pickModel = (registry: ModelEntry[], tier: number, cap: number) => {
  const usable = registry.filter(m => m.tier !== undefined && m.failures < 2).sort((a, b) => a.tier! - b.tier!)
  const want = Math.min(tier, cap)
  return usable.find(m => m.tier === want) ?? usable.filter(m => m.tier! <= want).pop() ?? usable[0]
}

export type Plan = { title: string; decision: Decision; subtasks: Subtask[] }

const subtask = (id: string, title: string, objective: string, model: string, reason: string, deps: string[]): Subtask => ({
  id,
  title: title.slice(0, 60),
  objective,
  acceptance: [`Answers: ${objective.slice(0, 120)}`, 'States what it could not verify'],
  model,
  modelReason: reason,
  deps,
  weight: 1,
  state: deps.length ? 'queued' : 'ready',
  anim: { from: 0, at: 0 },
})

export const plan = (text: string, config: Config, registry: ModelEntry[], now: number): Plan => {
  const c = classify(text)
  const { title, parts } = splitTask(text)
  const rationale: string[] = []
  const uncertainty: string[] = [
    'Classification is keyword and structure based; it does not read the code.',
    'Prices are unknown to ModelPilot, so cost is not part of the choice.',
  ]
  if (registry.every(m => m.runs === 0)) uncertainty.push('No model has run in this session yet: no measured performance.')
  const tradeoffs: string[] = []
  const cap = config.mode === 'budget-aware' ? 2 : 3
  const pinned = config.pin ? registry.find(m => m.alias === aliasOf(config.pin!)) : undefined
  const base = {
    at: now,
    mode: config.mode,
    category: c.type,
    fallback: 'Stop and ask: a failed subtask blocks its dependents; retry it with /model-pilot retry <id> [model].',
  }

  if (config.pin && !pinned) {
    return {
      title,
      subtasks: [],
      decision: { ...base, strategy: 'direct', assignments: [], rationale: [], uncertainty, tradeoffs, isParallelWorthwhile: false, refused: `Pinned model "${config.pin}" is not one this Claude Code build can invoke (${SCHEMA_MODELS.join(', ')}).` },
    }
  }

  const choose = (partText: string): { model: string; reason: string } => {
    if (pinned) return { model: pinned.alias, reason: 'pinned by you' }
    const tier = wantedTier(c, partText.split(/\s+/).length)
    const m = pickModel(registry, tier, cap)
    const why = [`wants tier ${tier}`]
    if (tier > cap) why.push(`capped at ${cap} by budget-aware mode`)
    if (m && m.tier !== Math.min(tier, cap)) why.push(`tier ${Math.min(tier, cap)} unavailable`)
    return { model: m?.alias ?? 'sonnet', reason: `${m?.alias} (policy tier ${m?.tier}): ${why.join(', ')}` }
  }

  // Short, well-scoped single-step work: no agent at all.
  const isShort = c.shape === 'single-step' && c.complexity === 'low'
  const independent = parts.filter(p => p.after === undefined).length
  const isParallelWorthwhile = c.shape === 'parallel' && independent >= 2 && config.maxAgents >= 2 && config.mode !== 'single-model'
  let strategy: Strategy = isShort ? 'direct' : isParallelWorthwhile ? 'team' : 'single'

  if (strategy === 'direct') {
    const m = choose(text)
    rationale.push('Short, single-step task: an agent would add overhead, not speed.')
    rationale.push(`Suggested model for the main session: ${m.model} (${m.reason}). ModelPilot does not change your /model.`)
    tradeoffs.push('No isolation or parallelism; nothing is spent by ModelPilot.')
    return { title, subtasks: [], decision: { ...base, strategy, assignments: [], rationale, uncertainty, tradeoffs, isParallelWorthwhile: false } }
  }

  let subtasks: Subtask[]
  if (strategy === 'single') {
    const m = choose(text)
    subtasks = [subtask('s1', title, text, m.model, m.reason, [])]
    rationale.push(
      c.shape === 'sequential'
        ? 'Steps depend on each other: one agent runs them in order rather than paying hand-off overhead.'
        : config.mode === 'single-model'
          ? 'single-model mode: one agent, whatever the shape.'
          : 'One part, or parallelism not allowed: one agent.',
    )
  } else {
    // One agent per independent part (with its sequential followers folded
    // in), capped at maxAgents - 1, plus one integration agent.
    const groups: Part[][] = []
    for (const p of parts) {
      if (p.after === undefined) groups.push([p])
      else groups[groups.length - 1]!.push(p)
    }
    const room = Math.max(1, config.maxAgents - 1)
    while (groups.length > room) groups[groups.length - 2]!.push(...groups.pop()!)
    subtasks = groups.map((g, i) => {
      const objective = g.map(p => p.text).join(', then ')
      const m = choose(objective)
      return subtask(`s${i + 1}`, g[0]!.text, objective, m.model, m.reason, [])
    })
    const integ = pinned ? { model: pinned.alias, reason: 'pinned by you' } : (() => {
      const m = pickModel(registry, Math.max(2, ...subtasks.map(s => registry.find(r => r.alias === s.model)?.tier ?? 2)), cap)
      return { model: m?.alias ?? 'sonnet', reason: `${m?.alias} (policy tier ${m?.tier}): integration needs at least the parts' tier` }
    })()
    subtasks.push(subtask(`s${subtasks.length + 1}`, 'Integrate results', `Combine the outputs of ${subtasks.map(s => s.id).join(', ')} into one answer for: ${title}`, integ.model, integ.reason, subtasks.map(s => s.id)))
    rationale.push(`${independent} independent parts written: ${groups.length} parallel agent(s) and one integration agent.`)
    if (parts.length > groups.length) rationale.push(`Sequential steps stay with the agent of the part they follow (max ${config.maxAgents} agents).`)
    tradeoffs.push('Parallel agents finish sooner but each pays its own prompt and tool-call tokens.')
    tradeoffs.push('Context passes through the artifact store; anything an agent reads is copied into its prompt and billed there.')
  }
  if (c.ambiguity === 'high') uncertainty.push('The task is short or vague; the plan may not match intent.')
  return {
    title,
    subtasks,
    decision: {
      ...base,
      strategy,
      assignments: subtasks.map(s => ({ subtaskId: s.id, model: s.model, reason: s.modelReason })),
      rationale,
      uncertainty,
      tradeoffs,
      isParallelWorthwhile,
    },
  }
}
