import type { Kind } from '../../card/grammar.js'
import type { DraftCard, DraftPlan, UnclearField } from './draft.js'
import type { RepositoryFacts } from './facts.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { GENERATED_FILES } from '../../../scripts/core/factory-paths.js'
import { isTestScope, runsOf, withinTouches } from '../../card/covering-tests.js'
import { CONTOURS, decisionsOf, KINDS } from '../../card/grammar.js'
import { createdPaths, parseCreatesEntry, parseParkingFile } from '../../card/parking.js'
import { CHANGESET_COMPANION, RISK_LEVELS, riskOf, touchedOrCreated } from '../../card/risk.js'
import { PREFIX_SUFFIX, touchError } from '../../card/task-file.js'
import { commandInsideJudgedWrap } from '../../card/witness-fields.js'
import { FACTORY_MANIFEST } from '../../materialize/factory-manifest.js'
import { globToRegExp } from '../../model/glob.js'
import { bashSyntaxProblem } from './bash-syntax.js'
import { commandArguments, commandWord, HOME_REFERENCE, namesATest, pathsNamedBy, TEST_NAME_ARGUMENT } from './command-word.js'
import { witnessKindField } from './draft.js'
import { isWithin } from './parking-tree.js'

export const DEFAULT_CONTOUR = 'cheap'
const LADDER_CONTOUR = 'ladder'
const LADDER_PREFIX = 'ladder: '
const OWNER_LADDER_WORD = /^ladder: owner [^\s—][^—]*— ?\S/
export const LADDER_GRAMMAR = `a line '${LADDER_PREFIX}owner <where the owner gave the word on this card> — <how many cheap failures and which, or why cheap does not give the proof>' in the card text`
export const CONTOUR_NOT_FROM_RISK = 'the risk table sets the review depth and who merges, never the contour'
export const CARD_REFERENCE = /^#(\d+)$/
const BACKTICKED = /`([^`]+)`/g
const MOVING_REF = /\borigin\/main\b/
const PROSE_STEP = /→|->|\b(?:PR body|by hand|manually)\b/i
const DEVICE_ROOT = '/dev/'
const INFORMATION_FLAGS = new Set(['-v', '-V', '--version', '-h', '--help'])
const TREE_READING_COMMANDS = new Set(['pnpm', 'npm', 'npx', 'yarn', 'node', 'git', 'vitest', 'tsx', 'tsc', 'eslint'])
const CHANGE_WITNESS_WORDING = /\b(?:red on (?:main|the base|base)|fails on (?:main|the base|base))\b/i
const CHANGE_WITNESS_KIND = 'acceptance'
const IMPLEMENT_KIND = 'implement'
const FIELD_ORDER = ['number', 'contour', 'decision', 'touches', 'creates', 'depends', 'blocks']

const HARNESS_MEMBERSHIP_TEST = 'tests/harness-membership.test.ts'
const TESTS_ROOT = 'tests'
const SOURCE_MODULE = /^src\/(.+)\.ts$/

export const OWNER_MERGES = 'architecture/owner-merges.md'
const OWNER_KINDS_HEADER = '| kind |'
const OWNER_BY_RISK_HEADER = '| by risk |'
const OWNER_DECISION = 'owner'
const AUTO_DECISION = 'auto'
const OWNER_RISK = 'R1'
export const NO_OWNER_PATH = `no touch meets an owner path of ${OWNER_MERGES}`
const UNDER_PREFIX = 'x'

export const PACKAGE_MANIFEST = 'package.json'
const SOURCE_OF_BUILT_ROOT: Readonly<Record<string, string>> = { dist: 'src' }

export interface CompanionRow {
  kind: string
  keptBy: string
  touched: (entry: string, published: readonly string[]) => boolean
  companions: (entry: string, touches: readonly string[], repository: RepositoryFacts) => string[]
}

function scopeOf(entry: string): string {
  return entry.endsWith(PREFIX_SUFFIX) ? entry.slice(0, -PREFIX_SUFFIX.length) : entry
}

function under(entry: string, root: string): boolean {
  const scope = scopeOf(entry)
  return scope === root || scope.startsWith(`${root}/`)
}

function testBeside(entry: string, touches: readonly string[], repository: RepositoryFacts): string[] {
  if (touches.some(touch => under(touch, TESTS_ROOT)))
    return []
  const module = SOURCE_MODULE.exec(entry)?.[1]
  const mirrored = `${TESTS_ROOT}/${module}.test.ts`
  return [module !== undefined && repository.exists(mirrored) ? mirrored : `${TESTS_ROOT}${PREFIX_SUFFIX}`]
}

export const COMPANION_REASON = 'every change of this kind carries it: the companion table in src/commands/intake/check.ts'

export interface CompositionRecord {
  id: string
  doc: string
  nodes: readonly { path?: string }[]
}

export interface FollowingReach {
  touches: readonly string[]
  added: ReadonlySet<string>
  compositionRecords: readonly CompositionRecord[]
}

export interface FollowingRow {
  kind: string
  follows: (file: string, reach: FollowingReach) => boolean
}

const TEMPLATE_GROUP_FILE = /^templates\/(?:base|harness|attach|ai\/[^/]+|stacks\/[^/]+|presets\/[^/]+\/[^/]+)\/(.+)$/
const DOT_SEGMENT = /(^|\/)_/g
const RENDERED_SUFFIX = /(?:\.existing)?\.eta$/
const CHANGESET_FILE = /^\.changeset\/(?!readme\.md$)[^/]+\.md$/i
const SECURITY_PATHS = ['architecture/security-invariants.md', '.gitleaks.toml', '.github/workflows']
const NEVER_FOLLOWING = ['.claude', OWNER_MERGES, ...SECURITY_PATHS]
export const COMPOSITION_ROOT = 'architecture/composition'

function reachesAny(touches: readonly string[], roots: readonly string[]): boolean {
  return touches.some(touch => roots.some(root => under(touch, root) || (touch.endsWith(PREFIX_SUFFIX) && under(root, scopeOf(touch)))))
}

export function rootCopyOf(entry: string): string | null {
  const copy = TEMPLATE_GROUP_FILE.exec(scopeOf(entry))?.[1]
  if (copy === undefined)
    return null
  const rendered = copy.replace(DOT_SEGMENT, '$1.')
  return entry.endsWith(PREFIX_SUFFIX) ? `${rendered}${PREFIX_SUFFIX}` : rendered.replace(RENDERED_SUFFIX, '')
}

function generatedFrom(generated: string, sources: readonly string[]): FollowingRow['follows'] {
  return (file, reach) => file === generated && reachesAny(reach.touches, sources)
}

function reachedRecordFollows(file: string, reach: FollowingReach): boolean {
  return reach.compositionRecords.some(record => (file === `${COMPOSITION_ROOT}/${record.id}.yaml` || file === record.doc)
    && reachesAny(reach.touches, record.nodes.flatMap(node => node.path ?? [])))
}

export const COMPANION_TABLE: readonly (CompanionRow | FollowingRow)[] = [
  { kind: 'the scripts manifest', keptBy: HARNESS_MEMBERSHIP_TEST, touched: entry => entry === 'package.json', companions: () => ['CONTRIBUTING.md', HARNESS_MEMBERSHIP_TEST] },
  { kind: 'the command definitions', keptBy: 'tests/readme-commands.test.ts', touched: entry => entry === 'src/program.ts', companions: () => ['README.md', 'docs/cli.md', `docs/guide${PREFIX_SUFFIX}`] },
  { kind: 'published code', keptBy: '.changeset/config.json', touched: (entry, published) => published.some(root => under(entry, SOURCE_OF_BUILT_ROOT[root] ?? root)), companions: () => [CHANGESET_COMPANION] },
  { kind: 'source code', keptBy: TESTS_ROOT, touched: entry => under(entry, 'src'), companions: testBeside },
  { kind: 'the card\'s changeset', follows: (file, reach) => CHANGESET_FILE.test(file) && reach.added.has(file) },
  { kind: 'the command surface', follows: generatedFrom(GENERATED_FILES.surface.path, GENERATED_FILES.surface.followSources) },
  { kind: 'the factory contract', follows: generatedFrom(GENERATED_FILES.factory.path, GENERATED_FILES.factory.followSources) },
  { kind: 'the add population', follows: generatedFrom(GENERATED_FILES.addPopulation.path, GENERATED_FILES.addPopulation.followSources) },
  { kind: 'the self-hosting drift list', follows: generatedFrom(GENERATED_FILES.selfHostingDrift.path, GENERATED_FILES.selfHostingDrift.followSources) },
  { kind: 'the factory manifest', follows: generatedFrom(GENERATED_FILES.factoryManifest.path, FACTORY_MANIFEST) },
  { kind: 'a root self-hosting copy', follows: (file, reach) => reach.touches.some((touch) => {
    const copy = rootCopyOf(touch)
    return copy !== null && covers(copy, file)
  }) },
  { kind: 'a composition record and its document', follows: reachedRecordFollows },
]
export const FOLLOWING_REASON = 'a generated twin of a touched file, a composition record and its document whose node the touches reach, or a changeset the card adds, follows the touches: the companion table in src/commands/intake/check.ts'

export function neverFollows(file: string, reach: FollowingReach): boolean {
  if (under(file, COMPOSITION_ROOT) && reachedRecordFollows(file, reach))
    return false
  return NEVER_FOLLOWING.some(root => under(file, root)) || riskOf(file).level === OWNER_RISK
}

export interface AdmittedReach {
  touches: string[]
  runs: string[]
}

export function admittedReachOf(cardId: number, cardBody: string | null): AdmittedReach {
  const parsed = cardBody === null ? null : parseParkingFile(`${cardId}.md`, cardBody)
  return parsed?.kind === 'parked' ? { touches: parsed.parked.task.touches, runs: runsOf(parsed.parked.task.body) } : { touches: [], runs: [] }
}

export function followsTouches(file: string, reach: FollowingReach): boolean {
  return COMPANION_TABLE.some(row => 'follows' in row && row.follows(file, reach))
}
const MAX_LISTED_TESTS_PER_DIRECTORY = 6
export { COVERING_REASON } from '../../card/covering-tests.js'

export interface Correction {
  field: string
  was: string
  now: string
  reason: string
}

export interface CheckedCard extends DraftCard {
  corrections: Correction[]
  covering: string[]
}

export interface NamedCommand { criterion: string, command: string }

export function movingRefRefusal(witnesses: readonly NamedCommand[]): string | null {
  const named = witnesses.find(witness => MOVING_REF.test(witness.command))
  return named === undefined ? null : `witness "${named.criterion}" names origin/main, which moves while the run goes; compare with HEAD, which the launcher pins at the base`
}

export interface CheckFacts {
  taken: ReadonlySet<number>
  parked: ReadonlySet<number>
  done: ReadonlySet<string>
  merged: ReadonlySet<string>
  repository: RepositoryFacts
  ownerMerges?: OwnerPaths
  published?: readonly string[]
}

export function publishedRootsOf(packageManifestText: string): string[] | undefined {
  let files: unknown
  try {
    files = (JSON.parse(packageManifestText) as { files?: unknown } | null)?.files
  }
  catch {
    return undefined
  }
  if (!Array.isArray(files))
    return undefined
  return files.filter((file): file is string => typeof file === 'string').map(file => file.replace(/^\.\//, '').replace(/\/+$/, ''))
}

export interface OwnerByRisk {
  level: string
  globs: string[]
}

export interface OwnerPaths {
  globs: string[]
  byRisk: OwnerByRisk[]
}

function tableCells(text: string, headerStart: string): string[][] {
  const lines = text.split('\n').map(line => line.trim())
  const header = lines.findIndex(line => line.startsWith(headerStart))
  if (header === -1)
    return []
  const rows = lines.slice(header + 2)
  const end = rows.findIndex(line => !line.startsWith('|'))
  return (end === -1 ? rows : rows.slice(0, end)).map(row => row.split('|').slice(1, -1).map(cell => cell.trim()))
}

const TABLE_ROW = /^\s*\|/
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/
export const SLICE_TABLE_SHAPE = 'a markdown table whose first column names each item: a header row \'| item | what it changes |\', a rule row \'|---|---|\', then one row per item, \'| <item id> | <what the item changes> |\''

export function sliceTableItems(text: string): string[] {
  const lines = text.split('\n')
  return lines.flatMap((line, at) => {
    if (!TABLE_ROW.test(line) || TABLE_RULE.test(line) || TABLE_RULE.test(lines[at + 1] ?? ''))
      return []
    const first = line.split('|')[1]?.trim() ?? ''
    return first === '' ? [] : [first]
  })
}

function globsIn(cell: string | undefined): string[] {
  return [...(cell ?? '').matchAll(BACKTICKED)].map(match => match[1]!)
}

export function ownerPathsOf(ownerMergesText: string): OwnerPaths {
  return {
    globs: tableCells(ownerMergesText, OWNER_KINDS_HEADER).flatMap(cells => globsIn(cells[1])),
    byRisk: tableCells(ownerMergesText, OWNER_BY_RISK_HEADER).map(cells => ({ level: cells[0] ?? '', globs: globsIn(cells[1]) })),
  }
}

function reachesLevel(touches: readonly string[], level: string): boolean {
  const at = RISK_LEVELS.findIndex(candidate => candidate === level)
  return at !== -1 && touches.some(touch => RISK_LEVELS.indexOf(riskOf(touch).level) <= at)
}

function meets(touch: string, glob: string): boolean {
  const pattern = globToRegExp(glob)
  if (!touch.endsWith(PREFIX_SUFFIX))
    return pattern.test(touch)
  const scope = scopeOf(touch)
  return glob.split('*')[0]!.startsWith(`${scope}/`) || pattern.test(`${scope}/${UNDER_PREFIX}`)
}

function heldBy(touches: readonly string[], globs: readonly string[]): { touch: string, glob: string } | undefined {
  for (const touch of touches) {
    const glob = globs.find(candidate => meets(touch, candidate))
    if (glob !== undefined)
      return { touch, glob }
  }
  return undefined
}

function ownerHold(touches: readonly string[], owner: OwnerPaths): { touch: string, glob: string, level?: string } | undefined {
  const byKind = heldBy(touches, owner.globs)
  if (byKind !== undefined)
    return byKind
  for (const row of owner.byRisk.filter(entry => reachesLevel(touches, entry.level))) {
    const byRisk = heldBy(touches, row.globs)
    if (byRisk !== undefined)
      return { ...byRisk, level: row.level }
  }
  return undefined
}

export function correctionText(correction: Correction): string {
  return `${correction.field} — ${correction.was} → ${correction.now} — ${correction.reason}`
}

function includes(values: readonly string[], value: string): boolean {
  return values.includes(value)
}

function numberCorrection(card: DraftCard, assigned: number, facts: CheckFacts): Correction[] {
  const named = card.number
  if (named === undefined || named === assigned)
    return []
  const reason = facts.taken.has(named)
    ? `#${named} is taken by a pull request or issue listed in --taken; numbers are assigned by construct intake`
    : facts.parked.has(named)
      ? `#${named} is taken by the parked card ${named}.md; numbers are assigned by construct intake`
      : 'numbers are assigned by construct intake, the next free after every number taken; a named number is never used'
  return [{ field: 'number', was: `#${named}`, now: `#${assigned}`, reason }]
}

