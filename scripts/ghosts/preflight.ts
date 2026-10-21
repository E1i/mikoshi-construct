import type { DiskReader } from '../bus/disk.js'
import type { Timer } from '../bus/witnesses.js'
import type { Shell } from '../ports/worktree.js'
import type { Sketch } from './sketch.js'
import process from 'node:process'
import { DISK_LOW, diskLowDetail, statfsReader } from '../bus/disk.js'
import { runOnTree } from '../bus/witnesses.js'
import { gitIn, lastLine, realShell, withWorktree } from '../ports/worktree.js'
import { generatorRefusal, ghostsFilesRefusal, immutableRefusal, invariantWitnesses, movingRefRefusal, unreadInvariantRefusal } from './preflight-static.js'

export interface PreflightEnv { repo: string, shell: Shell, log: (line: string) => void, clock: () => number, disk?: DiskReader }
export interface PreflightInput { briefPath: string, text: string, sketch: Sketch, buildStdout: string, base?: string }
export type Preflight = (input: PreflightInput) => void

interface BuiltArgs { witnesses: { criterion: string, command: string }[], invariants: string[], immutable: string[], design?: string, harness: { command: string } }
interface Phase { name: string, ms: number }

export class PreflightRefusal extends Error {
  constructor(readonly step: string, message: string) {
    super(`preflight ${step}: ${message}`)
  }
}

function refuseOn(step: string, problem: string | null): void {
  if (problem !== null)
    throw new PreflightRefusal(step, problem)
}

function diskLowRefusal(env: PreflightEnv): string | null {
  const detail = diskLowDetail(env.disk ?? statfsReader(env.repo))
  return detail === null ? null : `${DISK_LOW}: ${detail}; no worktree is created`
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function builtArgsOf(stdout: string): BuiltArgs {
  try {
    return JSON.parse(stdout) as BuiltArgs
  }
  catch {
    throw new PreflightRefusal('P1', 'check-acceptance build printed no readable arguments, so the witnesses cannot be run')
  }
}

function pinnedBase(repo: string): string {
  try {
    gitIn(repo, ['fetch', 'origin', 'main'])
    return gitIn(repo, ['rev-parse', 'origin/main'])
  }
  catch (error) {
    throw new PreflightRefusal('P0', `cannot pin the base: ${lastLine(error instanceof Error ? error.message : String(error))}`)
  }
}

function sketchChangedFiles(repo: string, base: string, sketch: Sketch): string[] | null {
  if (sketch.kind === 'none')
    return null
  try {
    gitIn(repo, ['merge-base', '--is-ancestor', base, sketch.sha])
  }
  catch {
    throw new PreflightRefusal('P0', `sketch ${sketch.sha.slice(0, 7)} does not contain origin/main ${base.slice(0, 7)}; rebase ${sketch.branch} onto origin/main first`)
  }
  return gitIn(repo, ['diff', '--name-only', base, sketch.sha]).split('\n').filter(file => file !== '')
}

function showAt(repo: string, ref: string): (file: string) => string | null {
  return (file) => {
    try {
      return gitIn(repo, ['show', `${ref}:${file}`])
    }
    catch {
      return null
    }
  }
}

function repositoryAtCwd(): string {
  try {
    return gitIn(process.cwd(), ['rev-parse', '--show-toplevel'])
  }
  catch {
    throw new PreflightRefusal('P0', 'run ghosts:hash inside the repository the brief is written against: the current directory is in no git repository')
  }
}

export function witnessesDirOf(briefPath: string): string {
  return `${briefPath.replace(/\.md$/, '')}.witnesses`
}

export function pinnedBaseAtCwd(): string {
  return pinnedBase(repositoryAtCwd())
}

function processEnv(): PreflightEnv {
  return { repo: repositoryAtCwd(), shell: realShell, log: line => console.error(line), clock: () => performance.now() }
}

export function runPreflight(input: PreflightInput, env: PreflightEnv = processEnv()): void {
  const phases: Phase[] = []
  const started = env.clock()
  let base = 'unpinned'
  const time: Timer = (name, run) => {
    const at = env.clock()
    try {
      return run()
    }
    finally {
      phases.push({ name, ms: env.clock() - at })
    }
  }
  try {
    refuseOn('P0', diskLowRefusal(env))
    const built = builtArgsOf(input.buildStdout)
    const design = built.design ?? ''
    refuseOn('P1', unreadInvariantRefusal(built.invariants))
    const invariants = invariantWitnesses(built.invariants)
    base = input.base ?? time('P0 base', () => pinnedBase(env.repo))
    const changed = time('P0 sketch', () => sketchChangedFiles(env.repo, base, input.sketch))
    const sketchSha = input.sketch.kind === 'branch' ? input.sketch.sha : null
    refuseOn('P2', movingRefRefusal([...built.witnesses, ...invariants]))
    refuseOn('P3', generatorRefusal(design, changed ?? []))
    refuseOn('P4', time('P4 ghosts-files', () => ghostsFilesRefusal(showAt(env.repo, sketchSha ?? base), design, changed ?? [])))
    refuseOn('P5', immutableRefusal(changed ?? [], built.immutable))
    withWorktree(env.repo, base, tree => runOnTree(
      { tree, base, shell: env.shell, log: env.log, refuse: refuseOn, time },
      { acceptance: built.witnesses, invariants, harnessCommand: built.harness.command, sketchSha, changed, witnessesDir: witnessesDirOf(input.briefPath) },
    ))
  }
  finally {
    env.log(`preflight: base ${base.slice(0, 7)}; ${phases.map(phase => `${phase.name} ${seconds(phase.ms)}`).join('; ')}; total ${seconds(env.clock() - started)}`)
  }
}
