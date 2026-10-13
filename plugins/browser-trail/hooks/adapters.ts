// Adapters: turn one tool call into a browser action, only from what the
// tool's name and arguments actually say. Each adapter keys on the tool names
// its integration documents; a name none knows is left unclassified.

import type { ActionType, Confidence, Integration, PageFact } from '../types'
import { mask, preview, redactText, redactUrl, summarizeInput } from './redact'

export type Classified = {
  integration: Integration
  actionType: ActionType
  summary: string
  title?: string
  detail?: string
  target?: string
  // The URL a navigate call asked for; not proof the page got there.
  requestedUrl?: string
  inputSummary: string
  classification: Confidence
  // Sub-steps a batch call lists in its own input, in order (requested).
  steps?: string[]
}

type Args = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const label = (v: unknown, max = 40) => {
  const s = str(v)
  return s ? preview(redactText(s), max) : undefined
}
const quoted = (v: unknown) => {
  const s = label(v)
  return s ? `"${s}"` : undefined
}
const safeUrl = (v: unknown) => {
  const s = str(v)
  return s ? redactUrl(s) : undefined
}
const urlPath = (u: string) => {
  try {
    const p = new URL(u)
    return `${p.host}${p.pathname === '/' ? '' : p.pathname}`
  } catch {
    return preview(u, 50)
  }
}

export const splitMcp = (tool: string) => {
  if (!tool.startsWith('mcp__')) return undefined
  const rest = tool.slice(5)
  const cut = rest.lastIndexOf('__')
  if (cut <= 0) return undefined
  return { server: rest.slice(0, cut), name: rest.slice(cut + 2) }
}

type Rule = (a: Args) => {
  actionType: ActionType
  summary: string
  title?: string
  detail?: string
  target?: string
  requestedUrl?: string
  steps?: string[]
}

const on = (target: string | undefined) => (target ? ` ${target}` : '')

// Playwright MCP (@playwright/mcp): tools named browser_*; `element` is the
// model's own description of the target, `ref` the snapshot's id for it.
const PLAYWRIGHT: Record<string, Rule> = {
  browser_navigate: a => ({ actionType: 'NAVIGATE', summary: `Navigate to ${urlPath(safeUrl(a.url) ?? '?')}`, requestedUrl: safeUrl(a.url) }),
  browser_navigate_back: () => ({ actionType: 'NAVIGATE', summary: 'Go back' }),
  browser_navigate_forward: () => ({ actionType: 'NAVIGATE', summary: 'Go forward' }),
  browser_click: a => ({ actionType: 'CLICK', summary: `${a.doubleClick ? 'Double-click' : 'Click'}${on(quoted(a.element))}`, target: label(a.element) ?? str(a.target) ?? str(a.ref) }),
  browser_hover: a => ({ actionType: 'OTHER', summary: `Hover${on(quoted(a.element))}`, target: label(a.element) ?? str(a.target) ?? str(a.ref) }),
  browser_drag: a => ({ actionType: 'OTHER', summary: `Drag ${quoted(a.startElement) ?? '?'} → ${quoted(a.endElement) ?? '?'}` }),
  browser_type: a => ({ actionType: 'TYPE', summary: `Type ${mask(a.text)} into${on(quoted(a.element))}`, target: label(a.element) ?? str(a.target) ?? str(a.ref) }),
  browser_fill_form: a => {
    const fields = Array.isArray(a.fields) ? a.fields : []
    const names = fields.map(f => label((f as Args)?.name, 20)).filter(Boolean)
    return { actionType: 'TYPE', summary: `Fill ${fields.length} field${fields.length === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}` }
  },
  browser_select_option: a => ({ actionType: 'TYPE', summary: `Select option in${on(quoted(a.element))}`, target: label(a.element) }),
  browser_press_key: a => ({ actionType: 'KEYPRESS', summary: `Press ${label(a.key, 20) ?? 'key'}` }),
  browser_snapshot: () => ({ actionType: 'INSPECT', summary: 'Read accessibility snapshot' }),
  browser_take_screenshot: a => ({ actionType: 'SCREENSHOT', summary: `Screenshot${a.element ? ` of ${quoted(a.element)}` : a.fullPage ? ' (full page)' : ''}` }),
  browser_wait_for: a => ({
    actionType: 'WAIT',
    summary: a.text ? `Wait for text ${quoted(a.text)}` : a.textGone ? `Wait for ${quoted(a.textGone)} to go` : `Wait ${a.time ?? '?'}s`,
  }),
  browser_evaluate: () => ({ actionType: 'INSPECT', summary: 'Evaluate JavaScript' }),
  browser_console_messages: () => ({ actionType: 'INSPECT', summary: 'Read console messages' }),
  browser_network_requests: () => ({ actionType: 'INSPECT', summary: 'Read network requests' }),
  browser_tabs: a => ({ actionType: 'TAB', summary: `Tabs: ${label(a.action, 12) ?? 'list'}` }),
  browser_close: () => ({ actionType: 'TAB', summary: 'Close page' }),
  browser_resize: a => ({ actionType: 'OTHER', summary: `Resize to ${a.width}×${a.height}` }),
  browser_file_upload: () => ({ actionType: 'OTHER', summary: 'Upload file(s)' }),
  browser_handle_dialog: a => ({ actionType: 'OTHER', summary: `${a.accept ? 'Accept' : 'Dismiss'} dialog` }),
  browser_find: a => ({ actionType: 'INSPECT', summary: `Find ${quoted(a.text ?? a.query) ?? 'elements'}` }),
  browser_drop: () => ({ actionType: 'OTHER', summary: 'Drop onto element' }),
  browser_network_request: () => ({ actionType: 'INSPECT', summary: 'Read network request' }),
  browser_run_code_unsafe: () => ({ actionType: 'OTHER', summary: 'Run Playwright code' }),
  browser_emulate_media: () => ({ actionType: 'OTHER', summary: 'Emulate media' }),
}

