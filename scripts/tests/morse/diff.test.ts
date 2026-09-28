import { describe, expect, it } from 'vitest'
import { changedFilesFrom } from '../../morse/diff.js'

describe('morse diff', () => {
  it('reads a binary path only from numstat\'s -\\t-', () => {
    expect(changedFilesFrom('M\0assets/logo.bin\0', '-\t-\tassets/logo.bin\0')).toEqual([
      { path: 'assets/logo.bin', status: 'M', additions: null, deletions: null },
    ])
  })

  it('refuses a path with a status and no numstat line', () => {
    expect(() => changedFilesFrom('M\0docs/a.md\0M\0docs/b.md\0', '1\t0\tdocs/a.md\0')).toThrow('inconsistent diff: docs/b.md has a status and no numstat line')
  })

  it('refuses a numstat line with one count missing', () => {
    expect(() => changedFilesFrom('M\0docs/a.md\0', '-\t3\tdocs/a.md\0')).toThrow('inconsistent diff')
  })

  it('refuses a status the rules do not handle', () => {
    expect(() => changedFilesFrom('T\0src/a.ts\0', '1\t1\tsrc/a.ts\0')).toThrow('unhandled git status T for src/a.ts')
  })
})
