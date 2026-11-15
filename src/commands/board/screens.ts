import type { Lore } from '../../ui/lore.js'
import type { BusCard, BusFacts, BusGroup, BusMatrix, BusTail, OwnerWait } from './bus.js'
import { ADMIT_COMMAND, pnpmCommand } from '../../../scripts/core/owner-commands.js'
import { FLOW_STAGES, LIVE_STAGES, LIVE_STATES, SHORT_SHA } from './bus.js'
import { planLine } from './goal.js'

const CARD_PREFIX = /^card:\s*/
const MATRIX_ROLE = 'matrix'
const GROUP_ROLE = 'group'
const SHADOW_ROLE = 'shadow'
const TAIL_ROLE = 'tail'
const BUS_ROLE = 'bus'
const WAITS_ROLE = 'waits for you'
export const WINDOW_WAITS_ROLE = 'waits for the window'
const CARDS_ROLE = 'cards'
const MINUTE_MS = 60_000
export const ENDED_SHOWN_HOURS = 12
const HOUR_MS = 3_600_000
const BAR_CELLS = 10
const BAR_DONE = '\u2588'
const BAR_LEFT = '\u2591'
const MERGE_COMMAND = 'gh pr merge'
const DECISION_COMMAND = pnpmCommand('decisions:add')
const OWNER_DECISION = '[owner] <decision>'
const REQUEST_SCRIPT = 'bus:request'
const WINDOW_COMMANDS = [pnpmCommand('intake'), pnpmCommand(REQUEST_SCRIPT)].map(head => `${head} `)

export type HintRunner = 'window' | 'owner'

export interface Hint {
  who: HintRunner
  command: string
}

export const REGISTER_PLAN_HINT: Hint = { who: 'window', command: pnpmCommand(REQUEST_SCRIPT, 'plan', '--op', 'open', '--plan', '<id>', '--title', '<text>', '--goal', '<text>', '--file', '<absolute plan file>') }
export const ADMIT_CARD_HINT: Hint = { who: 'window', command: `${ADMIT_COMMAND} <parking>/<lane>/<N>.md` }

const SLICE_MARK = '◧'
const CARD_NOUN = 'card'
const TASK_NOUN = 'task'
const NO_LANE = 'no lane'

export interface TaskTally {
  cards: number
  tasks: number
}

export interface TaskGroup {
  task: number
  of: number
  merged: number
  slices: BusCard[]
  waits: OwnerWait[]
}

export function sliceMark(card: BusCard): string | null {
  return card.parent === undefined ? null : `${SLICE_MARK} ${card.parent.part}/${card.parent.of} · of #${card.parent.card}`
}

function slicesOf(task: number, cards: readonly BusCard[]): BusCard[] {
  return cards.filter(card => card.parent?.card === task)
}

export function taskGroups(shown: readonly BusCard[], every: readonly BusCard[], waits: readonly OwnerWait[]): TaskGroup[] {
  const tasks = [...new Set(shown.flatMap(card => card.parent === undefined ? [] : [card.parent.card]))].sort((a, b) => a - b)
  return tasks.map((task) => {
    const all = slicesOf(task, every)
    const members = new Set([task, ...all.map(card => card.id)])
    return {
      task,
      of: Math.max(...all.map(card => card.parent!.of)),
      merged: all.filter(card => card.stage === 'merged').length,
      slices: slicesOf(task, shown).sort((a, b) => a.parent!.part - b.parent!.part || a.id - b.id),
      waits: waits.filter(wait => !liftedByTheWindow(wait) && wait.card !== null && members.has(wait.card)),
    }
  })
}

