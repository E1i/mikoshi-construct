import { PREFIX_SUFFIX } from './task-file.js'

export const RISK_LEVELS = ['R1', 'R2', 'R3', 'R4'] as const
export const RISK_PREFIX = 'risk: '
export const SEAM_PREFIX = 'seam: '
export const SLICE_PREFIX = 'slice: '

export type RiskLevel = typeof RISK_LEVELS[number]

export const RISK_MEANING: Record<RiskLevel, string> = {
  R1: 'critical: a person decides it and a review reads it before it merges',
  R2: 'high: a contract or a recorded shape that others read changes; a review reads it',
  R3: 'moderate: a capability grows beside what already works; the harness and a review',
  R4: 'low: tests close it',
}

const LADDER = 'the ladder mechanism a task runs on'
const APPROVAL_RULES = 'the rules by which a brief is approved'
const FOREIGN_WRITE = 'what init, attach, sync or detach write into another repository'
const CARRIERS = 'the registration of the carriers attach delivers'
const SECURITY = 'a security invariant'
const CONTRACT = 'a contract or a recorded shape that others read'
const FACTORY = 'the factory mechanism that decides on closing, merging and admitting a task'
const PUBLISH = 'a publish, which cannot be unpublished'
const ALWAYS_HIGH = 'always high: the composition models, the lint policy and who merges'
const LOW = 'documentation, a log, a test or a script outside the gate'
const ELSEWHERE = 'no path of the core, of a contract, or of the low list'

const CORE: readonly (readonly [string, string])[] = [
  ['.claude/skills/implement', LADDER],
  ['.claude/agents', LADDER],
  ['scripts/construct', LADDER],
  ['scripts/ghosts/approval.ts', LADDER],
  ['scripts/ghosts/hash.ts', LADDER],
  ['scripts/ghosts/launch.ts', LADDER],
  ['scripts/ghosts/approve.ts', APPROVAL_RULES],
  ['architecture/decisions/0053-morse-approves-a-brief-the-risk-matrix-does-not-reserve-for-the-owner.md', APPROVAL_RULES],
  ['architecture/decisions/0058-morse-approves-a-brief-of-every-risk.md', APPROVAL_RULES],
  ['templates/ai/claude/_claude/skills/implement', LADDER],
  ['templates/ai/claude/_claude/agents', LADDER],
  ['templates/ai/claude/scripts/construct', LADDER],
  ['templates', FOREIGN_WRITE],
  ['src/materialize', FOREIGN_WRITE],
  ['src/sync', FOREIGN_WRITE],
  ['src/manifest.ts', FOREIGN_WRITE],
  ['src/presets', CARRIERS],
  ['src/commands/init.ts', FOREIGN_WRITE],
  ['src/commands/attach', FOREIGN_WRITE],
  ['src/commands/sync', FOREIGN_WRITE],
  ['src/commands/detach', FOREIGN_WRITE],
  ['scripts/attach', CARRIERS],
  ['architecture/security-invariants.md', SECURITY],
  ['.changeset/config.json', PUBLISH],
  ['scripts/release', PUBLISH],
  ['.github/workflows', PUBLISH],
  ['architecture/composition', ALWAYS_HIGH],
  ['eslint.config.mjs', ALWAYS_HIGH],
  ['architecture/owner-merges.md', ALWAYS_HIGH],
]
const HIGH: readonly (readonly [string, string])[] = [
  ['contract', CONTRACT],
  ['src/detect', CONTRACT],
  ['src/model/schema.ts', CONTRACT],
  ['scripts/ghosts', FACTORY],
  ['scripts/shift', FACTORY],
]
const LOW_ROOTS = ['docs', 'architecture', 'tests', '.changeset', '.construct', 'scripts']
const GATE_SCRIPTS = ['scripts/composition', 'scripts/model', 'scripts/privacy', 'scripts/docs']

