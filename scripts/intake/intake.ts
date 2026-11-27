import type { DatabaseSync } from 'node:sqlite'
import type { CardEvent } from '../../src/commands/intake/index.js'
import type { LadderRunPort } from '../../src/commands/run-record.js'
import type { BusPorts } from '../../src/program.js'
import type { RecomputeFigures, RecomputeLedger, TableOrder } from '../nodes/merge/weights-drift.js'
import type { GitHub } from '../ports/github.js'
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runMain } from 'citty'
import { parkingFileText, parseParkingFile } from '../../src/card/parking.js'
import { textSha } from '../../src/card/text-sha.js'
import { bodySha, WINDOW_SHARD_VARIABLE } from '../../src/commands/intake/confirm.js'
import { printExport, runExport } from '../../src/commands/intake/export.js'
import { nextCardNumbers } from '../../src/commands/intake/numbers.js'
import { createMain } from '../../src/program.js'
import { createUi } from '../../src/ui/console.js'
import { resolveTheme } from '../../src/ui/theme.js'
import { RECOMPUTE_DRIFTED_SHARE, WEIGHTS_PATH } from '../ci/weights-law.js'
import { BUS_CONTRACT } from '../core/bus-adapter.js'
import { BUS_DB_VARIABLE, ForeignBusRefused } from '../core/bus-path.js'
import { CLOSED_CARD, DROPPED_CARD, MERGED_CARD } from '../core/card-automaton.js'
import { appendCardEvent, laid } from '../core/card-bodies.js'
import { appendEvent, defaultBusPath, inTransaction, openBus } from '../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, LADDER_RUN, PR_OPENED } from '../core/events.js'
import { constructCommand, pnpmCommand } from '../core/owner-commands.js'
import { launchWaitsOf } from '../nodes/launch/lane-assign.js'
import { latestGitHubNumber } from '../nodes/review/pr-close.js'
import { BusDecisions } from '../policy/decisions/index.js'
import { activeWindowShards } from '../policy/shards.js'
import { ANY, BusRead } from '../ports/bus-read.js'
import { clientAdapter } from '../ports/session.js'
import { tabWindowOf } from '../window/tab.js'
import { windowSessionOf } from '../window/window-heartbeat.js'
import { INTAKE_ACTOR_PREFIX } from './admissions.js'
import { busCardAdmissions, busCardEvents, busHeldCards, isOpenRelease, OPEN_A_RELEASE, RELEASE_FLAG } from './bus-intake.js'

const INTAKE_SUBCOMMAND = 'intake'
const RUN_RECORD_SUBCOMMAND = 'run-record'
const EXPORT_FLAG = '--export'
const PLAIN_FLAG = '--plain'
const JOHNNY_FLAG = '--johnny'

export const WEIGHTS_DRIFT_SOURCE = 'weights-drift'
export const WEIGHTS_DRIFT_ACTOR = `${INTAKE_ACTOR_PREFIX}${WEIGHTS_DRIFT_SOURCE}`
export const WEIGHTS_DRIFT_UNREAD = 'weights_drift_unread'
export const RECOMPUTE_WITNESS = pnpmCommand('exec', 'vitest', 'run', 'scripts/tests/ci/test-weights-fresh.test.ts')
const RECOMPUTE_MILESTONE = 'construct'
const ENDED_CARD_STATES: ReadonlySet<string> = new Set([MERGED_CARD, CLOSED_CARD, DROPPED_CARD])
const WEIGHTS_REPO = 'repos/{owner}/{repo}'
const LAST_TABLE_CHANGE = `${WEIGHTS_REPO}/commits?path=${WEIGHTS_PATH}&per_page=1`
const AT_OR_AFTER_CHANGE: ReadonlySet<unknown> = new Set(['ahead', 'identical'])
const BEFORE_CHANGE: ReadonlySet<unknown> = new Set(['behind', 'diverged'])

export function weightsTableOrder(gitHub: GitHub, head: string): TableOrder {
  const commits = gitHub(LAST_TABLE_CHANGE)
  if (commits.status !== 200 || !Array.isArray(commits.body))
    return { kind: 'unread', why: `GitHub answered ${commits.status} to the read of the last change of ${WEIGHTS_PATH} on main` }
  const change = (commits.body[0] as { sha?: unknown } | undefined)?.sha
  if (commits.body.length === 0 || change === head)
    return { kind: 'current' }
  if (typeof change !== 'string')
    return { kind: 'unread', why: `GitHub named the last change of ${WEIGHTS_PATH} on main with no sha` }
  const compared = gitHub(`${WEIGHTS_REPO}/compare/${change}...${head}`)
  const status = (compared.body as { status?: unknown } | null)?.status
  if (compared.status === 200 && AT_OR_AFTER_CHANGE.has(status))
    return { kind: 'current' }
  if (compared.status === 200 && BEFORE_CHANGE.has(status))
    return { kind: 'behind', change }
  return { kind: 'unread', why: `GitHub answered ${compared.status} with status ${String(status)} to the comparison of ${head} with ${change}, the last change of ${WEIGHTS_PATH}` }
}

