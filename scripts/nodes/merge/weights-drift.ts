import type { DatabaseSync } from 'node:sqlite'
import type { CardEvent, CardStatesPort } from '../../../src/commands/intake/index.js'
import type { CiRuns, RunOnMain, TestWeights } from '../../ci/test-weights.js'
import type { GitHub } from '../../ports/github.js'
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { bodySha } from '../../../src/commands/intake/confirm.js'
import { nextCardNumbers } from '../../../src/commands/intake/numbers.js'
import { CI_REPORT_ARTIFACT, FILE_WEIGHTS_NAME, measurementAt, RECOMPUTE_DRIFTED_SHARE, recomputedTable, WEIGHTS_PATH, weightsDrift } from '../../ci/test-weights.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../../core/card-automaton.js'
import { appendCardEvent, laid } from '../../core/card-bodies.js'
import { appendEvent, inTransaction } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_PLANNED, OPEN_PLAN, PR_OPENED } from '../../core/events.js'
import { pnpmCommand } from '../../core/owner-commands.js'
import { INTAKE_ACTOR_PREFIX } from '../../intake/admissions.js'
import { busHeldCards } from '../../intake/intake.js'
import { ANY, BusRead } from '../../ports/bus-read.js'
import { GhCiRuns, handedTablePath } from '../../ports/ci-reading.js'
import { launchDirOf } from '../../ports/tree-publish.js'
import { latestGitHubNumber } from '../review/pr-close.js'

export const WEIGHTS_DRIFT_SOURCE = 'weights-drift'
export const WEIGHTS_DRIFT_ACTOR = `${INTAKE_ACTOR_PREFIX}${WEIGHTS_DRIFT_SOURCE}`
export const WEIGHTS_DRIFT_UNREAD = 'weights_drift_unread'
export const RECOMPUTE_WITNESS = pnpmCommand('exec', 'vitest', 'run', 'scripts/tests/ci/test-weights-fresh.test.ts')
const RECOMPUTE_MILESTONE = 'construct'
const REPO = 'repos/{owner}/{repo}'
const OK = 200
const ABSENT = 404

export type DriftOutcome
  = | { kind: 'admitted', run: number, card: number, share: number }
    | { kind: 'fresh', run: number, share: number }
    | { kind: 'held', run: number, card: number }
    | { kind: 'seen', run: number }
    | { kind: 'unread', run: number | null, why: string }
    | { kind: 'no-run' }

export interface WeightsDriftParts {
  db: DatabaseSync
  ci: Pick<CiRuns, 'successfulRunsOnMain' | 'downloadArtifact'>
  gitHub: GitHub
  clock: () => Date
  cardStates: CardStatesPort
  launchDir: string
  scratch?: () => string
}

const ENDED_CARD_STATES: ReadonlySet<string> = new Set([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])

const LATEST_OPEN_RELEASE = `SELECT plan_id AS release FROM plans WHERE state = '${OPEN_PLAN}' ORDER BY event_id DESC LIMIT 1`

export function admissionKey(run: number): string {
  return `${CARD_ADMITTED}:${WEIGHTS_DRIFT_SOURCE}:run-${run}`
}

export function unreadKey(run: number): string {
  return `${BOARD_ALARM}:${WEIGHTS_DRIFT_UNREAD}:run-${run}`
}

function recomputeSlug(run: number): string {
  return `test-weights-recompute-${run}`
}

export interface RecomputeFigures {
  run: number
  head: string
  share: number
  driftedSeconds: number
  longestShardSeconds: number
  drifted: number
}

export function recomputeCardText(id: number, figures: RecomputeFigures): string {
  const percent = (figures.share * 100).toFixed(1)
  return parkingFileText({
    card: `#${id} ${recomputeSlug(figures.run)} [implement/${RECOMPUTE_MILESTONE}/S/cheap/auto] · depends — · blocks —`,
    branch: `feat/${recomputeSlug(figures.run)}`,
    touches: [WEIGHTS_PATH],
    continue: 'stop',
    who: 'shift',
    priority: 'p1',
    body: [
      `Recompute of ${WEIGHTS_PATH} admitted by the bus under D-600: CI run ${figures.run} on main at ${figures.head} measured ${figures.drifted} test files whose weight is missing or off, carrying ${figures.driftedSeconds.toFixed(1)} s, ${percent}% of the longest shard's ${figures.longestShardSeconds.toFixed(1)} s, above the ${(RECOMPUTE_DRIFTED_SHARE * 100).toFixed(0)}% line.`,
      '',
      `The bus computed the new table from that run and wrote it into this card's tree at ${WEIGHTS_PATH} before the session started. Change nothing else: commit that file as it stands and open the pull request. The table is ready; this card needs no network and no recompute of its own.`,
      '',
      'Witnesses:',
      `- ${RECOMPUTE_WITNESS}`,
    ].join('\n'),
  })
}

