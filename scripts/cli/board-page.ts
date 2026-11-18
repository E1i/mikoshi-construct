import type { DatabaseSync } from 'node:sqlite'
import type { WitnessField } from '../../src/card/witness-fields.js'
import type { BusCard, BusFacts, BusMatrix, BusService, CardsAtStage, CardStage, OwnerWait } from '../../src/commands/board/bus.js'
import type { CardMark, PlanProgress, ReleaseStage } from '../../src/commands/board/goal.js'
import type { CardStanding } from '../../src/commands/board/screens.js'
import type { FactoryState, TranscriptReader } from '../../src/commands/liveness.js'
import type { CheckCatalog } from '../ci/card-runs.js'
import type { LayerMap } from '../core/layer-map.js'
import type { CardFields } from '../intake/card-contract.js'
import type { WitnessRecordOnHead, WitnessTable } from '../intake/witness-fields-backfill.js'
import type { RoundKind, RoundSample } from '../supervisor/expected-time.js'
import type { RunsGroup, RunsReading } from './board-page/runs-html.js'
import type { AgentWords, EddiesLimits, Gauges, RoundStep, SessionView } from './board-page/session-card.js'
import type { BoardWarning, SessionContext } from './board-warnings.js'
import type { CardChain } from './card-chain.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { RUNS_PREFIX } from '../../src/card/covering-tests.js'
import { fieldCommand } from '../../src/card/witness-fields.js'
import { busFacts, CARD_STAGES, latestCardEvents, openTasks } from '../../src/commands/board/bus.js'
import { DROPPED, droppedLine, goalOf, MARK_WORDS, planLine } from '../../src/commands/board/goal.js'
import { backlogCards, byStage, counted, inLiveView, isLive, liftedByTheWindow, markedName, matrixLines, screenLines, sliceMark, slotsReading, standingLine, standingOf, tallyLine, taskGroupLine, taskGroups, taskTally, waitAction, waitTarget, WINDOW_WAITS_ROLE } from '../../src/commands/board/screens.js'
import { clientTranscriptReader, factoryLiveness, readTranscript } from '../../src/commands/liveness.js'
import { BANNER, LORE, PLAIN_LORE } from '../../src/ui/lore.js'
import { currentVersion, interfaceVersion } from '../../src/version.js'
import { cardRunsOf, catalogLayersByTest, catalogModuleLayers } from '../ci/card-runs.js'
import { staleLine } from '../core/bus-readings.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { ANSWER_STEP, CARD_HELD, CARD_RELEASED, TASK_LEASED } from '../core/events.js'
import { defaultHandoffDir } from '../core/handoff-dir.js'
import { statusLineOf } from '../core/handoff-status.js'
import { readLayerMap } from '../core/layer-map.js'
import { constructCommand, pnpmCommand } from '../core/owner-commands.js'
import { openDatabase } from '../core/sqlite.js'
import { cardContract } from '../intake/card-contract.js'
import { recordedWitnessFieldsBackfill, witnessTableOf } from '../intake/witness-fields-backfill.js'
import { currentDecisions } from '../policy/decisions/index.js'
import { GREEN, RED, UNCHECKED } from '../policy/policy.js'
import { BusRead } from '../ports/bus-read.js'
import { ghApi } from '../ports/github.js'
import { cardSizeIn } from '../ports/session.js'
import { cardSessionOf, expectedMinutes, roundSamples, shapeOf } from '../supervisor/expected-time.js'
import { BOARD_FILE, FRESH_MS, windowGauges } from '../window/board.js'
import { mikoHandoff } from '../window/loop.js'
import { planMarkdown } from '../window/plan-export.js'
import { busFresh, busPanel, pulseAgeMs } from './board-page/bus-panel.js'
import { BOARD_HISTORY_FILE, FILTER_ATTRIBUTE, filterId, filterRule, LIVE_FILTER, liveCardsOf, ownerHolds } from './board-page/live-cards.js'
import { mikoBay, mikoPanel } from './board-page/miko-panel.js'
import { LAYER_ENTRY, runsHtml, TOUCHED_TESTS } from './board-page/runs-html.js'
import { agentsLine, CARD_TASK, compact, eddiesBar, escaped, modelLabel, NO_SESSION_VIEW, percent, ROUND_COLOURS, ROUND_LABELS, sessionCard, STEPPED_ROLE, terminalOf } from './board-page/session-card.js'
import { boardWarnings, MainUpToDate, openPrCountOf, openPrLimitOf, plannedStallLines, savingOff, stalePassCountOf, stallLines } from './board-warnings.js'
import { cardChain } from './card-chain.js'

export const PREFIX = '[bus:board] '
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const EDDIES_FILE = path.join(REPOSITORY_ROOT, '.claude/eddies.json')
export const MODEL_FILE = path.join(REPOSITORY_ROOT, 'construct.model.json')
export const PACKAGE_FILE = path.join(REPOSITORY_ROOT, 'package.json')
export const HANDOFF_FILE = mikoHandoff(defaultHandoffDir())

export interface BoardFiles {
  write: (file: string, text: string) => void
  rename: (from: string, to: string) => void
}

export const DISK_FILES: BoardFiles = {
  write: (file, text) => writeFileSync(file, text),
  rename: renameSync,
}

export { escaped }
export type { EddiesLimits, Gauges, RunsGroup, RunsReading }

export interface CardDetail {
  contract: CardFields | null
  chain: CardChain | null
  pr: number | null
  witnessTable: WitnessTable | null
  runs: RunsReading | null
}

export interface Handoff {
  file: string
  text: string | null
}

export interface MachineLoad {
  load: number
  cores: number
}

export function machineLoad(): MachineLoad {
  return { load: os.loadavg()[0]!, cores: os.availableParallelism() }
}

export interface BoardPage {
  version: string
  machine: MachineLoad
  liveness: FactoryState
  modelVersion: number | null
  facts: BusFacts
  windowGauges: Gauges | null
  limits: EddiesLimits
  details: Map<number, CardDetail>
  decisions: ReturnType<typeof currentDecisions>
  handoff: Handoff
  repository: string | null
  tickMs: number | null
  warnings: BoardWarning[]
  sessions?: ReadonlyMap<string, SessionView>
  snapshot?: BoardSnapshot | null
  held?: ReadonlyMap<number, string>
}

