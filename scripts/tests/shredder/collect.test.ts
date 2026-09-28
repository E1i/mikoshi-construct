/* eslint-disable test/prefer-lowercase-title */
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const WORLD_SH = path.join(import.meta.dirname, 'collect-fixtures', 'world.sh')
const COLLECT_TS = path.join(REPO_ROOT, 'scripts', 'shredder', 'collect.ts')
const COLLECTOR = process.env.SHREDDER_COLLECTOR

function newWorld(kind: string): string {
  return execFileSync('bash', [WORLD_SH, 'new', kind], { encoding: 'utf8' }).trim()
}

function worldCheck(check: string, world: string): void {
  execFileSync('bash', [WORLD_SH, check, world], { encoding: 'utf8' })
}

function collectorInvocation(args: string[]): { cmd: string, cmdArgs: string[] } {
  return { cmd: 'pnpm', cmdArgs: ['exec', 'tsx', COLLECTOR ?? COLLECT_TS, ...args] }
}

interface RunResult { status: number, stdout: string, stderr: string }

function runCollector(world: string, extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  const { cmd, cmdArgs } = collectorInvocation(['--queue', path.join(world, 'queue.json'), '--out', path.join(world, 'snapshot')])
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv }
  env.PATH = `${path.join(world, 'bin')}:${env.PATH ?? ''}`
  const result = spawnSync(cmd, cmdArgs, { cwd: REPO_ROOT, encoding: 'utf8', env })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function writeCollectOut(world: string, result: RunResult): void {
  writeFileSync(path.join(world, 'collect.out'), `${result.stdout}${result.stderr}`)
}

function run(world: string, extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  const result = runCollector(world, extraEnv)
  writeCollectOut(world, result)
  return result
}

function taskFile(world: string, name: string): string {
  return readFileSync(path.join(world, 'snapshot', 'tasks', name), 'utf8')
}