function ownerSentToLadder(task: string): boolean {
  return task.split('\n').some(line => OWNER_LADDER_WORD.test(line.trim()))
}

function contourCorrection(card: DraftCard): Correction[] {
  if (card.contour === undefined)
    return []
  if (!includes(CONTOURS, card.contour))
    return [{ field: 'contour', was: card.contour, now: DEFAULT_CONTOUR, reason: `'${card.contour}' is not one of ${CONTOURS.join(', ')}; every card is ${DEFAULT_CONTOUR} unless the owner sends it to the ladder` }]
  if (card.contour !== LADDER_CONTOUR || ownerSentToLadder(card.task))
    return []
  return [{ field: 'contour', was: LADDER_CONTOUR, now: DEFAULT_CONTOUR, reason: `ladder is refused without the owner's word on this card and a reason written in it, ${LADDER_GRAMMAR}; ${CONTOUR_NOT_FROM_RISK}` }]
}

function ownerReason(touches: readonly string[], owner: OwnerPaths): string | undefined {
  const hold = ownerHold(touches, owner)
  if (hold !== undefined)
    return `${hold.touch} meets ${hold.glob} of ${OWNER_MERGES}${hold.level === undefined ? '' : `, owner by risk ${hold.level}`}`
  const critical = touches.map(riskOf).find(reading => reading.level === OWNER_RISK)
  return critical === undefined ? undefined : `${critical.touch} is risk ${OWNER_RISK}, ${critical.why}`
}

