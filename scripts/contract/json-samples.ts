import type { JsonKeysReading, Unbaselined } from './semantic-diff.js'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { COST_EXIT } from '../../src/commands/cost/index.js'
import { DOCTOR_EXIT } from '../../src/commands/doctor/index.js'
import { MUTATE_APPLY_EXIT, MUTATE_JUDGE_EXIT } from '../../src/commands/mutate/index.js'
import { SOULKILL_EXIT } from '../../src/commands/soulkill.js'
import { SYNC_APPLY_EXIT, SYNC_EXIT } from '../../src/commands/sync/index.js'
import { unbaselined } from './semantic-diff.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const FROZEN_010 = path.join(REPO_ROOT, 'tests/fixtures/sync/materialized-by-0.1.0')
const RUNTIME_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CURSOR_AGENT', 'CURSOR_TRACE_ID']
const MACHINE_COREPACK_HOME = process.env.COREPACK_HOME ?? path.join(homedir(), '.cache', 'node', 'corepack')
const SAMPLE_PRESET = 'node-library'

export type JsonRoot = 'object' | 'array' | 'null' | 'scalar'

export interface JsonSample {
  root: JsonRoot
  keys: string[]
}

export type JsonKeys = Record<string, Record<string, JsonSample>>

export interface ObservedCli {
  root: string
  holdsHeadInvariants: boolean
}

export const HEAD_CLI: ObservedCli = { root: REPO_ROOT, holdsHeadInvariants: true }

export function tagCli(worktree: string): ObservedCli {
  return { root: worktree, holdsHeadInvariants: false }
}

export function cliArgs(cli: ObservedCli, args: string[]): string[] {
  return [path.join(cli.root, 'node_modules/tsx/dist/cli.mjs'), path.join(cli.root, 'src/cli.ts'), ...args]
}

interface World {
  dir: string
  home: string
}

interface Sample {
  command: string
  state: string
  args: string[] | ((world: World) => string[])
  world: (scratch: Scratch) => World
}

export function cliEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', HOME: home, COREPACK_HOME: MACHINE_COREPACK_HOME }
  for (const name of RUNTIME_MARKERS)
    delete env[name]
  return env
}

function run(cli: ObservedCli, args: string[], world: World): { status: number | null, stdout: string } {
  const result = spawnSync(process.execPath, cliArgs(cli, [...args, '--dir', world.dir]), { env: cliEnv(world.home), encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout }
}

class Scratch {
  private count = 0
  private initialised: string | null = null

  constructor(readonly root: string, readonly cli: ObservedCli) {}

  world(): World {
    this.count += 1
    const base = path.join(this.root, `world-${this.count}`)
    const world = { dir: path.join(base, 'repo'), home: path.join(base, 'home') }
    mkdirSync(world.dir, { recursive: true })
    mkdirSync(world.home, { recursive: true })
    return world
  }

  init(): World {
    const world = this.world()
    if (this.initialised == null) {
      const status = run(this.cli, ['init', '--yes', '--preset', SAMPLE_PRESET], world).status
      if (status !== 0)
        throw new Error(`init --preset ${SAMPLE_PRESET} exited ${status} while building the --json samples`)
      this.initialised = world.dir
      return world
    }
    cpSync(this.initialised, world.dir, { recursive: true })
    return world
  }

  frozen010(): World {
    const world = this.world()
    cpSync(path.join(FROZEN_010, 'construct.json'), path.join(world.dir, 'construct.json'))
    cpSync(path.join(FROZEN_010, 'AGENTS.md.frozen'), path.join(world.dir, 'AGENTS.md'))
    cpSync(path.join(FROZEN_010, 'CLAUDE.md.frozen'), path.join(world.dir, 'CLAUDE.md'))
    mkdirSync(path.join(world.dir, 'architecture'))
    cpSync(path.join(FROZEN_010, 'security-invariants.md.frozen'), path.join(world.dir, 'architecture/security-invariants.md'))
    return world
  }
}

function projectsDir(world: World): string {
  const dir = path.join(world.home, '.claude/projects')
  mkdirSync(dir, { recursive: true })
  return dir
}

function projectKey(dir: string): string {
  return dir.replace(/[/.]/g, '-')
}

function withRecordedRun(world: World): World {
  const run = path.join(projectsDir(world), projectKey(world.dir), 'session-1/subagents/workflows/run-1')
  mkdirSync(run, { recursive: true })
  const usage = { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 }
  writeFileSync(path.join(run, 'agent-1.jsonl'), `${JSON.stringify({ requestId: 'r1', message: { role: 'assistant', model: 'm', usage } })}\n`)
  writeFileSync(path.join(run, 'agent-1.meta.json'), JSON.stringify({ description: 'implement', agentType: 'implementer' }))
  return world
}

function withLookalikeKey(world: World): World {
  mkdirSync(path.join(projectsDir(world), `-elsewhere-${path.basename(world.dir)}`))
  return world
}

function throughSymlinkRecordedAtRealPath(world: World): World {
  mkdirSync(path.join(projectsDir(world), projectKey(world.dir)))
  const link = `${world.dir}-link`
  symlinkSync(world.dir, link)
  return { ...world, dir: link }
}

function withoutBaselineFile(world: World): World {
  rmSync(path.join(world.dir, 'architecture/principles.md'))
  return world
}

function withMergedTargetPending(world: World): World {
  writeFileSync(path.join(world.dir, 'package.json'), '{}\n')
  return world
}

const MUTATION_TARGET = 'src/target.ts'
const MUTATION_TEST = 'tests/target.test.ts'
const AN_HOUR_AGO = (): Date => new Date(Date.now() - 3_600_000)

function outside(world: World, name: string): string {
  return path.join(path.dirname(world.dir), name)
}

function mutationTarget(world: World): World {
  const target = path.join(world.dir, MUTATION_TARGET)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, 'export const target = 1\n')
  utimesSync(target, AN_HOUR_AGO(), AN_HOUR_AGO())
  writeFileSync(outside(world, 'brief.md'), `M1 | ${MUTATION_TARGET} | find: \`= 1\` → \`= 2\` | red: ${MUTATION_TEST} › target › holds | \`the target holds\`\n`)
  return world
}

