import type { GhRunner } from '../core/gh.js'
import type { MergeEvent } from '../core/merge-event.js'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { JOURNAL_HISTORY_ENDS, writtenBeforeHistoryEnds } from '../../src/card/closed.js'
import { readBodyCard } from '../../src/card/grammar.js'
import { BUSY_TIMEOUT_MS } from '../bus/db.js'
import { openDatabase } from '../bus/sqlite.js'
import { HANDOFF_DIR_VARIABLE } from '../core/handoff-dir.js'
import { GHOST_JOURNAL, REPO } from '../shift/places.js'

export const MERGED_FILE = 'merged.txt'

export interface MergedDeps {
  gh: GhRunner
  journal: string
  readJournal: (file: string) => string | null
  append: (file: string, text: string) => void
  now: () => Date
  mergedInBus?: ReadonlySet<number>
}

const NONE_IN_BUS: ReadonlySet<number> = new Set()

export interface BusMerge {
  task: string
  pr: number
  by: string | null
  commit: string | null
  merged: string | null
  event: number
}

const MERGE_FACTS = `
  SELECT id, card_id, pr, json_extract(payload, '$.merged_by') AS by, json_extract(payload, '$.commit') AS commit_sha, json_extract(payload, '$.merged_at') AS merged
  FROM events
  WHERE type = 'pr.closed' AND legacy = 0 AND json_extract(payload, '$.merged') = 1 AND card_id IS NOT NULL AND pr IS NOT NULL AND ts >= ?
  ORDER BY id
`

export function busMerges(busPath: string): BusMerge[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const rows = db.prepare(MERGE_FACTS).all(JOURNAL_HISTORY_ENDS) as unknown as { id: number, card_id: number, pr: number, by: string | null, commit_sha: string | null, merged: string | null }[]
    return rows.map(row => ({ task: String(row.card_id), pr: row.pr, by: row.by, commit: row.commit_sha, merged: row.merged, event: row.id }))
  }
  finally {
    db.close()
  }
}

type SkipReason = 'no-card' | 'closed'

export interface MergeSkip {
  event: 'merge-skip'
  pr: number
  skip: SkipReason
  ts: string
}

export interface MergedResult {
  written: MergeEvent[]
  skipped: (MergeSkip & { detail: string })[]
  open: number[]
  notInBus: number[]
  notes: string[]
}

type Outcome = { kind: 'merge', line: MergeEvent } | { kind: 'skip', skip: SkipReason, detail: string } | { kind: 'open' }

interface PrView {
  state: string
  mergedAt: string
  mergedBy: { login: string }
  mergeCommit: { oid: string }
  body: string | null
}

export function journalLine(entry: MergeEvent | MergeSkip): string {
  return `${JSON.stringify(entry)}\n`
}

export function appendToJournal(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, text)
}

function journalEntries(text: string | null): Record<string, unknown>[] {
  return (text ?? '').split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown> | null
      return entry === null || typeof entry !== 'object' ? [] : [entry]
    }
    catch {
      return []
    }
  })
}

export function hasMergeLine(text: string | null, pr: number): boolean {
  return journalEntries(text).some(entry => entry.event === 'merge' && entry.pr === pr)
}

function pullRequestsToLookUp(text: string | null, mergedInBus: ReadonlySet<number>): number[] {
  const entries = journalEntries(text)
  const recorded = new Set(entries.filter(entry => entry.event === 'merge' || entry.event === 'merge-skip').map(entry => entry.pr))
  const closing = entries.filter(entry => entry.event === 'path' && typeof entry.verification === 'string').map(entry => entry.pr)
  return [...new Set(closing)].filter((pr): pr is number => typeof pr === 'number' && !recorded.has(pr) && !mergedInBus.has(pr))
}

function lookUp(deps: MergedDeps, pr: number): Outcome {
  const view = JSON.parse(deps.gh(['pr', 'view', String(pr), '-R', REPO, '--json', 'state,mergedAt,mergedBy,mergeCommit,body'])) as PrView
  if (view.state === 'CLOSED')
    return { kind: 'skip', skip: 'closed', detail: 'closed without merge' }
  if (view.state !== 'MERGED')
    return { kind: 'open' }
  const card = readBodyCard(view.body ?? '')
  if (card.kind === 'refused')
    return { kind: 'skip', skip: 'no-card', detail: `without a card: ${card.reason}` }
  return { kind: 'merge', line: { event: 'merge', task: String(card.card.id), pr, by: view.mergedBy.login, commit: view.mergeCommit.oid, merged: view.mergedAt, ts: deps.now().toISOString() } }
}

function emptyResult(): MergedResult {
  return { written: [], skipped: [], open: [], notInBus: [], notes: [] }
}

export function recordMerges(deps: MergedDeps): MergedResult {
  const result = emptyResult()
  for (const pr of pullRequestsToLookUp(deps.readJournal(deps.journal), deps.mergedInBus ?? NONE_IN_BUS)) {
    try {
      const outcome = lookUp(deps, pr)
      if (outcome.kind === 'open') {
        result.open.push(pr)
      }
      else if (outcome.kind === 'skip') {
        const skip: MergeSkip = { event: 'merge-skip', pr, skip: outcome.skip, ts: deps.now().toISOString() }
        deps.append(deps.journal, journalLine(skip))
        result.skipped.push({ ...skip, detail: outcome.detail })
      }
      else if (!writtenBeforeHistoryEnds(outcome.line)) {
        result.notInBus.push(pr)
      }
      else {
        deps.append(deps.journal, journalLine(outcome.line))
        result.written.push(outcome.line)
      }
    }
    catch (error) {
      result.notes.push(`PR #${pr} not read: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
    }
  }
  return result
}

function lookedUp(result: MergedResult): number {
  return result.written.length + result.skipped.length + result.open.length + result.notInBus.length + result.notes.length
}

export function mergedSummary(result: MergedResult): string | null {
  if (lookedUp(result) === 0)
    return null
  const count = (skip: SkipReason): number => result.skipped.filter(line => line.skip === skip).length
  const parts = [
    `${result.written.length} new`,
    [count('no-card'), 'without a card skipped'],
    [count('closed'), 'closed without merge skipped'],
    [result.open.length, 'open'],
    [result.notInBus.length, 'merged with no merged pr.closed in the bus yet, nothing written'],
    [result.notes.length, 'not read'],
  ].flatMap(part => typeof part === 'string' ? [part] : part[0] === 0 ? [] : [`${part[0]} ${part[0] === 1 ? 'PR' : 'PRs'} ${part[1]}`])
  return `merged: ${parts.join(' · ')}`
}

export function mergedDetails(result: MergedResult): string[] {
  return [
    ...result.written.map(line => `#${line.task} merged in PR #${line.pr}`),
    ...result.skipped.map(line => `PR #${line.pr} ${line.detail}`),
    ...result.open.map(pr => `PR #${pr} open`),
    ...result.notInBus.map(pr => `PR #${pr} merged; no merged pr.closed in the bus yet, and from ${JOURNAL_HISTORY_ENDS} no merge line is written`),
    ...result.notes,
  ]
}

export function defaultGhostJournal(): string {
  return path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL)
}
