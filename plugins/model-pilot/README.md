# model-pilot

ModelPilot routes a task to a fitting model, or to a small team of subagents when the task splits into independent parts. Agents share context through a versioned artifact store, and a live dashboard shows it all: radial progress, animated agent lanes, a data-flow graph, an activity feed and the router's reasoning.

Status: a working vertical slice (0.1.0), verified with real subagents. See "What works and what does not" before relying on it.

## Install

```
/plugin install model-pilot --marketplace iampramod43/claude-mods
```

Orchestration needs the default permission mode; see "Limitations" below.

## Use

```
/model-pilot plan Hook inventory: list the hooks in burn-meter; list the hooks in file-trail
/model-pilot approve            # or press a in the dashboard; nothing starts before this in recommend mode
/model-pilot                    # open the dashboard
```

- **Splitting a task:** independent parts are separated with `;` or new lines, and ordered steps with `then` or `->`. ModelPilot splits a task only along structure you wrote. It never guesses a decomposition.
- **Commands:**
  - `mode auto|recommend|single-model|budget-aware`
  - `pin <haiku|sonnet|opus|fable>|off`
  - `max-agents N`, `parallel N`
  - `budget <usd>|off`
  - `motion on|off`
  - `models`
  - `retry <id> [model]`
  - `cancel [id]`
- **Default config:** `recommend` mode, at most 3 agents, 3 in parallel, no budget, motion on, artifacts capped at 50,000 bytes. Config lives in the session only.

### Keys (dashboard focused)

| Key | Does |
| --- | --- |
| `1` `2` `3` `4` | Overview, Graph, Feed, Plan |
| `j` / `k` | select the next or previous agent |
| `o` | details of the selected agent: model and why, objective, error, tokens, its events |
| `f` | feed filter: all → failures → context → the selected agent |
| `a` | approve the planned task |
| `x` | cancel the selected agent, or the whole task if none is selected (uses `TaskStop`, so it goes through the permission check) |
| `m` | motion on or off |
| `t` | next task, when there are several |
| `h` | help |
| `q` | close the dashboard; the task keeps running |

## A real run (2026-10-13)

Haiku was pinned, and the run used two parallel workers plus one integration worker. It was captured in a real terminal, in the 62-column dock:

```
◈ MODELPILOT  Hook inventory                        COMPLETED
TEAM · 3 SUBTASKS · HAIKU · 49.8s · MODE RECOMMEND
      ▄▄▄▄▀▀▄▄▄▄
    ▄▀▀▀▀▀▀▀▀▀▀▀▀▄
  ▄▀▀▀▀▀▀▀  ▀▀▀▀▀▀▀▄
 ▀▀▀▀▀          ▀▀▀▀▀   ● 3/3 completed
▀▀▀▀     100%     ▀▀▀▀  progress = completed weight ÷ total; a
 ▀▀▀▀    done    ▀▀▀▀   running agent adds only what it reported
AGENTS  3 subtask(s)
● s1 claude-haiku-5-5 list the hook event…     22.3s COMPLETED
  ▕████████████████████████████▏ 100%  16.1k in · 724 out
● s2 claude-haiku-5-5 list the hook event…     24.8s COMPLETED
  ▕████████████████████████████▏ 100%  15.2k in · 934 out
● s3 claude-haiku-5-5 Integrate results        21.9s COMPLETED
  ▕████████████████████████████▏ 100%  27.2k in · 997 out
```

The graph for that run's events (read edges `┄◀`, write edges `─▶`, handoffs `═`, dependencies `╎`):

```
         AGENTS                           ◈ SHARED CONTEXT
   ╔═══┬─● s1 haiku    ◀──┬─┐             │
   ║   ╎                  ├─┼────────────▶┤◆ Task spec v1
 ╔═╬═┬─┼─● s2 haiku    ◀──┼─┼─┐           │
 ║ ║ ╎ ╎                  │ ├─┼──────────▶┤◆ s1 output v1
 ╚═╩═┴─┴▶● s3 haiku    ◀┄┄┼┄┴┄┤           │
                          │   └──────────▶┤◆ s2 output v1
         ○ router      ───┘               │
```

Colors are not shown. On a terminal the ring and the graph are drawn with a `Raster` element: true-color cells, with half blocks for a round ring.

