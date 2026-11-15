import type { ProvenWitness, Reviewer } from '../../nodes/review/reviewer.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent, WINDOW_LANE } from '../../core/card-bodies.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, WITNESS_RECORDED } from '../../core/events.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { ReviewWorker } from '../../nodes/review/review-worker.js'
import { ISOLATION_GAP, provenWitnessLine, reviewPrompt, WITNESS_RUNS_LINE } from '../../nodes/review/reviewer.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, sha } from '../bus/github-fake.js'
import { liveBench } from '../bus/merge-bench.js'

const PR = 1940
const CARD = PR + 100
const HEAD = sha('a')
const OTHER_HEAD = sha('b')
const BASE = sha('c')
const PROCESS_WITNESS: ProvenWitness = { id: 'W1', run: 'pnpm exec vitest run scripts/tests/a.test.ts', test: 'reads the table [needs ps]' }
const PLAIN_WITNESS: ProvenWitness = { id: 'W2', run: 'pnpm exec vitest run scripts/tests/b.test.ts', test: 'reads nothing' }
const cleanups: (() => void)[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0))
    cleanup()
})

function cardText(witnesses: readonly ProvenWitness[]): string {
  const fields = witnesses.map(witness => ({ ...witness, head: 'pass', base: 'fail', proves: 'it holds' }))
  return parkingFileText({
    card: `#${CARD} review-sandbox-norm [implement/construct/S/cheap/auto] · depends — · blocks —`,
    branch: `feat/card-${CARD}`,
    touches: ['scripts/a.ts'],
    continue: 'stop',
    who: 'shift',
    body: ['Make it right.', '', `witnesses: ${JSON.stringify(fields)}`].join('\n'),
  })
}

interface Asked {
  bench: MergeBench
  proven: () => readonly ProvenWitness[] | undefined
}

function admitted(witnesses: readonly ProvenWitness[]): Asked & { worker: ReviewWorker } {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const bench = liveBench()
  cleanups.push(() => bench.close())
  const text = cardText(witnesses)
  const parsed = parseParkingFile(`${CARD}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(bench.db, 'worker:intake:test', admittedRecord({ id: CARD, file: `${CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now(), WINDOW_LANE))
  bench.tick()
  let asked: readonly ProvenWitness[] | undefined
  const reviewer: Reviewer = async (_lease, _plan, _card, proven) => {
    asked = proven
    return { verdict: 'pass', findings: [], session: 'review-session' }
  }
  const worker = new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer, plan: () => fullReview('a fixed plan'), clock: bench.clock.now, session: 'worker-1' })
  return { bench, worker, proven: () => asked }
}

function admittedBody(bench: MergeBench): string {
  const row = bench.db.prepare(`SELECT json_extract(payload, '$.bodySha') AS body FROM events WHERE type = ? AND card_id = ? ORDER BY id DESC LIMIT 1`).get(CARD_ADMITTED, CARD) as { body: string }
  return row.body
}

function witnessRecorded(bench: MergeBench, head: string, verdict: string): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: WITNESS_RECORDED, actor: 'worker:witness:test', cardId: CARD, pr: PR, head, dedupeKey: `${WITNESS_RECORDED}:${CARD}:${head}:${BASE}:${verdict}`, payload: { head, base: BASE, cardBody: admittedBody(bench), verdict, detail: '' }, legacy: false })
}

async function reviewed(witnesses: readonly ProvenWitness[], records: readonly (readonly [string, string])[]): Promise<readonly ProvenWitness[] | undefined> {
  const { bench, worker, proven } = admitted(witnesses)
  for (const [head, verdict] of records)
    witnessRecorded(bench, head, verdict)
  bench.gitHub.open({ number: PR, head: HEAD, ref: `feat/card-${CARD}`, body: cardBody(PR) })
  bench.tick()
  expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'pass' })
  return proven()
}

const lease = { taskKey: `review:${CARD}:${PR}:${HEAD}`, queue: 'review' as const, cardId: CARD, pr: PR, head: HEAD, leaseGen: 1, actor: 'worker:review:w' }

describe('the review takes the witness node\'s record for a declared process-table witness', () => {
  it('a [needs ps] witness recorded green by the witness node on the head is not re-run in review and is named an isolation gap', async () => {
    expect(await reviewed([PROCESS_WITNESS, PLAIN_WITNESS], [[HEAD, 'green']])).toEqual([PROCESS_WITNESS])

    const prompt = reviewPrompt(lease, fullReview('a fixed plan'), '/tmp/t', '/tmp/v.json', cardText([PROCESS_WITNESS, PLAIN_WITNESS]), null, [PROCESS_WITNESS])
    const line = provenWitnessLine(PROCESS_WITNESS, HEAD)
    expect(prompt).toContain(WITNESS_RUNS_LINE)
    expect(prompt).toContain(line)
    expect(line).toContain('do not run it or its mutations')
    expect(line).toContain(`"W1: ${ISOLATION_GAP}"`)
    expect(line).toContain('repeat that string exactly in advice')
    expect(line).toContain('no reason for changes on its own')
    expect(line).toContain(HEAD)
    expect(prompt).not.toContain('Witness W2 (')
  })

  it('a witness without [needs ps], or with no green witness record on this head, is still run by the review', async () => {
    expect(await reviewed([PLAIN_WITNESS], [[HEAD, 'green']])).toEqual([])
    expect(await reviewed([PROCESS_WITNESS], [])).toEqual([])
    expect(await reviewed([PROCESS_WITNESS], [[HEAD, 'red']])).toEqual([])
    expect(await reviewed([PROCESS_WITNESS], [[HEAD, 'green'], [HEAD, 'red']])).toEqual([])
    expect(await reviewed([PROCESS_WITNESS], [[OTHER_HEAD, 'green']])).toEqual([])

    const plan = fullReview('a fixed plan')
    const card = cardText([PROCESS_WITNESS])
    const prompt = reviewPrompt(lease, plan, '/tmp/t', '/tmp/v.json', card, null, [])
    expect(prompt).toBe(reviewPrompt(lease, plan, '/tmp/t', '/tmp/v.json', card))
    expect(prompt).toContain(WITNESS_RUNS_LINE)
    expect(prompt).not.toContain(ISOLATION_GAP)
  })
})
