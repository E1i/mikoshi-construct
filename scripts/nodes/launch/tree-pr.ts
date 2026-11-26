import type { Contour } from '../../../src/card/grammar.js'
import type { ShiftTask } from '../../../src/card/task-file.js'
import type { PushPolicy } from '../../../src/commands/attach/record.js'
import type { AdmittedReach, CompanionRow } from '../../../src/commands/intake/check.js'
import type { BusCatalog } from '../../ci/card-runs.js'
import type { Prediction } from '../../policy/morse/rules.js'
import type { CompositionRecord, FollowingReach, GrownDerived, RefusedDerived } from '../../policy/touch-scope.js'
import type { GhRunner } from '../../ports/gh.js'
import type { TreeRun } from '../../ports/git.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { COVERING_REASON, importersOf, layerMasksOf, runsOf, TestCoverage } from '../../../src/card/covering-tests.js'
import { CARD_PATH_REASON } from '../../../src/card/grammar.js'
import { admittedReachOf, COMPANION_TABLE, FOLLOWING_REASON, PACKAGE_MANIFEST, publishedRootsOf } from '../../../src/commands/intake/check.js'
import { readShiftGate } from '../../../src/manifest.js'
import { busCheckCatalog, cardReadingOf } from '../../ci/card-runs.js'
import { parseCompositionModel } from '../../composition/model.js'
import { commandLine, GENERATED_FILES, pathsRebuiltBy } from '../../core/generated-files.js'
import { VERIFICATION_WORDS } from '../../core/verification.js'
import { growthToAsk } from '../../policy/derived-files.js'
import { classify, MorseRefusal } from '../../policy/morse/rules.js'
import { MATRIX_COUNT_LINE, pathWithoutMatrix } from '../../policy/policy.js'
import { matchGlob } from '../../policy/shredder/glob.js'
import { COMPOSITION_ROOT, derivedGrowthLine, derivedRefusalLine, derivedVerdictOf, followsTouches, isRegisteredDerived, neverFollows, OWNER_MERGES, pathsOutside, runsCover, TEST_ROOTS, withinTouches } from '../../policy/touch-scope.js'
import { ownerGlobs } from '../../policy/widening.js'
import { changedFilesFrom } from '../../ports/diff.js'
import { pnpmRerun, throughGitPort, treeReading } from '../../ports/git.js'

export const REFUSAL_REASONS = {
  'stale-base': 'a',
  'no-changeset': 'a',
  'no-matrix-line': 'a',
  'twin-unbuilt': 'a',
  'derived-unreproduced': 'a',
  'outside-touches': 'b',
  'no-card-body': 'c',
  'card-unparsed': 'c',
  'commit-push-failed': 'c',
  'no-pr-url': 'c',
} as const

export type RefusalReason = keyof typeof REFUSAL_REASONS
export type RefusalClass = typeof REFUSAL_REASONS[RefusalReason]

export interface Gap {
  reason: RefusalReason
  task: string
  paths: string[]
}

export type TreePr = { kind: 'pr', number: string, followed: string[] } | { kind: 'clean' } | { kind: 'kept' } | { kind: 'problem', why: string, gaps: Gap[] }

export interface Refusal {
  code: string
  class: RefusalClass
  tasks: string[]
  paths: string[]
}

const CLASS_WEIGHT: Record<RefusalClass, number> = { a: 0, b: 1, c: 2 }

export function refusalOf(gaps: readonly Gap[]): Refusal {
  const worst = gaps.map(gap => REFUSAL_REASONS[gap.reason]).reduce((left, right) => CLASS_WEIGHT[right] > CLASS_WEIGHT[left] ? right : left)
  const decisive = gaps.filter(gap => REFUSAL_REASONS[gap.reason] === worst)
  return {
    code: `${worst}:${[...new Set(decisive.map(gap => gap.reason))].sort().join('+')}`,
    class: worst,
    tasks: decisive.map(gap => gap.task).filter(task => task !== ''),
    paths: decisive.flatMap(gap => gap.paths),
  }
}

export function faultGaps(reason: RefusalReason): Gap[] {
  return [{ reason, task: '', paths: [] }]
}

export type TwinRebuild = (cwd: string, args: readonly string[]) => { status: number | null, stderr: string }