function recomputeSlug(run: number): string {
  return `test-weights-recompute-${run}`
}

export function recomputeCardText(id: number, figures: RecomputeFigures): string {
  return parkingFileText({
    card: `#${id} ${recomputeSlug(figures.run)} [implement/${RECOMPUTE_MILESTONE}/S/cheap/auto] · depends — · blocks —`,
    branch: `feat/${recomputeSlug(figures.run)}`,
    touches: [WEIGHTS_PATH],
    continue: 'stop',
    who: 'shift',
    priority: 'p1',
    body: [
      `Recompute of ${WEIGHTS_PATH} admitted by the bus under D-600: CI run ${figures.run} on main at ${figures.head} measured ${figures.drifted} test files whose weight is missing or off, carrying ${figures.driftedSeconds.toFixed(1)} s, ${(figures.share * 100).toFixed(1)}% of the longest shard's ${figures.longestShardSeconds.toFixed(1)} s, above the ${(RECOMPUTE_DRIFTED_SHARE * 100).toFixed(0)}% line.`,
      '',
      `The bus computed the new table from that run and wrote it into this card's tree at ${WEIGHTS_PATH} before the session started. Change nothing else: commit that file as it stands and open the pull request. The table is ready; this card needs no network and no recompute of its own.`,
      '',
      'Witnesses:',
      `- ${RECOMPUTE_WITNESS}`,
    ].join('\n'),
  })
}

