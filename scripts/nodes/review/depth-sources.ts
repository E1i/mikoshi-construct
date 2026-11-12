import type { DatabaseSync } from 'node:sqlite'
import type { BusCatalog } from '../../ci/card-runs.js'
import type { CardBodyReader } from '../../intake/parking-reads.js'
import type { CardScope, DepthSources, ReviewPlanner } from './review-depth.js'
import { existsSync } from 'node:fs'
import { layerMasksOf, runsOf } from '../../../src/card/covering-tests.js'
import { parseParkingFile } from '../../../src/card/parking.js'
import { busCheckCatalog, cardReadingOf } from '../../ci/card-runs.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../../core/db.js'
import { SCOPE_WIDENED } from '../../core/events.js'
import { openDatabase } from '../../core/sqlite.js'
import { cardContract } from '../../intake/card-contract.js'
import { predict } from '../../policy/morse/predict.js'
import { createdPaths } from '../../policy/touch-scope.js'
import { BusRead } from '../../ports/bus-read.js'
import { processGit } from '../../ports/git.js'
import { planReview } from './review-depth.js'

const MAIN = 'origin/main'

const CONCURRENT_REF_UPDATE = 'cannot lock ref'

export type GitRun = (repo: string, args: string[]) => string

function git(repo: string, args: string[]): string {
  return processGit.read(repo, args)
}

function lostRefRace(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  const text = `${error instanceof Error ? error.message : ''}${typeof stderr === 'string' ? stderr : ''}`
  return text.includes(CONCURRENT_REF_UPDATE)
}

function fetchPr(run: GitRun, repo: string, pr: number): void {
  const args = ['fetch', '--quiet', 'origin', 'main', `pull/${pr}/head`]
  try {
    run(repo, args)
  }
  catch (error) {
    if (!lostRefRace(error))
      throw error
    run(repo, args)
  }
}

export type WidenedReader = (cardId: number) => string[]

export const NOTHING_WIDENED: WidenedReader = () => []

function pathsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((file): file is string => typeof file === 'string') : []
}

export function widenedOnTheLatestAdmission(db: DatabaseSync, cardId: number): string[] {
  const card = cardContract(db, cardId)
  if (card === null)
    return []
  return new BusRead(db).where({ card: cardId }).slice(SCOPE_WIDENED, ['paths', 'admission']).filter(event => event.fields.admission === card.admissionEventId).flatMap(event => pathsOf(event.fields.paths))
}

export function busWidenedPaths(busPath: string): WidenedReader {
  return (cardId) => {
    if (!existsSync(busPath))
      return []
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      return widenedOnTheLatestAdmission(db, cardId)
    }
    finally {
      db.close()
    }
  }
}

function cardScope(bodyOf: CardBodyReader, widenedOf: WidenedReader, cardId: number, catalog: () => BusCatalog): CardScope | null {
  const text = bodyOf(cardId)
  if (text === null)
    return null
  const parsed = parseParkingFile(`${cardId}.md`, text)
  if (parsed.kind !== 'parked')
    return null
  const { body } = parsed.parked.task
  const touches = [...new Set([...parsed.parked.task.touches, ...widenedOf(cardId)])]
  return { touches, creates: createdPaths(parsed.parked.creates), ...cardReadingOf(touches, runsOf(body), layerMasksOf(body), catalog()) }
}

export function gitDepthSources(repo: string, journal: string, bodyOf: CardBodyReader, run: GitRun = git, catalog: () => BusCatalog = busCheckCatalog, widenedOf: WidenedReader = NOTHING_WIDENED): DepthSources {
  return {
    base: head => run(repo, ['merge-base', MAIN, head]).trim(),
    changed: (from, to) => run(repo, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(file => file !== ''),
    predict: (task, base, head) => {
      const { line, files } = predict({ task, base, head, journal, repo })
      return { prediction: line, files: files.map(file => file.path), added: files.filter(file => file.status === 'A').map(file => file.path) }
    },
    scope: cardId => cardScope(bodyOf, widenedOf, cardId, catalog),
  }
}

export function gitReviewPlanner(repo: string, journal: string, bodyOf: CardBodyReader, run: GitRun = git, widenedOf: WidenedReader = busWidenedPaths(defaultBusPath())): ReviewPlanner {
  const sources = gitDepthSources(repo, journal, bodyOf, run, busCheckCatalog, widenedOf)
  return (lease, earlier) => {
    if (lease.pr !== null)
      fetchPr(run, repo, lease.pr)
    return planReview(lease, earlier, sources)
  }
}
