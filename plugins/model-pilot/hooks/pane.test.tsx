import { expect, mock, test } from 'claude-code/testing'

const props = (cols: number, rows: number) =>
  ({ title: 'ModelPilot', isFocused: false, bodyColumns: cols, placement: cols >= 110 ? 'dock' : 'inline', scroll: { offset: 0, bodyRows: rows }, view: {} }) as never

const mount = ($: any, cols: number, rows: number, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'model-pilot', surface, component: 'Pane', requestId: 'model-pilot', props: props(cols, rows) })

const text = async (ui: any, re: RegExp) => ui.find({ type: 'Text', text: re })

const TEAM = 'plan Review the mods: review burn-meter hooks thoroughly; review file-trail hooks thoroughly'

// Stands in for the engine's subagent runner (SYNTHETIC): records each spawn.
const spawner = (on: any) => {
  const spawns: any[] = []
  // A hook that answers a spawn starts no agent: `agentId` is set by core
  // alone, so here the spawn request is checked, not the agent's run (the
  // run is covered by graph_orch.test.ts and verified live).
  on('agent.spawn', async (_$: unknown, e: any) => {
    spawns.push(e)
    return { model: e.model }
  })
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.1 } } }))
  return spawns
}

test('empty: the cockpit explains how to start and lists invokable models', async ($, on) => {
  mock.clock(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, 62, 40, surface)
    expect(await text(ui, /MODELPILOT/)).toBeDefined()
    expect(await text(ui, /No task yet/)).toBeDefined()
    expect(await text(ui, /^haiku/)).toBeDefined()
    expect(await text(ui, /price unknown/)).toBeDefined()
    await ui.unmount()
  }
})

test('recommend mode plans without launching; approval launches the worker type on the planned models', async ($, on) => {
  mock.clock(on)
  const spawns = spawner(on)
  const r = await $.command.run({ command: 'model-pilot', args: TEAM } as never)
  expect(JSON.stringify(r)).toContain('Approve with /model-pilot approve')
  expect(spawns.length).toBe(0)
  const ui = await mount($, 62, 40)
  expect(await text(ui, /AWAITING APPROVAL/)).toBeDefined()
  expect(await text(ui, /no progress reported|0%/)).toBeDefined()
  await ui.press({ key: 'k-a' })
  expect(spawns.length).toBe(2)
  // The engine hands the spawn on in the Agent tool's own shape.
  expect(spawns.every(s => (s.subagentType ?? s.subagent_type) === 'model-pilot:worker')).toBe(true)
  expect(spawns.map(s => s.model)).toEqual(['sonnet', 'sonnet'])
  expect(spawns[0].prompt).toContain('NOT in your context')
  // Without an id from core, the dashboard says so instead of pretending.
  await ui.press({ key: 'tab-feed' })
  expect(await text(ui, /s1 could not start: no agent id/)).toBeDefined()
  await ui.unmount()
})

test('a short task needs no agent and nothing is spawned, even in auto mode', async ($, on) => {
  mock.clock(on)
  const spawns = spawner(on)
  await $.command.run({ command: 'model-pilot', args: 'mode auto' } as never)
  const r = await $.command.run({ command: 'model-pilot', args: 'plan quick: rename one variable' } as never)
  expect(JSON.stringify(r)).toContain('No agents')
  expect(spawns.length).toBe(0)
})

test('auto mode launches; the store tools record real reads and writes with the caller', async ($, on) => {
  const clock = mock.clock(on)
  spawner(on)
  await $.command.run({ command: 'model-pilot', args: 'mode auto' } as never)
  await $.command.run({ command: 'model-pilot', args: TEAM } as never)
  await clock.advance(1)
  const read = await $.tool.call({ tool: 'mcp__model-pilot__read_artifact', id: 'task-spec' } as never)
  expect(JSON.stringify(read)).toContain('Task spec')
  const wrote = await $.tool.call({ tool: 'mcp__model-pilot__write_artifact', title: 'Hook map', content: 'burn-meter uses session.measure' } as never)
  expect(JSON.stringify(wrote)).toContain('Created hook-map v1')
  const dup = await $.tool.call({ tool: 'mcp__model-pilot__write_artifact', id: 'hook-map', title: 'Hook map', content: 'burn-meter uses session.measure' } as never)
  expect(JSON.stringify(dup)).toContain('deduplicated by hash')
  const ui = await mount($, 62, 40)
  await ui.press({ key: 'tab-feed' })
  expect(await text(ui, /main wrote "Hook map"/)).toBeDefined()
  expect(await text(ui, /read v1/)).toBeDefined()
  await ui.press({ key: 'tab-graph' })
  expect(await text(ui, /context edge\(s\) from real events/)).toBeDefined()
  await ui.unmount()
})

test('layouts: wide shows radial, lanes, graph and feed together; narrow and short stay usable', async ($, on) => {
  mock.clock(on)
  spawner(on)
  await $.command.run({ command: 'model-pilot', args: TEAM } as never)
  const wide = await mount($, 160, 50)
  for (const re of [/AGENTS/, /DATA FLOW/, /ACTIVITY/, /progress = completed weight/]) expect(await text(wide, re)).toBeDefined()
  await wide.unmount()
  for (const [c, r] of [[62, 40], [48, 20], [62, 14]] as const) {
    const ui = await mount($, c, r)
    expect(await text(ui, /MODELPILOT/)).toBeDefined()
    expect(await text(ui, /AGENTS/)).toBeDefined()
    await ui.unmount()
  }
  const desk = await mount($, 62, 40, 'desktop')
  expect(await text(desk, /AGENTS/)).toBeDefined()
  await desk.unmount()
})

test('plan tab explains the decision; motion can be turned off; closing does not cancel', async ($, on) => {
  const clock = mock.clock(on)
  const spawns = spawner(on)
  await $.command.run({ command: 'model-pilot', args: 'mode auto' } as never)
  await $.command.run({ command: 'model-pilot', args: TEAM } as never)
  await clock.advance(1)
  const ui = await mount($, 62, 40)
  await ui.press({ key: 'tab-plan' })
  for (const re of [/ASSIGNMENTS/, /WHY/, /UNCERTAINTY/, /FALLBACK/, /policy tier/]) expect(await text(ui, re)).toBeDefined()
  await ui.press({ key: 'k-m' })
  expect((await ui.find({ key: 'k-m' }))?.text).toBe('motion off')
  const pillBefore = (await ui.findAll({ type: 'Text' })).map((x: any) => x.text).find((x: string) => /^ [A-Z ]+ $/.test(x ?? ''))
  await ui.press({ key: 'k-q' })
  await ui.unmount()
  const again = await mount($, 62, 40)
  const pillAfter = (await again.findAll({ type: 'Text' })).map((x: any) => x.text).find((x: string) => /^ [A-Z ]+ $/.test(x ?? ''))
  expect(pillAfter).toBe(pillBefore)
  expect(spawns.length).toBe(2)
  await again.unmount()
})

test('unsupported pins and models are refused', async ($, on) => {
  mock.clock(on)
  const r = await $.command.run({ command: 'model-pilot', args: 'pin gpt-5' } as never)
  expect(JSON.stringify(r)).toContain('not a model this Claude Code build can invoke')
  const m = await $.command.run({ command: 'model-pilot', args: 'models' } as never)
  expect(JSON.stringify(m)).toContain('Other providers')
})