const NO_LIMITS: EddiesLimits = { contextLimit: null, cardContextLine: null, sessionSpend: null, agentSpend: null, warnRatio: null, modelWindows: new Map() }
const WINDOW_PLAIN_TITLE = ` title="${PLAIN_LORE.boardWindowRole} · ${PLAIN_LORE.boardWindowName}"`
const AGENT_WORDS: AgentWords = { pulse: PLAIN_LORE.boardAgentPulse, line: PLAIN_LORE.boardAgentsLine }
const ROUND_QUEUES: Readonly<Partial<Record<string, RoundKind>>> = { answer: 'answer', review: 'review' }
const WINDOW_ROLE = 'window'
const CARD_PREFIX = /^card:\s*/
const FIELD_COUNT = 5
const NONE = '—'
const ALL_FILTER = 'all'
const MINUTE_MS = 60_000
export const BOARD_DATA_FILE = 'board-data.js'
const BOARD_DATA_PREFIX = 'window.BOARD = '
const FORMAT_FLAGS: readonly (readonly [string, BoardFormat])[] = [['--json', 'json'], ['--html', 'html']]
const PLAN_FLAG = '--plan'
const ALL_FLAG = '--all'
const EXPORT_ORDER: readonly CardMark[] = ['delivered', 'in_progress', 'review', 'queued', DROPPED]
const EVENTS_PER_CARD = 5
const STALE_TICKS = 2
const STALE_READING = 'STALE'
export const SLOT_PREFIX = 'slot-'
const BUS_LIVE = 'bus-live'
const PULSE_ELEMENT_ID = 'bus-pulse'
const REFRESH_IN = 'refresh-in'
const OFFLINE_READING = 'bus offline'
const FACTORY_LIVE: FactoryState = 'live'
const BACKLOG = 'backlog'
const DRILL = 'drill'
const DRILL_CONTENT = 'drill-content'
const BACKLOG_SCROLL = 'backlog-scroll'
const DIALOG_PREFIX = 'dialog-'
const HANDOFF_DIALOG = 'handoff'
const DECISIONS_DIALOG = 'decisions'
const OPEN_HINT = '<span class="open-hint">open ›</span>'
const PULL_TITLE = 'Re-read the board now instead of at the next refresh; the bus catches the list up as it reduces'
const CARD_REFERENCE = /(?<!&|PR )#(\d+)\b/g
export const FLOW_META = 'live and recently ended cards by stage'
const CODE_SPAN = /`([^`]+)`/g
const HANDOFF_LINE = /^([^\s#:*-][^:]*):(?: (.*))?$/
const LIST_ITEM = /^\s*[-*]\s+/
const PUNCH_DIGITS = 16
const SETTLED_STAGES: readonly CardStage[] = ['merged', 'dropped']
export const PROGRESS_ORDER: readonly CardStage[] = ['merged', 'ready', 'answer/changes', 'review', 'in work', 'planned', 'stopped', 'dropped']
export const RELEASE_PROGRESS_ORDER: readonly ReleaseStage[] = ['delivered', 'review', 'in_progress', 'queued']
const WAIT_NEEDS: Record<OwnerWait['need'], string> = { decision: 'D', merge: 'M', command: 'C' }
const NOT_RUN_ON_HEAD = 'not run'
const NOT_REACHED_ON_HEAD = 'not reached'
const COULD_NOT_CHECK_ON_HEAD = 'could not check'
const SETTLED_ON_HEAD: Readonly<Partial<Record<string, string>>> = { [GREEN]: GREEN, [UNCHECKED]: COULD_NOT_CHECK_ON_HEAD }
const NEGATED_RUN = /^!\s+/
const WITNESS_ID_COLUMN = 'id'
const WITNESS_COLUMNS = ['run', 'test', 'head/base', 'proves']

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function positiveEntriesOf(value: unknown): ReadonlyMap<string, number> {
  if (value === null || typeof value !== 'object')
    return new Map()
  return new Map(Object.entries(value).flatMap(([model, size]): [string, number][] => {
    const window = positive(size)
    return window === null ? [] : [[model, window]]
  }))
}

export function readEddiesLimits(file: string = EDDIES_FILE): EddiesLimits {
  try {
    const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null
    return config === null || typeof config !== 'object' ? NO_LIMITS : { contextLimit: positive(config.contextLimit), cardContextLine: positive(config.cardContextLine), cardLineBySize: positiveEntriesOf(config.cardContextLineBySize), sessionSpend: positive(config.sessionSpend), agentSpend: positive(config.agentSpend), warnRatio: positive(config.warnRatio), modelWindows: positiveEntriesOf(config.modelWindows) }
  }
  catch {
    return NO_LIMITS
  }
}

export function readModelVersion(file: string = MODEL_FILE): number | null {
  try {
    const model = JSON.parse(readFileSync(file, 'utf8')) as { modelVersion?: unknown } | null
    return Number.isInteger(model?.modelVersion) ? model!.modelVersion as number : null
  }
  catch {
    return null
  }
}

export function readRepositoryUrl(file: string = PACKAGE_FILE): string | null {
  try {
    const url = (JSON.parse(readFileSync(file, 'utf8')) as { repository?: { url?: unknown } } | null)?.repository?.url
    return typeof url === 'string' ? url.replace(/^git\+/, '').replace(/\.git$/, '') : null
  }
  catch {
    return null
  }
}

export function readHandoff(file: string = HANDOFF_FILE): Handoff {
  try {
    return { file, text: readFileSync(file, 'utf8') }
  }
  catch {
    return { file, text: null }
  }
}

function cardPrs(db: DatabaseSync): Map<number, number> {
  const rows = db.prepare('SELECT card_id, pr FROM cards WHERE pr IS NOT NULL').all() as { card_id: number, pr: number }[]
  return new Map(rows.map(row => [Number(row.card_id), Number(row.pr)]))
}

function writtenEntries(named: readonly string[], masks: readonly string[]): string[] {
  return [...named, ...masks.map(mask => `${LAYER_ENTRY}${mask}`)]
}

function groupsOf(layers: readonly string[], tests: readonly string[], masks: readonly string[], catalog: CheckCatalog): RunsGroup[] {
  return layers.map(layer => ({ name: layer, files: tests.filter(test => catalog.testLayers.get(test)?.includes(layer)), derived: !masks.includes(layer) }))
}

export function runsReadingOf(touches: readonly string[], named: readonly string[], masks: readonly string[], catalog: CheckCatalog, map: LayerMap): RunsReading {
  const reading = cardRunsOf({ touches, runs: named, masks }, catalog, map)
  if ('full' in reading)
    return { full: reading.why, groups: [], paths: writtenEntries(named, masks) }
  const groups = groupsOf(reading.layers, reading.tests, masks, catalog)
  const shown = new Set([...groups.flatMap(group => group.files), ...reading.paths])
  const touched = reading.tests.filter(test => !shown.has(test))
  return { full: null, groups: touched.length === 0 ? groups : [...groups, { name: TOUCHED_TESTS, files: touched, derived: true }], paths: reading.paths }
}

function cardDetails(db: DatabaseSync, facts: BusFacts): Map<number, CardDetail> {
  const prs = cardPrs(db)
  const backfill = recordedWitnessFieldsBackfill(db)
  const catalog: CheckCatalog = { testLayers: catalogLayersByTest(db), moduleLayers: catalogModuleLayers(db) }
  const map = readLayerMap()
  return new Map(facts.cards.map((card) => {
    const contract = cardContract(db, card.id)
    const pr = prs.get(card.id) ?? null
    const witnessTable = witnessTableOf(db, contract, pr, backfill)
    const named = witnessTable?.runs ?? contract?.runs ?? []
    const runs = contract === null
      ? null
      : SETTLED_STAGES.includes(card.stage)
        ? { full: null, groups: [], paths: writtenEntries(named, contract.masks) }
        : runsReadingOf(contract.touches, named, contract.masks, catalog, map)
    return [card.id, { contract, chain: cardChain(db, card.id), pr, witnessTable, runs }]
  }))
}

function projectedWindowGauges(db: DatabaseSync): Gauges | null {
  const row = windowGauges(db)
  return row === null ? null : { context: positive(row.context), spent: positive(row.spent), model: row.model }
}

function cardLineOf(limits: EddiesLimits, task: string, facts: Pick<BusFacts, 'cards'>): Pick<EddiesLimits, 'contextLimit' | 'warnRatio'> {
  const size = cardSizeIn(facts.cards.find(card => card.id === Number(CARD_TASK.exec(task)?.[1]))?.line ?? null)
  const line = (size === null ? undefined : limits.cardLineBySize?.get(size)) ?? limits.cardContextLine
  return line === null ? limits : { contextLimit: line, warnRatio: 1 }
}

function stepsAfter(read: BusRead, lease: number): RoundStep[] {
  return read.slice(ANSWER_STEP, ['step', 'seconds']).filter(row => row.id > lease).flatMap(({ fields }) => typeof fields.step === 'string' && typeof fields.seconds === 'number' ? [{ step: fields.step, seconds: fields.seconds }] : [])
}

function sessionViewOf(db: DatabaseSync, service: BusService, cardLine: string | null, samples: () => readonly RoundSample[], transcripts: TranscriptReader): SessionView {
  const card = Number(CARD_TASK.exec(service.task)?.[1])
  const read = new BusRead(db).where({ card })
  const session = cardSessionOf(db, card)
  const lease = read.slice(TASK_LEASED, ['queue'], 'last')[0]
  const kind = ROUND_QUEUES[service.role]
  const expected = kind === undefined ? null : expectedMinutes(samples(), kind, shapeOf(cardLine))
  const sessionId = service.session ?? session?.session ?? null
  const text = session?.worktree == null || sessionId === null ? null : transcripts(session.worktree, sessionId)
  const steps = lease === undefined || service.role !== STEPPED_ROLE ? [] : stepsAfter(read, lease.id)
  return { startedAt: lease?.ts ?? session?.startedAt ?? null, expectedMs: expected === null ? null : expected * MINUTE_MS, steps, terminal: terminalOf(text, transcript => readTranscript(transcript).actions) }
}

function sessionViewsOf(db: DatabaseSync, facts: Pick<BusFacts, 'services' | 'cards'>, transcripts: TranscriptReader = clientTranscriptReader): Map<string, SessionView> {
  let samples: readonly RoundSample[] | null = null
  const measured = (): readonly RoundSample[] => samples ??= roundSamples(db)
  const lineOf = (task: string): string | null => facts.cards.find(card => `#${card.id}` === task)?.line ?? null
  return new Map(facts.services.filter(service => CARD_TASK.test(service.task)).map(service => [`${service.role} ${service.task}`, sessionViewOf(db, service, lineOf(service.task), measured, transcripts)]))
}

