import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPORT_FORMATS } from '../src/commands/mutate/index.js'
import { AI_TARGETS, PRESET_IDS, REVIEW_PROVIDERS } from '../src/presets/index.js'
import { runCli } from './cli-process.js'

const RECORDED_SURFACE = path.resolve(import.meta.dirname, '../contract/surface.json')
const UNKNOWN_VALUE = 'not-a-value'
const UNKNOWN_FLAG = 'definitely-not-a-flag'
const STACK_FRAME = /^\s+at /m

const ENUMERABLE_FLAGS: Array<[command: string, flag: string, options: readonly string[]]> = [
  ['init', 'preset', PRESET_IDS],
  ['init', 'ai', AI_TARGETS],
  ['init', 'review', REVIEW_PROVIDERS],
  ['attach', 'ai', AI_TARGETS],
  ['mutate judge', 'format', REPORT_FORMATS],
]

interface World {
  home: string
  dir: string
}

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-flags-'))
  const home = path.join(root, 'home')
  const dir = path.join(root, 'repo')
  mkdirSync(home)
  mkdirSync(dir)
  return { home, dir }
}

function recordedEnumerableFlags(): string[] {
  const surface = JSON.parse(readFileSync(RECORDED_SURFACE, 'utf8')) as { commands: Record<string, { flags?: Record<string, { options?: string[] }> }> }
  return Object.entries(surface.commands)
    .filter(([, command]) => command.flags != null)
    .flatMap(([name, command]) => Object.entries(command.flags ?? {}).filter(([, flag]) => flag.options != null).map(([flag]) => `${name} ${flag}`))
    .sort()
}

describe('an enumerable flag refuses a value outside its options before anything is written', () => {
  it('covers every flag the recorded surface lists with options, and no other', () => {
    const covered = [...new Set(ENUMERABLE_FLAGS.map(([command, flag]) => `${command} ${flag}`))].sort()
    expect(covered).toEqual(recordedEnumerableFlags())
  })

  it.each(ENUMERABLE_FLAGS)('%s --%s names the flag, the value and every allowed value', async (command, flag, options) => {
    const w = world()
    const run = await runCli([...command.split(' '), '--dir', w.dir, `--${flag}`, UNKNOWN_VALUE], w.home)

    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`--${flag}`)
    expect(run.stderr).toContain(UNKNOWN_VALUE)
    for (const option of options)
      expect(run.stderr).toContain(option)
    expect(readdirSync(w.dir)).toEqual([])
  }, 60_000)
})

describe('an unknown flag is refused the way citty refuses an argument', () => {
  it.each([
    ['doctor', 'USAGE construct doctor'],
    ['mutate judge', 'USAGE mutate judge'],
  ])('%s prints its usage, names the flag on stderr without a stack trace, exits 1 and writes nothing', async (command, usage) => {
    const w = world()
    const run = await runCli([...command.split(' '), '--dir', w.dir, `--${UNKNOWN_FLAG}`], w.home)

    expect(run.status).toBe(1)
    expect(run.stdout).toContain(usage)
    expect(run.stderr).toContain(`--${UNKNOWN_FLAG}`)
    expect(run.stderr).not.toMatch(STACK_FRAME)
    expect(readdirSync(w.dir)).toEqual([])
  }, 60_000)

  it('names every unknown flag, as it was typed, not only the first', async () => {
    const w = world()
    const run = await runCli(['doctor', '--dir', w.dir, '--first-unknown', '--no-second-unknown'], w.home)

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('--first-unknown')
    expect(run.stderr).toContain('--no-second-unknown')
    expect(readdirSync(w.dir)).toEqual([])
  }, 60_000)
})
