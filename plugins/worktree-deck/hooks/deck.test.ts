import { describe, expect, test } from 'claude-code/testing'

import {
  deepestRoot,
  describeTool,
  displayPath,
  duration,
  encodeProject,
  parseLastCommit,
  parseLeftRight,
  parseShortstat,
  parseStatus,
  parseWorktreeList,
  utf8Length,
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

  test('deepest root, durations, byte length', async () => {
    const roots = ['/r', '/r/.wt/feat', '/r-other']
    expect(deepestRoot('/r/.wt/feat/src', roots)).toBe('/r/.wt/feat')
    expect(deepestRoot('/r/src', roots)).toBe('/r')
    expect(deepestRoot('/r-other', roots)).toBe('/r-other')
    expect(deepestRoot('/elsewhere', roots)).toBeUndefined()
    expect(duration(840)).toBe('840ms')
    expect(duration(3200)).toBe('3.2s')
    expect(duration(250_000)).toBe('4m 10s')
    expect(utf8Length('aé→😀')).toBe(1 + 2 + 3 + 4)
  })
})

