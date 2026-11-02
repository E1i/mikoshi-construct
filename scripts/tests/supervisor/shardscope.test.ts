import type { DatabaseSync } from 'node:sqlite'
import type { ModeParts } from '../../supervisor/start.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { sayToOwnerChannel } from '../../owner/channel.js'
import { activeDecisionsShard, activeWindowShards, DECISIONS_SCOPE } from '../../policy/shards.js'
import { busDecisionsAdder, busDecisionsText, ghostProtocolWord, runMode, startCommandOf } from '../../supervisor/start.js'

const NOW = new Date('2026-11-03T12:00:00.000Z')
const HOURS = 8

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bench(): { parts: ModeParts, onBus: <T>(read: (db: DatabaseSync) => T) => T } {
  const root = mkdtempSync(path.join(tmpdir(), 'shardscope-'))
  roots.push(root)
  const busDb = path.join(root, 'bus', 'bus.db')
  mkdirSync(path.dirname(busDb), { recursive: true })
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
  sayToOwnerChannel(channel, ghostProtocolWord(HOURS), NOW)
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
      decisionsText: busDecisionsText(busDb),
    },
  }
}

describe('shardscope: the ghost-protocol shard lets the window answer card questions', () => {
  it(`ghost-protocol issues a ${DECISIONS_SCOPE} shard, which the regex witness selects as ghost-protocol issues a mergedecisions shard`, () => {
    const { parts, onBus } = bench()
    const parsed = startCommandOf(['--mode', 'ghost-protocol', '--hours', String(HOURS)])
    if (parsed === null || parsed.kind === 'start')
      throw new Error('ghost-protocol is not a mode command')

    const result = runMode(parsed, parts)

    expect(result.exitCode, result.stderr.join('\n')).toBe(0)
    expect(onBus(db => activeWindowShards(db, NOW)).map(shard => shard.scope)).toEqual([DECISIONS_SCOPE])
    expect(onBus(db => activeDecisionsShard(db, NOW))?.id).toBe('shard-1')
    expect(result.stdout.join('\n')).toContain(`scope ${DECISIONS_SCOPE}`)
  })
})
