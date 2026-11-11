import type { DecisionsPort } from '../scripts/policy/decisions/decisions.js'
import type { AdmitResult } from '../src/commands/intake/admit.js'
import type { AmendFlags } from '../src/commands/intake/amend.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../scripts/core/db.js'
import { reduce } from '../scripts/core/reducer.js'
import { busCardAdmissions, busCardEvents } from '../scripts/intake/intake.js'
import { decisionsOfProjection } from '../scripts/policy/decisions/decisions.js'
import { CREATED_PATHS_ARE_THE_CHANGE, runAdmit, unfitOnTheBase } from '../src/commands/intake/admit.js'

import { runAmend } from '../src/commands/intake/amend.js'

const NOW = new Date('2026-11-10T09:00:00.000Z')

function heldIn(file: string): DecisionsPort {
  return { inForce: () => decisionsOfProjection(existsSync(file) ? readFileSync(file, 'utf8') : '', NOW).inForce() }
}
const CARD = '#91 unfit-card [implement/runner/S/cheap/owner] · depends — · blocks —'
const ADDED_TEST = 'tests/newdir/a.test.ts'
const CREATED_FILE = 'src/board/new.ts'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { parking: string, repo: string, bus: string, decisions: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-unfit-witness-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  const parking = path.join(root, 'parking')
  mkdirSync(parking, { recursive: true })
  return { parking, repo, bus: path.join(root, 'bus.db'), decisions: path.join(root, 'owner-decisions.md') }
}

function field(run: string, base: 'pass' | 'fail'): Record<string, unknown> {
  return { id: 'W1', run, test: null, head: 'pass', base, proves: 'the card works' }
}

const DIRECTORY = field('pnpm exec vitest run tests/newdir', 'pass')
const RED_ON_MAIN = field(`pnpm exec vitest run ${ADDED_TEST}`, 'fail')
const GREEN_ON_MAIN = field(`pnpm exec vitest run ${ADDED_TEST}`, 'pass')
const OVER_CREATED = field(`test -f ${CREATED_FILE}`, 'fail')

function cardText(witness: Record<string, unknown>): string {
  return `card: ${CARD}\nbranch: feat/card-91\ntouches: src/board/run.ts, ${ADDED_TEST}\ncreates: ${CREATED_FILE}\ncontinue: stop\nwho: shift\n\nDo the thing.\n\nwitnesses: ${JSON.stringify([witness])}\n`
}

function withBus<T>(w: World, run: (ports: { events: ReturnType<typeof busCardEvents>, admissions: ReturnType<typeof busCardAdmissions> }) => T): T {
  const db = openBus(w.bus)
  try {
    const result = run({ events: busCardEvents(db), admissions: busCardAdmissions(db) })
    reduce(db)
    return result
  }
  finally {
    db.close()
  }
}

function admit(w: World, witness: Record<string, unknown>): AdmitResult {
  const file = path.join(w.parking, '91.md')
  writeFileSync(file, cardText(witness))
  const result = withBus(w, ({ events, admissions }) => runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, decisions: heldIn(w.decisions), events, admissions, cardStates: () => new Map() }, () => NOW))
  rmSync(file)
  return result
}

function amend(w: World, flags: AmendFlags): AdmitResult {
  return withBus(w, ({ events, admissions }) => runAmend({ card: '#91', flags, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, decisions: heldIn(w.decisions), events, admissions, cardStates: () => new Map() }, () => NOW))
}

function ownerWaits(w: World): number {
  const db = openBus(w.bus)
  try {
    return Number((db.prepare('SELECT count(*) AS n FROM owner_waits').get() as { n: number }).n)
  }
  finally {
    db.close()
  }
}

function replacing(witness: Record<string, unknown>): AmendFlags {
  return { witness: `W1=${JSON.stringify(witness)}` }
}

const WRITTEN_BY_DECISIONS_ADD = ' · decisions:add'

function standingDecision(w: World, marker = WRITTEN_BY_DECISIONS_ADD): void {
  writeFileSync(w.decisions, `# Owner decisions\n\n- D-41 · 2026-11-01 — [owner] ${CREATED_PATHS_ARE_THE_CHANGE[0]!.toUpperCase()}${CREATED_PATHS_ARE_THE_CHANGE.slice(1)}${marker}\n`)
}