function contextBar(service: BusService, gauges: Gauges, limits: EddiesLimits, facts: Pick<BusFacts, 'cards'>): string {
  const line = service.role === WINDOW_ROLE ? limits : cardLineOf(limits, service.task, facts)
  const denominator = gauges.model === null ? null : limits.modelWindows.get(gauges.model) ?? null
  return eddiesBar('ctx', gauges.context, denominator, line.contextLimit, line.warnRatio)
}

type GaugeSources = Pick<BoardPage, 'windowGauges'>

function gaugesOf(service: BusService, sources: GaugeSources): Gauges | null | undefined {
  if (service.role === WINDOW_ROLE)
    return sources.windowGauges
  return service.gauges
}

function sessionContexts(services: readonly BusService[], sources: GaugeSources, liveness: FactoryState): SessionContext[] {
  const contexts = new Map<string, number>()
  for (const service of services) {
    const context = gaugesOf(service, sources)?.context
    const windowGone = service.role === WINDOW_ROLE && liveness !== FACTORY_LIVE
    if (context != null && !windowGone) {
      const who = service.role === WINDOW_ROLE ? WINDOW_ROLE : service.task
      contexts.set(who, Math.max(contexts.get(who) ?? 0, context))
    }
  }
  return [...contexts].map(([who, context]) => ({ who, context }))
}

function tileDialog(service: BusService, page: BoardPage): string | null {
  if (service.role === WINDOW_ROLE)
    return HANDOFF_DIALOG
  const card = CARD_TASK.exec(service.task)?.[1]
  return card !== undefined && page.details.has(Number(card)) ? cardDialog(Number(card)) : null
}

function barsOf(service: BusService, page: BoardPage): string {
  const gauges = gaugesOf(service, page)
  return gauges == null ? '' : contextBar(service, gauges, page.limits, page.facts) + eddiesBar('spent', gauges.spent, page.limits.sessionSpend, page.limits.sessionSpend, page.limits.warnRatio)
}

function serviceTile(service: BusService, page: BoardPage): string {
  const bars = barsOf(service, page)
  const dialog = tileDialog(service, page)
  const parts = { opener: dialog === null ? '' : `${opener(dialog)} role="button"`, hint: dialog === null ? '' : OPEN_HINT, bars, agents: agentsLine(service, page.facts.at, page.limits, AGENT_WORDS), over: bars.includes(' data-over'), now: page.facts.at }
  return sessionCard(service, page.sessions?.get(`${service.role} ${service.task}`) ?? NO_SESSION_VIEW, parts)
}

function lineTile(role: string, line: string): string {
  return `<div class="svc bevel" data-role="${role}"><div class="svc-top"><span class="svc-kind">${role}</span><span class="lore">ICE</span></div><div class="svc-line">${escaped(line)}</div></div>`
}

function mikoStrip(page: BoardPage, { facts } = page): string {
  const windows = facts.services.filter(service => service.role === WINDOW_ROLE)
  const words = { role: LORE.boardWindowRole, name: LORE.boardWindowName, plainTitle: WINDOW_PLAIN_TITLE }
  const handoff = page.handoff.text
  const presence = { model: modelLabel(page.windowGauges?.model), core: facts.window?.core ?? null, status: handoff === null ? null : statusLineOf(handoff)?.status ?? null, handoffBytes: handoff === null ? null : new TextEncoder().encode(handoff).length, skills: facts.window?.skills ?? [], crawlers: facts.window?.crawlers ?? [] }
  return mikoPanel({ windows, bars: service => barsOf(service, page), presence, now: facts.at, words, opener: `${opener(HANDOFF_DIALOG)} role="button"`, hint: OPEN_HINT, idle: facts.services.length === 0 ? PLAIN_LORE.boardNoServices : null, bay: mikoBay(process.cwd(), presence.skills, LORE) })
}

function liveAttribute(facts: BusFacts): string {
  return busFresh(facts, FRESH_MS) ? '' : ' data-stale'
}

function servicesMeta(page: BoardPage): string {
  const { facts, limits } = page
  const warn = limits.warnRatio === null ? 'eddies: no warn line' : `eddies: warn line <b>${percent(limits.warnRatio)}</b>`
  const cardLine = limits.cardContextLine === null ? '' : ` · card line <b>${compact(limits.cardContextLine)}</b>`
  const sizedLines = [...limits.cardLineBySize ?? []].filter(([, line]) => line !== limits.cardContextLine).map(([size, line]) => ` · ${escaped(size)} <b>${compact(line)}</b>`).join('')
  return [
    `<span class="meta">quickhacks on the subnet · agents at work <b>${facts.services.length}</b> · slots <b>${escaped(slotsReading(facts))}</b></span>`,
    `<span class="meta right edd-note">${warn}${cardLine}${sizedLines}</span>`,
  ].join('')
}

function servicesSlot(page: BoardPage): string {
  const { facts } = page
  return [
    `<div class="panel-head"><h2 id="h-services">${PLAIN_LORE.boardTabServices}</h2>${servicesMeta(page)}</div>`,
    '<div class="svc-grid">',
    ...facts.services.filter(service => service.role !== WINDOW_ROLE).map(service => serviceTile(service, page)),
    ...matrixLines(facts, PLAIN_LORE).map(line => lineTile('matrix', line)),
    '</div>',
    mikoStrip(page),
    busPanel({ facts, freshMs: FRESH_MS, snapshot: page.snapshot ?? null, startCommand: pnpmCommand('bus:run') }),
  ].join('\n')
}

function failureSpan(facts: BusFacts): string {
  return `<span class="fail"${facts.failure === null ? ' data-none' : ''}>last failure <b>${escaped(facts.failure ?? 'none')}</b></span>`
}

function shownStages(facts: BusFacts): CardsAtStage[] {
  const shown = backlogCards(facts.cards, facts.at, false)
  return CARD_STAGES.map(stage => ({ stage, cards: shown.filter(card => card.stage === stage).map(card => card.id) }))
}

function inProgressOrder(stages: CardsAtStage[]): CardsAtStage[] {
  return PROGRESS_ORDER.flatMap(stage => stages.filter(entry => entry.stage === stage))
}

function flowStages(facts: BusFacts): CardsAtStage[] {
  return inProgressOrder(shownStages(facts))
}

function swatch(stage: CardStage | ReleaseStage, count?: number): string {
  return `<i class="sw" data-stage="${escaped(stage)}"${count === undefined ? '' : ` style="--_n: ${count}" title="${escaped(stage)}: ${count}"`}></i>`
}

function legendRow(entry: CardsAtStage, page: BoardPage): string {
  const ids = SETTLED_STAGES.includes(entry.stage) || entry.cards.length === 0 ? '' : `<span class="ids">${entry.cards.map(card => cardReference(card, page)).join('')}</span>`
  return `<div class="stage"${entry.cards.length === 0 ? ' data-empty' : ''}>${swatch(entry.stage)}<span class="name">${escaped(entry.stage)}</span><span class="n">${entry.cards.length}</span>${ids}</div>`
}

function planBlock(plan: PlanProgress, backlog: number): string {
  const dropped = droppedLine(plan, PLAIN_LORE)
  return [
    `<div class="goal-top"><span class="goal-k">release</span><span class="goal-name">${escaped(planLine(plan, backlog))}</span></div>`,
    `<div class="bar" role="img" aria-label="Release cards by stage">${RELEASE_PROGRESS_ORDER.filter(stage => plan.stages[stage] > 0).map(stage => swatch(stage, plan.stages[stage])).join('')}</div>`,
    dropped === null ? '' : `<div class="goal-dropped">${escaped(dropped)}</div>`,
  ].join('')
}

function goalSlot(facts: BusFacts): string {
  const { goal } = facts
  return goal === null ? '' : goal.plans.map(plan => planBlock(plan, goal.backlog)).join('')
}

function waitText(wait: OwnerWait): string {
  const target = waitTarget(wait)
  return `${wait.id}${target === null ? '' : ` ${target}`} — ${waitAction(wait, PLAIN_LORE)}`
}