describe('shredder collector', () => {
  it('P1 should extract the /implement text from a brief with a header', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    const content = taskFile(world, '01-a.brief.md')
    expect(content).toContain('/implement Task a changes src/a.ts.')
  })

  it('P1 should not copy the header into the output (an /implementation line is not the start)', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    const content = taskFile(world, '01-a.brief.md')
    expect(content).not.toContain('This header is not part of the approved text')
    expect(content).not.toMatch(/^\/implementation/m)
  })

  it('P2 should keep the Paths: line from an issue that has one', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    const content = taskFile(world, '02-271.issue.md')
    expect(content).toBe('# Collect the docs\n\nPaths: `docs/guide.md`; `src/b.ts`\n')
  })

  it('P2 should not invent a Paths: line for an issue without one', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    const content = taskFile(world, '04-280.issue.md')
    expect(content).toBe('# Unknown paths\n')
  })

  it('P3 should list a tracked file in files.txt', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    const files = readFileSync(path.join(world, 'snapshot', 'files.txt'), 'utf8').split('\n')
    expect(files).toContain('README.md')
  })

  it('P3 should not list an untracked file in files.txt', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    const files = readFileSync(path.join(world, 'snapshot', 'files.txt'), 'utf8').split('\n')
    expect(files).not.toContain('untracked.txt')
  })

  it('P4 should set runsAwaitingApproval true for a head with an action_required run', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    const prs = JSON.parse(readFileSync(path.join(world, 'snapshot', 'open-prs.json'), 'utf8')) as { number: number, runsAwaitingApproval: boolean }[]
    expect(prs.find(pr => pr.number === 11)?.runsAwaitingApproval).toBe(true)
  })

  it('P4 should not set runsAwaitingApproval for a head with only success runs', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    const prs = JSON.parse(readFileSync(path.join(world, 'snapshot', 'open-prs.json'), 'utf8')) as { number: number, runsAwaitingApproval: boolean }[]
    expect(prs.find(pr => pr.number === 12)?.runsAwaitingApproval).toBe(false)
  })

  it('P5 should copy status.md and owner-merges.md byte for byte', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    worldCheck('check-snapshot', world)
  })

  it('P5 should not replace their invalid UTF-8 bytes with U+FFFD', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    worldCheck('check-bytes', world)
  })

  it('P6 should write a new --out', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    worldCheck('check-snapshot', world)
  })

  it('P6 should not touch an existing --out, refusing and leaving it as it was', () => {
    const world = newWorld('occupied-out')
    expect(run(world).status).not.toBe(0)
    worldCheck('check-refused', world)
  })

  it('P7 should write the snapshot when every gh call succeeds', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    worldCheck('check-snapshot', world)
  })

  it('P7 should not hide a failing gh call, naming it and leaving nothing', () => {
    for (const kind of ['gh-pr-fails', 'gh-issue-fails', 'gh-run-fails']) {
      const world = newWorld(kind)
      expect(run(world).status).not.toBe(0)
      worldCheck('check-refused', world)
    }
  })

  it('P8 should accept a valid queue', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    worldCheck('check-snapshot', world)
  })

  it('P8 should not accept a queue with an unknown or missing key', () => {
    for (const kind of ['unknown-task-field', 'missing-top-field', 'unknown-top-field', 'missing-task-field']) {
      const world = newWorld(kind)
      expect(run(world).status).not.toBe(0)
      worldCheck('check-refused', world)
    }
  })

  it('P9 should list files from a working git ls-files', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    worldCheck('check-snapshot', world)
  })

  it('P9 should not hide a failing git ls-files, naming it and leaving nothing', () => {
    const world = newWorld('git-fails')
    expect(run(world).status).not.toBe(0)
    worldCheck('check-refused', world)
  })

  it('P10 should write the temporary directory next to --out and rename it into place', () => {
    const world = newWorld('ok')
    const fsSpyLog = path.join(world, '.world', 'fs-spy.log')
    const result = runCollector(world, {
      NODE_OPTIONS: `--import ${path.join(world, '.world', 'fs-spy.mjs')}`,
      FS_SPY_LOG: fsSpyLog,
      FS_SPY_SCOPE: world,
    })
    writeCollectOut(world, result)
    expect(result.status).toBe(0)
    worldCheck('check-snapshot', world)
    worldCheck('check-rename', world)
  })

  it('P10 should not create the temporary directory directly in the system temporary directory, and should not copy it', () => {
    const world = newWorld('ok')
    const fsSpyLog = path.join(world, '.world', 'fs-spy.log')
    const result = runCollector(world, {
      NODE_OPTIONS: `--import ${path.join(world, '.world', 'fs-spy.mjs')}`,
      FS_SPY_LOG: fsSpyLog,
      FS_SPY_SCOPE: world,
    })
    writeCollectOut(world, result)
    expect(result.status).toBe(0)
    worldCheck('check-rename', world)
    const ops = readFileSync(fsSpyLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { op: string, from: string, to: string | null })
    const created = ops.filter(op => op.op === 'mkdtemp' && path.dirname(op.from) === world)
    expect(created).toHaveLength(1)
    expect(ops.some(op => op.op === 'cp')).toBe(false)
  })

  it('P11 should refuse an invalid queue first when checked against an existing --out', () => {
    const world = newWorld('unknown-top-field')
    const outDir = path.join(world, 'snapshot')
    execFileSync('mkdir', [outDir])
    execFileSync('bash', ['-c', 'echo keep > "$1"', '--', path.join(outDir, 'keep.txt')])
    const result = run(world)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('reviewers')
  })

  it('P11 should not let the existing --out be blamed first; it stays as it was', () => {
    const world = newWorld('unknown-top-field')
    const outDir = path.join(world, 'snapshot')
    execFileSync('mkdir', [outDir])
    execFileSync('bash', ['-c', 'echo keep > "$1"', '--', path.join(outDir, 'keep.txt')])
    const result = run(world)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).not.toContain(outDir)
    expect(readFileSync(path.join(outDir, 'keep.txt'), 'utf8')).toBe('keep\n')
    expect(readdirSync(outDir)).toEqual(['keep.txt'])
  })

  it('P12 should accept a brief task with a worktree and issue tasks whose shape is well-formed', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    worldCheck('check-snapshot', world)
  })

  it('P12 should not accept a task whose shape is wrong: brief with issue, worktree on issue, or a wrong-typed key', () => {
    for (const kind of ['task-brief-and-issue', 'task-worktree-on-issue', 'task-wrong-type', 'top-wrong-type']) {
      const world = newWorld(kind)
      expect(run(world).status).not.toBe(0)
      worldCheck('check-refused', world)
    }
  })

  it('P13 should list every open pull request and run past gh\'s default limit', () => {
    const world = newWorld('many-prs')
    expect(run(world).status).toBe(0)
    const prs = JSON.parse(readFileSync(path.join(world, 'snapshot', 'open-prs.json'), 'utf8')) as { number: number, runsAwaitingApproval: boolean }[]
    expect(prs).toHaveLength(31)
  })

  it('P13 should not cut open pull requests or runs at gh\'s default limit', () => {
    const world = newWorld('many-prs')
    expect(run(world).status).toBe(0)
    const prs = JSON.parse(readFileSync(path.join(world, 'snapshot', 'open-prs.json'), 'utf8')) as { number: number, runsAwaitingApproval: boolean }[]
    expect(prs).toHaveLength(31)
    expect(prs.find(pr => pr.number === 11)?.runsAwaitingApproval).toBe(true)
  })

  it('P14 should list a non-ASCII tracked path as itself', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    const files = readFileSync(path.join(world, 'snapshot', 'files.txt'), 'utf8').split('\n')
    expect(files).toContain('docs/café.md')
  })

  it('P14 should not quote a non-ASCII path in files.txt', () => {
    const world = newWorld('ok')
    expect(run(world).status).toBe(0)
    const text = readFileSync(path.join(world, 'snapshot', 'files.txt'), 'utf8')
    expect(text).not.toMatch(/^"/m)
  })

  it('P15 should move the snapshot into place with one rename', () => {
    const world = newWorld('ok')
    const fsSpyLog = path.join(world, '.world', 'fs-spy.log')
    const result = runCollector(world, {
      NODE_OPTIONS: `--import ${path.join(world, '.world', 'fs-spy.mjs')}`,
      FS_SPY_LOG: fsSpyLog,
      FS_SPY_SCOPE: world,
    })
    writeCollectOut(world, result)
    expect(result.status).toBe(0)
    worldCheck('check-rename', world)
    const before = readFileSync(path.join(world, '.world', 'entries-before'), 'utf8').split('\n').filter(Boolean)
    expect(readdirSync(world).sort()).toEqual([...before, 'collect.out', 'snapshot'].sort())
  })

  it('P15 should not leave a temporary directory when the rename fails, naming the rename and leaving --out untouched', () => {
    const world = newWorld('out-appears')
    const result = runCollector(world, { NODE_OPTIONS: `--import ${path.join(world, '.world', 'out-appears.mjs')}` })
    writeCollectOut(world, result)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('rename')
    worldCheck('check-refused', world)
  })

  it('P16 should run every gh call in the queue\'s repo', () => {
    const world = newWorld('ok')
    expect(run(world, { GH_REPO: 'elsewhere/other' }).status).toBe(0)
    const log = readFileSync(path.join(world, '.world', 'gh-calls.log'), 'utf8')
    for (const line of log.split('\n').filter(Boolean))
      expect(line).toContain(`cwd=${path.join(world, 'repo')} `)
  })

  it('P16 should not run a gh call outside the repo: not the caller\'s directory, not the caller\'s GH_REPO', () => {
    const world = newWorld('ok')
    expect(run(world, { GH_REPO: 'elsewhere/other' }).status).toBe(0)
    const log = readFileSync(path.join(world, '.world', 'gh-calls.log'), 'utf8')
    for (const line of log.split('\n').filter(Boolean)) {
      expect(line.endsWith('GH_REPO=')).toBe(true)
      expect(line).not.toContain(`cwd=${REPO_ROOT} `)
    }
  })
})

