import type { BusCardStates } from '../../card/closed.js'
import { TASK_FILE } from '../../card/task-file.js'

const TAKEN_TOKEN = /^#?(\d+)$/

export type CardsOfTheBus = BusCardStates & { readonly foreign?: ReadonlySet<number> }

export type ParsedTaken = { kind: 'taken', numbers: number[] } | { kind: 'refused', reason: string }

export function parseTaken(text: string): ParsedTaken {
  const tokens = text.split(/[\s,]+/).filter(token => token !== '')
  const bad = tokens.find(token => !TAKEN_TOKEN.test(token))
  if (bad !== undefined)
    return { kind: 'refused', reason: `'${bad}' is not a pull request or issue number; --taken holds numbers separated by whitespace` }
  return { kind: 'taken', numbers: tokens.map(token => Number(TAKEN_TOKEN.exec(token)![1])) }
}

export function parkedNumbers(files: readonly string[]): number[] {
  return files.flatMap((file) => {
    const id = TASK_FILE.exec(file)?.[1]
    return id === undefined ? [] : [Number(id)]
  })
}

export function admittedNumbers(bus: BusCardStates | undefined): number[] {
  return [...(bus ?? new Map()).keys()].flatMap(task => TAKEN_TOKEN.test(task) ? [Number(task)] : [])
}

function runFrom(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => first + index)
}

export function nextCardNumbers(bus: CardsOfTheBus | undefined, outsideTheBus: readonly number[], count: number): number[] {
  const held = admittedNumbers(bus)
  const own = held.filter(id => bus?.foreign?.has(id) !== true)
  const occupied = new Set(held)
  let first = Math.max(0, ...own, ...outsideTheBus) + 1
  while (runFrom(first, count).some(id => occupied.has(id)))
    first += 1
  return runFrom(first, count)
}
