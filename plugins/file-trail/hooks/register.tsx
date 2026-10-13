import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { Active, Op } from '../types'
import {
  ancestors,
  bashCandidates,
  buildRows,
  empty,
  isFresh,
  LINGER_MS,
  record,
  relPath,
  removeActive,
  sortEntries,
  strongest,
  total,
} from './trail'

const PANE = 'file-trail'
const trail = atom({ plugin: 'file-trail', key: 'trail' } as const, empty())
const tick = atom({ plugin: 'file-trail', key: 'tick' } as const, 0)

const OP_STYLE: Record<Op, { letter: string; color: string; verb: string }> = {
  write: { letter: 'W', color: 'green', verb: 'writing' },
  edit: { letter: 'E', color: 'yellow', verb: 'editing' },
  read: { letter: 'R', color: 'cyan', verb: 'reading' },
  search: { letter: 'S', color: 'magenta', verb: 'searching' },
}

const kindOf = async ($: EngineInterface, abs: string) => {
  try {
    return (await $.fs.stat(abs)).kind
  } catch {
    return undefined
  }
}

// What a tool call touches, as repo-relative paths; `outside` counts paths
// that fall outside the repo.
const targetsOf = async ($: EngineInterface, e: ToolCallInput, root: string) => {
  const raw: { path: string; op: Op; bare?: true }[] = []
  if (e.tool === 'Read') raw.push({ path: e.file_path, op: 'read' })
  else if (e.tool === 'Edit') raw.push({ path: e.file_path, op: 'edit' })
  else if (e.tool === 'Write') raw.push({ path: e.file_path, op: 'write' })
  else if (e.tool === 'NotebookEdit') raw.push({ path: e.notebook_path, op: 'edit' })
  else if (e.tool === 'Bash') for (const c of bashCandidates(e.command)) raw.push({ path: c.token, op: c.op, bare: c.bare })

  const targets: Active[] = []
  const dirs = new Set<string>()
  let outside = 0
  for (const { path, op, bare } of raw) {
    const rel = relPath(root, path)
    if (rel === undefined) {
      if (path.startsWith('/')) outside++
      continue
    }
    if (rel === '' || targets.some(t => t.path === rel)) continue
    const kind = await kindOf($, `${root}/${rel}`)
    if (kind === 'dir') {
      targets.push({ path: rel, op: 'search' })
      dirs.add(rel)
    } else if (kind === 'file' || (op === 'write' && !bare)) targets.push({ path: rel, op })
  }

  return { targets, dirs, outside }
}

