import type { SliceSources } from './slice-depends.js'
import { GENERATED_WITH, groupsOf, riskReading, SEAM_PREFIX, sliceLine } from './risk.js'
import { PREFIX_SUFFIX } from './task-file.js'

export const AREAS = ['mechanism', 'prompts', 'templates', 'documents', 'generated'] as const
export const SIGNALS = ['touches', 'self', 'generated', 'unclear'] as const
export const MAX_TOUCHES = 6
export const MAX_AREAS = 2
export const MAX_UNCLEAR = 2
export const SIGNALS_TO_SPLIT = 2
export const SESSION_READING_TOKENS = 100_000
export const CHARACTERS_PER_TOKEN = 4
const SESSION_READING_CHARACTERS = SESSION_READING_TOKENS * CHARACTERS_PER_TOKEN
const VOLUME_LABEL = 'volume'
const MECHANISM_A_TASK_RUNS_ON = [
  'scripts/ghosts',
  'scripts/shift',
  'scripts/construct/implement.workflow',
  'scripts/construct/check-acceptance.mjs',
  '.claude/agents/harness.md',
]
const CROSSING_EVERY_AREA = ['tests', '.changeset']
const AREA_ROOTS: readonly (readonly [string, Area])[] = [
  ['.claude', 'prompts'],
  ['templates', 'templates'],
  ['docs', 'documents'],
  ['architecture', 'documents'],
]
const UNSLICEABLE = 'alone hold more reading than one session, so no slice of the volume seam fits; narrow them by hand'
const SLICES_MIX_RISK = 'its slices by area would still hold R1 together with R3–R4 work, so the risk seam slices instead'
const VOLUME_PRINCIPLE = 'a card whose reading fills one session context leaves no room for its work, so its touches are cut into slices that each fit; a generated file stays with its sources and a template with its twin; a person confirms the slices or keeps the card whole with the reason written'
const PRINCIPLE = 'slice by complexity first, by the risk matrix R1–R4 when these slices do not hold; a person confirms the slices or keeps the card whole with the reason written'

export type Area = typeof AREAS[number]
export type SignalName = typeof SIGNALS[number]

export interface Signal {
  name: SignalName
  detail: string
}

export interface ProposedSlice {
  area: Area
  touches: string[]
}

export interface SplitVerdict {
  split: boolean
  signals: Signal[]
  slices: ProposedSlice[]
  mixed: boolean
}

export interface VolumeVerdict {
  over: boolean
  tokens: number
  slices: string[][]
  mixed: boolean
  unsliceable: string[]
}

export interface ComplexityInput {
  touches: readonly string[]
  unclear: number
}