// Chrome DevTools MCP (chrome-devtools-mcp): `uid` names a snapshot element.
const DEVTOOLS: Record<string, Rule> = {
  navigate_page: a => ({ actionType: 'NAVIGATE', summary: a.url ? `Navigate to ${urlPath(safeUrl(a.url)!)}` : `Navigate ${label(a.type, 12) ?? ''}`.trim(), requestedUrl: safeUrl(a.url) }),
  new_page: a => ({ actionType: 'TAB', summary: `New page ${urlPath(safeUrl(a.url) ?? '?')}`, requestedUrl: safeUrl(a.url) }),
  select_page: a => ({ actionType: 'TAB', summary: `Select page ${a.pageIdx ?? a.pageId ?? '?'}` }),
  close_page: () => ({ actionType: 'TAB', summary: 'Close page' }),
  list_pages: () => ({ actionType: 'TAB', summary: 'List pages' }),
  click: a => ({ actionType: 'CLICK', summary: `Click ${label(a.uid, 20) ?? ''}`.trim(), target: label(a.uid, 20) }),
  hover: a => ({ actionType: 'OTHER', summary: `Hover ${label(a.uid, 20) ?? ''}`.trim(), target: label(a.uid, 20) }),
  drag: () => ({ actionType: 'OTHER', summary: 'Drag element' }),
  fill: a => ({ actionType: 'TYPE', summary: `Fill ${label(a.uid, 20) ?? ''} with ${mask(a.value)}`, target: label(a.uid, 20) }),
  fill_form: a => ({ actionType: 'TYPE', summary: `Fill ${Array.isArray(a.elements) ? a.elements.length : '?'} fields` }),
  press_key: a => ({ actionType: 'KEYPRESS', summary: `Press ${label(a.key, 20) ?? 'key'}` }),
  upload_file: () => ({ actionType: 'OTHER', summary: 'Upload file' }),
  handle_dialog: a => ({ actionType: 'OTHER', summary: `${label(a.action, 10) ?? 'Handle'} dialog` }),
  take_snapshot: () => ({ actionType: 'INSPECT', summary: 'Read page snapshot' }),
  take_screenshot: () => ({ actionType: 'SCREENSHOT', summary: 'Screenshot' }),
  wait_for: a => ({ actionType: 'WAIT', summary: `Wait for text ${quoted(a.text) ?? ''}`.trim() }),
  evaluate_script: () => ({ actionType: 'INSPECT', summary: 'Evaluate script' }),
  list_console_messages: () => ({ actionType: 'INSPECT', summary: 'Read console messages' }),
  get_console_message: () => ({ actionType: 'INSPECT', summary: 'Read console message' }),
  list_network_requests: () => ({ actionType: 'INSPECT', summary: 'Read network requests' }),
  get_network_request: () => ({ actionType: 'INSPECT', summary: 'Read network request' }),
  resize_page: () => ({ actionType: 'OTHER', summary: 'Resize page' }),
}

