import type { GeneratedRow } from './generated-files.js'
import { DECLARATION_SUFFIX, DECLARATIONS_FOLDER, GENERATED_FILES, GENERATED_KIND } from './generated-files.js'

export interface EventDeclaration {
  event: string
  constant: string
  payload: readonly string[] | null
}

export interface ReadingDeclaration {
  reading: string
  constant: string
  reducedInOrder: boolean
  types: readonly string[]
  foldedOnAppend: readonly string[] | null
}

type Problem = (problem: string) => void

export const EVENTS_KIND = 'events'
export const READINGS_KIND = 'readings'
export const EVENT_CATALOG_ROW = 'event-payloads'
export const READINGS_ROW = 'bus-readings'

export function generatedPathOf(id: string): string {
  const row = (Object.values(GENERATED_FILES) as GeneratedRow[]).find(entry => entry.id === id)
  if (row === undefined)
    throw new Error(`${DECLARATIONS_FOLDER}/${GENERATED_KIND}/ has no row ${id}, which the assembler of the declarations names`)
  return row.path
}

export const EVENT_CATALOG = generatedPathOf(EVENT_CATALOG_ROW)
export const READINGS_CATALOG = generatedPathOf(READINGS_ROW)

const CONSTANT = /^[A-Z][A-Z0-9_]*$/

const WRITTEN_BESIDE_THE_EVENTS = ['CARD_WAITS', 'CLOSED_PLAN', 'DEFERRED_TARGET', 'DROPPED_LANE', 'EVENT_PAYLOADS', 'OPEN_PLAN', 'OPEN_QUESTION', 'OUTSIDE_TOUCHES', 'TERMINAL_LANES', 'WAIT_LIFTERS']

function where(kind: string, key: string): string {
  return `${DECLARATIONS_FOLDER}/${kind}/${key}${DECLARATION_SUFFIX}`
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isSortedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText) && value.every((item, at) => at === 0 || value[at - 1]! < item)
}

function constantProblem(value: unknown): string | null {
  if (!isText(value) || !CONSTANT.test(value))
    return 'constant is not an upper-case identifier'
  return WRITTEN_BESIDE_THE_EVENTS.includes(value) ? `constant "${value}" is a name the event catalog writes beside the events` : null
}

export function eventOf(key: string, value: Record<string, unknown>, problem: Problem): EventDeclaration | null {
  const found = [
    constantProblem(value.constant),
    value.payload === null || isSortedList(value.payload) ? null : 'payload is neither null nor a sorted list of distinct non-empty keys',
  ].filter(text => text !== null)
  found.forEach(problem)
  return found.length === 0 ? { event: key, constant: value.constant as string, payload: value.payload as string[] | null } : null
}

export function readingOf(key: string, value: Record<string, unknown>, problem: Problem): ReadingDeclaration | null {
  const types = isSortedList(value.types) && value.types.length > 0
  const folded = value.foldedOnAppend === null || isSortedList(value.foldedOnAppend)
  const found = [
    constantProblem(value.constant),
    typeof value.reducedInOrder === 'boolean' ? null : 'reducedInOrder is not a boolean',
    types ? null : 'types is not a sorted non-empty list of distinct event types',
    folded ? null : 'foldedOnAppend is neither null nor a sorted list of distinct event types',
    (value.reducedInOrder === true) === (value.foldedOnAppend === null) ? null : 'a reading is either reduced in order, with foldedOnAppend null, or folds a list of its types on append',
    types && folded && value.foldedOnAppend !== null && (value.foldedOnAppend as string[]).some(type => !(value.types as string[]).includes(type)) ? 'foldedOnAppend names a type that types does not' : null,
  ].filter(text => text !== null)
  found.forEach(problem)
  return found.length === 0
    ? { reading: key, constant: value.constant as string, reducedInOrder: value.reducedInOrder as boolean, types: value.types as string[], foldedOnAppend: value.foldedOnAppend as string[] | null }
    : null
}

function byKey<Item>(items: readonly Item[], key: (item: Item) => string): Item[] {
  return [...items].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0)
}

export function eventProblems(events: readonly EventDeclaration[], readings: readonly ReadingDeclaration[]): string[] {
  const declared = new Set(events.map(event => event.event))
  const holders = new Map<string, string[]>()
  for (const [kind, key, constant] of [...events.map(event => [EVENTS_KIND, event.event, event.constant]), ...readings.map(reading => [READINGS_KIND, reading.reading, reading.constant])])
    holders.set(constant!, [...(holders.get(constant!) ?? []), where(kind!, key!)])
  return [
    ...[...holders].filter(([, files]) => files.length > 1).map(([constant, files]) => `constant ${constant} is named by ${files.join(', ')}; one declaration names it`),
    ...readings.flatMap(reading => [...new Set([...reading.types, ...(reading.foldedOnAppend ?? [])])]
      .filter(type => !declared.has(type))
      .map(type => `${where(READINGS_KIND, reading.reading)}: reads ${type}, which ${DECLARATIONS_FOLDER}/${EVENTS_KIND}/ does not declare`)),
  ]
}

