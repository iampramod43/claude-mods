// SYNTHETIC fixtures: shaped after each integration's documented tool names
// and arguments, not captured from a live session (none was connected when
// this was written). They prove the adapters, not the integrations.
import { describe, expect, test } from 'claude-code/testing'

import { batchProgress, classify, connectedBrowsers, evidenceOf, pageFromOutput, splitMcp } from './adapters'

describe('classify: Playwright MCP', () => {
  test('positive: navigate, click, type and screenshot', async () => {
    const nav = classify('mcp__playwright__browser_navigate', { url: 'http://localhost:3000/login?token=t0p' })!
    expect(nav.actionType).toBe('NAVIGATE')
    expect(nav.integration).toBe('playwright-mcp')
    expect(nav.requestedUrl).toBe('http://localhost:3000/login?token=redacted')
    expect(nav.summary).toBe('Navigate to localhost:3000/login')
    expect(classify('mcp__playwright__browser_click', { element: 'Sign in button', ref: 'e12' })!.summary).toBe('Click "Sign in button"')
    const typed = classify('mcp__playwright__browser_type', { element: 'Password', ref: 'e7', text: 'hunter2' })!
    expect(typed.actionType).toBe('TYPE')
    expect(typed.summary).not.toContain('hunter2')
    expect(typed.inputSummary).not.toContain('hunter2')
    expect(classify('mcp__pw__browser_take_screenshot', {})!.actionType).toBe('SCREENSHOT')
  })

  test('edge: fill_form names fields but never values', async () => {
    const c = classify('mcp__playwright__browser_fill_form', {
      fields: [
        { name: 'Email', type: 'textbox', ref: 'e1', value: 'me@x.test' },
        { name: 'Password', type: 'textbox', ref: 'e2', value: 'pw!' },
      ],
    })!
    expect(c.summary).toBe('Fill 2 fields: Email, Password')
    expect(JSON.stringify(c)).not.toContain('pw!')
    expect(JSON.stringify(c)).not.toContain('me@x.test')
  })
})