// Claude in Chrome: `computer` carries the low-level action in `action`.
const COMPUTER: Record<string, ActionType> = {
  left_click: 'CLICK',
  right_click: 'CLICK',
  double_click: 'CLICK',
  triple_click: 'CLICK',
  type: 'TYPE',
  key: 'KEYPRESS',
  scroll: 'SCROLL',
  scroll_to: 'SCROLL',
  screenshot: 'SCREENSHOT',
  zoom: 'SCREENSHOT',
  wait: 'WAIT',
  hover: 'OTHER',
  left_click_drag: 'OTHER',
}
// Claude in Chrome asks the model for an `action_summary` on clicks, keys,
// typing and form fills: a short description of the effect, used as the row
// label when present (redacted; typed values stay masked alongside).
const said = (a: Args) => label(a.action_summary, 50)
const VERB: Record<string, string> = {
  left_click: 'Click',
  right_click: 'Right-click',
  double_click: 'Double-click',
  triple_click: 'Triple-click',
  type: 'Type text',
  key: 'Press key',
  scroll: 'Scroll',
  scroll_to: 'Scroll to element',
  screenshot: 'Screenshot',
  zoom: 'Zoomed screenshot',
  wait: 'Wait',
  hover: 'Hover',
  left_click_drag: 'Drag',
}
const CHROME: Record<string, Rule> = {
  navigate: a => {
    const u = str(a.url)
    if (u === 'back' || u === 'forward') return { actionType: 'NAVIGATE', summary: `Go ${u}`, title: `Go ${u}`, detail: 'browser history' }
    const path = urlPath(safeUrl(a.url) ?? '?')
    return { actionType: 'NAVIGATE', summary: `Navigate to ${path}`, title: 'Navigate', detail: path, requestedUrl: safeUrl(a.url) }
  },
  computer: a => {
    const action = str(a.action) ?? '?'
    const actionType = COMPUTER[action] ?? 'OTHER'
    const where = str(a.ref) ?? (Array.isArray(a.coordinate) ? `(${a.coordinate.join(',')})` : undefined)
    const what = actionType === 'TYPE' ? ` ${mask(a.text)}` : actionType === 'KEYPRESS' ? ` ${label(a.text, 20) ?? ''}` : ''
    const own = said(a)
    const summary = own ? `${own}${actionType === 'TYPE' ? what : ''}` : `${action}${what}${where ? ` at ${where}` : ''}`
    const verb = VERB[action] ?? action
    const how = [
      `${verb.toLowerCase()}${where ? ` ${where}` : ''}`,
      actionType === 'TYPE' ? 'value redacted' : actionType === 'KEYPRESS' ? label(a.text, 20) : undefined,
      action === 'wait' && a.duration !== undefined ? `${a.duration}s` : undefined,
    ].filter(Boolean)
    return { actionType, summary, title: own ?? verb, detail: how.join(' · '), target: where }
  },
  read_page: a => ({ actionType: 'INSPECT', summary: 'Read page structure', title: 'Inspect page', detail: `read page structure${a.filter ? ` · ${label(a.filter, 12)}` : ''}` }),
  get_page_text: () => ({ actionType: 'INSPECT', summary: 'Read page text', title: 'Read page text', detail: 'text read, not stored' }),
  find: a => ({ actionType: 'INSPECT', summary: `Find ${quoted(a.query) ?? ''}`.trim(), title: 'Find elements', detail: quoted(a.query) ?? '' }),
  form_input: a => ({
    actionType: 'TYPE',
    summary: `${said(a) ?? `Set ${label(a.ref, 20) ?? 'field'}`} ← ${mask(a.value)}`,
    title: said(a) ?? 'Fill field',
    detail: `${label(a.ref, 20) ?? 'field'} · value redacted`,
    target: label(a.ref, 20),
  }),
  javascript_tool: () => ({ actionType: 'INSPECT', summary: 'Run JavaScript', title: 'Run JavaScript', detail: 'script on the page' }),
  read_console_messages: a => ({ actionType: 'INSPECT', summary: 'Read console messages', title: 'Read console', detail: a.pattern ? `pattern ${quoted(a.pattern)}` : 'console messages' }),
  read_network_requests: () => ({ actionType: 'INSPECT', summary: 'Read network requests', title: 'Read network', detail: 'network requests' }),
  tabs_context_mcp: () => ({ actionType: 'TAB', summary: 'Read tab context', title: 'Read tab context', detail: 'identify the active browser tab' }),
  tabs_create_mcp: () => ({ actionType: 'TAB', summary: 'Open tab', title: 'Open tab', detail: 'new tab in the group' }),
  tabs_close_mcp: a => ({ actionType: 'TAB', summary: `Close tab ${a.tabId ?? ''}`.trim(), title: 'Close tab', detail: a.tabId !== undefined ? `tab ${a.tabId}` : 'tab' }),
  list_connected_browsers: () => ({ actionType: 'TAB', summary: 'List connected browsers', title: 'List browsers', detail: 'connected browsers' }),
  select_browser: () => ({ actionType: 'TAB', summary: 'Select browser', title: 'Select browser', detail: 'browser choice' }),
  switch_browser: () => ({ actionType: 'TAB', summary: 'Switch browser', title: 'Switch browser', detail: 'browser choice' }),
  resize_window: a => ({ actionType: 'OTHER', summary: 'Resize window', title: 'Resize window', detail: a.width ? `${a.width}×${a.height}` : 'window' }),
  file_upload: () => ({ actionType: 'OTHER', summary: 'Upload file', title: 'Upload file', detail: 'file input' }),
  upload_image: () => ({ actionType: 'OTHER', summary: 'Upload image', title: 'Upload image', detail: 'image input' }),
  gif_creator: a => ({ actionType: 'SCREENSHOT', summary: `GIF recording: ${label(a.action, 12) ?? '?'}`, title: 'GIF recording', detail: label(a.action, 12) ?? '' }),
  shortcuts_list: () => ({ actionType: 'OTHER', summary: 'List shortcuts', title: 'List shortcuts', detail: 'shortcuts' }),
  shortcuts_execute: () => ({ actionType: 'OTHER', summary: 'Run shortcut', title: 'Run shortcut', detail: 'shortcut' }),
  // One call, several tools run in order, stopping at the first error. The
  // steps come from the call's own input, each labelled by the same rules.
  browser_batch: a => {
    const items = Array.isArray(a.actions) ? (a.actions as unknown[]) : []
    const parts = items.map(item => {
      const it = (item ?? {}) as { name?: unknown; input?: unknown }
      const name = str(it.name) ?? '?'
      const input = it.input && typeof it.input === 'object' ? (it.input as Args) : {}
      const rule = name === 'browser_batch' ? undefined : CHROME[name]
      const r = rule?.(input)
      return { step: r ? `${r.actionType.padEnd(10)} ${r.summary}` : `OTHER      ${preview(name, 30)}`, short: r?.title ?? name }
    })
    const n = parts.length
    return {
      actionType: 'BATCH',
      summary: `Batch of ${n} step${n === 1 ? '' : 's'}`,
      title: `Batch · ${n} step${n === 1 ? '' : 's'}`,
      detail: preview(parts.map(x => x.short).join(' → '), 80),
      steps: parts.map(x => x.step),
    }
  },
}

