import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { classify, connectedBrowsers, genericCall, splitMcp } from './adapters'
import { drawPane } from './pane'
import { cutOff, empty, emptyView, finish, start } from './trail'

const PANE = 'browser-trail'
// Requested sizes (the person's own drag wins): a dock wide enough for the
// timeline and inspector side by side, and an inline block that shows them.
const WIDE_COLS = 120
const INLINE_ROWS = 30
const TITLE = 'Browser trail'
const trail = atom({ plugin: 'browser-trail', key: 'trail' } as const, empty())
const view = atom({ plugin: 'browser-trail', key: 'view' } as const, emptyView())
const tick = atom({ plugin: 'browser-trail', key: 'tick' } as const, 0)
const isLight = atom({ plugin: 'browser-trail', key: 'isLight' } as const, false)

// Card fills follow the theme's brightness; read at start and on open.
const readTheme = async ($: EngineInterface) => {
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')
    const light = typeof row?.value === 'string' && /light/i.test(row.value)
    if (light !== (await read($, isLight))) await update($, isLight, () => light)
  } catch {}
}

// Browser tools can connect mid-session (/chrome, /mcp): the list is read
// again on a timer and on /browser-trail, not only at start.
const refreshConnected = async ($: EngineInterface) => {
  try {
    const names = (await $.tool.list()).map(t => t.name)
    const connected = connectedBrowsers(names)
    const t = await read($, trail)
    if (connected.join() !== t.connected.join()) await update($, trail, old => ({ ...old, connected }))
  } catch {}
}

// The trail belongs to one session: a call under another id (after /clear)
// starts a fresh one rather than mixing the two.
const ensureSession = async ($: EngineInterface) => {
  const sid = await $.session.id()
  const t = await read($, trail)
  if (t.sessionId !== sid) await update($, trail, old => ({ ...empty(sid), connected: old.connected }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const sid = await $.session.id()
    let names: string[] = []
    try {
      names = (await $.tool.list()).map(t => t.name)
    } catch {}
    let startedAt: number | undefined
    try {
      startedAt = (await $.session.usage()).startedAt
    } catch {}
    // Same session (a reload): calls still running lost their hook and their
    // result. Another session: start over.
    await update($, trail, t =>
      t.sessionId === sid
        ? { ...cutOff({ ...empty(sid), ...t }, 'session-restart'), isEnded: false, connected: connectedBrowsers(names), startedAt }
        : { ...empty(sid), connected: connectedBrowsers(names), startedAt },
    )
    await update($, view, v => ({ ...emptyView(), ...v }))
    await readTheme($)
    await $.command.register({
      name: 'browser-trail',
      description: 'Show a live timeline of the browser tool calls Claude makes; `all` toggles every tool call, `clear` hides the list',
      argumentHint: '[all|clear]',
    })
    // Redraw once a second while a call runs (its duration counts up), and
    // once more when LIVE turns IDLE.
    let beats = 0
    $.clock.every(1000, () => {
      void (async () => {
        if (++beats % 30 === 0) await refreshConnected($)
        const t = await read($, trail)
        const now = await $.clock.now()
        if (t.events.some(ev => ev.status === 'running') || (t.lastAt && now - t.lastAt < 62_000)) await update($, tick, n => n + 1)
      })()
    })

    return started
  })

  on('session.end', async ($, e, next) => {
    await update($, trail, t => ({ ...cutOff(t, 'session-end'), isEnded: true }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'browser-trail' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      const { seq } = await read($, trail)
      await update($, view, v => ({ ...v, hiddenThrough: seq, selected: undefined }))
      return { text: 'Browser trail list cleared (nothing deleted).' }
    }
    if (arg === 'all') {
      const v = await update($, view, v => ({ ...v, isAllTools: !v.isAllTools }))
      return { text: v.isAllTools ? 'Browser trail now records every tool call.' : 'Browser trail now records browser tool calls only.' }
    }
    await refreshConnected($)
    await readTheme($)
    // Focused, so its keys work at once (granted only over an empty prompt).
    await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: WIDE_COLS, rows: INLINE_ROWS })

    return { text: 'Browser trail opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const v = await read($, view)
    const c = classify(e.tool, input) ?? (v.isAllTools ? genericCall(e.tool, input) : undefined)
    if (!c) return next(e)

    await ensureSession($)
    const id = e.tool_use_id ?? `call-${Math.random().toString(36).slice(2)}`
    const before = await read($, trail)
    const at = await $.clock.now()
    const server = c.integration !== 'tool' && c.integration !== 'browser-cli' ? splitMcp(e.tool)?.server : undefined
    await update($, trail, t => {
      const started = start(t, id, e.tool, c, at)
      return server && !started.connected.includes(server) ? { ...started, connected: [...started.connected, server].sort() } : started
    })
    if (before.events.length === 0 && c.integration !== 'tool') void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

    let ran
    try {
      ran = await next(e)
    } catch (err) {
      const done = await $.clock.now()
      await update($, trail, t => finish(t, id, { isError: true, text: 'the call was interrupted or aborted' }, done, { tool: e.tool, c }))
      throw err
    }
    try {
      const done = await $.clock.now()
      await update($, trail, t =>
        finish(
          t,
          id,
          { isError: ran.isError === true, isDenied: ran.deny !== undefined, text: ran.deny ?? ran.text, result: ran.result },
          done,
          { tool: e.tool, c },
        ),
      )
    } catch {
      await update($, trail, t => cutOff(t, 'hook-failure', [id]))
    }
    return ran
  }).catch(($, e, next) => next(e)) // Observes only: replay-safe, a failure here never stops or reruns the tool.

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const t = await read($, trail)
    const v = await read($, view)
    const n = await read($, tick)
    const now = await $.clock.now()
    const props = e.props as { bodyColumns?: number; scroll?: { bodyRows?: number } }
    return drawPane(els, {
      t,
      v,
      now,
      tick: n,
      isLight: await read($, isLight),
      cols: props.bodyColumns ?? e.viewport?.columns ?? 100,
      rows: props.scroll?.bodyRows ?? Math.max(10, (e.viewport?.rows ?? 30) - 6),
      setView: fn => void update($, view, fn),
      close: () => void $.ui.close({ id: PANE }).catch(() => undefined),
    })
  })
}
