import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { LiveSnapshot } from '../types'

const NOW = 1_800_000_000_000
const iso = (ago: number) => new Date(NOW - ago).toISOString()

const PANE = {
  plugin: 'worktree-deck',
  component: 'Pane',
  requestId: 'worktree-deck',
  props: {
    title: 'Worktree Deck',
    isFocused: true,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const PROJECTS = '/home/u/.claude/projects'
const LIVE = '/home/u/.claude/worktree-deck/live'

// The feature worktree's session: started in a subfolder, so its project
// folder is "-r--wt-feat-src", matched by the cwd its records carry.
const transcript = [
  JSON.stringify({ type: 'ai-title', aiTitle: 'Retry uploads' }),
  JSON.stringify({ type: 'user', uuid: 'u1', timestamp: iso(9000), cwd: '/r/.wt/feat/src', message: { content: 'make retries exponential' } }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: iso(4000),
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/r/.wt/feat/src/up.ts' } }] },
  }),
  '',
].join('\n')

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const world = (on: On, extra: { live?: LiveSnapshot } = {}) => {
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'worktree-deck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'own' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('fs.read', (_, e) => (extra.live && e.path === `${LIVE}/${extra.live.sid}.json` ? { value: JSON.stringify(extra.live) } : { deny: 'missing' }))
  on('fs.list', (_, e) => {
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    if (e.path === PROJECTS) return { value: [dir('-r'), dir('-r--wt-feat-src'), dir('-other')] }
    if (e.path === `${PROJECTS}/-r--wt-feat-src`) return { value: [file('s1.jsonl', transcript.length, NOW - 4000)] }
    if (e.path === LIVE && extra.live) return { value: [file(`${extra.live.sid}.json`, 100, NOW - 500)] }
    return { value: [] }
  })
  on('process.run', (_, e) => {
    const [cmd, ...a] = e.argv
    const cwd = e.init?.cwd
    if (cmd === 'tail') return ok(transcript)
    if (cmd === 'sh') return ok('/r/.wt/feat/src\n/r\n')
    if (cmd === 'find') return ok('')
    if (a[0] === 'rev-parse' && a[1] === '--show-toplevel') return ok('/r\n')
    if (a[0] === 'rev-parse') return ok(`${cwd}/.git\n`)
    if (a[0] === 'worktree')
      return ok('worktree /r\nHEAD a\nbranch refs/heads/main\n\nworktree /r/.wt/feat\nHEAD b\nbranch refs/heads/feat/retry\n')
    if (a[0] === 'status')
      return ok(cwd === '/r' ? '# branch.head main\n' : '# branch.head feat/retry\n1 .M N... 100644 100644 100644 a b src/up.ts\n? notes.md\n')
    if (a[0] === 'diff') return ok(cwd === '/r' ? '' : ' 1 file changed, 12 insertions(+), 3 deletions(-)\n')
    if (a[0] === 'log') return ok(`${(NOW - 600_000) / 1000}\tfeat: start retry\n`)
    if (a[0] === 'rev-list') return ok('1\t3\n')
    return ok('')
  })
}

test('the dashboard shows each worktree, its session state and live activity', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Worktree Deck/ }))?.text).toContain('r')
    expect((await ui.find({ type: 'Text', text: /feat\/retry/ }))?.text).toContain('⎇ feat/retry')
    expect((await ui.find({ type: 'Text', text: /Retry uploads/ }))?.text).toContain('Retry uploads')
    expect((await ui.find({ type: 'Text', text: /make retries/ }))?.text).toContain('make retries exponential')
    // The session started in a subfolder still lands on its worktree, and a
    // tool call with no result yet reads as the work in progress.
    expect((await ui.find({ type: 'Text', text: /Editing/ }))?.text).toContain('src/up.ts')
    expect((await ui.find({ type: 'Text', text: /vs main/ }))?.text).toContain('↑3 ↓1 vs main')
    expect((await ui.find({ type: 'Text', text: /\.\/\.wt\/feat/ }))?.text).toContain('./.wt/feat')
    expect((await ui.find({ type: 'Text', text: /this session/ }))?.text).toContain('this session · main')
    expect((await ui.find({ type: 'Text', text: /worktrees/ }))?.text).toContain('2 worktrees')
    await ui.unmount()
  }
})

test('the inspector opens a session, its tools and back again', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'open:/r/.wt/feat' })
  expect((await ui.find({ type: 'Text', text: /^s1/ }))?.text).toBe('s1')
  expect((await ui.find({ type: 'Text', text: /transcript only/ }))?.text).toContain('transcript only')
  expect((await ui.find({ type: 'Text', text: /make retries/ }))?.text).toBe('make retries exponential')

  await ui.press({ key: 'tab:tools' })
  expect((await ui.find({ type: 'Button', key: 'tool:t1' }))?.text).toContain('Edit · Running')

  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: 'open:/r/.wt/feat' })).toBeDefined()
  await ui.unmount()
})

test('a live feed from another session shows a permission request', { timeoutMs: 20_000 }, async ($, on) => {
  const live: LiveSnapshot = {
    v: 1,
    sid: 's2',
    cwd: '/r/.wt/feat',
    startedAt: NOW - 60_000,
    beat: NOW - 1000,
    phase: 'permission',
    phaseAt: NOW - 3000,
    permission: { name: 'Bash', detail: 'Bash rm -rf dist', at: NOW - 3000 },
    events: [{ id: 'perm:b1', sid: 's2', at: NOW - 3000, kind: 'permission', src: 'hook', tool: 'Bash', text: 'Bash rm -rf dist' }],
    tools: [],
    subagents: [],
    toolCount: 0,
    errorCount: 0,
  }
  world(on, { live })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Approve\?/ }))?.text).toContain('Bash rm -rf dist')
  expect((await ui.find({ type: 'Text', text: /Needs approval/ }))?.text).toContain('Needs approval')
  await ui.unmount()
})

test('outside a git repo it says so', { timeoutMs: 20_000 }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'worktree-deck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'own' }))
  on('session.model', () => ({ value: 'm' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Not a git repository.')
  await ui.unmount()
})
