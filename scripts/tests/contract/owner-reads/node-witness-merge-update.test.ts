import type { Linter } from 'eslint'
import type { DatabaseSync } from 'node:sqlite'
import type { TimedShellResult } from '../../../nodes/witness/witness-executor.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../../src/card/parking.js'
import { textSha } from '../../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { lastEventId } from '../../../core/events-query.js'
import { CARD_ADMITTED, CARD_STARTED, POLICY_DENIED, PR_OBSERVED, REVIEW_RECORDED, SHARD_ISSUED, TASK_FAILED, UPDATE_DONE, WITNESS_RECORDED } from '../../../core/events.js'
import { anOpenPrOnTheHead } from '../../../core/pr-readings.js'
import { WITHDRAWN } from '../../../core/queue.js'
import { reduce } from '../../../core/reducer.js'
import { mergeSource } from '../../../nodes/merge/merge-candidates.js'
import { manualUpdateDone, recordedVerdictOn } from '../../../nodes/update/update-executor.js'
import { witnessCandidates, witnessSource } from '../../../nodes/witness/witness-candidates.js'
import { UNFIT } from '../../../nodes/witness/witness-executor.js'
import { WitnessNode } from '../../../nodes/witness/witness-worker.js'
import { SetupTurns, withWorktreeAsync } from '../../../ports/worktree.js'
import { busProjections, mergeParts, witnessParts } from '../../../supervisor/composition.js'
import { SILENT_MS } from '../../../supervisor/liveness-sites.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY } = await import(CONFIG_URL) as { FOREIGN_TABLE_SQL_POLICY: Linter.Config[] }
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const EXCEPTED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/foreign-table-sql-excepted.json'), 'utf8')) as string[]

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000

const FILES_OF_MODULE: Record<string, readonly string[]> = {
  'node-witness': ['scripts/nodes/witness/witness-candidates.ts', 'scripts/nodes/witness/witness-executor.ts'],
  'node-merge': ['scripts/nodes/merge/merge-candidates.ts'],
  'node-update': ['scripts/nodes/update/update-candidates.ts', 'scripts/nodes/update/update-executor.ts'],
}
const READERS = Object.values(FILES_OF_MODULE).flat()

async function ruleWithoutExceptions(): Promise<ESLint> {
  const eslint = new ESLint({ cwd: REPO_ROOT })
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, READERS[0]!)) as { languageOptions: { parser: Linter.Parser } }
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
    result.messages.filter(message => message.ruleId === RULE).map(message => `${NAMED_TABLE.exec(message.message)?.[1] ?? message.message}:${message.line}`),
  ]))
}

