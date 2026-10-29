import type { Lore } from '../../ui/lore.js'
import type { BusCard, BusFacts, BusMatrix, OwnerWait } from './bus.js'
import { FLOW_STAGES, LIVE_STAGES, LIVE_STATES, SHORT_SHA } from './bus.js'
import { planLine } from './goal.js'

const CARD_PREFIX = /^card:\s*/
const MATRIX_ROLE = 'matrix'
const BUS_ROLE = 'bus'
const WAITS_ROLE = 'waits for you'
const MINUTE_MS = 60_000
export const ENDED_SHOWN_HOURS = 12
const HOUR_MS = 3_600_000
const BAR_CELLS = 10
const BAR_DONE = '\u2588'
const BAR_LEFT = '\u2591'
const MERGE_COMMAND = 'gh pr merge'
const DECISION_COMMAND = 'pnpm decisions:add'
const OWNER_DECISION = '[owner] <decision>'
const WINDOW_COMMANDS = ['pnpm intake ', 'pnpm bus:request ']

export type HintRunner = 'window' | 'owner'

export interface Hint {
  who: HintRunner
  command: string
}

export const REGISTER_PLAN_HINT: Hint = { who: 'window', command: 'pnpm bus:request plan --op open --plan <id> --title <text> --goal <text> --file <absolute plan file>' }
export const ADMIT_CARD_HINT: Hint = { who: 'window', command: 'pnpm intake --admit <parking>/<lane>/<N>.md' }

function cardName(card: BusCard): string {
  return card.line === null ? `#${card.id}` : card.line.replace(CARD_PREFIX, '')
}

function flowName(card: BusCard): string {
  return `#${card.id}`
}

export function isLive(card: BusCard): boolean {
  return card.body && !card.closed && LIVE_STAGES.includes(card.stage) && LIVE_STATES.includes(card.state ?? '')
}

function endedRecently(card: BusCard, at: string): boolean {
  const endedAt = card.closed ? card.closedAt : isLive(card) ? null : card.since
  if (endedAt === null)
    return false
  const age = Date.parse(at) - Date.parse(endedAt)
  return !Number.isNaN(age) && age <= ENDED_SHOWN_HOURS * HOUR_MS
}

export function flowLines(cards: BusCard[], lore: Lore): string[] {
  const live = cards.filter(isLive)
  return lore.boardFlowColumns.map((title, column) => lore.boardColumnLine(title, live.filter(card => FLOW_STAGES[column]!.includes(card.stage)).map(flowName)))
}

