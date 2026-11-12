import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/duties/index.js'
import type { TreeCard, TreePrPorts } from '../../nodes/launch/tree-pr.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { Buffer } from 'node:buffer'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { treePr } from '../../nodes/launch/tree-pr.js'
import { HEAD_OUTSIDE_TOUCHES } from '../../nodes/merge/merge-executor.js'
import { planReview } from '../../nodes/review/review-depth.js'
import { classify } from '../../policy/morse/rules.js'
import { KNOWN_VIOLATIONS, removesEntriesOnly, textBeforePatch } from '../../policy/touch-scope.js'
import { sha } from './github-fake.js'
import { eventsOf, liveBench, mergeBench } from './merge-bench.js'

const PR = 1766
const CARD = PR + 100
const SESSION = 'card-session-1'
const TOUCHED = 'scripts/core/lease.ts'
const RULE = { severity: 'error', name: 'core-imports-nothing-to-its-right' }
const STALE = { type: 'dependency', from: TOUCHED, to: 'scripts/ports/meter.ts', rule: RULE }
const KEPT = { type: 'dependency', from: 'scripts/core/other.ts', to: 'scripts/ports/meter.ts', rule: RULE }
const GROWN_ENTRY = { type: 'dependency', from: TOUCHED, to: 'scripts/ports/github.ts', rule: RULE }

function listed(entries: readonly object[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`
}

const BASELINE = listed([STALE, KEPT])
const REMOVED = listed([KEPT])
const REMOVED_LAST = listed([STALE])
const GROWN = listed([STALE, KEPT, GROWN_ENTRY])
const ALTERED = listed([{ ...STALE, to: 'scripts/ports/github.ts' }, KEPT])
const ALTERED_WHILE_REMOVING = listed([{ ...KEPT, rule: { ...RULE, severity: 'warn' } }])
const WITH_THE_IMPORT = 'import { Meter } from \'../ports/meter.js\'\n\nexport const lease = Meter\n'
const WITHOUT_THE_IMPORT = 'export const lease = 1\n'
const REFUSED_AT_MERGE = { kind: 'denied', denial: { kind: 'technical', reason: HEAD_OUTSIDE_TOUCHES } }
const CARD_TEXT = `card: #${CARD} known-violation-removal-follows [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: stop\nwho: shift\n\nDrop the import.\n`

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function room(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'known-violation-removal-'))
  roots.push(root)
  return root
}

