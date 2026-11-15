import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/duties/index.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer, KNOWN_VIOLATIONS, ownerQuestionPath } from '../../nodes/answer/answerer.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { ranTheGreenGate } from './gate-stream.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1759
const SESSION = 'card-session-1'
const TOUCHED = 'scripts/a.ts'
const OTHER = 'scripts/elsewhere.ts'
const BASELINE = '[]\n'
const GROWN = '[{"type":"not-allowed","from":"scripts/a.ts","to":"scripts/b.ts"}]\n'
const NO_PATH = 'no path without the violation: scripts/a.ts must import scripts/b.ts'

vi.mock('../../ports/card-tree.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../ports/card-tree.js')>()
  const { readFileSync: read, writeFileSync: write } = await import('node:fs')
  const { join } = await import('node:path')
  return {
    ...original,
    pnpmRerun: (cwd: string) => {
      const grows = read(join(cwd, 'scripts/a.ts'), 'utf8').includes('./b.js')
      write(join(cwd, '.dependency-cruiser-known-violations.json'), grows ? '[{"type":"not-allowed","from":"scripts/a.ts","to":"scripts/b.ts"}]\n' : '[]\n')
      return { status: 0, stderr: '' }
    },
  }
})

const FILES: Record<string, string> = {
  'construct.json': `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [] } })}\n`,
  [TOUCHED]: 'export const a = 1\n',
  [OTHER]: 'export const elsewhere = 1\n',
  [KNOWN_VIOLATIONS]: BASELINE,
}

type Round = (worktree: string, ownerQuestion: string) => void

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

function cardTree(worktree: string): void {
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true })
    writeFileSync(path.join(worktree, file), text)
  }
  execFileSync('git', ['init', '-q', worktree])
  execFileSync('git', ['-C', worktree, 'add', '-A'])
  execFileSync('git', ['-C', worktree, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', 'commit', '-q', '-m', 'base'])
  execFileSync('git', ['-C', worktree, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
}

function pendingIn(worktree: string): string[] {
  return execFileSync('git', ['-C', worktree, 'diff', '--name-only', 'HEAD'], { encoding: 'utf8' }).split('\n').filter(file => file !== '')
}

const growsTheBaseline: Round = (worktree) => {
  writeFileSync(path.join(worktree, TOUCHED), 'import { b } from \'./b.js\'\n\nexport const a = b\n')
  writeFileSync(path.join(worktree, KNOWN_VIOLATIONS), GROWN)
}

const findsAPath: Round = (worktree) => {
  writeFileSync(path.join(worktree, TOUCHED), 'export const a = 2\n')
}

const saysThereIsNone: Round = (_worktree, ownerQuestion) => {
  writeFileSync(ownerQuestion, `${NO_PATH}\n`)
}

interface Answering {
  made: MergeBench
  outcome: AnswerOutcome
  published: number
  prompts: string[]
  worktree: string
}

async function answerWith(rounds: Round[], moves: boolean): Promise<Answering> {
  const made = mergeBench()
  benches.push(made)
  const home = mkdtempSync(path.join(tmpdir(), 'bus-answer-violation-'))
  roots.push(home)
  const worktree = path.join(home, `mc-${CARD}`)
  cardTree(worktree)
  const ts = made.clock.now().toISOString()
  const text = `card: #${CARD} card-${CARD} [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: stop\nwho: shift\n\nAnswer it.\n`
  appendEvent(made.db, { ts, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: SESSION, worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: 'a.ts needs what b.ts holds' }, legacy: false })
  made.tick()
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, made.clock.now().toISOString(), { queue: 'answer', cardId: CARD, stop })
  const lease = leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1') as Lease
  const dir = path.join(home, 'answers')
  const heads = moves ? [sha('a'), sha('e')] : [sha('a'), sha('a')]
  const prompts: string[] = []
  let published = 0
  const answerer = claudeAnswerer(dir, {
    cardText: () => text,
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      prompts.push(run.argv.join(' '))
      rounds.shift()?.(worktree, ownerQuestionPath(dir, SESSION, lease.leaseGen))
      ranTheGreenGate(run)
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
  const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees, dirty: () => false, liveSession: () => null, prepare: () => {} })
  return { made, outcome: await executor.answer(lease), published, prompts, worktree }
}

describe('an answer that grows the known dependency violations does not publish the growth, and the owner decides it (D-592)', () => {
  it('a grown baseline is dropped and the answer goes back for a path without the violation, which it publishes with no owner wait', async () => {
    const { made, outcome, published, prompts, worktree } = await answerWith([growsTheBaseline, findsAPath], true)

    expect(prompts).toHaveLength(2)
    expect(readFileSync(path.join(worktree, KNOWN_VIOLATIONS), 'utf8')).toBe(BASELINE)
    expect(published).toBe(1)
    expect(outcome).toMatchObject({ kind: 'answered', head: sha('e') })
    expect(eventsOf(made.db, CARD_ANSWERED)).toHaveLength(1)
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([])
  })

  it('a grown baseline with no path without the violation waits for the owner under a numbered wait, not a question.agent stop', async () => {
    const { made, outcome, published, prompts } = await answerWith([growsTheBaseline, saysThereIsNone], false)

    expect(prompts).toHaveLength(2)
    expect(published).toBe(0)
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner' })
    expect(eventsOf(made.db, OWNER_WAIT_OPENED).map(wait => wait.id)).toEqual([expect.stringMatching(/^Q\d+$/)])
    expect(eventsOf(made.db, CARD_STOPPED).filter(stop => stop.reason === 'question.agent')).toHaveLength(1)
  })

  it('a grown baseline beside another change outside the touches is refused for both, with no second round', async () => {
    const both: Round = (worktree) => {
      growsTheBaseline(worktree, '')
      writeFileSync(path.join(worktree, OTHER), 'export const elsewhere = 2\n')
    }
    const { outcome, published, prompts } = await answerWith([both, saysThereIsNone], false)

    expect(prompts).toHaveLength(1)
    expect(published).toBe(0)
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'question.owner' })
    expect((outcome as { detail: string }).detail).toContain(OTHER)
    expect((outcome as { detail: string }).detail).toContain(`${KNOWN_VIOLATIONS} is a derived file`)
  })
})
