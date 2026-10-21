import type { Contour } from '../../src/card/grammar.js'
import type { ShiftTask } from '../../src/card/task-file.js'
import type { CompanionRow } from '../../src/commands/intake/check.js'
import type { GhRunner } from '../core/gh.js'
import type { ChangedFile, Prediction } from '../morse/rules.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runsCover, runsOf, TestCoverage, withinTouches } from '../../src/card/covering-tests.js'
import { COMPANION_TABLE, PACKAGE_MANIFEST, publishedRootsOf } from '../../src/commands/intake/check.js'
import { MATRIX_COUNT_LINE, pathWithoutMatrix } from '../bus/policy.js'
import { changedFilesFrom } from '../morse/diff.js'
import { classify, MorseRefusal } from '../morse/rules.js'

export type TreePr = { kind: 'pr', number: string } | { kind: 'clean' } | { kind: 'problem', why: string }

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
const UNNAMED_REASON = 'the cheap path is held without a named reason'
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

function pathReason(git: TreePrPorts['git'], worktree: string, card: TreeCard, prediction: Prediction): string {
  if (prediction.verdict === card.contour)
    return `the card's contour and MORSE agree`
  if (card.contour === 'ladder')
    return 'the card takes the ladder by its contour where MORSE predicts cheap'
  if (card.namedPathReason !== null)
    return `cheap holds by the card's D-76 reason: ${card.namedPathReason}`
  if (prediction.rule === 'tests-shrunk' && removesOnlyImportsOrBlanks(git, worktree, prediction.why))
    return `cheap holds: the shrunk test files are ${prediction.why.join(', ')}, and every line the diff removes from them is an import or blank`
  return UNNAMED_REASON
}

interface ShiftedPath {
  line: string
  files: ChangedFile[]
  cheapAgainstLadderUnreasoned: boolean
}

function shiftedPath(git: TreePrPorts['git'], worktree: string, card: TreeCard): ShiftedPath {
  try {
    const files = changedFilesOf(git, worktree)
    const prediction = classify(files)
    const reason = pathReason(git, worktree, card, prediction)
    return {
      line: `Path: ${card.contour} · MORSE predicts ${prediction.verdict} by rule ${prediction.rule} (${prediction.why.join(', ')}) · ${reason}`,
      files,
      cheapAgainstLadderUnreasoned: prediction.verdict === 'ladder' && reason === UNNAMED_REASON,
    }
  }
  catch (error) {
    if (!(error instanceof MorseRefusal))
      throw error
    return { line: `Path: ${card.contour} · MORSE gave no prediction: ${error.message} · the ${card.contour} path is held without a named reason`, files: [], cheapAgainstLadderUnreasoned: false }
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

function formatGaps(body: string, shifted: ShiftedPath, publishedRoots: readonly string[], outsideTouches: readonly string[]): string[] {
  const paths = shifted.files.map(file => file.path)
  const unmatrixed = pathWithoutMatrix(body, paths)
  const published = paths.find(file => PUBLISHED_CODE.touched(file, publishedRoots))
  const changeset = shifted.files.some(file => file.status !== 'D' && CHANGESET_FILE.test(file.path))
  return [
    ...(unmatrixed === undefined ? [] : [`the code matrix count line ■ n □ n · n its change to ${unmatrixed} requires (architecture/code-matrix.md)`]),
    ...(shifted.cheapAgainstLadderUnreasoned ? ['the D-76 reason the card holds the cheap path where MORSE predicts the ladder'] : []),
    ...(published === undefined || changeset ? [] : [`the changeset its change to the published ${published} requires`]),
    ...(outsideTouches.length === 0 ? [] : [`the card's touches for ${outsideTouches.join(', ')}, which it changes outside them (only a test that covers a touched file, or one of the card's runs, may change outside the touches)`]),
  ]
}

export function matrixCountLineOf(report: string | null): string | undefined {
  return report === null ? undefined : MATRIX_COUNT_LINE.exec(report)?.[0]
}

function prBodyOf(card: TreeCard, path: string, countLine: string | undefined): string {
  const body = `${card.cardLine}\n\n${path}\n\nOpened by the shift from the card's worktree and branch after its session ended.`
  return countLine === undefined ? body : `${body}\n\n${countLine}`
}

function openPrOf(ports: TreePrPorts, branch: string): string | null {
  const open = JSON.parse(ports.gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'])) as { number: number }[]
  return open.length === 0 ? null : String(open[0]!.number)
}

export function commitAndPush(git: TreePrPorts['git'], worktree: string, branch: string, commitMessage: string): 'pushed' | 'clean' {
  const uncommitted = git(worktree, ['status', '--porcelain']).trim() !== ''
  const ahead = Number(git(worktree, ['rev-list', '--count', 'origin/main..HEAD']).trim())
  if (!uncommitted && ahead === 0)
    return 'clean'
  if (uncommitted) {
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-q', '-m', commitMessage])
  }
  git(worktree, ['push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`])
  return 'pushed'
}

export function mergeBaseProblem(git: TreePrPorts['git'], worktree: string, branch: string): string | null {
  const base = git(worktree, ['rev-parse', PR_BASE]).trim()
  const mergeBase = git(worktree, ['merge-base', 'HEAD', PR_BASE]).trim()
  return mergeBase === base ? null : `the shift opened no pull request for ${branch}: its merge-base ${mergeBase || 'none'} is not the PR base ${PR_BASE} at ${base}; bring the tree onto ${PR_BASE} first`
}

export function treePr(ports: TreePrPorts, card: TreeCard, worktree: string, report: string | null): TreePr {
  try {
    if (commitAndPush(ports.git, worktree, card.branch, card.commitMessage) === 'clean')
      return { kind: 'clean' }
    const open = openPrOf(ports, card.branch)
    if (open !== null)
      return { kind: 'pr', number: open }
    const offBase = mergeBaseProblem(ports.git, worktree, card.branch)
    if (offBase !== null)
      return { kind: 'problem', why: offBase }
    const shifted = shiftedPath(ports.git, worktree, card)
    const body = prBodyOf(card, shifted.line, matrixCountLineOf(report))
    const outside = changedOutsideTouches(ports.git, worktree, shifted.files.map(file => file.path), card.touches, card.runs)
    const gaps = formatGaps(body, shifted, publishedRootsAt(ports.git, worktree), outside)
    if (gaps.length > 0)
      return { kind: 'problem', why: `the shift opened no pull request for ${card.branch}: it lacks ${gaps.join('; ')}` }
    const created = ports.gh(['pr', 'create', '--head', card.branch, '--base', 'main', '--title', card.title, '--body', body])
    const number = PR_URL_NUMBER.exec(created.trim())?.[1]
    return number === undefined ? { kind: 'problem', why: `gh pr create printed no pull request URL: ${firstLine(created)}` } : { kind: 'pr', number }
  }
  catch (error) {
    return { kind: 'problem', why: `the shift could not commit, push or open the pull request of ${card.branch}: ${failureOf(error)}` }
  }
}

function failureOf(error: unknown): string {
  const command = firstLine(error instanceof Error ? error.message : String(error))
  const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim().split('\n').map(line => line.trim()).filter(line => line !== '').join(' · ') : ''
  return stderr === '' ? command : `${command}: ${stderr}`
}