function derivedDecision(decision: string, touches: readonly string[], owner: OwnerPaths): Correction[] {
  if (decision === OWNER_DECISION)
    return []
  const reason = ownerReason(touches, owner)
  if (reason === undefined)
    return decision === AUTO_DECISION ? [] : [{ field: 'decision', was: decision, now: AUTO_DECISION, reason: NO_OWNER_PATH }]
  return [{ field: 'decision', was: decision, now: OWNER_DECISION, reason }]
}

function unstatedDecision(card: DraftCard, touches: readonly string[], owner: OwnerPaths | undefined): string | undefined {
  if (card.decision !== undefined || owner === undefined || !includes(KINDS, card.kind) || !includes(decisionsOf(card.kind as Kind), OWNER_DECISION))
    return undefined
  return ownerReason(touches, owner) === undefined ? AUTO_DECISION : OWNER_DECISION
}

function decisionCorrection(card: DraftCard, touches: readonly string[], owner: OwnerPaths | undefined): Correction[] {
  if (card.decision === undefined || !includes(KINDS, card.kind))
    return []
  const decisions: readonly string[] = decisionsOf(card.kind as Kind)
  if (owner !== undefined && includes(decisions, OWNER_DECISION))
    return derivedDecision(card.decision, touches, owner)
  if (includes(decisions, card.decision))
    return []
  return [{ field: 'decision', was: card.decision, now: decisions[0]!, reason: `kind ${card.kind} takes decision ${decisions.join(' or ')}, not ${card.decision}` }]
}