export const GENERATED_WITH: Record<string, readonly string[]> = {
  'contract/surface.json': ['src/program.ts', 'scripts/contract'],
  'templates/attach/earlier-carriers.json': ['templates/ai', 'scripts/attach/earlier-carriers.ts'],
}
const TWINS: readonly (readonly [string, string])[] = [
  ['.claude', 'templates/ai/claude/_claude'],
  ['.claude', 'templates/ai/shared/_claude'],
  ['scripts/construct', 'templates/ai/claude/scripts/construct'],
]
const ACCOMPANYING = ['tests', '.changeset']
const WITNESS_ROOTS: readonly (readonly [string, string | null])[] = [
  ['scripts/tests', 'scripts'],
  ['tests', null],
]
const COMMANDS_CONTAINER = 'commands'
const TEST_SUFFIX = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const EXTENSION = /\.[^.]+$/
const DELIVERY = ['templates/attach', 'templates/ai', 'src/presets', 'scripts/attach']
const CAPABILITY = ['src', 'scripts']
const NO_COMPLEXITY_SLICES = 'R1 and R3–R4 in one card, and the complexity seam proposed no slices that keep them apart'
const PRINCIPLE = 'the highest level a touch reaches decides; a generated file stays with its sources and a template with its twin; this only proposes, a person confirms the slices or keeps the card whole, and the level is revised as the work shows what it touches'

interface RiskOfTouch {
  touch: string
  level: RiskLevel
  why: string
}

interface RiskSlice {
  level: RiskLevel
  touches: string[]
}

