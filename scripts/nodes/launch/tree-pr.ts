import type { Contour } from '../../../src/card/grammar.js'
import type { ShiftTask } from '../../../src/card/task-file.js'
import type { CompanionRow } from '../../../src/commands/intake/check.js'
import type { ChangedFile, Prediction } from '../../policy/morse/rules.js'
import type { GhRunner } from '../../ports/gh.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runsCover, runsOf, TestCoverage, withinTouches } from '../../../src/card/covering-tests.js'
import { COMPANION_TABLE, PACKAGE_MANIFEST, publishedRootsOf } from '../../../src/commands/intake/check.js'
import { VERIFICATION_WORDS } from '../../core/verification.js'
import { classify, MorseRefusal } from '../../policy/morse/rules.js'
import { MATRIX_COUNT_LINE, pathWithoutMatrix } from '../../policy/policy.js'
import { changedFilesFrom } from '../../ports/diff.js'

export const REFUSAL_REASONS = {
  'stale-base': 'a',
  'no-changeset': 'a',
  'no-matrix-line': 'a',
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

export type TreePr = { kind: 'pr', number: string } | { kind: 'clean' } | { kind: 'problem', why: string, gaps: Gap[] }

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

export interface TreePrPorts {
  git: (cwd: string, args: string[]) => string
  gh: GhRunner
}

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
}

export const CARD_PATH_REASON = /^Path \(D-76\):\s*(\S.*)$/m

export function shiftTreeCard(task: ShiftTask): TreeCard {
  return {
    branch: task.branch,
    title: `${task.card.name} (#${task.id})`,
    commitMessage: `${task.card.name} (#${task.id})\n\nCommitted by the shift from the card's worktree after its session ended.`,
    cardLine: task.card.line,
    contour: task.card.contour,
    touches: task.touches,
    runs: runsOf(task.body),
    namedPathReason: CARD_PATH_REASON.exec(task.body)?.[1]?.trim() ?? null,
  }
}

const PR_BASE = 'origin/main'
const SHIFTED_RANGE = `${PR_BASE}...HEAD`
const PUBLISHED_CODE = COMPANION_TABLE.find(row => row.kind === 'published code') as CompanionRow
const CHANGESET_FILE = /^\.changeset\/(?!readme\.md$)[^/]+\.md$/i
const CHEAP_DEFAULT_REASON = 'cheap holds as the default path of D-224'
const REMOVED_LINE = /^-(?!--)(.*)$/gm
const IMPORT_OR_BLANK = /^\s*(?:import\s.*)?$/

function changedFilesOf(git: TreePrPorts['git'], worktree: string): ChangedFile[] {
  return changedFilesFrom(
    git(worktree, ['diff', '--no-renames', '-z', '--name-status', SHIFTED_RANGE]),
    git(worktree, ['diff', '--no-renames', '-z', '--numstat', SHIFTED_RANGE]),
  )
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
  files: ChangedFile[]
}