export interface TreePrPorts {
  git: (cwd: string, args: string[]) => string
  gh: GhRunner
  pushPolicy?: (worktree: string) => PushPolicy
  rebuild?: TwinRebuild
  ownerWait?: OwnerWaitOpener
  allowances?: (cardId: number) => readonly string[]
  closedWaitTexts?: (cardId: number) => readonly string[]
}

export type OwnerWaitOpener = (cardId: number | null, text: string) => string

const PR_URL_NUMBER = /\/pull\/(\d+)\s*$/

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
}

export interface TreeCard {
  branch: string
  title: string
  commitMessage: string
  cardLine: string
  contour: Contour
  touches: string[]
  runs: string[]
  namedPathReason: string | null
  fullReading?: string
  cardId?: number
}

export function shiftTreeCard(task: ShiftTask, catalog: BusCatalog = busCheckCatalog()): TreeCard {
  const { runs, fullReading } = cardReadingOf(task.touches, runsOf(task.body), layerMasksOf(task.body), catalog)
  return {
    branch: task.branch,
    title: `${task.card.name} (#${task.id})`,
    commitMessage: `${task.card.name} (#${task.id})\n\nCommitted by the shift from the card's worktree after its session ended.`,
    cardLine: task.card.line,
    contour: task.card.contour,
    touches: task.touches,
    runs,
    namedPathReason: CARD_PATH_REASON.exec(task.body)?.[1]?.trim() ?? null,
    ...(Number.isInteger(Number(task.id)) ? { cardId: Number(task.id) } : {}),
    ...(fullReading === undefined ? {} : { fullReading }),
  }
}

const PR_BASE = 'origin/main'
const MERGE_HEAD = 'MERGE_HEAD'
const SHIFTED_RANGE = `${PR_BASE}...HEAD`
const PUBLISHED_CODE = COMPANION_TABLE.find(row => row.kind === 'published code') as CompanionRow
const CHANGESET_FILE = /^\.changeset\/(?!readme\.md$)[^/]+\.md$/i
const COMPOSITION_MODEL_SUFFIX = '.yaml'
const CHEAP_DEFAULT_REASON = 'cheap holds as the default path of D-224'
const REMOVED_LINE = /^-(?!--)(.*)$/gm
const IMPORT_OR_BLANK = /^\s*(?:import\s.*)?$/

interface DiffEntry {
  path: string
  status: string
}

function nameStatusOf(git: TreePrPorts['git'], worktree: string): string {
  return git(worktree, ['diff', '--no-renames', '-z', '--name-status', SHIFTED_RANGE])
}

function diffEntriesOf(nameStatus: string): DiffEntry[] {
  const records = nameStatus.split('\0').filter(record => record !== '')
  return Array.from({ length: Math.floor(records.length / 2) }, (_, index) => ({ status: records[2 * index]!, path: records[2 * index + 1]! }))
}

function removesOnlyImportsOrBlanks(git: TreePrPorts['git'], worktree: string, files: string[]): boolean {
  const patch = git(worktree, ['diff', '--no-renames', '-U0', SHIFTED_RANGE, '--', ...files])
  return [...patch.matchAll(REMOVED_LINE)].every(([, line]) => IMPORT_OR_BLANK.test(line!))
}

function reportPathReason(report: string | null): string | null {
  return report === null ? null : CARD_PATH_REASON.exec(report)?.[1]?.trim() ?? null
}

function pathReason(git: TreePrPorts['git'], worktree: string, card: TreeCard, prediction: Prediction, report: string | null): string {
  if (prediction.verdict === card.contour)
    return `the card's contour and MORSE agree`
  if (card.contour === 'ladder')
    return 'the card takes the ladder by its contour where MORSE predicts cheap'
  if (card.namedPathReason !== null)
    return `cheap holds by the card's D-76 reason: ${card.namedPathReason}`
  const reported = reportPathReason(report)
  if (reported !== null)
    return `cheap holds by the session report's D-76 reason: ${reported}`
  if (prediction.rule === 'tests-shrunk' && removesOnlyImportsOrBlanks(git, worktree, prediction.why))
    return `cheap holds: the shrunk test files are ${prediction.why.join(', ')}, and every line the diff removes from them is an import or blank`
  return CHEAP_DEFAULT_REASON
}