const LANES_AND_WAITS = [
  'export const DEFERRED_TARGET = \'later\'',
  'export const DROPPED_LANE = \'dropped\'',
  'export const TERMINAL_LANES: ReadonlySet<string> = new Set([\'archive\', DROPPED_LANE, \'superseded\'])',
  'export const OPEN_PLAN = \'open\'',
  'export const CLOSED_PLAN = \'closed\'',
  'export const OUTSIDE_TOUCHES = \'outside-touches\'',
  'export const OPEN_QUESTION = \'open-question\'',
  '',
  'export const WAIT_LIFTERS = [\'bus\', \'owner\', \'window\'] as const',
  '',
  'export type WaitLifter = typeof WAIT_LIFTERS[number]',
  '',
  'export interface WaitTerm {',
  '  lifter: WaitLifter',
  '  deadlineMinutes: number',
  '}',
  '',
  'export const CARD_WAITS = {',
  '  depends: { lifter: \'bus\', deadlineMinutes: 1440 },',
  '  lane: { lifter: \'bus\', deadlineMinutes: 120 },',
  '  launch: { lifter: \'bus\', deadlineMinutes: 30 },',
  '  owner: { lifter: \'owner\', deadlineMinutes: 720 },',
  '  stopped: { lifter: \'window\', deadlineMinutes: 60 },',
  '} as const satisfies Record<string, WaitTerm>',
  '',
  'export type WaitKind = keyof typeof CARD_WAITS',
  '',
]

const EVENT_ACCESS = [
  '} as const satisfies Record<string, readonly string[]>',
  '',
  'export type EventType = keyof typeof EVENT_PAYLOADS',
  '',
  'export type PayloadKey<T extends EventType> = (typeof EVENT_PAYLOADS)[T][number]',
  '',
  'export type EventPayload<T extends EventType> = { readonly [K in PayloadKey<T>]?: unknown }',
  '',
  'export type Declared<T extends EventType, P> = P & { readonly [K in Exclude<keyof P, PayloadKey<T>>]: never }',
  '',
  'export function declaredPayload<T extends EventType>(type: T, payload: object): EventPayload<T> {',
  '  const declared: readonly string[] = EVENT_PAYLOADS[type]',
  '  const undeclared = Object.keys(payload).filter(key => !declared.includes(key))',
  '  if (undeclared.length > 0)',
  `    throw new Error(\`\${type} declares no payload key \${undeclared.join(', ')} in EVENT_PAYLOADS of scripts/core/events.ts; nothing written\`)`,
  '  return payload as EventPayload<T>',
  '}',
  '',
  'export function declaredPart<T extends EventType>(type: T, stored: object): EventPayload<T> {',
  '  const declared: readonly string[] = EVENT_PAYLOADS[type]',
  '  return Object.fromEntries(Object.entries(stored).filter(([key]) => declared.includes(key))) as EventPayload<T>',
  '}',
  '',
  'export function catalogued(type: string): EventType {',
  '  if (!Object.hasOwn(EVENT_PAYLOADS, type))',
  `    throw new Error(\`\${type} declares no payload in EVENT_PAYLOADS of scripts/core/events.ts, so nothing may write or fold it\`)`,
  '  return type as EventType',
  '}',
  '',
]

function quotedList(items: readonly string[]): string {
  return `[${items.map(item => `'${item}'`).join(', ')}]`
}

export function renderEvents(events: readonly EventDeclaration[]): string {
  const sorted = byKey(events, event => event.event)
  return [
    ...sorted.map(event => `export const ${event.constant} = '${event.event}'`),
    '',
    ...LANES_AND_WAITS,
    'export const EVENT_PAYLOADS = {',
    ...sorted.flatMap(event => event.payload === null ? [] : [`  [${event.constant}]: ${quotedList(event.payload)},`]),
    ...EVENT_ACCESS,
  ].join('\n')
}

export function renderReadings(events: readonly EventDeclaration[], readings: readonly ReadingDeclaration[]): string {
  const constants = new Map(events.map(event => [event.event, event.constant]))
  const constantOf = (type: string): string => constants.get(type) ?? type
  const sorted = byKey(readings, reading => reading.reading)
  const named = [...new Set(sorted.flatMap(reading => [...reading.types, ...(reading.foldedOnAppend ?? [])]).map(constantOf))].sort((left, right) => left.localeCompare(right))
  const listOf = (types: readonly string[]): string => `[${types.map(constantOf).join(', ')}]`
  return [
    'import type { EventType } from \'./events.js\'',
    `import { ${named.join(', ')} } from './events.js'`,
    '',
    ...sorted.map(reading => `export const ${reading.constant} = '${reading.reading}'`),
    '',
    'export const PROJECTION_TYPES = {',
    ...sorted.map(reading => `  [${reading.constant}]: ${listOf(reading.types)},`),
    '} as const satisfies Record<string, readonly EventType[]>',
    '',
    'export type ReadProjection = keyof typeof PROJECTION_TYPES',
    '',
    `export const REDUCED_IN_ORDER: readonly ReadProjection[] = [${sorted.filter(reading => reading.reducedInOrder).map(reading => reading.constant).join(', ')}]`,
    '',
    'export const FOLDED_ON_APPEND: Partial<Record<ReadProjection, readonly EventType[]>> = {',
    ...sorted.flatMap(reading => reading.foldedOnAppend === null ? [] : [`  [${reading.constant}]: ${listOf(reading.foldedOnAppend)},`]),
    '}',
    '',
  ].join('\n')
}
