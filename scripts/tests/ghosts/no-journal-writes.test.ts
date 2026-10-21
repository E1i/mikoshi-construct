import type { TaskCloseDeps } from '../../ghosts/task-close.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { BUS_DB_VARIABLE, openBus } from '../../bus/db.js'
import { rememberedPreflight } from '../../ghosts/hash.js'
import { ghostLines } from '../../ghosts/journal.js'
import { recordFall } from '../../ghosts/supervise.js'
import { runTaskClose } from '../../ghosts/task-close.js'
import { recordDisposition } from '../../ghosts/verdict.js'
import { runShift } from '../../shift/shift.js'
import { read } from '../core/gh-fake.js'
import { captured, depsOf, fakeGh, newWorld } from '../shift/fixtures/autopilot-world.js'
import { ownBusPerTest } from './own-bus.js'

const NOW = new Date('2026-10-21T09:00:00.000Z')
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const LAUNCH = path.join(REPO_ROOT, 'scripts/ghosts/launch.ts')
const TSX = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')

const busOf = ownBusPerTest()

interface Place { handoff: string, bus: string }

function eventTypes(busPath: string): string[] {
  const db = openBus(busPath)
  try {
    return (db.prepare('SELECT type FROM events WHERE legacy = 0 ORDER BY id').all() as { type: string }[]).map(row => row.type)
  }
  finally {
    db.close()
  }
}

function closeDeps(handoffDir: string, busPath: string): TaskCloseDeps {
  const start = JSON.stringify({ event: 'path', task: '123', path: 'cheap', started: 'x', worktree: '/mc-123', branch: 'feat/123', card: { id: 123, name: 'n', kind: 'implement', milestone: 'ghosts', size: 'S', contour: 'cheap', decision: 'owner', depends: [], blocks: [], line: 'l' }, ts: 'x' })
  return {
    cwd: handoffDir,
    read: file => file === path.join(handoffDir, 'ghosts.jsonl') ? `${start}\n` : null,
    busPath,
    now: () => NOW,
    handoffDir,
    constructDir: path.join(handoffDir, '.construct'),
    realpath: file => file,
    exists: () => false,
    session: undefined,
    projectsDir: path.join(handoffDir, 'projects'),
    tokens: () => null,
    prBody: () => read(null),
  }
}

function launchCli(place: Place, args: string[]): void {
  const tasks = path.join(place.handoff, 'tasks.json')
  writeFileSync(tasks, JSON.stringify({ repo: place.handoff, status: path.join(place.handoff, 'status.md'), out: place.handoff, tasks: [] }))
  const result = spawnSync(process.execPath, [TSX, LAUNCH, '--tasks', tasks, ...args], { encoding: 'utf8', env: { ...process.env, [BUS_DB_VARIABLE]: place.bus } })
  expect(result.status, result.stderr).toBe(0)
}

function journalBytes(place: Place): string {
  const journal = path.join(place.handoff, 'ghosts.jsonl')
  return existsSync(journal) ? readFileSync(journal, 'utf8') : ''
}

function inHandoff(): Place {
  return { handoff: mkdtempSync(path.join(tmpdir(), 'no-journal-')), bus: busOf() }
}

async function failingShiftCard(): Promise<Place> {
  const world = newWorld([{ id: 1, body: 'do 1 STUB-FAIL' }])
  await runShift([world.shift, '--parking', world.parking], depsOf(world, fakeGh({}).gh, captured()))
  return { handoff: world.handoff, bus: world.bus }
}

const COMMANDS: { name: string, run: () => Promise<Place>, writes: string }[] = [
  { name: 'verdict --disposition', run: async () => {
    const place = inHandoff()
    await recordDisposition({ task: 't', pr: '520', followUp: '519', by: 'window' }, place.handoff, NOW)
    return place
  }, writes: 'ghost.line' },
  { name: 'a ladder fall', run: async () => {
    const place = inHandoff()
    await recordFall(123, 'ladder-not-done', 'session')
    return place
  }, writes: 'ghost.line' },
  { name: 'task:close', run: async () => {
    const place = inHandoff()
    runTaskClose(['123', '--pr', '460', '--verification', 'run'], closeDeps(place.handoff, place.bus))
    return place
  }, writes: 'card.verified' },
  { name: 'ghosts:launch --fall', run: async () => {
    const place = inHandoff()
    launchCli(place, ['--fall', 'review-hole', '--card', '123'])
    return place
  }, writes: 'ghost.line' },
  { name: 'ghosts:launch --revoke', run: async () => {
    const place = inHandoff()
    launchCli(place, ['--revoke', 'd'.repeat(64), '--card', '123'])
    return place
  }, writes: 'ghost.line' },
  { name: 'ghosts:hash preflight memory', run: async () => {
    const place = inHandoff()
    const remembered = rememberedPreflight(() => {}, { journalPath: path.join(place.handoff, 'ghosts.jsonl'), base: () => 'a'.repeat(40), log: () => {}, now: () => NOW })
    remembered.preflight({ briefPath: path.join(place.handoff, 'brief.md'), text: '/implement 123 n', sketch: { kind: 'none', reason: 'r' }, buildStdout: '' })
    return place
  }, writes: 'ghost.line' },
  { name: 'a shift card that stops', run: failingShiftCard, writes: 'ghost.line' },
]

describe('the window commands write the bus, not the journal', () => {
  it.each(COMMANDS)('no window command appends to ghosts.jsonl: $name writes $writes to the bus', async ({ run, writes }) => {
    const place = await run()
    expect(journalBytes(place)).toBe('')
    expect(eventTypes(place.bus)).toContain(writes)
  })

  it('no window command appends to ghosts.jsonl: a shift stop line is read back from the bus', async () => {
    const place = await failingShiftCard()
    expect(ghostLines(place.bus).filter(line => line.event === 'stop')).toMatchObject([{ task: '1', at: 'fault' }])
  })
})
