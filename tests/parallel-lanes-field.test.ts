import type { Prompter } from '../src/ui/prompts.js'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { runDoctor } from '../src/commands/doctor/index.js'
import { runInit } from '../src/commands/init.js'
import { runSync } from '../src/commands/sync/index.js'
import { DEFAULT_LANES, MANIFEST_FILE, readManifest } from '../src/manifest.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { parseLaneCount } from '../src/ui/prompts.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'
import { useIsolatedHome } from './isolated-home.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const HARNESS = 'pnpm run quality'
const ANSWERED_LANES = 7

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
useIsolatedHome()

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-lanes-'))
}

function gitRepository(): string {
  const dir = scratch()
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir })
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return dir
}

function answering(lanes: number | undefined): { prompter: Prompter, lanesAskedWith: number[] } {
  const lanesAskedWith: number[] = []
  return {
    lanesAskedWith,
    prompter: {
      preset: () => Promise.resolve('node-backend'),
      aiTarget: () => Promise.resolve('claude'),
      projectName: () => Promise.resolve('lanes-demo'),
      review: () => Promise.resolve(false),
      lanes: (initial) => {
        lanesAskedWith.push(initial)
        return Promise.resolve(lanes)
      },
      confirm: () => Promise.resolve(true),
      harnessCommand: () => Promise.resolve(HARNESS),
    },
  }
}

async function attachedWithLanes(): Promise<string> {
  const dir = gitRepository()
  const { prompter } = answering(ANSWERED_LANES)
  expect((await runAttach(ui, { dir, harness: HARNESS, requiredCheck: 'gate', yes: false }, prompter)).status).toBe('done')
  return dir
}

describe('parallel lanes', () => {
  it('init asks how many parallel lanes and writes the answer into construct.json', async () => {
    const dir = scratch()
    const { prompter, lanesAskedWith } = answering(ANSWERED_LANES)
    expect((await runInit(ui, { dir, yes: false, dryRun: false }, prompter)).status).toBe('done')
    expect(lanesAskedWith).toEqual([DEFAULT_LANES])
    expect(readManifest(dir)?.lanes).toBe(ANSWERED_LANES)
    expect((JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')) as { lanes: unknown }).lanes).toBe(ANSWERED_LANES)
  })

  it('init --yes writes the default of 3 parallel lanes', async () => {
    const dir = scratch()
    expect((await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })).status).toBe('done')
    expect(DEFAULT_LANES).toBe(3)
    expect(readManifest(dir)?.lanes).toBe(3)
  })

  it('a lanes flag answers the question, and a count that is not a whole number above zero is refused', async () => {
    const dir = scratch()
    const { prompter, lanesAskedWith } = answering(undefined)
    expect((await runInit(ui, { dir, preset: 'node-backend', name: 'flagged', ai: 'claude', review: 'none', lanes: '2', yes: false, dryRun: false }, prompter)).status).toBe('done')
    expect(lanesAskedWith).toEqual([])
    expect(readManifest(dir)?.lanes).toBe(2)
    for (const value of ['0', '-1', '1.5', 'three', ''])
      expect(() => parseLaneCount(value), value).toThrow(/invalid lane count/)
  })

  it('cancelling the lanes question writes nothing', async () => {
    const dir = scratch()
    const { prompter } = answering(undefined)
    expect((await runInit(ui, { dir, yes: false, dryRun: false }, prompter)).status).toBe('aborted')
    expect(existsSync(path.join(dir, MANIFEST_FILE))).toBe(false)
  })

  it('attach asks how many parallel lanes and writes the answer into the attach record without creating construct.json', async () => {
    const dir = gitRepository()
    const { prompter, lanesAskedWith } = answering(ANSWERED_LANES)
    expect((await runAttach(ui, { dir, harness: HARNESS, requiredCheck: 'gate', yes: false }, prompter)).status).toBe('done')
    expect(lanesAskedWith).toEqual([DEFAULT_LANES])
    expect(readAttachRecord(dir)?.lanes).toBe(ANSWERED_LANES)
    expect(existsSync(path.join(dir, MANIFEST_FILE))).toBe(false)
  })

  it('attach --yes records the default of 3 parallel lanes', async () => {
    const dir = gitRepository()
    expect((await runAttach(ui, { dir, harness: HARNESS, requiredCheck: 'gate', yes: true })).status).toBe('done')
    expect(readAttachRecord(dir)?.lanes).toBe(DEFAULT_LANES)
  })

  it('doctor and sync read a repository attached with a lanes answer as attached', async () => {
    const dir = await attachedWithLanes()
    const doctor = runDoctor(dir)
    if (doctor == null || !('state' in doctor))
      throw new Error('expected an attached report')
    expect(doctor.state).toBe('attached')
    expect(runSync(dir, VERSION)).toBeNull()
    expect(existsSync(path.join(dir, MANIFEST_FILE))).toBe(false)
    expect((await runAttach(ui, { dir, harness: HARNESS, requiredCheck: 'gate', yes: true })).refusal).toBe('attached')
  })
})
