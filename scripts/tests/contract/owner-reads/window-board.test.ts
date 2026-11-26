import type { Linter } from 'eslint'
import type { DatabaseSync } from 'node:sqlite'
import type { Board } from '../../../window/board.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { observeChain } from '../../../core/chain.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { lastEventId } from '../../../core/events-query.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, CUTOVER, OWNER_WAIT_OPENED, PR_CLOSED, PR_OBSERVED, PR_OPENED, REVIEW_RECORDED, TASK_COMPLETED } from '../../../core/events.js'
import { busProjections, pullRequests } from '../../../supervisor/composition.js'
import { readBoard } from '../../../window/board.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY } = await import(CONFIG_URL) as { FOREIGN_TABLE_SQL_POLICY: Linter.Config[] }
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const EXCEPTED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/foreign-table-sql-excepted.json'), 'utf8')) as string[]

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000

const OWNER_OF: Record<string, string> = {
  'scripts/window/board.ts': 'window',
}
const FILES = Object.keys(OWNER_OF)

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
    result.messages.filter(message => message.ruleId === RULE).map(message => `${NAMED_TABLE.exec(message.message)?.[1] ?? message.message}:${message.line}`),
  ]))
}

describe('the window board reads the tables of other owners only through their contracts', () => {
  it('the board belongs to the window and is no longer on the excepted list', () => {
    for (const [file, owner] of Object.entries(OWNER_OF))
      expect(MODULE_FILES[owner]).toContain(file)
    expect(EXCEPTED.filter(file => FILES.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in it', async () => {
    expect(await foreignTablesOf(FILES)).toEqual(Object.fromEntries(FILES.map(file => [file, []])))
  }, LINT_MS)
})

const NOW = new Date('2026-11-27T12:00:00.000Z')
const HOUR_BEFORE = Date.parse('2026-11-27T11:00:00.000Z')
const LANE = 'lane-1'

interface Appended {
  ts: string
  card?: number | null
  pr?: number | null
  head?: string | null
  payload?: Record<string, unknown>
  legacy?: boolean
}

const opened: { root: string, db: DatabaseSync }[] = []

afterEach(() => {
  for (const bench of opened.splice(0)) {
    bench.db.close()
    rmSync(bench.root, { recursive: true, force: true })
  }
})

function sha(char: string): string {
  return char.repeat(40)
}

function at(minute: number): string {
  return new Date(HOUR_BEFORE + minute * 60_000).toISOString()
}

function freshBus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'window-board-tail-'))
  const db = openBus(path.join(root, 'bus.db'))
  opened.push({ root, db })
  return db
}

function append(db: DatabaseSync, type: string, event: Appended): number {
  const legacy = event.legacy ?? false
  appendEvent(db, { ts: event.ts, type, actor: legacy ? null : 'policy', cardId: event.card ?? null, pr: event.pr ?? null, head: event.head ?? null, dedupeKey: `${type}:${lastEventId(db) + 1}`, payload: event.payload ?? {}, legacy })
  return lastEventId(db)
}

function standingCard(db: DatabaseSync, card: number, state: string | null = null): number {
  const admitted = append(db, CARD_ADMITTED, { ts: at(0), card })
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, lane, who, priority, depends) VALUES (?, ?, ?, ?, ?, \'shift\', NULL, \'[]\')').run(card, admitted, `do ${card}`, sha('a'), LANE)
  db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)').run(card, state, admitted)
  return admitted
}

function cardState(db: DatabaseSync, card: number, state: string): void {
  db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)').run(card, state, append(db, CARD_ADMITTED, { ts: at(0), card }))
}

interface OpenPr {
  pr: number
  card: number
  head: string
  ci?: string | null
  verdict?: string | null
}