describe('shredder collector outside the Design (#337)', () => {
  it('should read a gh output larger than the default 1 MiB buffer', () => {
    const world = newWorld('large-output')
    expect(run(world).status).toBe(0)
    const prs = JSON.parse(readFileSync(path.join(world, 'snapshot', 'open-prs.json'), 'utf8')) as { title: string }[]
    expect(prs[0]!.title).toHaveLength(2_000_000)
  })

  it('should name the error of a call that could not start, and leave nothing', () => {
    const world = newWorld('repo-missing')
    expect(run(world).status).not.toBe(0)
    worldCheck('check-refused', world)
  })

  it('should name the gh call whose output is not JSON, and leave nothing', () => {
    for (const kind of ['gh-pr-garbled', 'gh-issue-garbled', 'gh-run-garbled']) {
      const world = newWorld(kind)
      expect(run(world).status).not.toBe(0)
      worldCheck('check-refused', world)
    }
  })

  it('should not replace an empty directory that appears at --out during the run', () => {
    const world = newWorld('empty-out-appears')
    const result = runCollector(world, { NODE_OPTIONS: `--import ${path.join(world, '.world', 'empty-out-appears.mjs')}` })
    writeCollectOut(world, result)
    expect(result.status).not.toBe(0)
    worldCheck('check-refused', world)
  })

  it('should resolve the queue\'s relative paths against the queue file\'s directory, not the caller\'s', () => {
    const world = newWorld('relative-paths')
    expect(run(world).status).toBe(0)
    worldCheck('check-snapshot', world)
  })
})
