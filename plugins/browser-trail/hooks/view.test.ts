import { describe, expect, test } from 'claude-code/testing'
import type { Trail } from '../types'

import { classify } from './adapters'
import { empty, finish, start } from './trail'
import { detailOf, failureReport, fit, focusEvent, integrationName, layoutFor, pad2, telemetry, titleOf, windowAround, wrapLines } from './view'

const NAV = 'mcp__claude-in-chrome__navigate'
const CLICK = 'mcp__claude-in-chrome__computer'
const READ = 'mcp__claude-in-chrome__read_page'
const nav = classify(NAV, { url: 'http://localhost:8765/login.html' })!
const click = classify(CLICK, { action: 'left_click', ref: 'ref_3' })!
const readPage = classify(READ, {})!
const page = (url: string) => `ok\n\nTab Context:\n- Executed on tabId: 1\n- Available tabs:\n  • tabId 1: "T" ("${url}")`

describe('layoutFor', () => {
  test('positive: full and short by height', async () => {
    expect(layoutFor(150, 40).mode).toBe('full')
    expect(layoutFor(62, 40).mode).toBe('full')
    expect(layoutFor(150, 14).mode).toBe('short')
  })

  test('edge: tiny or missing sizes still lay out', async () => {
    const l = layoutFor(0, 0)
    expect(l.cols).toBeGreaterThan(0)
    expect(l.rows).toBeGreaterThan(0)
  })
})

describe('telemetry', () => {
  test('positive: counts, average of completed calls, elapsed', async () => {
    let t: Trail = { ...empty('s'), startedAt: 0 }
    t = start(t, 'a', NAV, nav, 1000)
    t = finish(t, 'a', { text: 'ok' }, 1400, { tool: NAV, c: nav })
    t = start(t, 'b', CLICK, click, 2000)
    t = finish(t, 'b', { isError: true, text: 'no' }, 2200, { tool: CLICK, c: click })
    t = start(t, 'c', READ, readPage, 3000)
    const m = telemetry(t, t.events, 5000)
    expect(m).toEqual({ total: 3, failed: 1, unknown: 0, running: 1, completed: 2, avgMs: 300, elapsedMs: 5000 })
  })

  test('negative: an empty session has no average and no invented elapsed time', async () => {
    const m = telemetry(empty('s'), [], 999)
    expect(m.avgMs).toBeUndefined()
    expect(m.elapsedMs).toBeUndefined()
    expect(m.total).toBe(0)
  })

  test('edge: a result with no start is not averaged', async () => {
    const t = finish(empty('s'), 'x', { text: 'ok' }, 50, { tool: CLICK, c: click })
    expect(telemetry(t, t.events, 100).avgMs).toBeUndefined()
  })
})

describe('row labels', () => {
  test('positive: adapters give a title and a detail (captured shapes)', async () => {
    let t = start(empty('s'), 'a', NAV, nav, 0)
    const ctx = classify('mcp__claude-in-chrome__tabs_context_mcp', {})!
    t = start(t, 'b', 'mcp__claude-in-chrome__tabs_context_mcp', ctx, 1)
    const fill = classify('mcp__claude-in-chrome__form_input', { ref: 'ref_7', value: 'hunter2-test', action_summary: 'Sets the password field' })!
    t = start(t, 'c', 'mcp__claude-in-chrome__form_input', fill, 2)
    const [n, c, f] = t.events
    expect([titleOf(n!), detailOf(n!)]).toEqual(['Navigate', 'localhost:8765/login.html'])
    expect([titleOf(c!), detailOf(c!)]).toEqual(['Read tab context', 'identify the active browser tab'])
    expect([titleOf(f!), detailOf(f!)]).toEqual(['Sets the password field', 'ref_7 · value redacted'])
    expect(JSON.stringify(t)).not.toContain('hunter2-test')
  })

  test('negative: without adapter labels, the summary and tool are used', async () => {
    const pw = classify('mcp__playwright__browser_click', { element: 'Go', target: 'e2' })!
    const t = start(empty('s'), 'a', 'mcp__playwright__browser_click', pw, 0)
    expect(titleOf(t.events[0]!)).toBe('Click "Go"')
    expect(detailOf(t.events[0]!)).toBe('target Go · browser_click')
  })

  test('edge: batch detail lists its steps in order', async () => {
    const b = classify('mcp__claude-in-chrome__browser_batch', {
      actions: [
        { name: 'form_input', input: { ref: 'ref_5', value: 'x', action_summary: 'Sets the email field' } },
        { name: 'computer', input: { action: 'left_click', ref: 'ref_8' } },
      ],
    })!
    expect(b.title).toBe('Batch · 2 steps')
    expect(b.detail).toBe('Sets the email field → Click')
    expect(integrationName('claude-in-chrome')).toBe('CHROME EXTENSION')
    expect(integrationName('playwright')).toBe('PLAYWRIGHT')
    expect(pad2(9)).toBe('09')
  })
})

