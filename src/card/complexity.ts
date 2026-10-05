import { PREFIX_SUFFIX } from './task-file.js'

export const AREAS = ['mechanism', 'prompts', 'templates', 'documents', 'generated'] as const
export const SIGNALS = ['touches', 'self', 'generated', 'unclear'] as const
export const MAX_TOUCHES = 6
export const MAX_AREAS = 2
export const MAX_UNCLEAR = 2
export const SIGNALS_TO_SPLIT = 2
export const SEAM_PREFIX = 'seam: '
export const SLICE_PREFIX = 'slice: '

const GENERATED_FROM: Record<string, readonly string[]> = {
  'contract/surface.json': ['src/program.ts', 'scripts/contract'],
  'templates/attach/earlier-carriers.json': ['templates/ai', 'scripts/attach/earlier-carriers.ts'],
}
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
  if (Object.keys(GENERATED_FROM).includes(scope))
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
  return Object.entries(GENERATED_FROM).flatMap(([generated, sources]) => {
    if (!touches.some(entry => reaches(entry, generated)))
      return []
    const withSources = touches.filter(entry => sources.some(source => reaches(entry, source)))
    return withSources.length === 0 ? [] : [{ name: 'generated' as const, detail: `generated ${generated} with its sources ${withSources.join(', ')}` }]
  })
}

function unclearSignal(unclear: number): Signal[] {
  return unclear <= MAX_UNCLEAR ? [] : [{ name: 'unclear', detail: `${unclear} unclear fields; more than ${MAX_UNCLEAR}` }]
}

function slicesByArea(touches: readonly string[], areas: readonly Area[]): ProposedSlice[] {
  const slices = areas.map(area => ({ area, touches: touches.filter(entry => areaOf(entry) === area) }))
  const crossing = touches.filter(entry => areaOf(entry) === null)
  const host = slices.find(slice => slice.area === 'mechanism') ?? slices[0]
  host?.touches.push(...crossing)
  return slices
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
  return { split, signals, slices: split && areas.length > 1 ? slicesByArea(input.touches, areas) : [] }
}

export function seamLines(verdict: SplitVerdict): string[] {
  if (!verdict.split)
    return []
  return [
    `${SEAM_PREFIX}complexity — ${verdict.signals.map(signal => signal.detail).join('; ')} — ${PRINCIPLE}`,
    ...verdict.slices.map((slice, index) => `${SLICE_PREFIX}${index + 1} ${slice.area} — ${slice.touches.join(', ')}`),
  ]
}
