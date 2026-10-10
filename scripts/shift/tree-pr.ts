import type { ShiftTask } from '../../src/card/task-file.js'
import type { GhRunner } from '../board/gh.js'

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
  prBody: string
}

export function shiftTreeCard(task: ShiftTask): TreeCard {
  return {
    branch: task.branch,
    title: `${task.card.name} (#${task.id})`,
    commitMessage: `${task.card.name} (#${task.id})\n\nCommitted by the shift from the card's worktree after its session ended.`,
    prBody: `${task.card.line}\n\nOpened by the shift from the card's worktree and branch after its session ended.`,
  }
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

export function treePr(ports: TreePrPorts, card: TreeCard, worktree: string): TreePr {
  try {
    if (commitAndPush(ports.git, worktree, card.branch, card.commitMessage) === 'clean')
      return { kind: 'clean' }
    const open = openPrOf(ports, card.branch)
    if (open !== null)
      return { kind: 'pr', number: open }
    const created = ports.gh(['pr', 'create', '--head', card.branch, '--base', 'main', '--title', card.title, '--body', card.prBody])
    const number = PR_URL_NUMBER.exec(created.trim())?.[1]
    return number === undefined ? { kind: 'problem', why: `gh pr create printed no pull request URL: ${firstLine(created)}` } : { kind: 'pr', number }
  }
  catch (error) {
    return { kind: 'problem', why: `the shift could not commit, push or open the pull request of ${card.branch}: ${firstLine(error instanceof Error ? error.message : String(error))}` }
  }
}
