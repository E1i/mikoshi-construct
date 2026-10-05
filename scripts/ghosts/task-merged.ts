import type { GhRunner } from '../board/gh.js'
import type { MergeEvent } from '../board/handoff.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseCard } from '../../src/card/grammar.js'
import { execGh } from '../board/gh.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { GHOST_JOURNAL, REPO } from '../shift/places.js'

export const PREFIX = '[task:merged] '

export interface MergedDeps {
  gh: GhRunner
  journal: string
  readJournal: (file: string) => string | null
  append: (file: string, text: string) => void
  now: () => Date
}

export interface MergedResult {
  written: MergeEvent[]
  notes: string[]
}

interface PrView {
  state: string
  mergedAt: string
  mergedBy: { login: string }
  mergeCommit: { oid: string }
  body: string
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
  const recorded = new Set(entries.filter(entry => entry.event === 'merge').map(entry => entry.pr))
  const closing = entries.filter(entry => entry.event === 'path' && typeof entry.verification === 'string').map(entry => entry.pr)
  return [...new Set(closing)].filter((pr): pr is number => typeof pr === 'number' && !recorded.has(pr))
}

function lookUp(deps: MergedDeps, pr: number): MergeEvent | null {
  const view = JSON.parse(deps.gh(['pr', 'view', String(pr), '-R', REPO, '--json', 'state,mergedAt,mergedBy,mergeCommit,body'])) as PrView
  if (view.state !== 'MERGED')
    return null
  const card = parseCard(view.body.split('\n')[0]!)
  if (card.kind === 'refused')
    throw new Error(`the body does not start with a card: ${card.reason}`)
  return { event: 'merge', task: String(card.card.id), pr, by: view.mergedBy.login, commit: view.mergeCommit.oid, merged: view.mergedAt, ts: deps.now().toISOString() }
}

export function recordMerges(deps: MergedDeps): MergedResult {
  const result: MergedResult = { written: [], notes: [] }
  for (const pr of pullRequestsToLookUp(deps.readJournal(deps.journal))) {
    try {
      const line = lookUp(deps, pr)
      if (line === null)
        continue
      deps.append(deps.journal, `${JSON.stringify(line)}\n`)
      result.written.push(line)
    }
    catch (error) {
      result.notes.push(`PR #${pr}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
    }
  }
  return result
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const journal = path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), GHOST_JOURNAL)
  if (!existsSync(journal)) {
    console.error(`${PREFIX}${journal} cannot be read`)
    process.exitCode = 1
  }
  else {
    const { written, notes } = recordMerges({
      gh: execGh,
      journal,
      readJournal: file => readFileSync(file, 'utf8'),
      append: (file, text) => {
        mkdirSync(path.dirname(file), { recursive: true })
        appendFileSync(file, text)
      },
      now: () => new Date(),
    })
    for (const line of written)
      console.log(`${PREFIX}#${line.task} merged in PR #${line.pr}`)
    for (const note of notes)
      console.error(`${PREFIX}${note}`)
  }
}
