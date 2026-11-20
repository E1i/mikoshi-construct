import type { DatabaseSync } from 'node:sqlite'
import type { Witness } from '../scripts/ports/witnesses.js'
import type { RequestTools } from '../scripts/window/window-requests.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, BUS_DB_VARIABLE } from '../scripts/core/db.js'
import { REQUEST_DONE, REQUEST_REFUSED, WITNESS_RECORDED } from '../scripts/core/events.js'
import { reduce } from '../scripts/core/reducer.js'
import { busIntakePorts } from '../scripts/intake/intake.js'
import { runOnTree } from '../scripts/ports/witnesses.js'
import { busProjections, openComposedBus } from '../scripts/supervisor/composition.js'
import { requestFromWindow, WindowRequests } from '../scripts/window/window-requests.js'
import { witnessFieldsOf, witnessText } from '../src/card/witness-fields.js'
import { deadOnTheBase, runAdmit } from '../src/commands/intake/admit.js'
import { runAmend } from '../src/commands/intake/amend.js'

const NOW = new Date('2026-11-20T03:08:00.000Z')
const CARD = 2107
const TOUCH = 'src/board/run.ts'
const BASE = 'abc1234'
const HEAD = 'f00d'.repeat(10)
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const W1 = { id: 'W1', run: `pnpm exec vitest run ${TOUCH}`, test: null, head: 'pass', base: 'fail', proves: 'the change works' }
const W2 = { id: 'W2', run: `test -f ${TOUCH}`, test: null, head: 'pass', base: 'pass', proves: 'the file stays' }
const W3 = { id: 'W3', run: `test -s ${TOUCH}`, test: null, head: 'pass', base: 'pass', proves: 'a weaker stand-in' }

function body(witnesses: readonly Record<string, unknown>[]): string {
  return `card: #${CARD} dead-witness-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCH}\ncontinue: stop\nwho: shift\n\nDo the thing.\n\nwitnesses: ${JSON.stringify(witnesses)}\n`
}

const ADMITTED = body([W1, W2])
const W1_TEXT = witnessText(witnessFieldsOf(ADMITTED)![0]!)

interface World { db: DatabaseSync, repo: string, root: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-dead-witness-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, TOUCH), '')
  mkdirSync(path.join(root, '.construct', 'parking'), { recursive: true })
  const bus = path.join(root, 'bus.db')
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  vi.stubEnv('HOME', root)
  return { db: openComposedBus(bus), repo, root }
}

function intakeOf(w: World) {
  const ports = busIntakePorts(w.db, 'by-hand')
  return { dir: w.repo, dryRun: false, autoConfirm: true, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions, decisions: ports.decisions }
}

function admitted(w: World): void {
  expect(runAdmit({ ...intakeOf(w), file: path.join(w.root, `${CARD}.md`), body: ADMITTED }, () => NOW).status).toBe('admitted')
  reduce(w.db, 'pending', busProjections())
}

function witnessRecorded(w: World, verdict: string, detail: string): void {
  appendEvent(w.db, { ts: NOW.toISOString(), type: WITNESS_RECORDED, actor: 'worker:witness:test', cardId: CARD, pr: null, head: HEAD, dedupeKey: `${WITNESS_RECORDED}:${CARD}:${verdict}:${detail.length}`, payload: { head: HEAD, base: BASE, cardBody: 'body', verdict, detail }, legacy: false })
  reduce(w.db, 'pending', busProjections())
}

type Outcome = 'amended' | 'ownerWait'

function outcomeOfStatus(status: string): Outcome {
  expect(['admitted', 'ownerWait']).toContain(status)
  return status === 'admitted' ? 'amended' : 'ownerWait'
}

function requested(w: World, request: Record<string, unknown>): Outcome {
  const id = requestFromWindow(w.db, NOW.toISOString(), 'test', { kind: 'amend', card: CARD, ...request })
  new WindowRequests(w.db, () => new Date(NOW.getTime() + id * 1000), { closeDropped: () => [] } as unknown as RequestTools, path.join(w.root, 'channel'), () => null, w.repo, {} as never).run()
  reduce(w.db, 'pending', busProjections())
  const answer = w.db.prepare(`SELECT type, json_extract(payload, '$.detail') AS detail FROM events WHERE type IN (?, ?) AND json_extract(payload, '$.request') = ?`).get(REQUEST_DONE, REQUEST_REFUSED, id) as { type: string, detail: string }
  if (answer.type === REQUEST_DONE)
    return 'amended'
  expect(answer.detail).toContain('W1')
  return 'ownerWait'
}

const DOORS: Record<string, (w: World) => Outcome> = {
  'intake --admit': w => outcomeOfStatus(runAdmit({ ...intakeOf(w), file: path.join(w.root, `${CARD}.md`), body: body([W3, W2]) }, () => NOW).status),
  'intake --amend': w => outcomeOfStatus(runAmend({ ...intakeOf(w), card: `#${CARD}`, flags: { witness: `W1=${JSON.stringify({ ...W3, id: 'W1' })}` } }, () => NOW).status),
  'bus:request amend': w => requested(w, { remove_witness: ['W1'], add_witness: [JSON.stringify(W3)] }),
}

