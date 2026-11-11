import { FACTORY_FOLDERS, FACTORY_FORMER_FOLDERS, FACTORY_ROOT, SEAM_SOURCES } from '../../scripts/core/factory-paths.js'
import { coreReasonOf, entryScope, FACTORY_REASON, PREFIX_SUFFIX, reaches, SECURITY_REASON, under } from '../../scripts/policy/touch-scope.js'

export const RISK_LEVELS = ['R1', 'R2', 'R3', 'R4'] as const
export const RISK_PREFIX = 'risk: '
export const SEAM_PREFIX = 'seam: '
export const SLICE_PREFIX = 'slice: '
export const SLICE_DEPENDS = '· depends '

export type RiskLevel = typeof RISK_LEVELS[number]

export const RISK_MEANING: Record<RiskLevel, string> = {
  R1: 'critical: a person decides it and a review reads it before it merges',
  R2: 'high: a contract or a recorded shape that others read changes; a review reads it',
  R3: 'moderate: a capability grows beside what already works; the harness and a review',
  R4: 'low: tests close it',
}

const CONTRACT = 'a contract or a recorded shape that others read'
const LOW = 'documentation, a log, a test or a script outside the gate'
const ELSEWHERE = 'no path of the core, of a contract, or of the low list'

const HIGH: readonly (readonly [string, string])[] = [
  ['contract', CONTRACT],
  ['src/detect', CONTRACT],
  ['src/model/schema.ts', CONTRACT],
  ...[...FACTORY_FORMER_FOLDERS.ghosts, ...FACTORY_FORMER_FOLDERS.shift].map(root => [root, FACTORY_REASON] as const),
]
const LOW_ROOTS = ['docs', 'architecture', 'tests', '.changeset', '.construct', 'scripts']
const GATE_SCRIPTS = ['scripts/composition', 'scripts/model', 'scripts/privacy', 'scripts/docs']

export const GENERATED_WITH: Readonly<Record<string, readonly string[]>> = SEAM_SOURCES
const TWINS: readonly (readonly [string, string])[] = [
  ['.claude', 'templates/ai/claude/_claude'],
  ['.claude', 'templates/ai/shared/_claude'],
  ['scripts/construct', 'templates/ai/claude/scripts/construct'],
]
const LOCK_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
const LOCK_SOURCES = ['package.json', 'pnpm-workspace.yaml']
const ACCOMPANYING = ['tests', '.changeset']
const WITNESS_ROOTS: readonly (readonly [string, string | null])[] = [
  [FACTORY_FOLDERS.tests[0], FACTORY_ROOT],
  ['tests', null],
]
const MODULE_INDEX = 'index'
export const TEST_SUFFIX = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const EXTENSION = /\.[^.]+$/
const DELIVERY = ['templates/attach', 'templates/ai', 'src/presets', 'scripts/attach']
const CAPABILITY = ['src', 'scripts']
const NO_COMPLEXITY_SLICES = 'R1 and R3–R4 in one card, and the complexity seam proposed no slices that keep them apart'
const PRINCIPLE = 'the highest level a touch reaches decides; a generated file stays with its sources, a lock file with its manifest and a template with its twin; this only proposes, a person confirms the slices or keeps the card whole, and the level is revised as the work shows what it touches'

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

export function covers(entry: string, file: string): boolean {
  return under(file, entryScope(entry).path)
}

function overlaps(a: string, b: string): boolean {
  return reaches(a, entryScope(b).path) || reaches(b, entryScope(a).path)
}

function relativeTo(entry: string, root: string): string | null {
  const scope = entryScope(entry)
  if (under(scope.path, root))
    return `.${entry.slice(root.length)}`
  return scope.prefix && under(root, scope.path) ? `.${PREFIX_SUFFIX}` : null
}

function isLow(entry: string): boolean {
  const scope = entryScope(entry).path
  if (GATE_SCRIPTS.some(root => reaches(entry, root)))
    return false
  return LOW_ROOTS.some(root => under(scope, root)) || (!scope.includes('/') && scope.endsWith('.md'))
}

export function touchedOrCreated(touches: readonly string[], created: readonly string[]): string[] {
  return [...touches, ...created.filter(entry => !touches.includes(entry))]
}

