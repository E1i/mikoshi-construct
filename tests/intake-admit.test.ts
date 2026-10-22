import type { TaskStartDeps } from '../scripts/ghosts/task-start.js'
import type { AdmitOptions, AdmitResult } from '../src/commands/intake/admit.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cardBodyText, WINDOW_LANE } from '../scripts/bus/card-bodies.js'
import { BUS_DB_VARIABLE, openBus } from '../scripts/bus/db.js'
import { recordDecision } from '../scripts/bus/decisions.js'
import { busCardAdmissions, busCardEvents } from '../scripts/bus/intake.js'
import { reduce } from '../scripts/bus/reducer.js'
import { runTaskStart } from '../scripts/ghosts/task-start.js'
import { downgradeAction, printAdmit, runAdmit, witnessDowngrades } from '../src/commands/intake/admit.js'
import { bodySha, bodyShaWithoutTouches } from '../src/commands/intake/confirm.js'
import { INTAKE_EXIT, runIntake } from '../src/commands/intake/index.js'
import { isWithin, parkingTree } from '../src/commands/intake/parking-tree.js'
import { createMain } from '../src/program.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-10-05T09:00:00.000Z')
const A_MINUTE_LATER = new Date(NOW.getTime() + 60_000)
const AN_HOUR_LATER = new Date(NOW.getTime() + 3_600_000)
const AFTER_THE_CUTOFF = new Date('2026-10-13T09:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, parking: string, journal: string, repo: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-admit-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  return { root, parking: path.join(root, 'parking'), journal: path.join(root, 'handoff', 'ghosts.jsonl'), repo }
}

function park(w: World, id: number, card: string, touches = 'src/board/**', body = 'Do the thing.'): string {
  mkdirSync(w.parking, { recursive: true })
  const file = path.join(w.parking, `${id}.md`)
  writeFileSync(file, `card: ${card}\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\n${body}\n`)
  return file
}

function journal(w: World, lines: Record<string, unknown>[]): void {
  mkdirSync(path.dirname(w.journal), { recursive: true })
  writeFileSync(w.journal, lines.map(line => `${JSON.stringify(line)}\n`).join(''))
}

function journalLines(w: World): Record<string, unknown>[] {
  return existsSync(w.journal) ? readFileSync(w.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

function busOf(w: World): string {
  return path.join(path.dirname(w.journal), 'bus.db')
}

function admit(w: World, file: string, options: Partial<AdmitOptions> = {}, at: Date = NOW): AdmitResult {
  const db = openBus(busOf(w))
  try {
    return runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: busCardEvents(db), ...options }, () => at)
  }
  finally {
    db.close()
  }
}

function admitThroughBus(w: World, file: string, options: Partial<AdmitOptions> = {}): AdmitResult {
  const db = openBus(busOf(w))
  try {
    const result = runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: busCardEvents(db), admissions: busCardAdmissions(db), ...options }, () => AFTER_THE_CUTOFF)
    reduce(db)
    return result
  }
  finally {
    db.close()
  }
}

function admittedRows(w: World): { ts: string, payload: string }[] {
  const db = openBus(busOf(w))
  try {
    return db.prepare(`SELECT ts, payload FROM events WHERE type = 'card.admitted' ORDER BY id`).all() as unknown as { ts: string, payload: string }[]
  }
  finally {
    db.close()
  }
}

function admittedPayloads(w: World): Record<string, unknown>[] {
  return admittedRows(w).map(row => JSON.parse(row.payload) as Record<string, unknown>)
}

function payloadsOf(w: World, type: string): Record<string, unknown>[] {
  const db = openBus(busOf(w))
  try {
    return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type) as unknown as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
  }
  finally {
    db.close()
  }
}

function admittedTimes(w: World): string[] {
  return admittedRows(w).map(row => row.ts)
}

