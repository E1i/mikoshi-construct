import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BLOCK_END,
  BLOCK_START,
  lastReleaseTag,
  SECURITY_INVARIANTS_FILE,
  securityInvariantsBlock,
  securityInvariantsDiff,
  UNCHANGED,
  withSecurityInvariantsBlock,
} from '../../release/security-diff.js'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
}

function writeInvariants(cwd: string, text: string): void {
  writeFileSync(path.join(cwd, SECURITY_INVARIANTS_FILE), text)
}

function releasedRepository(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'construct-security-diff-'))
  mkdirSync(path.join(cwd, 'architecture'))
  git(cwd, 'init', '--quiet')
  writeInvariants(cwd, '| S1 | no secret in a file |\n')
  writeFileSync(path.join(cwd, 'README.md'), 'one\n')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '--quiet', '-m', 'first')
  git(cwd, 'tag', 'v0.1.0')
  return cwd
}

function commitAll(cwd: string, message: string): void {
  git(cwd, 'add', '.')
  git(cwd, 'commit', '--quiet', '-m', message)
}

function blockFor(cwd: string): string {
  const tag = lastReleaseTag(cwd)
  return securityInvariantsBlock(tag, securityInvariantsDiff(cwd, tag))
}

describe('security invariants block', () => {
  it('gives a changed file its diff since the last release tag, in its own block', () => {
    const cwd = releasedRepository()
    writeInvariants(cwd, '| S1 | no secret in a file |\n| S2 | no spawn under src |\n')
    commitAll(cwd, 'second')

    const block = blockFor(cwd)

    expect(block.startsWith(BLOCK_START)).toBe(true)
    expect(block.endsWith(BLOCK_END)).toBe(true)
    expect(block).toContain('since v0.1.0')
    expect(block).toContain('```diff')
    expect(block).toContain('+| S2 | no spawn under src |')
    expect(block).not.toContain(UNCHANGED)
  })

  it('gives an unchanged file «без изменений» even when other files changed since the tag', () => {
    const cwd = releasedRepository()
    writeFileSync(path.join(cwd, 'README.md'), 'two\n')
    commitAll(cwd, 'second')

    const block = blockFor(cwd)

    expect(block).toContain(UNCHANGED)
    expect(block).not.toContain('```diff')
  })

  it('measures from the latest release tag, not the first', () => {
    const cwd = releasedRepository()
    writeInvariants(cwd, '| S1 | changed before the second release |\n')
    commitAll(cwd, 'second')
    git(cwd, 'tag', 'v0.2.0')

    expect(blockFor(cwd)).toContain(`since v0.2.0\n\n${UNCHANGED}`)
  })

  it('appends the block once and replaces it on a later run', () => {
    const first = withSecurityInvariantsBlock('Releases\n', securityInvariantsBlock('v0.1.0', ''))
    const second = withSecurityInvariantsBlock(first, securityInvariantsBlock('v0.1.0', '+| S2 |\n'))

    expect(second.startsWith('Releases\n\n')).toBe(true)
    expect(second.split(BLOCK_START)).toHaveLength(2)
    expect(second).not.toContain(UNCHANGED)
    expect(second).toContain('+| S2 |')
  })

  it('fences a diff that itself carries a code fence with a longer one', () => {
    expect(securityInvariantsBlock('v0.1.0', '+```ts\n')).toContain('````diff')
  })
})