function candidatesText(candidates: readonly string[]): string {
  return candidates.length === 0 ? 'no path is' : `${candidates.length} paths: ${candidates.join(', ')} are`
}

interface Touched {
  touches: string[]
  corrections: Correction[]
  unclear: UnclearField[]
}

const ROUTE_TOUCH = /^\//
const PACKAGE_TOUCH = /^@/
const HOST_TOUCH = /^(?:localhost|(?:[a-z0-9-]+\.)+(?:ai|app|cloud|co|com|dev|edu|gov|info|io|net|org|ru))(?::\d+)?(?:\/|$)/

function nonPathShape(entry: string, repository: RepositoryFacts, created: readonly string[]): string | null {
  if (ROUTE_TOUCH.test(entry))
    return 'a route'
  if (withinTouches(entry, created) || repository.exists(scopeOf(entry)))
    return null
  if (PACKAGE_TOUCH.test(entry))
    return 'a package name'
  return HOST_TOUCH.test(entry) ? 'a host' : null
}

export function nonPathTouchRefusals(cards: readonly DraftCard[], repository: RepositoryFacts): string[] {
  return cards.flatMap((card) => {
    const created = createdPaths(card.creates)
    return card.touches.flatMap((entry) => {
      const shape = nonPathShape(entry, repository, created)
      return shape === null ? [] : [`${card.name}: touches entry '${entry}' reads as ${shape}, not a repository path; touches hold only paths from the repository root, and a path the change makes is listed under creates`]
    })
  })
}

