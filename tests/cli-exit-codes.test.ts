import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli-process.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const FROZEN_010 = path.join(import.meta.dirname, 'fixtures/sync/materialized-by-0.1.0')

interface World {
  home: string
  dir: string
}

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-exit-'))
  const home = path.join(root, 'home')
  const dir = path.join(root, 'repo')
  mkdirSync(home)
  mkdirSync(dir)
  return { home, dir }
}

async function run(w: World, ...args: string[]): Promise<number | null> {
  return (await runCli([...args, '--dir', w.dir], w.home)).status
}

async function initialised(): Promise<World> {
  const w = world()
  expect(await run(w, 'init', '--yes', '--preset', 'node-library')).toBe(0)
  return w
}

function gitRepository(): World {
  const w = world()
  cpSync(EXISTING_MONOREPO, w.dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: w.dir })
  return w
}

async function attached(): Promise<World> {
  const w = gitRepository()
  expect(await run(w, 'attach', '--yes', '--harness', 'pnpm run quality')).toBe(0)
  return w
}

function frozen010(): World {
  const w = world()
  cpSync(path.join(FROZEN_010, 'construct.json'), path.join(w.dir, 'construct.json'))
  cpSync(path.join(FROZEN_010, 'AGENTS.md.frozen'), path.join(w.dir, 'AGENTS.md'))
  cpSync(path.join(FROZEN_010, 'CLAUDE.md.frozen'), path.join(w.dir, 'CLAUDE.md'))
  mkdirSync(path.join(w.dir, 'architecture'))
  cpSync(path.join(FROZEN_010, 'security-invariants.md.frozen'), path.join(w.dir, 'architecture/security-invariants.md'))
  return w
}

function vitestReport(w: World, name: string, startTime: number, status: 'passed' | 'failed'): string {
  const file = path.join(w.home, name)
  const assertionResults = [{ ancestorTitles: ['within'], title: 'is strict', status }]
  writeFileSync(file, JSON.stringify({ startTime, testResults: [{ name: path.join(w.dir, 'tests/limit.test.ts'), status, assertionResults }] }))
  return file
}

async function mutable(): Promise<World & { brief: string }> {
  const w = world()
  const source = path.join(w.dir, 'src/limit.ts')
  mkdirSync(path.dirname(source))
  writeFileSync(source, 'export const within = (a: number, b: number): boolean => a < b\n')
  const past = new Date(Date.now() - 3_600_000)
  utimesSync(source, past, past)
  const brief = path.join(w.home, 'brief.md')
  writeFileSync(brief, 'M1 | src/limit.ts | find: `a < b` → `a <= b` | red: tests/limit.test.ts › within › is strict\nM2 | src/limit.ts | find: `a < b` → `b > a` | red: green\n')
  expect(await run(w, 'mutate', 'judge', '--baseline', '--report', vitestReport(w, 'green.json', Date.now(), 'passed'))).toBe(0)
  return { ...w, brief }
}

function appliedAt(w: World, id: string): number {
  return (JSON.parse(readFileSync(path.join(w.dir, `.construct/mutations/${id}.json`), 'utf8')) as { appliedAt: number }).appliedAt
}

