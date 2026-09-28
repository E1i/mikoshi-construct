import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const LIFECYCLE_TIMEOUT_MS = 120_000

interface Call { args: string[], status: number | null, stdout: string, stderr: string }

type WorldSh = (...args: string[]) => string

interface WorldRow {
  kind: string
  script: string
  prefixes: string[]
  lifecycle: (worldSh: WorldSh) => void
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

const WORLDS: WorldRow[] = [
  {
    kind: 'ghost',
    script: 'scripts/tests/ghosts/fixtures/world.sh',
    prefixes: ['ghost-world.'],
    lifecycle: (worldSh) => {
      const w = worldSh('new', 'ok')
      worldSh('check-untouched', w)
      worldSh('clean', w)
    },
  },
  {
    kind: 'watch',
    script: 'scripts/tests/ghosts/watch-fixtures/world.sh',
    prefixes: ['watch-world.'],
    lifecycle: (worldSh) => {
      const w = worldSh('new', 'alive')
      const pids = readFileSync(path.join(w, '.world', 'pids'), 'utf8').split('\n').filter(Boolean).map(Number)
      expect(pids.length).toBeGreaterThan(0)
      worldSh('clean', w)
      expect(pids.filter(isRunning)).toEqual([])
    },
  },
  {
    kind: 'morse',
    script: 'scripts/tests/morse/fixtures/world.sh',
    prefixes: ['morse-world.', 'morse-backtest.', 'morse-refused-out.', 'morse-refused-err.', 'morse-classify-out.', 'morse-classify-err.', 'morse-rule-got.'],
    lifecycle: (worldSh) => {
      const w = worldSh('new')
      worldSh('check-classify-empty')
      worldSh('check-backtest-refused', 'not-json')
      worldSh('check-backtest')
      worldSh('clean', w)
    },
  },
  {
    kind: 'collect',
    script: 'scripts/tests/shredder/collect-fixtures/world.sh',
    prefixes: ['collect-world.', 'collect-decoy.'],
    lifecycle: (worldSh) => {
      const w = worldSh('new', 'ok')
      const decoy = worldSh('decoy', 'faithful')
      worldSh('clean', w)
      worldSh('clean', decoy)
    },
  },
]

let tmp = ''

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'worlds-test-')))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('test worlds leave nothing in TMPDIR', () => {
  it.each(WORLDS)('a $kind world is removed once its test is done, with every temporary of its calls', ({ script, prefixes, lifecycle }) => {
    const calls: Call[] = []
    const worldSh: WorldSh = (...args) => {
      const result = spawnSync('bash', [path.join(REPO_ROOT, script), ...args], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } })
      calls.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr })
      return result.stdout.trim()
    }
    lifecycle(worldSh)
    const created = calls.filter(call => call.args[0] === 'new' || call.args[0] === 'decoy').map(call => call.stdout.trim())
    expect(created.length).toBeGreaterThan(0)
    for (const made of created)
      expect(made.startsWith(`${tmp}/`)).toBe(true)
    expect(readdirSync(tmp).filter(name => prefixes.some(prefix => name.startsWith(prefix)))).toEqual([])
    expect(calls.filter(call => call.status !== 0)).toEqual([])
  }, LIFECYCLE_TIMEOUT_MS)
})
