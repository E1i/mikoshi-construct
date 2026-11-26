import type { Backoff, HostFault } from './host-fault.js'
import { Buffer } from 'node:buffer'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { commandLine, REBUILD_COMMANDS } from '../core/generated-files.js'
import { backoffDelay, HOST_BACKOFF, HOST_FAILURES, hostFaultInText, hostFaultOf, HostFaultPersists } from './host-fault.js'

export const TECHNOLOGY_WORDS = ['exec', 'git', 'porcelain'] as const

export interface WorktreeEntry {
  path: string
  branch: string | undefined
}

export interface GitReader {
  dirty: (worktree: string) => number | undefined
  worktrees: (repoRoot: string) => WorktreeEntry[] | undefined
}

export interface GitOptions {
  maxBuffer?: number
  timeoutMs?: number
  input?: string
  env?: NodeJS.ProcessEnv
  errorsShown?: boolean
}

export interface GitRunner {
  read: (tree: string, args: readonly string[], options?: GitOptions) => string
  readOrNull: (tree: string, args: readonly string[], options?: GitOptions) => string | null
  readBytes: (tree: string, args: readonly string[], maxBuffer: number, options?: GitOptions) => Buffer
  readLater: (tree: string, args: readonly string[], options?: GitOptions) => Promise<string>
  succeeds: (tree: string, args: readonly string[], options?: GitOptions) => boolean
}

export type GitAnswer = string | Buffer | Error

export interface GitCall {
  tree: string
  args: string[]
}

const execFileAsync = promisify(execFile)

function settings(options: GitOptions = {}) {
  return {
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', options.errorsShown === true ? 'inherit' : 'pipe'] as ('ignore' | 'pipe' | 'inherit')[],
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: 'SIGKILL' as const }),
    ...(options.env === undefined ? {} : { env: options.env }),
  }
}

function run(args: string[], options?: GitOptions): string {
  return execFileSync('git', args, { ...settings(options), encoding: 'utf8' })
}

export const processGit: GitRunner = {
  read(tree, args, options) {
    return run(['-C', tree, ...args], options)
  },
  readOrNull(tree, args, options) {
    try {
      return run(['-C', tree, ...args], options)
    }
    catch {
      return null
    }
  },
  readBytes(tree, args, maxBuffer, options) {
    return execFileSync('git', ['-C', tree, ...args], { ...settings(options), maxBuffer })
  },
  async readLater(tree, args, options) {
    const { stdout } = await execFileAsync('git', ['-C', tree, ...args], {
      encoding: 'utf8',
      ...(options?.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
      ...(options?.env === undefined ? {} : { env: options.env }),
    })
    return stdout
  },
  succeeds(tree, args, options) {
    try {
      run(['-C', tree, ...args], options)
      return true
    }
    catch {
      return false
    }
  },
}

export class InMemoryGit implements GitRunner {
  readonly calls: GitCall[] = []

  constructor(private readonly answer: (call: GitCall) => GitAnswer) {}

  read(tree: string, args: readonly string[]): string {
    const answered = this.answered(tree, args)
    return typeof answered === 'string' ? answered : answered.toString('utf8')
  }

  readOrNull(tree: string, args: readonly string[]): string | null {
    try {
      return this.read(tree, args)
    }
    catch {
      return null
    }
  }

  readBytes(tree: string, args: readonly string[]): Buffer {
    const answered = this.answered(tree, args)
    return typeof answered === 'string' ? Buffer.from(answered, 'utf8') : answered
  }

  async readLater(tree: string, args: readonly string[]): Promise<string> {
    return this.read(tree, args)
  }

  succeeds(tree: string, args: readonly string[]): boolean {
    try {
      this.answered(tree, args)
      return true
    }
    catch {
      return false
    }
  }

  private answered(tree: string, args: readonly string[]): string | Buffer {
    const call = { tree, args: [...args] }
    this.calls.push(call)
    const answer = this.answer(call)
    if (answer instanceof Error)
      throw answer
    return answer
  }
}

export function readThroughPort(tree: string, args: readonly string[]): string {
  return processGit.read(tree, args)
}

export type { Backoff }

export const SYNC_COMMANDS = ['fetch', 'commit', 'push'] as const

export const REF_LOCK_RACE = 'cannot lock ref'

export const GIT_BACKOFF: Backoff = { attempts: 4, firstMs: 250, sleep: HOST_BACKOFF.sleep }

export type GitCommand = (cwd: string, args: string[]) => string

export type GitOutcome = { kind: 'race', detail: string } | { kind: 'host', fault: HostFault } | { kind: 'refused', refusal: string }

const SYNC: ReadonlySet<string> = new Set(SYNC_COMMANDS)
const DENIAL = /^.*\b(?:fatal|error|remote):.*(?:operation not permitted|permission denied|read-only file system|denied to|\[remote rejected\]).*$/im

function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  return typeof stderr === 'string' || stderr instanceof Uint8Array ? String(stderr).trim() : ''
}

function failureText(error: unknown): string {
  return `${error instanceof Error ? error.message : String(error)}\n${stderrOf(error)}`
}

function firstSaid(text: string): string {
  return text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
}

export function gitOutcomeOf(error: unknown): GitOutcome {
  const text = failureText(error)
  if (text.includes(REF_LOCK_RACE))
    return { kind: 'race', detail: firstSaid(text.slice(text.indexOf(REF_LOCK_RACE))) }
  const fault = hostFaultOf(error)
  if (fault !== null)
    return { kind: 'host', fault }
  return { kind: 'refused', refusal: firstSaid(stderrOf(error)) || firstSaid(text) }
}