export interface RiskReading {
  level: RiskLevel
  why: string
  slices: RiskSlice[]
  capabilityDelivery: boolean
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

function overlaps(a: string, b: string): boolean {
  return reaches(a, scopeOf(b).path) || reaches(b, scopeOf(a).path)
}

function relativeTo(entry: string, root: string): string | null {
  const scope = scopeOf(entry)
  if (under(scope.path, root))
    return `.${entry.slice(root.length)}`
  return scope.prefix && under(root, scope.path) ? `.${PREFIX_SUFFIX}` : null
}

function isLow(entry: string): boolean {
  const scope = scopeOf(entry).path
  if (GATE_SCRIPTS.some(root => reaches(entry, root)))
    return false
  return LOW_ROOTS.some(root => under(scope, root)) || (!scope.includes('/') && scope.endsWith('.md'))
}

export function riskOf(touch: string): RiskOfTouch {
  const core = CORE.find(([root]) => reaches(touch, root))
  if (core !== undefined)
    return { touch, level: 'R1', why: core[1] }
  const high = HIGH.find(([root]) => reaches(touch, root))
  if (high !== undefined)
    return { touch, level: 'R2', why: high[1] }
  return isLow(touch) ? { touch, level: 'R4', why: LOW } : { touch, level: 'R3', why: ELSEWHERE }
}

function highest(levels: readonly RiskLevel[]): RiskLevel {
  return RISK_LEVELS.find(level => levels.includes(level)) ?? 'R4'
}

function twins(a: string, b: string): boolean {
  return TWINS.some(([repo, template]) => {
    const pairs = [[relativeTo(a, repo), relativeTo(b, template)], [relativeTo(b, repo), relativeTo(a, template)]]
    return pairs.some(([left, right]) => left !== null && right !== null && overlaps(left, right))
  })
}

function generatedTogether(a: string, b: string): boolean {
  return Object.entries(GENERATED_WITH).some(([generated, sources]) => {
    const isSource = (entry: string): boolean => sources.some(source => reaches(entry, source))
    return (reaches(a, generated) && isSource(b)) || (reaches(b, generated) && isSource(a))
  })
}

function keptTogether(a: string, b: string): boolean {
  return twins(a, b) || generatedTogether(a, b)
}

export function groupsOf(touches: readonly string[]): number[] {
  const group = touches.map((_, index) => index)
  const find = (index: number): number => (group[index] === index ? index : find(group[index]!))
  touches.forEach((a, i) => touches.forEach((b, j) => {
    if (i < j && keptTogether(a, b))
      group[find(j)] = find(i)
  }))
  return touches.map((_, index) => find(index))
}

function criticalSide(touches: readonly RiskOfTouch[]): boolean[] {
  const groups = groupsOf(touches.map(entry => entry.touch))
  const critical = new Set(groups.filter((_, index) => touches[index]!.level === 'R1'))
  return groups.map(group => critical.has(group))
}

function isCapabilityDelivery(critical: readonly RiskOfTouch[], rest: readonly RiskOfTouch[]): boolean {
  return critical.filter(entry => !accompanies(entry.touch)).every(entry => DELIVERY.some(root => reaches(entry.touch, root)) || critical.some(other => twins(entry.touch, other.touch)))
    && rest.some(entry => CAPABILITY.some(root => under(scopeOf(entry.touch).path, root)))
}

function accompanies(touch: string): boolean {
  return ACCOMPANYING.some(root => under(scopeOf(touch).path, root))
}

function witnessRootOf(touch: string): readonly [string, string | null] | undefined {
  const scope = scopeOf(touch).path
  return WITNESS_ROOTS.find(([root]) => under(scope, root) && scope !== root)
}

function witnessedNames(test: string, root: string): string[] {
  return scopeOf(test).path.slice(root.length + 1).split('/').map(segment => segment.replace(TEST_SUFFIX, ''))
}

function codeNames(code: string): string[] {
  return scopeOf(code).path.split('/').slice(1).map(segment => segment.replace(EXTENSION, '')).filter(segment => segment !== COMMANDS_CONTAINER)
}

function witnesses(test: string, code: string): boolean {
  const witnessRoot = witnessRootOf(test)
  if (witnessRoot === undefined || witnessRootOf(code) !== undefined)
    return false
  const [root, codeRoot] = witnessRoot
  if (codeRoot !== null && !under(scopeOf(code).path, codeRoot))
    return false
  const segments = codeNames(code)
  return witnessedNames(test, root).some(name => segments.some(segment => name === segment || name.startsWith(`${segment}-`)))
}

function withWitnesses(touches: readonly string[], critical: readonly boolean[]): boolean[] {
  return touches.map((touch, index) => critical[index]! || touches.some((code, at) => critical[at]! && witnesses(touch, code)))
}

export function riskReading(touches: readonly string[], complexitySliced: boolean): RiskReading {
  const read = touches.map(riskOf)
  const level = highest(read.map(entry => entry.level))
  const top = read.filter(entry => entry.level === level)
  const why = [...new Set(top.map(entry => entry.why))].map(reason => `${reason}: ${top.filter(entry => entry.why === reason).map(entry => entry.touch).join(', ')}`).join('; ')
  const critical = withWitnesses(touches, criticalSide(read))
  const high = read.filter((_, index) => critical[index])
  const rest = read.filter((_, index) => !critical[index])
  const mixed = high.length > 0 && rest.some(entry => (entry.level === 'R3' || entry.level === 'R4') && !accompanies(entry.touch))
  const slices = !mixed || complexitySliced
    ? []
    : [high, rest].map(side => ({ level: highest(side.map(entry => entry.level)), touches: side.map(entry => entry.touch) }))
  return { level, why, slices, capabilityDelivery: slices.length > 0 && isCapabilityDelivery(high, rest) }
}

export function riskLines(reading: RiskReading): string[] {
  const line = `${RISK_PREFIX}${reading.level} — ${RISK_MEANING[reading.level]} — ${reading.why}`
  if (reading.slices.length === 0)
    return [line]
  const names = reading.capabilityDelivery ? ['delivery', 'capability'] : []
  return [
    line,
    `${SEAM_PREFIX}risk${reading.capabilityDelivery ? ' (capability / delivery)' : ''} — ${NO_COMPLEXITY_SLICES} — ${PRINCIPLE}`,
    ...reading.slices.map((slice, index) => `${SLICE_PREFIX}${index + 1} ${slice.level}${names[index] === undefined ? '' : ` ${names[index]}`} — ${slice.touches.join(', ')}`),
  ]
}
