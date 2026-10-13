import { describe, expect, test } from 'claude-code/testing'

import { classify } from './adapters'
import { cleanOutput, counts, cutOff, durationMs, empty, finish, fmtDuration, moveSelection, outputPreview, sessionStatus, start, visible, emptyView, MAX_EVENTS } from './trail'

const NAV = 'mcp__playwright__browser_navigate'
const CLICK = 'mcp__playwright__browser_click'
const nav = classify(NAV, { url: 'http://localhost:3000/login' })!
const click = classify(CLICK, { element: 'Sign in', ref: 'e1' })!

describe('correlation', () => {
  test('positive: start and result pair by id, with duration', async () => {
    let t = start(empty('s1'), 'a', NAV, nav, 1000)
    expect(t.events[0]!.status).toBe('running')
    expect(durationMs(t.events[0]!, 1500)).toBe(500)
    t = finish(t, 'a', { text: 'ok' }, 1800, { tool: NAV, c: nav })
    expect(t.events[0]!.status).toBe('ok')
    expect(durationMs(t.events[0]!, 9999)).toBe(800)
    expect(fmtDuration(800)).toBe('800ms')
    expect(fmtDuration(1250)).toBe('1.3s')
  })

  test('positive: a failed call is an error with its redacted text', async () => {
    let t = start(empty('s1'), 'a', CLICK, click, 0)
    t = finish(t, 'a', { isError: true, text: 'Element not found; auth=Bearer abcdefghijklmn' }, 10, { tool: CLICK, c: click })
    expect(t.events[0]!.status).toBe('error')
    expect(t.events[0]!.errorSummary).not.toContain('abcdefghijklmn')
    expect(counts(t.events).failed).toBe(1)
  })

  test('edge: timeouts are told from their error text', async () => {
    let t = start(empty('s1'), 'a', CLICK, click, 0)
    t = finish(t, 'a', { isError: true, text: 'TimeoutError: locator.click: Timeout 5000ms exceeded' }, 5000, { tool: CLICK, c: click })
    expect(t.events[0]!.status).toBe('timeout')
    expect(t.events[0]!.statusSource).toBe('error-text')
  })

  test('edge: a deny is an error, not OK', async () => {
    let t = start(empty('s1'), 'a', CLICK, click, 0)
    t = finish(t, 'a', { isDenied: true, text: 'user said no' }, 5, { tool: CLICK, c: click })
    expect(t.events[0]!.status).toBe('error')
  })

  test('edge: duplicate starts and results change nothing', async () => {
    let t = start(empty('s1'), 'a', NAV, nav, 0)
    t = start(t, 'a', NAV, nav, 50)
    expect(t.events.length).toBe(1)
    expect(t.events[0]!.startedAt).toBe(0)
    t = finish(t, 'a', {}, 100, { tool: NAV, c: nav })
    const again = finish(t, 'a', { isError: true, text: 'late' }, 200, { tool: NAV, c: nav })
    expect(again).toBe(t)
  })

  test('edge: a result before its start is kept, then filled in', async () => {
    let t = finish(empty('s1'), 'a', { text: 'done' }, 300, { tool: CLICK, c: click })
    expect(t.events[0]!.status).toBe('ok')
    expect(durationMs(t.events[0]!, 999)).toBeUndefined()
    t = start(t, 'a', CLICK, click, 100)
    expect(t.events.length).toBe(1)
    expect(durationMs(t.events[0]!, 999)).toBe(200)
  })

  test('negative: a result with no start and no call is ignored', async () => {
    const t = empty('s1')
    expect(finish(t, 'zz', {}, 1)).toBe(t)
  })
})

describe('page facts', () => {
  test('positive: a successful navigate is the correlated page; reported output wins', async () => {
    let t = start(empty('s1'), 'a', NAV, nav, 0)
    t = finish(t, 'a', { text: 'navigated' }, 10, { tool: NAV, c: nav })
    expect(t.page!.url).toBe('http://localhost:3000/login')
    expect(t.page!.confidence).toBe('correlated')
    t = start(t, 'b', CLICK, click, 20)
    t = finish(t, 'b', { text: '- Page URL: http://localhost:3000/home\n- Page Title: Home' }, 30, { tool: CLICK, c: click })
    expect(t.page!.url).toBe('http://localhost:3000/home')
    expect(t.page!.confidence).toBe('observed')
  })

  test('negative: a failed navigate does not move the page', async () => {
    let t = start(empty('s1'), 'a', NAV, nav, 0)
    t = finish(t, 'a', { isError: true, text: 'net::ERR_CONNECTION_REFUSED' }, 10, { tool: NAV, c: nav })
    expect(t.page).toBeUndefined()
  })

  test('edge: large output is bounded and snapshot content is dropped', async () => {
    const out = outputPreview(`Clicked\n- Page Snapshot:\n${'- text "private customer data"\n'.repeat(10_000)}`)!
    expect(out).toBe('Clicked -')
    expect(outputPreview('x'.repeat(50_000))!.length).toBeLessThan(850)
  })
})