const BROWSERISH = /browser|playwright|puppeteer|chrome|chromium|selenium|webdriver/i

const fromMcp = (tool: string, a: Args): Classified | undefined => {
  const parts = splitMcp(tool)
  if (!parts) return undefined
  const { server, name } = parts
  const pick = (integration: Integration, rules: Record<string, Rule>): Classified | undefined => {
    const rule = rules[name]
    if (!rule) return undefined
    return { integration, ...rule(a), inputSummary: summarizeInput(a), classification: 'observed' }
  }
  // Server first: Claude in Chrome also has a `browser_*` tool (browser_batch).
  const known =
    (/claude[-_]?in[-_]?chrome/i.test(server) ? pick('claude-in-chrome', CHROME) : undefined) ??
    (name.startsWith('browser_') ? pick('playwright-mcp', PLAYWRIGHT) : undefined) ??
    (/devtools|chrome/i.test(server) ? pick('chrome-devtools-mcp', DEVTOOLS) : undefined)
  if (known) return known
  // A browser-looking server or tool this file has no rule for: one grouped
  // call under its own name, never a guessed action.
  if (BROWSERISH.test(server) || name.startsWith('browser_')) {
    return { integration: 'browser-mcp', actionType: 'OTHER', summary: name, inputSummary: summarizeInput(a), classification: 'observed' }
  }
  return undefined
}