function waitItem(wait: OwnerWait, page: BoardPage): string {
  const inner = `<span class="kind">${WAIT_NEEDS[wait.need]}</span><span class="what">${escaped(waitText(wait))}</span>`
  return wait.card !== null && page.details.has(wait.card) ? `<button type="button" class="ask"${opener(cardDialog(wait.card))}>${inner}${OPEN_HINT}</button>` : `<span class="ask" data-static>${inner}</span>`
}

function waitStrip(label: string, items: readonly string[]): string {
  return items.length === 0 ? '' : `<section class="owner-strip bevel" aria-label="${label.charAt(0).toUpperCase()}${label.slice(1)}"><span class="lbl">${label}</span>${items.join('')}</section>`
}

function waitsSlot(page: BoardPage): string {
  const { waits, waitsStale } = page.facts
  return `${waitStrip('waits for you', [...waitsStale === undefined ? [] : [`<button type="button" class="ask" data-pull title="${PULL_TITLE}">${escaped(waitsStale)}<span class="open-hint">re-read now ›</span></button>`], ...waits.filter(wait => !liftedByTheWindow(wait)).map(wait => waitItem(wait, page))])}${waitStrip(WINDOW_WAITS_ROLE, waits.filter(liftedByTheWindow).map(wait => waitItem(wait, page)))}`
}

function warningsSlot(warnings: readonly BoardWarning[]): string {
  const items = warnings.map(warning => `<span class="warning" data-level="${warning.level}">${escaped(warning.text)}</span>`)
  return items.length === 0 ? '' : `<section class="warning-strip bevel" aria-label="Warnings"><span class="lbl">warnings</span>${items.join('')}</section>`
}

function flowSlot(page: BoardPage): string {
  const { facts } = page
  return [
    `<div class="panel-head"><h2 id="h-flow">${PLAIN_LORE.boardTabFlow}</h2><span class="meta">${FLOW_META}</span></div>`,
    '<div class="flow">',
    ...flowStages(facts).map(entry => legendRow(entry, page)),
    `<div class="flow-note"><span>review queue <b>${facts.reviewQueue}</b></span>${failureSpan(facts)}${facts.cardsStale === undefined ? '' : `<span data-static>${escaped(facts.cardsStale)}</span>`}</div>`,
    '</div>',
  ].join('\n')
}

function relation(parts: string[], name: string): string {
  return parts.find(part => part.startsWith(`${name} `))?.slice(name.length + 1).trim() || NONE
}

function cardFields(card: BusCard): string[] {
  const parts = (card.line ?? '').replace(CARD_PREFIX, '').split(' · ')
  const words = parts[0]!.split(' ').filter(word => !word.startsWith('#') && word !== '')
  const tagWord = words.find(word => word.startsWith('['))
  const tags = (tagWord ?? '').replace(/^\[|\]$/g, '').split('/')
  const fields = Array.from({ length: FIELD_COUNT }, (_, at) => tags[at] || NONE)
  return [words.find(word => word !== tagWord) ?? NONE, ...fields, relation(parts, 'depends'), relation(parts, 'blocks')]
}

function cardRowOf(facts: BusFacts, standing: CardStanding): (card: BusCard) => string {
  return (card) => {
    const cells = cardFields(card).map((field, at) => `<td${at === 0 ? ' class="slug"' : ''}>${escaped(field)}</td>`).join('')
    const [stage, why] = [escaped(card.stage), standingLine(card, facts, standing, PLAIN_LORE)]
    return `<tr data-card="${card.id}" data-stage="${stage}"${inLiveView(card, standing) ? ' data-live' : ''}${opener(cardDialog(card.id))}><td class="id">${escaped(markedName(`#${card.id}`, card))}</td>${cells}<td><span class="st" data-stage="${stage}">${stage}</span>${why === null ? '' : `<span class="why">${escaped(why)}</span>`}</td><td>${OPEN_HINT}</td></tr>`
  }
}

function wholeCardsBody(cards: BusCard[], cardRow: (card: BusCard) => string): string[] {
  return cards.length === 0 ? [] : [`<tbody>${byStage(cards).map(cardRow).join('')}</tbody>`]
}

function stagesOf(cards: BusCard[]): string[] {
  const present = new Set(cards.map(card => card.stage))
  return CARD_STAGES.filter(stage => present.has(stage))
}

const COLUMNS = ['card', 'slug', 'kind', 'contour', 'size', 'path', 'gate', 'depends', 'blocks', 'state', '']

function backlogFilters(facts: BusFacts): string[] {
  return [LIVE_FILTER, ...stagesOf(backlogCards(facts.cards, facts.at, true))]
}

function filterTargetIds(facts: BusFacts): string[] {
  return [ALL_FILTER, ...backlogFilters(facts)].map(filterId)
}

function backlogSlot(facts: BusFacts): string {
  const cards = backlogCards(facts.cards, facts.at, true)
  const filters = backlogFilters(facts)
  const chip = (filter: string): string => `<a class="chip" href="#${filterId(filter)}">${escaped(filter)}</a>`
  return [
    `<style>${filters.map(filterRule).join('\n')}</style>`,
    `<div class="panel-head"><h2 id="h-backlog">${PLAIN_LORE.boardTabBacklog}</h2><span class="meta">${counted(cards.length, 'card')} · ordered by state, slices under their task</span></div>`,
    `<nav class="filters" aria-label="Filter by stage">${chip(ALL_FILTER)}${filters.map(chip).join('')}</nav>`,
  ].join('\n')
}

function taskBody(group: ReturnType<typeof taskGroups>[number], cardRow: (card: BusCard) => string): string {
  return `<tbody class="task-group" data-task="${group.task}" data-collapsed><tr class="task"${group.waits.length === 0 ? '' : ' data-waits'}><th colspan="11" scope="rowgroup"><button type="button" class="task-fold" data-fold="${group.task}" aria-expanded="false">${escaped(taskGroupLine(group))}</button></th></tr>${group.slices.map(cardRow).join('')}</tbody>`
}

function rowsSlot(facts: BusFacts, held: ReadonlyMap<number, string> = new Map()): string {
  const cards = backlogCards(facts.cards, facts.at, true)
  const cardRow = cardRowOf(facts, standingOf(facts, held))
  return [
    `<thead><tr>${COLUMNS.map(column => `<th scope="col">${column}</th>`).join('')}</tr></thead>`,
    ...taskGroups(cards, facts.cards, facts.waits).map(group => taskBody(group, cardRow)),
    ...wholeCardsBody(cards.filter(card => card.parent === undefined), cardRow),
  ].join('\n')
}

function backlogPanel(filters: readonly string[], slots: BoardSlots): string {
  return [
    `<section class="panel backlog bevel" id="${BACKLOG}" aria-labelledby="h-backlog">`,
    ...filters.map(id => `<span class="filter-target" id="${id}"></span>`),
    `<div id="${SLOT_PREFIX}backlog">${slots.backlog}</div>`,
    `<div class="scroll" id="${BACKLOG_SCROLL}"><table id="${SLOT_PREFIX}rows">`,
    slots.rows,
    '</table></div></section>',
  ].join('\n')
}

function headerPanel(version: string, slots: BoardSlots): string {
  return [
    '<header class="panel bevel">',
    `<div class="banner-wrap"><pre class="banner" aria-label="MIKOSHI">${escaped(BANNER.replace(/^\n/, ''))}</pre>`,
    `<p class="subtitle">${escaped(LORE.subtitle(version))}</p></div>`,
    `<div class="head-side"><p class="board-title">construct <span>board</span></p><p class="kv" id="${SLOT_PREFIX}kv">${slots.kv}</p></div>`,
    `<div class="goal" id="${SLOT_PREFIX}goal">${slots.goal}</div>`,
    '</header>',
    `<div class="waits" id="${SLOT_PREFIX}waits">${slots.waits}</div>`,
  ].join('\n')
}