describe('intake counts replacing an unfit witness with a red-on-main one as a refinement', () => {
  it('amending an unfit witness to a red-on-main one is admitted without an owner wait', () => {
    const w = world()
    expect(admit(w, DIRECTORY)).toMatchObject({ status: 'admitted' })
    expect(amend(w, replacing(RED_ON_MAIN))).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(ownerWaits(w)).toBe(0)
  })

  it('amending an unfit witness to one that is not red on main still waits for the owner', () => {
    const w = world()
    admit(w, DIRECTORY)
    expect(amend(w, replacing(GREEN_ON_MAIN))).toMatchObject({ status: 'ownerWait' })
  })

  it('a card whose witness checks a path it creates is admitted without an owner wait under a standing general decision in force', () => {
    const held = world()
    admit(held, OVER_CREATED)
    expect(amend(held, replacing(RED_ON_MAIN))).toMatchObject({ status: 'ownerWait' })
    const w = world()
    standingDecision(w)
    expect(admit(w, OVER_CREATED)).toMatchObject({ status: 'admitted' })
    expect(amend(w, replacing(RED_ON_MAIN))).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(ownerWaits(w)).toBe(0)
  })

  it('a red-on-main witness added beside an unfit one does not excuse that unfit one\'s downgrade', () => {
    const w = world()
    admit(w, DIRECTORY)
    expect(amend(w, { ...replacing(GREEN_ON_MAIN), addWitnesses: [JSON.stringify({ ...RED_ON_MAIN, id: 'W2' })] })).toMatchObject({ status: 'ownerWait' })
  })

  it('under the standing decision, a red-on-main witness added beside a created-path one does not excuse its downgrade', () => {
    const w = world()
    standingDecision(w)
    admit(w, OVER_CREATED)
    expect(amend(w, { ...replacing(GREEN_ON_MAIN), addWitnesses: [JSON.stringify({ ...RED_ON_MAIN, id: 'W2' })] })).toMatchObject({ status: 'ownerWait' })
  })

  it('a decision bound to another card is not a standing general decision', () => {
    const w = world()
    writeFileSync(w.decisions, `# Owner decisions\n\n- D-41 · 2026-11-01 — [owner] ${CREATED_PATHS_ARE_THE_CHANGE} · card #7${WRITTEN_BY_DECISIONS_ADD}\n`)
    admit(w, OVER_CREATED)
    expect(amend(w, replacing(RED_ON_MAIN))).toMatchObject({ status: 'ownerWait' })
  })

  it('a standing general decision written into the file by hand, not through decisions:add, waives nothing', () => {
    const w = world()
    standingDecision(w, '')
    admit(w, OVER_CREATED)
    expect(amend(w, replacing(RED_ON_MAIN))).toMatchObject({ status: 'ownerWait' })
  })

  it('under the standing decision, a witness naming a created path and a path on the base is not refined', () => {
    const w = world()
    standingDecision(w)
    admit(w, field(`test -f ${CREATED_FILE} && test -f src/board/run.ts`, 'fail'))
    expect(amend(w, replacing(RED_ON_MAIN))).toMatchObject({ status: 'ownerWait' })
  })

  it('a witness is unfit on the base when it runs a directory that is not there, or names a file outside the card', () => {
    const scope = { dir: world().repo, card: { touches: [ADDED_TEST], creates: [CREATED_FILE] }, createdAreTheChange: false }
    expect(unfitOnTheBase('pnpm exec vitest run tests/newdir', scope)).toBe(true)
    expect(unfitOnTheBase('pnpm exec vitest run tests/other/b.test.ts', scope)).toBe(true)
    expect(unfitOnTheBase(`pnpm exec vitest run ${ADDED_TEST}`, scope)).toBe(false)
    expect(unfitOnTheBase('pnpm exec vitest run src/board/run.ts', scope)).toBe(false)
  })

  it('a witness naming an absent directory that holds a path of the card is within the card', () => {
    const scope = { dir: world().repo, card: { touches: [ADDED_TEST], creates: [] }, createdAreTheChange: false }
    expect(unfitOnTheBase('test -d tests/newdir', scope)).toBe(false)
  })
})