function openPr(db: DatabaseSync, row: OpenPr): void {
  const event = append(db, PR_OPENED, { ts: at(1), card: row.card, pr: row.pr, head: row.head })
  db.prepare('INSERT INTO prs (pr, card_id, base, head, state, ci, verdict_on_head, event_id) VALUES (?, ?, \'main\', ?, \'open\', ?, ?, ?)').run(row.pr, row.card, row.head, row.ci ?? 'green', row.verdict ?? null, event)
}

function read(db: DatabaseSync): Board {
  return readBoard({ db, now: NOW, watched: [], leaseOrders: {}, projections: busProjections(), pulls: pullRequests(db) })
}

function executionOf(db: DatabaseSync, card: number): Board['execution'][number] | undefined {
  return read(db).execution.find(row => row.card === card)
}

function linkOf(db: DatabaseSync, name: string): Board['contract'][number] | undefined {
  return read(db).contract.find(link => link.link === name)
}

describe('the window board reads each surviving mutation of card #2139 as a behaviour', () => {
  it('a review recorded on an earlier head than the open pull request reads as on an earlier head, and one on its head does not', () => {
    const db = freshBus()
    openPr(db, { pr: 500, card: 50, head: sha('b') })
    append(db, REVIEW_RECORDED, { ts: at(2), card: 50, pr: 500, head: sha('a'), payload: { verdict: 'pass', depth: 'full' } })
    expect(executionOf(db, 50)?.review).toBe('pass · full (an earlier head)')
    append(db, REVIEW_RECORDED, { ts: at(3), card: 50, pr: 500, head: sha('b'), payload: { verdict: 'changes', depth: 'full' } })
    expect(executionOf(db, 50)?.review).toBe('changes · full')
  })

  it('the since of an open pull request counts only observations whose verdict on head matches the pull request', () => {
    const db = freshBus()
    openPr(db, { pr: 510, card: 51, head: sha('b'), ci: 'green', verdict: 'pass' })
    append(db, PR_OBSERVED, { ts: at(2), card: 51, pr: 510, head: sha('b'), payload: { ci: 'green', verdict_on_head: null } })
    append(db, PR_OBSERVED, { ts: at(4), card: 51, pr: 510, head: sha('b'), payload: { ci: 'green', verdict_on_head: 'pass' } })
    expect(executionOf(db, 51)).toMatchObject({ stage: 'awaiting merge', since: at(4) })
  })

  it('a card with its own open pull request is never the card ahead of itself in its lane', () => {
    const db = freshBus()
    standingCard(db, 60, 'queued')
    openPr(db, { pr: 600, card: 60, head: sha('b') })
    const board = read(db)
    expect(board.waiting).toEqual([])
    expect(board.ready.map(card => `${card.card} ${card.wait.kind}`)).toEqual(['60 launch'])
  })

  it('a card with two open owner waits stands on the first of them', () => {
    const db = freshBus()
    standingCard(db, 70)
    const waits = [{ id: 'Q1', need: 'decision', minute: 2 }, { id: 'Q2', need: 'review', minute: 3 }]
    for (const wait of waits) {
      const event = append(db, OWNER_WAIT_OPENED, { ts: at(wait.minute), card: 70, payload: { id: wait.id } })
      db.prepare('INSERT INTO owner_waits (id, need, text, card_id, state, opened_at, event_id) VALUES (?, ?, ?, 70, \'open\', ?, ?)').run(wait.id, wait.need, `wait ${wait.id}`, at(wait.minute), event)
    }
    expect(read(db).blocked.map(card => `${card.card} ${card.wait.kind} ${card.wait.detail} ${card.wait.since}`)).toEqual([`70 owner Q1 decision ${at(2)}`])
  })

  it('with two cards in work the last progress is the newer of their stamps', () => {
    const db = freshBus()
    append(db, CARD_STARTED, { ts: at(1), card: 80 })
    append(db, CARD_STARTED, { ts: at(5), card: 81 })
    expect(read(db).progress.last).toBe(at(5))
  })

  it('legacy events before the cutover do not count against one writer, and one after it does', () => {
    const db = freshBus()
    append(db, 'legacy.path', { ts: at(1), legacy: true })
    append(db, CUTOVER, { ts: at(2) })
    expect(linkOf(db, 'one writer')).toEqual({ link: 'one writer', green: true, fact: '0 legacy events after the cutover' })
    append(db, 'legacy.path', { ts: at(3), legacy: true })
    expect(linkOf(db, 'one writer')).toEqual({ link: 'one writer', green: false, fact: '1 legacy events after the cutover' })
  })

  it('a waiting chain whose waitingOn changed reads the last waiting observation', () => {
    const db = freshBus()
    for (const [minute, waitingOn] of [[1, [849]], [2, [850]]] as const)
      observeChain(db, at(minute), 'worker:chain:1', { dir: '/trees/852', parking: '/parking/lane-1', cardId: 852, sha: sha('c'), pid: 98, leader: null, boundary: true, state: 'waiting', waitingOn: [...waitingOn] })
    expect(executionOf(db, 852)?.stage).toBe('waiting on #850')
  })

  it('a chain observed twice writes since its first observation', () => {
    const db = freshBus()
    for (const minute of [1, 3])
      observeChain(db, at(minute), 'worker:chain:1', { dir: '/trees/853', parking: '/parking/lane-1', cardId: 853, sha: sha('c'), pid: 97, leader: null, boundary: false, state: 'running' })
    expect(executionOf(db, 853)).toMatchObject({ stage: 'writing', since: at(1) })
  })

  it('the stop marker on an open pull request of a stopped card carries the stop detail', () => {
    const db = freshBus()
    cardState(db, 90, 'stopped')
    openPr(db, { pr: 900, card: 90, head: sha('b') })
    append(db, CARD_STOPPED, { ts: at(2), card: 90, payload: { reason: 'question.agent', detail: 'which lane' } })
    expect(executionOf(db, 90)?.markers).toEqual(['stopped question.agent: which lane'])
  })

  it('an open pull request whose card was stopped and is no longer in the stopped state carries no stop marker', () => {
    const db = freshBus()
    cardState(db, 91, 'running')
    openPr(db, { pr: 910, card: 91, head: sha('b') })
    append(db, CARD_STOPPED, { ts: at(2), card: 91, payload: { reason: 'question.agent', detail: 'which lane' } })
    expect(executionOf(db, 91)?.markers).toEqual([])
  })

  it('a completed task on a queue other than answer does not count on the answer link', () => {
    const db = freshBus()
    append(db, TASK_COMPLETED, { ts: at(1), card: 92, payload: { queue: 'review' } })
    expect(linkOf(db, 'answer')).toEqual({ link: 'answer', green: false, fact: '0 answer tasks completed' })
    append(db, TASK_COMPLETED, { ts: at(2), card: 92, payload: { queue: 'answer' } })
    expect(linkOf(db, 'answer')).toEqual({ link: 'answer', green: true, fact: '1 answer tasks completed' })
  })

  it('a pull request closed merged without a card takes its card from an earlier event of the same pull request', () => {
    const db = freshBus()
    append(db, PR_OBSERVED, { ts: at(1), card: 77, pr: 777, head: sha('b'), payload: { ci: 'green' } })
    append(db, PR_CLOSED, { ts: at(2), pr: 777, payload: { merged: true, commit: sha('d') } })
    expect(read(db).execution.find(row => row.pr === 777)).toMatchObject({ card: 77, stage: `merged ${sha('d')}`, since: at(2) })
  })

  it('a legacy event newer than a card\'s last live event does not move where the card stands from', () => {
    const db = freshBus()
    const admitted = standingCard(db, 95)
    append(db, 'legacy.path', { ts: at(9), card: 95, legacy: true })
    expect(read(db).ready.map(card => [card.card, card.wait.event, card.wait.since])).toEqual([['95', admitted, at(0)]])
  })
})
