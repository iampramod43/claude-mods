import { describe, expect, test } from 'claude-code/testing'

import {
  activityOf,
  describeTool,
  displayPath,
  encodeProject,
  IDLE_MS,
  parseLastCommit,
  parseLeftRight,
  parseShortstat,
  parseStatus,
  parseTranscript,
  parseWorktreeList,
} from './deck'

describe('parseWorktreeList', () => {
  test('main, a branch, a detached and a prunable worktree', async () => {
    const list = parseWorktreeList(
      [
        'worktree /r',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /r/.wt/feat-x',
        'HEAD bbb',
        'branch refs/heads/feat/x',
        'locked',
        '',
        'worktree /tmp/d',
        'HEAD ccc',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    )
    expect(list.map(w => w.path)).toEqual(['/r', '/r/.wt/feat-x', '/tmp/d'])
    expect(list[1]!.branch).toBe('feat/x')
    expect(list[1]!.locked).toBe(true)
    expect(list[2]!.detached).toBe(true)
    expect(list[2]!.prunable).toBe(true)
  })
})

describe('parseStatus', () => {
  test('branch, ahead/behind and each kind of change', async () => {
    const g = parseStatus(
      [
        '# branch.oid abc',
        '# branch.head feat/x',
        '# branch.upstream origin/feat/x',
        '# branch.ab +2 -1',
        '1 M. N... 100644 100644 100644 a b src/staged file.ts',
        '1 .M N... 100644 100644 100644 a b src/mod.ts',
        '2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts',
        'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
        '? notes.md',
      ].join('\n'),
    )
    expect(g.branch).toBe('feat/x')
    expect(g.upstream).toBe('origin/feat/x')
    expect([g.ahead, g.behind]).toEqual([2, 1])
    expect([g.staged, g.modified, g.untracked, g.conflicts]).toEqual([2, 1, 1, 1])
    expect(g.files).toEqual(['src/staged file.ts', 'src/mod.ts', 'new.ts', 'conflict.ts', 'notes.md'])
  })

  test('detached head', async () => {
    expect(parseStatus('# branch.head (detached)\n').detached).toBe(true)
  })
})

describe('small parsers', () => {
  test('shortstat, left-right, last commit', async () => {
    expect(parseShortstat(' 3 files changed, 120 insertions(+), 14 deletions(-)\n')).toEqual({ added: 120, removed: 14 })
    expect(parseShortstat(' 1 file changed, 1 deletion(-)')).toEqual({ added: 0, removed: 1 })
    expect(parseShortstat('')).toEqual({ added: 0, removed: 0 })
    expect(parseLeftRight('4\t7\n')).toEqual({ behind: 4, ahead: 7 })
    expect(parseLeftRight('')).toBeUndefined()
    expect(parseLastCommit('1700000000\tfix: thing\n')).toEqual({ at: 1700000000000, subject: 'fix: thing' })
    expect(parseLastCommit('')).toBeUndefined()
  })

  test('project folder encoding', async () => {
    expect(encodeProject('/home/u/work/claude-mods')).toBe('-home-u-work-claude-mods')
    expect(encodeProject('/r/.claude/worktrees/a_b')).toBe('-r--claude-worktrees-a-b')
  })

  test('display path', async () => {
    expect(displayPath('/home/u/r', '/home/u/r', '/home/u')).toBe('~/r')
    expect(displayPath('/home/u/r/.wt/x', '/home/u/r', '/home/u')).toBe('./.wt/x')
    expect(displayPath('/tmp/x', '/home/u/r', '/home/u')).toBe('/tmp/x')
  })

  test('tool description', async () => {
    expect(describeTool('Edit', { file_path: '/r/hooks/deck.ts' })).toBe('Edit hooks/deck.ts')
    expect(describeTool('Bash', { command: 'npm test', description: 'Run tests' })).toBe('Bash Run tests')
    expect(describeTool('mcp__github__create_pr', {})).toBe('github · create_pr')
  })
})

const line = (r: unknown) => JSON.stringify(r)

describe('parseTranscript', () => {
  test('a cut first line, title, prompt, then a tool in flight', async () => {
    const text = [
      'tail-cut garbage"}',
      line({ type: 'ai-title', aiTitle: 'Add retry logic' }),
      line({ type: 'user', message: { content: 'make retries exponential' } }),
      line({ type: 'user', isMeta: true, message: { content: 'meta stuff' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/src/up.ts' } }] } }),
    ].join('\n')
    const t = parseTranscript(text)
    expect(t.title).toBe('Add retry logic')
    expect(t.prompt).toBe('make retries exponential')
    expect(t.tool).toBe('Edit src/up.ts')
    expect(t.said).toBe('On it.')
    expect(t.last).toBe('tool')
  })

  test('tool results and system-tag prompts are not prompts; a final answer ends the turn', async () => {
    const t = parseTranscript(
      [
        line({ type: 'user', message: { content: [{ type: 'text', text: 'real prompt' }] } }),
        line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
        line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
        line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.\nAll green.' }] } }),
      ].join('\n'),
    )
    expect(t.prompt).toBe('real prompt')
    expect(t.said).toBe('Done. All green.')
    expect(t.last).toBe('text')
  })

  test('an interrupt and a subagent sidechain', async () => {
    const t = parseTranscript(
      [
        line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
        line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
      ].join('\n'),
    )
    expect(t.last).toBe('interrupt')
    expect(t.tool).toBeUndefined()
  })
})

describe('activityOf', () => {
  const now = 10_000_000
  test('each state', async () => {
    expect(activityOf(undefined, now, now)).toBe('none')
    expect(activityOf('tool', now - 5000, now)).toBe('working')
    expect(activityOf('result', now - 5000, now)).toBe('working')
    expect(activityOf('tool', now - 60_000, now)).toBe('pending')
    expect(activityOf('text', now - 5000, now)).toBe('waiting')
    expect(activityOf('interrupt', now - 5000, now)).toBe('waiting')
    expect(activityOf('prompt', now - 5 * 60_000, now)).toBe('idle')
    expect(activityOf('text', now - IDLE_MS - 1, now)).toBe('idle')
  })
})