export function riskOf(touch: string): RiskOfTouch {
  const core = coreReasonOf(touch)
  if (core !== undefined)
    return { touch, level: 'R1', why: core }
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

function splitPath(path: string): { directory: string, name: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { directory: '', name: path } : { directory: path.slice(0, at), name: path.slice(at + 1) }
}

function isLockFile(entry: string): boolean {
  const scope = entryScope(entry)
  return !scope.prefix && LOCK_FILES.includes(splitPath(scope.path).name)
}

function lockedWith(lock: string, manifest: string): boolean {
  const scope = entryScope(manifest)
  if (!isLockFile(lock) || scope.prefix || !LOCK_SOURCES.includes(splitPath(scope.path).name))
    return false
  const { directory } = splitPath(entryScope(lock).path)
  return directory === '' || under(scope.path, directory)
}

function keptTogether(a: string, b: string): boolean {
  return twins(a, b) || generatedTogether(a, b) || lockedWith(a, b) || lockedWith(b, a)
}

export function groupsOf(touches: readonly string[]): number[] {
  const group = touches.map((_, index) => index)
  const find = (index: number): number => (group[index] === index ? index : find(group[index]!))
  touches.forEach((a, i) => touches.forEach((b, j) => {
    if (i < j && keptTogether(a, b))
      group[find(j)] = find(i)
  }))
  touches.forEach((touch, i) => {
    const alone = touches.every((_, j) => j === i || find(j) !== find(i))
    const host = touches.findIndex((other, j) => j !== i && !isLockFile(other))
    if (isLockFile(touch) && alone && host >= 0)
      group[find(i)] = find(host)
  })
  return touches.map((_, index) => find(index))
}

function criticalSide(touches: readonly RiskOfTouch[]): boolean[] {
  const groups = groupsOf(touches.map(entry => entry.touch))
  const critical = new Set(groups.filter((_, index) => touches[index]!.level === 'R1'))
  return groups.map(group => critical.has(group))
}

function isCapabilityDelivery(critical: readonly RiskOfTouch[], rest: readonly RiskOfTouch[]): boolean {
  return critical.filter(entry => !accompanies(entry.touch)).every(entry => DELIVERY.some(root => reaches(entry.touch, root)) || critical.some(other => twins(entry.touch, other.touch)))
    && rest.some(entry => CAPABILITY.some(root => under(entryScope(entry.touch).path, root)))
}

function accompanies(touch: string): boolean {
  return ACCOMPANYING.some(root => under(entryScope(touch).path, root))
}

function witnessRootOf(touch: string): readonly [string, string | null] | undefined {
  const scope = entryScope(touch).path
  return WITNESS_ROOTS.find(([root]) => under(scope, root) && scope !== root)
}

function witnessedNames(test: string, root: string): string[] {
  return entryScope(test).path.slice(root.length + 1).split('/').map(segment => segment.replace(TEST_SUFFIX, ''))
}

function codeName(code: string): string | undefined {
  const names = entryScope(code).path.split('/').slice(1).map(segment => segment.replace(EXTENSION, ''))
  return names.at(-1) === MODULE_INDEX ? names.at(-2) : names.at(-1)
}

function witnesses(test: string, code: string): boolean {
  const witnessRoot = witnessRootOf(test)
  if (witnessRoot === undefined || witnessRootOf(code) !== undefined)
    return false
  const [root, codeRoot] = witnessRoot
  if (codeRoot !== null && !under(entryScope(code).path, codeRoot))
    return false
  const own = codeName(code)
  return own !== undefined && witnessedNames(test, root).some(name => name === own || name.startsWith(`${own}-`))
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

const UNSLICED_SIZE = 'XS'
const WHOLE_XS = 'intake keeps an XS card whole: its risk slices would be one change cut into cards that wait on each other'
const WHOLE_SECURITY = 'intake keeps a security-invariants row and the code that changes it whole: the row and its code are one change'

export function riskWholeReason(reading: RiskReading, size: string): string | null {
  const [critical] = reading.slices
  if (critical === undefined)
    return null
  if (size === UNSLICED_SIZE)
    return WHOLE_XS
  const core = critical.touches.map(riskOf).filter(entry => entry.level === 'R1')
  return core.length > 0 && core.every(entry => entry.why === SECURITY_REASON) ? WHOLE_SECURITY : null
}

export function sliceLine(index: number, label: string, touches: readonly string[], depends: readonly number[] = []): string {
  return `${SLICE_PREFIX}${index + 1} ${label} — ${touches.join(', ')}${depends.length === 0 ? '' : ` ${SLICE_DEPENDS}${depends.map(at => at + 1).join(', ')}`}`
}

export function riskLines(reading: RiskReading, depends: readonly (readonly number[])[] = []): string[] {
  const line = `${RISK_PREFIX}${reading.level} — ${RISK_MEANING[reading.level]} — ${reading.why}`
  if (reading.slices.length === 0)
    return [line]
  const names = reading.capabilityDelivery ? ['delivery', 'capability'] : []
  return [
    line,
    `${SEAM_PREFIX}risk${reading.capabilityDelivery ? ' (capability / delivery)' : ''} — ${NO_COMPLEXITY_SLICES} — ${PRINCIPLE}`,
    ...reading.slices.map((slice, index) => sliceLine(index, `${slice.level}${names[index] === undefined ? '' : ` ${names[index]}`}`, slice.touches, depends[index])),
  ]
}