const DEATHS: Record<string, { verdict: string, detail: string }> = {
  'unfit on the base': { verdict: 'unfit', detail: `witness "${W1_TEXT}" ran no test on the base ${BASE}: a witness that finds zero tests cannot fail; no replacement` },
  'green on the base it declared red': { verdict: 'red', detail: `P7: witness "${W1_TEXT}" exits 0 on the clean base ${BASE}: it is green before any change, so no implementation can make it red` },
}

const LIVES: Record<string, { verdict: string, detail: string } | null> = {
  'no record': null,
  'red on the head only': { verdict: 'red', detail: `P8: positive control "${W1_TEXT}" exits 1 on the sketch f00d staged on the base ${BASE}: 1 failed` },
  'green after a dead record': { verdict: 'green', detail: `every card witness red on the base ${BASE} and green on f00d` },
}

describe('replacing a witness the bus recorded dead is an amendment, not a downgrade for the owner', () => {
  it('replacing a witness the bus recorded dead is an amendment with no owner wait at every amend door', () => {
    for (const [door, through] of Object.entries(DOORS)) {
      for (const [death, record] of Object.entries(DEATHS)) {
        const w = world()
        admitted(w)
        witnessRecorded(w, record.verdict, record.detail)
        expect({ door, death, outcome: through(w) }).toEqual({ door, death, outcome: 'amended' })
        expect(w.db.prepare('SELECT count(*) AS n FROM owner_waits').get()).toEqual({ n: 0 })
        w.db.close()
      }
    }
  })

  it('weakening a live witness still waits for the owner', () => {
    for (const [door, through] of Object.entries(DOORS)) {
      for (const [life, record] of Object.entries(LIVES)) {
        const w = world()
        admitted(w)
        if (life === 'green after a dead record')
          witnessRecorded(w, DEATHS['unfit on the base']!.verdict, DEATHS['unfit on the base']!.detail)
        if (record !== null)
          witnessRecorded(w, record.verdict, record.detail)
        expect({ door, life, outcome: through(w) }).toEqual({ door, life, outcome: 'ownerWait' })
        w.db.close()
      }
    }
  })

  it('a red on the base it declared red keeps the witness alive', () => {
    expect(deadOnTheBase(W1_TEXT, [{ verdict: 'red', detail: `P7: install failed on the base ${BASE}` }])).toBe(false)
    expect(deadOnTheBase(W1_TEXT, [{ verdict: 'unfit', detail: `witness "${witnessText(witnessFieldsOf(ADMITTED)![1]!)}" ran no test on the base ${BASE}` }])).toBe(false)
    expect(deadOnTheBase(W1_TEXT, [{ verdict: 'red', detail: `P7: invariant "${W1_TEXT}" exits 1 on the clean base ${BASE}: 1 failed` }])).toBe(false)
  })

  it('reads death from the refusals the witness run itself words, against the declared base', () => {
    const W4 = { id: 'W4', run: 'true', test: null, head: 'fail', base: 'pass', proves: 'a stated base' }
    const texts = witnessFieldsOf(body([W1, W2, W4]))!.map(witnessText)
    const [w1, w2, w4] = texts as [string, string, string]
    const CASES: Record<string, { witness: string, status: number, acceptance: Witness[], invariants: Witness[], dead: boolean }> = {
      'green on the base it declared red': { witness: w1, status: 0, acceptance: [{ criterion: w1, command: 'true' }], invariants: [], dead: true },
      'red invariant on the base it declared green': { witness: w2, status: 1, acceptance: [], invariants: [{ criterion: w2, command: 'true' }], dead: true },
      'red on the base its field states green': { witness: w4, status: 1, acceptance: [{ criterion: w4, command: 'true', onBase: { command: 'true', stated: 'pass' } }], invariants: [], dead: true },
      'red on the base it declared red': { witness: w1, status: 1, acceptance: [{ criterion: w1, command: 'true' }], invariants: [], dead: false },
    }
    const verdicts = Object.fromEntries(Object.entries(CASES).map(([name, { witness, status, acceptance, invariants }]) => {
      const tree = mkdtempSync(path.join(tmpdir(), 'intake-dead-witness-tree-'))
      roots.push(tree)
      const refusals: string[] = []
      try {
        runOnTree({ tree, base: BASE, log() {}, refuse: (step, problem) => {
          if (problem !== null)
            throw new Error(`${step}: ${problem}`)
        }, shell: () => ({ status, output: '' }), time: (_name, run) => run() }, { acceptance, invariants, harnessCommand: null, sketchSha: null, changed: null, witnessesDir: tree, creates: [] })
      }
      catch (error) {
        refusals.push((error as Error).message)
      }
      return [name, deadOnTheBase(witness, refusals.map(detail => ({ verdict: 'red', detail })))]
    }))
    expect(verdicts).toEqual(Object.fromEntries(Object.entries(CASES).map(([name, { dead }]) => [name, dead])))
  })
})
