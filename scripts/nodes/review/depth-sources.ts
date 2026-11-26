import type { DatabaseSync } from 'node:sqlite'
import type { BusCatalog } from '../../ci/card-runs.js'
import type { Lease } from '../../core/lease.js'
import type { CardBodyReader } from '../../intake/parking-reads.js'
import type { Backoff } from '../../ports/git.js'
import type { CardScope, DepthSources, ReviewPlanner } from './review-depth.js'
import type { ProvenWitness } from './reviewer.js'
import type { UnstartedTail, UnstartedTails } from './tail-card.js'
import { existsSync } from 'node:fs'
import { layerMasksOf, runsOf } from '../../../src/card/covering-tests.js'
import { parseParkingFile } from '../../../src/card/parking.js'
import { busCheckCatalog, cardReadingOf } from '../../ci/card-runs.js'
import { CAPABILITIES, declaredCapabilities } from '../../ci/sandbox-failing.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_CONTINUED, CARD_DROPPED, CARD_FELL, CARD_STARTED, CARD_STOPPED, MERGE_DONE, PR_OPENED, SCOPE_WIDENED, WITNESS_RECORDED } from '../../core/events.js'
import { reviewInputOfKey } from '../../core/identifiers.js'
import { openDatabase } from '../../core/sqlite.js'
import { predict } from '../../policy/morse/predict.js'
import { createdPaths } from '../../policy/touch-scope.js'
import { ANY, BusRead } from '../../ports/bus-read.js'
import { GIT_BACKOFF, processGit, syncThroughPort, throughGitPort } from '../../ports/git.js'
import { planReview } from './review-depth.js'
import { TAIL_ACTOR, TAIL_SOURCE } from './tail-card.js'

const MAIN = 'origin/main'

export type GitRun = (repo: string, args: string[]) => string

const git = throughGitPort((repo, args) => processGit.read(repo, args))