function cardEventOf(id: number, text: string, run: number, at: Date): CardEvent {
  const parsed = parseParkingFile(`${id}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(`the recompute card #${id} does not parse: ${parsed.reason}`)
  const { card: { line, depends, decision, contour } } = parsed.parked.task
  const sha = bodySha(text)
  return {
    type: CARD_ADMITTED,
    cardId: id,
    ts: at.toISOString(),
    dedupeKey: admissionKey(run),
    payload: { card: line, lane: null, depends, decision, contour, confirmation: 'auto', corrections: [], bodySha: sha, text, textSha: textSha(text), source: WEIGHTS_DRIFT_SOURCE },
  }
}

function decodedContent(body: unknown): string | null {
  const content = (body as { content?: unknown } | null)?.content
  return typeof content === 'string' ? Buffer.from(content, 'base64').toString('utf8') : null
}

export interface DriftWatch {
  watch: () => DriftOutcome
}

export function driftLine(outcome: DriftOutcome): string {
  switch (outcome.kind) {
    case 'admitted':
      return `test weights: run ${outcome.run} drifted ${(outcome.share * 100).toFixed(1)}% of the longest shard; recompute card #${outcome.card} admitted`
    case 'fresh':
      return `test weights: run ${outcome.run} drifted ${(outcome.share * 100).toFixed(1)}% of the longest shard, within the ${(RECOMPUTE_DRIFTED_SHARE * 100).toFixed(0)}% line`
    case 'held':
      return `test weights: run ${outcome.run} not measured while recompute card #${outcome.card} is unmerged`
    case 'seen':
      return `test weights: run ${outcome.run} was measured already`
    case 'unread':
      return `test weights: nothing admitted: ${outcome.why}`
    case 'no-run':
      return 'test weights: no successful CI run on main yet'
  }
}

export function liveWeightsDrift(gitHub: GitHub, busPath: string): (db: DatabaseSync) => DriftWatch {
  const launchDir = launchDirOf(homedir(), busPath)
  return db => new WeightsDriftWatch({ db, ci: new GhCiRuns(), gitHub, clock: () => new Date(), cardStates: () => busHeldCards(db), launchDir })
}

export class WeightsDriftWatch implements DriftWatch {
  private readonly checked = new Set<number>()

  constructor(private readonly parts: WeightsDriftParts) {}

  watch(): DriftOutcome {
    const listed = this.parts.ci.successfulRunsOnMain(1)
    if (listed.kind === 'failed')
      return { kind: 'unread', run: null, why: `the successful CI runs on main could not be listed: ${listed.reason}` }
    const run = listed.value[0]
    if (run === undefined)
      return { kind: 'no-run' }
    if (this.checked.has(run.databaseId) || this.decided(run.databaseId))
      return { kind: 'seen', run: run.databaseId }
    const open = this.openRecomputeCard()
    if (open !== null)
      return { kind: 'held', run: run.databaseId, card: open }
    const outcome = this.measured(run)
    if (outcome.kind === 'unread')
      this.recordUnread(run.databaseId, outcome.why)
    this.checked.add(run.databaseId)
    return outcome
  }

  private decided(run: number): boolean {
    const read = new BusRead(this.parts.db).where({ actor: WEIGHTS_DRIFT_ACTOR })
    const slug = ` ${recomputeSlug(run)} `
    return read.slice(CARD_ADMITTED, ['card']).some(event => String(event.fields.card).includes(slug))
      || read.slice(BOARD_ALARM, ['reason', 'ref']).some(event => event.fields.reason === WEIGHTS_DRIFT_UNREAD && event.fields.ref === String(run))
  }

  private openRecomputeCard(): number | null {
    const card = new BusRead(this.parts.db).where({ actor: WEIGHTS_DRIFT_ACTOR }).slice(CARD_ADMITTED, [], 'last')[0]?.card ?? null
    if (card === null)
      return null
    const state = this.parts.cardStates().get(String(card))
    return state !== undefined && ENDED_CARD_STATES.has(state) ? null : card
  }

  private measured(run: RunOnMain): DriftOutcome {
    const directory = (this.parts.scratch ?? (() => mkdtempSync(path.join(tmpdir(), 'weights-drift-'))))()
    try {
      const downloaded = this.parts.ci.downloadArtifact(run.databaseId, { name: CI_REPORT_ARTIFACT, dir: directory })
      if (!downloaded.done)
        return { kind: 'unread', run: run.databaseId, why: `the ${CI_REPORT_ARTIFACT} artifact of run ${run.databaseId} was not downloaded: ${downloaded.reason}` }
      const tree = this.treeAt(run.headSha)
      if (typeof tree === 'string')
        return { kind: 'unread', run: run.databaseId, why: tree }
      const measurement = measurementAt(path.join(directory, FILE_WEIGHTS_NAME), test => tree.has(test))
      if (measurement.kind === 'absent')
        return { kind: 'unread', run: run.databaseId, why: `run ${run.databaseId}: ${measurement.line}` }
      const table = this.tableAt(run.headSha)
      if (typeof table === 'string')
        return { kind: 'unread', run: run.databaseId, why: table }
      const drift = weightsDrift(measurement.weights, table, RECOMPUTE_DRIFTED_SHARE)
      if (!drift.stale)
        return { kind: 'fresh', run: run.databaseId, share: drift.share }
      const { text } = recomputedTable(table, measurement.weights, test => tree.has(test))
      const card = this.admit({ run: run.databaseId, head: run.headSha, share: drift.share, driftedSeconds: drift.driftedSeconds, longestShardSeconds: drift.longestShardSeconds, drifted: drift.drifted.length }, text)
      return { kind: 'admitted', run: run.databaseId, card, share: drift.share }
    }
    catch (error) {
      return { kind: 'unread', run: run.databaseId, why: `the drift of run ${run.databaseId} was not measured: ${messageOf(error)}` }
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  private tableAt(sha: string): TestWeights | string {
    const response = this.parts.gitHub(`${REPO}/contents/${WEIGHTS_PATH}?ref=${sha}`)
    if (response.status === ABSENT)
      return {}
    const text = response.status === OK ? decodedContent(response.body) : null
    return text === null ? `GitHub answered ${response.status} to the read of ${WEIGHTS_PATH} at ${sha}` : JSON.parse(text) as TestWeights
  }

  private treeAt(sha: string): Set<string> | string {
    const response = this.parts.gitHub(`${REPO}/git/trees/${sha}?recursive=1`)
    const body = response.body as { tree?: { path?: unknown }[], truncated?: unknown } | null
    if (response.status !== OK || !Array.isArray(body?.tree))
      return `GitHub answered ${response.status} to the read of the tree at ${sha}`
    if (body.truncated === true)
      return `GitHub truncated the tree at ${sha}, so which test files exist there is not known`
    return new Set(body.tree.flatMap(entry => typeof entry.path === 'string' ? [entry.path] : []))
  }

  private admit(figures: RecomputeFigures, table: string): number {
    const onGitHub = latestGitHubNumber(this.parts.gitHub)
    return inTransaction(this.parts.db, () => {
      const [id] = nextCardNumbers(this.parts.cardStates(), [this.latestPrInTheBus(), onGitHub], 1)
      const text = recomputeCardText(id!, figures)
      const handed = handedTablePath(this.parts.launchDir, id!)
      mkdirSync(path.dirname(handed), { recursive: true })
      writeFileSync(handed, table)
      const at = this.parts.clock()
      if (!appendCardEvent(this.parts.db, WEIGHTS_DRIFT_ACTOR, laid(this.parts.db, cardEventOf(id!, text, figures.run, at))))
        throw new Error(`the card.admitted of recompute card #${id} was not appended`)
      this.planIntoTheRelease(id!, at)
      return id!
    })
  }

  private latestPrInTheBus(): number {
    return new BusRead(this.parts.db).where({ pr: ANY }).slice(PR_OPENED, [], 'last')[0]?.pr ?? 0
  }

  private planIntoTheRelease(card: number, at: Date): void {
    const release = (this.parts.db.prepare(LATEST_OPEN_RELEASE).get() as { release: string } | undefined)?.release
    if (release === undefined)
      return
    appendEvent(this.parts.db, { ts: at.toISOString(), type: CARD_PLANNED, actor: WEIGHTS_DRIFT_ACTOR, cardId: card, pr: null, head: null, dedupeKey: `${CARD_PLANNED}:${WEIGHTS_DRIFT_SOURCE}:${release}:${card}`, payload: { release, card }, legacy: false })
  }

  private recordUnread(run: number, why: string): void {
    appendEvent(this.parts.db, { ts: this.parts.clock().toISOString(), type: BOARD_ALARM, actor: WEIGHTS_DRIFT_ACTOR, cardId: null, pr: null, head: null, dedupeKey: unreadKey(run), payload: { reason: WEIGHTS_DRIFT_UNREAD, ref: String(run), detail: why }, legacy: false })
  }
}