function touchesChecked(card: DraftCard, repository: RepositoryFacts): Touched {
  const touched: Touched = { touches: [], corrections: [], unclear: [] }
  const creates = createdPaths(card.creates)
  for (const parsed of card.creates.map(parseCreatesEntry)) {
    if (parsed.kind === 'refused')
      touched.unclear.push({ field: 'creates', reason: parsed.reason })
  }
  for (const entry of card.touches) {
    if (touchError(entry) !== null) {
      touched.touches.push(entry)
      continue
    }
    const created = withinTouches(entry, creates)
    const prefix = entry.endsWith(PREFIX_SUFFIX) ? PREFIX_SUFFIX : ''
    const scope = prefix === '' ? entry : entry.slice(0, -PREFIX_SUFFIX.length)
    if (repository.exists(scope)) {
      touched.touches.push(entry)
      if (creates.includes(entry))
        touched.corrections.push({ field: 'creates', was: entry, now: '(exists, not new)', reason: `${entry} already exists` })
      continue
    }
    const segment = scope.slice(scope.lastIndexOf('/') + 1)
    const candidates = created ? [] : repository.pathsNamed(segment)
    if (candidates.length === 1) {
      touched.touches.push(`${candidates[0]}${prefix}`)
      touched.corrections.push({ field: 'touches', was: entry, now: `${candidates[0]}${prefix}`, reason: `'${scope}' does not exist; '${candidates[0]}' is the only path named '${segment}'` })
      continue
    }
    touched.touches.push(entry)
    if (!created)
      touched.unclear.push({ field: 'touches', reason: `'${scope}' does not exist and ${candidatesText(candidates)} named '${segment}'; list it under creates if the change makes it` })
  }
  return touched
}

