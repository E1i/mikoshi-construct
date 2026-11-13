import type { Answerer } from '../../nodes/answer/answerer.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, REVIEW_RECORDED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { mergeBench } from './merge-bench.js'

const CARD = 1726
const PR = CARD - 100
const FIX_ON_MAIN = 'scripts/fix-on-main.ts'

const roots: string[] = []
const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function identified(tree: string): void {
  git(tree, ['config', 'user.name', 'bus'])
  git(tree, ['config', 'user.email', 'bus@example.invalid'])
  git(tree, ['config', 'commit.gpgsign', 'false'])
}

function committed(tree: string, file: string, message: string): string {
  mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
  writeFileSync(path.join(tree, file), `${message}\n`)
  git(tree, ['add', '-A'])
  git(tree, ['commit', '-q', '-m', message])
  return git(tree, ['rev-parse', 'HEAD'])
}

function cardTreeBehindMain(): { trees: string, tree: string, head: string, mainHead: string } {
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-main-'))
  roots.push(trees)
  const origin = path.join(trees, 'origin.git')
  const seed = path.join(trees, 'seed')
  git(trees, ['init', '-q', '--bare', origin])
  git(trees, ['init', '-q', seed])
  identified(seed)
  committed(seed, 'README.md', 'base')
  git(seed, ['push', '-q', origin, 'HEAD:refs/heads/main'])
  const tree = path.join(trees, `mc-${CARD}`)
  git(trees, ['clone', '-q', origin, tree])
  identified(tree)
  git(tree, ['checkout', '-q', '-b', `feat/card-${CARD}`])
  const head = committed(tree, 'scripts/card.ts', 'the card change')
  const mainHead = committed(seed, FIX_ON_MAIN, 'a fix merged to main')
  git(seed, ['push', '-q', origin, 'HEAD:refs/heads/main'])
  return { trees, tree, head, mainHead }
}

describe('an answer round pulls main into the card tree', () => {
  it('an answer round on a tree whose base lacks a commit merged to main merges main into the tree before its session starts', async () => {
    const made = mergeBench()
    benches.push(made)
    const { trees, tree, head, mainHead } = cardTreeBehindMain()
    const ts = made.clock.now().toISOString()
    appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree: tree, branch: `feat/card-${CARD}`, base: mainHead }, legacy: false })
    made.gitHub.open({ number: PR, head, review: 'failure' })
    appendEvent(made.db, { ts, type: REVIEW_RECORDED, actor: 'worker:review:reviewer-1', cardId: CARD, pr: PR, head, dedupeKey: `${REVIEW_RECORDED}:${PR}`, payload: { head, verdict: 'changes', reviewer_session: 'reviewer-1', findings: ['name the reader'] }, legacy: false })
    made.tick()
    const lease = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')!
    expect(lease).toMatchObject({ cardId: CARD, pr: PR, head })
    const seen: { fix: boolean, mainIn: boolean }[] = []
    const answerer: Answerer = async (request) => {
      seen.push({ fix: existsSync(path.join(request.card.worktree, FIX_ON_MAIN)), mainIn: git(request.card.worktree, ['merge-base', '--is-ancestor', mainHead, 'HEAD']) === '' })
      return { session: 'card-session-1', resumed: true, before: head, after: head, owner: null }
    }
    const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: () => `feat/card-${CARD}`, recreate: () => {}, bringTo: () => {} }
    const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => null, prepare: () => {} })

    await executor.answer(lease)

    expect(seen).toEqual([{ fix: true, mainIn: true }])
  })
})
