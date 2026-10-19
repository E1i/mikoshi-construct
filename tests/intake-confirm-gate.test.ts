import type { CardEvent, IntakeOptions, IntakeResult } from '../src/commands/intake/index.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseParkingFile } from '../src/card/parking.js'
import { textSha } from '../src/card/text-sha.js'
import { ADMIT_SOURCE, AMEND_SOURCE, runAdmit } from '../src/commands/intake/admit.js'
import { bodySha } from '../src/commands/intake/confirm.js'
import { CARD_ADMITTED, INTAKE_EXIT, printIntake, runIntake } from '../src/commands/intake/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const BEFORE_THE_CUTOFF = new Date('2026-10-12T16:00:00.000Z')
const roots: string[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: BEFORE_THE_CUTOFF, toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, repo: string, parking: string, journal: string, draft: string }

function world(cards: Record<string, unknown>[]): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-confirm-'))
  roots.push(root)
  const draft = path.join(root, 'draft.json')
  writeFileSync(draft, JSON.stringify({ cards }))
  return { root, repo: repositoryOf(root, cards), parking: path.join(root, 'parking'), journal: path.join(root, 'ghosts.jsonl'), draft }
}

function repositoryOf(root: string, cards: unknown): string {
  const repo = path.join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const touches = Array.isArray(cards) ? cards.flatMap(card => (card as { touches?: string[] }).touches ?? []) : []
  for (const entry of touches) {
    const target = path.join(repo, entry.replace(/\/\*\*$/, ''))
    mkdirSync(entry.endsWith('/**') ? target : path.dirname(target), { recursive: true })
    if (!entry.endsWith('/**'))
      writeFileSync(target, '')
  }
  return repo
}

function card(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'gate-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', who: 'shift', touches: ['src/a.ts'], task: 'Gate the card.', witnesses: ['`pnpm run quality` is green'], ...fields }
}

function intake(w: World, options: Partial<IntakeOptions> = {}): IntakeResult {
  return runIntake({ draft: w.draft, taken: '-', parking: w.parking, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, readStdin: () => '12', ...options })
}

