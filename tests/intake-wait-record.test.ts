import type { WaitKind } from '../scripts/core/events.js'
import type { AdmitOptions, AdmitResult, JournalledIntake } from '../src/commands/intake/admit.js'
import type { CardEvent } from '../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CARD_ADMITTED, CARD_WAITING, CARD_WAITS, WITNESS_DOWNGRADE } from '../scripts/core/events.js'
import { waitText } from '../scripts/window/board.js'
import { runAdmit } from '../src/commands/intake/admit.js'
import { WINDOW_SHARD_VARIABLE } from '../src/commands/intake/confirm.js'
import { ASKS_THE_WINDOW, HELD_FOR_CONFIRMATION, intakeWait, runIntake, waitRecordText } from '../src/commands/intake/index.js'

const NOW = new Date('2026-11-12T10:00:00.000Z')
const MINUTE_MS = 60_000
const roots: string[] = []

beforeEach(() => {
  vi.stubEnv(WINDOW_SHARD_VARIABLE, '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Bench { repo: string, parking: string, states: Map<string, string>, events: CardEvent[] }

function bench(): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-wait-record-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  const parking = path.join(root, 'parking')
  mkdirSync(parking, { recursive: true })
  return { repo, parking, states: new Map(), events: [] }
}

function cardText(id: number, depends: string, who: string, body = 'Do the thing.'): string {
  return `card: #${id} card-${id} [implement/black-ice/S/cheap/owner] · depends ${depends} · blocks —\nbranch: feat/card-${id}\ntouches: src/a.ts\ncontinue: stop\nwho: ${who}\n\n${body}\n`
}

function journalled(b: Bench, id: number): JournalledIntake | null {
  const at = b.events.map(event => event.type === CARD_ADMITTED && event.cardId === id).lastIndexOf(true)
  if (at === -1)
    return null
  const { payload, ts } = b.events[at]!
  return { card: String(payload.card), bodySha: payload.bodySha, ts, confirmation: payload.confirmation, source: payload.source, text: String(payload.text), event: at + 1 }
}

function admit(b: Bench, id: number, text: string, options: Partial<AdmitOptions> = {}): AdmitResult {
  return runAdmit({
    file: path.join(b.parking, `${id}.md`),
    body: text,
    dir: b.repo,
    dryRun: false,
    autoConfirm: true,
    parkingRoot: b.parking,
    events: event => b.events.push(event),
    cardStates: () => b.states,
    admissions: number => journalled(b, number),
    ...options,
  }, () => NOW)
}

function waits(b: Bench): CardEvent[] {
  return b.events.filter(event => event.type === CARD_WAITING)
}

function recordFaults(event: CardEvent): string[] {
  const kind = event.payload.code as WaitKind | undefined
  if (kind === undefined || !Object.hasOwn(CARD_WAITS, kind))
    return [`#${event.cardId} ${String(event.payload.reason ?? 'depends')}: no wait kind`]
  const term = CARD_WAITS[kind]
  const deadline = new Date(Date.parse(event.ts) + term.deadlineMinutes * MINUTE_MS).toISOString()
  const detail = String(event.payload.detail ?? '')
  const tail = `, the ${term.lifter} lifts it by ${deadline}`
  return detail.startsWith(`${kind} `) && detail.endsWith(tail) ? [] : [`#${event.cardId} ${kind}: '${detail}' names no lifter ${term.lifter} and deadline ${deadline}`]
}

function lifters(b: Bench): [unknown, unknown][] {
  return waits(b).map(event => [event.payload.reason ?? 'depends', CARD_WAITS[event.payload.code as WaitKind].lifter])
}

describe('every wait intake leaves is a wait record of the bus', () => {
  it('every wait intake leaves has a wait record with its kind, who lifts it and a deadline', () => {
    const b = bench()
    b.states.set('80', 'queued')
    b.states.set('81', 'merged')
    expect(admit(b, 82, cardText(82, '#80', 'shift'))).toMatchObject({ status: 'admitted' })
    expect(admit(b, 83, cardText(83, '#81', 'shift'), { autoConfirm: false })).toMatchObject({ status: 'awaiting' })
    expect(admit(b, 84, cardText(84, '—', 'window'))).toMatchObject({ status: 'admitted' })
    expect(admit(b, 85, cardText(85, '—', 'shift', 'Witnesses:\n- `pnpm exec vitest run src/a.ts` passes'))).toMatchObject({ status: 'admitted' })
    expect(admit(b, 85, cardText(85, '—', 'shift', 'Witnesses:\n- `pnpm exec vitest run src/b.ts` passes'))).toMatchObject({ status: 'ownerWait' })

    expect(lifters(b)).toEqual([['depends', 'bus'], [HELD_FOR_CONFIRMATION, 'owner'], [ASKS_THE_WINDOW, 'window'], [WITNESS_DOWNGRADE, 'owner']])
    expect(waits(b).flatMap(recordFaults)).toEqual([])
  })

  it('a card held under a window shard waits for the window, and a window card intake parks from a draft waits for the window', () => {
    vi.stubEnv(WINDOW_SHARD_VARIABLE, 'shard-1')
    const b = bench()
    b.states.set('81', 'merged')
    expect(admit(b, 83, cardText(83, '#81', 'shift'), { autoConfirm: false })).toMatchObject({ status: 'awaiting' })
    expect(lifters(b)).toEqual([[HELD_FOR_CONFIRMATION, 'window']])

    const draft = path.join(b.parking, '..', 'draft.json')
    writeFileSync(draft, JSON.stringify({ cards: [{ name: 'window-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', who: 'window', touches: ['src/a.ts'], task: 'Ask the window.', witnesses: ['`pnpm run quality` is green'] }] }))
    const drafted: CardEvent[] = []
    expect(runIntake({ draft, taken: '-', parking: b.parking, dir: b.repo, dryRun: false, autoConfirm: true, readStdin: () => '12', events: event => drafted.push(event) })).toMatchObject({ status: 'written' })
    const asked = drafted.filter(event => event.type === CARD_WAITING)
    expect(asked.map(event => event.payload.reason)).toEqual([ASKS_THE_WINDOW])
    expect(asked.flatMap(recordFaults)).toEqual([])
  })

  it('the record intake writes is the record the board reads: the same kind, lifter and deadline in the same words', () => {
    for (const kind of Object.keys(CARD_WAITS) as WaitKind[]) {
      const wait = intakeWait(kind, 'detail', NOW)
      expect(wait.lifter).toBe(CARD_WAITS[kind].lifter)
      expect(Date.parse(wait.deadline) - NOW.getTime()).toBe(CARD_WAITS[kind].deadlineMinutes * MINUTE_MS)
      expect(waitRecordText(wait)).toBe(waitText({ ...wait, card: 1, lane: 'lane-01', event: 1 }))
    }
  })
})
