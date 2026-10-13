import { describe, expect, test } from 'claude-code/testing'

import { bashCandidates, buildRows, empty, isFresh, LINGER_MS, record, relPath } from './trail'

const ROOT = '/repo'

describe('relPath', () => {
  test('positive: absolute path inside the repo', async () => {
    expect(relPath(ROOT, '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relPath(ROOT, './src/a.ts')).toBe('src/a.ts')
  })

  test('negative: outside the repo', async () => {
    expect(relPath(ROOT, '/tmp/x.ts')).toBeUndefined()
    expect(relPath(ROOT, '/repository/x.ts')).toBeUndefined()
    expect(relPath(ROOT, '../x.ts')).toBeUndefined()
  })

  test('edge: the root itself', async () => {
    expect(relPath(ROOT, '/repo/')).toBe('')
    expect(relPath(ROOT, '.')).toBe('')
  })
})

describe('bashCandidates', () => {
  const tokens = (cmd: string) => bashCandidates(cmd).map(c => `${c.op}:${c.token}`)

  test('positive: reads from cat, sed -n and grep', async () => {
    expect(tokens('cat src/a.ts | head')).toEqual(['read:src/a.ts'])
    expect(tokens("sed -n '1,20p' src/b.tsx")).toEqual(['read:src/b.tsx'])
    expect(tokens('grep -rn "useQuota" src/lib')).toEqual(['read:src/lib'])
  })

  test('positive: in-place sed edits and redirects write', async () => {
    expect(tokens("sed -i 's/a/b/' src/a.ts")).toEqual(['edit:src/a.ts'])
    expect(tokens('echo hi > notes.md')).toEqual([])
    expect(tokens('cat a.txt > out/b.txt')).toEqual(['read:a.txt', 'write:out/b.txt'])
  })

  test('negative: git and globs are not paths', async () => {
    expect(tokens('git add src/a.ts')).toEqual([])
    expect(tokens("find src -name '*.ts'")).toEqual(['read:src'])
    expect(tokens('ls 2>&1 /dev/null')).toEqual([])
  })

  test('positive: bare folder names are kept as maybe-paths', async () => {
    const found = bashCandidates('grep -rln "ParticipantGroupReview" components app | head')
    expect(found).toEqual([
      { token: 'components', op: 'read', bare: true },
      { token: 'app', op: 'read', bare: true },
    ])
  })

  test('edge: grep pattern that looks like a path is skipped', async () => {
    expect(tokens('grep -n "a/b" src/c.ts')).toEqual(['read:src/c.ts'])
  })
})

describe('buildRows', () => {
  const base = () => ({
    ...empty(ROOT),
    rootEntries: [
      { name: 'src', isDir: true },
      { name: 'docs', isDir: true },
      { name: 'package.json', isDir: false },
    ],
    sizes: { src: 5, 'src/lib': 2 },
  })

  test('positive: opens only the branch to a touched file', async () => {
    const t = record(base(), 'src/lib/quota.ts', 'edit', false)
    const rows = buildRows(t).map(r => r.guide + (r.more ? `… ${r.more} more` : r.name))
    expect(rows).toEqual([
      '├─ docs/',
      '├─ src/',
      '│  ├─ lib/',
      '│  │  ├─ quota.ts',
      '│  │  └─ … 1 more',
      '│  └─ … 4 more',
      '└─ package.json',
    ])
  })

  test('edge: an active path shows before it is recorded', async () => {
    const t = { ...base(), active: { x: [{ path: 'package.json', op: 'read' as const }] } }
    expect(buildRows(t).find(r => r.path === 'package.json')?.active).toBe('read')
  })

  test('negative: nothing touched shows only the top level, closed', async () => {
    const rows = buildRows(base())
    expect(rows.map(r => r.name)).toEqual(['docs/', 'src/', 'package.json'])
    expect(rows.every(r => !r.isOpen)).toBe(true)
  })
})

describe('highlight linger', () => {
  test('positive: fresh right after a touch, not after the linger', async () => {
    const t = record(empty('/repo'), 'a.ts', 'read', false, 1000).touches['a.ts']
    expect(isFresh(t, 1000 + LINGER_MS - 1)).toBe(true)
    expect(isFresh(t, 1000 + LINGER_MS)).toBe(false)
  })

  test('negative: untouched or untimed paths are never fresh', async () => {
    expect(isFresh(undefined, 5)).toBe(false)
    expect(isFresh(record(empty('/repo'), 'a.ts', 'read', false).touches['a.ts'], 5)).toBe(false)
  })
})