function admittedEvents(w: World): number {
  const db = openBus(busOf(w))
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'card.admitted'`).get() as { n: number }).n)
  }
  finally {
    db.close()
  }
}

function printed(result: AdmitResult): { lines: string[], exit: number } {
  const lines: string[] = []
  const exit = printAdmit(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { lines, exit }
}

function taskStart(w: World, card: string): number {
  const deps: TaskStartDeps = {
    cwd: '/repo',
    git: (_cwd, args) => {
      if (args[0] === 'show-ref')
        throw new Error('no such branch')
      return args[0] === 'rev-parse' ? '/work/repo\n' : ''
    },
    install: () => undefined,
    exists: () => false,
    bus: busOf(w),
    now: () => NOW,
    session: 's1',
  }
  return runTaskStart(['feat/admitted', '--card', card], deps).exitCode
}

const CLEAN = '#80 clean-card [implement/runner/S/cheap/owner] · depends — · blocks —'
const STALE = '#81 stale-card [implement/runner/S/cheap/owner] · depends #70 · blocks #90 the board card'
const STALE_ADMITTED = '#81 stale-card [implement/runner/S/cheap/owner] · depends — · blocks #90 the board card'
const WAITING = '#82 waiting-card [implement/runner/S/cheap/owner] · depends #80 · blocks —'
const STALE_WAITING = '#83 stale-waiting-card [implement/runner/S/cheap/owner] · depends #70 #80 · blocks #90 the board card'
const STALE_WAITING_ADMITTED = '#83 stale-waiting-card [implement/runner/S/cheap/owner] · depends — · blocks #90 the board card'

function stalePark(w: World): string {
  park(w, 80, CLEAN)
  park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
  return park(w, 81, STALE)
}

function mergedSeventy(w: World): void {
  journal(w, [{ event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' }, { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
}

function latestText(w: World, file: string): string {
  const id = Number(path.basename(file, '.md'))
  const db = openBus(busOf(w))
  try {
    const row = db.prepare(`SELECT json_extract(payload, '$.text') AS text FROM events WHERE type = 'card.admitted' AND card_id = ? AND json_type(payload, '$.text') = 'text' ORDER BY id DESC LIMIT 1`).get(id) as { text: string } | undefined
    return row?.text ?? readFileSync(file, 'utf8')
  }
  finally {
    db.close()
  }
}

function admittedCardText(result: AdmitResult): string {
  if (!('card' in result))
    throw new Error(`no card in a ${result.status} result`)
  return result.card.text
}

describe('construct intake --admit takes a card parked before the intake door', () => {
  it('writes an intake line for a card with nothing to correct, leaves the file as it was, and task:start takes the card', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    const before = readFileSync(file, 'utf8')
    expect(taskStart(w, CLEAN)).toBe(1)
    const result = admit(w, file)
    expect(result.status).toBe('admitted')
    expect(printed(result).exit).toBe(INTAKE_EXIT.admitted)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toEqual([{ event: 'intake', task: '80', card: CLEAN, confirmation: 'none', corrections: [], bodySha: bodySha(before), source: 'admit', ts: NOW.toISOString() }])
    expect(taskStart(w, CLEAN)).toBe(0)
  })

  it('refuses a card whose milestone the repository\'s construct.json does not list, names the list and writes nothing, and admits one it lists', () => {
    const w = world()
    writeFileSync(path.join(w.repo, 'construct.json'), JSON.stringify({ manifestVersion: 6, milestones: ['ghosts', 'ice'] }))
    const outside = '#81 port-card [implement/moon/S/cheap/auto] · depends — · blocks —'
    expect(admit(w, park(w, 81, outside))).toEqual({ status: 'refused', why: `milestone 'moon' is not one of ghosts, ice` })
    expect(journalLines(w)).toEqual([])
    expect(admit(w, park(w, 82, '#82 port-card [implement/ice/S/cheap/auto] · depends — · blocks —')).status).toBe('admitted')
  })

  it('a card with no file in the parking is admitted from its bus body', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    const text = readFileSync(file, 'utf8')
    expect(admitThroughBus(w, file).status).toBe('admitted')
    rmSync(file)

    expect(admitThroughBus(w, file)).toMatchObject({ status: 'alreadyAdmitted', card: { line: CLEAN, text } })
    expect(existsSync(file)).toBe(false)
    expect(admittedPayloads(w).map(payload => payload.text)).toEqual([text])
  })

  it('a parking file that is there wins over the bus body', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    expect(admitThroughBus(w, file).status).toBe('admitted')
    const edited = readFileSync(file, 'utf8').replace('Do the thing.', 'Do the edited thing.')
    writeFileSync(file, edited)

    expect(admitThroughBus(w, file, { autoConfirm: true })).toMatchObject({ status: 'admitted', source: 'amend', card: { text: edited } })
    expect(admittedPayloads(w).at(-1)?.text).toBe(edited)
  })

  it('a corrected admission of a card whose parking file is there leaves the file as it was, the bus carrying the corrected text', () => {
    const w = world()
    const file = stalePark(w)
    const written = readFileSync(file, 'utf8')
    expect(admitThroughBus(w, file, { autoConfirm: true }).status).toBe('admitted')
    mergedSeventy(w)

    const amended = admitThroughBus(w, file, { autoConfirm: true })
    expect(amended).toMatchObject({ status: 'admitted', source: 'amend', card: { line: STALE_ADMITTED } })
    expect(readFileSync(file, 'utf8')).toBe(written)
    expect(admittedPayloads(w).at(-1)?.text).toBe(admittedCardText(amended))
  })

  it('a corrected admission from the bus body writes no parking file and is carried by its card.admitted event and card_bodies alone', () => {
    const w = world()
    const file = stalePark(w)
    expect(admitThroughBus(w, file, { autoConfirm: true }).status).toBe('admitted')
    mergedSeventy(w)
    rmSync(file)

    const amended = admitThroughBus(w, file, { autoConfirm: true })
    expect(amended).toMatchObject({ status: 'admitted', source: 'amend', card: { line: STALE_ADMITTED } })
    const corrected = admittedCardText(amended)
    expect(existsSync(file)).toBe(false)
    expect(admittedPayloads(w).at(-1)?.text).toBe(corrected)
    const db = openBus(busOf(w))
    try {
      expect(cardBodyText(db, 81)).toBe(corrected)
    }
    finally {
      db.close()
    }
  })

  it('an admission that only drops merged depends is held behind a token', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 81, STALE)
    journal(w, [{ event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' }, { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    expect(admit(w, file).status).toBe('awaiting')
  })

  it('an amend with a correction and no --confirm is held with a token and exit 2', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 81, STALE)
    const before = readFileSync(file, 'utf8')
    journal(w, [
      { event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' },
      { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' },
      { event: 'intake', task: '81', card: STALE, confirmation: 'none', corrections: [], source: 'admit', ts: NOW.toISOString() },
    ])
    const held = admit(w, file)
    expect(held).toMatchObject({ status: 'awaiting', stale: false })
    expect(held.status === 'awaiting' ? held.token : '').not.toBe('')
    expect(printed(held).exit).toBe(INTAKE_EXIT.awaiting)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toHaveLength(3)
  })

  it('no confirmation is recorded without --confirm', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 81, STALE)
    journal(w, [{ event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' }, { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    const held = admit(w, file)
    expect(printed(held).lines.join('\n')).not.toContain('confirmed by a person')
    expect(journalLines(w).filter(line => line.event === 'intake')).toHaveLength(0)
    const token = held.status === 'awaiting' ? held.token : ''
    expect(admit(w, file, { confirm: token }).status).toBe('admitted')
    expect(journalLines(w).at(-1)).toMatchObject({ event: 'intake', task: '81', confirmation: 'person' })
  })

  it('any other correction still needs a person', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 81, STALE, 'scripts/board/run.ts')
    journal(w, [{ event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' }, { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    expect(admit(w, file).status).toBe('awaiting')
  })

  it('holds a card with a correction behind the confirmation token, and admits it once a person confirms', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 81, STALE, 'scripts/board/run.ts')
    const before = readFileSync(file, 'utf8')
    journal(w, [{ event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' }, { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])

    const held = admit(w, file)
    expect(held.status).toBe('awaiting')
    const { lines, exit } = printed(held)
    expect(exit).toBe(INTAKE_EXIT.awaiting)
    expect(lines.join('\n')).toContain('corrected: depends — #70 → (removed) — already merged')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toHaveLength(2)

    const token = held.status === 'awaiting' ? held.token : ''
    expect(admit(w, file, { confirm: token }).status).toBe('admitted')
    const after = latestText(w, file)
    expect(after).toBe(before.replace(STALE, STALE_ADMITTED).replace('touches: scripts/', 'touches: src/').replace('Do the thing.\n', `Do the thing.\n\ncorrected: touches — scripts/board/run.ts → src/board/run.ts — 'scripts/board/run.ts' does not exist; 'src/board/run.ts' is the only path named 'run.ts'\ncorrected: depends — #70 → (removed) — already merged\n`))
    expect(journalLines(w).at(-1)).toMatchObject({ event: 'intake', task: '81', card: STALE_ADMITTED, confirmation: 'person', source: 'admit' })
    expect(taskStart(w, STALE_ADMITTED)).toBe(0)
    expect(taskStart(w, STALE)).toBe(1)
  })

  it('a card whose depends are not merged is not admitted and stays in the queue as blocked with a waiting on #N event', () => {
    const w = world()
    park(w, 80, CLEAN)
    const file = park(w, 82, WAITING)
    const before = readFileSync(file, 'utf8')

    const waiting = admit(w, file)
    expect(waiting).toMatchObject({ status: 'waiting', waitingOn: [80], inBus: true })
    const { lines, exit } = printed(waiting)
    expect(exit).toBe(INTAKE_EXIT.waiting)
    expect(lines.join('')).toContain(`Not admitted yet ${file}: ${WAITING}. It depends on #80, not merged yet`)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toEqual([])
    expect(admittedEvents(w)).toBe(0)
    expect(payloadsOf(w, 'card.waiting')).toEqual([{ depends: [80] }])
    expect(taskStart(w, WAITING)).toBe(1)

    journal(w, [{ event: 'merge', task: '80', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    const held = admit(w, file)
    expect(held.status).toBe('awaiting')
    const token = held.status === 'awaiting' ? held.token : ''
    expect(admit(w, file, { confirm: token }).status).toBe('admitted')
    expect(admittedEvents(w)).toBe(1)
  })

  it('a card waiting on an unmerged depends writes no card.waiting when no bus is wired, and an amend of an admitted card does not wait', () => {
    const w = world()
    park(w, 80, CLEAN)
    const file = park(w, 82, WAITING)
    const waiting = admit(w, file, { events: undefined })
    expect(waiting).toMatchObject({ status: 'waiting', inBus: false })
    expect(printed(waiting).lines.join('')).toContain('no bus is wired to this run, so nothing was written')
    expect(payloadsOf(w, 'card.waiting')).toEqual([])

    journal(w, [{ event: 'intake', task: '82', card: WAITING, bodySha: 'an earlier body', source: 'admit', ts: NOW.toISOString() }])
    expect(admit(w, file, { events: undefined }).status).toBe('admitted')
  })

  it('a corrected card that keeps an unmerged depends waits before it asks for a confirmation, and is held behind the token once the depends merges', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 83, STALE_WAITING, 'scripts/board/run.ts')
    const before = readFileSync(file, 'utf8')
    const merge70 = { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }
    journal(w, [merge70])

    expect(admit(w, file)).toMatchObject({ status: 'waiting', waitingOn: [80] })
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toHaveLength(1)

    journal(w, [merge70, { event: 'merge', task: '80', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    const held = admit(w, file)
    expect(held.status).toBe('awaiting')
    const token = held.status === 'awaiting' ? held.token : ''
    expect(admit(w, file, { confirm: token })).toMatchObject({ status: 'admitted', card: { line: STALE_WAITING_ADMITTED } })
  })

  it('a depends on a card that is neither parked, done nor merged is admitted with an unclear mark, not left waiting', () => {
    const w = world()
    const file = park(w, 82, WAITING.replace('depends #80', 'depends #79'))
    expect(admit(w, file)).toMatchObject({ status: 'admitted', card: { unclear: [{ field: 'depends' }] } })
    expect(latestText(w, file)).toContain('unclear: depends')
    expect(payloadsOf(w, 'card.waiting')).toEqual([])
  })

  it('a dry run of a first admission with an unmerged depends reports the wait and writes nothing', () => {
    const w = world()
    park(w, 80, CLEAN)
    const file = park(w, 82, WAITING)
    const before = readFileSync(file, 'utf8')
    const dry = admit(w, file, { dryRun: true })
    expect(dry).toMatchObject({ status: 'waiting', waitingOn: [80], dryRun: true })
    const { lines, exit } = printed(dry)
    expect(exit).toBe(INTAKE_EXIT.waiting)
    expect(lines.join('')).toContain('so --admit would leave it parked and write a card.waiting. Nothing was written.')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(payloadsOf(w, 'card.waiting')).toEqual([])
  })

  it('a depends whose card opened its pull request but has no merge line waits', () => {
    const w = world()
    const file = park(w, 82, WAITING.replace('depends #80', 'depends #77'))
    journal(w, [{ event: 'path', task: '77', path: 'cheap', pr: 7, verification: 'run' }])
    expect(admit(w, file)).toMatchObject({ status: 'waiting', waitingOn: [77] })
    expect(payloadsOf(w, 'card.waiting')).toEqual([{ depends: [77] }])
  })

  it('a depends known only to the bus waits while the bus runs it, and not once the bus ended it', () => {
    const admitWithBusState = (state: string): AdmitResult => {
      const w = world()
      return admit(w, park(w, 82, WAITING.replace('depends #80', 'depends #77')), { cardStates: () => new Map([['77', state]]) })
    }
    expect(admitWithBusState('running')).toMatchObject({ status: 'waiting', waitingOn: [77] })
    for (const ended of ['merged', 'closed'])
      expect(admitWithBusState(ended), ended).toMatchObject({ status: 'awaiting', card: { unclear: [] } })
  })

  it('a waiting card with no bus wired prints the no-bus wait and exits 3', () => {
    const w = world()
    park(w, 80, CLEAN)
    const file = park(w, 82, WAITING)
    const { lines, exit } = printed(admit(w, file, { events: undefined }))
    expect(exit).toBe(INTAKE_EXIT.waiting)
    expect(lines.join('')).toContain(`Not admitted yet ${file}: ${WAITING}. It depends on #80, not merged yet, so it stays parked; no bus is wired to this run`)
  })

  it('a dry run of a corrected card with an unmerged depends exits 3 and prints no token', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 83, STALE_WAITING, 'scripts/board/run.ts')
    journal(w, [{ event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    const dry = admit(w, file, { dryRun: true })
    expect(dry).toMatchObject({ status: 'waiting', waitingOn: [80], dryRun: true })
    const { lines, exit } = printed(dry)
    expect(exit).toBe(INTAKE_EXIT.waiting)
    expect(lines.join('')).not.toContain('--confirm')
  })

  it('a stale --confirm admits nothing', () => {
    const w = world()
    const file = park(w, 81, STALE, 'scripts/board/run.ts')
    journal(w, [{ event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' }, { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    const held = admit(w, file, { confirm: 'not-the-token' })
    expect(held).toMatchObject({ status: 'awaiting', stale: true })
    expect(journalLines(w)).toHaveLength(2)
  })

  it('a second --admit of an admitted card writes no second intake line', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file)
    const again = admit(w, file)
    expect(again.status).toBe('alreadyAdmitted')
    expect(printed(again).exit).toBe(INTAKE_EXIT.alreadyAdmitted)
    expect(journalLines(w)).toHaveLength(1)
  })

  it('an unchanged admitted card writes no file and no intake line', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', 'Do the thing.\n\nWitnesses:\n- `pnpm vitest run` exit 0')
    expect(admit(w, file).status).toBe('admitted')
    const before = readFileSync(file, 'utf8')
    const again = admit(w, file)
    expect(again).toMatchObject({ status: 'alreadyAdmitted', source: 'amend' })
    expect(printed(again).lines.join('\n')).toContain('Its card.admitted is in the bus')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toHaveLength(1)
  })

  it('amends an admitted card whose task text or witnesses changed, and the unchanged amendment is then already admitted', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', 'Do the thing.\n\nWitnesses:\n- `pnpm vitest run` exit 0')
    admit(w, file)
    park(w, 80, CLEAN, 'src/board/**', 'Do the corrected thing.\n\nWitnesses:\n- `pnpm vitest run` exit 0')
    const amended = admit(w, file)
    expect(amended).toMatchObject({ status: 'admitted', source: 'amend' })
    const { lines, exit } = printed(amended)
    expect(exit).toBe(INTAKE_EXIT.admitted)
    expect(lines.join('\n')).toContain('80.md: #80 clean-card')
    expect(lines.join('\n')).toContain('source amend')
    expect(journalLines(w).at(-1)).toMatchObject({ event: 'intake', task: '80', card: CLEAN, source: 'amend', bodySha: bodySha(readFileSync(file, 'utf8')) })

    park(w, 80, CLEAN, 'src/board/**', 'Do the corrected thing.\n\nWitnesses:\n- `pnpm vitest run` exit 1')
    expect(admit(w, file)).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(journalLines(w)).toHaveLength(3)
    expect(admit(w, file).status).toBe('alreadyAdmitted')
    expect(journalLines(w)).toHaveLength(3)
    expect(taskStart(w, CLEAN)).toBe(0)
  })

  it('amends an admitted card whose only change is its touches line, and the unchanged amendment is then already admitted', () => {
    const w = world()
    mkdirSync(path.join(w.repo, 'src', 'card'), { recursive: true })
    writeFileSync(path.join(w.repo, 'src', 'card', 'grammar.ts'), '')
    const file = park(w, 80, CLEAN)
    expect(admit(w, file).status).toBe('admitted')
    park(w, 80, CLEAN, 'src/board/**, src/card/grammar.ts')
    const amended = admit(w, file)
    expect(amended).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(printed(amended).lines.join('\n')).toContain('source amend')
    const after = readFileSync(file, 'utf8')
    expect(after).toContain('touches: src/board/**, src/card/grammar.ts\n')
    expect(journalLines(w)).toHaveLength(2)
    expect(journalLines(w).at(-1)).toMatchObject({ event: 'intake', task: '80', card: CLEAN, source: 'amend', bodySha: bodySha(after) })
    expect(bodySha(after)).not.toBe(journalLines(w)[0]!.bodySha)
    expect(admit(w, file).status).toBe('alreadyAdmitted')
    expect(journalLines(w)).toHaveLength(2)
  })

  it('a card admitted when the digest left out its touches line, and unchanged since, writes no intake line', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    const text = readFileSync(file, 'utf8')
    expect(bodyShaWithoutTouches(text)).not.toBe(bodySha(text))
    journal(w, [{ event: 'intake', task: '80', card: CLEAN, confirmation: 'none', corrections: [], bodySha: bodyShaWithoutTouches(text), source: 'admit', ts: NOW.toISOString() }])
    const again = admit(w, file)
    expect(again).toMatchObject({ status: 'alreadyAdmitted', source: 'amend' })
    expect(printed(again).lines.join('\n')).toContain('Its card.admitted is in the bus')
    expect(journalLines(w)).toHaveLength(1)
  })

  it('amends an admitted card through the parking grammar: a refused file writes nothing, and a correction waits for its token', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file)
    writeFileSync(file, `card: ${CLEAN}\nbranch: feat/card-80\ntouches: src/board/**\ncontinue: stop\n\nDo the thing.\n`)
    expect(admit(w, file).status).toBe('refused')
    park(w, 80, CLEAN, 'scripts/board/run.ts', 'Do the other thing.')
    expect(admit(w, file).status).toBe('awaiting')
    expect(journalLines(w)).toHaveLength(1)
  })

  it('amends a card whose intake line recorded no body digest, since the text it admitted is unknown', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    journal(w, [{ event: 'intake', task: '80', card: CLEAN, confirmation: 'none', corrections: [], source: 'admit', ts: NOW.toISOString() }])
    expect(admit(w, file)).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(journalLines(w).at(-1)).toMatchObject({ source: 'amend', bodySha: bodySha(readFileSync(file, 'utf8')) })
  })

  it('corrects a touches entry to the only path of that name, and marks one that names no path unclear without changing who', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'scripts/board/run.ts, src/nowhere.ts')
    const result = admit(w, file, { autoConfirm: true })
    expect(result.status).toBe('admitted')
    const text = latestText(w, file)
    expect(text).toContain('touches: src/board/run.ts, src/nowhere.ts\n')
    expect(text).toContain('who: shift\n')
    expect(text).toContain('corrected: touches — scripts/board/run.ts → src/board/run.ts')
    expect(text).toContain(`unclear: touches — 'src/nowhere.ts' does not exist`)
    expect(journalLines(w)[0]).toMatchObject({ confirmation: 'auto', source: 'admit' })
  })

  it('--dry-run prints the card it would admit and writes nothing', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    const result = admit(w, file, { dryRun: true })
    expect(result.status).toBe('dryRun')
    expect(printed(result).exit).toBe(INTAKE_EXIT.dryRun)
    expect(existsSync(w.journal)).toBe(false)
  })

  it('admit refuses a witness whose -t is not a regex', () => {
    const w = world()
    const witness = '`pnpm exec vitest run tests/a.test.ts -t \'a named file against tests/** is no conflict\'` exit 0'
    const file = park(w, 80, CLEAN, 'src/board/**', `Do the thing.\n\nWitnesses:\n- ${witness}`)
    const before = readFileSync(file, 'utf8')
    const result = admit(w, file)
    expect(result.status).toBe('invalidTestPattern')
    const { lines, exit } = printed(result)
    expect(exit).toBe(INTAKE_EXIT.refused)
    expect(lines.join('\n')).toContain(witness)
    expect(lines.join('\n')).toContain('Nothing to repeat')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(w.journal)).toBe(false)
  })

  it('admit takes a witness whose -t compiles', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', 'Do the thing.\n\nWitnesses:\n- `pnpm exec vitest run tests/a.test.ts -t \'tests/\\*\\*\'` exit 0')
    expect(admit(w, file).status).toBe('admitted')
  })

  it('refuses a file that is not a parked card, and --admit beside --draft', () => {
    const w = world()
    mkdirSync(w.parking, { recursive: true })
    const file = path.join(w.parking, '80.md')
    writeFileSync(file, 'not a card\n')
    expect(printed(admit(w, file)).exit).toBe(INTAKE_EXIT.refused)
    expect(runIntake({ admit: file, draft: 'd.json', taken: '-', parking: w.parking, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, readStdin: () => '' })).toMatchObject({ status: 'refused', refusal: 'admitWithDraft' })
    expect(existsSync(w.journal)).toBe(false)
  })
})

