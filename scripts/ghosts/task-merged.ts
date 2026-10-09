import type { GhRunner } from '../board/gh.js'
import type { MergeEvent } from '../board/handoff.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readBodyCard } from '../../src/card/grammar.js'
import { execGh } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { GHOST_JOURNAL, REPO } from '../shift/places.js'

export const PREFIX = '[task:merged] '
export const MERGED_FILE = 'merged.txt'
export const DETAILS_FLAG = '--details'
export const RECHECK_FLAG = '--recheck'

export interface MergedDeps {
  gh: GhRunner
  journal: string
  readJournal: (file: string) => string | null
  append: (file: string, text: string) => void
  now: () => Date
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

function pullRequestsToLookUp(text: string | null): number[] {
  const entries = journalEntries(text)
  const recorded = new Set(entries.filter(entry => entry.event === 'merge' || entry.event === 'merge-skip').map(entry => entry.pr))
  const closing = entries.filter(entry => entry.event === 'path' && typeof entry.verification === 'string').map(entry => entry.pr)
  return [...new Set(closing)].filter((pr): pr is number => typeof pr === 'number' && !recorded.has(pr))
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

export function recordMerges(deps: MergedDeps): MergedResult {
  const result: MergedResult = { written: [], skipped: [], open: [], notes: [] }
  for (const pr of pullRequestsToLookUp(deps.readJournal(deps.journal))) {
    try {
      const outcome = lookUp(deps, pr)
      if (outcome.kind === 'open') {
        result.open.push(pr)
      }
      else if (outcome.kind === 'skip') {
        const skip: MergeSkip = { event: 'merge-skip', pr, skip: outcome.skip, ts: deps.now().toISOString() }
        deps.append(deps.journal, `${JSON.stringify(skip)}\n`)
        result.skipped.push({ ...skip, detail: outcome.detail })
      }
      else {
        deps.append(deps.journal, `${JSON.stringify(outcome.line)}\n`)
        result.written.push(outcome.line)
      }
    }
    catch (error) {
      result.notes.push(`PR #${pr} not read: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
    }
  }
  return result
}

export function recheckMerge(deps: MergedDeps, pr: number): MergedResult {
  const result: MergedResult = { written: [], skipped: [], open: [], notes: [] }
  const entries = journalEntries(deps.readJournal(deps.journal)).filter(entry => entry.pr === pr)
  if (entries.some(entry => entry.event === 'merge')) {
    result.notes.push(`PR #${pr} already has a merge line; nothing written`)
    return result
  }
  if (!entries.some(entry => entry.event === 'merge-skip' && entry.skip === 'no-card')) {
    result.notes.push(`PR #${pr} has no merge-skip line with skip no-card in ${deps.journal}; nothing written`)
    return result
  }
  try {
    const outcome = lookUp(deps, pr)
    if (outcome.kind === 'merge') {
      deps.append(deps.journal, `${JSON.stringify(outcome.line)}\n`)
      result.written.push(outcome.line)
    }
    else if (outcome.kind === 'skip') {
      result.notes.push(`PR #${pr} still ${outcome.detail}; nothing written`)
    }
    else {
      result.notes.push(`PR #${pr} is open; nothing written`)
    }
  }
  catch (error) {
    result.notes.push(`PR #${pr} not read: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
  }
  return result
}

export function recheckArgument(argv: readonly string[]): number | null | 'invalid' {
  const at = argv.indexOf(RECHECK_FLAG)
  if (at === -1)
    return argv.some(arg => arg.startsWith(`${RECHECK_FLAG}=`)) ? 'invalid' : null
  const value = argv[at + 1] ?? ''
  return /^[1-9]\d*$/.test(value) ? Number(value) : 'invalid'
}

export function recheckSummary(result: MergedResult): string[] {
  return result.written.length > 0 ? [`merged: ${result.written.length} new`] : result.notes
}

function lookedUp(result: MergedResult): number {
  return result.written.length + result.skipped.length + result.open.length + result.notes.length
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
    [result.notes.length, 'not read'],
  ].flatMap(part => typeof part === 'string' ? [part] : part[0] === 0 ? [] : [`${part[0]} ${part[0] === 1 ? 'PR' : 'PRs'} ${part[1]}`])
  return `merged: ${parts.join(' · ')}`
}

export function mergedDetails(result: MergedResult): string[] {
  return [
    ...result.written.map(line => `#${line.task} merged in PR #${line.pr}`),
    ...result.skipped.map(line => `PR #${line.pr} ${line.detail}`),
    ...result.open.map(pr => `PR #${pr} open`),
    ...result.notes,
  ]
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const journal = path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL)
  if (!existsSync(journal)) {
    console.error(`${PREFIX}${journal} cannot be read`)
    process.exitCode = 1
  }
  else {
    const deps: MergedDeps = {
      gh: execGh,
      journal,
      readJournal: file => readFileSync(file, 'utf8'),
      append: (file, text) => {
        mkdirSync(path.dirname(file), { recursive: true })
        appendFileSync(file, text)
      },
      now: () => new Date(),
    }
    const recheck = recheckArgument(process.argv)
    if (recheck === 'invalid') {
      console.error(`${PREFIX}${RECHECK_FLAG} needs a pull request number; nothing written`)
      process.exit(1)
    }
    const result = recheck === null ? recordMerges(deps) : recheckMerge(deps, recheck)
    if (recheck !== null && result.written.length === 0)
      process.exitCode = 1
    const summary = recheck === null ? [mergedSummary(result) ?? 'merged: nothing to look up'] : recheckSummary(result)
    for (const line of summary)
      console.log(`${PREFIX}${line}`)
    if (process.argv.includes(DETAILS_FLAG)) {
      for (const line of mergedDetails(result))
        console.log(`${PREFIX}${line}`)
    }
  }
}
