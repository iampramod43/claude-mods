import { expect, mock, test } from 'claude-code/testing'

// Pane props at a given size: bodyColumns across, scroll.bodyRows down.
const props = (cols: number, rows: number) =>
  ({ title: 'Browser trail', isFocused: false, bodyColumns: cols, placement: cols >= 110 ? 'dock' : 'inline', scroll: { offset: 0, bodyRows: rows }, view: {} }) as never

const mount = ($: any, cols: number, rows: number, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'browser-trail', surface, component: 'Pane', requestId: 'browser-trail', props: props(cols, rows) })

// SYNTHETIC tool answers standing in for Claude in Chrome, shaped after the
// payloads captured on 2026-10-13 (see adapters.test.ts).
const chrome = (on: any) => {
  on('session.id', async () => ({ value: 's-test-1234567890' }))
  on('tool.call', async ($: unknown, e: { tool: string; ref?: string; actions?: unknown[] }) => {
    if (e.tool.endsWith('__browser_batch'))
      return { isError: true, result: 'x', text: 'actions[2] (computer:left_click) failed: No element found with reference: "ref_99". (2 completed, 0 remaining)' }
    if (e.tool.endsWith('__navigate'))
      return { result: [], text: 'Navigated to http://localhost:8765/login.html\n\nTab Context:\n- Executed on tabId: 7\n- Available tabs:\n  • tabId 7: "Test Login" ("http://localhost:8765/login.html")' }
    return { result: [], text: 'Clicked on element ref_3\n\nTab Context:\n- Executed on tabId: 7\n- Available tabs:\n  • tabId 7: "Test Login" ("http://localhost:8765/login.html?token=zzz")' }
  })
}

const drive = async ($: any) => {
  await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'http://localhost:8765/login.html', tabId: 7 })
  await $.tool.call({ tool: 'mcp__claude-in-chrome__computer', action: 'left_click', ref: 'ref_3', tabId: 7, action_summary: 'Clicks the Sign in button' })
  await $.tool.call({
    tool: 'mcp__claude-in-chrome__browser_batch',
    actions: [
      { name: 'computer', input: { action: 'wait', duration: 1, tabId: 7 } },
      { name: 'computer', input: { action: 'screenshot', tabId: 7 } },
      { name: 'computer', input: { action: 'left_click', ref: 'ref_99', tabId: 7, action_summary: 'Clicks a missing button' } },
    ],
  })
}

const text = async (ui: any, re: RegExp) => ui.find({ type: 'Text', text: re })

test('empty session: header, status pill, cards and guidance on every surface', async ($, on) => {
  mock.clock(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, 62, 40, surface)
    expect(await text(ui, /BROWSER TRAIL/)).toBeDefined()
    expect(await text(ui, /NO BROWSER TOOLS/)).toBeDefined()
    for (const label of [/ACTIONS/, /FAILURES/, /AVG LATENCY/, /ELAPSED/]) expect(await text(ui, label)).toBeDefined()
    expect(await text(ui, /EXECUTION TIMELINE/)).toBeDefined()
    expect(await text(ui, /No browser tools are connected/)).toBeDefined()
    // No failure, no callout.
    expect(await text(ui, /ACTION FAILED/)).toBeUndefined()
    await ui.unmount()
  }
})

test('a session: titles and details, statuses, the failure callout, the page', async ($, on) => {
  mock.clock(on)
  chrome(on)
  await drive($)
  const ui = await mount($, 62, 40)
  expect(await text(ui, /LIVE SESSION/)).toBeDefined()
  expect(await text(ui, /CHROME EXTENSION · SESSION S-TE/)).toBeDefined()
  expect(await text(ui, /Test Login/)).toBeDefined()
  expect(await text(ui, /01 Navigate/)).toBeDefined()
  expect(await text(ui, /localhost:8765\/login\.html/)).toBeDefined()
  expect(await text(ui, /02 Clicks the Sign in button/)).toBeDefined()
  expect(await text(ui, /click ref_3/)).toBeDefined()
  expect(await text(ui, /03 Batch · 3 steps/)).toBeDefined()
  expect(await text(ui, /2\/3 ok, step 3 failed/)).toBeDefined()
  expect(await text(ui, /^DONE$/)).toBeDefined()
  expect(await text(ui, /^FAILED$/)).toBeDefined()
  expect(await text(ui, /ACTION FAILED/)).toBeDefined()
  expect(await text(ui, /browser_batch returned an error/)).toBeDefined()
  expect(await text(ui, /does not show that the app failed/)).toBeDefined()
  expect(await text(ui, /No later check of the page observed/)).toBeDefined()
  // Never an invented step after the failure.
  expect(await text(ui, /04 /)).toBeUndefined()
  // Secrets in reported URLs never reach the drawing.
  expect(await text(ui, /zzz/)).toBeUndefined()
  await ui.unmount()
})