describe('selection and windows', () => {
  test('positive: the window keeps the focus row in view', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => i)
    expect(windowAround(rows, 50, 10).rows).toContain(50)
    expect(windowAround(rows, -1, 10).rows).toEqual(rows.slice(-10))
    expect(windowAround(rows.slice(0, 5), 2, 10).rows.length).toBe(5)
  })

  test('positive: the inspector follows selection, else running, else newest', async () => {
    let t = start(empty('s'), 'a', NAV, nav, 0)
    t = finish(t, 'a', {}, 1, { tool: NAV, c: nav })
    t = start(t, 'b', CLICK, click, 2)
    t = start(t, 'c', READ, readPage, 3)
    t = finish(t, 'c', {}, 4, { tool: READ, c: readPage })
    expect(focusEvent(t.events, 'a')!.id).toBe('a')
    expect(focusEvent(t.events, undefined)!.id).toBe('b')
    expect(focusEvent([], undefined)).toBeUndefined()
  })
})

describe('failures', () => {
  test('positive: a failed call with the next page check after it', async () => {
    let t = start(empty('s'), 'a', CLICK, click, 0)
    t = finish(t, 'a', { isError: true, text: 'No element found' }, 1, { tool: CLICK, c: click })
    t = start(t, 'b', READ, readPage, 2)
    t = finish(t, 'b', {}, 3, { tool: READ, c: readPage })
    const [f] = failureReport(t.events)
    expect(f!.kind).toBe('tool')
    expect(f!.nextCheck!.id).toBe('b')
  })

  test('edge: a failed Playwright test run is the test runner\'s report', async () => {
    const run = classify('Bash', { command: 'npx playwright test' })!
    let t = start(empty('s'), 'a', 'Bash', run, 0)
    t = finish(t, 'a', { isError: true, text: '1 failed' }, 1, { tool: 'Bash', c: run })
    expect(failureReport(t.events)[0]!.kind).toBe('test')
    expect(failureReport(t.events)[0]!.nextCheck).toBeUndefined()
  })
})

describe('text', () => {
  test('long text truncates and wraps within bounds', async () => {
    expect(fit('abcdef', 4)).toBe('abc…')
    expect(fit('ab', 4, true)).toBe('ab  ')
    expect(fit('x', 0)).toBe('')
    const lines = wrapLines('y'.repeat(1000), 40, 3)
    expect(lines.length).toBe(3)
    expect(lines[2]).toContain('+')
    expect(wrapLines('cat: /nonexistent-file: No such file or directory', 30, 5)).toEqual(['cat: /nonexistent-file: No', 'such file or directory'])
  })
})

describe('rows recorded before titles', () => {
  test('edge: "Navigate to X" splits into title and detail', async () => {
    const old = { ...start(empty('s'), 'a', NAV, nav, 0).events[0]!, title: undefined, detail: undefined }
    expect([titleOf(old), detailOf(old)]).toEqual(['Navigate', 'localhost:8765/login.html'])
  })
})
