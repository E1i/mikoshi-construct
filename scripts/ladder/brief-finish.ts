import type { ShiftTask } from '../../src/card/task-file.js'
import type { TaskStartDeps } from '../ports/task-start.js'
import type { PnpmResult } from './install.js'
import { writeFileSync } from 'node:fs'
import { briefEffort, EXPECT_LINE_INDEX, parseExpect } from './expect.js'
import { parseSketch } from './sketch.js'

export interface BriefFinishDeps {
  cwd: string
  git: TaskStartDeps['git']
  read: (file: string) => string
  pnpm?: (cwd: string, args: string[], input?: string) => PnpmResult
}

export const NO_PNPM_RUNNER = 'no pnpm runner is wired into this shift'

export function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
}

export function runPnpm(deps: Pick<BriefFinishDeps, 'cwd' | 'pnpm'>, args: string[], input?: string): PnpmResult | null {
  if (deps.pnpm === undefined)
    return null
  try {
    return deps.pnpm(deps.cwd, args, input)
  }
  catch (error) {
    return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

function commitSketch(deps: BriefFinishDeps, tree: string, name: string): string {
  const original = deps.git(tree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const branch = `sketch/${name}`
  deps.git(tree, ['checkout', '-B', branch])
  try {
    deps.git(tree, ['add', '-A'])
    deps.git(tree, ['commit', '-m', `sketch: ${name}`])
    const sha = deps.git(tree, ['rev-parse', 'HEAD']).trim()
    deps.git(tree, ['checkout', original])
    return `${branch} @ ${sha}`
  }
  catch (error) {
    deps.git(tree, ['reset', '--quiet'])
    deps.git(tree, ['checkout', original])
    deps.git(tree, ['branch', '-D', branch])
    throw error
  }
}

function failureLine(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : ''
  return firstLine(stderr) || firstLine(error instanceof Error ? error.message : String(error))
}

function hasExpect(text: string): boolean {
  try {
    return parseExpect(text) !== null
  }
  catch {
    return true
  }
}

export function finishBrief(deps: BriefFinishDeps, tree: string, card: ShiftTask['card'], brief: string): string | null {
  try {
    const text = deps.read(brief)
    let sketch: ReturnType<typeof parseSketch>
    try {
      sketch = parseSketch(text)
    }
    catch {
      return null
    }
    const lines = text.split('\n')
    const dirty = sketch.kind === 'none' && deps.git(tree, ['status', '--porcelain']).trim() !== ''
    if (dirty) {
      lines[1] = `Sketch: ${commitSketch(deps, tree, card.name)}`
      writeFileSync(brief, lines.join('\n'))
    }
    if (hasExpect(text))
      return null
    const effort = briefEffort(text)?.toLowerCase()
    const sampled = runPnpm(deps, ['ghosts:expect-sample', ...(effort === undefined ? [] : ['--effort', effort]), '--sketch', dirty || sketch.kind === 'branch' ? 'yes' : 'no'])
    if (sampled === null)
      return NO_PNPM_RUNNER
    const line = sampled.stdout.split('\n').find(candidate => candidate.startsWith('expect: '))
    if (sampled.code !== 0 || line === undefined)
      return firstLine(sampled.stderr) || `ghosts:expect-sample exit ${sampled.code}`
    lines.splice(EXPECT_LINE_INDEX, 0, line)
    writeFileSync(brief, lines.join('\n'))
    return null
  }
  catch (error) {
    return failureLine(error)
  }
}