function covers(touch: string, companion: string): boolean {
  return touch === companion || (touch.endsWith(PREFIX_SUFFIX) && under(companion, scopeOf(touch)))
}

function withCompanions<T extends Touched>(touched: T, runs: readonly string[], repository: RepositoryFacts, published: readonly string[]): T {
  const missing: string[] = []
  for (const row of COMPANION_TABLE) {
    if (!('companions' in row) || !repository.exists(row.keptBy))
      continue
    for (const entry of touched.touches.filter(touch => row.touched(touch, published))) {
      const touches = [...touched.touches, ...missing]
      for (const companion of row.companions(entry, [...touches, ...runs], repository)) {
        if (repository.exists(scopeOf(companion)) && !touches.some(touch => covers(touch, companion)))
          missing.push(companion)
      }
    }
  }
  return {
    ...touched,
    touches: [...touched.touches, ...missing],
    corrections: [...touched.corrections, ...missing.map(companion => ({ field: 'touches', was: '(absent)', now: companion, reason: COMPANION_REASON }))],
  }
}

function directoryOf(file: string): string {
  return file.slice(0, file.lastIndexOf('/'))
}

function listedCovering(tests: readonly string[]): string[] {
  const byDirectory = new Map<string, string[]>()
  for (const test of tests)
    byDirectory.set(directoryOf(test), [...(byDirectory.get(directoryOf(test)) ?? []), test])
  return [...byDirectory].flatMap(([directory, members]) => members.length > MAX_LISTED_TESTS_PER_DIRECTORY ? [`${directory}${PREFIX_SUFFIX}`] : members)
}

function coveringRuns(touches: readonly string[], repository: RepositoryFacts): string[] {
  return listedCovering(repository.testsCovering(touches).filter(test => !touches.some(touch => covers(touch, test))))
}

interface Linked {
  kept: string[]
  corrections: Correction[]
  unclear: UnclearField[]
}

function referencesChecked(field: 'depends' | 'blocks', references: readonly string[], facts: CheckFacts): Linked {
  const linked: Linked = { kept: [], corrections: [], unclear: [] }
  for (const reference of references) {
    const id = CARD_REFERENCE.exec(reference)?.[1]
    if (id === undefined) {
      linked.kept.push(reference)
    }
    else if (facts.merged.has(id)) {
      linked.corrections.push({ field, was: reference, now: '(removed)', reason: 'already merged' })
    }
    else {
      linked.kept.push(reference)
      if (!facts.parked.has(Number(id)) && !facts.done.has(id))
        linked.unclear.push({ field, reason: `'${reference}' is neither a parked card, done nor merged in the journal` })
    }
  }
  return linked
}

function movingRefsUnclear(witness: string): UnclearField[] {
  return [...witness.matchAll(BACKTICKED)].flatMap(([, command]) => {
    const moving = movingRefRefusal([{ criterion: witness.trim(), command: command! }])
    return moving === null ? [] : [{ field: 'witnesses', reason: moving }]
  })
}

function bashSyntaxUnclear(witness: string): UnclearField[] {
  return [...witness.matchAll(BACKTICKED)].flatMap(([, command]) => {
    const problem = bashSyntaxProblem(command!)
    return problem === null ? [] : [{ field: 'witnesses', reason: `witness "${witness.trim()}" fails bash -n: ${problem}` }]
  })
}

function proseUnclear(witness: string): UnclearField[] {
  const step = PROSE_STEP.exec(witness.replace(BACKTICKED, ''))?.[0]
  return step === undefined ? [] : [{ field: 'witnesses', reason: `witness "${witness.trim()}" is written as prose: '${step}' is a step no command runs; a witness is a command and its exit` }]
}

function outsidePath(command: string): string | undefined {
  const word = commandWord(command)
  if (word !== undefined && HOME_REFERENCE.test(word))
    return word
  return commandArguments(command).find(token => HOME_REFERENCE.test(token) || (path.isAbsolute(token) && !token.startsWith(DEVICE_ROOT)))
}