function headerReadings(page: BoardPage): string {
  const { facts } = page
  return [
    `<span>model <b>${page.modelVersion === null ? NONE : `v${page.modelVersion}`}</b></span><span>ui <b>${escaped(interfaceVersion(page.version))}</b></span>`,
    `<span>written <b>${escaped(facts.at)}</b></span><span>live <b>${escaped(tallyLine(taskTally(facts.cards.filter(isLive))))}</b></span>`,
    `<span>refresh <b>${page.tickMs === null ? NONE : `${page.tickMs / 1000}s`}</b><i class="countdown" id="${REFRESH_IN}"></i></span>`,
    `<span>load <b><span data-count="${page.machine.load.toFixed(1)}">${page.machine.load.toFixed(1)}</span> / ${page.machine.cores} cores</b></span>`,
    `<span class="live" id="${BUS_LIVE}"${page.liveness === FACTORY_LIVE ? '' : ' data-stale'}>${page.liveness === FACTORY_LIVE ? 'bus live' : OFFLINE_READING}</span>`,
  ].join('')
}

function pulseReading(facts: BusFacts): string {
  const age = pulseAgeMs(facts)
  return age === null ? 'no pulse' : `pulse ${Math.round(age / MINUTE_MS)} min`
}

function statusSlot(facts: BusFacts): string {
  return [
    '<span class="mode">BOARD</span>',
    `<span>subnet <b class="live" id="${PULSE_ELEMENT_ID}"${liveAttribute(facts)}>${pulseReading(facts)}</b></span>`,
    `<span>agents <b>${facts.services.length}</b></span>`,
    `<span>review queue <b>${facts.reviewQueue}</b></span>`,
    failureSpan(facts),
    `<button type="button"${opener(HANDOFF_DIALOG)}><kbd>H</kbd> handoff ›</button>`,
    `<button type="button"${opener(DECISIONS_DIALOG)}><kbd>D</kbd> decisions ›</button>`,
    '<span>geek mode <b>--geek</b></span>',
    `<span class="cursor">${constructCommand('board')}</span>`,
  ].join('')
}

function opener(dialog: string): string {
  return ` data-open="${dialog}" tabindex="0" aria-haspopup="dialog"`
}

function cardDialog(card: number): string {
  return `card-${card}`
}

function cardReference(card: number, page: BoardPage): string {
  return page.details.has(card) ? `<button type="button" class="cid"${opener(cardDialog(card))}>#${card} ›</button>` : `#${card}`
}

function linked(text: string, page: BoardPage): string {
  return escaped(text).replace(CARD_REFERENCE, (_, card: string) => cardReference(Number(card), page)).replace(CODE_SPAN, '<code>$1</code>')
}

type PunchValue = string | number | null | undefined | readonly string[]

function punchField(label: string, value: PunchValue, page: BoardPage, wide = false): string {
  const empty = value === null || value === undefined || value === '' || value === NONE || (Array.isArray(value) && value.length === 0)
  const shown = empty ? NONE : Array.isArray(value) ? value.map(item => `<span class="tag">${linked(item, page)}</span>`).join(' ') : linked(String(value), page)
  return `<div class="pf"${wide ? ' data-wide' : ''}><span class="pf-k">${escaped(label)}</span><span class="pf-v"${empty ? ' data-none' : ''}>${shown}</span></div>`
}

function holes(sha: string): string {
  return [...sha.slice(0, PUNCH_DIGITS)].flatMap(digit => Number.parseInt(digit, 16).toString(2).padStart(4, '0').split('')).map(bit => `<i${bit === '1' ? ' data-on' : ''}></i>`).join('')
}

function punch(label: string, sha: string, fields: string[]): string {
  return `<div class="punch"><span class="punch-label">${escaped(label)}</span><div class="punch-holes" aria-hidden="true">${holes(sha)}</div><div class="punch-grid">${fields.join('')}</div></div>`
}

function divider(name: string): string {
  return `<div class="divider">${name}</div>`
}

function note(html: string): string {
  return `<p class="note">${html}</p>`
}

function paragraphs(text: string, page: BoardPage): string {
  return text.split(/\n\s*\n/).map(part => part.trim()).filter(part => part !== '').map(part => `<p>${linked(part, page)}</p>`).join('')
}

function listed(heading: string, items: readonly string[], page: BoardPage): string {
  return items.length === 0 ? '' : `<h3>${heading}</h3><ul>${items.map(item => `<li>${linked(item, page)}</li>`).join('')}</ul>`
}

function dialogHead(kind: string, id: string, name: string, state: string, idTitle = ''): string {
  return `<div class="drill-head"><span class="drill-kind">${kind}</span><span class="drill-id" id="drill-title"${idTitle}>${escaped(id)}</span><span class="drill-name">${escaped(name)}</span>${state}<form method="dialog"><button class="drill-close" value="close">esc · close</button></form></div>`
}