export function laneColumns(cards: BusCard[]): (string | null)[] {
  const named = [...new Set(cards.flatMap(card => card.lane === null ? [] : [card.lane]))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return cards.some(card => card.lane === null) ? [...named, null] : named
}

export function backlogCards(cards: BusCard[], at: string, all: boolean): BusCard[] {
  return all ? cards : cards.filter(card => isLive(card) || endedRecently(card, at))
}

export function backlogLines(cards: BusCard[], lore: Lore): string[] {
  return laneColumns(cards).flatMap((lane) => {
    const inLane = cards.filter(card => card.lane === lane)
    return [lore.boardLaneLine(lane ?? undefined, inLane.length), ...inLane.map(card => lore.boardBacklogRow(cardName(card), card.stage))]
  })
}

export function servicesLines(facts: BusFacts, lore: Lore): string[] {
  if (facts.services.length === 0)
    return [lore.boardNoServices]
  return facts.services.map(service => lore.boardServiceLine(service.role, service.task, service.tree ?? undefined, service.step))
}

function matrixStep(matrix: BusMatrix): string {
  const counts = matrix.full === null ? `killed ${matrix.killed} \u00B7 survived ${matrix.survived} \u00B7 not run ${matrix.notRun}` : `full run: ${matrix.full}`
  return matrix.head === null ? counts : `${counts} @ ${matrix.head.slice(0, SHORT_SHA)}`
}

export function matrixLines(facts: BusFacts, lore: Lore): string[] {
  return facts.matrices.map(matrix => lore.boardServiceLine(MATRIX_ROLE, `PR #${matrix.pr}`, undefined, matrixStep(matrix)))
}

function minutesSince(ts: string, at: string): number {
  return Math.max(0, Math.round((Date.parse(at) - Date.parse(ts)) / MINUTE_MS))
}

export function slotsReading(facts: BusFacts): string {
  return facts.slots.length === 0 ? 'none in use' : facts.slots.map(slot => `${slot.queue} ${slot.used}${slot.total === null ? '' : `/${slot.total}`}`).join(', ')
}

export function pulseLines(facts: BusFacts, lore: Lore): string[] {
  const pulse = facts.pulse === null ? 'no pulse recorded' : `pulse ${minutesSince(facts.pulse, facts.at)} min ago`
  return [lore.boardServiceLine(BUS_ROLE, 'pulse', undefined, `${pulse} \u00B7 slots in use: ${slotsReading(facts)}`)]
}

export function progressBar(delivered: number, total: number): string {
  const filled = total === 0 ? 0 : Math.round(Math.min(delivered, total) / total * BAR_CELLS)
  return `[${BAR_DONE.repeat(filled)}${BAR_LEFT.repeat(BAR_CELLS - filled)}]`
}

export function hintLine(hint: Hint, lore: Lore): string {
  return lore.boardHint(hint.who, hint.command)
}

export function planHint(facts: BusFacts): Hint | null {
  return facts.goal === null && facts.cards.some(isLive) ? REGISTER_PLAN_HINT : null
}

export function goalLines(facts: BusFacts, lore: Lore): string[] {
  const { goal } = facts
  const hint = planHint(facts)
  if (hint !== null)
    return [lore.boardNoPlan(hintLine(hint, lore))]
  return goal === null ? [] : goal.plans.map(plan => `${progressBar(plan.delivered, plan.total)} ${planLine(plan, goal.backlog)}`)
}

function impliedCommand(wait: OwnerWait): string {
  if (wait.need === 'merge' && wait.pr !== null)
    return `${MERGE_COMMAND} ${wait.pr}`
  return wait.card === null ? `${DECISION_COMMAND} "${OWNER_DECISION}"` : `${DECISION_COMMAND} --card #${wait.card} "${OWNER_DECISION}"`
}

export function waitHint(wait: OwnerWait): Hint {
  const command = wait.command ?? impliedCommand(wait)
  return { who: WINDOW_COMMANDS.some(prefix => command.startsWith(prefix)) ? 'window' : 'owner', command }
}

export function waitTarget(wait: OwnerWait): string | null {
  if (wait.pr !== null)
    return `PR #${wait.pr}`
  return wait.card === null ? null : `#${wait.card}`
}

export function waitAction(wait: OwnerWait, lore: Lore): string {
  return `${wait.text} \u00B7 ${hintLine(waitHint(wait), lore)}`
}

function waitName(wait: OwnerWait, lore: Lore): string {
  const target = waitTarget(wait)
  return `${wait.id} ${wait.need}${target === null ? '' : ` ${target}`} (${waitAction(wait, lore)})`
}

export function waitsLines(facts: BusFacts, lore: Lore): string[] {
  return facts.waits.length === 0 ? [] : [lore.boardServiceLine(WAITS_ROLE, `${facts.waits.length}`, undefined, facts.waits.map(wait => waitName(wait, lore)).join(' \u00B7 '))]
}

export function flowHintLines(cards: BusCard[], lore: Lore): string[] {
  return cards.some(isLive) ? [] : [lore.boardFlowEmpty(hintLine(ADMIT_CARD_HINT, lore))]
}

export interface Screen {
  title: string
  lines: string[]
}

export interface Screens {
  screens: Screen[]
  footer: string
}

export function boardScreens(facts: BusFacts, lore: Lore, all = false): Screens {
  return {
    screens: [
      { title: lore.boardTabFlow, lines: [...goalLines(facts, lore), ...waitsLines(facts, lore), ...flowLines(facts.cards, lore), ...flowHintLines(facts.cards, lore)] },
      { title: lore.boardTabBacklog, lines: backlogLines(backlogCards(facts.cards, facts.at, all), lore) },
      { title: lore.boardTabServices, lines: [...servicesLines(facts, lore), ...pulseLines(facts, lore), ...matrixLines(facts, lore)] },
    ],
    footer: lore.boardFooter(facts.services.length, facts.failure ?? undefined, facts.reviewQueue),
  }
}

export function screenLines(facts: BusFacts, lore: Lore, all = false): string[] {
  const { screens, footer } = boardScreens(facts, lore, all)
  return [...screens.flatMap(screen => [screen.title, ...screen.lines]), footer]
}