describe('construct intake --admit holds an amend that lowers an admitted witness for the owner', () => {
  const ACCEPTANCE = '`pnpm exec vitest run tests/a.test.ts` exits 0; red on main'
  const INVARIANT = '`pnpm exec vitest run tests/a.test.ts` exits 0'
  const ANOTHER = '`pnpm exec vitest run tests/b.test.ts` exits 0; red on main'

  function bodyWith(...witnesses: string[]): string {
    return `Do the thing.\n\nWitnesses:\n${witnesses.map(witness => `- ${witness}`).join('\n')}`
  }

  function decisionsOf(w: World): string {
    return path.join(w.root, 'owner-decisions.md')
  }

  function ownerWaits(w: World): { id: string, need: string, text: string, card_id: number, state: string, answer: string | null }[] {
    const db = openBus(busOf(w))
    try {
      return db.prepare('SELECT id, need, text, card_id, state, answer FROM owner_waits ORDER BY id').all() as unknown as { id: string, need: string, text: string, card_id: number, state: string, answer: string | null }[]
    }
    finally {
      db.close()
    }
  }

  function ownerAllows(w: World, cardId: number, witness: string): void {
    const text = `[owner] ${downgradeAction(cardId, witness)}`
    writeFileSync(decisionsOf(w), `# Owner decisions\n\n- D-7 · 2026-10-13 — ${text} · card #${cardId} · decisions:add\n`)
    const db = openBus(busOf(w))
    try {
      recordDecision(db, { ts: AFTER_THE_CUTOFF.toISOString(), decisionId: 7, text, cards: [cardId] })
      reduce(db)
    }
    finally {
      db.close()
    }
  }

  it('an amend that removes red on main from a witness is not admitted and opens an owner wait', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', bodyWith(ACCEPTANCE))
    expect(admitThroughBus(w, file, { decisions: decisionsOf(w) })).toMatchObject({ status: 'admitted', source: 'admit' })
    park(w, 80, CLEAN, 'src/board/**', bodyWith(INVARIANT))
    const held = admitThroughBus(w, file, { decisions: decisionsOf(w) })
    expect(held).toMatchObject({ status: 'ownerWait', downgrades: [ACCEPTANCE], inBus: true })
    const { lines, exit } = printed(held)
    expect(exit).toBe(INTAKE_EXIT.waiting)
    expect(lines.join('\n')).toContain(downgradeAction(80, ACCEPTANCE))
    expect(admittedEvents(w)).toBe(1)
    expect(ownerWaits(w)).toEqual([{ id: expect.stringMatching(/^W\d+$/), need: 'decision', text: `разрешить понижение свидетеля ${ACCEPTANCE} у #80`, card_id: 80, state: 'open', answer: null }])
    expect(admitThroughBus(w, file, { decisions: decisionsOf(w) }).status).toBe('ownerWait')
    expect(ownerWaits(w)).toHaveLength(1)
  })

  it('an amend that deletes a witness is not admitted, and a dry run of it writes nothing', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', bodyWith(ACCEPTANCE, ANOTHER))
    admitThroughBus(w, file, { decisions: decisionsOf(w) })
    park(w, 80, CLEAN, 'src/board/**', bodyWith(ANOTHER))
    expect(admitThroughBus(w, file, { decisions: decisionsOf(w), dryRun: true })).toMatchObject({ status: 'ownerWait', downgrades: [ACCEPTANCE], dryRun: true })
    expect(ownerWaits(w)).toEqual([])
    expect(admitThroughBus(w, file, { decisions: decisionsOf(w) })).toMatchObject({ status: 'ownerWait', downgrades: [ACCEPTANCE] })
    expect(ownerWaits(w)).toHaveLength(1)
  })

  it('an amend whose witness downgrade the owner allowed is admitted', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', bodyWith(ACCEPTANCE))
    admitThroughBus(w, file, { decisions: decisionsOf(w) })
    park(w, 80, CLEAN, 'src/board/**', bodyWith(INVARIANT))
    expect(admitThroughBus(w, file, { decisions: decisionsOf(w) }).status).toBe('ownerWait')
    ownerAllows(w, 80, ACCEPTANCE)
    expect(ownerWaits(w)).toMatchObject([{ state: 'closed', answer: 'D-7' }])
    expect(admitThroughBus(w, file, { decisions: decisionsOf(w) })).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(admittedEvents(w)).toBe(2)
  })

  it('an allowance names the witness it lowers: another downgrade of the same card still waits', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', bodyWith(ACCEPTANCE, ANOTHER))
    admitThroughBus(w, file, { decisions: decisionsOf(w) })
    ownerAllows(w, 80, ACCEPTANCE)
    park(w, 80, CLEAN, 'src/board/**', bodyWith(INVARIANT))
    expect(admitThroughBus(w, file, { decisions: decisionsOf(w) })).toMatchObject({ status: 'ownerWait', downgrades: [ACCEPTANCE, ANOTHER] })
  })

  it('an amend that adds a witness is admitted at once', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', bodyWith(INVARIANT))
    admitThroughBus(w, file, { decisions: decisionsOf(w) })
    park(w, 80, CLEAN, 'src/board/**', bodyWith(ACCEPTANCE, ANOTHER))
    expect(admitThroughBus(w, file, { decisions: decisionsOf(w) })).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(ownerWaits(w)).toEqual([])
  })

  it('a new card with no previous body opens no owner wait', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', bodyWith(INVARIANT))
    expect(admitThroughBus(w, file, { decisions: decisionsOf(w) })).toMatchObject({ status: 'admitted', source: 'admit' })
    expect(ownerWaits(w)).toEqual([])
  })
})