interface ShiftedPath {
  line: string
  files: DiffEntry[]
}

function predictedLine(git: TreePrPorts['git'], worktree: string, card: TreeCard, report: string | null, nameStatus: string): string {
  try {
    const prediction = classify(changedFilesFrom(nameStatus, git(worktree, ['diff', '--no-renames', '-z', '--numstat', SHIFTED_RANGE])))
    return `Path: ${card.contour} · MORSE predicts ${prediction.verdict} by rule ${prediction.rule} (${prediction.why.join(', ')}) · ${pathReason(git, worktree, card, prediction, report)}`
  }
  catch (error) {
    if (!(error instanceof MorseRefusal))
      throw error
    return `Path: ${card.contour} · MORSE gave no prediction: ${error.message} · the ${card.contour} path is held without a named reason`
  }
}

function shiftedPath(git: TreePrPorts['git'], worktree: string, card: TreeCard, report: string | null): ShiftedPath {
  const nameStatus = nameStatusOf(git, worktree)
  return { line: predictedLine(git, worktree, card, report, nameStatus), files: diffEntriesOf(nameStatus) }
}

function publishedRootsAt(git: TreePrPorts['git'], worktree: string): string[] {
  let manifest: string
  try {
    manifest = git(worktree, ['show', `HEAD:${PACKAGE_MANIFEST}`])
  }
  catch {
    return []
  }
  return publishedRootsOf(manifest) ?? []
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return null
  }
}

export interface TouchesFollowed {
  followed: string[]
  outside: string[]
}

function worktreeFiles(git: TreePrPorts['git'], worktree: string): string[] {
  return listedOrNone(() => git(worktree, ['ls-files', '--cached', '--others', '--exclude-standard']))
}

export function worktreeCoverage(git: TreePrPorts['git'], worktree: string): TestCoverage {
  return new TestCoverage(() => worktreeFiles(git, worktree), file => readOrNull(path.join(worktree, file)))
}

interface ConceptReach {
  touches: readonly string[]
  creates: readonly string[]
}

export const CONCEPT_RULES = {
  reaches: (file: string, concept: ConceptReach): boolean => pathsOutside(concept.touches, concept.creates, [file]).length === 0,
  neverFollows: (file: string, concept: ConceptReach): boolean => isRegisteredDerived(file) || neverFollows(file, { touches: [...concept.touches], added: new Set(), compositionRecords: [] }),
  testRoots: TEST_ROOTS,
}

export function worktreeImporters(git: TreePrPorts['git'], worktree: string): Map<string, string[]> {
  return importersOf(worktreeFiles(git, worktree), file => readOrNull(path.join(worktree, file)))
}

function listedOrNone(list: () => string): string[] {
  try {
    return list().split('\n').filter(file => file !== '')
  }
  catch {
    return []
  }
}

export function addedSinceBase(git: TreePrPorts['git'], worktree: string, files: readonly string[]): Set<string> {
  const atBase = new Set(listedOrNone(() => git(worktree, ['ls-tree', '-r', '--name-only', PR_BASE])))
  return new Set(atBase.size === 0 ? [] : files.filter(file => !atBase.has(file)))
}

function recordAtBase(git: TreePrPorts['git'], worktree: string, file: string): CompositionRecord[] {
  try {
    return [parseCompositionModel(git(worktree, ['show', `${PR_BASE}:${file}`]), file)]
  }
  catch {
    return []
  }
}

export function compositionRecordsAtBase(git: TreePrPorts['git'], worktree: string): CompositionRecord[] {
  return listedOrNone(() => git(worktree, ['ls-tree', '-r', '--name-only', PR_BASE, `${COMPOSITION_ROOT}/`]))
    .filter(file => file.endsWith(COMPOSITION_MODEL_SUFFIX))
    .flatMap(file => recordAtBase(git, worktree, file))
}

export interface DerivedSplit {
  followed: string[]
  refused: RefusedDerived[]
  grown: GrownDerived[]
  rest: string[]
}