function report(world: World, name: string, startTime: number, status: 'passed' | 'failed'): string {
  const assertionResults = [{ ancestorTitles: ['target'], fullName: 'target holds', status, title: 'holds', failureMessages: [] }]
  const testResults = [{ name: path.join(world.dir, MUTATION_TEST), status, message: '', startTime, assertionResults }]
  const file = outside(world, name)
  writeFileSync(file, JSON.stringify({ numTotalTests: 1, startTime, success: status === 'passed', testResults }))
  return file
}

function applyArgs(world: World): string[] {
  return ['mutate', 'apply', '--from', outside(world, 'brief.md'), '--id', 'M1', '--json']
}

function judgeArgs(reportFile: string): string[] {
  return ['mutate', 'judge', '--id', 'M1', '--report', reportFile, '--json']
}

function withBaseline(scratch: Scratch, world: World): World {
  const status = run(scratch.cli, ['mutate', 'judge', '--baseline', '--report', report(world, 'baseline.json', Date.now(), 'passed')], world).status
  if (status !== 0)
    throw new Error(`mutate judge --baseline exited ${status} while building the --json samples`)
  return world
}

function applied(scratch: Scratch): World {
  const world = withBaseline(scratch, mutationTarget(scratch.world()))
  const status = run(scratch.cli, applyArgs(world), world).status
  if (status !== 0)
    throw new Error(`mutate apply exited ${status} while building the --json samples`)
  return world
}

function withForeignEdit(world: World): World {
  writeFileSync(path.join(world.dir, MUTATION_TARGET), 'export const target = 3\n')
  return world
}

const SAMPLES: Sample[] = [
  { command: 'doctor', state: 'ok', args: ['doctor', '--json'], world: scratch => scratch.init() },
  { command: 'doctor', state: 'notOk', args: ['doctor', '--json'], world: scratch => withoutBaselineFile(scratch.init()) },
  { command: 'doctor', state: 'noManifest', args: ['doctor', '--json'], world: scratch => scratch.world() },
  { command: 'sync', state: 'upToDate', args: ['sync', '--json'], world: scratch => scratch.init() },
  { command: 'sync', state: 'pending', args: ['sync', '--json'], world: scratch => scratch.frozen010() },
  { command: 'sync', state: 'noManifest', args: ['sync', '--json'], world: scratch => scratch.world() },
  { command: 'sync --apply', state: 'written', args: ['sync', '--apply', '--json'], world: scratch => scratch.frozen010() },
  { command: 'sync --apply', state: 'refused', args: ['sync', '--apply', '--json'], world: scratch => withMergedTargetPending(scratch.frozen010()) },
  { command: 'sync --apply', state: 'noManifest', args: ['sync', '--apply', '--json'], world: scratch => scratch.world() },
  { command: 'cost', state: 'ok', args: ['cost', '--json'], world: scratch => withRecordedRun(scratch.init()) },
  { command: 'cost', state: 'empty', args: ['cost', '--json'], world: (scratch) => {
    const world = scratch.init()
    projectsDir(world)
    return world
  } },
  { command: 'cost', state: 'mismatch', args: ['cost', '--json'], world: scratch => throughSymlinkRecordedAtRealPath(scratch.init()) },
  { command: 'cost', state: 'unknown', args: ['cost', '--json'], world: scratch => withLookalikeKey(scratch.init()) },
  { command: 'cost', state: 'unsupported', args: ['cost', '--json'], world: scratch => scratch.init() },
  { command: 'soulkill', state: 'reported', args: ['soulkill', '--json'], world: scratch => scratch.init() },
  { command: 'mutate apply', state: 'applied', args: applyArgs, world: scratch => withBaseline(scratch, mutationTarget(scratch.world())) },
  { command: 'mutate apply', state: 'refused', args: applyArgs, world: scratch => mutationTarget(scratch.world()) },
  { command: 'mutate judge', state: 'baselineRecorded', args: world => ['mutate', 'judge', '--baseline', '--report', report(world, 'green.json', Date.now(), 'passed'), '--json'], world: scratch => mutationTarget(scratch.world()) },
  { command: 'mutate judge', state: 'refused', args: world => judgeArgs(report(world, 'green.json', Date.now(), 'passed')), world: scratch => mutationTarget(scratch.world()) },
  { command: 'mutate judge', state: 'matched', args: world => judgeArgs(report(world, 'red.json', Date.now(), 'failed')), world: scratch => applied(scratch) },
  { command: 'mutate judge', state: 'unmatched', args: world => judgeArgs(report(world, 'green.json', Date.now(), 'passed')), world: scratch => applied(scratch) },
  { command: 'mutate judge', state: 'noWitness', args: world => judgeArgs(report(world, 'stale.json', 0, 'failed')), world: scratch => applied(scratch) },
  { command: 'mutate judge', state: 'hardFailure', args: world => judgeArgs(report(world, 'red.json', Date.now(), 'failed')), world: scratch => withForeignEdit(applied(scratch)) },
]

