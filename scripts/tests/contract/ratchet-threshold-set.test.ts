import type { GhResponse, GitHub, GitHubPut } from '../../ports/github.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { renderRatchet } from '../../contract/ratchet.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, COMMAND_EXECUTED, POLICY_ALLOWED, POLICY_DENIED, RATCHET_THRESHOLD_SET, UPDATE_DONE } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { cardContract } from '../../intake/card-contract.js'
import { raisedRatchet, RATCHET_RECORD_PATH, UpdateExecutor } from '../../nodes/update/update-executor.js'
import { mergePolicy } from '../../policy/policy.js'
import { ratchetThresholdSets, updateParts } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, REPO, sha } from '../bus/github-fake.js'
import { eventsOf, liveBench, mainMovesPastEveryPr } from '../bus/merge-bench.js'
import { detectUpdate } from '../bus/update-detection.js'

const PR = 1150
const CARD = PR + 100
const BRANCH = `feat/card-${CARD}`
const TOUCHES = 'scripts/x.ts'
const ROW = 'lines:scripts/big.ts'
const RECORDED = renderRatchet({ 'threshold': 800, [ROW]: 900, 'overlaps:bus-read': 471 })
const CONTENT_SHA = sha('c')
const WRITTEN_COMMIT = sha('e')
const CONTENTS = `${REPO}/contents/${RATCHET_RECORD_PATH}`

interface Written {
  endpoint: string
  fields: Record<string, string>
}

function admitted(bench: MergeBench): void {
  const text = `card: #${CARD} task-${CARD} [implement/construct/S/cheap/owner] · depends — · blocks —\nbranch: ${BRANCH}\ntouches: ${TOUCHES}\nwho: shift\n\ndo ${CARD}\n`
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { text, textSha: textSha(text), lane: null, decision: 'owner', contour: 'cheap', depends: [] }, legacy: false })
}

function thresholdSet(bench: MergeBench, to: number, decision: string): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: RATCHET_THRESHOLD_SET, actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: `${RATCHET_THRESHOLD_SET}:${CARD}:${decision}`, payload: { row: ROW, to, decision }, legacy: false })
}

interface ContentsAnswers {
  read: GhResponse['body']
  write: GhResponse
}

const RECORDED_READ = { content: Buffer.from(RECORDED).toString('base64'), sha: CONTENT_SHA }
const WRITE_ACCEPTED: GhResponse = { status: 200, headers: {}, body: { commit: { sha: WRITTEN_COMMIT } } }
const ANSWERED: ContentsAnswers = { read: RECORDED_READ, write: WRITE_ACCEPTED }

function updateBench(sets: (bench: MergeBench) => void, answers: ContentsAnswers = ANSWERED) {
  const bench = liveBench()
  admitted(bench)
  sets(bench)
  bench.gitHub.open({ number: PR, mergeable_state: 'behind', review: 'success' })
  bench.tick()
  mainMovesPastEveryPr(bench)
  detectUpdate(bench)
  const reads: string[] = []
  const written: Written[] = []
  const gitHub: GitHub = (endpoint) => {
    if (endpoint !== `${CONTENTS}?ref=${BRANCH}`)
      return bench.gitHub.client(endpoint)
    reads.push(endpoint)
    return { status: 200, headers: {}, body: answers.read }
  }
  const put: GitHubPut = (endpoint, fields): GhResponse => {
    if (endpoint !== CONTENTS)
      return bench.gitHub.put(endpoint, fields)
    written.push({ endpoint, fields })
    return answers.write
  }
  const executor = new UpdateExecutor({ source: updateParts(), silentMs: SILENT_MS, db: bench.db, gitHub, put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {}, thresholds: ratchetThresholdSets(bench.db) })
  const outcome = executor.update(leaseNext(bench.db, bench.clock.now().toISOString(), 'update', 'worker:update:worker-1')!)
  return { bench, outcome, reads, written }
}

function decoded(fields: Record<string, string>): Record<string, number> {
  return JSON.parse(Buffer.from(fields.content!, 'base64').toString('utf8')) as Record<string, number>
}