export function taskGroupLine(group: TaskGroup): string {
  const waits = group.waits.map(wait => `${wait.id} ${wait.need}${wait.card === null ? '' : ` #${wait.card}`}`)
  return `${TASK_NOUN} #${group.task} · slices merged ${group.merged} of ${group.of}${waits.length === 0 ? '' : ` · ${WAITS_ROLE}: ${waits.join(', ')}`}`
}

export function sliceRowName(card: BusCard): string {
  return `${cardName(card)} · ${card.lane ?? NO_LANE}`
}

export function markedName(name: string, card: BusCard): string {
  const mark = sliceMark(card)
  return mark === null ? name : `${name} ${mark}`
}

export function taskTally(cards: readonly BusCard[]): TaskTally {
  return { cards: cards.length, tasks: new Set(cards.map(card => card.parent?.card ?? card.id)).size }
}

export function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function tallyLine(tally: TaskTally): string {
  return `${counted(tally.cards, CARD_NOUN)} = ${counted(tally.tasks, TASK_NOUN)}`
}

function cardName(card: BusCard): string {
  return markedName(card.line === null ? `#${card.id}` : card.line.replace(CARD_PREFIX, ''), card)
}

function flowName(card: BusCard): string {
  return markedName(`#${card.id}`, card)
}

function tallyLines(cards: BusCard[]): string[] {
  const live = cards.filter(isLive)
  return live.length === 0 ? [] : [tallyLine(taskTally(live))]
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

export function backlogLines(cards: BusCard[], lore: Lore, every: readonly BusCard[] = cards, waits: readonly OwnerWait[] = []): string[] {
  const groups = taskGroups(cards, every, waits).flatMap(group => [taskGroupLine(group), ...group.slices.map(card => lore.boardBacklogRow(sliceRowName(card), card.stage))])
  const whole = cards.filter(card => card.parent === undefined)
  return [...groups, ...laneColumns(whole).flatMap((lane) => {
    const inLane = whole.filter(card => card.lane === lane)
    return [lore.boardLaneLine(lane ?? undefined, inLane.length), ...inLane.map(card => lore.boardBacklogRow(cardName(card), card.stage))]
  })]
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

function groupStep(group: BusGroup): string {
  const modules = group.modules.length === 0 ? 'no declared module' : `modules ${group.modules.join(', ')}`
  return `${modules} \u00B7 ${group.turn === null ? 'no turn: every member parked or unordered' : `turn PR #${group.turn}`}`
}

export function groupLines(facts: BusFacts, lore: Lore): string[] {
  if (facts.groups === undefined || facts.groups.length === 0)
    return []
  const groups = facts.groups.map(group => lore.boardServiceLine(GROUP_ROLE, group.prs.map(pr => `PR #${pr}`).join(' '), undefined, groupStep(group)))
  const shadow = facts.shadow === undefined ? [] : [lore.boardServiceLine(SHADOW_ROLE, 'order', undefined, `needsUpdate counted ${facts.shadow.needsUpdate} \u00B7 needsVerification counted ${facts.shadow.needsVerification} \u00B7 nothing acts on them yet`)]
  return [...groups, ...shadow]
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
  return { who: wait.lifter === 'window' || WINDOW_COMMANDS.some(prefix => command.startsWith(prefix)) ? 'window' : 'owner', command }
}

export function liftedByTheWindow(wait: OwnerWait): boolean {
  return wait.lifter === 'window'
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
  const owners = facts.waits.filter(wait => !liftedByTheWindow(wait))
  const windows = facts.waits.filter(liftedByTheWindow)
  const parts = [...facts.waitsStale === undefined ? [] : [facts.waitsStale], ...owners.map(wait => waitName(wait, lore))]
  const ownerLine = parts.length === 0 ? [] : [lore.boardServiceLine(WAITS_ROLE, `${owners.length}`, undefined, parts.join(' \u00B7 '))]
  return windows.length === 0 ? ownerLine : [...ownerLine, lore.boardServiceLine(WINDOW_WAITS_ROLE, `${windows.length}`, undefined, windows.map(wait => waitName(wait, lore)).join(' \u00B7 '))]
}

function tailStep(tail: BusTail): string {
  const at = tail.head === null ? '' : ` @ ${tail.head.slice(0, SHORT_SHA)}`
  return `marked drip, not counted in the verdict${tail.pr === null ? '' : ` of PR #${tail.pr}`}${at} · ${tail.finding}`
}

export function tailLines(facts: BusFacts, lore: Lore, all = false): string[] {
  const shown = new Set(backlogCards(facts.cards, facts.at, all).map(card => card.id))
  return (facts.tails ?? []).filter(tail => shown.has(tail.card)).map(tail => lore.boardServiceLine(TAIL_ROLE, `#${tail.card}`, undefined, tailStep(tail)))
}

function behindCardsLines(facts: BusFacts, lore: Lore): string[] {
  return facts.cardsStale === undefined ? [] : [lore.boardServiceLine(CARDS_ROLE, `${facts.cards.length}`, undefined, facts.cardsStale)]
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
      { title: lore.boardTabFlow, lines: [...goalLines(facts, lore), ...waitsLines(facts, lore), ...tailLines(facts, lore, all), ...behindCardsLines(facts, lore), ...tallyLines(facts.cards), ...flowLines(facts.cards, lore), ...flowHintLines(facts.cards, lore)] },
      { title: lore.boardTabBacklog, lines: [...behindCardsLines(facts, lore), ...backlogLines(backlogCards(facts.cards, facts.at, all), lore, facts.cards, facts.waits)] },
      { title: lore.boardTabServices, lines: [...servicesLines(facts, lore), ...pulseLines(facts, lore), ...matrixLines(facts, lore), ...groupLines(facts, lore)] },
    ],
    footer: lore.boardFooter(facts.services.length, facts.failure ?? undefined, facts.reviewQueue),
  }
}

export function screenLines(facts: BusFacts, lore: Lore, all = false): string[] {
  const { screens, footer } = boardScreens(facts, lore, all)
  return [...screens.flatMap(screen => [screen.title, ...screen.lines]), footer]
}
