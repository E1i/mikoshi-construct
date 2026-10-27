import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeAttachRecord } from '../../../src/commands/attach/record.js'
import { leaseNext } from '../../core/lease.js'
import { pushPolicyOf } from '../../core/push-policy.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { treePr } from '../../nodes/launch/tree-pr.js'
import { MergeExecutor } from '../../nodes/merge/merge-executor.js'
import { PrCloser, RoundLimitRecutter } from '../../nodes/review/pr-close.js'
import { ghNotePr } from '../../nodes/review/review-worker.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { GhBudgetWindow, ghPort } from '../../ports/gh.js'
import { cardBody, sha } from '../bus/github-fake.js'
import { liveBench, mergeBench } from '../bus/merge-bench.js'
import { detectUpdate } from '../bus/update-detection.js'

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

  it.each(['none', 'bus'] as const)('the policy attach writes as %s is the policy the bus reads', (push) => {
    const root = repoWith(null)
    writeAttachRecord(root, { recordVersion: 4, construct: '0', attachedAt: '', harness: 'none', files: {}, directories: [], excludeCreated: false, excludeSeparator: 0, push })

    expect(pushPolicyOf(realGit, root)).toBe(push)
  })

  it.each([['none', false], ['bus', true]] as const)('the answerer under push %s publishes: %s', async (policy, published) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'push-none-answer-')))
    const worktree = path.join(root, 'tree')
    mkdirSync(worktree)
    const publishes: string[] = []
    const answerer = claudeAnswerer(path.join(root, 'answers'), {
      cardText: () => null,
      available: () => true,
      remoteHead: () => null,
      spawn: async () => 0,
      newSession: () => 's1',
      publish: card => publishes.push(card.branch),
      pushPolicy: () => policy,
    })
    const lease = { taskKey: 'answer:1:2', queue: 'answer', cardId: 1, pr: 2, head: 'a'.repeat(40), leaseGen: 1, actor: 'worker:answer:w' } as const
    const answered = await answerer({ lease, source: { kind: 'changes', findings: [], events: [] }, widened: null, card: { session: 's0', worktree, branch: 'feat/x' } })

    expect({ published: publishes.length === 1, owner: answered.owner }).toEqual({ published, owner: null })
  })

  it.each([['none', 0, 'denied'], ['bus', 1, 'updated']] as const)('the update executor under push %s makes %s update-branch calls: %s', (policy, puts, kind) => {
    const made = liveBench()
    try {
      made.gitHub.open({ number: 987, review: 'success', mergeable_state: 'behind' })
      made.tick()
      detectUpdate(made)
      const executor = new UpdateExecutor({ db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, settle: () => {}, pushPolicy: () => policy })
      const outcome = executor.update(leaseNext(made.db, made.clock.now().toISOString(), 'update', 'worker:update:worker-1')!)

      expect({ puts: made.gitHub.puts.length, kind: outcome.kind }).toEqual({ puts, kind })
      if (outcome.kind === 'denied')
        expect(outcome).toMatchObject({ denial: { reason: 'kept_by_push_policy' }, next: 'withdrawn' })
    }
    finally {
      made.close()
    }
  })

  it.each([['none', 0], ['bus', 2]] as const)('a note on a pull request under push %s runs %s gh calls', (policy, calls) => {
    const spawned: string[][] = []
    const port = ghPort({ spawn: (_command, args) => {
      spawned.push(args)
      return { status: 0, stdout: 'the body\n', stderr: '' }
    }, pause: () => {}, budget: new GhBudgetWindow({ calls: 5, windowMs: 1000 }, () => 0) })

    ghNotePr('/repo', port, () => policy)(970, 'a note')

    expect(spawned.length).toBe(calls)
  })

  it('a malformed attach record reads as none', () => {
    const root = repoWith(null)
    mkdirSync(path.join(root, '.construct'))
    writeFileSync(path.join(root, '.construct/attach.json'), '{ not json')

    expect(pushPolicyOf(realGit, root)).toBe('none')
  })

  it.each([['none', 0, 'denied'], ['bus', 1, 'merged']] as const)('the merge executor under push %s makes %s merge calls: %s', (policy, puts, kind) => {
    const made = liveBench()
    try {
      made.gitHub.open({ number: 960, review: 'success' })
      made.tick()
      const executor = new MergeExecutor({ db: made.db, gitHub: made.gitHub.client, put: made.gitHub.put, publish: made.gitHub.publish, clock: made.clock.now, run: null, pushPolicy: () => policy })
      const outcome = executor.merge(leaseNext(made.db, made.clock.now().toISOString(), 'merge', 'worker:merge:worker-1')!)

      expect({ puts: made.gitHub.puts.length, kind: outcome.kind }).toEqual({ puts, kind })
      if (outcome.kind === 'denied')
        expect(outcome).toMatchObject({ denial: { reason: 'kept_by_push_policy' }, next: 'withdrawn' })
    }
    finally {
      made.close()
    }
  })

  it.each([['none', 0, 'denied'], ['bus', 1, 'closed']] as const)('the pull request closer under push %s makes %s close calls: %s', (policy, closes, kind) => {
    const made = mergeBench()
    try {
      made.gitHub.open({ number: 980, head: sha('a'), ref: 'feat/card-1080', body: cardBody(980) })
      made.tick()
      const outcome = new PrCloser(made.db, made.gitHub.client, made.gitHub.patch, made.clock.now, () => policy).close({ attempt: 'a', pr: 980, cardId: 1080, reason: 'cut anew', by: 'window' })

      expect({ closes: made.gitHub.closes.length, kind: outcome.kind }).toEqual({ closes, kind })
    }
    finally {
      made.close()
    }
  })

  it.each([['none', 'push policy none'], ['bus', 'no admitted body']] as const)('the round-limit recutter under push %s makes no GitHub write and waits: %s', (policy, why) => {
    const made = mergeBench()
    try {
      const writes: string[] = []
      const record = (endpoint: string): never => {
        writes.push(endpoint)
        throw new Error('written')
      }
      const recutter = new RoundLimitRecutter({ db: made.db, gitHub: made.gitHub.client, post: record, patch: record, clock: made.clock.now, parked: () => [], pushPolicy: () => policy })
      const outcome = recutter.recut({ cardId: 1080, pr: 980, head: sha('a'), findings: [] })

      expect(writes).toEqual([])
      expect(outcome).toMatchObject({ kind: 'owner_wait', why: expect.stringContaining(why) as unknown })
    }
    finally {
      made.close()
    }
  })
})