describe('witnessDowngrades', () => {
  it('names a removed witness and one that lost red on main, and not one that gained it or kept it', () => {
    expect(witnessDowngrades(['a; red on main', 'b', 'c; red on main', 'd'], ['a', 'b; red on main', 'c; red on main'])).toEqual(['a; red on main', 'd'])
  })
})

describe('construct intake --admit with the bus counts a journal line only before the cutoff', () => {
  it('a journal intake line after the cutoff with no card.admitted in the bus does not make the card admitted', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    journal(w, [{ event: 'intake', task: '80', card: CLEAN, bodySha: bodySha(readFileSync(file, 'utf8')), confirmation: 'none', source: 'admit', ts: '2026-10-13T00:00:00.000Z' }])
    expect(admit(w, file, { admissions: () => null }, new Date('2026-10-13T09:00:00.000Z'))).toMatchObject({ status: 'admitted', source: 'admit' })
  })
})

describe('construct intake --admit says whether task:start will take the card', () => {
  it('names the bus when the port wrote card.admitted, and task:start takes the card', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    expect(printed(admit(w, file)).lines[0]).toBe(`[ok] Admitted ${file}: ${CLEAN}. Its card.admitted is in the bus, so task:start and the shift take it.\n`)
    expect(taskStart(w, CLEAN)).toBe(0)
  })

  it('says only what it wrote when no bus is wired: the journal line and no card.admitted, which this repository\'s task:start then refuses', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    expect(printed(admit(w, file, { events: undefined })).lines[0]).toBe(`[ok] Admitted ${file}: ${CLEAN}. Its intake line is in the journal; no bus is wired to this run, so no card.admitted was written.\n`)
    expect(taskStart(w, CLEAN)).toBe(1)
  })

  it('a bus-wired --admit of a card an unwired run admitted writes its card.admitted and no second intake line, and task:start takes the card', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file, { events: undefined })
    const again = admit(w, file)
    expect(again.status).toBe('alreadyAdmitted')
    expect(printed(again).lines[0]).toBe(`[ok] Already admitted ${file}: ${CLEAN}. Its card.admitted is in the bus, so task:start and the shift take it.\n`)
    expect(journalLines(w)).toHaveLength(1)
    expect(admittedEvents(w)).toBe(1)
    expect(taskStart(w, CLEAN)).toBe(0)
  })

  it('a repeated bus-wired --admit of an admitted card leaves one card.admitted in the bus', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file)
    admit(w, file, {}, A_MINUTE_LATER)
    admit(w, file, {}, AN_HOUR_LATER)
    expect(admittedEvents(w)).toBe(1)
  })

  it('the card.admitted a bus-wired --admit writes for a journal-admitted card carries the journal line\'s ts, source and confirmation', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file, { events: undefined, autoConfirm: true })
    admit(w, file, {}, AN_HOUR_LATER)
    expect(admittedPayloads(w)).toEqual([expect.objectContaining({ source: 'admit', confirmation: 'auto' })])
    expect(admittedTimes(w)).toEqual([NOW.toISOString()])
  })

  it('an unwired --admit of an admitted card says nothing was written', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file, { events: undefined })
    expect(printed(admit(w, file, { events: undefined })).lines[0]).toBe(`[ok] Already admitted ${file}: ${CLEAN}. The journal holds its intake line; no bus is wired to this run, so nothing was written.\n`)
  })

  it('a dry run of an admitted card writes no card.admitted', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file, { events: undefined })
    admit(w, file, { dryRun: true })
    expect(admittedEvents(w)).toBe(0)
  })
})

