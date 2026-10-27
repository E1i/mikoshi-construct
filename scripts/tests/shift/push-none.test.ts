import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pushPolicyOf } from '../../core/push-policy.js'
import { treePr } from '../../nodes/launch/tree-pr.js'

const CARD = {
  branch: 'feat/x',
  title: 'x (#1)',
  commitMessage: 'x (#1)',
  cardLine: '#1 x [implement/infra/S/cheap/auto] · depends — · blocks —',
  contour: 'cheap' as const,
  touches: ['scripts/x.ts'],
  runs: [],
  namedPathReason: null,
}

function realGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

function repoWith(record: object | null): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'push-none-')))
  realGit(root, ['init', '-q'])
  if (record !== null) {
    mkdirSync(path.join(root, '.construct'))
    writeFileSync(path.join(root, '.construct/attach.json'), JSON.stringify(record))
  }
  return root
}

describe('push policy none', () => {
  it('tree-pr calls neither git push nor gh pr create', () => {
    const calls: string[] = []
    const ports = {
      git: (_cwd: string, args: string[]) => {
        calls.push(`git ${args.join(' ')}`)
        return ''
      },
      gh: (args: string[]) => {
        calls.push(`gh ${args.join(' ')}`)
        return ''
      },
      pushPolicy: () => 'none' as const,
    }

    expect(treePr(ports, CARD, '/w', null)).toEqual({ kind: 'kept' })
    expect(calls).toEqual([])
  })

  it('the policy is none for an attached repository by default and bus only when the record says so', () => {
    expect(pushPolicyOf(realGit, repoWith({ push: 'none' }))).toBe('none')
    expect(pushPolicyOf(realGit, repoWith({}))).toBe('none')
    expect(pushPolicyOf(realGit, repoWith({ push: 'bus' }))).toBe('bus')
    expect(pushPolicyOf(realGit, repoWith(null))).toBe('bus')
  })
})
