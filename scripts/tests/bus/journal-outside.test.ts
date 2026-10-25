import type { CardEvent } from '../../../src/commands/intake/index.js'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JOURNAL_HISTORY_ENDS } from '../../../src/card/closed.js'
import { admittedRecord, recordIntake } from '../../../src/commands/intake/index.js'
import { ghostJournalOf } from '../../cli/check-catalog.js'
import { appendEvent, openBus } from '../../core/db.js'
import { GHOST_LINE, REVIEW_RECORDED, SHARD_ISSUED } from '../../core/events.js'
import { runShard } from '../../policy/shard.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const JOURNAL_NAMES = /ghosts\.jsonl|GHOST_JOURNAL|journalOf\(/
const READERS = ['scripts/policy/decisions/read.ts', 'scripts/policy/decisions/add.ts', 'scripts/window/watch.ts', 'scripts/intake/parking.ts', 'scripts/cli/check-catalog.ts']
const WRITERS = ['scripts/done/check.ts', 'scripts/policy/shard.ts', 'src/commands/mutate/journal.ts', 'src/commands/intake/index.ts']
const FILE_APPENDS = /appendFileSync/
const AFTER_THE_CUTOFF = new Date(Date.parse(JOURNAL_HISTORY_ENDS) + 86_400_000)

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'journal-outside-'))
  roots.push(root)
  return root
}

function source(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

describe('the readers and writers of ghosts.jsonl outside the ladder use the bus', () => {
  it('decisions, watch, parking and check-catalog read the bus and not ghosts.jsonl', () => {
    for (const reader of READERS)
      expect(source(reader), reader).not.toMatch(JOURNAL_NAMES)
    expect(source('scripts/cli/check-catalog.ts')).not.toMatch(/from '\.\.\/ghosts\//)

    const db = openBus(path.join(scratch(), 'bus.db'))
    try {
      const judged = JSON.stringify({ event: 'mutation-judged', card: '616', id: 'M1', outcome: 'named-red', matched: true })
      appendEvent(db, { ts: '2026-10-22T10:00:00.000Z', type: GHOST_LINE, actor: 'worker:test:1', cardId: 616, pr: null, head: null, dedupeKey: 'ghost.line:1', payload: judged, legacy: false })
      appendEvent(db, { ts: '2026-10-22T10:01:00.000Z', type: REVIEW_RECORDED, actor: 'worker:review:1', cardId: 616, pr: null, head: null, dedupeKey: 'review.recorded:1', payload: '{}', legacy: false })
      expect(ghostJournalOf(db)).toBe(`${judged}\n`)
    }
    finally {
      db.close()
    }
  })

  it('check-catalog reads a mutation judged before the cutover from the legacy history ahead of the bus ghost lines', () => {
    const db = openBus(path.join(scratch(), 'bus.db'))
    try {
      const before = { event: 'mutation-judged', card: '600', id: 'M0', outcome: 'named-red', matched: true, ts: '2026-10-10T10:00:00.000Z' }
      const after = JSON.stringify({ event: 'mutation-judged', card: '616', id: 'M1', outcome: 'named-red', matched: true })
      appendEvent(db, { ts: '2026-10-22T10:00:00.000Z', type: GHOST_LINE, actor: 'worker:test:1', cardId: 616, pr: null, head: null, dedupeKey: 'ghost.line:1', payload: after, legacy: false })
      appendEvent(db, { ts: before.ts, type: 'mutation-judged', actor: 'journal', cardId: 600, pr: null, head: null, dedupeKey: 'legacy:mutation-judged:600', payload: before, legacy: true })
      expect(ghostJournalOf(db)).toBe(`${JSON.stringify(before)}\n${after}\n`)
    }
    finally {
      db.close()
    }
  })

  it('done check, shard, mutate and intake write the bus and not ghosts.jsonl', () => {
    for (const writer of WRITERS) {
      expect(source(writer), writer).not.toMatch(JOURNAL_NAMES)
      expect(source(writer), writer).not.toMatch(FILE_APPENDS)
    }

    const recorded: string[] = []
    const shard = runShard(['--card', '726', '--by', 'Eli'], { record: event => recorded.push(event.type), activeWindows: () => [], inForce: () => false, now: () => AFTER_THE_CUTOFF, uuid: () => 'shard-1', by: () => '', out: () => {}, err: () => {} })
    expect(shard).toBe(0)
    expect(recorded).toEqual([SHARD_ISSUED])

    const journal = path.join(scratch(), 'handoff', 'ghosts.jsonl')
    const card = { id: 13, file: '13.md', line: '#13 a-card [implement/runner/S/cheap/owner] · depends — · blocks —', who: 'shift', unclear: [], corrections: [], seam: [], risk: [], slices: [], text: 'card: #13\n' }
    const bus: CardEvent[] = []
    recordIntake([admittedRecord(card, 'none', AFTER_THE_CUTOFF, null)], event => bus.push(event))
    expect(bus.map(event => event.cardId)).toEqual([13])
    expect(existsSync(journal)).toBe(false)
  })

  it('cloud-start is gone and verdict stays in the ladder', () => {
    expect(existsSync(path.join(REPO_ROOT, 'scripts/ghosts/cloud-start.ts'))).toBe(false)
    expect(existsSync(path.join(REPO_ROOT, 'scripts/tests/ghosts/cloud-start.test.ts'))).toBe(false)
    expect(Object.keys(JSON.parse(source('scripts/ci/test-weights.json')) as Record<string, number>)).not.toContain('scripts/tests/ghosts/cloud-start.test.ts')
    expect(source('architecture/ghosts-files.md')).not.toContain('cloud-start')
    expect(source('scripts/nodes/close/task-close.ts')).not.toContain('cloud-start')
    expect(existsSync(path.join(REPO_ROOT, 'scripts/ladder/verdict.ts'))).toBe(true)
    expect(source('architecture/ghosts-files.md')).toContain('| `scripts/ladder/verdict.ts` | ghosts |')
  })
})
