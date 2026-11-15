import type { DatabaseSync } from 'node:sqlite'
import type { BusCatalog } from '../../ci/card-runs.js'
import type { Lease } from '../../core/lease.js'
import type { CardBodyReader } from '../../intake/parking-reads.js'
import type { CardScope, DepthSources, ReviewPlanner } from './review-depth.js'
import type { ProvenWitness } from './reviewer.js'
import { existsSync } from 'node:fs'
import { layerMasksOf, runsOf } from '../../../src/card/covering-tests.js'
import { parseParkingFile } from '../../../src/card/parking.js'
import { busCheckCatalog, cardReadingOf } from '../../ci/card-runs.js'
import { CAPABILITIES, declaredCapabilities } from '../../ci/sandbox-failing.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../../core/db.js'
import { CARD_ADMITTED, SCOPE_WIDENED, WITNESS_RECORDED } from '../../core/events.js'
import { reviewInputOfKey } from '../../core/identifiers.js'
import { openDatabase } from '../../core/sqlite.js'
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

function latestAdmissionWithBody(read: BusRead): number | null {
  const admissions = read.slice(CARD_ADMITTED, ['text', 'textSha'])
  const withBody = admissions.filter(({ fields }) => typeof fields.text === 'string' && typeof fields.textSha === 'string')
  return withBody.at(-1)?.id ?? null
}

export function widenedOnTheLatestAdmission(db: DatabaseSync, cardId: number): string[] {
  const read = new BusRead(db).where({ card: cardId })
  const admission = latestAdmissionWithBody(read)
  if (admission === null)
    return []
  return read.slice(SCOPE_WIDENED, ['paths', 'admission']).filter(event => event.fields.admission === admission).flatMap(event => pathsOf(event.fields.paths))
}

const [, PROCESS_TABLE] = CAPABILITIES

const WITNESS_GREEN = 'green'

const WITNESSES_LINE = 'witnesses: '

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function cardWitnesses(card: string | null): ProvenWitness[] {
  const line = (card ?? '').split('\n').find(text => text.startsWith(WITNESSES_LINE))
  if (line === undefined)
    return []
  try {
    const list = JSON.parse(line.slice(WITNESSES_LINE.length)) as unknown
    return Array.isArray(list)
      ? list.flatMap((item: Record<string, unknown> | null) => item !== null && isText(item.id) && isText(item.run) && isText(item.test) ? [{ id: item.id, run: item.run, test: item.test }] : [])
      : []
  }
  catch {
    return []
  }
}

function witnessGreenOnHead(db: DatabaseSync, lease: Lease): boolean {
  if (lease.head === null)
    return false
  const latest = new BusRead(db).where({ card: lease.cardId }).slice(WITNESS_RECORDED, ['verdict', 'cardBody']).filter(event => event.head === lease.head).at(-1)
  if (latest?.fields.verdict !== WITNESS_GREEN)
    return false
  const cardBody = reviewInputOfKey(lease.taskKey)?.cardBody ?? null
  return cardBody === null || latest.fields.cardBody === cardBody
}

export function provenWitnesses(db: DatabaseSync, lease: Lease, card: string | null): ProvenWitness[] {
  const needsProcessTable = cardWitnesses(card).filter(({ test }) => declaredCapabilities(test).includes(PROCESS_TABLE))
  return needsProcessTable.length > 0 && witnessGreenOnHead(db, lease) ? needsProcessTable : []
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