// Bash commands driving a browser CLI. Inferred: the command line says what
// was asked for, and one command can do many things.
const AGENT_BROWSER: Record<string, ActionType> = {
  open: 'NAVIGATE',
  goto: 'NAVIGATE',
  navigate: 'NAVIGATE',
  back: 'NAVIGATE',
  forward: 'NAVIGATE',
  reload: 'NAVIGATE',
  click: 'CLICK',
  dblclick: 'CLICK',
  fill: 'TYPE',
  type: 'TYPE',
  select: 'TYPE',
  press: 'KEYPRESS',
  scroll: 'SCROLL',
  snapshot: 'INSPECT',
  get: 'INSPECT',
  eval: 'INSPECT',
  screenshot: 'SCREENSHOT',
  wait: 'WAIT',
  tab: 'TAB',
  close: 'TAB',
}

const fromBash = (command: string): Classified | undefined => {
  const ab = command.match(/(?:^|[;&|]\s*|\s)(?:npx\s+(?:-y\s+)?)?agent-browser\s+([a-z-]+)(.*)/)
  if (ab) {
    const sub = ab[1]!
    const rest = ab[2] ?? ''
    const actionType = AGENT_BROWSER[sub] ?? 'OTHER'
    const url = rest.match(/https?:\/\/\S+/)?.[0]
    const shownRest = actionType === 'TYPE' ? '' : ` ${preview(redactText(rest.split(/[;&|]/)[0]!.trim()), 40)}`
    return {
      integration: 'browser-cli',
      actionType,
      summary: `agent-browser ${sub}${shownRest}`.trim(),
      requestedUrl: actionType === 'NAVIGATE' && url ? redactUrl(url) : undefined,
      inputSummary: preview(redactText(command), 300),
      classification: 'inferred',
    }
  }
  if (/(?:^|[;&|]\s*|\s)(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+|bunx\s+)?playwright\s+test\b/.test(command)) {
    return {
      integration: 'browser-cli',
      actionType: 'ASSERT',
      summary: 'Run Playwright tests',
      inputSummary: preview(redactText(command), 300),
      classification: 'inferred',
    }
  }
  return undefined
}

export const classify = (tool: string, input: Args): Classified | undefined => {
  if (tool === 'Bash' && typeof input.command === 'string') return fromBash(input.command)
  return fromMcp(tool, input)
}