test('selection: k selects, o inspects with batch steps, o goes back', async ($, on) => {
  mock.clock(on)
  chrome(on)
  await drive($)
  const ui = await mount($, 62, 40)
  await ui.press({ key: 'k-k' })
  await ui.press({ key: 'k-o' })
  expect(await text(ui, /INSPECT · #03/)).toBeDefined()
  expect(await text(ui, /NOT RUN|FAILED/)).toBeDefined()
  expect(await text(ui, /EXECUTION TIMELINE/)).toBeUndefined()
  await ui.press({ key: 'k-k' })
  expect(await text(ui, /INSPECT · #02/)).toBeDefined()
  await ui.press({ key: 'k-o' })
  expect(await text(ui, /EXECUTION TIMELINE/)).toBeDefined()
  await ui.unmount()
})

test('failures only: f filters to failed calls', async ($, on) => {
  mock.clock(on)
  chrome(on)
  await drive($)
  const ui = await mount($, 62, 40)
  await ui.press({ key: 'k-f' })
  expect(await text(ui, /FAILED CALLS/)).toBeDefined()
  expect(await text(ui, /01 Navigate/)).toBeUndefined()
  expect(await text(ui, /03 Batch/)).toBeDefined()
  await ui.unmount()
})

test('short: one-line rows and a strip, no callout', async ($, on) => {
  mock.clock(on)
  chrome(on)
  await drive($)
  const ui = await mount($, 100, 14)
  expect(await text(ui, /BROWSER TRAIL/)).toBeDefined()
  expect(await text(ui, /actions ·/)).toBeDefined()
  expect(await text(ui, /AVG LATENCY/)).toBeUndefined()
  expect(await text(ui, /ACTION FAILED/)).toBeUndefined()
  expect(await text(ui, /03 Batch/)).toBeDefined()
  await ui.unmount()
})

test('resizing redraws from the same state: nothing is lost', async ($, on) => {
  mock.clock(on)
  chrome(on)
  await drive($)
  for (const [c, r] of [[160, 50], [62, 30], [44, 20], [100, 12], [150, 40]] as const) {
    const ui = await mount($, c, r)
    expect(await text(ui, /BROWSER TRAIL/)).toBeDefined()
    expect(await text(ui, /03 Batch/)).toBeDefined()
    await ui.unmount()
  }
})

test('help and clear', async ($, on) => {
  mock.clock(on)
  chrome(on)
  await drive($)
  const ui = await mount($, 80, 40)
  await ui.press({ key: 'k-h' })
  expect(await text(ui, /LEGEND/)).toBeDefined()
  await ui.press({ key: 'k-h' })
  await ui.press({ key: 'k-c' })
  expect(await text(ui, /Timeline cleared/)).toBeDefined()
  expect(await text(ui, /ACTION FAILED/)).toBeUndefined()
  await ui.unmount()
})

test('a failing tool still reaches the model as its own error, shown as TIMEOUT', async ($, on) => {
  mock.clock(on)
  on('session.id', async () => ({ value: 's-test' }))
  on('tool.call', async () => ({ isError: true, result: 'boom', text: 'TimeoutError: Timeout 5000ms exceeded' }) as never)
  const ran = await $.tool.call({ tool: 'mcp__playwright__browser_click', element: 'Go', target: 'e2' } as never)
  expect((ran as { isError?: boolean }).isError).toBe(true)
  const ui = await mount($, 62, 40)
  expect(await text(ui, /^TIMEOUT$/)).toBeDefined()
  expect(await text(ui, /ACTION TIMED OUT/)).toBeDefined()
  await ui.unmount()
})

test('non-browser calls are not recorded by default', async ($, on) => {
  mock.clock(on)
  on('tool.call', async () => ({ result: 'x', text: 'x' }))
  await $.tool.call({ tool: 'Read', file_path: '/etc/hosts' } as never)
  const ui = await mount($, 62, 40)
  expect(await text(ui, /No browser tools are connected/)).toBeDefined()
  await ui.unmount()
})