describe('ratchet.threshold.set applied on update', () => {
  it('an owner answer recorded as ratchet.threshold.set is written into contract/ratchet.json on the card branch by the update, with no hand edit and no touch on the card', () => {
    const { bench, outcome, written } = updateBench(made => thresholdSet(made, 940, 'D-999'))
    try {
      expect(written).toHaveLength(1)
      expect(written[0]!.fields).toMatchObject({ sha: CONTENT_SHA, branch: BRANCH })
      expect(decoded(written[0]!.fields)).toEqual({ 'threshold': 800, [ROW]: 940, 'overlaps:bus-read': 471 })
      expect(Buffer.from(written[0]!.fields.content!, 'base64').toString('utf8')).toBe(renderRatchet({ 'threshold': 800, [ROW]: 940, 'overlaps:bus-read': 471 }))
      expect(bench.gitHub.puts.map(call => call.endpoint)).toEqual([])
      expect(outcome).toMatchObject({ kind: 'updated', from: sha('a'), to: WRITTEN_COMMIT, carry: { carried: null, clean: false } })
      expect(eventsOf(bench.db, UPDATE_DONE)).toEqual([expect.objectContaining({ from: sha('a'), to: WRITTEN_COMMIT })])
      expect(eventsOf(bench.db, POLICY_ALLOWED)).toContainEqual(expect.objectContaining({ command: 'ratchet_threshold' }))
      expect(eventsOf(bench.db, COMMAND_EXECUTED)).toContainEqual(expect.objectContaining({ command: 'ratchet_threshold', ok: true, status: 200 }))
      expect(cardContract(bench.db, CARD)?.touches).toEqual([TOUCHES])
    }
    finally {
      bench.close()
    }
  })

  it('a card with no recorded threshold set is updated as before and its ratchet is neither read nor written', () => {
    const { bench, outcome, reads, written } = updateBench(() => {})
    try {
      expect({ reads, written }).toEqual({ reads: [], written: [] })
      expect(bench.gitHub.puts.map(call => call.endpoint)).toEqual([`${REPO}/pulls/${PR}/update-branch`])
      expect(outcome.kind).toBe('updated')
    }
    finally {
      bench.close()
    }
  })

  it('a threshold the branch already holds is not written again, so the update goes on as before', () => {
    const { bench, reads, written } = updateBench(made => thresholdSet(made, 900, 'D-998'))
    try {
      expect({ reads: reads.length, written }).toEqual({ reads: 1, written: [] })
      expect(bench.gitHub.puts.map(call => call.endpoint)).toEqual([`${REPO}/pulls/${PR}/update-branch`])
    }
    finally {
      bench.close()
    }
  })

  it.each([
    ['no content', { sha: CONTENT_SHA }],
    ['no sha', { content: RECORDED_READ.content }],
  ])('a ratchet read that comes back with %s is denied and nothing is written or updated', (_missing, read) => {
    const { bench, outcome, written } = updateBench(made => thresholdSet(made, 940, 'D-997'), { ...ANSWERED, read })
    try {
      expect(written).toEqual([])
      expect(bench.gitHub.puts).toEqual([])
      expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'github_error', detail: expect.stringContaining('no content or sha') } })
      expect(eventsOf(bench.db, UPDATE_DONE)).toEqual([])
    }
    finally {
      bench.close()
    }
  })

  it.each([
    ['a status other than 200 or 201', { status: 409, headers: {}, body: { commit: { sha: WRITTEN_COMMIT } } }],
    ['no commit sha', { status: 201, headers: {}, body: { commit: {} } }],
  ])('a ratchet write answered with %s is denied, recorded as a failed command, and completes no update', (_answer, write: GhResponse) => {
    const { bench, outcome, written } = updateBench(made => thresholdSet(made, 940, 'D-996'), { ...ANSWERED, write })
    try {
      expect(written).toHaveLength(1)
      expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'github_error' } })
      expect(eventsOf(bench.db, COMMAND_EXECUTED)).toContainEqual(expect.objectContaining({ command: 'ratchet_threshold', ok: false, status: write.status }))
      expect(eventsOf(bench.db, POLICY_DENIED)).toHaveLength(1)
      expect(eventsOf(bench.db, UPDATE_DONE)).toEqual([])
    }
    finally {
      bench.close()
    }
  })

  it.each([
    ['a non-number to', { row: ROW, to: '940', decision: 'D-995' }],
    ['a non-string row', { row: 7, to: 940, decision: 'D-995' }],
    ['a missing decision', { row: ROW, to: 940 }],
  ])('a ratchet.threshold.set with %s is skipped by the reader, so the update neither reads nor writes the ratchet', (_malformed, payload) => {
    const { bench, reads, written } = updateBench(made => appendEvent(made.db, { ts: made.clock.now().toISOString(), type: RATCHET_THRESHOLD_SET, actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: `${RATCHET_THRESHOLD_SET}:${CARD}:malformed`, payload, legacy: false }))
    try {
      expect(ratchetThresholdSets(bench.db)(CARD)).toEqual([])
      expect({ reads, written }).toEqual({ reads: [], written: [] })
      expect(bench.gitHub.puts.map(call => call.endpoint)).toEqual([`${REPO}/pulls/${PR}/update-branch`])
    }
    finally {
      bench.close()
    }
  })

  it('a set only raises its row: a lower answer leaves the record unchanged, and a new row is added in the rendered order', () => {
    expect(raisedRatchet(RECORDED, [{ row: ROW, to: 850, decision: 'D-1' }])).toBeNull()
    expect(raisedRatchet(RECORDED, [{ row: 'lines:scripts/new.ts', to: 810, decision: 'D-1' }])).toBe(renderRatchet({ ...JSON.parse(RECORDED) as Record<string, number>, 'lines:scripts/new.ts': 810 }))
  })

  it('a growth of the ratchet with no recorded decision is still refused to the bus merge', () => {
    const growth = { filename: RATCHET_RECORD_PATH, patch: `@@ -1,3 +1,3 @@\n {\n-  "${ROW}": 900,\n+  "${ROW}": 940,\n   "threshold": 800\n` }
    const verdict = mergePolicy({ cardId: CARD, description: cardBody(PR), headRef: BRANCH, title: `feat: card #${CARD}`, files: [RATCHET_RECORD_PATH], patched: [growth], ownerMergesText: readFileSync('architecture/owner-merges.md', 'utf8'), shardActive: false, shardUnder: null, windowShard: null, decisions: [] })
    expect(verdict).toMatchObject({ kind: 'denied', rule: 'ratchet_grows' })
  })
})