// The generic fallback: any tool call, under its own name.
export const genericCall = (tool: string, input: Args): Classified => {
  const inputSummary = summarizeInput(input)
  const brief = typeof input.command === 'string' ? `$ ${preview(redactText(input.command), 60)}` : preview(inputSummary, 60)
  // Bash and Agent carry the model's own one-line description: the title.
  const said = label(input.description, 50)
  return {
    integration: 'tool',
    actionType: 'OTHER',
    summary: brief ? `${tool} · ${brief}` : tool,
    title: said ?? tool,
    detail: said ? brief : brief || tool,
    inputSummary,
    classification: 'observed',
  }
}

// Browser tools among a tool list, by server (or `Bash CLI`), for the header.
export const connectedBrowsers = (names: string[]) => {
  const found = new Set<string>()
  for (const n of names) {
    const c = fromMcp(n, {})
    if (c) found.add(splitMcp(n)!.server)
  }
  return [...found].sort()
}

// What a tool's result says about the page, when it says anything.
// Playwright MCP prints "- Page URL: …" / "- Page Title: …" after actions;
// Chrome DevTools MCP's page list marks the current one "[selected]".
export const pageFromOutput = (text: string, via: string): PageFact | undefined => {
  // A tab still loading reports its URL as its title: no title then.
  const fact = (url: string, title: string | undefined): PageFact => ({
    url: redactUrl(url),
    title: title && title !== url && !/^https?:\/\//.test(title) ? preview(redactText(title), 60) : undefined,
    confidence: 'observed',
    via,
  })
  const pw = text.match(/Page URL:\s*(\S+)/)?.[1]
  if (pw) return fact(pw, text.match(/Page Title:\s*(.+)/)?.[1]?.trim())
  const dt = text.match(/^\s*\d+:\s*(\S+)\s*\[selected\]/m)?.[1]
  if (dt) return fact(dt, undefined)
  // Claude in Chrome appends "Tab Context" listing `tabId N: "title" ("url")`
  // and names the tab it acted on ("Executed on tabId: N") or the selected
  // one ("selectedTabId":N). With neither, a single listed tab is the page.
  const tabs = [...text.matchAll(/tabId (\d+): "(.*)" \("([^"]+)"\)/g)].map(m => ({ id: m[1]!, title: m[2], url: m[3]! }))
  if (tabs.length === 0) return undefined
  const on = text.match(/Executed on tabId: (\d+)/)?.[1] ?? text.match(/"selectedTabId":\s*(\d+)/)?.[1]
  const tab = on ? tabs.find(t => t.id === on) : tabs.length === 1 ? tabs[0] : undefined
  return tab ? fact(tab.url, tab.title) : undefined
}

// How far a batch got, from its own report: "actions[i] (…) failed" and
// "(N completed, M remaining)". A batch that returned without error ran
// every step. Undefined when the text says neither.
export const batchProgress = (count: number, isError: boolean, text: string) => {
  if (!isError) return { completed: count, failedAt: undefined as number | undefined }
  const failedAt = text.match(/actions\[(\d+)\][^\n]*failed/)?.[1]
  const completed = text.match(/\((\d+) completed/)?.[1]
  if (failedAt === undefined && completed === undefined) return undefined
  return { completed: completed !== undefined ? Number(completed) : Number(failedAt), failedAt: failedAt !== undefined ? Number(failedAt) : undefined }
}

// What a result holds that could back a claim about the page: images
// (screenshots) and snapshots. Never the content itself.
export const evidenceOf = (actionType: ActionType, result: unknown, text: string | undefined): string[] => {
  const out: string[] = []
  const blocks = Array.isArray(result) ? result : Array.isArray((result as { content?: unknown })?.content) ? (result as { content: unknown[] }).content : []
  const images = blocks.filter(b => (b as { type?: unknown })?.type === 'image').length
  if (images) out.push(`${images} image block${images === 1 ? '' : 's'} returned`)
  if (text && /Page Snapshot|```yaml|\buid=|\[ref=/.test(text)) out.push(`page snapshot in output (${text.split('\n').length} lines, not stored)`)
  if (actionType === 'SCREENSHOT' && !images) out.push('no image block in result')
  return out
}
