import type { Contour } from '../../src/card/grammar.js'
import type { ShiftTask } from '../../src/card/task-file.js'
import type { GhRunner } from '../board/gh.js'
import type { ChangedFile, Prediction } from '../morse/rules.js'
import { changedFilesFrom } from '../morse/diff.js'
import { classify, MorseRefusal } from '../morse/rules.js'
import { MATRIX_COUNT_LINE } from './merge.js'

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
}

export function shiftTreeCard(task: ShiftTask): TreeCard {
  return {
    branch: task.branch,
    title: `${task.card.name} (#${task.id})`,
    commitMessage: `${task.card.name} (#${task.id})\n\nCommitted by the shift from the card's worktree after its session ended.`,
    cardLine: task.card.line,
    contour: task.card.contour,
  }
}

const SHIFTED_RANGE = 'origin/main...HEAD'
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

function pathReason(git: TreePrPorts['git'], worktree: string, contour: Contour, prediction: Prediction): string {
  if (prediction.verdict === contour)
    return `the card's contour and MORSE agree`
  if (contour === 'ladder')
    return 'the card takes the ladder by its contour where MORSE predicts cheap'
  if (prediction.rule === 'tests-shrunk' && removesOnlyImportsOrBlanks(git, worktree, prediction.why))
    return `cheap holds: the shrunk test files are ${prediction.why.join(', ')}, and every line the diff removes from them is an import or blank`
  return 'the cheap path is held without a named reason'
}

function pathLine(git: TreePrPorts['git'], worktree: string, contour: Contour): string {
  try {
    const prediction = classify(changedFilesOf(git, worktree))
    return `Path: ${contour} · MORSE predicts ${prediction.verdict} by rule ${prediction.rule} (${prediction.why.join(', ')}) · ${pathReason(git, worktree, contour, prediction)}`
  }
  catch (error) {
    if (!(error instanceof MorseRefusal))
      throw error
    return `Path: ${contour} · MORSE gave no prediction: ${error.message} · the ${contour} path is held without a named reason`
  }
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

export function treePr(ports: TreePrPorts, card: TreeCard, worktree: string, report: string | null): TreePr {
  try {
    if (commitAndPush(ports.git, worktree, card.branch, card.commitMessage) === 'clean')
      return { kind: 'clean' }
    const open = openPrOf(ports, card.branch)
    if (open !== null)
      return { kind: 'pr', number: open }
    const body = prBodyOf(card, pathLine(ports.git, worktree, card.contour), matrixCountLineOf(report))
    const created = ports.gh(['pr', 'create', '--head', card.branch, '--base', 'main', '--title', card.title, '--body', body])
    const number = PR_URL_NUMBER.exec(created.trim())?.[1]
    return number === undefined ? { kind: 'problem', why: `gh pr create printed no pull request URL: ${firstLine(created)}` } : { kind: 'pr', number }
  }
  catch (error) {
    return { kind: 'problem', why: `the shift could not commit, push or open the pull request of ${card.branch}: ${firstLine(error instanceof Error ? error.message : String(error))}` }
  }
}
