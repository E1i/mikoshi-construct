import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { SIGNAL_FIELDS } from '../../../src/ui/signal.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORLD = path.join(REPO_ROOT, 'scripts/tests/ghosts/fixtures/world.sh')
const LAUNCH = path.join(REPO_ROOT, 'scripts/ghosts/launch.ts')

const LABEL_WIDTH = Math.max(...SIGNAL_FIELDS.map(field => field.length))

const created: string[] = []

function world(...args: string[]): string {
  const result = spawnSync('bash', [WORLD, ...args], { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`world.sh ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  if (args[0] === 'new')
    created.push(result.stdout.trim())
  return result.stdout.trim()
}

afterEach(() => {
  while (created.length > 0)
    world('clean', created.pop()!)
})

function launchOk(): { printed: string[], journal: Record<string, string>[] } {
  const w = world('new', 'ok')
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), LAUNCH, '--tasks', path.join(w, 'tasks.json')], {
    input: 'yes\n',
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(w, 'bin')}:${process.env.PATH}` },
  })
  expect(result.status).toBe(0)
  const journal = readFileSync(path.join(w, 'handoff', 'ghosts.jsonl'), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, string>)
  return { printed: result.stdout.split('\n'), journal }
}

describe('ghosts:launch writes the entry card it prints', () => {
  it('prints RESULT accepted · not started in every card, and writes one entry line per task before its task line', () => {
    const { printed, journal } = launchOk()
    const entries = journal.filter(line => line.event === 'entry')
    expect(printed.filter(line => line === 'RESULT   | accepted · not started')).toHaveLength(entries.length)
    expect(printed.some(line => line.includes('not launched'))).toBe(false)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(journal.indexOf(entry)).toBeLessThan(journal.findIndex(line => line.event === 'task' && line.task === entry.task))
      expect(Object.keys(entry).sort()).toEqual(['event', 'task', 'ts', ...SIGNAL_FIELDS].sort())
    }
  })

  it('writes the same CONTRACT, EXPECT and ACTION the card printed, byte for byte', () => {
    const { printed, journal } = launchOk()
    for (const entry of journal.filter(line => line.event === 'entry')) {
      for (const field of ['CONTRACT', 'EXPECT', 'ACTION'] as const)
        expect(printed, `${entry.task} ${field}`).toContain(`${field.padEnd(LABEL_WIDTH)} | ${entry[field]}`)
    }
  })
})