export function gitRefusalIn(text: string | null): string | null {
  if (text === null || text.includes(REF_LOCK_RACE) || hostFaultInText(text) !== null)
    return null
  return DENIAL.exec(text)?.[0].trim() ?? null
}

export class GitRaceLost extends Error {
  readonly stderr: string

  constructor(readonly detail: string, attempts: number, cause: unknown) {
    super(`git lost a ref-lock race ${attempts} times: ${detail}`, { cause })
    this.stderr = stderrOf(cause)
  }
}

function settled(error: unknown, outcome: GitOutcome, attempts: number): unknown {
  if (outcome.kind === 'race')
    return new GitRaceLost(outcome.detail, attempts, error)
  if (outcome.kind === 'host')
    return new HostFaultPersists(outcome.fault, attempts)
  return error
}

const UNPORTED = new WeakMap<GitCommand, GitCommand>()

function unported(run: GitCommand): GitCommand {
  return UNPORTED.get(run) ?? run
}

export function syncThroughPort(run: GitCommand, cwd: string, args: string[], backoff: Backoff = GIT_BACKOFF): string {
  const raw = unported(run)
  for (let attempt = 0; ; attempt += 1) {
    try {
      return raw(cwd, args)
    }
    catch (error) {
      const outcome = gitOutcomeOf(error)
      if (outcome.kind === 'host')
        HOST_FAILURES.record(outcome.fault)
      if (outcome.kind === 'refused' || attempt + 1 >= backoff.attempts)
        throw settled(error, outcome, attempt + 1)
      backoff.sleep(backoffDelay(backoff, attempt))
    }
  }
}

export function throughGitPort(run: GitCommand, backoff: Backoff = GIT_BACKOFF): GitCommand {
  const raw = unported(run)
  const ported: GitCommand = (cwd, args) => SYNC.has(args[0] ?? '') ? syncThroughPort(raw, cwd, args, backoff) : raw(cwd, args)
  UNPORTED.set(ported, raw)
  return ported
}

export const portGit: GitCommand = throughGitPort((cwd, args) => processGit.read(cwd, args))

export function loadedCodeSha(): string | null {
  return processGit.readOrNull(import.meta.dirname, ['rev-parse', 'HEAD'])?.trim() ?? null
}

export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  return porcelain.split('\n\n').filter(block => block.trim() !== '').map((block) => {
    const lines = block.split('\n')
    const branch = lines.find(line => line.startsWith('branch '))?.slice('branch '.length).replace(/^refs\/heads\//, '')
    return { path: lines.find(line => line.startsWith('worktree '))!.slice('worktree '.length), branch }
  })
}

export const execGit: GitReader = {
  dirty(worktree) {
    try {
      return run(['-C', worktree, 'status', '--porcelain']).split('\n').filter(line => line !== '').length
    }
    catch {
      return undefined
    }
  },
  worktrees(repoRoot) {
    try {
      return parseWorktrees(run(['-C', repoRoot, 'worktree', 'list', '--porcelain']))
    }
    catch {
      return undefined
    }
  },
}

export type TreeRun = (cwd: string, args: readonly string[]) => { status: number | null, stderr: string }

export type TreeRerun = { kind: 'ran', outputs: ReadonlyMap<string, string | null> } | { kind: 'failed', why: string }

export interface TreeReading {
  current: (file: string) => string | null
  base: (file: string) => string | null
  rerun: (command: readonly string[], outputs: readonly string[]) => TreeRerun
}

function registeredRebuild(args: readonly string[]): readonly string[] | undefined {
  return REBUILD_COMMANDS.find(command => command.length === args.length && command.every((word, index) => word === args[index]))
}

export function pnpmRerun(cwd: string, args: readonly string[]): { status: number | null, stderr: string } {
  const rebuild = registeredRebuild(args)
  if (rebuild === undefined)
    return { status: null, stderr: `refused: ${commandLine(args)} is not a registered derived-file rebuild` }
  const run = spawnSync('pnpm', [...rebuild], { cwd, encoding: 'utf8' })
  return { status: run.status, stderr: run.error?.message ?? run.stderr }
}

function textIn(worktree: string, file: string): string | null {
  try {
    return readFileSync(path.join(worktree, file), 'utf8')
  }
  catch {
    return null
  }
}

function putBack(worktree: string, held: ReadonlyMap<string, string | null>): void {
  for (const [file, text] of held) {
    if (text === null)
      rmSync(path.join(worktree, file), { force: true })
    else
      writeFileSync(path.join(worktree, file), text)
  }
}

export function treeReading(read: (cwd: string, args: string[]) => string, worktree: string, base: string, run: TreeRun): TreeReading {
  return {
    current: file => textIn(worktree, file),
    base: (file) => {
      try {
        return read(worktree, ['show', `${base}:${file}`])
      }
      catch {
        return null
      }
    },
    rerun: (command, outputs) => {
      const held = new Map(outputs.map(file => [file, textIn(worktree, file)]))
      try {
        const result = run(worktree, command)
        if (result.status !== 0)
          return { kind: 'failed', why: `exited ${result.status ?? 'without a status'}: ${result.stderr.trim()}` }
        return { kind: 'ran', outputs: new Map(outputs.map(file => [file, textIn(worktree, file)])) }
      }
      finally {
        putBack(worktree, held)
      }
    },
  }
}