function cardPunch(card: BusCard, detail: CardDetail, page: BoardPage): string {
  const [slug, kind, contour, size, cardPath, gate, depends, blocks] = cardFields(card)
  const contract = detail.contract
  const fields = [
    punchField('kind', kind, page),
    punchField('contour', contour, page),
    punchField('size', size, page),
    punchField('path', cardPath, page),
    punchField('gate', gate, page),
    punchField('milestone', contract?.milestone, page),
    punchField('decision', contract?.decision, page),
    punchField('who', contract?.who, page),
    punchField('priority', contract?.priority, page),
    punchField('risk', contract?.risk, page),
    punchField('continue', contract?.continue, page),
    punchField('depends', depends, page),
    punchField('blocks', blocks, page),
    punchField('branch', contract?.branch, page, true),
    punchField('card line', contract?.cardLine ?? card.line, page, true),
    punchField('touches', contract?.touches, page, true),
    punchField('creates', contract?.creates, page, true),
    punchField('seam', contract?.seam, page),
    punchField('slice', contract?.slice, page),
    punchField('text_sha', contract?.textSha, page),
    punchField('admission', contract?.admissionEventId, page),
    punchField('last heartbeat', contract?.lastHeartbeat?.ts, page),
  ]
  return punch(`card · ${slug === NONE ? `#${card.id}` : slug}`, contract?.textSha ?? card.id.toString(16).padStart(PUNCH_DIGITS, '0'), fields)
}

function lastWitnessResult(field: WitnessField, record: WitnessRecordOnHead | null): string {
  if (record === null)
    return NOT_RUN_ON_HEAD
  const command = fieldCommand(field).replace(NEGATED_RUN, '')
  return SETTLED_ON_HEAD[record.verdict] ?? ([command, `! ${command}`].some(named => record.detail.includes(`\`${named}\``)) ? RED : NOT_REACHED_ON_HEAD)
}

function witnessRow(field: WitnessField, record: WitnessRecordOnHead | null, page: BoardPage): string {
  const expected = `${escaped(field.head)}/${escaped(field.base)} · last ${lastWitnessResult(field, record)}`
  return `<tr><th scope="row">${escaped(field.id)}</th><td><code>${escaped(field.run)}</code></td><td>${escaped(field.test ?? NONE)}</td><td>${expected}</td><td>${linked(field.proves, page)}</td></tr>`
}

function witnessTableHtml(table: WitnessTable, page: BoardPage): string {
  const head = WITNESS_COLUMNS.map(column => `<th scope="col">${column}</th>`).join('')
  const rows = table.witnesses.map(field => witnessRow(field, table.record, page)).join('')
  return `<h3>Witnesses</h3><div class="mx-wrap"><table class="mx" data-witnesses><thead><tr><th scope="col">${WITNESS_ID_COLUMN}</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
}

function withoutRunsLine(prose: string): string {
  return prose.split('\n').filter(line => !line.trim().startsWith(RUNS_PREFIX)).join('\n')
}

function cardProse(detail: CardDetail, page: BoardPage): string {
  const contract = detail.contract
  if (contract === null)
    return note('The bus holds no admitted card text for this card.')
  const table = detail.witnessTable
  const witnesses = `${table === null ? listed('Witnesses', contract.witnesses, page) : witnessTableHtml(table, page)}${runsHtml(detail.runs, table !== null)}`
  return `<div class="prose">${paragraphs(withoutRunsLine(contract.prose), page)}${witnesses}${listed('Unclear', contract.unclear, page)}</div>`
}

function matrixRows(rows: [string, string][]): string {
  return `<div class="mx-wrap"><table class="mx"><tbody>${rows.map(([key, value]) => `<tr><th scope="row">${escaped(key)}</th><td>${escaped(value)}</td></tr>`).join('')}</tbody></table></div>`
}

function pullLink(pr: number, page: BoardPage): string {
  return page.repository === null ? `PR #${pr}` : `<a data-link href="${escaped(`${page.repository}/pull/${pr}`)}">PR #${pr} ›</a>`
}

function matrixHasData(matrix: BusMatrix): boolean {
  return matrix.killed + matrix.survived + matrix.notRun > 0 || matrix.full !== null
}

function cardMatrix(detail: CardDetail, page: BoardPage): string {
  const matrix: BusMatrix | undefined = page.facts.matrices.find(entry => entry.pr === detail.pr)
  if (matrix === undefined || !matrixHasData(matrix))
    return ''
  const contract = detail.contract
  const check = matrixRows([['pull request', `PR #${matrix.pr}`], ['head', matrix.head ?? NONE], ['killed', String(matrix.killed)], ['survived', String(matrix.survived)], ['not run', String(matrix.notRun)], ['full run', matrix.full ?? NONE]])
  const risk = matrixRows([['risk', contract?.risk ?? NONE], ['seam', contract?.seam.join(', ') || NONE], ['slice', contract?.slice.join(', ') || NONE]])
  return `${divider('matrix')}<div><p class="mx-title">check matrix · ${pullLink(matrix.pr, page)}</p>${check}</div><div><p class="mx-title">risk matrix</p>${risk}</div>`
}

function verdictText(verdict: unknown): string {
  return typeof verdict === 'string' ? verdict : JSON.stringify(verdict) ?? NONE
}

function chainEntries(chain: CardChain): [number, string][] {
  const entries: [number, string][] = chain.versions.map(event => [event, 'card text admitted'])
  if (chain.verdict !== null)
    entries.push([chain.verdict.event, `review recorded · ${verdictText(chain.verdict.verdict)}`])
  if (chain.proof !== null)
    entries.push([chain.proof, 'card verified'])
  return entries.sort((a, b) => a[0] - b[0])
}

function cardChainHtml(card: BusCard, detail: CardDetail): string {
  const command = `<code>${pnpmCommand('card', `${card.id} --chain`)}</code>`
  if (detail.chain === null)
    return note(`No chain: the bus holds no admitted text for this card (${command}).`)
  const entries = chainEntries(detail.chain).map(([event, what]) => `<li><span class="when">event ${event}</span><span class="dot"></span><span class="ev">${escaped(what)}</span></li>`)
  const decisions = detail.chain.decisions.length === 0 ? '' : note(`decisions named: ${escaped(detail.chain.decisions.join(', '))}`)
  return `<ol class="chain">${entries.join('')}</ol>${decisions}${note(`the same fact as ${command}`)}`
}

function cardDialogHtml(card: BusCard, detail: CardDetail, page: BoardPage): string {
  const stage = escaped(card.stage)
  return [
    dialogHead('card', `#${card.id}`, cardFields(card)[0]!, `<span class="st" data-stage="${stage}">${stage}</span>`),
    '<div class="drill-body">',
    cardPunch(card, detail, page),
    divider('prose'),
    cardProse(detail, page),
    cardMatrix(detail, page),
    divider('chain'),
    cardChainHtml(card, detail),
    '</div>',
  ].join('')
}

interface HandoffParts {
  fields: [string, string[]][]
  prose: string[]
}

function handoffParts(text: string): HandoffParts {
  const parts: HandoffParts = { fields: [], prose: [] }
  let field: [string, string[]] | null = null
  for (const line of text.split(/\r?\n/)) {
    const labelled = HANDOFF_LINE.exec(line)
    if (labelled !== null) {
      field = [labelled[1]!, labelled[2] === undefined ? [] : [labelled[2]]]
      parts.fields.push(field)
    }
    else if (field !== null && LIST_ITEM.test(line)) {
      field[1].push(line.replace(LIST_ITEM, ''))
    }
    else if (line.trim() !== '') {
      field = null
      parts.prose.push(line.trim())
    }
  }
  return parts
}

function handoffHead(name: string, state: string): string {
  return dialogHead('handoff', LORE.boardWindowName, name, state, WINDOW_PLAIN_TITLE)
}

function handoffDialogHtml(page: BoardPage): string {
  const name = path.basename(page.handoff.file)
  if (page.handoff.text === null)
    return `${handoffHead(name, '')}<div class="drill-body">${note(`No ${escaped(name)} to read.`)}</div>`
  const { fields, prose } = handoffParts(page.handoff.text)
  const status = statusLineOf(page.handoff.text)?.value
  const punchFields = fields.map(([label, values]) => punchField(label, values.length === 1 ? values[0] : values, page, values.length > 1))
  return [
    handoffHead(name, status === undefined ? '' : `<span class="st">${escaped(status)}</span>`),
    '<div class="drill-body">',
    punch(`handoff · ${name}`, createHash('sha256').update(page.handoff.text).digest('hex'), punchFields),
    divider('prose'),
    prose.length === 0 ? note(`${escaped(name)} carries no prose.`) : `<div class="prose">${prose.map(line => `<p>${linked(line, page)}</p>`).join('')}</div>`,
    '</div>',
  ].join('')
}

function decisionsDialogHtml(page: BoardPage): string {
  const rows = (page.decisions.stale === null ? page.decisions.rows : []).map(decision => `<div><b>D-${decision.decisionId}</b><span>${linked(decision.text, page)}</span></div>`)
  return [
    dialogHead('decisions', 'in force', page.decisions.stale === null ? counted(rows.length, 'owner decision') : staleLine(page.decisions.stale), ''),
    '<div class="drill-body">',
    page.decisions.stale !== null ? note(escaped(staleLine(page.decisions.stale))) : rows.length === 0 ? note('The bus holds no owner decision in force.') : `<div class="dec">${rows.join('')}</div>`,
    '</div>',
  ].join('')
}

function dialogTemplate(dialog: string, html: string): string {
  return `<template id="${DIALOG_PREFIX}${dialog}">${html}</template>`
}

export const VIEW_KEY = 'construct-board:view'

const PAGE_SCRIPT = path.join(import.meta.dirname, 'board-page', 'script.js')
const SCRIPT_NAMES_GLOBAL = 'window.BOARD_NAMES'
const SCRIPT_NAMES = { drill: DRILL, drillContent: DRILL_CONTENT, backlogScroll: BACKLOG_SCROLL, viewKey: VIEW_KEY, dialogPrefix: DIALOG_PREFIX, handoffDialog: HANDOFF_DIALOG, decisionsDialog: DECISIONS_DIALOG, busLive: BUS_LIVE, offlineReading: OFFLINE_READING, pulse: PULSE_ELEMENT_ID, titlePrefix: `${constructCommand('board')} · `, slotPrefix: SLOT_PREFIX, backlog: BACKLOG, filterAttribute: FILTER_ATTRIBUTE, staleTicks: STALE_TICKS, staleReading: STALE_READING, dataFile: BOARD_DATA_FILE, refreshIn: REFRESH_IN, round: { ...ROUND_COLOURS, ...ROUND_LABELS } }
const SCRIPT = `\n${SCRIPT_NAMES_GLOBAL} = ${JSON.stringify(SCRIPT_NAMES)};\n${readFileSync(PAGE_SCRIPT, 'utf8')}`

function dialogsSlot(page: BoardPage): string {
  const cards = page.facts.cards.flatMap((card) => {
    const detail = page.details.get(card.id)
    return detail === undefined ? [] : [dialogTemplate(cardDialog(card.id), cardDialogHtml(card, detail, page))]
  })
  return [
    dialogTemplate(HANDOFF_DIALOG, handoffDialogHtml(page)),
    dialogTemplate(DECISIONS_DIALOG, decisionsDialogHtml(page)),
    ...cards,
  ].join('\n')
}

function dialogs(slots: BoardSlots): string {
  return [
    `<dialog class="drill bevel" id="${DRILL}" aria-labelledby="drill-title"><div class="drill-wrap" id="${DRILL_CONTENT}"></div></dialog>`,
    `<div id="${SLOT_PREFIX}dialogs" hidden>${slots.dialogs}</div>`,
    `<script>${SCRIPT}</script>`,
  ].join('\n')
}

const STYLE = `\n${readFileSync(path.join(import.meta.dirname, 'board-page', 'style.css'), 'utf8')}`

export interface BoardSlots {
  warnings: string
  kv: string
  goal: string
  waits: string
  services: string
  flow: string
  backlog: string
  rows: string
  status: string
  dialogs: string
}

const EMPTY_SLOTS: BoardSlots = { warnings: '', kv: '', goal: '', waits: '', services: '', flow: '', backlog: '', rows: '', status: '', dialogs: '' }

export interface BoardData {
  written: string
  tickMs: number | null
  pulse: string | null
  waits: OwnerWait[]
  slots: BoardSlots
  filters: string[]
}

export function boardData(page: BoardPage): BoardData {
  return {
    written: page.facts.at,
    tickMs: page.tickMs,
    pulse: page.facts.pulse,
    waits: page.facts.waits,
    slots: {
      kv: headerReadings(page),
      goal: goalSlot(page.facts),
      waits: waitsSlot(page),
      warnings: warningsSlot(page.warnings),
      services: servicesSlot(page),
      flow: flowSlot(page),
      backlog: backlogSlot(page.facts),
      rows: rowsSlot(page.facts, page.held),
      status: statusSlot(page.facts),
      dialogs: dialogsSlot(page),
    },
    filters: filterTargetIds(page.facts),
  }
}

export function boardDataScript(data: BoardData): string {
  return `${BOARD_DATA_PREFIX}${JSON.stringify(data)}\n`
}

export interface BoardSnapshot {
  written: string
  tickMs: number | null
  pulse: string | null
  waits: OwnerWait[]
}

export function readSnapshot(file: string): BoardSnapshot | null {
  try {
    const text = readFileSync(file, 'utf8')
    if (!text.startsWith(BOARD_DATA_PREFIX))
      return null
    const data = JSON.parse(text.slice(BOARD_DATA_PREFIX.length)) as Partial<BoardData> | null
    if (typeof data?.written !== 'string')
      return null
    return { written: data.written, tickMs: positive(data.tickMs), pulse: typeof data.pulse === 'string' ? data.pulse : null, waits: Array.isArray(data.waits) ? data.waits : [] }
  }
  catch {
    return null
  }
}

export interface BusDown {
  at: string
  stoppedAt: string | null
  error: string
  snapshot: BoardSnapshot | null
  handoffStatus: string | null
}

function snapshotAgeMs(down: BusDown): number | null {
  return down.snapshot === null ? null : Math.max(0, Date.parse(down.at) - Date.parse(down.snapshot.written))
}

function snapshotStale(down: BusDown): boolean {
  const age = snapshotAgeMs(down)
  const tick = down.snapshot?.tickMs ?? null
  return age === null || tick === null || age > STALE_TICKS * tick
}

function ownerStatus(handoff: Handoff): string | null {
  if (handoff.text === null)
    return null
  const status = statusLineOf(handoff.text)
  return status?.status === 'OWNER' ? status.value : null
}

export function busDownOf(now: Date, error: string, snapshotFile: string, handoff: Handoff): BusDown {
  const snapshot = readSnapshot(snapshotFile)
  return { at: now.toISOString(), stoppedAt: snapshot?.pulse ?? snapshot?.written ?? null, error, snapshot, handoffStatus: ownerStatus(handoff) }
}

export function busDownLine(down: BusDown): string {
  return `the bus stopped at ${down.stoppedAt ?? 'an unknown time'}: ${down.error}`
}

function snapshotLine(down: BusDown): string {
  const age = snapshotAgeMs(down)
  return down.snapshot === null || age === null ? 'no board snapshot to read' : `snapshot written ${down.snapshot.written} · age ${Math.round(age / MINUTE_MS)} min`
}

function busDownWaits(down: BusDown): string {
  const items = [
    ...(down.snapshot?.waits ?? []).map(wait => `<span class="ask" data-static><span class="kind">${WAIT_NEEDS[wait.need] ?? '?'}</span><span class="what">${escaped(waitText(wait))}</span></span>`),
    ...(down.handoffStatus === null ? [] : [`<span class="ask" data-static><span class="kind">H</span><span class="what">${escaped(`handoff STATUS: ${down.handoffStatus}`)}</span></span>`]),
  ]
  return items.length === 0 ? note('No open owner wait in the last snapshot or the handoff.') : waitStrip('waits for you', items)
}

function pageHead(title: string, body: string): string[] {
  return ['<!doctype html>', '<html lang="en"><head><meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', `<title>${constructCommand('board')} · ${title}</title>`, `<style>${STYLE}</style></head>${body}`]
}

export function renderBusDown(down: BusDown): string {
  return [
    ...pageHead('bus stopped', '<body>'),
    `<section class="panel bevel" role="alert" aria-labelledby="h-bus-down"><div class="panel-head"><h2 id="h-bus-down">bus stopped</h2></div>`,
    `<div class="down"><p class="fail">${escaped(busDownLine(down))}</p><p><span class="live" data-snapshot${snapshotStale(down) ? ' data-stale' : ''}>${escaped(snapshotLine(down))}</span></p></div></section>`,
    busDownWaits(down),
    '</body></html>',
    '',
  ].join('\n')
}

export function busDownJson(down: BusDown): string {
  return `${JSON.stringify({ status: 'stopped', at: down.at, line: busDownLine(down), stoppedAt: down.stoppedAt, error: down.error, snapshot: down.snapshot === null ? null : { written: down.snapshot.written, ageMs: snapshotAgeMs(down), stale: snapshotStale(down) }, waits: down.snapshot?.waits ?? [], handoffStatus: down.handoffStatus }, null, 2)}\n`
}

export function busDownText(down: BusDown): string {
  const waits = [...(down.snapshot?.waits ?? []).map(wait => `${WAIT_NEEDS[wait.need] ?? '?'} ${waitText(wait)}`), ...(down.handoffStatus === null ? [] : [`handoff STATUS: ${down.handoffStatus}`])]
  return `${[busDownLine(down), snapshotLine(down), ...(waits.length === 0 ? ['no open owner wait in the last snapshot or the handoff'] : waits.map(wait => `waits for you: ${wait}`))].join('\n')}\n`
}

export function busJson(db: DatabaseSync, now: Date, liveOnly = false): string {
  const facts = busFacts(db, now)
  const prs = cardPrs(db)
  const events = latestCardEvents(db, EVENTS_PER_CARD)
  return `${JSON.stringify({ status: 'live', at: facts.at, pulse: facts.pulse, waits: facts.waits, waitsStale: facts.waitsStale ?? null, cardsStale: facts.cardsStale ?? null, tally: taskTally(facts.cards.filter(isLive)), cards: (liveOnly ? facts.cards.filter(isLive) : facts.cards).map(card => ({ id: card.id, stage: card.stage, state: card.state, pr: prs.get(card.id) ?? null, line: card.line, parent: card.parent ?? null, mark: sliceMark(card), events: events.get(card.id) ?? [] })), tasks: openTasks(db) }, null, 2)}\n`
}

export function renderBoard(page: BoardPage): string {
  const { slots, filters } = boardData(page)
  return pageHtml(page.version, page.facts.at, page.tickMs, slots, filters)
}

export function renderShell(version: string, tickMs: number | null): string {
  return pageHtml(version, '', tickMs, EMPTY_SLOTS, [])
}

function pageHtml(version: string, written: string, tickMs: number | null, slots: BoardSlots, filters: readonly string[]): string {
  return [
    ...pageHead(escaped(written), `<body data-written="${escaped(written)}" data-tick-ms="${tickMs ?? ''}">`),
    headerPanel(version, slots),
    `<div class="warnings" id="${SLOT_PREFIX}warnings">${slots.warnings}</div>`,
    `<section class="panel bevel" id="${SLOT_PREFIX}services" aria-labelledby="h-services">\n${slots.services}\n</section>`,
    '<div class="split">',
    `<section class="panel bevel" id="${SLOT_PREFIX}flow" aria-labelledby="h-flow">\n${slots.flow}\n</section>`,
    backlogPanel(filters, slots),
    '</div>',
    `<footer class="statusline" id="${SLOT_PREFIX}status">${slots.status}</footer>`,
    dialogs(slots),
    '</body></html>',
    '',
  ].join('\n')
}

function contextWarnings(contexts: readonly SessionContext[], limits: EddiesLimits, facts: Pick<BusFacts, 'cards'>): BoardWarning[] {
  const quiet = { openPrs: 0, openPrLimit: null, ownerWaits: 0, stalls: [], savingOff: false }
  return contexts.flatMap(session => boardWarnings({ ...quiet, ...(session.who === WINDOW_ROLE ? limits : cardLineOf(limits, session.who, facts)), contexts: [session] }))
}

function boardPageOf(db: DatabaseSync, busPath: string, now: Date, handoffFile: string, tickMs: number | null, main: MainUpToDate, eddiesFile: string = EDDIES_FILE, live = false): BoardPage {
  const all = busFacts(db, now)
  const facts = live ? { ...all, cards: liveCardsOf(all.cards, all.at) } : all
  const liveness = factoryLiveness(busPath, now.getTime()).state
  const sources: GaugeSources = { windowGauges: projectedWindowGauges(db) }
  const limits = readEddiesLimits(eddiesFile)
  return {
    version: currentVersion(),
    machine: machineLoad(),
    liveness: facts.services.some(service => service.role !== WINDOW_ROLE && service.session !== undefined) ? FACTORY_LIVE : liveness,
    modelVersion: readModelVersion(),
    facts,
    ...sources,
    limits,
    warnings: [
      ...contextWarnings(sessionContexts(facts.services, sources, liveness), limits, facts),
      ...boardWarnings({
        ...limits,
        contexts: [],
        openPrs: openPrCountOf(db),
        openPrLimit: openPrLimitOf(process.env),
        ownerWaits: facts.waits.length,
        stalls: [...stallLines(db, facts.pulse, now), ...plannedStallLines(db, now)],
        savingOff: savingOff(process.env, main),
        stalePasses: stalePassCountOf(db),
      }),
    ],
    details: cardDetails(db, facts),
    sessions: sessionViewsOf(db, facts),
    decisions: currentDecisions(db),
    handoff: readHandoff(handoffFile),
    repository: readRepositoryUrl(),
    tickMs,
    snapshot: readSnapshot(path.join(path.dirname(busPath), BOARD_DATA_FILE)),
    held: ownerHoldsOf(db),
  }
}

function ownerHoldsOf(db: DatabaseSync): Map<number, string> {
  const read = new BusRead(db)
  return ownerHolds(read.slice(CARD_HELD, ['reason', 'takeover']), read.slice(CARD_RELEASED, ['takeover']))
}

export function writeBoardPage(file: string, html: string, files: BoardFiles = DISK_FILES): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  files.write(temporary, html)
  files.rename(temporary, file)
}