function recomputeEventOf(id: number, text: string, run: number, at: Date): CardEvent {
  const parsed = parseParkingFile(`${id}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(`the recompute card #${id} does not parse: ${parsed.reason}`)
  const { card: { line, depends, decision, contour } } = parsed.parked.task
  return {
    type: CARD_ADMITTED,
    cardId: id,
    ts: at.toISOString(),
    dedupeKey: `${CARD_ADMITTED}:${WEIGHTS_DRIFT_SOURCE}:run-${run}`,
    payload: { card: line, depends, decision, contour, confirmation: 'auto', corrections: [], bodySha: bodySha(text), text, textSha: textSha(text), source: WEIGHTS_DRIFT_SOURCE },
  }
}

export interface WeightsRecomputeParts {
  db: DatabaseSync
  gitHub: GitHub
  hand: (cardId: number, file: string, text: string) => void
  clock: () => Date
}

export class BusWeightsRecompute implements RecomputeLedger {
  constructor(private readonly parts: WeightsRecomputeParts) {}

  private get read(): BusRead {
    return new BusRead(this.parts.db).where({ actor: WEIGHTS_DRIFT_ACTOR })
  }

  decided(run: number): boolean {
    const slug = ` ${recomputeSlug(run)} `
    return this.read.slice(CARD_ADMITTED, ['card']).some(event => String(event.fields.card).includes(slug))
      || this.read.slice(BOARD_ALARM, ['reason', 'ref']).some(event => event.fields.reason === WEIGHTS_DRIFT_UNREAD && event.fields.ref === String(run))
  }

  tableOrder(head: string): TableOrder {
    return weightsTableOrder(this.parts.gitHub, head)
  }

  openCard(): number | null {
    const card = this.read.slice(CARD_ADMITTED, [], 'last')[0]?.card ?? null
    if (card === null)
      return null
    const state = busHeldCards(this.parts.db).get(String(card))
    return state !== undefined && ENDED_CARD_STATES.has(state) ? null : card
  }

  admit(figures: RecomputeFigures, table: string): number {
    const onGitHub = latestGitHubNumber(this.parts.gitHub)
    const { db } = this.parts
    return inTransaction(db, () => {
      const [id] = nextCardNumbers(busHeldCards(db), [this.latestPrInTheBus(), onGitHub], 1)
      const text = recomputeCardText(id!, figures)
      this.parts.hand(id!, WEIGHTS_PATH, table)
      const at = this.parts.clock()
      if (!appendCardEvent(BUS_CONTRACT, db, WEIGHTS_DRIFT_ACTOR, laid(db, recomputeEventOf(id!, text, figures.run, at))))
        throw new Error(`the card.admitted of recompute card #${id} was not appended`)
      return id!
    })
  }

  unread(run: number, why: string): void {
    appendEvent(this.parts.db, { ts: this.parts.clock().toISOString(), type: BOARD_ALARM, actor: WEIGHTS_DRIFT_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${WEIGHTS_DRIFT_UNREAD}:run-${run}`, payload: { reason: WEIGHTS_DRIFT_UNREAD, ref: String(run), detail: why }, legacy: false })
  }

  private latestPrInTheBus(): number {
    return new BusRead(this.parts.db).where({ pr: ANY }).slice(PR_OPENED, [], 'last')[0]?.pr ?? 0
  }
}

export function busIntakePorts(db: DatabaseSync, session?: string, release?: string, declarationsRoot?: string): BusPorts {
  return { cardEvents: busCardEvents(db, session, release, declarationsRoot), cardStates: () => busHeldCards(db), cardAdmissions: busCardAdmissions(db), decisions: new BusDecisions(db), cardWaits: launchWaitsOf(db) }
}

export async function runBusIntake(db: DatabaseSync, argv: readonly string[], session?: string, declarationsRoot?: string): Promise<void> {
  const exportAt = argv.indexOf(EXPORT_FLAG)
  if (exportAt !== -1) {
    const ui = createUi(resolveTheme({ plain: argv.includes(PLAIN_FLAG), johnny: argv.includes(JOHNNY_FLAG) }))
    process.exitCode = printExport(ui, runExport({ card: argv[exportAt + 1] ?? '', admissions: busCardAdmissions(db) }), text => process.stdout.write(text))
    return
  }
  const releaseAt = argv.indexOf(RELEASE_FLAG)
  const release = releaseAt === -1 ? undefined : argv[releaseAt + 1] ?? ''
  if (release !== undefined && !isOpenRelease(db, release)) {
    process.stderr.write(`Refused: ${RELEASE_FLAG} ${release} names no open release in the bus; open it with ${OPEN_A_RELEASE} first. Nothing was admitted.\n`)
    process.exitCode = 1
    return
  }
  const rest = releaseAt === -1 ? argv : [...argv.slice(0, releaseAt), ...argv.slice(releaseAt + 2)]
  await runMain(createMain(busIntakePorts(db, session, release, declarationsRoot)), { rawArgs: [INTAKE_SUBCOMMAND, ...rest] })
}

function refused(message: string): null {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
  return null
}

function namesItsBus(): boolean {
  return (process.env[BUS_DB_VARIABLE] ?? '') !== ''
}

function intakeBusPath(): string | null {
  try {
    const busPath = defaultBusPath()
    if (namesItsBus() || existsSync(busPath))
      return busPath
    return refused(`Refused: no bus at ${busPath}, and a card number comes only from the bus; run construct-factory or ${constructCommand('attach')} in this repository first, or name the bus in ${BUS_DB_VARIABLE}. No bus was created and no number assigned.`)
  }
  catch (error) {
    if (!(error instanceof ForeignBusRefused))
      throw error
    return refused(error.message)
  }
}

export function windowShardOfRun(db: DatabaseSync, env: NodeJS.ProcessEnv, now: Date): string | null {
  if (windowSessionOf(env) === null && tabWindowOf(env) === null)
    return null
  return activeWindowShards(db, now)[0]?.id ?? null
}

export const busLadderRun: LadderRunPort = (busPath, event) => {
  const db = openBus(busPath)
  try {
    return appendEvent(db, { ...event, type: LADDER_RUN, pr: null, head: null, legacy: false })
  }
  finally {
    db.close()
  }
}

async function runRunRecord(argv: readonly string[]): Promise<void> {
  await runMain(createMain({ ladderRun: busLadderRun }), { rawArgs: [...argv] })
}

export async function intakeMain(argv: readonly string[]): Promise<void> {
  if (argv[0] === RUN_RECORD_SUBCOMMAND) {
    await runRunRecord(argv)
    return
  }
  const busPath = intakeBusPath()
  if (busPath === null)
    return
  const db = openBus(busPath)
  try {
    const shard = windowShardOfRun(db, process.env, new Date())
    if (shard !== null)
      process.env[WINDOW_SHARD_VARIABLE] = shard
    await runBusIntake(db, argv, clientAdapter().ownSession(process.env) ?? undefined, process.cwd())
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await intakeMain(process.argv.slice(2))
