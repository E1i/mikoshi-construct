import type { DatabaseSync } from 'node:sqlite'
import type { CardWait, CardWaitsPort } from '../../../src/commands/intake/admit.js'
import type { RequestTools } from '../../window/window-requests.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { appendEvent, BUS_DB_VARIABLE } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_VERIFIED, PR_OBSERVED, REQUEST_DONE, REQUEST_REFUSED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardAdmissions, busCardEvents, busHeldCards } from '../../intake/intake.js'
import { launchWaitsOf, layLanes } from '../../nodes/launch/lane-assign.js'
import { busProjections, openComposedBus } from '../../supervisor/composition.js'
import { requestFromWindow, WindowRequests } from '../../window/window-requests.js'

const NOW = new Date('2026-11-19T09:00:00.000Z')
const [BOUND, HELD, THIRD, FOURTH] = [2047, 2065, 2090, 2091]
const OPEN_PR = 1770
const SHARED = 'src/x.ts'
const APART = 'src/y.ts'
const ELSEWHERE = 'src/z.ts'
const HEAD = 'a'.repeat(40)
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function body(id: number, touches: string, depends: readonly number[] = []): string {
  const after = depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')
  const witness = { id: 'W1', run: `pnpm exec vitest run tests/card-${id}.test.ts`, test: `the card ${id} test`, head: 'pass', base: 'fail', proves: `what card ${id} proves` }
  return `card: #${id} card-${id} [implement/runner/S/cheap/owner] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n\nwitnesses: ${JSON.stringify([witness])}\n`
}

interface World { db: DatabaseSync, repo: string, root: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'wait-binding-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  for (const file of [SHARED, APART, ELSEWHERE])
    writeFileSync(path.join(repo, file), '')
  mkdirSync(path.join(root, '.construct', 'parking'), { recursive: true })
  const bus = path.join(root, 'bus.db')
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  vi.stubEnv('HOME', root)
  return { db: openComposedBus(bus), repo, root }
}

function admitWith(w: World, id: number, touches: string, depends: readonly number[], cardWaits: CardWaitsPort, text: string = body(id, touches, depends)): ReturnType<typeof runAdmit> {
  const result = runAdmit({ file: path.join(w.root, `${id}.md`), body: text, dir: w.repo, dryRun: false, autoConfirm: true, events: busCardEvents(w.db), admissions: busCardAdmissions(w.db), cardStates: () => busHeldCards(w.db), cardWaits }, () => NOW)
  reduce(w.db, 'pending', busProjections())
  return result
}

function admitted(w: World, id: number, touches: string, depends: readonly number[] = []): void {
  expect(admitWith(w, id, touches, depends, launchWaitsOf(w.db, w.repo)).status).toBe('admitted')
}

function waitsFrom(table: Record<number, readonly CardWait[]>): CardWaitsPort {
  return cardId => [...table[cardId] ?? []]
}

const NO_WAITS = waitsFrom({})

