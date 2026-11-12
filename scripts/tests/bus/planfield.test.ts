import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_PLANNED, CARD_UNPLANNED, PLAN_BACKFILLED, PLAN_CLOSED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_OPENED } from '../../core/events.js'
import { OWNER } from '../../core/inbox.js'
import { reduce } from '../../core/reducer.js'
import { runBusIntake } from '../../intake/intake.js'
import { busProjections } from '../../supervisor/composition.js'
import { runRequest, WindowRequests } from '../../window/window-requests.js'

const RELEASE = 'factory-0.45.2'
const GATE = 'VEDETIRUN'
const SESSION = 'planfield-test'
const BODY_CARD = 7701
const NOW = new Date('2026-11-03T12:00:00.000Z')
const roots: string[] = []
const exitCodes: (typeof process.exitCode)[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
  process.exitCode = exitCodes.pop()
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'planfield-'))
  roots.push(root)
  exitCodes.push(process.exitCode)
  return root
}

function owner(db: DatabaseSync, type: string, cardId: number | null, payload: Record<string, unknown>): void {
  appendEvent(db, { ts: NOW.toISOString(), type, actor: OWNER, cardId, pr: null, head: null, dedupeKey: `${type}:${JSON.stringify(payload)}`, payload, legacy: false })
}

function openRelease(db: DatabaseSync): void {
  owner(db, PLAN_OPENED, null, { id: RELEASE, title: 'Factory 0.45.2', goal: 'vedeti runs without the owner', plan_file: '/plans/0.45.2.md' })
}

function requests(db: DatabaseSync): WindowRequests {
  const refuse = (): never => {
    throw new Error('not used by a plan request')
  }
  return new WindowRequests(db, () => NOW, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: refuse, closePr: refuse, closeDropped: () => [] }, path.join(tmpdir(), 'planfield-no-channel'), () => '0.45.2', process.cwd())
}

function asked(db: DatabaseSync, ...argv: string[]): string[] {
  expect(runRequest(['plan', ...argv], db, NOW, SESSION, () => {})).toBe(0)
  return requests(db).run().map(outcome => `${outcome.kind}: ${outcome.detail}`)
}

function releases(db: DatabaseSync): unknown {
  return db.prepare('SELECT card_id, release FROM card_releases ORDER BY card_id').all()
}

function count(db: DatabaseSync, type: string): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n)
}

function draftIn(root: string): string[] {
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  const card = { name: 'first', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'auto', who: 'shift', touches: ['src/a.ts'], task: 'Change a.', witnesses: ['`pnpm exec vitest run` exits 0'] }
  writeFileSync(path.join(root, 'draft.json'), JSON.stringify({ cards: [card] }))
  writeFileSync(path.join(root, 'taken.txt'), '1\n')
  return ['--draft', path.join(root, 'draft.json'), '--taken', path.join(root, 'taken.txt'), '--dir', repo, '--parking', path.join(root, 'parking'), '--auto-confirm', '--plain']
}

function writeCard(root: string, releaseLine: string, task: string): string {
  const file = path.join(root, `${BODY_CARD}.md`)
  writeFileSync(file, [
    `card: #${BODY_CARD} bodyrelease [implement/runner/S/cheap/auto] · depends — · blocks —`,
    'branch: feat/bodyrelease',
    'touches: src/a.ts',
    'who: shift',
    releaseLine,
    '',
    task,
    '',
    'Witnesses:',
    '- `pnpm exec vitest run` exits 0',
    '',
  ].join('\n'))
  return file
}

function admitting(root: string, releaseLine: string): string[] {
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  return ['--admit', writeCard(root, releaseLine, 'Change a.'), '--dir', repo, '--auto-confirm', '--plain']
}