describe('construct intake --admit and package.json', () => {
  it('adds the script companions to a card that touches package.json, with no person to confirm', () => {
    const w = world()
    mkdirSync(path.join(w.repo, 'tests'))
    for (const existing of ['package.json', 'CONTRIBUTING.md', 'tests/harness-membership.test.ts'])
      writeFileSync(path.join(w.repo, existing), '')
    const file = park(w, 80, CLEAN, 'package.json, src/board/**')
    expect(admit(w, file).status).toBe('admitted')
    const text = latestText(w, file)
    expect(text).toContain('touches: package.json, src/board/**, CONTRIBUTING.md, tests/harness-membership.test.ts\n')
    expect(text).toContain('corrected: touches — (absent) → tests/harness-membership.test.ts — every change of this kind carries it')
    expect(text).toContain('corrected: touches — (absent) → CONTRIBUTING.md')
    expect(text).not.toContain('unclear:')
    expect(journalLines(w).at(-1)).toMatchObject({ confirmation: 'none' })
    expect(admit(w, file).status).toBe('alreadyAdmitted')
  })

  it('adds only the companion a card that touches package.json is missing', () => {
    const w = world()
    mkdirSync(path.join(w.repo, 'tests'))
    for (const existing of ['package.json', 'CONTRIBUTING.md', 'tests/harness-membership.test.ts'])
      writeFileSync(path.join(w.repo, existing), '')
    const file = park(w, 80, CLEAN, 'package.json, CONTRIBUTING.md')
    expect(admit(w, file).status).toBe('admitted')
    expect(latestText(w, file)).toContain('touches: package.json, CONTRIBUTING.md, tests/harness-membership.test.ts\n')
  })

  it('adds no companion to a card that does not touch package.json', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file)
    expect(latestText(w, file)).not.toContain('CONTRIBUTING.md')
  })
})

