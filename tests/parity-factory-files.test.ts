import type { MergeFacts } from '../scripts/policy/policy.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUS_DB_VARIABLE, DECISIONS_FILE, repoHome, repoIdOf } from '../scripts/core/bus-path.js'
import { decisionsRefusals } from '../scripts/policy/decisions/decisions.js'
import { mergePolicy } from '../scripts/policy/policy.js'
import { OWNER_DECISIONS_HEADER, writeOwnerDecisionsBeside } from '../src/commands/attach/index.js'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const FACTORY_FILES = [
  '.claude/agents/brief.md',
  '.claude/agents/review.md',
  '.claude/agents/scan.md',
  '.claude/skills/probe/SKILL.md',
  '.claude/commands/status.md',
  '.claude/commands/attached-discover.md',
]

const OWNER_MERGES = 'architecture/owner-merges.md'

function scratch(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function gitRepository(): string {
  const dir = scratch('construct-parity-')
  mkdirSync(path.join(dir, '.git'))
  return dir
}

async function initInto(dir: string, home: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const ui = createUi(resolveTheme({ plain: true }), silentWriter)
  const result = await runInit(ui, { dir, preset: 'node-backend', ai: 'claude', yes: true, dryRun: false, env, home })
  return result.status
}

function decisionsFileFor(dir: string, home: string): string {
  return path.join(repoHome(home, repoIdOf(dir)), DECISIONS_FILE)
}

function read(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), 'utf8')
}

function mergeFacts(ownerMergesText: string, files: string[]): MergeFacts {
  return {
    cardId: 7,
    description: '#7 a-card [implement/construct/M/cheap/owner] · depends — · blocks —',
    headRef: 'feat/demo',
    title: 'demo',
    files,
    ownerMergesText,
    shardActive: true,
    shardUnder: null,
    windowShard: null,
    decisions: [],
  }
}

describe('init carries the files the factory reads', () => {
  it('a fresh init carries the brief, review and scan agents and the probe skill', async () => {
    const dir = gitRepository()
    expect(await initInto(dir, scratch('construct-home-'))).toBe('done')
    for (const file of FACTORY_FILES)
      expect(existsSync(path.join(dir, file)), file).toBe(true)
    expect(read(dir, '.claude/agents/brief.md')).toMatch(/^\/implement /m)
    expect(read(dir, '.claude/agents/brief.md')).toContain('~/.construct/<repo-id>/handoff/')
  })

  it('a fresh init writes owner-merges.md and the bus decisions file', async () => {
    const dir = gitRepository()
    const home = scratch('construct-home-')
    expect(await initInto(dir, home)).toBe('done')
    const ownerMerges = read(dir, OWNER_MERGES)
    expect(mergePolicy(mergeFacts(ownerMerges, ['.github/workflows/ci.yml'])).rule).toBe('no_shard_merge')
    expect(mergePolicy(mergeFacts(ownerMerges, ['docs/guide.md'])).rule).toBe('owner_under_shard')
    const decisions = readFileSync(decisionsFileFor(dir, home), 'utf8')
    expect(decisions).toBe(OWNER_DECISIONS_HEADER)
    expect(decisionsRefusals(decisions)).toEqual([])
  })

  it('the init CLAUDE.md says who commits', async () => {
    const dir = gitRepository()
    expect(await initInto(dir, scratch('construct-home-'))).toBe('done')
    const claude = read(dir, 'CLAUDE.md')
    expect(claude).toContain('## Who commits')
    expect(claude).toContain(`(${OWNER_MERGES})`)
  })

  it('the CLAUDE.md block written into an existing repository says who commits', async () => {
    const dir = gitRepository()
    writeFileSync(path.join(dir, 'package.json'), '{ "name": "svc" }\n')
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# svc\n')
    expect(await initInto(dir, scratch('construct-home-'))).toBe('done')
    const claude = read(dir, 'CLAUDE.md')
    expect(claude).toContain('Who commits:')
    expect(claude).toContain(`(${OWNER_MERGES})`)
  })
})

describe('the bus decisions file beside the repository', () => {
  it('keeps a decisions file that is already there byte for byte', async () => {
    const dir = gitRepository()
    const home = scratch('construct-home-')
    const file = decisionsFileFor(dir, home)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '# Owner decisions\n\n- D-1 · kept\n')
    expect(await initInto(dir, home)).toBe('done')
    expect(readFileSync(file, 'utf8')).toBe('# Owner decisions\n\n- D-1 · kept\n')
  })

  it('writes nothing for a directory git does not hold', () => {
    const dir = scratch('construct-parity-nogit-')
    const home = scratch('construct-home-')
    expect(writeOwnerDecisionsBeside(dir, {}, home)).toBeUndefined()
    expect(existsSync(decisionsFileFor(dir, home))).toBe(false)
  })

  it('writes nothing under the home directory when the environment names another bus', () => {
    const dir = gitRepository()
    const home = scratch('construct-home-')
    expect(writeOwnerDecisionsBeside(dir, { [BUS_DB_VARIABLE]: path.join(scratch('construct-bus-'), 'bus.db') }, home)).toBeUndefined()
    expect(existsSync(decisionsFileFor(dir, home))).toBe(false)
  })

  it('writes the header beside the repository bus and reports where', () => {
    const dir = gitRepository()
    const home = scratch('construct-home-')
    expect(writeOwnerDecisionsBeside(dir, {}, home)).toBe(decisionsFileFor(dir, home))
    expect(readFileSync(decisionsFileFor(dir, home), 'utf8')).toBe(OWNER_DECISIONS_HEADER)
  })
})
