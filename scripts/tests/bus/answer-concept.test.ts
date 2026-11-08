import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/answer-executor.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, SCOPE_WIDENED, SHARD_ISSUED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { CONCEPT_WIDENING_REASON } from '../../nodes/answer/concept-scope.js'
import { DECISIONS_SCOPE } from '../../policy/shards.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD_ID = 905
const OWNER_MERGES = readFileSync('architecture/owner-merges.md', 'utf8')
const TOUCHED = 'scripts/nodes/answer/answerer.ts'
const IMPORTER = 'scripts/nodes/answer/answer-executor.ts'
const R1_IMPORTER = 'scripts/nodes/close/close-executor.ts'
const FIXTURE = 'scripts/tests/ghosts/watch-fixtures/world.sh'
const TEST_KEYED_RECORD = 'scripts/ci/sandbox-failing.jsonl'
const CLAUDE_FILE = '.claude/rules/answer.md'
const OWNER_IMPORTER = 'scripts/ports/isolation.ts'
const UNRELATED = 'scripts/core/unrelated.ts'
const Q211_SHAPE = [IMPORTER, FIXTURE, TEST_KEYED_RECORD]

const REPOSITORY: Record<string, string> = {
  'construct.json': `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [] } })}\n`,
  [TOUCHED]: 'export const answer = 1\n',
  [IMPORTER]: 'import { answer } from \'./answerer.js\'\n\nexport const executor = answer\n',
  [R1_IMPORTER]: 'import { answer } from \'../answer/answerer.js\'\n\nexport const close = answer\n',
  [FIXTURE]: 'echo world\n',
  [TEST_KEYED_RECORD]: '{}\n',
  [CLAUDE_FILE]: 'rule\n',
  [OWNER_IMPORTER]: 'import { answer } from \'../nodes/answer/answerer.js\'\n\nexport const isolation = answer\n',
  [UNRELATED]: 'export const unrelated = 1\n',
}

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

function writeInto(worktree: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true })
    writeFileSync(path.join(worktree, file), text)
  }
}

function cardTree(home: string): string {
  const worktree = path.join(home, `mc-${CARD_ID}`)
  writeInto(worktree, REPOSITORY)
  execFileSync('git', ['init', '-q', worktree])
  execFileSync('git', ['-C', worktree, 'add', '-A'])
  execFileSync('git', ['-C', worktree, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', 'commit', '-q', '-m', 'base'])
  execFileSync('git', ['-C', worktree, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
  return worktree
}

const CARD_TEXT = parkingFileText({ card: `#${CARD_ID} answer-concept [implement/construct/M/cheap/owner] · depends — · blocks —`, branch: `feat/card-${CARD_ID}`, touches: [TOUCHED], continue: 'auto', who: 'window', body: 'the answer card' })

interface Answering {
  outcome: AnswerOutcome
  published: string[]
  made: MergeBench
}

function eventOf(made: MergeBench, type: string, cardId: number | null, payload: Record<string, unknown>, key: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: key, payload, legacy: false })
}

async function answerLeaving(changed: readonly string[], shard: boolean): Promise<Answering> {
  const made = mergeBench()
  benches.push(made)
  const home = mkdtempSync(path.join(tmpdir(), 'bus-answer-concept-'))
  roots.push(home)
  const worktree = cardTree(home)
  const now = made.clock.now()
  if (shard)
    eventOf(made, SHARD_ISSUED, null, { id: 'ws-1', by: 'Eli', scope: DECISIONS_SCOPE, until: new Date(now.getTime() + 3_600_000).toISOString(), window: 1 }, `${SHARD_ISSUED}:ws-1`)
  eventOf(made, CARD_ADMITTED, CARD_ID, { card: `#${CARD_ID}`, lane: 'lane-1', text: CARD_TEXT, textSha: textSha(CARD_TEXT) }, `${CARD_ADMITTED}:body:${CARD_ID}`)
  eventOf(made, CARD_STARTED, CARD_ID, { session: 'card-session-1', worktree, branch: `feat/card-${CARD_ID}`, base: sha('1') }, `${CARD_STARTED}:${CARD_ID}`)
  eventOf(made, CARD_STOPPED, CARD_ID, { reason: 'question.agent', detail: 'the importers follow the renamed exports' }, `${CARD_STOPPED}:${CARD_ID}`)
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  made.tick()
  const reduced = made.clock.now().toISOString()
  queueTask(made.db, reduced, { queue: 'answer', cardId: CARD_ID, stop })
  const lease = leaseNext(made.db, reduced, 'answer', 'worker:answer:worker-1') as Lease
  const published: string[] = []
  const heads = [sha('a'), sha('e')]
  const answerer = claudeAnswerer(path.join(home, 'answers'), {
    cardText: () => CARD_TEXT,
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      writeInto(worktree, Object.fromEntries([TOUCHED, ...changed].map(file => [file, `${REPOSITORY[file] ?? ''}// answered\n`])))
      writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
      return 0
    },
    newSession: () => 'new-session',
    publish: card => published.push(card.branch),
    pending: () => [TOUCHED, ...changed],
  })
  const trees: CardTreeTools = { home, exists: existsSync, branchOf: card => `feat/card-${card}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees, dirty: () => false, liveSession: () => null, prepare: () => {} })
  return { outcome: await executor.answer(lease), published, made }
}

describe('an answer under a window shard widens within the card\'s concept (D-360, D-371)', () => {
  it('under a window shard the Q211 shape commits, pushes and records scope.widened without a stop', async () => {
    const { outcome, published, made } = await answerLeaving(Q211_SHAPE, true)

    expect(outcome).toMatchObject({ kind: 'answered', head: sha('e') })
    expect(published).toEqual([`feat/card-${CARD_ID}`])
    expect(eventsOf(made.db, SCOPE_WIDENED)).toEqual([{ paths: Q211_SHAPE, admission: expect.any(Number) as unknown, detail: CONCEPT_WIDENING_REASON }])
    expect(eventsOf(made.db, CARD_ANSWERED)).toHaveLength(1)
    expect(eventsOf(made.db, CARD_STOPPED)).toHaveLength(1)
  })

  it('under a window shard a .claude file, an owner path or a file that imports no touch still stops the answer', async () => {
    for (const refused of [CLAUDE_FILE, OWNER_IMPORTER, R1_IMPORTER, UNRELATED]) {
      const { outcome, published, made } = await answerLeaving([...Q211_SHAPE, refused], true)

      expect(outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner' })
      expect((outcome as { detail: string }).detail).toContain(`left changes to ${refused}, outside`)
      expect(published).toEqual([])
      expect(eventsOf(made.db, SCOPE_WIDENED)).toEqual([])
    }
  })

  it('without a window shard the Q211 shape stops as before', async () => {
    const { outcome, published, made } = await answerLeaving(Q211_SHAPE, false)

    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner' })
    expect((outcome as { detail: string }).detail).toContain(`left changes to ${Q211_SHAPE.join(', ')}, outside`)
    expect(published).toEqual([])
    expect(eventsOf(made.db, SCOPE_WIDENED)).toEqual([])
  })
})