## Findings (discovery, 2026-10-13, Claude Code 2.1.296)

- **Stack.** A Claude Code function-hooks plugin like the other mods (TSX, pure logic in `.ts`, `claude plugin test`). It shares no code with burn-meter, file-trail or browser-trail, which were not changed.
- **Invokable models.** The only ones are those this build's Agent tool accepts: `haiku`, `sonnet`, `opus`, `fable` (Anthropic, run as Claude Code subagents). Settings have `model: opus` and no `availableModels` restriction.
  - There is no `$.model.list`. The registry is built from that schema, plus the session model and its context window as `$.session` reports them.
- **Other providers.** An `OPENROUTER_API_KEY` is set in settings `env`, but Claude Code has no subagent path to it. ModelPilot does not invoke it and does not add providers.
- **Launching agents.**
  - `$.agent.spawn({ prompt, description, subagentType, model, name, cwd })` starts a background subagent and returns `{ model, agentId }`.
  - Its answer arrives as `turn.complete` carrying the same `agentId`.
  - There is no isolation option on a spawn.
  - `TaskStop` stops an agent by ID.
  - `$.agent.register` defines ModelPilot's worker type. `agent.offer` hides it from the main model.
- **Events.**
  - `tool.call` carries `agentId` (which loop made the call), and so do `turn.step` and `turn.complete`.
  - `turn.complete` carries `usage` (input, output, cache read and write tokens, and the model ID the API reported) and `durationMs`.
  - Cost is only a session total (`$.session.usage().cost.usd`); there is none per agent. Usage events have no ID of their own, so each agent's usage is taken once, from its `turn.complete`.
- **Agent tools.** `$.tool.register` lets the mod offer tools to its agents. ModelPilot's artifact tools are `mcp__model-pilot__{list_artifacts,read_artifact,write_artifact,report_progress}`. Every read and write therefore arrives as a real call with the caller's `agentId`.

## Architecture

| Part | File |
| --- | --- |
| Model registry, task classifier, splitter, routing policy | `hooks/router.ts` |
| Shared context store: artifacts, versions, hash dedup, stale detection, redaction, event log | `hooks/store.ts` |
| Planner/DAG state: launch limits, completion, handoff, unblocking, failure blocking, retry, worker prompt | `hooks/orchestrate.ts` |
| Progress estimator and bar animation | `hooks/progress.ts` |
| Raster grid, half-block radial chart | `hooks/raster.ts` |
| Data-flow graph: edges from events, lane layout | `hooks/graph.ts` |
| Commands, artifact tools, real spawns, event collection | `hooks/register.tsx` |
| Dashboard | `hooks/pane.tsx` |

**Routing.** The classifier is deterministic: type keywords, complexity, ambiguity, risk, context and speed cues, and the written shape. Every judgement records the signal it came from. The policy:
- **direct:** a short, single-step, low-complexity task gets no agent. ModelPilot suggests a model for the main session but never changes `/model`.
- **single:** sequential steps, or `single-model` mode, run as one agent.
- **team:** two or more independent parts get one agent each, plus an integration agent that depends on all of them, capped by `max-agents`.
- **Model choice:** the policy tiers are haiku 1, sonnet 2, opus 3. These are ModelPilot's rule, labelled `policy`, not provider facts. `fable` has no tier, so it is used only when pinned.
- **Adjustments:** high risk or reasoning raises the tier, and "quick" lowers it. `budget-aware` caps the tier at 2, and a model that failed twice this session is avoided.
- **Explanation:** each decision records its rationale, uncertainty, trade-offs and fallback (stop and ask, then retry).

**Context sharing.** Agents do **not** share one model context. A worker's prompt lists artifact *references* (ID, title, version, size estimate), never content. It calls `read_artifact` for what it needs, and that text is then copied into, and billed in, its own context.
- Each artifact has an ID, type, title, versions (with a hash, author, time, bytes, and estimated tokens at chars/4), tags, and a truncation flag.
- Content is redacted and capped at `max_artifact_bytes` before it is stored.
- Identical content is deduplicated by hash.
- A write over an older `base_version` is refused as stale, and a read naming an older version is recorded as stale.
- A finished agent's answer is stored as its output artifact, then handed to its dependents.
- Events: `artifact_created`, `artifact_updated`, `artifact_read` (only on a real call), `artifact_shared` (a reference in a prompt), `handoff_created`, `handoff_received`, `dependency_unblocked`.