describe('sessions and bounds', () => {
  test('positive: a restart marks running calls unknown, finished ones stay', async () => {
    let t = start(empty('s1'), 'a', NAV, nav, 0)
    t = finish(t, 'a', {}, 5, { tool: NAV, c: nav })
    t = start(t, 'b', CLICK, click, 6)
    t = cutOff(t, 'session-restart')
    expect(t.events.map(e => e.status)).toEqual(['ok', 'unknown'])
    expect(t.events[1]!.statusSource).toBe('session-restart')
  })

  test('positive: status is LIVE, IDLE or ENDED', async () => {
    let t = start(empty('s1'), 'a', NAV, nav, 0)
    expect(sessionStatus(t, 10 * 60_000)).toBe('LIVE')
    t = finish(t, 'a', {}, 100, { tool: NAV, c: nav })
    expect(sessionStatus(t, 200)).toBe('LIVE')
    expect(sessionStatus(t, 10 * 60_000)).toBe('IDLE')
    expect(sessionStatus({ ...t, isEnded: true }, 200)).toBe('ENDED')
  })

  test('edge: the trail is bounded', async () => {
    let t = empty('s1')
    for (let i = 0; i < MAX_EVENTS + 25; i++) t = start(t, `c${i}`, CLICK, click, i)
    expect(t.events.length).toBe(MAX_EVENTS)
    expect(t.dropped).toBe(25)
    expect(t.events[0]!.id).toBe('c25')
  })

  test('view: failures filter, clear and selection', async () => {
    let t = start(empty('s1'), 'a', NAV, nav, 0)
    t = finish(t, 'a', {}, 1, { tool: NAV, c: nav })
    t = start(t, 'b', CLICK, click, 2)
    t = finish(t, 'b', { isError: true, text: 'boom' }, 3, { tool: CLICK, c: click })
    const v = emptyView()
    expect(visible(t, { ...v, isFailuresOnly: true }).map(e => e.id)).toEqual(['b'])
    expect(visible(t, { ...v, hiddenThrough: t.seq })).toEqual([])
    expect(t.events.length).toBe(2)
    const list = visible(t, v)
    expect(moveSelection(list, undefined, -1)).toBe('b')
    expect(moveSelection(list, 'b', -1)).toBe('a')
    expect(moveSelection(list, 'a', -5)).toBe('a')
    expect(moveSelection([], 'a', 1)).toBeUndefined()
  })
})

describe('Claude in Chrome through the trail (captured shapes)', () => {
  test('positive: a failed batch marks its steps; typed echoes are not kept', async () => {
    const B = 'mcp__claude-in-chrome__browser_batch'
    const b = classify(B, { actions: [{ name: 'computer', input: { action: 'wait', duration: 1, tabId: 1 } }, { name: 'computer', input: { action: 'screenshot', tabId: 1 } }, { name: 'computer', input: { action: 'left_click', ref: 'ref_99', tabId: 1 } }] })!
    let t = start(empty('s'), 'b', B, b, 0)
    t = finish(t, 'b', { isError: true, text: 'actions[2] (computer:left_click) failed: No element found. (2 completed, 0 remaining)' }, 900, { tool: B, c: b })
    expect(t.events[0]!.steps!.map(s => s.status)).toEqual(['ok', 'ok', 'error'])

    const F = 'mcp__claude-in-chrome__form_input'
    const f = classify(F, { ref: 'ref_1', value: 'tester@example.test', tabId: 1 })!
    t = start(t, 'f', F, f, 1000)
    t = finish(t, 'f', { text: 'Set email value to "tester@example.test" (previous: "")' }, 1100, { tool: F, c: f })
    expect(JSON.stringify(t)).not.toContain('tester@example.test')
  })
})

describe('output cleanup (from a live pane, 2026-10-13)', () => {
  test('positive: Claude Code reminders and Tab Context never reach a preview', async () => {
    const raw = 'Navigated to http://localhost:8765/login.html\n\nTab Context:\n- Executed on tabId: 5\n- Available tabs:\n  • tabId 5: "x" ("http://localhost:8765/login.html")\n<system-reminder>You used a single tool call this turn.</system-reminder>'
    expect(outputPreview(raw)).toBe('Navigated to http://localhost:8765/login.html')
    expect(cleanOutput('ok <system-reminder>unterminated')).toBe('ok')
  })

  test('negative: ordinary output is unchanged', async () => {
    expect(cleanOutput('Clicked on element ref_3')).toBe('Clicked on element ref_3')
  })
})
