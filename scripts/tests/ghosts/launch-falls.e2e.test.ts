import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WORLD = path.join(REPO_ROOT, 'scripts/tests/ghosts/fixtures/world.sh')
const LAUNCH = path.join(REPO_ROOT, 'scripts/ghosts/launch.ts')
const CARD = 902

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

function cardedWorld(kind: string): string {
  return world('new', kind)
}

function launch(w: string, args: string[] = []): { status: number | null, output: string } {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), LAUNCH, '--tasks', path.join(w, 'tasks.json'), ...args], {
    input: 'yes\n',
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(w, 'bin')}:${process.env.PATH}` },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function journalOf(w: string): Record<string, unknown>[] {
  const journalPath = path.join(w, 'handoff', 'ghosts.jsonl')
  if (!existsSync(journalPath))
    return []
  return readFileSync(journalPath, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event !== 'path')
}

function recordTwoFalls(w: string): void {
  expect(launch(w, ['--fall', 'review-hole', '--card', String(CARD)]).status).toBe(0)
  expect(launch(w, ['--fall', 'hash-recounted', '--card', `#${CARD}`]).status).toBe(0)
}

describe('ghosts:launch refuses a third Ghost on a card that fell twice', () => {
  it('records each fall in the journal under the card number', () => {
    const w = cardedWorld('ok')
    recordTwoFalls(w)
    expect(journalOf(w).map(({ event, card, kind }) => ({ event, card, kind }))).toEqual([
      { event: 'fall', card: CARD, kind: 'review-hole' },
      { event: 'fall', card: CARD, kind: 'hash-recounted' },
    ])
  })

  it('refuses the launch with "cut the task" after two falls and opens nothing', () => {
    const w = cardedWorld('ok')
    recordTwoFalls(w)
    const { status, output } = launch(w)
    expect(status).toBe(1)
    expect(output).toContain(`task g2: card #${CARD} fell 2 times (review-hole, hash-recounted); cut the task into sub-cards with construct intake`)
    expect(output).not.toContain('task g1:')
    world('check-untouched', w)
    expect(journalOf(w).filter(line => line.event !== 'fall')).toEqual([])
  })

  it('launches after one fall', () => {
    const w = cardedWorld('ok')
    expect(launch(w, ['--fall', 'base-red', '--card', String(CARD)]).status).toBe(0)
    expect(launch(w).status).toBe(0)
  })

  it('accepts the launch with the owner\'s flag and writes the flag into the journal before the entries', () => {
    const w = cardedWorld('ok')
    recordTwoFalls(w)
    const { status } = launch(w, ['--owner-allows', String(CARD)])
    expect(status).toBe(0)
    const journal = journalOf(w)
    const allowed = journal.findIndex(line => line.event === 'owner-allows')
    expect(journal[allowed]).toMatchObject({ event: 'owner-allows', card: CARD, tasks: ['g2'] })
    expect(allowed).toBeLessThan(journal.findIndex(line => line.event === 'entry'))
  })

  it('records a ladder that ended not done as a fall of its card', () => {
    const w = cardedWorld('failing')
    launch(w)
    expect(journalOf(w).filter(line => line.event === 'fall').map(({ card, kind }) => ({ card, kind }))).toEqual([{ card: CARD, kind: 'ladder-not-done' }])
  })

  it('refuses an unknown fall kind', () => {
    const w = cardedWorld('ok')
    const { status, output } = launch(w, ['--fall', 'tired', '--card', String(CARD)])
    expect(status).not.toBe(0)
    expect(output).toContain('fall: expected one of base-red, ladder-not-done, review-hole, handoff-without-pr, hash-recounted')
    expect(journalOf(w)).toEqual([])
  })
})