describe('the witness, merge and update nodes read the tables of other owners only through their contracts', () => {
  it('each file belongs to its node and none stays on the excepted list', () => {
    for (const [module, files] of Object.entries(FILES_OF_MODULE)) {
      for (const file of files)
        expect(MODULE_FILES[module]).toContain(file)
    }
    expect(EXCEPTED.filter(file => READERS.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in any of them', async () => {
    expect(await foreignTablesOf(READERS)).toEqual(Object.fromEntries(READERS.map(file => [file, []])))
  }, LINT_MS)
})

const TS = '2026-11-26T10:00:00.000Z'
const CARD = 4101
const OTHER_CARD = 4102
const PR = 5101
const OTHER_PR = 5102
const fullSha = (digit: string): string => digit.repeat(40)
const HEAD = fullSha('a')
const OLD_HEAD = fullSha('b')
const BASE = fullSha('1')
const OTHER_BASE = fullSha('2')
const CARD_BODY = 'c'.repeat(40)
const dbs: DatabaseSync[] = []
const roots: string[] = []
let serial = 0

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  dbs.push(db)
  return db
}

interface EventFields { cardId?: number | null, pr?: number | null, head?: string | null, payload?: Record<string, unknown> }

function recorded(db: DatabaseSync, type: string, fields: EventFields = {}): number {
  serial += 1
  appendEvent(db, { ts: TS, type, actor: 'owner', cardId: fields.cardId ?? null, pr: fields.pr ?? null, head: fields.head ?? null, dedupeKey: `${type}:owner-reads-${serial}`, payload: fields.payload ?? {}, legacy: false })
  return lastEventId(db)
}

interface WithdrawnTask { key: string, queue: 'merge' | 'close', cardId: number, pr: number | null, head: string }

function withdrawn(db: DatabaseSync, task: WithdrawnTask): number {
  const id = recorded(db, TASK_FAILED, { cardId: task.cardId, pr: task.pr, head: task.head, payload: { task_key: task.key, reason: 'technical' } })
  db.prepare('INSERT INTO tasks (task_key, queue, card_id, pr, head, state, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(task.key, task.queue, task.cardId, task.pr, task.head, WITHDRAWN, id)
  return id
}

function pullRequest(db: DatabaseSync, pr: number, cardId: number, head: string, state = 'open'): void {
  const id = recorded(db, PR_OBSERVED, { cardId, pr, head })
  db.prepare('INSERT OR REPLACE INTO prs (pr, card_id, base, head, state, draft, event_id) VALUES (?, ?, ?, ?, ?, 0, ?)').run(pr, cardId, 'main', head, state, id)
}

function shardIssued(db: DatabaseSync, cardId: number): void {
  recorded(db, SHARD_ISSUED, { cardId, payload: { id: `shard-${serial}` } })
}

function requeuedMerges(db: DatabaseSync): string[] {
  return mergeSource(mergeParts()).requeue!(db, TS).map(row => row.task_key)
}

const MERGE_KEY = `merge:${CARD}:${PR}:${HEAD}`

describe('a withdrawn merge is requeued by a later shard only on its open head', () => {
  it('a shard issued after the withdrawal requeues it', () => {
    const db = bus()
    pullRequest(db, PR, CARD, HEAD)
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: PR, head: HEAD })
    shardIssued(db, CARD)

    expect(requeuedMerges(db)).toEqual([MERGE_KEY])
  })

  it('a shard issued before the withdrawal does not requeue it', () => {
    const db = bus()
    pullRequest(db, PR, CARD, HEAD)
    shardIssued(db, CARD)
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: PR, head: HEAD })

    expect(requeuedMerges(db)).toEqual([])
  })

  it('a later shard does not requeue a merge whose pull request closed', () => {
    const db = bus()
    pullRequest(db, PR, CARD, HEAD, 'closed')
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: PR, head: HEAD })
    shardIssued(db, CARD)

    expect(requeuedMerges(db)).toEqual([])
  })

  it('a later shard does not requeue a merge withdrawn on a head the pull request has moved past', () => {
    const db = bus()
    pullRequest(db, PR, CARD, HEAD)
    const oldKey = `merge:${CARD}:${PR}:${OLD_HEAD}`
    withdrawn(db, { key: oldKey, queue: 'merge', cardId: CARD, pr: PR, head: OLD_HEAD })
    shardIssued(db, CARD)

    expect(requeuedMerges(db)).toEqual([])
  })

  it('requeues by task key, not by the order the tasks were withdrawn in', () => {
    const db = bus()
    pullRequest(db, PR, CARD, HEAD)
    pullRequest(db, OTHER_PR, CARD, OLD_HEAD)
    const later = `merge:${CARD}:${OTHER_PR}:${OLD_HEAD}`
    withdrawn(db, { key: later, queue: 'merge', cardId: CARD, pr: OTHER_PR, head: OLD_HEAD })
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: PR, head: HEAD })
    shardIssued(db, CARD)

    expect(requeuedMerges(db)).toEqual([MERGE_KEY, later])
  })
})

describe('an open pull request on the head', () => {
  it('is on the head it was observed on and on no other', () => {
    const db = bus()
    pullRequest(db, PR, CARD, HEAD)

    expect(anOpenPrOnTheHead(db, PR, HEAD)).toBe(true)
    expect(anOpenPrOnTheHead(db, PR, OLD_HEAD)).toBe(false)
  })
})

function reviewed(db: DatabaseSync, head: string, verdict: string): void {
  recorded(db, REVIEW_RECORDED, { cardId: CARD, pr: PR, head, payload: { head, verdict } })
}

describe('the verdict recorded on a head', () => {
  it('is the newest review on that head', () => {
    const db = bus()
    reviewed(db, HEAD, 'changes')
    reviewed(db, HEAD, 'pass')

    expect(recordedVerdictOn(db, PR, HEAD)).toEqual({ verdict: 'pass', rulesVersion: null })
  })

  it('is not a newer review on another head', () => {
    const db = bus()
    reviewed(db, HEAD, 'pass')
    reviewed(db, OLD_HEAD, 'changes')

    expect(recordedVerdictOn(db, PR, HEAD)).toEqual({ verdict: 'pass', rulesVersion: null })
  })

  it('is not an update onto the head that carried nothing', () => {
    const db = bus()
    reviewed(db, HEAD, 'pass')
    appendEvent(db, manualUpdateDone({ ts: TS, session: 'window', cardId: CARD, pr: PR, from: OLD_HEAD, to: HEAD }))

    expect(recordedVerdictOn(db, PR, HEAD)).toEqual({ verdict: 'pass', rulesVersion: null })
  })

  it('is the verdict an update onto the head carried', () => {
    const db = bus()
    reviewed(db, HEAD, 'changes')
    recorded(db, UPDATE_DONE, { cardId: CARD, pr: PR, head: OLD_HEAD, payload: { from: OLD_HEAD, to: HEAD, carried: 'pass' } })

    expect(recordedVerdictOn(db, PR, HEAD)).toEqual({ verdict: 'pass', rulesVersion: null })
  })
})