const sizeOf = async ($: EngineInterface, abs: string) => {
  try {
    return (await $.fs.list(abs)).length
  } catch {
    return 0
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const root = started.cwd.replace(/\/$/, '')
    let entries: { name: string; isDir: boolean }[] = []
    try {
      entries = (await $.fs.list(root))
        .filter(f => f.name !== '.git')
        .map(f => ({ name: f.name, isDir: f.kind === 'dir' }))
    } catch {}
    await update($, trail, t => ({
      ...(t.root === root ? t : empty(root)),
      root,
      rootEntries: sortEntries(entries),
      active: {},
    }))
    await $.command.register({
      name: 'file-trail',
      description: 'Show the files Claude touches in a live repo tree; `clear` resets it',
      argumentHint: '[clear]',
    })
    void $.ui.open({ id: PANE, title: 'File trail' })

    return started
  })

  on('command.run', { command: 'file-trail' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, trail, t => ({ ...empty(t.root), rootEntries: t.rootEntries }))
      return { text: 'File trail cleared.' }
    }
    await $.ui.open({ id: PANE, title: 'File trail' })

    return { text: 'File trail opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const { root } = await read($, trail)
    if (!root) return next(e)
    const { targets, dirs, outside } = await targetsOf($, e, root)
    if (targets.length === 0) {
      if (outside) await update($, trail, t => ({ ...t, outside: t.outside + outside }))
      return next(e)
    }

    // Folder sizes for the "… N more" rows, listed once per folder.
    const known = (await read($, trail)).sizes
    const sizes: Record<string, number> = {}
    for (const dir of new Set([...targets.flatMap(t => ancestors(t.path)), ...dirs])) {
      if (known[dir] === undefined) sizes[dir] = await sizeOf($, `${root}/${dir}`)
    }

    const id = e.tool_use_id ?? `call-${Math.random().toString(36).slice(2)}`
    await update($, trail, t => ({
      ...t,
      sizes: { ...t.sizes, ...sizes },
      active: { ...t.active, [id]: targets },
      outside: t.outside + outside,
    }))
    try {
      const ran = await next(e)
      const at = await $.clock.now()
      await update($, trail, t => {
        let out = { ...t, active: removeActive(t.active, id) }
        if (ran.deny === undefined) for (const a of targets) out = record(out, a.path, a.op, dirs.has(a.path), at)
        return out
      })
      // Redraw once the highlight has run its course.
      $.clock.after(LINGER_MS + 100, () => void update($, tick, n => n + 1))
      return ran
    } catch (err) {
      await update($, trail, t => ({ ...t, active: removeActive(t.active, id) }))
      throw err
    }
  }).catch(($, e, next) => next(e)) // Observes only: a failure here never stops the tool.

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const t = await read($, trail)
    await read($, tick)
    const now = await $.clock.now()
    const rows = buildRows(t)
    const touched = Object.values(t.touches)
    const recent = new Set(
      Object.entries(t.touches)
        .sort((a, b) => b[1].last - a[1].last)
        .slice(0, 3)
        .map(([p]) => p),
    )
    const counts = { write: 0, edit: 0, read: 0, search: 0 }
    for (const touch of touched) counts[strongest(touch)]++
    const working = Object.values(t.active).flat()
    const repo = t.root.split('/').pop() || t.root

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>📂 {repo}</Text>
          <Text dimColor>
            {'  '}
            {touched.length} touched
          </Text>
        </Text>
        <Text>
          {(['read', 'edit', 'write', 'search'] as const).map(op => (
            <Text>
              <Text color={OP_STYLE[op].color} bold>
                {OP_STYLE[op].letter}
              </Text>
              <Text dimColor> {counts[op]}  </Text>
            </Text>
          ))}
        </Text>
        {working.length > 0 ? (
          <Text wrap="truncate-start">
            <Text color={OP_STYLE[working[0]!.op].color} bold>
              ▶ {OP_STYLE[working[0]!.op].verb}
            </Text>{' '}
            {working[0]!.path}
            {working.length > 1 && <Text dimColor> +{working.length - 1}</Text>}
          </Text>
        ) : (
          <Text dimColor>· idle</Text>
        )}
        <Text> </Text>
        {rows.map(r => {
          if (r.more !== undefined) {
            return (
              <Text key={r.key} wrap="truncate-end">
                <Text dimColor>
                  {r.guide}… {r.more} more
                </Text>
              </Text>
            )
          }
          const op = r.active ?? (r.touch ? strongest(r.touch) : undefined)
          const style = op ? OP_STYLE[op] : undefined
          const isRecent = recent.has(r.path)
          const lit = Boolean(r.active) || isFresh(r.touch, now)
          return (
            <Text key={r.key} wrap="truncate-end">
              <Text dimColor>{r.guide}</Text>
              <Text
                color={lit ? 'black' : style?.color}
                backgroundColor={lit ? style?.color : undefined}
                bold={lit || isRecent || r.isOpen}
                dimColor={!op && !r.isOpen}
              >
                {r.name}
              </Text>
              {r.active ? (
                <Text color={style?.color} bold>
                  {' '}
                  ◀ {style?.verb}
                </Text>
              ) : (
                r.touch && (
                  <Text color={style?.color}>
                    {' '}
                    {style?.letter}
                    {total(r.touch) > 1 ? <Text dimColor>×{total(r.touch)}</Text> : null}
                  </Text>
                )
              )}
            </Text>
          )
        })}
        {t.outside > 0 && (
          <Text dimColor>
            {'\n'}+{t.outside} outside the repo
          </Text>
        )}
      </Box>
    )
  })
}