describe.concurrent('every command exits with the code it exits with today, as a literal', () => {
  it('init: written 0, dry run 0, no terminal without --yes 1, unknown preset 1', async () => {
    expect(await run(world(), 'init', '--yes', '--preset', 'node-library')).toBe(0)
    expect(await run(world(), 'init', '--yes', '--preset', 'node-library', '--dry-run')).toBe(0)
    expect(await run(world(), 'init', '--preset', 'node-library')).toBe(1)
    expect(await run(world(), 'init', '--yes', '--preset', 'nope')).toBe(1)
  })

  it('attach and its alias: attached 0, refused 1', async () => {
    expect(await run(gitRepository(), 'attach', '--yes', '--harness', 'pnpm run quality')).toBe(0)
    expect(await run(gitRepository(), 'jack-in', '--yes', '--harness', 'pnpm run quality')).toBe(0)
    expect(await run(world(), 'attach', '--yes', '--harness', 'pnpm run quality')).toBe(1)
  })

  it('detach and its alias: detached 0, nothing attached 0, refused 1', async () => {
    expect(await run((await attached()), 'detach')).toBe(0)
    expect(await run((await attached()), 'jack-out')).toBe(0)
    expect(await run(world(), 'detach')).toBe(0)
    const orphan = (await attached())
    rmSync(path.join(orphan.dir, '.construct/attach.json'))
    expect(await run(orphan, 'detach')).toBe(1)
  })

  it('doctor: intact 0, broken 1, no construct.json 1, a later manifest 1; the same under --json', async () => {
    const intact = (await initialised())
    expect(await run(intact, 'doctor')).toBe(0)
    expect(await run(intact, 'doctor', '--json')).toBe(0)
    const broken = (await initialised())
    rmSync(path.join(broken.dir, 'architecture/principles.md'))
    expect(await run(broken, 'doctor')).toBe(1)
    expect(await run(broken, 'doctor', '--json')).toBe(1)
    expect(await run(world(), 'doctor')).toBe(1)
    expect(await run(world(), 'doctor', '--json')).toBe(1)
    const ahead = world()
    writeFileSync(path.join(ahead.dir, 'construct.json'), '{"manifestVersion": 99}\n')
    expect(await run(ahead, 'doctor')).toBe(1)
  })

  it('sync: up to date 0, no construct.json 1, pending 2', async () => {
    expect(await run((await initialised()), 'sync')).toBe(0)
    expect(await run(world(), 'sync')).toBe(1)
    expect(await run(frozen010(), 'sync')).toBe(2)
    expect(await run(frozen010(), 'sync', '--json')).toBe(2)
  })

  it('sync --apply: written 0, no construct.json 1, a pending merged target refused 2', async () => {
    expect(await run(frozen010(), 'sync', '--apply')).toBe(0)
    expect(await run(world(), 'sync', '--apply')).toBe(1)
    const merged = frozen010()
    writeFileSync(path.join(merged.dir, 'package.json'), '{}\n')
    expect(await run(merged, 'sync', '--apply')).toBe(2)
  })

  it('cost: no session store 3, a store with nothing for this directory 0, a look-alike key only 1', async () => {
    const w = (await initialised())
    expect(await run(w, 'cost')).toBe(3)
    expect(await run(w, 'cost', '--json')).toBe(3)
    mkdirSync(path.join(w.home, '.claude/projects'), { recursive: true })
    expect(await run(w, 'cost')).toBe(0)
    mkdirSync(path.join(w.home, '.claude/projects', `-elsewhere-${path.basename(w.dir)}`))
    expect(await run(w, 'cost')).toBe(1)
  })

  it('graph: drawn 0, no model 0', async () => {
    expect(await run((await initialised()), 'graph')).toBe(0)
    expect(await run(world(), 'graph')).toBe(0)
  })

  it('soulkill and its aliases: 0, with and without --json', async () => {
    const w = (await initialised())
    for (const command of ['soulkill', 'inspect', 'capture'])
      expect(await run(w, command), command).toBe(0)
    expect(await run(w, 'soulkill', '--json')).toBe(0)
  })

  it('mutate apply: applied 0, refused 1', async () => {
    const w = await mutable()
    expect(await run(w, 'mutate', 'apply', '--from', w.brief, '--id', 'M1')).toBe(0)
    expect(await run(w, 'mutate', 'apply', '--from', w.brief, '--id', 'M1')).toBe(1)
    expect(await run(world(), 'mutate', 'apply', '--from', w.brief, '--id', 'M1')).toBe(1)
  })

  it('mutate judge: matched 0, baseline recorded 0, refused 1, unmatched 2, no witness 2, hard failure 3', async () => {
    const matched = await mutable()
    expect(await run(matched, 'mutate', 'apply', '--from', matched.brief, '--id', 'M1')).toBe(0)
    expect(await run(matched, 'mutate', 'judge', '--id', 'M1', '--json', '--report', vitestReport(matched, 'm1.json', appliedAt(matched, 'M1') + 1, 'failed'))).toBe(0)
    expect(await run(matched, 'mutate', 'judge', '--baseline', '--report', vitestReport(matched, 'red.json', Date.now(), 'failed'))).toBe(1)
    expect(await run(matched, 'mutate', 'judge', '--id', 'M9', '--report', vitestReport(matched, 'm9.json', Date.now(), 'failed'))).toBe(1)
    const unmatched = await mutable()
    expect(await run(unmatched, 'mutate', 'apply', '--from', unmatched.brief, '--id', 'M2')).toBe(0)
    expect(await run(unmatched, 'mutate', 'judge', '--id', 'M2', '--report', vitestReport(unmatched, 'm2.json', appliedAt(unmatched, 'M2') + 1, 'failed'))).toBe(2)
    const stale = await mutable()
    expect(await run(stale, 'mutate', 'apply', '--from', stale.brief, '--id', 'M1')).toBe(0)
    expect(await run(stale, 'mutate', 'judge', '--id', 'M1', '--report', vitestReport(stale, 'm1.json', appliedAt(stale, 'M1') - 1, 'failed'))).toBe(2)
    const foreign = await mutable()
    expect(await run(foreign, 'mutate', 'apply', '--from', foreign.brief, '--id', 'M1')).toBe(0)
    writeFileSync(path.join(foreign.dir, 'src/limit.ts'), 'export const someoneElse = true\n')
    expect(await run(foreign, 'mutate', 'judge', '--id', 'M1', '--report', vitestReport(foreign, 'm1.json', appliedAt(foreign, 'M1') + 1, 'failed'))).toBe(3)
  })
})