function fetchPr(run: GitRun, repo: string, pr: number, backoff: Backoff): void {
  syncThroughPort(run, repo, ['fetch', '--quiet', 'origin', 'main', `pull/${pr}/head`], backoff)
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

export type TestSource = (head: string, file: string) => string | null

export function gitTestSource(repo: string, run: GitRun = git): TestSource {
  return (head, file) => {
    try {
      return run(repo, ['show', `${head}:${file}`])
    }
    catch {
      return null
    }
  }
}

const TEST_FILE = /^[\w./@-]+\.(?:test|spec)\.[cm]?[jt]sx?$/

const TEST_CALL = /\b(describe|it|test)((?:\.\w+)*)\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g

const ESCAPED = /\\(.)/g

const QUOTES = new Set(['\'', '"', '`'])

const OPENING = new Set(['(', '[', '{'])

const CLOSING = new Set([')', ']', '}'])

interface TestCall { title: string, suite: boolean, start: number, end: number }

function skipQuoted(source: string, from: number): number {
  const quote = source[from]
  let at = from + 1
  while (at < source.length && source[at] !== quote)
    at += source[at] === '\\' ? 2 : 1
  return at + 1
}

function skipComment(source: string, from: number): number {
  if (source.startsWith('//', from)) {
    const end = source.indexOf('\n', from)
    return end === -1 ? source.length : end
  }
  const end = source.indexOf('*/', from + 2)
  return end === -1 ? source.length : end + 2
}

function withoutComments(source: string): string {
  let kept = ''
  let at = 0
  while (at < source.length) {
    const opensComment = source.startsWith('//', at) || source.startsWith('/*', at)
    const next = QUOTES.has(source[at]!) ? skipQuoted(source, at) : opensComment ? skipComment(source, at) : at + 1
    const piece = source.slice(at, next)
    kept += opensComment ? piece.replace(/[^\n]/g, ' ') : piece
    at = next
  }
  return kept
}

function callEnd(source: string, open: number): number {
  let depth = 0
  let at = open
  while (at < source.length) {
    const char = source[at]!
    if (QUOTES.has(char)) {
      at = skipQuoted(source, at)
      continue
    }
    if (OPENING.has(char))
      depth += 1
    else if (CLOSING.has(char) && --depth === 0)
      return at
    at += 1
  }
  return source.length
}

function testCalls(text: string): TestCall[] {
  const source = withoutComments(text)
  return [...source.matchAll(TEST_CALL)].map((match) => {
    const start = match.index + match[0].indexOf('(')
    return { title: match[4]!.replace(ESCAPED, '$1'), suite: match[1] === 'describe', start, end: callEnd(source, start) }
  })
}

export function fullTestNames(source: string): string[] {
  const calls = testCalls(source)
  return calls.filter(call => !call.suite).map((test) => {
    const chain = calls.filter(suite => suite.suite && suite.start < test.start && test.end <= suite.end)
    return [...chain.map(suite => suite.title), test.title].join(' ')
  })
}

function testFilesOf(run: string): string[] {
  return run.split(/\s+/).filter(token => TEST_FILE.test(token))
}

function namedTestsDeclare(witness: ProvenWitness, head: string, source: TestSource): boolean {
  const named = testFilesOf(witness.run).flatMap(file => fullTestNames(source(head, file) ?? '')).filter(name => name.includes(witness.test))
  return named.length > 0 && named.every(name => declaredCapabilities(name).includes(PROCESS_TABLE))
}

function declaresProcessTable(witness: ProvenWitness, head: string, source: TestSource): boolean {
  return declaredCapabilities(witness.test).includes(PROCESS_TABLE) || namedTestsDeclare(witness, head, source)
}

export function provenWitnesses(db: DatabaseSync, lease: Lease, card: string | null, source: TestSource): ProvenWitness[] {
  const witnesses = cardWitnesses(card)
  if (witnesses.length === 0 || lease.head === null || !witnessGreenOnHead(db, lease))
    return []
  const { head } = lease
  return witnesses.filter(witness => declaresProcessTable(witness, head, source))
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

export function gitReviewPlanner(repo: string, journal: string, bodyOf: CardBodyReader, run: GitRun = git, widenedOf: WidenedReader = busWidenedPaths(defaultBusPath()), backoff: Backoff = GIT_BACKOFF): ReviewPlanner {
  const sources = gitDepthSources(repo, journal, bodyOf, run, busCheckCatalog, widenedOf)
  return (lease, earlier) => {
    if (lease.pr !== null)
      fetchPr(run, repo, lease.pr, backoff)
    return planReview(lease, earlier, sources)
  }
}

const LEFT_THE_QUEUE = [CARD_STARTED, CARD_CONTINUED, CARD_ANSWERED, PR_OPENED, CARD_STOPPED, CARD_FELL, CARD_DROPPED, CARD_CLOSED, MERGE_DONE] as const

function hasLeftTheQueue(read: BusRead, card: number): boolean {
  const ofTheCard = read.where({ card })
  return LEFT_THE_QUEUE.some(type => ofTheCard.slice(type, [], 'last').length > 0)
}

export function busUnstartedTails(db: DatabaseSync): UnstartedTails {
  return (parent) => {
    const read = new BusRead(db)
    const admissions = read.where({ card: ANY, actor: TAIL_ACTOR }).slice(CARD_ADMITTED, ['source', 'depends', 'bodySha'])
    const tails = new Map<number, UnstartedTail>()
    for (const { card, fields } of admissions) {
      const depends = Array.isArray(fields.depends) ? fields.depends : []
      if (card === null || fields.source !== TAIL_SOURCE || depends[0] !== parent)
        continue
      tails.set(card, { card, bodySha: typeof fields.bodySha === 'string' ? fields.bodySha : null })
    }
    return [...tails.values()].filter(tail => !hasLeftTheQueue(read, tail.card)).sort((a, b) => a.card - b.card)
  }
}