describe('the release is a field of the card', () => {
  it('a card admitted with --release X carries release X in the bus with no other step', async () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    openRelease(db)
    await runBusIntake(db, [...draftIn(root), '--release', RELEASE], SESSION)
    const admitted = db.prepare('SELECT card_id FROM events WHERE type = ?').all(CARD_ADMITTED) as { card_id: number }[]
    expect(admitted).toHaveLength(1)
    reduce(db, 'pending', busProjections())
    expect(releases(db)).toEqual([{ card_id: admitted[0]!.card_id, release: RELEASE }])
    expect(count(db, CARD_PLANNED)).toBe(1)

    const closed = scratch()
    const empty = openBus(path.join(closed, 'bus.db'))
    await runBusIntake(empty, [...draftIn(closed), '--release', 'no-such-release'], SESSION)
    expect(process.exitCode).toBe(1)
    expect(count(empty, CARD_ADMITTED)).toBe(0)
    db.close()
    empty.close()
  })

  it('a card whose body names a release lands in it with no flag and no plan request', async () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    openRelease(db)
    await runBusIntake(db, admitting(root, `release: ${RELEASE}`), SESSION)
    expect(count(db, CARD_ADMITTED)).toBe(1)
    expect(reduce(db, 'pending', busProjections()).rejected).toBe(0)
    expect(releases(db)).toEqual([{ card_id: BODY_CARD, release: RELEASE }])
    expect(count(db, CARD_PLANNED)).toBe(1)
    db.close()
  })

  it('a body naming a release that is not open admits nothing and plans nothing', async () => {
    const never = scratch()
    const empty = openBus(path.join(never, 'bus.db'))
    await runBusIntake(empty, admitting(never, 'release: no-such-release'), SESSION)
    expect(process.exitCode).toBe(1)
    expect(count(empty, CARD_ADMITTED)).toBe(0)
    expect(count(empty, CARD_PLANNED)).toBe(0)
    empty.close()

    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    openRelease(db)
    reduce(db, 'pending', busProjections())
    owner(db, PLAN_CLOSED, null, { plan: RELEASE })
    process.exitCode = 0
    await runBusIntake(db, admitting(root, `release: ${RELEASE}`), SESSION)
    expect(process.exitCode).toBe(1)
    expect(count(db, CARD_ADMITTED)).toBe(0)
    expect(count(db, CARD_PLANNED)).toBe(0)
    db.close()
  })

  it('a body and a --release that name different releases admit nothing', async () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    openRelease(db)
    owner(db, PLAN_OPENED, null, { id: 'factory-other', title: 'Other', goal: 'another release', plan_file: '/plans/other.md' })
    await runBusIntake(db, [...admitting(root, `release: ${RELEASE}`), '--release', 'factory-other'], SESSION)
    expect(process.exitCode).toBe(1)
    expect(count(db, CARD_ADMITTED)).toBe(0)
    expect(count(db, CARD_PLANNED)).toBe(0)
    db.close()
  })

  it('a body and a --release that name the same open release admit the card into it once', async () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    openRelease(db)
    process.exitCode = 0
    await runBusIntake(db, [...admitting(root, `release: ${RELEASE}`), '--release', RELEASE], SESSION)
    expect(process.exitCode).toBe(0)
    expect(count(db, CARD_ADMITTED)).toBe(1)
    expect(count(db, CARD_PLANNED)).toBe(1)
    expect(reduce(db, 'pending', busProjections()).rejected).toBe(0)
    expect(releases(db)).toEqual([{ card_id: BODY_CARD, release: RELEASE }])
    db.close()
  })

  it('an amended body still naming its release plans nothing more, though the release has closed', async () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    openRelease(db)
    const argv = admitting(root, `release: ${RELEASE}`)
    await runBusIntake(db, argv, SESSION)
    reduce(db, 'pending', busProjections())
    owner(db, PLAN_CLOSED, null, { plan: RELEASE })
    reduce(db, 'pending', busProjections())
    process.exitCode = 0
    writeCard(root, `release: ${RELEASE}`, 'Change a, amended.')
    await runBusIntake(db, argv, SESSION)
    expect(process.exitCode).toBe(0)
    expect(count(db, CARD_ADMITTED)).toBe(2)
    expect(count(db, CARD_PLANNED)).toBe(1)
    expect(reduce(db, 'pending', busProjections()).rejected).toBe(0)
    db.close()
  })

  it('a card moved out by plan remove stays out when its unchanged body is admitted again', async () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    openRelease(db)
    const argv = admitting(root, `release: ${RELEASE}`)
    await runBusIntake(db, argv, SESSION)
    reduce(db, 'pending', busProjections())
    expect(asked(db, '--op', 'remove', '--card', `#${BODY_CARD}`)).toEqual([`done: ${CARD_UNPLANNED} #${BODY_CARD}`])
    reduce(db, 'pending', busProjections())
    await runBusIntake(db, argv, SESSION)
    expect(reduce(db, 'pending', busProjections()).rejected).toBe(0)
    expect(releases(db)).toEqual([])
    expect(count(db, CARD_PLANNED)).toBe(1)
    db.close()
  })

  it('plan remove #N returns the card to the backlog with one card.unplanned event', () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    openRelease(db)
    expect(asked(db, '--op', 'add', '--plan', RELEASE, '--card', '#901')).toEqual([`done: ${CARD_PLANNED} ${RELEASE} #901`])
    reduce(db, 'pending', busProjections())
    expect(releases(db)).toEqual([{ card_id: 901, release: RELEASE }])
    expect(asked(db, '--op', 'remove', '--card', '#901')).toEqual([`done: ${CARD_UNPLANNED} #901`])
    expect(reduce(db, 'pending', busProjections()).rejected).toBe(0)
    expect(releases(db)).toEqual([])
    expect(count(db, CARD_UNPLANNED)).toBe(1)
    db.close()
  })

  it('plan add on a release that is not open is refused and writes no card.planned', () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    expect(asked(db, '--op', 'add', '--plan', 'no-such-release', '--card', '#901')).toEqual([`refused: ${CARD_PLANNED}: release no-such-release is not open`])

    openRelease(db)
    reduce(db, 'pending', busProjections())
    owner(db, PLAN_CLOSED, null, { plan: RELEASE })
    expect(asked(db, '--op', 'add', '--plan', RELEASE, '--card', '#902')).toEqual([`refused: ${CARD_PLANNED}: release ${RELEASE} is not open`])

    reduce(db, 'pending', busProjections())
    owner(db, PLAN_OPENED, null, { id: RELEASE, title: 'opened a second time', goal: 'the reducer rejects it', plan_file: '/plans/0.45.2.md' })
    expect(asked(db, '--op', 'add', '--plan', RELEASE, '--card', '#903')).toEqual([`refused: ${CARD_PLANNED}: release ${RELEASE} is not open`])

    reduce(db, 'pending', busProjections())
    expect(count(db, CARD_PLANNED)).toBe(0)
    expect(releases(db)).toEqual([])
    db.close()
  })

  it('the factory-0.45.2 backfill gives each linked card its release in one event and the gate VEDETIRUN to the release', () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    openRelease(db)
    for (const [item, cards] of [['P0', [1473, 1474]], ['P1', [1480]], ['P2', []]] as const) {
      owner(db, PLAN_ITEM_ADDED, null, { plan: RELEASE, item, title: item })
      for (const card of cards)
        owner(db, PLAN_ITEM_LINKED, card, { plan: RELEASE, item, card })
    }
    reduce(db, 'pending', busProjections())
    expect(asked(db, '--op', 'backfill', '--plan', RELEASE, '--gate', GATE)).toEqual([`done: ${PLAN_BACKFILLED} ${RELEASE}`])
    expect(count(db, PLAN_BACKFILLED)).toBe(1)
    expect(reduce(db, 'pending', busProjections()).rejected).toBe(0)
    expect(releases(db)).toEqual([1473, 1474, 1480].map(card_id => ({ card_id, release: RELEASE })))
    expect(db.prepare('SELECT gate FROM plans WHERE plan_id = ?').get(RELEASE)).toEqual({ gate: GATE })
    expect(asked(db, '--op', 'backfill', '--plan', RELEASE)).toEqual([`refused: ${PLAN_BACKFILLED} needs a --gate and a plan whose items link cards`])
    db.close()
  })
})