describe('classify: other integrations', () => {
  test('positive: Chrome DevTools MCP and Claude in Chrome', async () => {
    expect(classify('mcp__chrome-devtools__navigate_page', { url: 'https://a.test/' })!.integration).toBe('chrome-devtools-mcp')
    const fill = classify('mcp__chrome-devtools__fill', { uid: '1_4', value: 'secret' })!
    expect(fill.summary).not.toContain('secret')
    const comp = classify('mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [10, 20] })!
    expect(comp.actionType).toBe('CLICK')
    expect(comp.integration).toBe('claude-in-chrome')
    expect(classify('mcp__claude-in-chrome__computer', { action: 'type', text: 'pw' })!.summary).not.toContain('pw ')
  })

  test('positive: browser CLIs in Bash are inferred', async () => {
    const c = classify('Bash', { command: 'agent-browser open https://app.test/?session=abc' })!
    expect(c.classification).toBe('inferred')
    expect(c.actionType).toBe('NAVIGATE')
    expect(c.requestedUrl).not.toContain('abc')
    expect(classify('Bash', { command: 'agent-browser fill @e3 "hunter2"' })!.summary).not.toContain('hunter2')
    expect(classify('Bash', { command: 'npx playwright test e2e/login.spec.ts' })!.actionType).toBe('ASSERT')
  })

  test('negative: unrelated tools are not browser actions', async () => {
    expect(classify('Read', { file_path: '/a' })).toBeUndefined()
    expect(classify('Bash', { command: 'ls -la' })).toBeUndefined()
    expect(classify('mcp__linear__create_issue', { title: 'x' })).toBeUndefined()
    // A generic `click` on a server that is not a browser is left alone.
    expect(classify('mcp__figma__click', {})).toBeUndefined()
  })

  test('edge: an unknown tool on a browser server is one grouped OTHER call', async () => {
    const c = classify('mcp__my-browser__do_everything', { steps: 5 })!
    expect(c.actionType).toBe('OTHER')
    expect(c.summary).toBe('do_everything')
    expect(splitMcp('mcp__a__b__c')).toEqual({ server: 'a__b', name: 'c' })
    expect(splitMcp('Bash')).toBeUndefined()
  })
})

describe('outputs', () => {
  test('positive: Playwright page state is observed', async () => {
    const p = pageFromOutput('### Page state\n- Page URL: http://localhost:3000/dash?token=z\n- Page Title: Dashboard\n', 'browser_click')!
    expect(p.url).toBe('http://localhost:3000/dash?token=redacted')
    expect(p.title).toBe('Dashboard')
    expect(p.confidence).toBe('observed')
  })

  test('negative: no URL in output, no page fact', async () => {
    expect(pageFromOutput('Clicked.', 'x')).toBeUndefined()
  })

  test('edge: evidence counts images and never keeps snapshot text', async () => {
    expect(evidenceOf('SCREENSHOT', [{ type: 'image', data: '…' }], '')).toEqual(['1 image block returned'])
    expect(evidenceOf('SCREENSHOT', [], '')).toEqual(['no image block in result'])
    const ev = evidenceOf('INSPECT', undefined, '- Page Snapshot:\n```yaml\n- button "Go" [ref=e1]\n```')
    expect(ev[0]).toContain('page snapshot in output')
    expect(ev.join()).not.toContain('Go')
  })

  test('connectedBrowsers names browser servers only', async () => {
    expect(connectedBrowsers(['Bash', 'mcp__playwright__browser_click', 'mcp__playwright__browser_snapshot', 'mcp__linear__x'])).toEqual(['playwright'])
    expect(connectedBrowsers(['Read'])).toEqual([])
  })
})

describe('malformed payloads', () => {
  test('edge: wrong types and missing fields never throw', async () => {
    expect(classify('mcp__playwright__browser_navigate', { url: 42 })!.summary).toBe('Navigate to ?')
    expect(classify('mcp__playwright__browser_fill_form', { fields: 'nope' })!.summary).toBe('Fill 0 fields')
    expect(classify('mcp__claude-in-chrome__computer', {})!.actionType).toBe('OTHER')
    expect(classify('mcp__playwright__browser_click', { element: { x: 1 } })!.summary).toBe('Click')
    expect(classify('Bash', { command: undefined })).toBeUndefined()
    expect(classify('mcp__', {})).toBeUndefined()
    expect(pageFromOutput('', 'x')).toBeUndefined()
    expect(evidenceOf('OTHER', { content: 'not-an-array' }, undefined)).toEqual([])
  })
})

describe('Playwright MCP as installed (2026-10-13)', () => {
  test('positive: `target` is the element id in this version', async () => {
    expect(classify('mcp__playwright__browser_click', { target: 'e5' })!.target).toBe('e5')
    expect(classify('mcp__playwright__browser_run_code_unsafe', { code: 'x' })!.summary).toBe('Run Playwright code')
  })
})

// CAPTURED from a live Claude in Chrome session (2026-10-13, extension on
// Windows Chrome, Claude Code in WSL2), sanitized: dummy test values only.
describe('Claude in Chrome, captured', () => {
  const ctx = (tabs: string, extra = '') =>
    `${extra}\n\nTab Context:\n- Executed on tabId: 587716726\n- Available tabs:\n${tabs}`

  test('positive: action_summary labels the row; typed values stay masked', async () => {
    const c = classify('mcp__claude-in-chrome__form_input', { tabId: 587716726, ref: 'ref_2', value: 'hunter2-test', action_summary: 'Sets the password field' })!
    expect(c.summary).toBe('Sets the password field ← ‹12 chars›')
    expect(JSON.stringify(c)).not.toContain('hunter2-test')
    const click = classify('mcp__claude-in-chrome__computer', { tabId: 1, action: 'left_click', ref: 'ref_3', action_summary: 'Clicks the Sign in button' })!
    expect(click.actionType).toBe('CLICK')
    expect(click.summary).toBe('Clicks the Sign in button')
    expect(click.target).toBe('ref_3')
  })

  test('positive: browser_batch is Claude in Chrome, with its steps in order', async () => {
    const c = classify('mcp__claude-in-chrome__browser_batch', {
      actions: [
        { name: 'computer', input: { action: 'wait', duration: 1, tabId: 1 } },
        { name: 'computer', input: { action: 'screenshot', tabId: 1, scale: 0.4 } },
        { name: 'computer', input: { action: 'left_click', ref: 'ref_99', tabId: 1, action_summary: 'Clicks a button that does not exist' } },
      ],
    })!
    expect(c.integration).toBe('claude-in-chrome')
    expect(c.actionType).toBe('BATCH')
    expect(c.steps!.length).toBe(3)
    expect(c.steps![2]).toContain('Clicks a button that does not exist')
  })

  test('positive: the page comes from Tab Context', async () => {
    const p = pageFromOutput(ctx('  • tabId 587716726: "Test Login" ("http://localhost:8765/login.html")', 'Clicked on element ref_3'), 'computer')!
    expect(p.url).toBe('http://localhost:8765/login.html')
    expect(p.title).toBe('Test Login')
    const json = '{"availableTabs":[{"tabId":5,"title":"Dashboard","url":"http://localhost:8765/home.html?email=tester%40example.test&password=REDACTED"}],"selectedTabId":5}\n\nTab Context:\n- Available tabs:\n  • tabId 5: "Dashboard" ("http://localhost:8765/home.html?email=tester%40example.test&password=REDACTED")'
    const d = pageFromOutput(json, 'tabs_context_mcp')!
    expect(d.title).toBe('Dashboard')
    expect(d.url).not.toContain('tester')
  })

  test('negative: two tabs and no executed/selected id is no page fact', async () => {
    const t = '  • tabId 1: "A" ("http://a.test/")\n  • tabId 2: "B" ("http://b.test/")'
    expect(pageFromOutput(`Tab Context:\n- Available tabs:\n${t}`, 'x')).toBeUndefined()
  })

  test('edge: batch progress from its error report', async () => {
    const err = '[computer:wait] Waited for 1 second\n[computer:screenshot] Successfully captured screenshot\n\nactions[2] (computer:left_click) failed: No element found with reference: "ref_99". (2 completed, 0 remaining)'
    expect(batchProgress(3, true, err)).toEqual({ completed: 2, failedAt: 2 })
    expect(batchProgress(3, false, '')).toEqual({ completed: 3, failedAt: undefined })
    expect(batchProgress(3, true, 'tab closed')).toBeUndefined()
  })
})

describe('page titles', () => {
  test('edge: a loading tab whose title is its URL has no title', async () => {
    const p = pageFromOutput('Tab Context:\n- Executed on tabId: 5\n- Available tabs:\n  • tabId 5: "http://localhost:8765/login.html" ("http://localhost:8765/login.html")', 'navigate')!
    expect(p.url).toBe('http://localhost:8765/login.html')
    expect(p.title).toBeUndefined()
  })
})