function writtenPage(file: string, html: string): string {
  writeBoardPage(file, html)
  return file
}

export type BoardFormat = 'html' | 'json' | 'text'

export function boardFormatOf(args: readonly string[]): BoardFormat {
  return FORMAT_FLAGS.find(([flag]) => args.includes(flag))?.[1] ?? 'text'
}

function mainUpToDateOfThisRepository(): MainUpToDate {
  return new MainUpToDate(ghApi(process.cwd()), Date.now)
}

function boardText(busPath: string, now: Date, handoffFile: string, format: BoardFormat, eddiesFile: string, liveOnly: boolean): string {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    if (format !== 'html')
      return format === 'json' ? busJson(db, now, liveOnly) : `${screenLines(busFacts(db, now), PLAIN_LORE, false, ownerHoldsOf(db)).join('\n')}\n`
    return renderBoard(boardPageOf(db, busPath, now, handoffFile, null, mainUpToDateOfThisRepository(), eddiesFile))
  }
  finally {
    db.close()
  }
}

export function printBoard(busPath: string, now: Date, write: (text: string) => void, handoffFile: string = HANDOFF_FILE, format: BoardFormat = 'text', eddiesFile: string = EDDIES_FILE, liveOnly = false): number {
  let text: string
  try {
    text = boardText(busPath, now, handoffFile, format, eddiesFile, liveOnly)
  }
  catch (error) {
    const down = busDownOf(now, error instanceof Error ? error.message.split('\n')[0]! : String(error), path.join(path.dirname(busPath), BOARD_DATA_FILE), readHandoff(handoffFile))
    write({ html: renderBusDown, json: busDownJson, text: busDownText }[format](down))
    return 1
  }
  write(text)
  return 0
}