function outsidePathsUnclear(commands: readonly string[], witness: string): UnclearField[] {
  return commands.flatMap((command) => {
    const outside = outsidePath(command)
    return outside === undefined ? [] : [{ field: 'witnesses', reason: `witness "${witness.trim()}" names ${outside}, a path outside the worktree the witness runs in; the tree under test cannot change it, so the witness cannot be red on the base` }]
  })
}

interface WitnessReach { repository: RepositoryFacts, created: readonly string[] }

function namedPaths(command: string, reach: WitnessReach): string[] {
  return pathsNamedBy(command, relative => reach.repository.exists(relative) || withinTouches(relative, reach.created))
}

function readsTheTree(command: string, reach: WitnessReach): boolean {
  const word = commandWord(command) ?? ''
  if (TREE_READING_COMMANDS.has(word)) {
    const named = commandArguments(command)
    return named.length === 0 || named.some(token => !INFORMATION_FLAGS.has(token))
  }
  return namedPaths(command, reach).length > 0
}

function headIndependentUnclear(commands: readonly string[], witness: string, reach: WitnessReach): UnclearField[] {
  return commands.some(command => readsTheTree(command, reach)) ? [] : [{ field: 'witnesses', reason: `witness "${witness.trim()}" reads nothing the tree under test can change; its result does not depend on the head` }]
}

export function unjudgedCommand(command: string): string {
  return commandInsideJudgedWrap(command) ?? command
}

export function isChangeWitness(witness: string): boolean {
  return (witnessKindField(witness) ?? (CHANGE_WITNESS_WORDING.test(witness) ? CHANGE_WITNESS_KIND : undefined)) === CHANGE_WITNESS_KIND
}

function baseGreenUnclear(card: DraftCard, commands: readonly string[], witness: string, reach: WitnessReach): UnclearField[] {
  if (card.kind !== IMPLEMENT_KIND || !isChangeWitness(witness) || commands.some(command => namesATest(command) || namedPaths(command, reach).length > 0))
    return []
  return [{ field: 'witnesses', reason: `witness "${witness.trim()}" is to be red on the base, but it names no path of the repository or of the card's creates; a whole-tree command is green on a clean base, so the witness cannot be red on the base: name the file the change makes red, or list it under creates` }]
}

function witnessesUnclear(card: DraftCard, repository: RepositoryFacts): UnclearField[] {
  const reach: WitnessReach = { repository, created: createdPaths(card.creates) }
  return card.witnesses.flatMap((witness) => {
    const commands = [...witness.matchAll(BACKTICKED)].map(match => match[1]!).filter(command => (commandWord(command) ?? '') !== '')
    const words = commands.map(command => commandWord(command)!)
    if (words.length === 0)
      return [{ field: 'witnesses', reason: `'${witness.trim()}' names no command; a witness is run by a command` }]
    const unresolved = [...new Set(words)].filter(word => !repository.commandResolves(word))
    return [
      ...unresolved.map(word => ({ field: 'witnesses', reason: `'${word}' is not on PATH and is no file of the repository` })),
      ...movingRefsUnclear(witness),
      ...bashSyntaxUnclear(witness),
      ...proseUnclear(witness),
      ...outsidePathsUnclear(commands, witness),
      ...(unresolved.length === 0 ? headIndependentUnclear(commands, witness, reach) : []),
      ...baseGreenUnclear(card, commands, witness, reach),
    ]
  })
}

