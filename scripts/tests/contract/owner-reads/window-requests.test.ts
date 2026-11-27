import type { Linter } from 'eslint'
import type { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { bodyLineOf, heldCardOf, openWaitsOfCard, ownerWaitOf, unclosedDecisionWaitWithText } from '../../../core/card-readings.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { latest, latestTaskOfCardIn, unanswered } from '../../../core/events-query.js'
import { OWNER_WAIT_CLOSED, OWNER_WAIT_OPENED, PR_OBSERVED, REQUEST_DONE, WINDOW_REQUEST } from '../../../core/events.js'
import { plans } from '../../../core/plan-readings.js'
import { lastEventId } from '../../../core/watermark.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, 'eslint.config.mjs')).href
const { FOREIGN_TABLE_SQL_POLICY } = await import(CONFIG_URL) as { FOREIGN_TABLE_SQL_POLICY: Linter.Config[] }
const MODULE_FILES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const EXCEPTED = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts/quality/foreign-table-sql-excepted.json'), 'utf8')) as string[]

const RULE = 'tables/no-foreign-table-sql'
const NAMED_TABLE = /^SQL names (\w+),/
const LINT_MS = 120_000

const OWNER_OF: Record<string, string> = {
  'scripts/window/requests/context.ts': 'window',
  'scripts/window/requests/amend.ts': 'window',
  'scripts/window/requests/requeue.ts': 'window',
  'scripts/window/requests/takeover.ts': 'window',
  'scripts/window/requests/plan.ts': 'window',
  'scripts/window/requests/owner-answer.ts': 'window',
  'scripts/window/requests/drop.ts': 'window',
  'scripts/window/requests/owner-wait-close.ts': 'window',
  'scripts/window/requests/request.ts': 'window',
  'scripts/window/requests/tree-cut.ts': 'window',
  'scripts/window/window-requests.ts': 'window',
  'scripts/window/window-request-tools.ts': 'window',
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

describe('the window requests read the tables of other owners only through their contracts', () => {
  it('each file belongs to its module and is no longer on the excepted list', () => {
    for (const [file, owner] of Object.entries(OWNER_OF))
      expect(MODULE_FILES[owner]).toContain(file)
    expect(EXCEPTED.filter(file => FILES.includes(file))).toEqual([])
  })

  it('the rule without exceptions finds no table of another owner in them', async () => {
    expect(await foreignTablesOf(FILES)).toEqual(Object.fromEntries(FILES.map(file => [file, []])))
  }, LINT_MS)
})

const TS = '2026-11-27T08:00:00.000Z'
const CARD = 7
const OTHER_CARD = 8
const PR = 41
const HEAD = 'a'.repeat(40)
const opened: DatabaseSync[] = []

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  opened.push(db)
  return db
}

interface Seed {
  type: string
  key: string
  card?: number | null
  pr?: number | null
  head?: string | null
  payload?: Record<string, unknown>
  legacy?: boolean
}

function append(db: DatabaseSync, seed: Seed): number {
  appendEvent(db, { ts: TS, type: seed.type, actor: 'policy', cardId: seed.card ?? null, pr: seed.pr ?? null, head: seed.head ?? null, dedupeKey: seed.key, payload: seed.payload ?? {}, legacy: seed.legacy ?? false })
  return lastEventId(db)
}

describe('the readings the window requests take from bus, card-record and plan', () => {
  it('bus answers the live window requests no answer names yet, oldest first', () => {
    const db = bus()
    const first = append(db, { type: WINDOW_REQUEST, key: 'r1', payload: { kind: 'mode' } })
    const second = append(db, { type: WINDOW_REQUEST, key: 'r2', payload: { kind: 'plan' } })
    append(db, { type: WINDOW_REQUEST, key: 'r3', payload: { kind: 'hold' }, legacy: true })
    append(db, { type: REQUEST_DONE, key: `${WINDOW_REQUEST}:${first}:answered` })
    const pending = unanswered(db, WINDOW_REQUEST, { prefix: `${WINDOW_REQUEST}:`, suffix: ':answered' })
    expect(pending.map(row => row.id)).toEqual([second])
    expect(pending[0]!.data).toEqual({ kind: 'plan' })
  })

  it('bus answers the newest event that carries a head, past a newer one that carries none', () => {
    const db = bus()
    const withHead = append(db, { type: PR_OBSERVED, pr: PR, head: HEAD, key: 'o1' })
    append(db, { type: PR_OBSERVED, pr: PR, key: 'o2' })
    expect(latest(db, { types: [PR_OBSERVED], pr: PR, withHead: true })?.id).toBe(withHead)
    expect(latest(db, { types: [PR_OBSERVED], pr: PR })?.id).toBe(withHead + 1)
  })

  it('bus answers the newest task of a card in the named states', () => {
    const db = bus()
    const event = append(db, { type: WINDOW_REQUEST, key: 't0' })
    db.prepare(`INSERT INTO tasks (task_key, queue, card_id, state, event_id) VALUES ('answer:old', 'answer', ?, 'queued', ?), ('launch:new', 'launch', ?, 'leased', ?), ('review:done', 'review', ?, 'done', ?), ('answer:other', 'answer', ?, 'queued', ?)`).run(CARD, event, CARD, event, CARD, event, OTHER_CARD, event)
    const live = db.prepare(latestTaskOfCardIn(['queued', 'leased']))
    expect({ ...live.get(CARD) }).toEqual({ task_key: 'launch:new', queue: 'launch', state: 'leased' })
    expect(db.prepare(latestTaskOfCardIn(['done'])).get(OTHER_CARD)).toBeUndefined()
  })

  it('card-record answers a wait by its id and the open waits of a card in the order they opened', () => {
    const db = bus()
    const ids = [1, 2, 3].map(at => append(db, { type: WINDOW_REQUEST, key: `w${at}` }))
    db.prepare(`INSERT INTO owner_waits (id, need, text, card_id, pr, state, opened_at, event_id) VALUES
      ('Q2', 'decision', 't', ?, NULL, 'open', ?, ?),
      ('Q1', 'merge', 't', ?, ?, 'open', ?, ?),
      ('Q3', 'decision', 't', ?, NULL, 'closed', ?, ?)`).run(CARD, TS, ids[1]!, CARD, PR, TS, ids[0]!, CARD, TS, ids[2]!)
    expect(ownerWaitOf(db, 'Q3')).toEqual({ id: 'Q3', state: 'closed', need: 'decision', card_id: CARD, pr: null })
    expect(ownerWaitOf(db, 'Q9')).toBeNull()
    expect(openWaitsOfCard(db, CARD).map(wait => wait.id)).toEqual(['Q1', 'Q2'])
    expect(openWaitsOfCard(db, CARD)[0]).toEqual({ id: 'Q1', state: 'open', need: 'merge', card_id: CARD, pr: PR })
    expect(openWaitsOfCard(db, OTHER_CARD)).toEqual([])
  })

  it('card-record answers the open decision wait with the same text, and none that a row or an event closed', () => {
    const db = bus()
    const question = 'which "one"?'
    append(db, { type: OWNER_WAIT_OPENED, key: 'q1', payload: { id: 'Q1', need: 'decision', text: question } })
    append(db, { type: OWNER_WAIT_OPENED, key: 'q2', payload: { id: 'Q2', need: 'merge', text: question } })
    expect(unclosedDecisionWaitWithText(db, question)).toBe('Q1')
    expect(unclosedDecisionWaitWithText(db, 'another question')).toBeNull()
    append(db, { type: OWNER_WAIT_CLOSED, key: 'c1', payload: { id: 'Q1' } })
    expect(unclosedDecisionWaitWithText(db, question)).toBeNull()
    const reopened = append(db, { type: OWNER_WAIT_OPENED, key: 'q3', payload: { id: 'Q3', need: 'decision', text: question } })
    db.prepare(`INSERT INTO owner_waits (id, need, text, state, opened_at, event_id) VALUES ('Q3', 'decision', ?, 'closed', ?, ?)`).run(question, TS, reopened)
    expect(unclosedDecisionWaitWithText(db, question)).toBeNull()
  })

  it('card-record answers the line, branch and lane of a body, and the state of a card it holds', () => {
    const db = bus()
    const event = append(db, { type: WINDOW_REQUEST, key: 'b1' })
    db.prepare(`INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, card_line, branch, lane) VALUES (?, ?, 't', 's', '#7 x', 'feat/x', 'lane-1')`).run(CARD, event)
    db.prepare(`INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, 'started', NULL, ?), (?, NULL, NULL, ?)`).run(CARD, event, OTHER_CARD, event)
    expect(bodyLineOf(db, CARD)).toEqual({ card_line: '#7 x', branch: 'feat/x', lane: 'lane-1' })
    expect(bodyLineOf(db, OTHER_CARD)).toBeNull()
    expect(heldCardOf(db, CARD)).toEqual({ state: 'started' })
    expect(heldCardOf(db, OTHER_CARD)).toEqual({ state: null })
    expect(heldCardOf(db, 99)).toBeNull()
  })

  it('plan answers the cards the items of a plan link, once each and in order', () => {
    const db = bus()
    const event = append(db, { type: WINDOW_REQUEST, key: 'p1' })
    db.prepare(`INSERT INTO plan_items (plan_id, item_id, title, cards, event_id) VALUES ('rel', 'b', 't', '[9, 3]', ?), ('rel', 'a', 't', '[3, 5]', ?), ('other', 'a', 't', '[1]', ?)`).run(event, event, event)
    expect(plans.linkedCards(db, 'rel')).toEqual([3, 5, 9])
    expect(plans.linkedCards(db, 'none')).toEqual([])
  })
})