**Graph edges.** These come only from recorded events:
- **read:** artifact → agent, from `artifact_read`;
- **write:** agent → artifact, from `artifact_created`/`artifact_updated`, unless refused;
- **handoff:** agent → agent through an artifact, from `handoff_created`;
- **dependency:** task → task, from the plan, drawn dim.

An edge whose event is under 1.5 s old is lit. Old artifacts are grouped into `+N older`. A narrow or non-terminal pane gets a list of edges instead of the drawing.

**Progress.** The planner gives subtasks equal weight.
- A completed subtask counts in full.
- A running one counts only the percentage its agent reported with `report_progress`, labelled `est.`.
- A running agent that reported nothing counts as 0 and shows "no progress reported".
- Failed and cancelled subtasks are shown but never counted.
- Elapsed time is never used. With no subtasks, progress shows `—`.

**Animation.** Bars ease over 600 ms only when a real state or progress change happens. The redraw timer runs only while a bar is easing or an edge is lit. `m` or `motion off` turns animation off.

## What is measured, estimated, or unknown

| Value | Status |
| --- | --- |
| Model per agent | **measured**: the ID the spawn and the API report (`claude-haiku-5-5`) |
| Tokens per agent | **provider-reported**: `turn.complete` usage, once per agent |
| Duration per agent | **measured**: from spawn to `turn.complete` |
| Session cost | **engine-reported** total; the budget is checked against its growth since the task started (the main thread included) |
| Cost per agent, model prices | **unknown**: not exposed; never estimated |
| Context window | **session-reported** for the session model only; **unknown** for the others |
| Model tiers | **policy**: ModelPilot's own rule |
| Artifact tokens | **estimated** (chars/4), labelled |
| Subtask progress | **agent-reported** (estimated) or none |

## What works and what does not

**Works, verified live:**
- planning and approval;
- real Haiku subagents started on the planned model;
- artifact reads through ModelPilot's tools;
- outputs stored as artifacts, handed off, and the dependent unblocked;
- the integration agent;
- provider-reported tokens;
- radial progress and lanes updating to `COMPLETED` (100%);
- refused spawns shown with the engine's own reason, with their dependents blocked.

**Works, verified in tests:**
- the routing rules;
- deduplication and stale reads and writes;
- redaction;
- edge direction and type;
- grouping of many artifacts;
- budget and concurrency limits;
- recommend mode never launching;
- short tasks spawning nothing;
- layouts at wide, narrow, short and desktop sizes;
- motion off;
- closing the dashboard without cancelling;
- no cross-talk between tasks.

**Limitations:**
- **Auto permission mode refuses ModelPilot's spawns.** In auto mode Claude Code's classifier gives "no verdict" on an agent spawn a mod starts rather than the model, so the spawn is refused; ModelPilot shows the reason. Run a session in default permission mode, where the spawn proceeds, to use orchestration. Launching through the main model, so the classifier sees a model request, is not built.
- **Each artifact-tool call asks permission** in default mode, like any MCP tool. To stop the prompts, allow `mcp__model-pilot__*` in your permission rules. ModelPilot does not allow its own tools for you.
- **Workers are read-only by design**: `Read` plus the artifact tools, with no Bash or Edit, because spawns have no worktree isolation option. Agents that edit files are not supported.
- **The planner splits only along structure you wrote.** No model is used to decompose a task, since that would spend tokens before approval.
- **Progress for a running agent depends on its own `report_progress` calls.** Haiku workers in the live run did not call it, so those lanes showed "no progress reported" until done.
- **Single-agent usage.** If a subagent ran several turns, only the usage on its final `turn.complete` is shown.
- **No persistence.** Plans, config and the store live in the session's state. Up to 8 tasks are kept.
- **Agents Claude starts itself** (through the Agent tool) are observed in a separate "Agents Claude started" task, never mixed into a planned one.

## Tests

`claude plugin test plugins/model-pilot`: 47 tests across router, store, progress, graph, orchestration and the dashboard. A test cannot start a real agent, because `agentId` is set by core alone. The dashboard tests therefore check the spawn request (worker type, planned model, a prompt with references only) and that a spawn without an ID is reported honestly. The run itself was verified live (above).