function witnessDenied(db: DatabaseSync, cardId: number, head: string, payload: Record<string, unknown>, pr: number | null = null): void {
  recorded(db, POLICY_DENIED, { cardId, pr, head, payload: { reason: 'witness', ...payload } })
}

function witnessRecorded(db: DatabaseSync, cardId: number, head: string, payload: Record<string, unknown>): void {
  recorded(db, WITNESS_RECORDED, { cardId, head, payload: { head, cardBody: CARD_BODY, ...payload } })
}

function requeuedOnAWitness(db: DatabaseSync): string[] {
  return witnessSource().requeue!(db, TS).map(row => row.task_key)
}

const CLOSE_KEY = `close:${CARD}:-:${HEAD}`

describe('a task withdrawn on a witness is requeued once the witness is green on the denied base', () => {
  it('a green record after the withdrawal requeues a withdrawn close', () => {
    const db = bus()
    witnessDenied(db, CARD, HEAD, { command: 'close', base: BASE })
    withdrawn(db, { key: CLOSE_KEY, queue: 'close', cardId: CARD, pr: null, head: HEAD })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'green' })

    expect(requeuedOnAWitness(db)).toEqual([CLOSE_KEY])
  })

  it('a red record after the withdrawal does not requeue it', () => {
    const db = bus()
    witnessDenied(db, CARD, HEAD, { command: 'close', base: BASE })
    withdrawn(db, { key: CLOSE_KEY, queue: 'close', cardId: CARD, pr: null, head: HEAD })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'red' })

    expect(requeuedOnAWitness(db)).toEqual([])
  })

  it('a green record from before the withdrawal does not requeue it', () => {
    const db = bus()
    witnessDenied(db, CARD, HEAD, { command: 'close', base: BASE })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'green' })
    withdrawn(db, { key: CLOSE_KEY, queue: 'close', cardId: CARD, pr: null, head: HEAD })

    expect(requeuedOnAWitness(db)).toEqual([])
  })

  it('a witness denial of the other command does not decide this queue', () => {
    const db = bus()
    witnessDenied(db, CARD, HEAD, { command: 'merge', base: BASE })
    withdrawn(db, { key: CLOSE_KEY, queue: 'close', cardId: CARD, pr: null, head: HEAD })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'green' })

    expect(requeuedOnAWitness(db)).toEqual([])
  })

  it('a green witness requeues a withdrawn merge on its open head', () => {
    const db = bus()
    pullRequest(db, PR, CARD, HEAD)
    witnessDenied(db, CARD, HEAD, { command: 'merge', base: BASE }, PR)
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: PR, head: HEAD })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'green' })

    expect(requeuedOnAWitness(db)).toEqual([MERGE_KEY])
  })

  it('a green witness does not requeue a withdrawn merge whose pull request closed', () => {
    const db = bus()
    pullRequest(db, PR, CARD, HEAD, 'closed')
    witnessDenied(db, CARD, HEAD, { command: 'merge', base: BASE }, PR)
    withdrawn(db, { key: MERGE_KEY, queue: 'merge', cardId: CARD, pr: PR, head: HEAD })
    witnessRecorded(db, CARD, HEAD, { base: BASE, verdict: 'green' })

    expect(requeuedOnAWitness(db)).toEqual([])
  })
})

function admitted(db: DatabaseSync, cardId: number, bodySha = CARD_BODY): void {
  recorded(db, CARD_ADMITTED, { cardId, payload: { card: `#${cardId}`, bodySha } })
}

describe('a witness candidate on a denied base', () => {
  it('opens only on the latest witness denial of the card on the head', () => {
    const db = bus()
    admitted(db, CARD)
    witnessDenied(db, CARD, HEAD, { command: 'merge', base: OTHER_BASE }, PR)
    witnessDenied(db, CARD, HEAD, { command: 'merge', base: BASE }, PR)

    expect(witnessCandidates(db, TS, witnessParts()).map(task => task.base)).toEqual([BASE])
  })
})

const WITNESSED_BODY = 'Write done.txt.\n\nWitnesses:\n- `test -f done.txt` exits 0; red on main'