function started(w: World, id: number): void {
  appendEvent(w.db, { ts: NOW.toISOString(), type: CARD_STARTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${id}:test`, payload: {}, legacy: false })
  reduce(w.db, 'pending', busProjections())
}

function withOpenPr(w: World, id: number, pr: number): void {
  started(w, id)
  appendEvent(w.db, { ts: NOW.toISOString(), type: PR_OBSERVED, actor: 'policy', cardId: id, pr, head: null, dedupeKey: `${PR_OBSERVED}:${id}:test`, payload: { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'pending', auto_merge: false, draft: false }, legacy: false })
  reduce(w.db, 'pending', busProjections())
}

function amended(w: World, request: Record<string, unknown>): { type: string, detail: string } {
  const id = requestFromWindow(w.db, NOW.toISOString(), 'test', { kind: 'amend', ...request })
  const tools = { closeDropped: () => [] } as unknown as RequestTools
  new WindowRequests(w.db, () => new Date(NOW.getTime() + id * 1000), tools, path.join(w.root, 'channel'), () => null, w.repo, {} as never).run()
  reduce(w.db, 'pending', busProjections())
  return w.db.prepare(`SELECT type, json_extract(payload, '$.detail') AS detail FROM events WHERE type IN (?, ?) AND json_extract(payload, '$.request') = ?`).get(REQUEST_DONE, REQUEST_REFUSED, id) as { type: string, detail: string }
}

function admissions(w: World, id: number): number {
  return Number((w.db.prepare('SELECT count(*) AS n FROM events WHERE type = ? AND card_id = ?').get(CARD_ADMITTED, id) as { n: number }).n)
}

describe('binding a wait of one card on another refuses a cycle and names both cards', () => {
  it('an amend binding a card to wait on a card whose launch its own open PR holds is refused and names both cards', () => {
    const w = world()
    admitted(w, BOUND, SHARED)
    withOpenPr(w, BOUND, OPEN_PR)
    admitted(w, HELD, SHARED)
    expect(launchWaitsOf(w.db, w.repo)(HELD)).toEqual([{ card: BOUND, why: `overlap with open PR #${OPEN_PR} on ${SHARED}` }])
    const before = admissions(w, BOUND)
    const answer = amended(w, { card: BOUND, depends: `+#${HELD}` })
    expect(answer.type).toBe(REQUEST_REFUSED)
    expect(answer.detail).toContain(`#${BOUND} depends on #${HELD}, and #${HELD} waits on #${BOUND} (overlap with open PR #${OPEN_PR} on ${SHARED}), so neither ever moves`)
    expect(admissions(w, BOUND)).toBe(before)
    w.db.close()
  })

  it('an amend binding a card to wait on a card whose launch its own running session holds is refused and names both cards', () => {
    const w = world()
    admitted(w, BOUND, SHARED)
    started(w, BOUND)
    admitted(w, HELD, SHARED)
    const why = `overlap with the session of #${BOUND} on ${SHARED}`
    expect(launchWaitsOf(w.db, w.repo)(HELD)).toEqual([{ card: BOUND, why }])
    const before = admissions(w, BOUND)
    const answer = amended(w, { card: BOUND, depends: `+#${HELD}` })
    expect(answer.type).toBe(REQUEST_REFUSED)
    expect(answer.detail).toContain(`#${BOUND} depends on #${HELD}, and #${HELD} waits on #${BOUND} (${why}), so neither ever moves`)
    expect(admissions(w, BOUND)).toBe(before)
    w.db.close()
  })

  it('an amend binding a card to wait on a card whose launch its own lane holds is refused and names both cards', () => {
    const w = world()
    admitted(w, BOUND, APART)
    admitted(w, HELD, ELSEWHERE)
    layLanes(w.db, 1, NOW.toISOString(), 'policy', null, [])
    reduce(w.db, 'pending', busProjections())
    started(w, BOUND)
    const [wait] = launchWaitsOf(w.db, w.repo)(HELD)
    expect(wait?.card).toBe(BOUND)
    expect(wait?.why).toMatch(new RegExp(`^#${BOUND} at the head of `))
    const before = admissions(w, BOUND)
    const answer = amended(w, { card: BOUND, depends: `+#${HELD}` })
    expect(answer.type).toBe(REQUEST_REFUSED)
    expect(answer.detail).toContain(`#${BOUND} depends on #${HELD}, and #${HELD} waits on #${BOUND} (${wait?.why}), so neither ever moves`)
    expect(admissions(w, BOUND)).toBe(before)
    w.db.close()
  })

  it('an amend binding a card to wait on a card that already depends on it is refused and names both cards', () => {
    const w = world()
    admitted(w, BOUND, SHARED)
    admitted(w, HELD, APART, [BOUND])
    const before = admissions(w, BOUND)
    const answer = amended(w, { card: BOUND, depends: `+#${HELD}` })
    expect(answer.type).toBe(REQUEST_REFUSED)
    expect(answer.detail).toContain(`#${BOUND} depends on #${HELD}, and #${HELD} depends on #${BOUND}, so neither ever moves`)
    expect(admissions(w, BOUND)).toBe(before)
    w.db.close()
  })

  it('an amend binding a card to wait on a card that waits on nothing leading back is admitted', () => {
    const w = world()
    admitted(w, THIRD, SHARED)
    withOpenPr(w, THIRD, OPEN_PR)
    admitted(w, HELD, SHARED)
    admitted(w, BOUND, ELSEWHERE)
    expect(launchWaitsOf(w.db, w.repo)(HELD)).toEqual([{ card: THIRD, why: `overlap with open PR #${OPEN_PR} on ${SHARED}` }])
    expect(amended(w, { card: BOUND, depends: `+#${HELD}` }).type).toBe(REQUEST_DONE)
    w.db.close()
  })

  it('an admission whose wait chain leads back through two cards is refused and names the whole chain', () => {
    const w = world()
    for (const id of [HELD, THIRD])
      expect(admitWith(w, id, APART, [], NO_WAITS).status).toBe('admitted')
    const chain = waitsFrom({ [HELD]: [{ card: THIRD, why: 'lane held' }], [THIRD]: [{ card: BOUND, why: `depends on #${BOUND}` }] })
    const result = admitWith(w, BOUND, SHARED, [HELD], chain)
    expect(result).toEqual({ status: 'refused', why: `#${BOUND} depends on #${HELD}, and #${HELD} waits on #${THIRD} (lane held), #${THIRD} depends on #${BOUND}, so none of them ever moves; drop the depends or settle #${BOUND} first` })
    w.db.close()
  })

  it('an admission whose depended card sits in a cycle that does not lead back is admitted and the walk ends', () => {
    const w = world()
    for (const id of [HELD, THIRD])
      expect(admitWith(w, id, APART, [], NO_WAITS).status).toBe('admitted')
    const loop = waitsFrom({ [HELD]: [{ card: THIRD, why: `depends on #${THIRD}` }], [THIRD]: [{ card: HELD, why: `depends on #${HELD}` }] })
    expect(admitWith(w, BOUND, SHARED, [HELD], loop).status).toBe('admitted')
    w.db.close()
  })

  it('an amend that keeps a depends it already holds is not checked again for a cycle', () => {
    const w = world()
    expect(admitWith(w, HELD, APART, [], NO_WAITS).status).toBe('admitted')
    expect(admitWith(w, BOUND, SHARED, [HELD], NO_WAITS).status).toBe('admitted')
    const back = waitsFrom({ [HELD]: [{ card: BOUND, why: `overlap with open PR #${OPEN_PR} on ${SHARED}` }] })
    const amendedBody = body(BOUND, `${SHARED}, ${ELSEWHERE}`, [HELD])
    expect(admitWith(w, BOUND, SHARED, [HELD], back, amendedBody).status).toBe('admitted')
    expect(admitWith(w, FOURTH, ELSEWHERE, [HELD], back).status).toBe('admitted')
    expect(admitWith(w, BOUND, SHARED, [HELD, FOURTH], waitsFrom({ [FOURTH]: [{ card: BOUND, why: 'lane held' }] }), body(BOUND, `${SHARED}, ${ELSEWHERE}`, [HELD, FOURTH])).status).toBe('refused')
    w.db.close()
  })

  it('a card already satisfied waits on nothing, whatever its depends', () => {
    const w = world()
    admitted(w, HELD, APART)
    admitted(w, BOUND, SHARED, [HELD])
    expect(launchWaitsOf(w.db, w.repo)(BOUND)).toEqual([{ card: HELD, why: `depends on #${HELD}` }])
    appendEvent(w.db, { ts: NOW.toISOString(), type: CARD_VERIFIED, actor: 'policy', cardId: BOUND, pr: null, head: null, dedupeKey: `${CARD_VERIFIED}:${BOUND}:test`, payload: { report: 'probe.md', verification: 'run' }, legacy: false })
    expect(launchWaitsOf(w.db, w.repo)(BOUND)).toEqual([])
    w.db.close()
  })

  it('a card with an unmerged depends waits on that depends alone, because launch gives it no hold naming a card', () => {
    const w = world()
    admitted(w, BOUND, SHARED)
    withOpenPr(w, BOUND, OPEN_PR)
    admitted(w, HELD, SHARED, [BOUND])
    expect(launchWaitsOf(w.db, w.repo)(HELD)).toEqual([{ card: BOUND, why: `depends on #${BOUND}` }])
    w.db.close()
  })
})
