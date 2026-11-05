import { expect, test } from 'claude-code/testing'

const NOW = 1_800_000_000_000

const PANE = {
  plugin: 'worktree-deck',
  component: 'Pane',
  requestId: 'worktree-deck',
  props: {
    title: 'Worktrees',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const transcript = [
  JSON.stringify({ type: 'ai-title', aiTitle: 'Retry uploads' }),
  JSON.stringify({ type: 'user', message: { content: 'make retries exponential' } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/.wt/feat/src/up.ts' } }] } }),
].join('\n')

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })

test('the pane shows each worktree and what its Claude session is doing', async ($, on) => {
  on('command.register', () => ({ value: { command: 'worktree-deck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', (_, e) =>
    e.path.endsWith('-r--wt-feat')
      ? { value: [{ name: 's1.jsonl', kind: 'file', size: 10, mtimeMs: NOW - 3000, isLink: false }] }
      : { value: [] },
  )
  on('process.run', (_, e) => {
    const [cmd, ...a] = e.argv
    const cwd = e.init?.cwd
    if (cmd === 'tail') return ok(transcript)
    if (a[0] === 'rev-parse' && a[1] === '--show-toplevel') return ok('/r\n')
    if (a[0] === 'rev-parse') return ok(`${cwd}/.git\n`)
    if (a[0] === 'worktree')
      return ok('worktree /r\nHEAD a\nbranch refs/heads/main\n\nworktree /r/.wt/feat\nHEAD b\nbranch refs/heads/feat/retry\n')
    if (a[0] === 'status')
      return ok(
        cwd === '/r'
          ? '# branch.head main\n'
          : '# branch.head feat/retry\n1 .M N... 100644 100644 100644 a b src/up.ts\n? notes.md\n',
      )
    if (a[0] === 'diff') return ok(cwd === '/r' ? '' : ' 1 file changed, 12 insertions(+), 3 deletions(-)\n')
    if (a[0] === 'log') return ok(`${(NOW - 600_000) / 1000}\tfeat: start retry\n`)
    if (a[0] === 'rev-list') return ok('1\t3\n')
    return ok('')
  })

  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /feat\/retry/ }))?.text).toContain('feat/retry')
  expect((await ui.find({ type: 'Text', text: /Retry uploads/ }))?.text).toContain('Retry uploads')
  expect((await ui.find({ type: 'Text', text: /▶/ }))?.text).toContain('Edit src/up.ts')
  expect((await ui.find({ type: 'Text', text: /make retries/ }))?.text).toContain('make retries exponential')
  expect((await ui.find({ type: 'Text', text: /vs main/ }))?.text).toContain('↑3 ↓1 vs main')
  expect((await ui.find({ type: 'Text', text: /this session/ }))?.text).toContain('main')
  expect((await ui.find({ type: 'Text', text: /\.\/\.wt\/feat/ }))?.text).toContain('./.wt/feat')
  await ui.unmount()
})

test('outside a git repo it says so', async ($, on) => {
  on('command.register', () => ({ value: { command: 'worktree-deck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal' } }))

  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Not a git repository.')
  await ui.unmount()
})