function startedOnMain(db: DatabaseSync, cardId: number): void {
  const text = parkingFileText({ card: `#${cardId} witnessed [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: `feat/witnessed-${cardId}`, touches: ['done.txt'], continue: 'stop', who: 'shift', body: WITNESSED_BODY })
  admitted(db, cardId)
  const admission = lastEventId(db)
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha) VALUES (?, ?, ?, ?)').run(cardId, admission, text, textSha(text))
  recorded(db, CARD_STARTED, { cardId })
}

function mainRecorded(db: DatabaseSync): void {
  const id = recorded(db, 'main.advanced', { head: BASE })
  db.prepare('INSERT INTO mains (sha, touches_mechanics, event_id) VALUES (?, 0, ?)').run(BASE, id)
}

function cardIn(db: DatabaseSync, cardId: number, state: string): void {
  db.prepare('INSERT OR REPLACE INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)').run(cardId, state, lastEventId(db))
}

function witnessedOnMain(db: DatabaseSync): number[] {
  return witnessCandidates(db, TS, witnessParts()).filter(task => task.pr === undefined).map(task => task.cardId)
}

describe('a witness candidate on main', () => {
  it('opens for a started card with witnesses and no pull request', () => {
    const db = bus()
    mainRecorded(db)
    startedOnMain(db, CARD)

    expect(witnessedOnMain(db)).toEqual([CARD])
  })

  it('does not open for a card that has a pull request', () => {
    const db = bus()
    mainRecorded(db)
    startedOnMain(db, CARD)
    pullRequest(db, PR, CARD, HEAD, 'closed')

    expect(witnessedOnMain(db)).toEqual([])
  })

  it.each(['dropped', 'merged'])('does not open for a %s card', (state) => {
    const db = bus()
    mainRecorded(db)
    startedOnMain(db, CARD)
    startedOnMain(db, OTHER_CARD)
    cardIn(db, CARD, state)

    expect(witnessedOnMain(db)).toEqual([OTHER_CARD])
  })
})

const ADDED_TEST = 'tests/newdir/a.test.ts'
const FOREIGN_TEST = 'tests/other/b.test.ts'
const VITEST_RUN = /vitest run (\S+)/
const NOW = '2026-11-26T10:02:00.000Z'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

function committed(repo: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), text)
    git(repo, 'add', file)
  }
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

async function vitestLike(command: string, cwd: string): Promise<TimedShellResult> {
  const target = VITEST_RUN.exec(command)?.[1]
  const found = target !== undefined && existsSync(path.join(cwd, target))
  return found ? { status: 0, output: ' Test Files  1 passed (1)\n      Tests  1 passed (1)\n', timedOut: false } : { status: 1, output: `No test files found, exiting with code 1\nfilter: ${target ?? ''}\n`, timedOut: false }
}

function admittedWith(db: DatabaseSync, touches: string[], at: string, suffix: string): void {
  const witness = { id: 'W1', run: `pnpm exec vitest run ${FOREIGN_TEST}`, test: null, head: 'pass', base: 'fail', proves: 'a test outside the latest touches' }
  const text = parkingFileText({ card: `#${CARD} scoped [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: 'feat/scoped', touches, continue: 'stop', who: 'shift', body: `Add the tests.\n\nwitnesses: ${JSON.stringify([witness])}` })
  appendEvent(db, { ts: at, type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${suffix}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
}

describe('the witness node judges a witness against the latest admission of the card', () => {
  it('a file the first admission touched and the latest does not is outside the card', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const root = mkdtempSync(path.join(tmpdir(), 'owner-reads-witness-'))
    roots.push(root)
    const repo = path.join(root, 'repo')
    execFileSync('git', ['init', '-q', repo])
    const base = committed(repo, { 'README.md': 'base\n' }, 'base')
    const head = committed(repo, { [ADDED_TEST]: 'it passes\n' }, 'head')
    const db = openBus(path.join(root, 'bus.db'))
    dbs.push(db)
    admittedWith(db, ['tests/newdir/**', 'tests/other/**'], '2026-11-26T09:00:00.000Z', 'first')
    admittedWith(db, ['tests/newdir/**'], '2026-11-26T09:30:00.000Z', 'latest')
    appendEvent(db, { ts: '2026-11-26T10:01:00.000Z', type: PR_OBSERVED, actor: 'netwatch', cardId: CARD, pr: PR, head, dedupeKey: `${PR_OBSERVED}:${PR}:${head}`, payload: { card_id: CARD, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: 'a'.repeat(64) }, legacy: false })
    reduce(db, 'pending', busProjections())
    const turns = new SetupTurns()
    const trees = { baseOf: async () => base, withTree: <T>(at: string, run: (tree: string) => Promise<T>) => withWorktreeAsync(repo, at, run, turns) }
    const node = new WitnessNode({ silentMs: SILENT_MS, db, clock: () => new Date(NOW), session: 'witness-1', mode: 'live', env: {}, shell: vitestLike, trees })
    for (let round = 0; round < 2; round += 1) {
      const controller = new AbortController()
      await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    }

    const records = (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(WITNESS_RECORDED) as { payload: string }[]).map(row => JSON.parse(row.payload) as { verdict: string, detail: string })
    expect(records.map(record => record.verdict)).toEqual([UNFIT])
    expect(records[0]!.detail).toContain(`names ${FOREIGN_TEST}`)
    expect(records[0]!.detail).toContain('outside the card\'s touches')
  }, LINT_MS)
})
