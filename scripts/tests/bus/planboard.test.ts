import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { droppedLine, GATE_DUE, GATE_OPEN, goalOf, planLine } from '../../../src/commands/board/goal.js'
import { PLAIN_LORE } from '../../../src/ui/lore.js'
import { exportedPlan, printBoard, printPlan, runBoardCli } from '../../cli/board-page.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_PLANNED, PLAN_OPENED } from '../../core/events.js'
import { OWNER } from '../../core/inbox.js'
import { reduce } from '../../core/reducer.js'
import { runBusIntake } from '../../intake/intake.js'

const RELEASE = 'factory-0.45.2'
const GATE = 'VEDETIRUN'
const SESSION = 'planboard-test'
const NOW = new Date('2026-11-03T12:00:00.000Z')
const roots: string[] = []
const exitCodes: (typeof process.exitCode)[] = []

beforeEach(() => {
  vi.stubEnv('BUS_RERUN', '')
})

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
  process.exitCode = exitCodes.pop()
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'planboard-'))
  roots.push(root)
  exitCodes.push(process.exitCode)
  return root
}

function owner(db: DatabaseSync, type: string, cardId: number | null, payload: Record<string, unknown>): void {
  appendEvent(db, { ts: NOW.toISOString(), type, actor: OWNER, cardId, pr: null, head: null, dedupeKey: `${type}:${cardId}:${JSON.stringify(payload)}`, payload, legacy: false })
}

function openRelease(db: DatabaseSync, gate: string | null = GATE): void {
  owner(db, PLAN_OPENED, null, { id: RELEASE, title: 'Factory 0.45.2', goal: 'vedeti runs without the owner', plan_file: '/plans/0.45.2.md', ...(gate === null ? {} : { gate }) })
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

function releaseBench(states: Record<number, string>): DatabaseSync {
  const db = openBus(path.join(scratch(), 'bus.db'))
  openRelease(db)
  for (const card of Object.keys(states).map(Number))
    owner(db, CARD_PLANNED, card, { release: RELEASE })
  expect(reduce(db).rejected).toBe(0)
  for (const [card, state] of Object.entries(states))
    db.prepare('INSERT OR REPLACE INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, 1)').run(Number(card), state)
  return db
}

function releaseOf(db: DatabaseSync): NonNullable<ReturnType<typeof goalOf>>['plans'][number] {
  const release = goalOf(db, NOW)?.plans.find(plan => plan.id === RELEASE)
  expect(release).toBeDefined()
  return release!
}

describe('the release board is a filter of cards by their release', () => {
  it('a card admitted with --release X shows in release X on the board with no other step', async () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    openRelease(db)
    await runBusIntake(db, [...draftIn(root), '--release', RELEASE], SESSION)
    const admitted = (db.prepare('SELECT card_id FROM events WHERE type = ?').all(CARD_ADMITTED) as { card_id: number }[]).map(row => row.card_id)
    expect(admitted).toHaveLength(1)
    reduce(db)
    const release = releaseOf(db)
    expect(release.cards).toEqual([{ card: admitted[0], mark: 'queued' }])
    expect(release).toMatchObject({ total: 1, remainder: 1, stages: { queued: 1 } })
    expect(goalOf(db, NOW)!.backlog).toBe(0)
    db.close()
  })

  it('a dropped card leaves the remainder and shows as one dropped line', () => {
    const db = releaseBench({ 901: 'merged', 902: 'running', 903: 'dropped', 904: 'closed' })
    const release = releaseOf(db)
    expect(release).toMatchObject({ delivered: 1, total: 2, remainder: 1 })
    expect(droppedLine(release, PLAIN_LORE)).toBe('dropped 2: #903, #904')
    expect(planLine(release, 0)).not.toContain('903')
    const html = renderBoardOf(db)
    expect(html.match(/class="goal-dropped"/g)).toHaveLength(1)
    expect(html).toContain('<div class="goal-dropped">dropped 2: #903, #904</div>')
    db.close()
  })

  it('the remainder is the count of unmerged cards with release X', () => {
    const db = releaseBench({ 911: 'merged', 912: 'running', 913: 'in_review', 914: 'queued', 915: 'queued' })
    const release = releaseOf(db)
    expect(release).toMatchObject({ delivered: 1, total: 5, remainder: 4, stages: { delivered: 1, in_progress: 1, review: 1, queued: 2 } })
    expect(planLine(release, 0)).toBe(`Factory 0.45.2: merged 1 of 5 · in work 1 · review 1 · queue 2 · remainder 4 · gate ${GATE}: ${GATE_OPEN} · +1 in 24 h · backlog: 0`)
    db.close()
  })

  it('the gate is the exit criterion: open while the remainder holds a card, due once it is empty', () => {
    const db = releaseBench({ 921: 'merged', 922: 'dropped' })
    expect(releaseOf(db).gate).toEqual({ word: GATE, status: GATE_DUE })
    const ungated = openBus(path.join(scratch(), 'bus.db'))
    openRelease(ungated, null)
    reduce(ungated)
    expect(planLine(releaseOf(ungated), 0)).toContain('gate: not set')
    db.close()
    ungated.close()
  })

  it('plan.md is an export of the release from the bus, grouped by stage', () => {
    const db = releaseBench({ 931: 'merged', 932: 'running', 933: 'dropped' })
    const text = exportedPlan(db, RELEASE, NOW)!
    expect(text.split('\n').slice(0, 5)).toEqual(['# Factory 0.45.2', '', 'vedeti runs without the owner', '', planLine(releaseOf(db), 0)])
    expect(text.indexOf('## merged (1)\n\n- #931\n')).toBeLessThan(text.indexOf('## in work (1)\n\n- #932\n'))
    expect(text.indexOf('## in work (1)\n\n- #932\n')).toBeLessThan(text.indexOf('## dropped (1)\n\n- #933\n'))
    expect(text).not.toContain('## review')
    expect(exportedPlan(db, 'no-such-release', NOW)).toBeNull()
    db.close()
  })

  it('pnpm board --plan prints the export with each card named from its body, and refuses a release that is not open', async () => {
    const root = scratch()
    const busFile = path.join(root, 'bus.db')
    const db = openBus(busFile)
    openRelease(db)
    await runBusIntake(db, [...draftIn(root), '--release', RELEASE], SESSION)
    reduce(db)
    const [card] = releaseOf(db).cards
    db.close()
    let written = ''
    expect(printPlan(busFile, RELEASE, NOW, (text) => {
      written += text
    })).toBe(0)
    expect(written).toContain(`## queue (1)\n\n- #${card!.card} first\n`)
    expect(printPlan(busFile, 'closed-release', NOW, () => {})).toBe(1)
    expect(runBoardCli(busFile, ['--plan'])).toBe(2)
  })
})

function renderBoardOf(db: DatabaseSync): string {
  const busFile = (db.prepare('PRAGMA database_list').get() as { file: string }).file
  let html = ''
  expect(printBoard(busFile, NOW, (text) => {
    html += text
  }, path.join(path.dirname(busFile), 'miko.md'), 'html')).toBe(0)
  return html
}
