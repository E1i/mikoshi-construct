import type { TreeCard, TreePrPorts } from '../../shift/tree-pr.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { treePr } from '../../shift/tree-pr.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const CARD: TreeCard = {
  branch: 'feat/x',
  title: 'x (#1)',
  commitMessage: 'x (#1)',
  cardLine: '#1 x [implement/infra/S/cheap/auto] · depends — · blocks —',
  contour: 'cheap',
  touches: ['scripts/x.ts'],
  namedPathReason: null,
}

function repoWithoutOrigin(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-'))
  roots.push(root)
  execFileSync('git', ['-C', root, 'init', '-q'])
  return root
}

describe('treePr', () => {
  it('a failed push reports git stderr in the problem', () => {
    const worktree = repoWithoutOrigin()
    const ports: TreePrPorts = {
      git: (cwd, args) => {
        if (args[0] === 'status')
          return ''
        if (args[0] === 'rev-list')
          return '1\n'
        return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      },
      gh: () => {
        throw new Error('no gh call is expected')
      },
    }
    const result = treePr(ports, CARD, worktree, null)
    expect(result.kind).toBe('problem')
    expect(result.kind === 'problem' && result.why).toMatch(/^the shift could not commit, push or open the pull request of feat\/x: Command failed: git -C .+ push -q -u origin HEAD:refs\/heads\/feat\/x: error: src refspec HEAD does not match any · error: failed to push some refs to 'origin'$/)
  })
})