export function derivedSplit(git: TreePrPorts['git'], worktree: string, outside: readonly string[], run: TreeRun, allowances: readonly string[] = [], closedWaitTexts: readonly string[] = []): DerivedSplit {
  const derived = outside.filter(isRegisteredDerived)
  const rest = outside.filter(file => !isRegisteredDerived(file))
  if (derived.length === 0)
    return { followed: [], refused: [], grown: [], rest }
  const verdict = derivedVerdictOf(derived, treeReading(git, worktree, PR_BASE, run))
  const grown = growthToAsk(verdict.grown, allowances, closedWaitTexts)
  const stillGrown = new Set(grown.map(each => each.file))
  const allowed = verdict.grown.map(each => each.file).filter(file => !stillGrown.has(file))
  return { followed: inOrderOf(derived, verdict.followed, allowed), refused: verdict.refused, grown, rest }
}

function heldBack(split: DerivedSplit): string[] {
  return [...split.refused.map(each => each.file), ...split.grown.map(each => each.file)]
}

function inOrderOf(outside: readonly string[], ...lists: (readonly string[])[]): string[] {
  const kept = new Set(lists.flat())
  return outside.filter(file => kept.has(file))
}

export function touchesFollowed(outside: readonly string[], reach: FollowingReach, coverage: TestCoverage): TouchesFollowed {
  if (outside.length === 0)
    return { followed: [], outside: [] }
  const covering = new Set(coverage.of(reach.touches))
  const follows = (file: string): boolean => !neverFollows(file, reach) && (covering.has(file) || followsTouches(file, reach))
  return { followed: outside.filter(follows), outside: outside.filter(file => !follows(file)) }
}

function admittedMasksOf(cardBody: string | null, reach: AdmittedReach): string[] {
  return reach.touches.length === 0 && reach.runs.length === 0 ? [] : layerMasksOf(cardBody ?? '')
}

export function answerFollowed(git: TreePrPorts['git'], worktree: string, outside: readonly string[], cardId: number, cardBody: string | null, coverage: TestCoverage, catalog: BusCatalog = busCheckCatalog(), run: TreeRun = pnpmRerun, allowances: readonly string[] = []): TouchesFollowed {
  const reach = admittedReachOf(cardId, cardBody)
  const { runs } = cardReadingOf(reach.touches, reach.runs, admittedMasksOf(cardBody, reach), catalog)
  const unrun = outside.filter(file => !runsCover(file, runs))
  if (unrun.length === 0)
    return { followed: [], outside: [] }
  const derived = derivedSplit(git, worktree, unrun, run, allowances)
  const touched = touchesFollowed(derived.rest, { touches: reach.touches, added: addedSinceBase(git, worktree, derived.rest), compositionRecords: compositionRecordsAtBase(git, worktree) }, coverage)
  return { followed: inOrderOf(unrun, touched.followed, derived.followed), outside: inOrderOf(unrun, touched.outside, heldBack(derived)) }
}

export function followedLine(followed: readonly string[]): string {
  return `Touches followed: ${followed.join(', ')} (${COVERING_REASON}; ${FOLLOWING_REASON})`
}

interface ChangedOutside extends TouchesFollowed {
  refused: RefusedDerived[]
  grown: GrownDerived[]
}

interface OwnerHeard {
  allowances: readonly string[]
  closedWaitTexts: readonly string[]
}

export function ownerHeardOn(ports: Pick<TreePrPorts, 'allowances' | 'closedWaitTexts'>, cardId: number | undefined): OwnerHeard {
  if (cardId === undefined)
    return { allowances: [], closedWaitTexts: [] }
  return { allowances: ports.allowances?.(cardId) ?? [], closedWaitTexts: ports.closedWaitTexts?.(cardId) ?? [] }
}

function changedOutsideTouches(git: TreePrPorts['git'], worktree: string, files: readonly DiffEntry[], card: TreeCard, run: TreeRun, heard: OwnerHeard): ChangedOutside {
  const outside = files.map(file => file.path).filter(file => !withinTouches(file, card.touches) && !runsCover(file, card.runs))
  const derived = derivedSplit(git, worktree, outside, run, heard.allowances, heard.closedWaitTexts)
  const added = new Set(files.filter(file => file.status === 'A').map(file => file.path))
  const compositionRecords = derived.rest.length === 0 ? [] : compositionRecordsAtBase(git, worktree)
  const touched = touchesFollowed(derived.rest, { touches: card.touches, added, compositionRecords }, worktreeCoverage(git, worktree))
  return { followed: inOrderOf(outside, touched.followed, derived.followed, derived.grown.map(each => each.file)), outside: touched.outside, refused: derived.refused, grown: derived.grown }
}