function testNamePatterns(witness: string): string[] {
  return [...witness.matchAll(BACKTICKED)].flatMap(command => [...command[1]!.matchAll(TEST_NAME_ARGUMENT)].map(match => match[1] ?? match[2]?.replace(/\\([\\"$`])/g, '$1') ?? match[3]!))
}

export function invalidTestPatterns(cards: readonly DraftCard[]): string[] {
  return cards.flatMap(card => card.witnesses.flatMap(witness => testNamePatterns(witness).flatMap((pattern) => {
    try {
      return new RegExp(pattern, '') && []
    }
    catch (error) {
      return [`${witness.trim()} — ${error instanceof Error ? error.message : String(error)}`]
    }
  })))
}

function runsUnclear(card: DraftCard): UnclearField[] {
  return (card.runs ?? []).filter(entry => !isTestScope(entry)).map(entry => ({ field: 'runs', reason: `'${entry}' is not a test or a tree of tests, so nothing runs it; name a test path or drop it` }))
}

function byFieldOrder(corrections: Correction[]): Correction[] {
  return [...corrections].sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field))
}

function checkCard(card: DraftCard, assigned: number, facts: CheckFacts): CheckedCard {
  const checked = touchesChecked(card, facts.repository)
  const covering = coveringRuns(checked.touches, facts.repository)
  const touched = withCompanions(checked, [...covering, ...(card.runs ?? [])], facts.repository, facts.published ?? [])
  const runs = covering.filter(test => !touched.touches.some(touch => covers(touch, test)))
  const depends = referencesChecked('depends', card.depends, facts)
  const blocks = referencesChecked('blocks', card.blocks, facts)
  const contour = contourCorrection(card)
  const decided = touchedOrCreated(touched.touches, createdPaths(card.creates))
  const decision = decisionCorrection(card, decided, facts.ownerMerges)
  return {
    ...card,
    contour: contour[0]?.now ?? card.contour,
    decision: decision[0]?.now ?? card.decision ?? unstatedDecision(card, decided, facts.ownerMerges),
    ...(runs.length === 0 ? {} : { runs: [...new Set([...(card.runs ?? []), ...runs])] }),
    touches: touched.touches,
    covering: runs,
    depends: depends.kept,
    blocks: blocks.kept,
    unclear: [
      ...card.unclear,
      ...touched.unclear,
      ...depends.unclear,
      ...blocks.unclear,
      ...witnessesUnclear(card, facts.repository),
      ...runsUnclear(card),
    ],
    corrections: byFieldOrder([
      ...numberCorrection(card, assigned, facts),
      ...contour,
      ...decision,
      ...touched.corrections,
      ...depends.corrections,
      ...blocks.corrections,
    ]),
  }
}

export function checkDraft(cards: readonly DraftCard[], numbers: readonly number[], facts: CheckFacts): CheckedCard[] {
  return cards.map((card, index) => checkCard(card, numbers[index]!, facts))
}

export const PLAN_FIELD = 'plan'

export interface PlanLink {
  id: string
  title: string
  goal: string
  file: string
}

export type CheckedPlan = { kind: 'plan', link: PlanLink } | { kind: 'refused', reasons: string[] }

function planFileRefusal(plan: DraftPlan, file: string, dir: string): string | null {
  if (path.isAbsolute(plan.file) || !isWithin(dir, file))
    return `plan ${plan.id}: ${plan.file} is outside the repository ${dir}; keep the plan file in the repository and name it by its path from the root`
  if (!existsSync(file))
    return `plan ${plan.id}: ${plan.file} does not exist in the repository`
  return null
}

function itemRefusals(cards: readonly DraftCard[], plan: DraftPlan, items: readonly string[]): string[] {
  return cards.flatMap((card) => {
    if (card.item === undefined)
      return [`${card.name}: names no 'item' of plan ${plan.id}; every card of a planned draft links to the row of the slice table it carries`]
    return items.includes(card.item) ? [] : [`${card.name}: item '${card.item}' has no row in the slice table of ${plan.file}; add the row, or name one of ${items.join(', ')}`]
  })
}

export function checkPlan(plan: DraftPlan | undefined, cards: readonly DraftCard[], dir: string): CheckedPlan | null {
  if (plan === undefined) {
    const named = cards.filter(card => card.item !== undefined).map(card => card.name)
    return named.length === 0 ? null : { kind: 'refused', reasons: [`${named.join(', ')} name an 'item', but the draft names no 'plan' to hold it`] }
  }
  const file = path.resolve(dir, plan.file)
  const fileRefused = planFileRefusal(plan, file, dir)
  if (fileRefused !== null)
    return { kind: 'refused', reasons: [fileRefused] }
  const items = sliceTableItems(readFileSync(file, 'utf8'))
  if (items.length === 0)
    return { kind: 'refused', reasons: [`plan ${plan.id}: ${plan.file} has no slice table; add ${SLICE_TABLE_SHAPE}`] }
  const reasons = itemRefusals(cards, plan, items)
  return reasons.length > 0 ? { kind: 'refused', reasons } : { kind: 'plan', link: { ...plan, file } }
}