function journalLines(w: World): Record<string, unknown>[] {
  return existsSync(w.journal) ? readFileSync(w.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

function printed(result: IntakeResult): { lines: string[], exit: number } {
  const lines: string[] = []
  const exit = printIntake(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { lines, exit }
}

const CORRECTION = 'number — #12 → #13 — #12 is taken by a pull request or issue listed in --taken; numbers are assigned by construct intake'

describe('intake confirmation gate', () => {
  it('without --auto-confirm a corrected card is not parked and nothing is journaled until a person confirms the list it printed', () => {
    const w = world([card({ number: 12 })])
    const held = intake(w)
    expect(held.status).toBe('awaiting')
    expect(existsSync(path.join(w.parking, '13.md'))).toBe(false)
    expect(journalLines(w)).toEqual([])
    const { lines, exit } = printed(held)
    expect(exit).toBe(INTAKE_EXIT.awaiting)
    expect(lines.join('\n')).toContain(`corrected: ${CORRECTION}`)
    const token = held.status === 'awaiting' ? held.token : ''
    expect(lines.at(-1)).toContain(`--confirm ${token}`)

    const confirmed = intake(w, { confirm: token })
    expect(confirmed.status).toBe('written')
    const text = readFileSync(path.join(w.parking, '13.md'), 'utf8')
    expect(text).toContain(`corrected: ${CORRECTION}`)
    expect(text).toContain('who: shift')
    expect(journalLines(w)).toMatchObject([{ event: 'intake', task: '13', confirmation: 'person', corrections: [CORRECTION] }])
  })

  it('confirmed slices are parked as cards with depends and no manual step', () => {
    const w = world([card({ touches: ['scripts/bus/queue.ts', 'scripts/bus/round-limit-decision.ts'] })])
    writeFileSync(path.join(w.repo, 'scripts/bus/queue.ts'), 'import { roundLimitDecisionOf } from \'./round-limit-decision.js\'\n')
    const held = intake(w)
    expect(held.status).toBe('awaiting')
    expect(existsSync(w.parking)).toBe(false)
    const token = held.status === 'awaiting' ? held.token : ''
    const confirmed = intake(w, { confirm: token })
    expect(confirmed.status).toBe('written')
    const parked = confirmed.status === 'written' ? confirmed.cards : []
    expect(parked.map(entry => entry.line)).toEqual([
      '#13 gate-card-slice-1 [implement/runner/S/cheap/owner] · depends #14 · blocks —',
      '#14 gate-card-slice-2 [implement/runner/S/cheap/owner] · depends — · blocks #13',
    ])
    for (const [index, entry] of parked.entries()) {
      const text = readFileSync(path.join(w.parking, entry.file), 'utf8')
      expect(text).toContain(`whole: slice ${index + 1} of gate-card`)
      expect(text).toContain('who: shift')
      expect(text).toContain('- `pnpm run quality` is green')
    }
    expect(readFileSync(path.join(w.parking, '13.md'), 'utf8')).toContain('touches: scripts/bus/queue.ts\n')
    expect(readFileSync(path.join(w.parking, '14.md'), 'utf8')).toContain('touches: scripts/bus/round-limit-decision.ts\n')
    expect(journalLines(w)).toMatchObject([{ task: '13', confirmation: 'person' }, { task: '14', confirmation: 'person' }])
  })

  it('card A of probe 1075 passes intake into cards with depends with no manual step', () => {
    const touches = ['scripts/ghosts/hash.ts', 'scripts/ghosts/approval.ts', 'scripts/tests/ghosts/hash.test.ts', 'scripts/bus/inbox.ts', 'scripts/bus/queue.ts', 'scripts/bus/round-limit-decision.ts', 'scripts/bus/update-done.ts', 'scripts/bus/merge-executor.ts', 'scripts/decisions/decisions.ts', 'scripts/ci/update-branch.ts', 'scripts/tests/bus/round-limit-decision.test.ts', 'scripts/tests/bus/merge-queue.test.ts', 'scripts/bus/answerer.ts', 'scripts/bus/answer-worker.ts', 'scripts/bus/lease.ts', 'scripts/tests/bus/answer-node.test.ts', 'scripts/miko/watch.ts', 'scripts/miko/watch-store.ts', 'scripts/tests/miko/watch.test.ts', 'scripts/construct/check-acceptance.mjs', 'templates/ai/claude/scripts/construct/check-acceptance.mjs', 'scripts/ghosts/launch.ts', 'scripts/bus/launch-worker.ts', 'package.json', 'architecture/window.md', '.changeset/**']
    const witness = '`pnpm exec vitest run scripts/tests/ghosts/hash.test.ts scripts/tests/bus/round-limit-decision.test.ts scripts/tests/bus/merge-queue.test.ts scripts/tests/bus/answer-node.test.ts scripts/tests/miko/watch.test.ts` exits 0'
    const w = world([card({ name: 'owner-loop-without-relay', milestone: 'operator', size: 'L', touches, task: 'Card A owner-loop-without-relay, eight items as one task.', witnesses: [witness] })])
    writeFileSync(path.join(w.repo, 'package.json'), '{}\n')
    writeFileSync(path.join(w.repo, 'scripts/bus/queue.ts'), 'import { roundLimitDecisionOf } from \'./round-limit-decision.js\'\n')
    const held = intake(w)
    expect(held.status).toBe('awaiting')
    const confirmed = intake(w, { confirm: held.status === 'awaiting' ? held.token : '' })
    expect(confirmed.status).toBe('written')
    const parked = confirmed.status === 'written' ? confirmed.cards : []
    expect(parked.map(entry => entry.line)).toEqual([
      '#13 owner-loop-without-relay-slice-1 [implement/operator/L/cheap/owner] · depends #14 · blocks —',
      '#14 owner-loop-without-relay-slice-2 [implement/operator/L/cheap/owner] · depends — · blocks #13',
    ])
    expect(parked.map(entry => entry.who)).toEqual(['shift', 'shift'])
    expect(parked.every(entry => entry.slices.length === 0 && entry.unclear.length === 0)).toBe(true)
    const parsed = parked.map(entry => parseParkingFile(entry.file, readFileSync(path.join(w.parking, entry.file), 'utf8')))
    const parkedTouches = parsed.flatMap(entry => (entry.kind === 'parked' ? entry.parked.task.touches : []))
    expect(new Set(parkedTouches)).toEqual(new Set(touches))
    expect(parsed.map(entry => entry.kind === 'parked' && entry.parked.task.touches.includes('scripts/bus/queue.ts'))).toEqual([true, false])
  })

  it('a --confirm token that names another list parks nothing and prints the list this run holds', () => {
    const w = world([card({ number: 12 })])
    const result = intake(w, { confirm: 'not-the-token' })
    expect(result).toMatchObject({ status: 'awaiting', stale: true })
    expect(existsSync(w.parking)).toBe(false)
    expect(printed(result).lines[0]).toContain('--confirm names a different list of corrections')
  })

  it('with --auto-confirm a corrected card is parked at once and its corrections and the flag are written to the journal', () => {
    const w = world([card({ number: 12 }), card({ name: 'clean-card' })])
    const result = intake(w, { autoConfirm: true })
    expect(result.status).toBe('written')
    expect(printed(result).exit).toBe(INTAKE_EXIT.written)
    expect(readFileSync(path.join(w.parking, '13.md'), 'utf8')).toContain('who: shift')
    expect(journalLines(w)).toMatchObject([
      { event: 'intake', task: '13', confirmation: 'auto', corrections: [CORRECTION] },
      { event: 'intake', task: '14', confirmation: 'auto', corrections: [] },
    ])
  })

  it('a draft with no correction is parked without a confirmation and journaled as needing none', () => {
    const w = world([card()])
    const result = intake(w)
    expect(result.status).toBe('written')
    expect(journalLines(w)).toMatchObject([{ event: 'intake', task: '13', confirmation: 'none', corrections: [] }])
  })

  it.each([['the parking root', '', 'lane-01'], ['a lane', 'lane-4', 'lane-4']])('a card sliced and confirmed into %s hands the bus its card.admitted beside the journal line', (_where, lane, expected) => {
    const w = world([card()])
    const bus: CardEvent[] = []
    expect(intake(w, { parking: path.join(w.parking, lane), parkingRoot: w.parking, events: event => bus.push(event) }).status).toBe('written')
    expect(bus).toMatchObject([{ type: CARD_ADMITTED, cardId: 13, payload: { card: expect.stringMatching(/^#13 gate-card /), lane: expected, confirmation: 'none' } }])
    expect(journalLines(w)).toMatchObject([{ event: 'intake', task: '13', ts: bus[0]!.ts }])
  })

  it('a bus-wired draft intake with an accepted correction says it is recorded in the bus', () => {
    const w = world([card({ number: 12 })])
    const { lines } = printed(intake(w, { autoConfirm: true, events: () => {} }))
    expect(lines.join('\n')).toContain('accepted in advance by --auto-confirm, and recorded in the bus.')
  })

  it('--dry-run neither parks nor journals, whatever the corrections', () => {
    const w = world([card({ number: 12 })])
    expect(intake(w, { dryRun: true }).status).toBe('dryRun')
    expect(existsSync(w.parking)).toBe(false)
    expect(journalLines(w)).toEqual([])
    printIntake(createUi(resolveTheme({ plain: true }), silentWriter), intake(w, { dryRun: true }))
  })

  it('an admitted card writes card.admitted to the bus beside its intake line in the journal, an amend writes the amended card again, and a second --admit hands the bus only the key it already holds', () => {
    const w = world([card()])
    const lane = path.join(w.parking, 'lane-2')
    mkdirSync(lane, { recursive: true })
    const file = path.join(lane, '80.md')
    const parked = `card: #80 clean-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-80\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
    writeFileSync(file, parked)
    const bus: CardEvent[] = []
    const keepOncePerDedupeKey = (event: CardEvent) => bus.some(kept => kept.dedupeKey === event.dedupeKey) || bus.push(event)
    const admit = () => runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: keepOncePerDedupeKey })
    expect(admit().status).toBe('admitted')
    const text = readFileSync(file, 'utf8')
    expect(bus).toEqual([{
      type: CARD_ADMITTED,
      cardId: 80,
      ts: expect.any(String),
      dedupeKey: expect.stringMatching(/^card\.admitted:80:/),
      payload: { card: expect.stringMatching(/^#80 clean-card /), lane: 'lane-2', depends: [], decision: 'owner', contour: 'cheap', confirmation: 'none', corrections: [], bodySha: bodySha(text), text, textSha: textSha(text), source: ADMIT_SOURCE },
    }])
    expect(journalLines(w)).toMatchObject([{ event: 'intake', task: '80', source: ADMIT_SOURCE, bodySha: bodySha(text) }])
    expect(admit().status).toBe('alreadyAdmitted')
    writeFileSync(file, parked.replace('Do the thing.', 'Do the other thing.'))
    expect(admit()).toMatchObject({ status: 'admitted', source: AMEND_SOURCE })
    expect(bus).toHaveLength(2)
    expect(bus[1]).toMatchObject({ type: CARD_ADMITTED, cardId: 80, payload: { lane: 'lane-2', bodySha: bodySha(readFileSync(file, 'utf8')), source: AMEND_SOURCE } })
    expect(admit().status).toBe('alreadyAdmitted')
    expect(bus).toHaveLength(2)
    expect(journalLines(w)).toMatchObject([{ source: ADMIT_SOURCE }, { source: AMEND_SOURCE }])
  })

  it('a card admitted at the parking root writes its intake line and hands the bus card.admitted with no lane', () => {
    const w = world([card()])
    mkdirSync(w.parking, { recursive: true })
    const file = path.join(w.parking, '81.md')
    writeFileSync(file, `card: #81 root-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-81\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
    const bus: CardEvent[] = []
    expect(runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: event => bus.push(event) }).status).toBe('admitted')
    expect(bus).toMatchObject([{ type: CARD_ADMITTED, cardId: 81, payload: { card: expect.stringMatching(/^#81 root-card /), lane: null } }])
    expect(journalLines(w)).toMatchObject([{ event: 'intake', task: '81', source: ADMIT_SOURCE }])
  })

  it.each([['notes', 'a parking subdirectory that is no lane'], ['../elsewhere', 'a directory outside the parking tree'], ['lane-2/inner', 'a directory below a lane'], ['../lane-2', 'a lane-named directory outside the parking tree'], ['lane-2/lane-3', 'a lane-named directory below a lane']])('a card admitted from %s (%s) hands the bus card.admitted with no lane', (relative) => {
    const w = world([card()])
    const dir = path.resolve(w.parking, relative)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '82.md')
    writeFileSync(file, `card: #82 stray-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-82\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
    const bus: CardEvent[] = []
    expect(runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: event => bus.push(event) }).status).toBe('admitted')
    expect(bus).toMatchObject([{ type: CARD_ADMITTED, cardId: 82, payload: { lane: null } }])
    expect(journalLines(w)).toMatchObject([{ event: 'intake', task: '82', source: ADMIT_SOURCE }])
  })
})