function derivedGaps(worktree: string, refused: readonly RefusedDerived[]): FormatGap[] {
  return refused.length === 0 ? [] : [{ reason: 'derived-unreproduced', lacks: `derived files its generators reproduce: ${derivedRefusalLine(refused)}`, task: `rerun the registered generator of ${refused.map(each => each.file).join(', ')} in ${worktree} and keep exactly what it writes, or undo the change; never edit a derived file by hand (D-592)`, paths: refused.map(each => each.file) }]
}

function grownLine(grown: readonly GrownDerived[]): string {
  return grown.length === 0 ? '' : `\n\nDerived growth waits for the owner: ${derivedGrowthLine(grown)}`
}

function openGrowthWait(ports: TreePrPorts, card: TreeCard, pr: string, grown: readonly GrownDerived[]): void {
  if (grown.length > 0)
    ports.ownerWait?.(card.cardId ?? null, `${card.cardLine} · pull request #${pr}: ${derivedGrowthLine(grown)}`)
}

function unwaitedGrowth(ports: TreePrPorts, grown: readonly GrownDerived[]): RefusedDerived[] {
  return ports.ownerWait === undefined ? grown.map(each => ({ file: each.file, why: `${derivedGrowthLine([each])}, and this shift has no owner wait to open for it` })) : []
}

interface FormatGap extends Gap {
  lacks: string
}

function fullReadingNote(why: string | undefined): string {
  return why === undefined ? '' : `; Runs read in full: ${why}, so only the paths the card names count as its runs`
}

function matrixGap(unmatrixed: string, codeMatrix: string): FormatGap {
  return { reason: 'no-matrix-line', lacks: `the code matrix count line ■ n □ n · n its change to ${unmatrixed} requires (${codeMatrix})`, task: `write the code matrix of ${codeMatrix} and its count line ■ n □ n · n into the shift report`, paths: [] }
}

function formatGaps(body: string, shifted: ShiftedPath, publishedRoots: readonly string[], outsideTouches: readonly string[], codeMatrix: string | null, fullReading: string | undefined): FormatGap[] {
  const paths = shifted.files.map(file => file.path)
  const unmatrixed = codeMatrix === null ? undefined : pathWithoutMatrix(body, paths)
  const published = paths.find(file => PUBLISHED_CODE.touched(file, publishedRoots))
  const changeset = shifted.files.some(file => file.status !== 'D' && CHANGESET_FILE.test(file.path))
  const gaps: FormatGap[] = []
  if (codeMatrix !== null && unmatrixed !== undefined)
    gaps.push(matrixGap(unmatrixed, codeMatrix))
  if (published !== undefined && !changeset)
    gaps.push({ reason: 'no-changeset', lacks: `the changeset its change to the published ${published} requires`, task: `add a .changeset/*.md file for the change to ${published}`, paths: [] })
  if (outsideTouches.length > 0)
    gaps.push({ reason: 'outside-touches', lacks: `the card's touches for ${outsideTouches.join(', ')}, which it changes outside them (only a test that covers a touched file, a generated twin or the changeset of a touched file, a composition record or its document whose node the touches reach at the base, or one of the card's runs, may change outside the touches, and never a .claude, owner-merges, security or other R1 path)${fullReadingNote(fullReading)}`, task: '', paths: [...outsideTouches] })
  return gaps
}

export function matrixCountLineOf(report: string | null): string | undefined {
  return report === null ? undefined : MATRIX_COUNT_LINE.exec(report)?.[0]
}

export interface ReportClosing {
  report: string
  verification: string
}

const REPORT_PATH_LINE = /^Report:\s*(\S+)\s*$/m
const VERIFICATION_LINE = /^verification:\s*(\S+)\s*$/m

