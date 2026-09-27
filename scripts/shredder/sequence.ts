import type { OpenPr, WindowRow } from './reader.js'
import type { TaskRow } from './task.js'
import { HOT_FILES } from './paths.js'

const VERSION_PR_TITLE = 'chore: version packages'

export interface Sequencing {
  after: string[]
  parallelWith: string[]
  locks: string[]
  why: string[]
}

interface Predecessor {
  label: string
  shared: string[]
  hot: boolean
}

function intersect(a: string[], b: string[]): string[] {
  const set = new Set(b)
  return a.filter(item => set.has(item)).sort()
}

function isHot(shared: string[]): boolean {
  return shared.some(path => HOT_FILES.includes(path))
}

function predecessorsOf(index: number, tasks: TaskRow[], openPrs: OpenPr[]): Predecessor[] {
  const task = tasks[index]!
  const predecessors: Predecessor[] = []
  for (let earlier = 0; earlier < index; earlier++) {
    const other = tasks[earlier]!
    if (other.noPaths)
      continue
    const shared = intersect(task.write, other.write)
    if (shared.length > 0)
      predecessors.push({ label: other.display, shared, hot: isHot(shared) })
  }
  for (const pr of openPrs) {
    if (pr.title === VERSION_PR_TITLE)
      continue
    const shared = intersect(task.write, pr.files)
    if (shared.length > 0)
      predecessors.push({ label: `PR #${pr.number}`, shared, hot: isHot(shared) })
  }
  return predecessors
}

function parallelWithOf(index: number, tasks: TaskRow[]): string[] {
  const task = tasks[index]!
  const parallel: string[] = []
  for (let other = 0; other < tasks.length; other++) {
    if (other === index)
      continue
    const otherTask = tasks[other]!
    if (otherTask.noPaths)
      continue
    const shared = intersect(task.write, otherTask.write)
    if (shared.length === 0)
      parallel.push(otherTask.display)
  }
  return parallel
}

export function versionLockPr(openPrs: OpenPr[]): OpenPr | null {
  return openPrs.find(pr => pr.title === VERSION_PR_TITLE && pr.runsAwaitingApproval === false) ?? null
}

function treeHoldingWindow(worktree: string, windows: WindowRow[]): WindowRow | null {
  return windows.find(row => row.tree === worktree && (row.state === 'writing' || row.state === 'reviewing')) ?? null
}

export function sequenceTask(index: number, tasks: TaskRow[], openPrs: OpenPr[], windows: WindowRow[], versionLock: OpenPr | null): Sequencing {
  const task = tasks[index]!
  const why: string[] = []
  const predecessors = predecessorsOf(index, tasks, openPrs)
  for (const predecessor of predecessors) {
    const listed = predecessor.hot ? predecessor.shared.filter(path => HOT_FILES.includes(path)) : predecessor.shared
    why.push(`${predecessor.hot ? 'S2' : 'S1'} after ${predecessor.label}: ${listed.join(', ')}`)
  }
  const parallelWith = parallelWithOf(index, tasks)
  if (parallelWith.length > 0)
    why.push(`S3 parallel with ${parallelWith.join(', ')}`)

  const locks: string[] = []
  if (versionLock) {
    locks.push(`no merge until PR #${versionLock.number}`)
    why.push(`S4 PR #${versionLock.number}`)
  }
  const holder = treeHoldingWindow(task.worktree, windows)
  if (holder) {
    locks.push(`tree held by window ${holder.window}`)
    why.push(`S5 window ${holder.window}: ${task.worktree}`)
  }

  return { after: predecessors.map(predecessor => predecessor.label), parallelWith, locks, why }
}