function cardTree(worktree: string): void {
  const files = { 'construct.json': `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [] } })}\n`, [TOUCHED]: WITH_THE_IMPORT, [KNOWN_VIOLATIONS]: BASELINE }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true })
    writeFileSync(path.join(worktree, file), text)
  }
  execFileSync('git', ['init', '-q', worktree])
  execFileSync('git', ['-C', worktree, 'add', '-A'])
  execFileSync('git', ['-C', worktree, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base'])
  execFileSync('git', ['-C', worktree, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
}

function pendingIn(worktree: string): string[] {
  return execFileSync('git', ['-C', worktree, 'diff', '--name-only', 'HEAD'], { encoding: 'utf8' }).split('\n').filter(file => file !== '')
}

type Round = (worktree: string) => void

function dropsTheImportAnd(known: string): Round {
  return (worktree) => {
    writeFileSync(path.join(worktree, TOUCHED), WITHOUT_THE_IMPORT)
    writeFileSync(path.join(worktree, KNOWN_VIOLATIONS), known)
  }
}

const leavesTheList: Round = (worktree) => {
  writeFileSync(path.join(worktree, TOUCHED), WITHOUT_THE_IMPORT)
}

interface Answering {
  made: MergeBench
  outcome: AnswerOutcome
  published: number
  prompts: string[]
  known: string
}

async function answerWith(rounds: Round[]): Promise<Answering> {
  const made = mergeBench()
  benches.push(made)
  const home = room()
  const worktree = path.join(home, `mc-${CARD}`)
  cardTree(worktree)
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text: CARD_TEXT, textSha: textSha(CARD_TEXT) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: SESSION, worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: 'the import of the meter goes' }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, stop })
  const lease = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease
  const dir = path.join(home, 'answers')
  const heads = [sha('a'), sha('e')]
  const prompts: string[] = []
  let published = 0
  const answerer = claudeAnswerer(dir, {
    cardText: () => CARD_TEXT,
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      prompts.push(run.argv.join(' '))
      rounds.shift()?.(worktree)
      writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
      return 0
    },
    newSession: () => 'new-session',
    publish: () => {
      published += 1
    },
    pending: () => pendingIn(worktree),
  })
  const trees: CardTreeTools = { home, exists: existsSync, branchOf: card => `feat/card-${card}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees, dirty: () => false, liveSession: () => null, prepare: () => {} })
  const outcome = await executor.answer(lease)
  return { made, outcome, published, prompts, known: readFileSync(path.join(worktree, KNOWN_VIOLATIONS), 'utf8') }
}

function patchOf(before: string, after: string): string {
  const root = room()
  writeFileSync(path.join(root, 'before.json'), before)
  writeFileSync(path.join(root, 'after.json'), after)
  const diff = spawnSync('git', ['diff', '--no-index', '--', path.join(root, 'before.json'), path.join(root, 'after.json')], { encoding: 'utf8' }).stdout
  return diff.slice(diff.indexOf('@@'))
}

function mergeOf(known: string): ReturnType<MergeBench['merge']> {
  const made = liveBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:merge`, payload: { card: `#${CARD}`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: 'admission-merge', text: CARD_TEXT, textSha: textSha(CARD_TEXT), bodySha: 'merge' }, legacy: false })
  reduce(made.db)
  const fake = made.gitHub as unknown as { answer: (endpoint: string) => unknown }
  const answer = fake.answer.bind(made.gitHub)
  fake.answer = endpoint => endpoint.startsWith(`repos/{owner}/{repo}/contents/${KNOWN_VIOLATIONS}?ref=`) ? { content: Buffer.from(known).toString('base64') } : answer(endpoint)
  made.gitHub.open({ number: PR, review: 'success', files: [TOUCHED, KNOWN_VIOLATIONS], patches: { [KNOWN_VIOLATIONS]: patchOf(BASELINE, known) } })
  made.tick()
  return made.merge(made.lease()!)
}

describe('a known-violation entry the card made stale follows its touches, growth stays the owner\'s (D-514)', () => {
  it('a card that removes an import and deletes its known-violation entry passes the answer and merge guards', async () => {
    const { made, outcome, published, prompts, known } = await answerWith([dropsTheImportAnd(REMOVED)])

    expect(prompts).toHaveLength(1)
    expect(known).toBe(REMOVED)
    expect(published).toBe(1)
    expect(outcome).toMatchObject({ kind: 'answered' })
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])
    expect(mergeOf(REMOVED)).toMatchObject({ kind: 'merged' })
    expect(mergeOf(REMOVED_LAST)).toMatchObject({ kind: 'merged' })
  })

  it('a card that adds a known-violation entry is refused', async () => {
    const { prompts, known, published } = await answerWith([dropsTheImportAnd(GROWN), leavesTheList])

    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('find a path without the violation')
    expect(known).toBe(BASELINE)
    expect(published).toBe(1)
    expect(mergeOf(GROWN)).toMatchObject(REFUSED_AT_MERGE)
  })

  it('a card that alters a known-violation entry is refused', async () => {
    const { prompts, known } = await answerWith([dropsTheImportAnd(ALTERED), leavesTheList])

    expect(prompts).toHaveLength(2)
    expect(known).toBe(BASELINE)
    expect(mergeOf(ALTERED)).toMatchObject(REFUSED_AT_MERGE)
    expect(mergeOf(ALTERED_WHILE_REMOVING)).toMatchObject(REFUSED_AT_MERGE)
    expect(removesEntriesOnly(BASELINE, ALTERED_WHILE_REMOVING)).toBe(false)
  })

  it('the text before a patch is the base the patch was taken from, and a patch that does not fit reads as nothing', () => {
    expect(textBeforePatch(REMOVED, patchOf(BASELINE, REMOVED))).toBe(BASELINE)
    expect(textBeforePatch(REMOVED_LAST, patchOf(BASELINE, REMOVED_LAST))).toBe(BASELINE)
    expect(textBeforePatch(GROWN, patchOf(BASELINE, REMOVED))).toBeNull()
  })
})

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=shift', '-c', 'user.email=shift@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function reviewFindingsOf(known: string): string[] {
  const root = path.join(room(), 'review')
  cardTree(root)
  const base = gitIn(root, ['rev-parse', 'HEAD']).trim()
  dropsTheImportAnd(known)(root)
  gitIn(root, ['commit', '-q', '-am', 'card'])
  const head = gitIn(root, ['rev-parse', 'HEAD']).trim()
  gitIn(root, ['checkout', '-q', base])
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  const files = [TOUCHED, KNOWN_VIOLATIONS]
  const plan = planReview({ taskKey: `review:${CARD}:${PR}:${head}`, queue: 'review', cardId: CARD, pr: PR, head, leaseGen: 1, actor: 'worker:review:w' }, null, {
    base: () => base,
    changed: () => files,
    predict: () => ({ prediction: classify(files.map(file => ({ path: file, status: 'M', additions: 1, deletions: 1 }))), files, added: [] }),
    scope: () => ({ touches: [TOUCHED], creates: [], runs: [] }),
  })
  return plan.depth === 'diff' && plan.round === 'first' ? plan.touchFindings : [`the plan is ${plan.depth}`]
}