export function reportClosingOf(report: string | null): ReportClosing | null {
  const written = report === null ? undefined : REPORT_PATH_LINE.exec(report)?.[1]
  const verification = report === null ? undefined : VERIFICATION_LINE.exec(report)?.[1]
  if (written === undefined || verification === undefined || !(VERIFICATION_WORDS as readonly string[]).includes(verification))
    return null
  return { report: written, verification }
}

function prBodyOf(card: TreeCard, path: string, touched: ChangedOutside, countLine: string | undefined): string {
  const followedLines = touched.followed.length === 0 ? '' : `\n\n${followedLine(touched.followed)}`
  const body = `${card.cardLine}\n\n${path}${followedLines}${grownLine(touched.grown)}\n\nOpened by the shift from the card's worktree and branch after its session ended.`
  return countLine === undefined ? body : `${body}\n\n${countLine}`
}

function openPrOf(ports: TreePrPorts, branch: string): string | null {
  const open = JSON.parse(ports.gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'])) as { number: number }[]
  return open.length === 0 ? null : String(open[0]!.number)
}

function openPrMatrixGap(ports: TreePrPorts, worktree: string, pr: string, report: string | null): FormatGap | null {
  const codeMatrix = readShiftGate(worktree).codeMatrix
  if (codeMatrix === null)
    return null
  const body = ports.gh(['pr', 'view', pr, '--json', 'body', '-q', '.body']).trimEnd()
  const unmatrixed = pathWithoutMatrix(body, diffEntriesOf(nameStatusOf(ports.git, worktree)).map(file => file.path))
  if (unmatrixed === undefined)
    return null
  const countLine = matrixCountLineOf(report)
  if (countLine === undefined)
    return matrixGap(unmatrixed, codeMatrix)
  ports.gh(['pr', 'edit', pr, '--body', `${body}\n\n${countLine}`])
  return null
}

function lacking(branch: string, gaps: readonly FormatGap[]): TreePr {
  return { kind: 'problem', why: `the shift opened no pull request for ${branch}: it lacks ${gaps.map(gap => gap.lacks).join('; ')}`, gaps: gaps.map(({ reason, task, paths }) => ({ reason, task, paths })) }
}

export interface FreshBaseGap {
  files: string[]
  failure: string | null
}

export type Pushed = { kind: 'pushed' } | { kind: 'clean' } | ({ kind: 'conflict' } & FreshBaseGap)

const FACTORY_TWIN = GENERATED_FILES.factory
const FACTORY_TWIN_PATHS = pathsRebuiltBy(FACTORY_TWIN.rebuild)

class TwinUnbuilt extends Error {}

function rebuildFactoryTwin(git: TreePrPorts['git'], worktree: string, rebuild: TwinRebuild | undefined): boolean {
  if (rebuild === undefined || !existsSync(path.join(worktree, FACTORY_TWIN.path)))
    return false
  const result = rebuild(worktree, FACTORY_TWIN.rebuild)
  if (result.status !== 0)
    throw new TwinUnbuilt(`${commandLine(FACTORY_TWIN.rebuild)} exited ${result.status ?? 'without a status'}: ${result.stderr.trim()}`)
  git(worktree, ['add', '--', ...FACTORY_TWIN_PATHS.filter(file => existsSync(path.join(worktree, file)))])
  return true
}

function hasChanges(git: TreePrPorts['git'], worktree: string): boolean {
  return git(worktree, ['status', '--porcelain']).trim() !== ''
}

function takeTwinsFromMain(git: TreePrPorts['git'], worktree: string, rebuild: TwinRebuild | undefined): void {
  if (rebuild === undefined)
    return
  const twins = conflictedFiles(git, worktree).filter(file => FACTORY_TWIN_PATHS.includes(file))
  if (twins.length > 0)
    git(worktree, ['checkout', MERGE_HEAD, '--', ...twins])
}

function conflictedFiles(git: TreePrPorts['git'], worktree: string): string[] {
  return git(worktree, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(file => file !== '')
}

function mergeInProgress(git: TreePrPorts['git'], worktree: string): boolean {
  try {
    git(worktree, ['rev-parse', '-q', '--verify', MERGE_HEAD])
    return true
  }
  catch {
    return false
  }
}

function ownerGlobsOfMain(git: TreePrPorts['git'], worktree: string): string[] {
  try {
    return ownerGlobs(git(worktree, ['show', `${PR_BASE}:${OWNER_MERGES}`]))
  }
  catch {
    return []
  }
}

function namesIn(listing: string): string[] {
  return listing.split('\0').filter(file => file !== '')
}

function takeOwnerPathsFromMain(git: TreePrPorts['git'], worktree: string): string[] {
  const globs = ownerGlobsOfMain(git, worktree)
  const base = git(worktree, ['merge-base', 'HEAD', MERGE_HEAD]).trim()
  const movedOnMain = namesIn(git(worktree, ['diff', '--no-renames', '--name-only', '-z', base, MERGE_HEAD]))
  const taken = [...new Set([...movedOnMain, ...conflictedFiles(git, worktree)])].filter(file => globs.some(glob => matchGlob(glob, file)))
  if (taken.length === 0)
    return []
  const onMain = new Set(namesIn(git(worktree, ['ls-tree', '-r', '--name-only', '-z', MERGE_HEAD, '--', ...taken])))
  const kept = taken.filter(file => onMain.has(file))
  const removed = taken.filter(file => !onMain.has(file))
  const changedOnBranch = new Set(namesIn(git(worktree, ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'])))
  if (kept.length > 0)
    git(worktree, ['checkout', MERGE_HEAD, '--', ...kept])
  if (removed.length > 0)
    git(worktree, ['rm', '-q', '-f', '--ignore-unmatch', '--', ...removed])
  return taken.filter(file => changedOnBranch.has(file))
}

function startFreshMerge(git: TreePrPorts['git'], worktree: string): FreshBaseGap | null {
  try {
    git(worktree, ['merge', '-q', '--no-edit', '--no-commit', PR_BASE])
    return null
  }
  catch (error) {
    if (conflictedFiles(git, worktree).length > 0)
      return null
    if (mergeInProgress(git, worktree))
      git(worktree, ['merge', '--abort'])
    return { files: [], failure: failureOf(error) }
  }
}

function mergeFreshBase(git: TreePrPorts['git'], worktree: string, rebuild: TwinRebuild | undefined): FreshBaseGap | null {
  const refused = startFreshMerge(git, worktree)
  if (refused !== null || !mergeInProgress(git, worktree))
    return refused
  const replaced = takeOwnerPathsFromMain(git, worktree)
  takeTwinsFromMain(git, worktree, rebuild)
  const left = conflictedFiles(git, worktree)
  if (left.length > 0)
    return { files: left, failure: null }
  try {
    rebuildFactoryTwin(git, worktree, rebuild)
  }
  catch (error) {
    if (!(error instanceof TwinUnbuilt))
      throw error
    git(worktree, ['merge', '--abort'])
    return { files: [], failure: `the bus could not rebuild ${FACTORY_TWIN.path} after the merge: ${error.message}` }
  }
  throughGitPort(git)(worktree, ['commit', '-q', '--no-edit', ...(replaced.length === 0 ? [] : ['-m', `Merge ${PR_BASE}: owner paths at main's version over the branch's ${replaced.join(', ')}`])])
  return null
}

export function commitAndPush(run: TreePrPorts['git'], worktree: string, branch: string, commitMessage: string, rebuild?: TwinRebuild): Pushed {
  const git = throughGitPort(run)
  git(worktree, ['fetch', '-q', 'origin', 'main'])
  if (mergeInProgress(git, worktree))
    takeOwnerPathsFromMain(git, worktree)
  const leftUnmerged = conflictedFiles(git, worktree)
  if (leftUnmerged.length > 0)
    return { kind: 'conflict', files: leftUnmerged, failure: null }
  const uncommitted = hasChanges(git, worktree)
  const ahead = Number(git(worktree, ['rev-list', '--count', `${PR_BASE}..HEAD`]).trim())
  if (!uncommitted && ahead === 0)
    return { kind: 'clean' }
  const rebuilt = rebuildFactoryTwin(git, worktree, rebuild)
  if (uncommitted || (rebuilt && hasChanges(git, worktree))) {
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-q', '-m', commitMessage])
  }
  const gap = mergeFreshBase(git, worktree, rebuild)
  if (gap !== null)
    return { kind: 'conflict', ...gap }
  git(worktree, ['push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`])
  return { kind: 'pushed' }
}

export function freshBaseProblem(gap: FreshBaseGap): string {
  return gap.failure === null ? `conflicts in ${gap.files.join(', ')}` : `fails without a conflict: ${gap.failure}`
}

export function freshBaseTask(worktree: string, gap: FreshBaseGap): string {
  if (gap.failure !== null)
    return `clear what stopped the merge of a fresh ${PR_BASE} (${gap.failure}) without dropping the card's work, and leave the merge itself to the bus, which merges again when the session ends`
  return `the bus started merging a fresh ${PR_BASE} into the branch and that merge stands in progress in ${worktree}, with every owner path of ${OWNER_MERGES} already at main's version: resolve every conflict in ${gap.files.join(', ')} keeping what the card asks for, stage each with git -C ${worktree} add, and conclude the merge with git -C ${worktree} commit --no-edit; start no new merge, abort nothing and write no owner path`
}

function staleBase(branch: string, worktree: string, gap: FreshBaseGap): TreePr {
  return { kind: 'problem', why: `the shift opened no pull request for ${branch}: merging a fresh ${PR_BASE} into it ${freshBaseProblem(gap)}`, gaps: [{ reason: 'stale-base', task: freshBaseTask(worktree, gap), paths: gap.files }] }
}

export function treePr(ports: TreePrPorts, card: TreeCard, worktree: string, report: string | null): TreePr {
  try {
    if (ports.pushPolicy?.(worktree) === 'none')
      return { kind: 'kept' }
    const pushed = commitAndPush(ports.git, worktree, card.branch, card.commitMessage, ports.rebuild)
    if (pushed.kind === 'clean')
      return { kind: 'clean' }
    if (pushed.kind === 'conflict')
      return staleBase(card.branch, worktree, pushed)
    const open = openPrOf(ports, card.branch)
    if (open !== null) {
      const gap = openPrMatrixGap(ports, worktree, open, report)
      return gap === null ? { kind: 'pr', number: open, followed: [] } : lacking(card.branch, [gap])
    }
    const shifted = shiftedPath(ports.git, worktree, card, report)
    const touched = changedOutsideTouches(ports.git, worktree, shifted.files, card, ports.rebuild ?? pnpmRerun, ownerHeardOn(ports, card.cardId))
    const body = prBodyOf(card, shifted.line, touched, matrixCountLineOf(report))
    const gaps = [...formatGaps(body, shifted, publishedRootsAt(ports.git, worktree), touched.outside, readShiftGate(worktree).codeMatrix, card.fullReading), ...derivedGaps(worktree, [...touched.refused, ...unwaitedGrowth(ports, touched.grown)])]
    if (gaps.length > 0)
      return lacking(card.branch, gaps)
    const created = ports.gh(['pr', 'create', '--head', card.branch, '--base', 'main', '--title', card.title, '--body', body])
    const number = PR_URL_NUMBER.exec(created.trim())?.[1]
    if (number === undefined)
      return { kind: 'problem', why: `gh pr create printed no pull request URL: ${firstLine(created)}`, gaps: faultGaps('no-pr-url') }
    openGrowthWait(ports, card, number, touched.grown)
    return { kind: 'pr', number, followed: touched.followed }
  }
  catch (error) {
    if (error instanceof TwinUnbuilt)
      return { kind: 'problem', why: `the shift opened no pull request for ${card.branch}: the bus could not rebuild ${FACTORY_TWIN.path} from the card's sources: ${error.message}`, gaps: [{ reason: 'twin-unbuilt', task: `make ${commandLine(FACTORY_TWIN.rebuild)} pass in ${worktree} by fixing the sources it reads, never by editing ${FACTORY_TWIN.path}, which the bus rebuilds and commits itself`, paths: [] }] }
    return { kind: 'problem', why: `the shift could not commit, push or open the pull request of ${card.branch}: ${failureOf(error)}`, gaps: faultGaps('commit-push-failed') }
  }
}

function failureOf(error: unknown): string {
  const command = firstLine(error instanceof Error ? error.message : String(error))
  const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim().split('\n').map(line => line.trim()).filter(line => line !== '').join(' · ') : ''
  return stderr === '' ? command : `${command}: ${stderr}`
}
