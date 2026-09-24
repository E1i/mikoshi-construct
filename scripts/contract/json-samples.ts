import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { COST_EXIT } from '../../src/commands/cost/index.js'
import { DOCTOR_EXIT } from '../../src/commands/doctor/index.js'
import { SOULKILL_EXIT } from '../../src/commands/soulkill.js'
import { SYNC_APPLY_EXIT, SYNC_EXIT } from '../../src/commands/sync/index.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const TSX = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const CLI = path.join(REPO_ROOT, 'src/cli.ts')
const FROZEN_010 = path.join(REPO_ROOT, 'tests/fixtures/sync/materialized-by-0.1.0')
const RUNTIME_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CURSOR_AGENT', 'CURSOR_TRACE_ID']
const MACHINE_COREPACK_HOME = process.env.COREPACK_HOME ?? path.join(homedir(), '.cache', 'node', 'corepack')
const SAMPLE_PRESET = 'node-library'

export type JsonKeys = Record<string, Record<string, string[]>>

interface World {
  dir: string
  home: string
}

interface Sample {
  command: string
  state: string
  args: string[]
  world: (scratch: Scratch) => World
}

export function cliEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', HOME: home, COREPACK_HOME: MACHINE_COREPACK_HOME }
  for (const name of RUNTIME_MARKERS)
    delete env[name]
  return env
}

function run(args: string[], world: World): { status: number | null, stdout: string } {
  const result = spawnSync(process.execPath, [TSX, CLI, ...args, '--dir', world.dir], { env: cliEnv(world.home), encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout }
}

class Scratch {
  private count = 0
  private initialised: string | null = null

  constructor(readonly root: string) {}

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
      const status = run(['init', '--yes', '--preset', SAMPLE_PRESET], world).status
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
]

const EXIT_TABLES: Record<string, Record<string, number>> = {
  'doctor': DOCTOR_EXIT,
  'sync': SYNC_EXIT,
  'sync --apply': SYNC_APPLY_EXIT,
  'cost': COST_EXIT,
  'soulkill': SOULKILL_EXIT,
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

export function keyPaths(value: unknown): string[] {
  const into = new Set<string>()
  collectKeyPaths(value, '', into)
  return [...into].sort()
}

function sampled(sample: Sample, scratch: Scratch): string[] {
  const { status, stdout } = run(sample.args, sample.world(scratch))
  const expected = EXIT_TABLES[sample.command]?.[sample.state]
  if (status !== expected)
    throw new Error(`${sample.command} ${sample.state}: the sample exited ${status}, the state exits ${expected}`)
  const parsed = JSON.parse(stdout) as unknown
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed) || !('schemaVersion' in parsed))
    throw new Error(`${sample.command} ${sample.state}: the --json sample carries no top-level schemaVersion`)
  if (sample.command === 'cost' && (parsed as { status?: unknown }).status !== sample.state)
    throw new Error(`cost ${sample.state}: the sample reports status ${String((parsed as { status?: unknown }).status)}`)
  return keyPaths(parsed)
}

export function jsonKeys(): JsonKeys {
  const scratch = new Scratch(realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-json-'))))
  try {
    const keys: JsonKeys = {}
    for (const sample of SAMPLES) {
      keys[sample.command] ??= {}
      keys[sample.command][sample.state] = sampled(sample, scratch)
    }
    return keys
  }
  finally {
    rmSync(scratch.root, { recursive: true, force: true })
  }
}