function shiftedPath(git: TreePrPorts['git'], worktree: string, card: TreeCard, report: string | null): ShiftedPath {
  try {
    const files = changedFilesOf(git, worktree)
    const prediction = classify(files)
    return {
      line: `Path: ${card.contour} · MORSE predicts ${prediction.verdict} by rule ${prediction.rule} (${prediction.why.join(', ')}) · ${pathReason(git, worktree, card, prediction, report)}`,
      files,
    }
  }
  catch (error) {
    if (!(error instanceof MorseRefusal))
      throw error
    return { line: `Path: ${card.contour} · MORSE gave no prediction: ${error.message} · the ${card.contour} path is held without a named reason`, files: [] }
  }
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

function changedOutsideTouches(git: TreePrPorts['git'], worktree: string, paths: readonly string[], touches: readonly string[], runs: readonly string[]): string[] {
  const outside = paths.filter(file => !withinTouches(file, touches) && !runsCover(file, runs))
  if (outside.length === 0)
    return []
  const coverage = new TestCoverage(() => git(worktree, ['ls-files']).split('\n').filter(file => file !== ''), file => readOrNull(path.join(worktree, file)))
  const covering = new Set(coverage.of(touches))
  return outside.filter(file => !covering.has(file))
}

interface FormatGap extends Gap {
  lacks: string
}

function formatGaps(body: string, shifted: ShiftedPath, publishedRoots: readonly string[], outsideTouches: readonly string[]): FormatGap[] {
  const paths = shifted.files.map(file => file.path)
  const unmatrixed = pathWithoutMatrix(body, paths)
  const published = paths.find(file => PUBLISHED_CODE.touched(file, publishedRoots))
  const changeset = shifted.files.some(file => file.status !== 'D' && CHANGESET_FILE.test(file.path))
  const gaps: FormatGap[] = []
  if (unmatrixed !== undefined)
    gaps.push({ reason: 'no-matrix-line', lacks: `the code matrix count line ■ n □ n · n its change to ${unmatrixed} requires (architecture/code-matrix.md)`, task: 'write the code matrix of architecture/code-matrix.md and its count line ■ n □ n · n into the shift report', paths: [] })
  if (published !== undefined && !changeset)
    gaps.push({ reason: 'no-changeset', lacks: `the changeset its change to the published ${published} requires`, task: `add a .changeset/*.md file for the change to ${published}`, paths: [] })
  if (outsideTouches.length > 0)
    gaps.push({ reason: 'outside-touches', lacks: `the card's touches for ${outsideTouches.join(', ')}, which it changes outside them (only a test that covers a touched file, or one of the card's runs, may change outside the touches)`, task: '', paths: [...outsideTouches] })
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

function prBodyOf(card: TreeCard, path: string, countLine: string | undefined): string {
  const body = `${card.cardLine}\n\n${path}\n\nOpened by the shift from the card's worktree and branch after its session ended.`
  return countLine === undefined ? body : `${body}\n\n${countLine}`
}

function openPrOf(ports: TreePrPorts, branch: string): string | null {
  const open = JSON.parse(ports.gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'])) as { number: number }[]
  return open.length === 0 ? null : String(open[0]!.number)
}

export interface FreshBaseGap {
  files: string[]
  failure: string | null
}

export type Pushed = { kind: 'pushed' } | { kind: 'clean' } | ({ kind: 'conflict' } & FreshBaseGap)

function conflictedFiles(git: TreePrPorts['git'], worktree: string): string[] {
  return git(worktree, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(file => file !== '')
}

function mergeInProgress(git: TreePrPorts['git'], worktree: string): boolean {
  try {
    git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
    return true
  }
  catch {
    return false
  }
}

function mergeFreshBase(git: TreePrPorts['git'], worktree: string): FreshBaseGap | null {
  try {
    git(worktree, ['merge', '-q', '--no-edit', PR_BASE])
    return null
  }
  catch (error) {
    const files = conflictedFiles(git, worktree)
    if (mergeInProgress(git, worktree))
      git(worktree, ['merge', '--abort'])
    return { files, failure: files.length === 0 ? failureOf(error) : null }
  }
}

export function commitAndPush(git: TreePrPorts['git'], worktree: string, branch: string, commitMessage: string): Pushed {
  git(worktree, ['fetch', '-q', 'origin', 'main'])
  const leftUnmerged = conflictedFiles(git, worktree)
  if (leftUnmerged.length > 0)
    return { kind: 'conflict', files: leftUnmerged, failure: null }
  const uncommitted = git(worktree, ['status', '--porcelain']).trim() !== ''
  const ahead = Number(git(worktree, ['rev-list', '--count', `${PR_BASE}..HEAD`]).trim())
  if (!uncommitted && ahead === 0)
    return { kind: 'clean' }
  if (uncommitted) {
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-q', '-m', commitMessage])
  }
  const gap = mergeFreshBase(git, worktree)
  if (gap !== null)
    return { kind: 'conflict', ...gap }
  git(worktree, ['push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`])
  return { kind: 'pushed' }
}

export function freshBaseProblem(gap: FreshBaseGap): string {
  return gap.failure === null ? `conflicts in ${gap.files.join(', ')}` : `fails without a conflict: ${gap.failure}`
}

export function freshBaseTask(worktree: string, gap: FreshBaseGap): string {
  const settle = gap.failure === null ? `resolve every conflict in ${gap.files.join(', ')} keeping what the card asks for` : `clear what stopped it (${gap.failure}) without dropping the card's work`
  return `merge a fresh ${PR_BASE} into the branch (git -C ${worktree} fetch origin main, then git -C ${worktree} merge ${PR_BASE}; merge, not rebase), ${settle}, and conclude the merge with git -C ${worktree} commit --no-edit`
}

function staleBase(branch: string, worktree: string, gap: FreshBaseGap): TreePr {
  return { kind: 'problem', why: `the shift opened no pull request for ${branch}: merging a fresh ${PR_BASE} into it ${freshBaseProblem(gap)}`, gaps: [{ reason: 'stale-base', task: freshBaseTask(worktree, gap), paths: gap.files }] }
}

export function treePr(ports: TreePrPorts, card: TreeCard, worktree: string, report: string | null): TreePr {
  try {
    const pushed = commitAndPush(ports.git, worktree, card.branch, card.commitMessage)
    if (pushed.kind === 'clean')
      return { kind: 'clean' }
    if (pushed.kind === 'conflict')
      return staleBase(card.branch, worktree, pushed)
    const open = openPrOf(ports, card.branch)
    if (open !== null)
      return { kind: 'pr', number: open }
    const shifted = shiftedPath(ports.git, worktree, card, report)
    const body = prBodyOf(card, shifted.line, matrixCountLineOf(report))
    const outside = changedOutsideTouches(ports.git, worktree, shifted.files.map(file => file.path), card.touches, card.runs)
    const gaps = formatGaps(body, shifted, publishedRootsAt(ports.git, worktree), outside)
    if (gaps.length > 0)
      return { kind: 'problem', why: `the shift opened no pull request for ${card.branch}: it lacks ${gaps.map(gap => gap.lacks).join('; ')}`, gaps: gaps.map(({ reason, task, paths }) => ({ reason, task, paths })) }
    const created = ports.gh(['pr', 'create', '--head', card.branch, '--base', 'main', '--title', card.title, '--body', body])
    const number = PR_URL_NUMBER.exec(created.trim())?.[1]
    return number === undefined ? { kind: 'problem', why: `gh pr create printed no pull request URL: ${firstLine(created)}`, gaps: faultGaps('no-pr-url') } : { kind: 'pr', number }
  }
  catch (error) {
    return { kind: 'problem', why: `the shift could not commit, push or open the pull request of ${card.branch}: ${failureOf(error)}`, gaps: faultGaps('commit-push-failed') }
  }
}

function failureOf(error: unknown): string {
  const command = firstLine(error instanceof Error ? error.message : String(error))
  const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim().split('\n').map(line => line.trim()).filter(line => line !== '').join(' · ') : ''
  return stderr === '' ? command : `${command}: ${stderr}`
}
