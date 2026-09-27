import type { BuildModeResult } from './build-mode.js'
import type { TaskFile } from './reader.js'
import { runBuildMode } from './build-mode.js'
import { briefPaths, buildWriteSet, issuePaths } from './paths.js'

export interface TaskRow {
  id: string
  fileName: string
  display: string
  title: string
  worktree: string
  build: BuildModeResult
  write: string[]
  noPaths: boolean
}

function taskDisplay(id: string): string {
  return /^\d+$/.test(id) ? `#${id}` : id
}

const WORKTREE_LINE = /^Worktree:(.+)$/m
const IMPLEMENT_PREFIX = '/implement '

function taskTitle(taskFile: TaskFile): string {
  const firstLine = taskFile.text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
  if (firstLine.startsWith('# '))
    return firstLine.slice(2).trim()
  if (firstLine.startsWith(IMPLEMENT_PREFIX))
    return firstLine.slice(IMPLEMENT_PREFIX.length).trim()
  return firstLine
}

function taskWorktree(taskFile: TaskFile, id: string): string {
  return WORKTREE_LINE.exec(taskFile.text)?.[1]?.trim() ?? `../mc-${id}`
}

export function buildTaskRow(taskFile: TaskFile, files: string[]): TaskRow {
  const build = runBuildMode(taskFile.filePath)
  const rawPaths = taskFile.kind === 'issue' ? issuePaths(taskFile.text, files) : briefPaths(taskFile.text, files)
  const write = buildWriteSet(rawPaths, files, build.immutable)
  return {
    id: taskFile.id,
    fileName: taskFile.fileName,
    display: taskDisplay(taskFile.id),
    title: taskTitle(taskFile),
    worktree: taskWorktree(taskFile, taskFile.id),
    build,
    write,
    noPaths: write.length === 0,
  }
}
