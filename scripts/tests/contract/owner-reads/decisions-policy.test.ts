import type { Linter } from 'eslint'
import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../../core/lease.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../../core/db.js'
import { events, unspentShardRows } from '../../../core/events-query.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED, DECISIONS_IMPORTED, DECISIONS_PROJECTED, PR_OBSERVED, QUESTION_AGENT, REVIEW_RECORDED, SHARD_ISSUED, TASK_COMPLETED, TASK_RELEASED } from '../../../core/events.js'
import { TREE_CARRIER_QUEUE } from '../../../core/lease.js'
import { NETWATCH } from '../../../core/observations.js'
import { reduce } from '../../../core/reducer.js'
import { answerSourceOf, cardSessionOf, carriedTreeOf, failedChecksOn, openPrOfCard, ownerHoldOf } from '../../../nodes/answer/answer-source.js'
import { decisionRows, recordDecision } from '../../../policy/decisions/index.js'
import { busProjections, DECISION_EVENT_READS } from '../../../supervisor/composition.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY } = await import(CONFIG_URL) as { FOREIGN_TABLE_SQL_POLICY: Linter.Config[] }
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const EXCEPTED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/foreign-table-sql-excepted.json'), 'utf8')) as string[]

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000
const RELATIVE_IMPORT = /from '(\.{1,2}\/[^']+)'/g

const DECISIONS_INDEX = 'scripts/policy/decisions/index.ts'
const ANSWER_SOURCE = 'scripts/nodes/answer/answer-source.ts'
const SHARDS = 'scripts/policy/shards.ts'
const FILES = [DECISIONS_INDEX, ANSWER_SOURCE, SHARDS]
const OWNER_OF = { [DECISIONS_INDEX]: 'decisions', [ANSWER_SOURCE]: 'node-answer', [SHARDS]: 'rules' }
const UNDECIDED_READERS = [DECISIONS_INDEX, SHARDS]
const OWNERS_ABOVE_THE_UNDECIDED = ['pr-record']

function sourceOfImport(file: string, specifier: string): string {
  return path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, '.ts')
}

function importsOf(file: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
  return [...text.matchAll(RELATIVE_IMPORT)].map(match => sourceOfImport(file, match[1]!))
}

async function ruleWithoutExceptions(): Promise<ESLint> {
  const eslint = new ESLint({ cwd: REPO_ROOT })
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, FILES[0]!)) as { languageOptions: { parser: Linter.Parser } }
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.{ts,mts,cts,js,mjs,cjs}'], languageOptions: { parser: config.languageOptions.parser, sourceType: 'module' }, linterOptions: { reportUnusedDisableDirectives: 'off' } },
      ...FOREIGN_TABLE_SQL_POLICY.map(block => ({ ...block, ignores: (block.ignores ?? []).filter(ignored => !EXCEPTED.includes(ignored)) })),
    ],
  })
}

async function foreignTablesOf(files: readonly string[]): Promise<Record<string, string[]>> {
  const results = await (await ruleWithoutExceptions()).lintFiles([...files])
  return Object.fromEntries(results.map(result => [
    path.relative(REPO_ROOT, result.filePath),
    [...new Set(result.messages.filter(message => message.ruleId === RULE).map(message => NAMED_TABLE.exec(message.message)?.[1] ?? message.message))].sort(),
  ]))
}

function noneOf(files: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(files.map(file => [file, []]))
}