describe('construct intake --admit and the creates line', () => {
  it('admit keeps the creates line and marks no created path unclear', () => {
    const w = world()
    mkdirSync(w.parking, { recursive: true })
    const file = path.join(w.parking, '80.md')
    writeFileSync(file, `card: ${CLEAN}\nbranch: feat/card-80\ntouches: src/board/fresh.ts\ncreates: src/board/fresh.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
    const result = admit(w, file)
    expect(result.status).toBe('admitted')
    expect(latestText(w, file)).not.toContain('unclear: touches')
    expect(latestText(w, file)).toContain('creates: src/board/fresh.ts')
  })

  it('admit reads a creates entry with its kind as the path it creates', () => {
    const w = world()
    mkdirSync(w.parking, { recursive: true })
    const file = path.join(w.parking, '80.md')
    writeFileSync(file, `card: ${CLEAN}\nbranch: feat/card-80\ntouches: src/board/fresh.ts\ncreates: src/board/fresh.ts (plain)\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
    expect(admit(w, file).status).toBe('admitted')
    expect(latestText(w, file)).not.toContain('unclear:')
    expect(latestText(w, file)).toContain('creates: src/board/fresh.ts (plain)')
  })

  it('admit marks a creates entry with a kind outside the list unclear', () => {
    const w = world()
    mkdirSync(w.parking, { recursive: true })
    const file = path.join(w.parking, '80.md')
    writeFileSync(file, `card: ${CLEAN}\nbranch: feat/card-80\ntouches: src/board/fresh.ts\ncreates: src/board/fresh.ts (bogus)\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
    admit(w, file)
    expect(latestText(w, file)).toContain(`unclear: creates — creates entry 'src/board/fresh.ts (bogus)' names kind 'bogus', not one of ghosts, plain`)
  })

  it('a parked card without a creates line parses as before', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/fresh.ts')
    expect(admit(w, file).status).toBe('admitted')
    expect(latestText(w, file)).toContain('unclear: touches')
  })
})

describe('construct intake --admit across the lanes of the parking', () => {
  function parkIn(w: World, lane: string, id: number, card: string): string {
    const dir = path.join(w.parking, lane)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${id}.md`)
    writeFileSync(file, `card: ${card}\nbranch: feat/card-${id}\ntouches: src/board/**\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
    return file
  }

  it('a depends on a card parked in another lane is not unclear', () => {
    const w = world()
    parkIn(w, 'lane-1', 53, '#53 first [implement/runner/S/cheap/owner] · depends — · blocks —')
    parkIn(w, 'lane-1', 43, '#43 other [implement/runner/S/cheap/owner] · depends — · blocks —')
    const line = '#58 second [implement/runner/S/cheap/owner] · depends #53 · blocks #43'
    const file = parkIn(w, 'lane-2', 58, line)
    expect(admit(w, file)).toMatchObject({ status: 'waiting', waitingOn: [53], card: { line, unclear: [] } })

    journal(w, [{ event: 'merge', task: '53', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    expect(admit(w, file)).toMatchObject({ status: 'awaiting', card: { unclear: [] } })
    expect(admit(w, file, { autoConfirm: true })).toMatchObject({ status: 'admitted', card: { unclear: [] } })
    expect(latestText(w, file)).not.toContain('unclear:')
  })

  it('a depends on a card parked under another parking root stays unclear', () => {
    const w = world()
    parkIn(w, 'lane-1', 53, '#53 first [implement/runner/S/cheap/owner] · depends — · blocks —')
    const file = parkIn(w, 'lane-2', 58, '#58 second [implement/runner/S/cheap/owner] · depends #53 · blocks —')
    const result = admit(w, file, { parkingRoot: path.join(w.root, 'elsewhere') })
    expect(result).toMatchObject({ status: 'admitted', card: { unclear: [{ field: 'depends' }] } })
    expect(latestText(w, file)).toContain('unclear: depends')
  })

  it('a card sliced through the bus gets its lane from the bus and lays no lane directory in the parking', () => {
    const w = world()
    mkdirSync(path.join(w.repo, 'src', 'atlas'), { recursive: true })
    writeFileSync(path.join(w.repo, 'src', 'atlas', 'map.ts'), '')
    const card = (name: string, touches: string[]): Record<string, unknown> => ({ name, kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'auto', who: 'shift', touches, task: 'Do the thing.', witnesses: ['`pnpm run quality` is green'] })
    const draft = path.join(w.root, 'draft.json')
    writeFileSync(draft, JSON.stringify({ cards: [card('board-run', ['src/board/run.ts', '.changeset/**']), card('atlas-map', ['src/atlas/map.ts', '.changeset/**']), card('board-all', ['src/board/**'])] }))
    const db = openBus(busOf(w))
    const result = (() => {
      try {
        return runIntake({ draft, taken: '-', readStdin: () => '1', parking: w.parking, parkingRoot: w.parking, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: true, events: busCardEvents(db) })
      }
      finally {
        db.close()
      }
    })()
    expect(result).toMatchObject({ status: 'written', cards: [{ file: '2.md' }, { file: '3.md' }, { file: '4.md' }] })
    expect(admittedPayloads(w).map(payload => payload.lane)).toEqual([WINDOW_LANE, WINDOW_LANE, WINDOW_LANE])
    expect(existsSync(w.parking)).toBe(false)
  })
})

describe('the parking tree draft and admit both read', () => {
  it('lists the root and every lane under it, nested lanes included', () => {
    const w = world()
    mkdirSync(path.join(w.parking, 'lane-1', 'nested'), { recursive: true })
    mkdirSync(path.join(w.parking, 'lane-2'), { recursive: true })
    writeFileSync(path.join(w.parking, 'lane-2', '58.md'), '')
    expect(parkingTree(w.parking).sort()).toEqual([
      w.parking,
      path.join(w.parking, 'lane-1'),
      path.join(w.parking, 'lane-1', 'nested'),
      path.join(w.parking, 'lane-2'),
    ])
  })

  it('is empty for a parking root that does not exist', () => {
    expect(parkingTree(path.join(world().root, 'missing'))).toEqual([])
  })

  it('holds the root and its lanes within, and a sibling sharing its prefix outside', () => {
    const w = world()
    expect(isWithin(w.parking, w.parking)).toBe(true)
    expect(isWithin(w.parking, path.join(w.parking, 'lane-1'))).toBe(true)
    expect(isWithin(w.parking, `${w.parking}-other`)).toBe(false)
    expect(isWithin(w.parking, w.root)).toBe(false)
  })
})

describe('construct intake --admit through the CLI entry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function admitThroughEntry(w: World, file: string, extra: string[] = []): Promise<{ exit: typeof process.exitCode, output: string }> {
    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
    const previousExit = process.exitCode
    try {
      await runCommand(createMain(), { rawArgs: ['intake', '--plain', '--admit', file, '--dir', w.repo, '--journal', w.journal, '--parking', w.parking, ...extra] })
      return { exit: process.exitCode, output: written.join('') }
    }
    finally {
      write.mockRestore()
      process.exitCode = previousExit
    }
  }

  it('intake --admit through the CLI entry either writes card.admitted to the bus as pnpm intake does or refuses and names pnpm intake --admit, and never admits silently without the bus event', async () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    openBus(busOf(w)).close()
    vi.stubEnv(BUS_DB_VARIABLE, busOf(w))
    const { exit, output } = await admitThroughEntry(w, file)
    const inBus = admittedEvents(w) > 0
    const refusedAndNamed = exit === INTAKE_EXIT.refused && output.includes('pnpm intake --admit')
    expect(inBus || refusedAndNamed).toBe(true)
    expect(journalLines(w).filter(line => line.event === 'intake')).toHaveLength(inBus ? 1 : 0)
  })

  it('intake --admit --dry-run through the CLI entry beside a bus is never refused and writes nothing', async () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    openBus(busOf(w)).close()
    vi.stubEnv(BUS_DB_VARIABLE, busOf(w))
    const { exit, output } = await admitThroughEntry(w, file, ['--dry-run'])
    expect(exit).not.toBe(INTAKE_EXIT.refused)
    expect(output).not.toContain('pnpm intake --admit instead')
    expect(admittedEvents(w)).toBe(0)
    expect(journalLines(w)).toHaveLength(0)
  })

  it('intake --admit through the CLI entry on a machine with no bus admits into the journal as before', async () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    vi.stubEnv(BUS_DB_VARIABLE, busOf(w))
    const { exit } = await admitThroughEntry(w, file)
    expect(exit).not.toBe(INTAKE_EXIT.refused)
    expect(existsSync(busOf(w))).toBe(false)
    expect(journalLines(w).filter(line => line.event === 'intake')).toHaveLength(1)
  })
})