const OPENED_PR = 1588
const SHIFT_CARD: TreeCard = { branch: `feat/card-${CARD}`, title: `known-violation-removal-follows (#${CARD})`, commitMessage: `known-violation-removal-follows (#${CARD})`, cardLine: CARD_TEXT.split('\n')[0]!, contour: 'cheap', touches: [TOUCHED], runs: [], namedPathReason: null }

function launchOf(known: string): { opened: ReturnType<typeof treePr>, bodies: string[] } {
  const worktree = path.join(room(), `mc-${CARD}`)
  cardTree(worktree)
  const origin = path.join(path.dirname(worktree), 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin])
  gitIn(worktree, ['remote', 'add', 'origin', origin])
  gitIn(worktree, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
  gitIn(worktree, ['fetch', '-q', 'origin'])
  gitIn(worktree, ['checkout', '-q', '-b', SHIFT_CARD.branch])
  dropsTheImportAnd(known)(worktree)
  const bodies: string[] = []
  const ports: TreePrPorts = {
    git: gitIn,
    gh: (args) => {
      if (args[1] === 'list')
        return '[]'
      bodies.push(args[args.indexOf('--body') + 1]!)
      return `https://github.com/o/r/pull/${OPENED_PR}\n`
    },
  }
  return { opened: treePr(ports, SHIFT_CARD, worktree, null), bodies }
}

describe('the review and the launch let the same removal follow and keep growth outside (D-514)', () => {
  it('the review shows a removed known-violation entry inside the touches and a grown or altered list outside them', () => {
    const outside = `${KNOWN_VIOLATIONS} is outside the touches of card #${CARD} (${TOUCHED})`

    expect(reviewFindingsOf(REMOVED)).toEqual([])
    expect(reviewFindingsOf(GROWN)).toEqual([outside])
    expect(reviewFindingsOf(ALTERED)).toEqual([outside])
  })

  it('the launch opens the pull request with a removed entry followed, and opens none for a grown or altered list', () => {
    const removed = launchOf(REMOVED)
    expect(removed.opened).toEqual({ kind: 'pr', number: String(OPENED_PR), followed: [KNOWN_VIOLATIONS] })
    expect(removed.bodies[0]).toContain(`Touches followed: ${KNOWN_VIOLATIONS}`)

    for (const known of [GROWN, ALTERED]) {
      const refused = launchOf(known)
      expect(refused.opened).toMatchObject({ kind: 'problem', gaps: [{ reason: 'outside-touches', paths: [KNOWN_VIOLATIONS] }] })
      expect(refused.bodies).toEqual([])
    }
  })
})
