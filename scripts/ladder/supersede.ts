import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { approvedHashPath, extractApprovedSketch } from './approval.js'

const NO_SKETCH = 'none'
const SHORT_SHA = 7

export interface RunSketch {
  task: string
  sketch: string | null
}

function normalized(sketch: string | null | undefined): string {
  return sketch ?? NO_SKETCH
}

export function sketchSuperseded(runSketch: string | null | undefined, approvedSketch: string): boolean {
  return normalized(runSketch) !== normalized(approvedSketch)
}

export function shortSketch(sketch: string | null | undefined): string {
  const value = normalized(sketch)
  return value === NO_SKETCH ? value : value.slice(0, SHORT_SHA)
}

export function patchPath(reportDir: string, id: string, oldSketch: string | null | undefined): string {
  return path.join(reportDir, `ghost-${id}.done-${shortSketch(oldSketch)}.patch`)
}

export function approvedSketchOf(brief: string | undefined): string | undefined {
  if (brief === undefined)
    return undefined
  const approvedPath = approvedHashPath(brief)
  return existsSync(approvedPath) ? extractApprovedSketch(readFileSync(approvedPath, 'utf8')) : undefined
}

export function lastRunSketch(journalText: string, namesTask: (value: unknown) => boolean): RunSketch | undefined {
  let last: RunSketch | undefined
  for (const line of journalText.split('\n')) {
    try {
      const parsed = JSON.parse(line) as { event?: unknown, task?: unknown, sketch?: unknown }
      if (parsed.event === 'task' && namesTask(parsed.task))
        last = { task: String(parsed.task), sketch: typeof parsed.sketch === 'string' ? parsed.sketch : null }
    }
    catch {}
  }
  return last
}

function git(worktree: string, args: string[]): string {
  return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function releaseTree(worktree: string, patch: string): { saved: true } | { failure: string } | { clean: true } {
  try {
    if (git(worktree, ['status', '--porcelain']).trim() === '')
      return { clean: true }
    git(worktree, ['add', '-A'])
    const work = git(worktree, ['diff', '--cached', '--binary', 'HEAD'])
    if (work === '') {
      git(worktree, ['reset', '-q'])
      return { failure: `the tree is dirty but its work came out as an empty patch for ${patch}` }
    }
    try {
      writeFileSync(patch, work, { flag: 'wx' })
    }
    catch (error) {
      git(worktree, ['reset', '-q'])
      throw error
    }
    git(worktree, ['reset', '-q', '--hard', 'HEAD'])
    git(worktree, ['clean', '-fdq'])
    return { saved: true }
  }
  catch (error) {
    return { failure: `its uncommitted work could not be saved to ${patch}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}` }
  }
}
