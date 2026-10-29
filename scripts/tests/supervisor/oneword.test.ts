import type { DatabaseSync } from 'node:sqlite'
import type { ModeParts } from '../../supervisor/start.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decisionsFileOf } from '../../core/bus-path.js'
import { appendEvent, openBus } from '../../core/db.js'
import { LIVE_FLAG } from '../../core/node.js'
import { reduce } from '../../core/reducer.js'
import { sayToOwnerChannel } from '../../owner/channel.js'
import { liveDecisionOf } from '../../policy/live-decision.js'
import { activeWindowShards, decisionsInForceAt } from '../../policy/shards.js'
import { busDecisionsAdder, ghostProtocolWord, runMode, startCommandOf } from '../../supervisor/start.js'
import { liveWorkers, returnToWindowAtTermEnd, switchedOn, switchWorker, termEndOf, wantedLaunches } from '../../supervisor/workers.js'

const NOW = new Date('2026-10-29T12:00:00.000Z')
const HOURS = '8'
const TERM_END = new Date('2026-10-29T20:00:00.000Z')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Bench {
  parts: ModeParts
  onBus: <T>(read: (db: DatabaseSync) => T) => T
}

function bench(decisionsUnreadable = false): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'oneword-'))
  roots.push(root)
  const busDb = path.join(root, 'bus', 'bus.db')
  mkdirSync(path.dirname(busDb), { recursive: true })
  if (decisionsUnreadable)
    mkdirSync(decisionsFileOf(busDb))
  const onBus = <T>(read: (db: DatabaseSync) => T): T => {
    const db = openBus(busDb)
    try {
      return read(db)
    }
    finally {
      db.close()
    }
  }
  const channel = path.join(root, 'answers')
  sayToOwnerChannel(channel, ghostProtocolWord(Number(HOURS)), NOW)
  return {
    onBus,
    parts: {
      busDir: path.join(root, 'bus', 'workers'),
      channel,
      now: () => NOW,
      uuid: () => 'shard-1',
      record: event => onBus(db => appendEvent(db, event)),
      activeWindows: now => onBus(db => activeWindowShards(db, now)),
      addDecision: busDecisionsAdder(busDb, () => NOW),
    },
  }
}

function command(...argv: string[]) {
  const parsed = startCommandOf(argv)
  if (parsed === null || parsed.kind === 'start')
    throw new Error(`${argv.join(' ')} is not a mode command`)
  return parsed
}

function ghostProtocol(parts: ModeParts) {
  return runMode(command('--mode', 'ghost-protocol', '--hours', HOURS), parts)
}

function liveScripts(busDir: string, now: Date = NOW): string[] {
  return wantedLaunches(busDir, () => [], [], now).filter(launch => launch.args.includes(LIVE_FLAG)).map(launch => launch.script)
}

describe('oneword: the ghost-protocol word is the only owner word', () => {
  it('ghost-protocol with a shard seeds merge and update live', () => {
    const { parts, onBus } = bench()
    runMode(command('--mode', 'window'), parts)

    const result = ghostProtocol(parts)

    expect(result.exitCode, result.stderr.join('\n')).toBe(0)
    expect(onBus(db => activeWindowShards(db, NOW)).map(shard => shard.id)).toEqual(['shard-1'])
    expect(liveWorkers(parts.busDir)).toEqual(expect.arrayContaining(['merge', 'update']))
    expect(liveScripts(parts.busDir)).toEqual(expect.arrayContaining(['bus:merge', 'bus:update']))
    onBus(db => reduce(db))
    const decisions = onBus(db => decisionsInForceAt(db, NOW))
    expect(liveDecisionOf(decisions, 'merge')).not.toBeNull()
    expect(liveDecisionOf(decisions, 'update')).not.toBeNull()
    expect(liveDecisionOf(onBus(db => decisionsInForceAt(db, TERM_END)), 'merge')).toBeNull()
  })

  it('ghost-protocol seeds close and restart live', () => {
    const { parts } = bench()

    expect(ghostProtocol(parts).exitCode).toBe(0)

    expect(switchedOn(parts.busDir)).toEqual(expect.arrayContaining(['close', 'restart']))
    expect(liveWorkers(parts.busDir)).toEqual(switchedOn(parts.busDir))
    expect(liveScripts(parts.busDir)).toEqual(expect.arrayContaining(['bus:close', 'bus:restart']))
  })

  it('the return to window at the term end leaves no switched-off worker live, so merge switched on later is in shadow', () => {
    const { parts } = bench()
    ghostProtocol(parts)

    expect(returnToWindowAtTermEnd(parts.busDir, new Date(Date.parse(termEndOf(parts.busDir)!) + 1))).toBe(true)
    switchWorker(parts.busDir, 'merge', true)

    expect(liveWorkers(parts.busDir)).not.toContain('merge')
    expect(liveScripts(parts.busDir, TERM_END)).not.toContain('bus:merge')
  })

  it('a live decision that could not be written is named and the mode stays switched', () => {
    const { parts } = bench(true)

    const result = ghostProtocol(parts)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain('allow-live merge was not written')
    expect(result.stderr.join('\n')).toContain('allow-live update was not written')
    expect(liveWorkers(parts.busDir)).toEqual(expect.arrayContaining(['merge', 'update']))
  })
})