export function exportedPlan(db: DatabaseSync, release: string, now: Date): string | null {
  const goal = goalOf(db, now)
  const plan = goal?.plans.find(open => open.id === release)
  if (goal === null || goal === undefined || plan === undefined)
    return null
  const sections = EXPORT_ORDER.map(mark => ({ heading: MARK_WORDS[mark], cards: plan.cards.filter(card => card.mark === mark).map(card => card.card) }))
  return planMarkdown(db, { title: plan.title, goal: plan.goal, line: planLine(plan, goal.backlog), sections })
}

export function printPlan(busPath: string, release: string, now: Date, write: (text: string) => void): number {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const text = exportedPlan(db, release, now)
    if (text === null) {
      console.error(`${PREFIX}release ${release} is not open in the bus`)
      return 1
    }
    write(text)
    return 0
  }
  finally {
    db.close()
  }
}

export function runBoardCli(busPath: string = defaultBusPath(), args: readonly string[] = process.argv.slice(2)): number {
  if (!existsSync(busPath)) {
    console.error(`${PREFIX}no bus database at ${busPath}`)
    return 1
  }
  if (args.includes(PLAN_FLAG)) {
    const release = args[args.indexOf(PLAN_FLAG) + 1]
    if (release === undefined) {
      console.error(`${PREFIX}${PLAN_FLAG} takes the id of an open release`)
      return 2
    }
    return printPlan(busPath, release, new Date(), text => process.stdout.write(text))
  }
  const history = path.join(path.dirname(busPath), BOARD_HISTORY_FILE)
  if (args.includes(ALL_FLAG))
    return printBoard(busPath, new Date(), html => process.stdout.write(`${writtenPage(history, html)}\n`), HANDOFF_FILE, 'html')
  return printBoard(busPath, new Date(), text => process.stdout.write(text), HANDOFF_FILE, boardFormatOf(args), EDDIES_FILE, args.includes('--live'))
}

export interface BoardProjection {
  file: string
  dataFile: string
  project: (now: Date) => void
}

export function boardProjection(db: DatabaseSync, busPath: string, tickMs: number, files: BoardFiles = DISK_FILES, handoffFile: string = HANDOFF_FILE, main: MainUpToDate = mainUpToDateOfThisRepository()): BoardProjection {
  const file = path.join(path.dirname(busPath), BOARD_FILE)
  const dataFile = path.join(path.dirname(busPath), BOARD_DATA_FILE)
  let shell = existsSync(file) ? readFileSync(file, 'utf8') : null
  return {
    file,
    dataFile,
    project: (now) => {
      try {
        const page = boardPageOf(db, busPath, now, handoffFile, tickMs, main, EDDIES_FILE, true)
        writeBoardPage(dataFile, boardDataScript(boardData(page)), files)
        const next = renderShell(page.version, tickMs)
        if (next !== shell) {
          writeBoardPage(file, next, files)
          shell = next
        }
      }
      catch (error) {
        console.error(`${PREFIX}${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    },
  }
}

export const BOARD_PERIOD_MS = 10_000
export const BOARD_TIMER_PREFIX = '[bus:board-timer] '
export const BOARD_TIMER_BUS_PATH = 'boardTimerBusPath'
export const BOARD_TIMER_PERIOD = 'boardTimerPeriodMs'
const BOARD_TIMER_ENTRY = new URL('./board-page/timer.ts', import.meta.url)

export interface ReadOnlyBoard {
  projection: BoardProjection
  close: () => void
}

export function readOnlyBoardProjection(busPath: string, periodMs: number): ReadOnlyBoard {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  return { projection: boardProjection(db, busPath, periodMs), close: () => db.close() }
}

export interface StartedBoardTimer {
  file: string
  dataFile: string
  stop: () => Promise<void>
}

export type BoardTimerSpawn = (entry: URL, workerData: Record<string, unknown>) => { on: (event: 'error', listener: (error: Error) => void) => unknown, terminate: () => Promise<unknown> }

export function startBoardTimer(busPath: string, periodMs: number = BOARD_PERIOD_MS, spawn: BoardTimerSpawn = (entry, workerData) => new Worker(entry, { workerData })): StartedBoardTimer {
  const worker = spawn(BOARD_TIMER_ENTRY, { [BOARD_TIMER_BUS_PATH]: busPath, [BOARD_TIMER_PERIOD]: periodMs })
  worker.on('error', error => console.error(`${BOARD_TIMER_PREFIX}${error.message.split('\n')[0]}`))
  return {
    file: path.join(path.dirname(busPath), BOARD_FILE),
    dataFile: path.join(path.dirname(busPath), BOARD_DATA_FILE),
    stop: async () => void await worker.terminate(),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runBoardCli()