describe('decisions index, answer-source and shards read the tables of other owners only through their contracts', () => {
  it('each file belongs to its module and has left the excepted list', () => {
    for (const [file, owner] of Object.entries(OWNER_OF))
      expect(MODULE_FILES[owner]).toContain(file)
    expect(EXCEPTED.filter(file => FILES.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in them', async () => {
    expect(await foreignTablesOf(FILES)).toEqual(noneOf(FILES))
  }, LINT_MS)

  it('neither decisions index nor shards imports a file of pr-record', () => {
    const above = new Set(OWNERS_ABOVE_THE_UNDECIDED.flatMap(owner => MODULE_FILES[owner] ?? []))
    expect(Object.fromEntries(UNDECIDED_READERS.map(file => [file, importsOf(file).filter(imported => above.has(imported))]))).toEqual(noneOf(UNDECIDED_READERS))
  })

  it('the shard fragments composition binds into merge candidates are the bus\'s, not the rules\'', () => {
    const shards = readFileSync(path.join(REPO_ROOT, SHARDS), 'utf8')
    expect(shards).not.toMatch(/export (?:const|function) (?:WINDOW_SHARDS_LIVE_AT|unspentShardsOf)\b/)
    expect(importsOf('scripts/supervisor/composition.ts')).toContain('scripts/core/events-query.ts')
  })
})

const CARD = 2269
const PR = 1931
const NEWER_PR = PR + 1
const HEAD = 'a'.repeat(40)
const OTHER_HEAD = 'b'.repeat(40)
const UNOBSERVED_HEAD = 'c'.repeat(40)
const TS = '2026-11-24T00:00:00.000Z'
const NOW = new Date(TS)
const REVIEWER = 'worker:review:session-1'
const LAUNCH = 'worker:launch:launch-1'

const buses: DatabaseSync[] = []

afterEach(() => {
  for (const db of buses.splice(0))
    db.close()
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  buses.push(db)
  return db
}

let keys = 0

interface Written {
  type: string
  actor?: string | null
  cardId?: number | null
  pr?: number | null
  head?: string | null
  payload: Record<string, unknown>
  legacy?: boolean
}

function written(db: DatabaseSync, event: Written): number {
  keys += 1
  appendEvent(db, { ts: TS, actor: LAUNCH, cardId: CARD, pr: null, head: null, legacy: false, ...event, dedupeKey: `${event.type}:tail-${keys}` })
  return Math.max(...events(db, { legacy: 'either' }).map(row => row.id))
}

function observed(db: DatabaseSync, pr: number, fields: Record<string, unknown>): void {
  const head = typeof fields.head === 'string' ? fields.head : HEAD
  written(db, { type: PR_OBSERVED, actor: NETWATCH, pr, head, payload: { base: 'main', mergeable: 'clean', ci: 'green', draft: false, auto_merge: false, ...fields, head } })
}

function reviewed(db: DatabaseSync, head: string, verdict: string, findings: string[]): void {
  written(db, { type: REVIEW_RECORDED, actor: REVIEWER, pr: PR, head, payload: { head, verdict, reviewer_session: 'session-1', findings } })
}

function leaseAt(head: string): Lease {
  return { taskKey: `answer:${CARD}`, cardId: CARD, pr: PR, head, leaseGen: 1, actor: 'worker:answer:worker-1' } as unknown as Lease
}

function cardLease(): Lease {
  return { taskKey: `answer:${CARD}`, cardId: CARD, pr: null, head: null, leaseGen: 1, actor: 'worker:answer:worker-1' } as unknown as Lease
}

function projected(db: DatabaseSync): void {
  reduce(db, 'pending', busProjections())
}

describe('the answer source reads the newest of what stands on the card and its head', () => {
  it('names the newest of two open draft pull requests a bus holds for one card', () => {
    const db = bus()
    const event = written(db, { type: CARD_STARTED, payload: { session: 's', worktree: '/trees/a', branch: 'feat/a' } })
    for (const pr of [PR, NEWER_PR])
      db.prepare(`INSERT INTO prs (pr, card_id, base, head, state, ci, draft, event_id) VALUES (?, ?, 'main', ?, 'open', 'green', 1, ?)`).run(pr, CARD, HEAD, event)
    expect(openPrOfCard(db, CARD)).toBe(NEWER_PR)
    expect(ownerHoldOf(db, CARD)).toContain(`#${NEWER_PR},`)
  })

  it('takes the findings of the newest changes review at the lease head, past a later pass and a review of another head', () => {
    const db = bus()
    observed(db, PR, { verdict_on_head: 'changes' })
    projected(db)
    reviewed(db, HEAD, 'changes', ['the older finding'])
    reviewed(db, HEAD, 'changes', ['the newer finding'])
    reviewed(db, HEAD, 'pass', ['a pass is no finding'])
    reviewed(db, OTHER_HEAD, 'changes', ['a finding of another head'])
    expect(answerSourceOf(db, leaseAt(HEAD), NOW)).toMatchObject({ kind: 'changes', findings: ['the newer finding'] })
  })

  it('takes the failed checks of the newest red observation at the lease head', () => {
    const db = bus()
    observed(db, PR, { ci: 'red', failed_checks: ['the older check'] })
    observed(db, PR, { ci: 'red', failed_checks: ['the newer check'] })
    projected(db)
    expect(failedChecksOn(db, leaseAt(HEAD))).toEqual(['the newer check'])
  })

  it('reads nothing for a lease whose head is not the head the pull request stands at', () => {
    const db = bus()
    observed(db, PR, { ci: 'red', verdict_on_head: 'changes', failed_checks: ['a check'] })
    projected(db)
    expect(answerSourceOf(db, leaseAt(UNOBSERVED_HEAD), NOW)).toBeNull()
  })

  it('hands the latest events of the card oldest first', () => {
    const db = bus()
    written(db, { type: CARD_STARTED, payload: { session: 's', worktree: '/trees/a', branch: 'feat/a' } })
    written(db, { type: CARD_STOPPED, payload: { reason: QUESTION_AGENT, detail: 'which?' } })
    const ids = answerSourceOf(db, cardLease(), NOW)!.events.map(event => event.id)
    expect(ids).toHaveLength(2)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })

  it('an answered stop is no longer the standing question', () => {
    const db = bus()
    written(db, { type: CARD_STOPPED, payload: { reason: QUESTION_AGENT, detail: 'which?' } })
    expect(answerSourceOf(db, cardLease(), NOW)).toMatchObject({ kind: 'question' })
    written(db, { type: CARD_ANSWERED, actor: 'worker:answer:worker-1', payload: { session: 's' } })
    expect(answerSourceOf(db, cardLease(), NOW)).toBeNull()
  })

  it('a release that carries no tree does not hide the tree an older end carried', () => {
    const db = bus()
    const tree = { path: '/trees/a', head: HEAD, localCommits: [], dirty: false }
    written(db, { type: TASK_COMPLETED, actor: 'worker:answer:worker-1', payload: { queue: TREE_CARRIER_QUEUE, task_key: `answer:${CARD}`, lease_gen: 1, tree } })
    written(db, { type: TASK_RELEASED, actor: 'worker:answer:worker-1', payload: { queue: TREE_CARRIER_QUEUE, task_key: `answer:${CARD}`, lease_gen: 2, reason: 'released' } })
    expect(carriedTreeOf(db, CARD)).toEqual(tree)
  })

  it('a legacy path line naming no tree does not hide an older one that names it', () => {
    const db = bus()
    written(db, { type: 'path', actor: null, legacy: true, payload: { worktree: '/trees/a', branch: 'feat/a' } })
    written(db, { type: 'path', actor: null, legacy: true, payload: { path: 'cheap' } })
    expect(cardSessionOf(db, CARD)).toMatchObject({ worktree: '/trees/a', branch: 'feat/a' })
  })
})

describe('the decision and shard readings keep their order and their drops', () => {
  it('an import is projected before only by a projection that precedes it', () => {
    const db = bus()
    const imported = written(db, { type: DECISIONS_IMPORTED, actor: NETWATCH, cardId: null, payload: { decisions: [] } })
    const projection = written(db, { type: DECISIONS_PROJECTED, actor: NETWATCH, cardId: null, payload: {} })
    expect(DECISION_EVENT_READS.projectedBefore(db, imported)).toBe(false)
    expect(DECISION_EVENT_READS.projectedBefore(db, projection + 1)).toBe(true)
  })

  it('two unspent shards of one card come oldest first', () => {
    const db = bus()
    written(db, { type: SHARD_ISSUED, actor: 'owner', payload: { id: 'shard-old', under: 'D-1' } })
    written(db, { type: SHARD_ISSUED, actor: 'owner', payload: { id: 'shard-new', under: 'D-2' } })
    expect(unspentShardRows(db, CARD, null).map(row => row.id)).toEqual(['shard-old', 'shard-new'])
  })

  it('a decision row whose event cannot be read is dropped', () => {
    const db = bus()
    recordDecision(db, { ts: TS, decisionId: 9001, text: 'a decision', cards: [CARD] })
    projected(db)
    expect(decisionRows(db, DECISION_EVENT_READS)).toHaveLength(1)
    expect(decisionRows(db, { ...DECISION_EVENT_READS, tsOf: () => new Map() })).toEqual([])
  })
})