export const EXIT_TABLES: Record<string, Record<string, number>> = {
  'doctor': DOCTOR_EXIT,
  'sync': SYNC_EXIT,
  'sync --apply': SYNC_APPLY_EXIT,
  'cost': COST_EXIT,
  'soulkill': SOULKILL_EXIT,
  'mutate apply': MUTATE_APPLY_EXIT,
  'mutate judge': MUTATE_JUDGE_EXIT,
}

function collectKeyPaths(value: unknown, at: string, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value)
      collectKeyPaths(element, `${at}[]`, into)
    return
  }
  if (value == null || typeof value !== 'object')
    return
  for (const [key, child] of Object.entries(value)) {
    const keyPath = at === '' ? key : `${at}.${key}`
    into.add(keyPath)
    collectKeyPaths(child, keyPath, into)
  }
}

export function jsonRoot(value: unknown): JsonRoot {
  if (value === null)
    return 'null'
  if (Array.isArray(value))
    return 'array'
  return typeof value === 'object' ? 'object' : 'scalar'
}

export function keyPaths(value: unknown): string[] {
  const into = new Set<string>()
  collectKeyPaths(value, '', into)
  return [...into].sort()
}

function heldHeadInvariants(sample: Sample, status: number | null, parsed: unknown): void {
  const expected = EXIT_TABLES[sample.command]?.[sample.state]
  if (status !== expected)
    throw new Error(`${sample.command} ${sample.state}: the sample exited ${status}, the state exits ${expected}`)
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed) || !('schemaVersion' in parsed))
    throw new Error(`${sample.command} ${sample.state}: the --json sample carries no top-level schemaVersion`)
}

function parsedOutput(sample: Sample, status: number | null, stdout: string): unknown {
  if (status == null)
    throw new Error(`${sample.command} ${sample.state}: the sample was killed before it exited`)
  try {
    return JSON.parse(stdout) as unknown
  }
  catch {
    throw new Error(`${sample.command} ${sample.state}: the sample exited ${status} and printed no JSON`)
  }
}

function sampled(sample: Sample, scratch: Scratch): JsonSample {
  const world = sample.world(scratch)
  const { status, stdout } = run(scratch.cli, typeof sample.args === 'function' ? sample.args(world) : sample.args, world)
  const parsed = parsedOutput(sample, status, stdout)
  if (scratch.cli.holdsHeadInvariants)
    heldHeadInvariants(sample, status, parsed)
  if (sample.command === 'cost' && (parsed as { status?: unknown }).status !== sample.state)
    throw new Error(`cost ${sample.state}: the sample reports status ${String((parsed as { status?: unknown }).status)}`)
  return { root: jsonRoot(parsed), keys: keyPaths(parsed) }
}

export type UnsampledPair<T> = (command: string, state: string, error: unknown) => T

export function observedJsonKeys<T>(cli: ObservedCli, unsampled: UnsampledPair<T>): Record<string, Record<string, JsonSample | T>> {
  const scratch = new Scratch(realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-json-'))), cli)
  try {
    const keys: Record<string, Record<string, JsonSample | T>> = {}
    for (const sample of SAMPLES) {
      keys[sample.command] ??= {}
      try {
        keys[sample.command][sample.state] = sampled(sample, scratch)
      }
      catch (error) {
        keys[sample.command][sample.state] = unsampled(sample.command, sample.state, error)
      }
    }
    return keys
  }
  finally {
    rmSync(scratch.root, { recursive: true, force: true })
  }
}

function rethrown(_command: string, _state: string, error: unknown): never {
  throw error
}

export function jsonKeys(): JsonKeys {
  return observedJsonKeys(HEAD_CLI, rethrown)
}

export function failureLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0]
}

function unobservedPair(command: string, state: string, error: unknown): Unbaselined {
  return unbaselined(`${command} ${state} could not be observed from the tag: ${failureLine(error)}`)
}

export function tagJsonKeys(cli: ObservedCli): JsonKeysReading {
  return observedJsonKeys(cli, unobservedPair)
}