function scopeOf(entry: string): { path: string, prefix: boolean } {
  return entry.endsWith(PREFIX_SUFFIX) ? { path: entry.slice(0, -PREFIX_SUFFIX.length), prefix: true } : { path: entry, prefix: false }
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function reaches(entry: string, root: string): boolean {
  const scope = scopeOf(entry)
  return under(scope.path, root) || (scope.prefix && under(root, scope.path))
}

function areaOf(entry: string): Area | null {
  const scope = scopeOf(entry).path
  if (Object.keys(GENERATED_WITH).includes(scope))
    return 'generated'
  if (CROSSING_EVERY_AREA.some(root => under(scope, root)))
    return null
  const rooted = AREA_ROOTS.find(([root]) => under(scope, root))
  if (rooted !== undefined)
    return rooted[1]
  return !scope.includes('/') && scope.endsWith('.md') ? 'documents' : 'mechanism'
}

function touchesSignal(touches: readonly string[], areas: readonly Area[]): Signal[] {
  if (touches.length <= MAX_TOUCHES && areas.length <= MAX_AREAS)
    return []
  return [{ name: 'touches', detail: `${touches.length} touches over ${areas.length} areas (${areas.join(', ')}); more than ${MAX_TOUCHES} touches or ${MAX_AREAS} areas` }]
}

function selfSignal(touches: readonly string[]): Signal[] {
  const reached = touches.filter(entry => MECHANISM_A_TASK_RUNS_ON.some(root => reaches(entry, root)))
  return reached.length === 0 ? [] : [{ name: 'self', detail: `touches the mechanism the task runs on: ${reached.join(', ')}` }]
}

function generatedSignal(touches: readonly string[]): Signal[] {
  return Object.entries(GENERATED_WITH).flatMap(([generated, sources]) => {
    if (!touches.some(entry => reaches(entry, generated)))
      return []
    const withSources = touches.filter(entry => sources.some(source => reaches(entry, source)))
    return withSources.length === 0 ? [] : [{ name: 'generated' as const, detail: `generated ${generated} with its sources ${withSources.join(', ')}` }]
  })
}

function unclearSignal(unclear: number): Signal[] {
  return unclear <= MAX_UNCLEAR ? [] : [{ name: 'unclear', detail: `${unclear} unclear fields; more than ${MAX_UNCLEAR}` }]
}

function areaOfGroup(touches: readonly string[], groups: readonly number[], index: number): Area | null {
  const members = touches.filter((_, at) => groups[at] === groups[index])
  const present = new Set(members.map(areaOf))
  return AREAS.find(area => present.has(area)) ?? null
}

function slicesByArea(touches: readonly string[]): ProposedSlice[] {
  const groups = groupsOf(touches)
  const areaOfTouch = touches.map((_, index) => areaOfGroup(touches, groups, index))
  const slices = AREAS
    .map(area => ({ area, touches: touches.filter((_, index) => areaOfTouch[index] === area) }))
    .filter(slice => slice.touches.length > 0)
  const crossing = touches.filter((_, index) => areaOfTouch[index] === null)
  const host = slices.find(slice => slice.area === 'mechanism') ?? slices[0]
  host?.touches.push(...crossing)
  return slices
}

function mixesRisk(touches: readonly string[]): boolean {
  return riskReading(touches, false).slices.length > 0
}

function charactersOf(touch: string, sources: SliceSources): number {
  const files = touch.endsWith(PREFIX_SUFFIX) ? sources.filesUnder(touch.slice(0, -PREFIX_SUFFIX.length)) : [touch]
  return files.reduce((sum, file) => sum + (sources.read(file)?.length ?? 0), 0)
}

function tokensOf(characters: number): number {
  return Math.ceil(characters / CHARACTERS_PER_TOKEN)
}

function packedByVolume(touches: readonly string[], characters: readonly number[]): { touches: string[], characters: number }[] {
  const groups = groupsOf(touches)
  const packed: { touches: string[], characters: number }[] = []
  for (const group of new Set(groups)) {
    const members = touches.flatMap((touch, index) => (groups[index] === group ? [{ touch, characters: characters[index]! }] : []))
    const weight = members.reduce((sum, member) => sum + member.characters, 0)
    const last = packed.at(-1)
    if (last !== undefined && last.characters + weight <= SESSION_READING_CHARACTERS) {
      last.touches.push(...members.map(member => member.touch))
      last.characters += weight
    }
    else {
      packed.push({ touches: members.map(member => member.touch), characters: weight })
    }
  }
  return packed
}

export function volumeSignal(touches: readonly string[], sources: SliceSources): VolumeVerdict {
  const characters = touches.map(touch => charactersOf(touch, sources))
  const total = characters.reduce((sum, count) => sum + count, 0)
  if (total <= SESSION_READING_CHARACTERS)
    return { over: false, tokens: tokensOf(total), slices: [], mixed: false, unsliceable: [] }
  const packed = packedByVolume(touches, characters)
  const unsliceable = packed.filter(slice => slice.characters > SESSION_READING_CHARACTERS).flatMap(slice => slice.touches)
  const slices = unsliceable.length > 0 ? [] : packed.map(slice => slice.touches)
  const mixed = slices.length > 1 && slices.some(mixesRisk)
  return { over: true, tokens: tokensOf(total), slices: slices.length > 1 && !mixed ? slices : [], mixed, unsliceable }
}

export function splitSignal(input: ComplexityInput): SplitVerdict {
  const present = new Set(input.touches.map(areaOf))
  const areas = AREAS.filter(area => present.has(area))
  const signals = [
    ...touchesSignal(input.touches, areas),
    ...selfSignal(input.touches),
    ...generatedSignal(input.touches),
    ...unclearSignal(input.unclear),
  ]
  const split = new Set(signals.map(signal => signal.name)).size >= SIGNALS_TO_SPLIT
  const slices = split ? slicesByArea(input.touches) : []
  const mixed = slices.length > 1 && slices.some(slice => mixesRisk(slice.touches))
  return { split, signals, slices: slices.length > 1 && !mixed ? slices : [], mixed }
}

export function seamLines(verdict: SplitVerdict, depends: readonly (readonly number[])[] = []): string[] {
  if (!verdict.split)
    return []
  return [
    `${SEAM_PREFIX}complexity — ${[...verdict.signals.map(signal => signal.detail), ...(verdict.mixed ? [SLICES_MIX_RISK] : [])].join('; ')} — ${PRINCIPLE}`,
    ...verdict.slices.map((slice, index) => sliceLine(index, slice.area, slice.touches, depends[index])),
  ]
}

export function volumeLines(verdict: VolumeVerdict, depends: readonly (readonly number[])[] = []): string[] {
  if (!verdict.over)
    return []
  return [
    `${SEAM_PREFIX}${VOLUME_LABEL} — about ${verdict.tokens} tokens of reading in the touches; more than ${SESSION_READING_TOKENS}, the reading one session holds beside its work${verdict.unsliceable.length > 0 ? `; ${verdict.unsliceable.join(', ')} ${UNSLICEABLE}` : ''}${verdict.mixed ? `; ${SLICES_MIX_RISK}` : ''} — ${VOLUME_PRINCIPLE}`,
    ...verdict.slices.map((touches, index) => sliceLine(index, VOLUME_LABEL, touches, depends[index])),
  ]
}
